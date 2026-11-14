'use strict';

const web = require('../adapters/websearch');
const weather = require('../adapters/search/weather');
const router = require('../adapters/searchRouter');
const policy = require('../core/search/policy');
const quality = require('../core/search/quality');
const { effectiveMaxAgeDays } = quality;
const { result, formatResult } = require('../core/search/result');
const { remaining, errorInfo, report, searchError } = require('../adapters/search/transport');
const links = require('../adapters/links');

// 原文类查询：要的是「内容本身」（歌词/台词/攻略/步骤…），搜索摘要往往只剩
// 歌名页/目录页，必须把结果页正文抓回来才算拿到东西。见 run() 里的补正文步骤。
// 名单/榜单同理：用户要的是完整清单，搜索摘要通常只有前几名（实测 HLTV top20
// 的摘要只给前三），不抓结果页正文就只能报半截名单。
const ORIGINAL_TEXT_RE = /(歌词|副歌|台词|原文|全文|诗文|攻略|步骤|教程|说明书|玩法|怎么玩|怎么弄|怎么做|名单|榜单|排行|排名|top\s*\d+)/i;

/** 单轮搜索的唯一入口；只返回证据，不读写会话存储或决定聊天回复。 */
async function search({ text = '', history = [], llm, config = {}, now = new Date(), timeZone = '', signal, trace, force = false } = {}, deps = {}) {
  const providers = deps.providers || web;
  // 抓正文默认走真实 links 适配器；测试注入 deps.describeLink 以免出网。
  const describeLink = deps.describeLink || links.describeLink;
  const places = deps.places || weather;
  const routeSearch = deps.route || router.route;
  const started = Date.now();
  const deadline = started + remaining({ timeoutMs: config.timeoutMs ?? 8000 });
  const controller = new AbortController();
  const attempts = [], staleItems = [];
  let completed;
  const say = (stage, data) => report(trace, stage, data);
  const options = () => ({ deadline, timeoutMs: Math.max(0, deadline - Date.now()), signal: controller.signal, trace: say });
  const active = () => !controller.signal.aborted && Date.now() < deadline;
  const finish = value => {
    if (completed) return completed;
    const out = { ...value, attempts: [...attempts, ...(value.attempts || [])], staleItems: [...staleItems, ...(value.staleItems || [])], elapsedMs: Date.now() - started };
    // 默认 1400 字会截掉第 3 条以后的摘要；放宽到 3200，persona 侧有自己的截断兜底。
    out.text = formatResult(out, { maxChars: 3200 });
    if (out.reason === 'stale_only' && out.items.length) {
      // 旧证据放行时必须让模型知道这是存档：否则会把去年的名单当今年报出来
      out.text += '\n（注意：以上资料均为较旧时间的存档，回答时必须说明资料对应的年份时间，不得当作当前最新情况。）';
    }
    completed = out;
    say('complete', { status: out.status, reason: out.reason, selected: out.items.length, chars: out.text.length, elapsedMs: out.elapsedMs });
    return out;
  };
  const skipped = reason => {
    say('decision', { decision: 'skip', reason });
    return finish(result([], { status: 'skipped', reason }));
  };
  if (config.enabled === false) return skipped('disabled');
  text = String(text).trim();
  if (!text) return skipped('empty_input');
  if (signal?.aborted) return finish(result([], { status: 'failed', reason: 'aborted' }));

  const remember = value => {
    attempts.push(...(value.attempts || []));
    staleItems.push(...(value.staleItems || []));
  };
  const call = async (provider, fn) => {
    try { return await fn(); } catch (err) {
      const info = errorInfo(err);
      say('failed', { provider, ...info });
      return result([], { status: 'failed', reason: info.code, attempts: [{ provider, status: 'failed', code: info.code, error: info }] });
    }
  };
  const locate = async (provider, fn) => {
    try { return await fn(); } catch (err) {
      const info = errorInfo(err);
      attempts.push({ provider, status: 'failed', code: info.code, error: info });
      say('failed', { provider, ...info });
      return null;
    }
  };
  const run = async () => {
    const gate = policy.gate(text, config.semanticRoute);
    let route = force ? { failed: false, need: true, query: text } : { failed: true, need: false };
    if (!force && gate.route && active()) {
      const routeStarted = Date.now();
      try {
        route = await routeSearch(llm, text, { ...options(), now, timeZone,
          history: typeof history === 'function' ? history() : history,
          // 2 秒对自建/较慢的模型太苛刻（实测 75% 超时回退关键词规则，热梗问题
          // 全被跳过）。3.5 秒内大部分路由能返回；总预算仍在 websearch.timeoutMs 内。
          timeoutMs: Math.min(3500, options().timeoutMs) });
      } catch (err) { say('route_failed', errorInfo(err)); }
      attempts.push({ provider: 'router', status: route.failed ? 'failed' : 'ok', elapsedMs: Date.now() - routeStarted });
    }
    if (!active()) throw searchError(controller.signal.aborted ? 'aborted' : 'deadline_exceeded');
    // 路由说「不用查」通常照办；但「会变的统计事实」（榜单/排名/冠军/销量…）是例外：
    // 路由容易把这类当成「模型自己知道」，而模型记忆停在过去（实见 CS top20 拿 2024 冒充 2025），
    // 强信号命中时必须查。
    if (!route.need && !(route.failed && gate.fallback) && !gate.volatile) return skipped(route.failed ? 'local_not_needed' : 'router_not_needed');
    say('decision', { decision: 'run', reason: route.need ? 'router_requested' : route.failed ? 'router_failed_keyword_fallback' : gate.volatile ? 'volatile_forced' : 'rules_requested',
      routeFailed: Boolean(route.failed), budgetMs: options().timeoutMs });
    const intent = policy.intent(text, route);
    let q = intent.query;
    // 路由挂了（回退关键词规则选源），或被统计事实信号推翻（此时路由没给检索词）：
    // 这两种情况下查询词都是用户原句，必须清洗成能搜的形式。
    // 以前直接拿原句搜：'你知道CS去年的top20名单吗' 这种问句会把 '你知道…吗' 一起搜，
    // 命中率极差（实测第一次 10 条全被相关性过滤拒掉，得多打两次搜索）。
    if (route.failed || !route.need) {
      try {
        const cleaned = quality.cleanQuery(q);
        if (cleaned && cleaned !== q) {
          say('query_rewrite', { reason: route.failed ? 'router_failed' : 'volatile_forced', from: q.length, to: cleaned.length });
          q = cleaned;
        }
      } catch { /* 清洗失败就用原句 */ }
    }
    // 相对时间词必须锚成具体年份：搜「去年 top20」返回的是任意年份的杂页，证据年份一错
    // 她就拿旧名单当答案。路由提示词已要求换算，这里对两种来源统一兜底（幂等）。
    try {
      const anchored = quality.anchorYears(q, now);
      if (anchored && anchored !== q) {
        say('query_rewrite', { reason: 'anchor_relative_time', from: q.length, to: anchored.length });
        q = anchored;
      }
    } catch { /* 锚定失败就用原句 */ }
    // 天气/热榜这类专用接口常要两次串行请求（地理编码 → 预报）：只分剩余预算的
    // 60% 会在慢网络下必然超时，然后退化去搜网页拿到「城市百科」这种垃圾证据。
    // 给到至少 6 秒，同时仍受总 deadline 约束。
    // 专用接口的预算要给「网页回退」留一份：天气要串行打两次（地理编码→预报），
    // 全吃光的话失败后就只能直接报 empty（实测：700ms 预算下网页回退一次都跑不了）。
    const totalBudget = Math.max(0, Number(options().timeoutMs) || 0);
    const webReserve = Math.min(2500, Math.floor(totalBudget * 0.25));
    const specializedDeadline = Math.min(
      deadline - webReserve,
      Date.now() + Math.max(1500, Math.floor(totalBudget * 0.75)));
    const specializedOptions = () => ({ ...options(), deadline: specializedDeadline,
      timeoutMs: Math.max(0, specializedDeadline - Date.now()) });
    if (intent.kind === 'weather') {
      let city = intent.city;
      let place = null;
      let unresolvedCity = false;
      // 用户本句的地点优先于配置；只有没说地点时才用配置和本机公网 IP。
      if (!city && active()) {
        const candidate = policy.cityCandidate(text);
        if (candidate && candidate.length <= 40) {
          place = await locate('geocode', () => places.geocodeCity(candidate, specializedOptions()));
          if (place) city = place.name;
          else unresolvedCity = true;
        }
      }
      if (!city && !unresolvedCity) city = String(config.city || '').trim();
      if (!city && !unresolvedCity && active()) city = await locate('ip-city', () => places.ipCity(specializedOptions())) || '';
      if (city && active()) {
        // 中国天气网优先：国内实况/预报+预警，比国外接口更准；拿不到城市代码或失败
        // 再退回 open-meteo，最后 wttr。三段各留余量，网页回退的预算在 specializedDeadline
        // 之外（webReserve）不受影响。
        if (typeof places.cnWeatherResult === 'function') {
          const cnLeft = Math.max(0, specializedDeadline - Date.now());
          const cnValue = await call('cnweather', () => places.cnWeatherResult(city, {
            ...specializedOptions(),
            deadline: Math.min(specializedDeadline, Date.now() + Math.floor(cnLeft * 0.6)),
            // 配置里的常住城市：区县同名时用它挑对（西湖/东湖/新建…）
            parent: String(config.city || '').trim(),
          }));
          if (cnValue.status === 'ok') return finish(cnValue);
          remember(cnValue);
        }
        // open-meteo 只拿专用预算的 55%：它被墙/重置时还要给 wttr 兜底留时间。
        const omLeft = Math.max(0, specializedDeadline - Date.now());
        const omDeadline = Date.now() + Math.floor(omLeft * 0.55);
        const value = await call('open-meteo', () => providers.weatherResult(city, {
          ...specializedOptions(),
          deadline: Math.min(specializedDeadline, omDeadline),
          ...(place ? { place } : {}),
        }));
        if (value.status === 'ok') return finish(value);
        remember(value);
        // open-meteo 被墙/重置时退化到 wttr.in：宁可换源，也不要掉进网页搜索
        // 拿「南昌地图/百科」当天气证据（用户实见：「全是地图百科」）。
        if (active() && typeof places.wttrResult === 'function') {
          const wtLeft = Math.max(0, specializedDeadline - Date.now());
          const alt = await call('wttr', () => places.wttrResult(city, {
            ...specializedOptions(),
            deadline: Math.min(specializedDeadline, Date.now() + Math.floor(wtLeft * 0.8)),
          }));
          if (alt.status === 'ok') return finish(alt);
          remember(alt);
        }
      }
      // 补地点时保留“明天/带伞”等原需求，避免天气失败后退化成泛查城市天气。
      if (city && !q.includes(city)) q = city + ' ' + q;
    }
    if (intent.kind === 'hotlist' && active()) {
      const value = await call(intent.site || 'toutiao', () => providers.hotlistResult(intent.site || 'toutiao', { ...specializedOptions(), limit: 10 }));
      if (value.status === 'ok') return finish(value);
      remember(value);
    }
    if (!active()) throw searchError(controller.signal.aborted ? 'aborted' : 'deadline_exceeded');
    if (policy.DOMAINS[intent.site]) q = q.replace(/\bsite:[a-z0-9.-]+/gi, '').trim() + ' site:' + policy.DOMAINS[intent.site];
    const value = await call('web', () => providers.searchResult(q, { ...options(), limit: 4,
      maxAgeDays: effectiveMaxAgeDays(`${text} ${q}`, intent.fresh, intent.timeRange) }));
    // deadline 先到时 race 会整体 reject——已经拿到的结果不能跟着丢，先留在这里。
    if (value && value.items && value.items.length) partial = value;
    // 原文类查询：搜索摘要经常只剩「歌名页/目录页」（用户看到的「都是链接没正文」就是
    // 这个）。抓前两条非百科结果页的正文补进资料——复用读链接的 SSRF 防护和缓存；
    // 死链/失效页的「正文」是站点提示语，必须剔除，不然反而污染资料。
    if (value.status === 'ok' && value.items?.length && ORIGINAL_TEXT_RE.test(text + ' ' + q) && active()) {
      const candidates = value.items.filter(it => it.provider !== 'baike' && it.provider !== 'page').slice(0, 2);
      for (const top of candidates) {
        const page = await locate('page-reader', () => describeLink(top.url,
          { timeoutMs: Math.max(0, Math.min(6000, Math.floor(options().timeoutMs * 0.6))) }));
        // 三道闸：站点失效提示 → 死链；正文不含查询关键词 → JS 渲染页抓到的页脚垃圾；
        // 都过不了就不收，宁可只有摘要列表也不往资料里塞噪音。
        const dead = page && page.ok
          && /失效|已删除|被删除|不存在|查无此页|您访问的页面|找不到页面|404 Not Found/.test(page.article.slice(0, 120));
        const relevant = page && page.ok && !dead
          && page.article.length > 60
          // 只给抓回来的正文打分（title 来自搜索结果，本来就含关键词，凑进去会放过页脚垃圾）。
          && quality.relevanceScore(q, { title: '', snippet: page.article }) > 0;
        if (relevant) {
          value.items = [{ title: (page.title || top.title) + '（正文摘录）', url: page.url || top.url,
            snippet: page.article, provider: 'page' }, ...value.items];
          break;
        }
      }
    }
    return finish(value);
  };
  let timer, abort;
  let partial = null;   // run() 里已经成功拿到、但整体 deadline 先到的部分结果
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise((_, reject) => {
        abort = () => { controller.abort(); reject(searchError('aborted')); };
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => { controller.abort(); reject(searchError('deadline_exceeded')); }, Math.max(0, deadline - Date.now()));
      }),
    ]);
  } catch (err) {
    const info = errorInfo(err);
    say('failed', info);
    // 超时/中止时若已有部分结果，照常 finish——4 条相关摘要比一条 failed 有用得多。
    if (partial && partial.items && partial.items.length) return finish(partial);
    return finish(result([], { status: 'failed', reason: info.code }));
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
    controller.abort();
  }
}

module.exports = { search };
