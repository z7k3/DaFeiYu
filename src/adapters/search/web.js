'use strict';

const bing = require('./bing');
const so360 = require('./so360');
const baike = require('./baike');
const tavily = require('./tavily');
const { remaining, report, errorInfo } = require('./transport');
const quality = require('../../core/search/quality');
const { result } = require('../../core/search/result');

async function searchResult(query, opts = {}) {
  const started = Date.now();
  const deadline = Math.min(opts.deadline ?? Infinity, started + remaining(opts));
  const raw = String(query || '').trim();
  if (!raw) return result([], { status: 'skipped', reason: 'empty_input' });
  const site = (raw.match(/\bsite:([a-z0-9.-]+)/i) || [])[1] || '';
  const body = raw.replace(/\bsite:[a-z0-9.-]+/gi, '').trim().slice(0, 100);
  const q = body + (site ? ' site:' + site : '');
  const attempts = [], all = [], staleItems = [];
  const seen = new Set();
  let deadlineExpired = false;
  let answer = '';
  const budget = () => remaining({ ...opts, deadline });
  const valid = () => quality.splitFreshness(q, all, opts).items;
  const ask = async (provider, term, reserve = false) => {
    if (deadlineExpired || opts.signal?.aborted || budget() <= 0) return;
    if (site && !term.toLowerCase().includes('site:' + site.toLowerCase())) term += ' site:' + site;
    const start = Date.now();
    const left = budget();
    // 高级全文搜索约需 6 秒；保留少量余量供后续源补位，普通网页源仍按原预算切分。
    const timeoutMs = reserve && left > 100
      ? Math.floor(left * (provider === 'tavily' ? 0.95 : 0.65)) : left;
    try {
      const source = provider === 'tavily' ? tavily : { bing, so360, baike }[provider];
      const response = await source.search(term, { ...opts, deadline, timeoutMs });
      const parsed = Array.isArray(response) ? response : (Array.isArray(response?.items) ? response.items : []);
      const scoped = site ? parsed.filter(item => {
        const host = new URL(item.url).hostname.toLowerCase();
        return host === site.toLowerCase() || host.endsWith('.' + site.toLowerCase());
      }) : parsed;
      const relevant = quality.keepRelevant(body, scoped);
      if (provider === 'tavily' && relevant.length) answer = String(response?.answer || '').trim();
      report(opts.trace, 'filter', { provider, parsed: parsed.length, relevant: relevant.length,
        rejected: parsed.length - relevant.length, reason: 'relevance_filter' });
      const fetchedAt = new Date().toISOString();
      for (const item of relevant) {
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        all.push({ ...item, provider, fetchedAt, publishedAt: item.publishedAt || null });
      }
      attempts.push({ provider, status: relevant.length ? 'ok' : 'empty', parsed: parsed.length,
        relevant: relevant.length, elapsedMs: Date.now() - start });
    } catch (err) {
      // 保留上游总预算耗尽后停止补搜的修复；首源的预留预算超时仍可切备用源。
      if (err?.code === 'deadline_exceeded' && timeoutMs >= left) deadlineExpired = true;
      const info = errorInfo(err);
      attempts.push({ provider, status: 'failed', code: info.code, error: info, elapsedMs: Date.now() - start });
      report(opts.trace, 'failed', { provider, ...info });
    }
  };
  // 梗/流行语类查询：先直接抓百度百科词条摘要。热梗释义集中在百科，通用搜索
  // 收录差且易被相关性过滤器整页拒掉；词条不存在时 baike 返回空数组，不影响
  // 后面的 bing/360 主检索。限定 site: 的查询跳过（站点过滤会把百科结果全滤掉）。
  if (!site && baike.MEME_RE.test(body)) await ask('baike', body, true);
  // Tavily 首选源：配置了 Key 才排班。结构化 JSON + 全文 + 真实发布时间，
  // 没有 bing/360 的反爬垃圾问题；拿到 ≥2 条有效结果就直接跳过本地引擎——
  // 省时间，也避免无谓地去碰会间歇性返回广告页的 cn.bing.com/so.com。
  const tavilyOn = Boolean(String(opts.tavilyApiKey || '').trim()) && !site;
  if (tavilyOn) {
    await ask('tavily', body, true);
    // 名单/榜单类查询补一轮「完整名单」变体：单轮结果常是颁奖/前三的新闻页，
    // 完整名单在汇总页或后续报道里（实见 HLTV top20：单轮只有前三的报道，
    // 20 人名单的汇总页要换关键词才搜得到）。URL 去重挡住重复条目。
    if (!site && /(名单|榜单|排行|排名|top\s*\d)/i.test(body)
        && valid().length < 5 && budget() > 800) {
      await ask('tavily', body + ' 完整名单', true);
    }
  }
  // 首轮双源并行：cn.bing.com 和 so.com 都会对无 Cookie 的程序化抓取间歇性返回
  // 广告/默认页（2026-11-14 实测：搜「孤勇者歌词」bing 给出战网/企业微信/金蝶官网，
  // 搜「小米su7」给出帝国时代秘籍页；同一查询换次请求又正常）。串行单源一旦中招，
  // 整轮只剩备用词苦撑；并行合并让两家互为冗余，垃圾由相关性过滤负责淘汰。
  // Tavily 已给足（≥2 条有效）时跳过本轮——省时间，也少暴露一次抓取指纹。
  if (!(tavilyOn && valid().length >= 2)) {
    await Promise.all([ask('bing', q, true), ask('so360', q, true)]);
  }
  const named = quality.modelNames(body).length || /\b(?:macbook|ipad|watch|airpods)\b/i.test(body);
  if (!site && !named && /(苹果|iphone|mac)/i.test(body) && /(最新|机器|机型|型号|出到|几代|发布)/.test(body)) {
    const product = /(电脑|笔记本|mac)/i.test(body) ? 'Mac 机型' : /手机|iphone/i.test(body) ? 'iPhone 机型' : '苹果 产品';
    await ask('bing', 'site:apple.com.cn ' + product, true);
  }
  if (valid().length < 2) {
    // 保留原始查询作主检索，纠错只产生候选，不覆盖用户的专名和型号。
    const alternatives = [...new Set([quality.cleanQuery(body), quality.queryTokens(body).join(' ')])]
      .filter(x => x && x !== body).slice(0, 2);
    for (const term of alternatives) {
      await ask('bing', term, true);
      if (valid().length >= 2) break;
    }
  }
  if (valid().length < 2 && !(tavilyOn && valid().length >= 1)) await ask('so360', q);   // 首轮已并行问过；这里只在仍不足时再试一次（URL 去重挡住重复条目）
  // 通用兜底：bing/360 都没给够时，专名类查询往往在百度百科有词条（人物/作品/地名/产品/梗）。
  // baike.search 自带清洗（去问句骨架），词条不存在返回空数组，不产生噪音。
  // 只有「一条都没捞到」才补查百度百科：有 1 条已可用时不再多打一次外网请求
  // （产品/型号类查询本来就不该走百科，避免拖慢和污染失败状态）。
  if (!valid().length && !site) await ask('baike', body);
  const split = quality.splitFreshness(q, quality.keepRelevant(body, all), opts);
  staleItems.push(...split.staleItems);
  let items = split.items.slice(0, Math.max(1, Math.min(10, Number(opts.limit) || 5)));
  let staleFallback = false;
  // 名单/资料类查询全部过旧时交出「带时间的旧证据」而不是空手：
  // 实测「Falcons 队员名单」10 条候选全被判 stale → 她只能回答"没查到靠谱的结果"，
  // 但旧名单页对她完全有用（如实报年份即可）。价格/今天这类硬时效查询除外——
  // 旧数字是有害证据，宁可空手（交给上层"没查到"）。
  if (!items.length && split.staleItems.length
      && !/(今天|今日|刚刚|刚才|实时|现在|此刻|多少钱|什么价|价格|报价|行情)/i.test(body)) {
    items = split.staleItems.slice(0, Math.max(1, Math.min(3, Number(opts.limit) || 5)));
    staleFallback = true;
  }
  // 百科是补充源：它的空结果不能把主搜索的 parse_error 洗成 no_results，
  // 否则「解析结构变了」这种真故障会被当成「今天没搜到」。
  const coreAttempts = attempts.filter((a) => a.provider !== 'baike');
  const reason = items.length ? (staleFallback ? 'stale_only' : 'available') : opts.signal?.aborted ? 'aborted' : deadlineExpired || budget() <= 0 ? 'deadline_exceeded'
    : staleItems.length ? 'stale_only' : coreAttempts.length && coreAttempts.every(a => a.status === 'failed') ? coreAttempts.at(-1)?.code || 'no_results' : 'no_results';
  report(opts.trace, 'result', { candidates: all.length, stale: staleItems.length, selected: items.length,
    sources: items.map(x => new URL(x.url).hostname) });
  // status 也按主搜索判定：所有主源都失败（含 parse_error）就是 failed，
  // 不能被百科补充源的空结果洗成 empty。
  const coreFailed = coreAttempts.length > 0 && coreAttempts.every(a => a.status === 'failed');
  return result(items, { attempts, staleItems, reason, elapsedMs: Date.now() - started,
    ...(answer ? { answer } : {}),
    ...(!items.length && (coreFailed || ['aborted', 'deadline_exceeded'].includes(reason)) ? { status: 'failed' } : {}) });
}

module.exports = { searchResult };
