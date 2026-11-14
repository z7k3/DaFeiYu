'use strict';

// 「去年/前年/最近/上个月」也是时效词：问「去年的榜单」时，几年前的旧文不该无限放行
// （实见：CS 去年 top20 的查询完全不限新鲜度，旧年份名单文章畅通无阻地当了证据）。
const TIME_SENSITIVE_RE = /(最新|现在|今年|去年|前年|最近|近期|上个月|上月|上周|目前|当前|今天|今日|刚刚|实时|这周|本周|最近几天|这两天|出到几|第几代|什么型号|哪个版本|多少钱|什么价|行情|发布会|刚出|新出)/;
const STOP_WORDS = /(帮我|请问|请|一下|查查|查一查|搜搜|搜索|看看|我想知道|你知道|知道|谁是|是谁|这个|那个|什么|怎么|为什么|是不是|有没有|最新|现在|目前|当前|今天|多少钱|什么价|价格是|怎么样|如何|的|吗|呢|啊|呀|吧|了|嘛|呗)/gi;
const GENERIC = new Set(['谁是', '是谁', '这个', '那个', '一个', '什么', '怎么', '为什', '时候', '东西',
  '事情', '问题', '方法', '我们', '你们', '他们', '自己', '可以', '不是', '就是', '还是', '如果', '但是',
  '所以', '因为', '这样', '那样', '知道', '觉得', '应该', '需要', '很多', '非常', '真的', '一直',
  '已经', '开始', '结束', '现在', '今天', '明天', '如何', '哪些']);
const ALIASES = { 苹果: ['iphone', 'apple', 'mac', 'ipad'], iphone: ['苹果'], mac: ['macbook'] };
// 时间词只表达「什么时候」，不承载「查什么」：它们既不能当必须命中的锚点
// （实见「今晚南昌天气」→ 锚点「今晚南昌」把全部结果拒掉），也不能参与分词
// （「原神最近有新活动」桥接出「神最/近有/有新」这种结果页永远不会有的大米词，
// 把覆盖率分母撑大）。锚点计算和 queryTokens 都要先剥掉它们。
const TOKEN_TIME_RE = /(今天|今日|今晚|今早|昨天|昨日|昨晚|前天|明天|明早|明晚|后天|现在|目前|当前|最近|近期|最新|刚刚|刚才|本周|这周|下周|上周|周末|早上|上午|中午|下午|晚上|夜里|凌晨|今年|去年|前年|大前年)/g;

function expandBrand(text) {
  const s = String(text || '');
  if (/\b(?:iphone|ipad|mac(?:book)?|watch|airpods)\b/i.test(s)) return s;
  // “机器”不足以确定产品线，只有明确手机/电脑语境才扩展。
  if (/(苹果|apple)/i.test(s) && /(电脑|笔记本)/.test(s)) return s.replace(/苹果电脑|苹果笔记本|苹果|apple/gi, 'Mac');
  if (/(苹果|apple)/i.test(s) && /手机/.test(s)) return s.replace(/苹果手机|苹果|apple/gi, 'iPhone');
  return s;
}

function queryTokens(query) {
  // 单字虚词（有/和/跟/就…）也不参与分词：它们跨在词边界上会造出「有新」这类
  // 结果页永远不会有的大米词，把覆盖率分母撑大（实测原神官网活动页被拖到 2/6）。
  const text = expandBrand(String(query || '').replace(/\bsite:[a-z0-9.-]+/gi, '')).replace(STOP_WORDS, ' ').replace(TOKEN_TIME_RE, ' ').replace(/[有在和跟与就也都还又把被对向或而且]/g, ' ');
  const tokens = (text.match(/[a-z0-9][a-z0-9+.\-]{1,}/gi) || []).map(x => x.toLowerCase());
  for (const run of text.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    for (let i = 0; i + 1 < run.length; i++) tokens.push(run.slice(i, i + 2));
    if (run.length <= 4) tokens.push(run);
  }
  return [...new Set(tokens)].filter(x => !GENERIC.has(x));
}

/** 相对时间词锚定成具体年份：搜索引擎不认「去年」，锚定后才能命中用户真正指的那一年。 */
function anchorYears(text, now = new Date()) {
  const t = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const y = t.getFullYear();
  return String(text || '')
    .replace(/大前年/g, (y - 3) + '年')
    .replace(/前年/g, (y - 2) + '年')
    .replace(/去年/g, (y - 1) + '年')
    .replace(/今年/g, y + '年');
}

function cleanQuery(query) {
  let text = String(query || '').replace(/^\s*(帮我|请|你|麻烦)?\s*(查一下|查查|查一查|查|搜一下|搜搜|搜|找一下|找|看看)/, ' ')
    .replace(STOP_WORDS, ' ').replace(/[，。！？、!?]/g, ' ').replace(/\s+/g, ' ').trim();
  text = expandBrand(text).replace(/\s*(是|有|在|了)\s*$/g, '').trim();
  if (/(多少钱|什么价|价格|报价)/.test(query) && !/价格|报价|行情/.test(text)) text = (text + ' 价格').trim();
  return text || String(query || '').trim();
}

function modelNames(text) {
  return (String(text).match(/\b(?:iphone\s*\d+(?:\s*(?:pro\s*max|pro|plus|mini|air))?|(?:rtx|gtx)\s*\d+(?:\s*(?:ti|super))?|deepseek\s*v\d+(?:\.\d+)*|[ma]\d+(?:\s*(?:pro|max|ultra))?)\b/gi) || [])
    .map(x => x.toLowerCase().replace(/\s+/g, ''));
}

function relevanceScore(query, item) {
  const hay = `${item.title || ''} ${item.snippet || ''}`.toLowerCase();
  if (/(手机|机器|机型|型号|iphone)/i.test(query) && /(蔷薇科|苹果属|malus|水果|落叶乔木|果树)/i.test(hay)) return 0;
  const models = modelNames(query);
  const found = modelNames(hay);
  if (models.length && !models.every(x => found.includes(x))) return 0;
  // 查询里带明确年份时，通篇讲别的年份的资料等于答非所问——「2025 年的榜单」配上
  // 2024 年的名单文章，正是「她拿旧年份当去年」这类错误的证据侧根源。正文一个年份
  // 都没有的没法核对年份，照常打分，交给其余规则把关。
  const wantedYears = String(query).match(/(?<!\d)20\d{2}(?!\d)/g);
  if (wantedYears && wantedYears.length) {
    const hayYears = hay.match(/(?<!\d)20\d{2}(?!\d)/g) || [];
    if (hayYears.length && !hayYears.some(y => wantedYears.includes(y))) return 0;
  }
  const tokens = queryTokens(query);
  if (!tokens.length) return 1;
  const hits = tokens.filter(t => hay.includes(t) || (ALIASES[t] || []).some(a => hay.includes(a)));
    const coverage = tokens.length ? hits / tokens.length : 1;
  if (!hits.length) return 0;
  // 有明确英文实体时，不能只靠“价格/更新”等泛词留下另一种产品。
  const entities = tokens.filter(t => /^[a-z]/.test(t) && !['pro', 'max', 'plus', 'mini', 'air'].includes(t));
  if (entities.length && !entities.some(t => hay.includes(t) || (ALIASES[t] || []).some(a => hay.includes(a)))) return 0;
  // 中文短主体（小米汽车、小蓝鲸、北京）不能仅靠“价格/天气”等需求词命中。
  // 长句暂不强行切实体，避免二字分词把自然问句误当成完整专名。
  const topics = cleanQuery(query).replace(/\bsite:[a-z0-9.-]+/gi, '')
    .replace(/B站|哔哩哔哩|微博|今日头条/gi, ' ')
    .replace(TOKEN_TIME_RE, ' ')
    .replace(/明天|后天|多少度|天气|气温|温度|预报|下雨|下雪|会不会|会|价格|报价|售价|价位|行情|热搜|热榜|新闻|更新|进度|发布|上市|机型|型号|机器|推荐|是什么|怎么样|副歌|歌词|原文|全文|攻略|台词|诗文|含义|出处|背景|步骤|教程|怎么玩|怎么弄|怎么做|完整|一段/g, ' ')
    .match(/[\u4e00-\u9fa5]{2,}/g) || [];
  const anchors = topics.filter(x => x.length <= 4);
  if (!entities.length && anchors.length && !anchors.some(t => hay.includes(t) || (ALIASES[t] || []).some(a => hay.includes(a)))) return 0;
  const title = String(item.title || '').toLowerCase();
  return hits.length / tokens.length + hits.filter(t => title.includes(t)).length + models.length * 4;
}

function keepRelevant(query, results) {
  const tokens = queryTokens(query);
  const qYears = String(query).match(/(?<!\d)20\d{2}(?!\d)/g) || [];
  const scored = results.map((item, index) => {
    const hay = ((item.title || '') + ' ' + (item.snippet || '')).toLowerCase();
    const raw = relevanceScore(query, item);
    const trusted = item.provider === 'tavily';
    if (trusted) {
      // 硬规则对 tavily 也生效：年份错位/型号冲突的资料直接出局。
      const hayYears = hay.match(/(?<!\d)20\d{2}(?!\d)/g) || [];
      if (qYears.length && hayYears.length && !qYears.some(y => hayYears.includes(y))) {
        return { item, index, score: 0, trusted: true, coverage: 0 };
      }
      const models = modelNames(query);
      const found = modelNames(hay);
      if (models.length && !models.every(x => found.includes(x))) {
        return { item, index, score: 0, trusted: true, coverage: 0 };
      }
      // 跨语言最佳证据：中文 bigram 分母压分没关系——结构化源自身带语义评分，
      // 给保底分并排在抓取碎片之前（实见 CS2 top20：tavily 6 条只活 1 条）。
      const providerScore = item.score == null || item.score === '' ? NaN : Number(item.score);
      const score = Number.isFinite(providerScore) ? providerScore + 10 : Math.max(raw, 1) + 10;
      return { item, index, score, trusted: true, coverage: 1 };
    }
    const hits = tokens.filter(t => hay.includes(t) || (ALIASES[t] || []).some(a => hay.includes(a))).length;
    const coverage = tokens.length ? hits / tokens.length : 1;
    return { item, index, score: raw, coverage, trusted: false };
  });
  const plain = scored.filter(x => !x.trusted);
  const best = plain.reduce((m, x) => Math.max(m, x.coverage), 0);
  // 覆盖率相对阈值只作用于抓取源：池子里有高覆盖答案时，只擦到一两个泛词的
  // 搭便车条目不该混进资料。但阈值永远不超过池内最佳值——池子整体都弱时
  // 保留弱证据，宁可让 persona 说明证据不足，也不能把「查到了」变成「没查到」。
  const bar = best > 0 ? Math.min(Math.max(0.34, best * 0.6), best) : 0;
  return scored.filter(x => x.score > 0 && (x.trusted || x.coverage >= bar))
    .sort((a, b) => b.score - a.score || a.index - b.index).map(x => x.item);
}

function parseSnippetAgeDays(snippet, nowMs = Date.now()) {
  const s = String(snippet || '').replace(/&ensp;|&#8194;|&nbsp;/g, ' ').trim();
  const now = new Date(nowMs);
  // 只读开头的时间标记。正文的“今天/去年”可能是事件时间，不是发布时间。
  const prefix = s.replace(/^(?:发布(?:于|时间)?|更新(?:于|时间)?)\s*[:：]?\s*/, '');
  let m = prefix.match(/^(20\d{2})\s*[年\-/]\s*(\d{1,2})\s*[月\-/]\s*(\d{1,2})/);
  let year, month, day;
  if (m) [, year, month, day] = m.map(Number);
  else {
    m = prefix.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (m) {
      year = now.getFullYear(); month = Number(m[1]); day = Number(m[2]);
      if (new Date(year, month - 1, day).getTime() > nowMs + 86400000) year--;
    }
  }
  if (year) {
    const date = new Date(year, month - 1, day);
    if (date.getMonth() !== month - 1 || date.getDate() !== day || date.getTime() > nowMs + 86400000) return null;
    return Math.max(0, (nowMs - date.getTime()) / 86400000);
  }
  if (/^(刚刚|刚才)/.test(prefix)) return 0;
  if (/^(今天|今日)/.test(prefix)) return 0.5;
  if (/^(昨天|昨日)/.test(prefix)) return 1;
  if (/^(前天|前日)/.test(prefix)) return 2;
  m = prefix.match(/^(\d+)\s*(分钟|小时|天|周|个月|月|年)\s*(?:之)?前/);
  if (m) return Number(m[1]) * ({ 分钟: 1 / 1440, 小时: 1 / 24, 天: 1, 周: 7, 个月: 30, 月: 30, 年: 365 }[m[2]]);
  return null;
}

function tightenFreshness(query, limit) {
  if (/(今天|今日|刚刚|刚才|实时|现在|此刻)/.test(query)) return limit == null ? 2 : Math.min(Number(limit), 2);
  if (/(这周|本周|最近几天|这两天|近几天)/.test(query)) return limit == null ? 7 : Math.min(Number(limit), 7);
  return limit;
}

function effectiveMaxAgeDays(query, routeFresh, timeRange) {
  // 用户明确的今天/本周约束优先于模型的宽泛时效标签。
  const base = routeFresh === 'any' || timeRange === 'history' ? null : routeFresh === 'strict' ? 90 : routeFresh === 'normal' ? 365 : undefined;
  const limit = tightenFreshness(query, base);
  const rangeLimit = ['current', 'today', 'tomorrow'].includes(timeRange) ? 2 : timeRange === 'week' ? 7 : null;
  return rangeLimit === null ? limit : limit == null ? rangeLimit : Math.min(limit, rangeLimit);
}

function isTimeSensitive(query) { return TIME_SENSITIVE_RE.test(String(query || '')); }

function splitFreshness(query, results, { maxAgeDays, nowMs = Date.now() } = {}) {
  const unlimited = maxAgeDays === null || maxAgeDays === Infinity || (maxAgeDays === undefined && !isTimeSensitive(query));
  const limit = tightenFreshness(query, maxAgeDays === undefined ? 550 : maxAgeDays);
  const items = [], staleItems = [];
  for (const item of results) {
    const published = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
    const age = Number.isFinite(published) ? (nowMs - published) / 86400000 : parseSnippetAgeDays(item.snippet || '', nowMs);
    (unlimited || age === null || age <= limit ? items : staleItems).push(item);
  }
  return { items, staleItems };
}

function dropStaleResults(query, results, opts) { return splitFreshness(query, results, opts).items; }

module.exports = { expandBrand, cleanQuery, anchorYears, queryTokens, modelNames, relevanceScore, keepRelevant,
  parseSnippetAgeDays, tightenFreshness, effectiveMaxAgeDays, isTimeSensitive, splitFreshness, dropStaleResults };
