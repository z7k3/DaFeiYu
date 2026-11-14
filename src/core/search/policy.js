'use strict';

const KEYWORDS = /(查一下|查查|搜一下|搜搜|帮我查|帮我看看|最新|热搜|新闻|发生了什么|怎么回事|多少钱|什么价格|几块钱|什么时候|是谁|谁是|行情|报价|天气|下雨|下雪|气温|多少度|冷不冷|热不热|台风|雾霾|空气质量|出到|第几代|几代|什么型号|哪个型号|哪个版本|什么版本|现在还|今年|去年|苹果|iphone|ipad|华为|小米|三星|索尼|任天堂|switch|ps5|显卡|rtx|骁龙|麒麟|芯片|发布会|歌词|原唱|主题曲|插曲|片尾曲|台词|诗文|攻略|原文|找一段|来一段|网上找|在哪看|哪里能|资源|名单|目录|教程|怎么玩|怎么弄|怎么做|步骤|有哪些)/i;
const FACT = /(是什么|是谁|多少|几号|几点|怎么样|怎么|为什么|哪一?[个些张条]|有没有|是不是|能不能|会不会|可不可以|排行|排名|热搜|热榜|热门|最新|出到|第几)/;
const CHITCHAT = /^(在吗|在不在|你好|嗨|hi|哈喽|早安|晚安|睡了|吃饭了吗|吃了吗|你在干嘛|在干啥|干啥呢|干嘛呢)/i;
const OPINION = /(你觉得|你认为|你看|你怎么看|该不该|要不要|喜不喜欢|喜欢吗|讨厌|爱我吗|想我了吗)/;
// 会随年份/赛季变化的「统计事实」信号：榜单、排名、冠军、比分、销量、版本……这类东西
// 模型记忆永远不可靠（训练截止≠今天），语义路由却常把它误判成「模型自己知道」——
// 实见：「你知道CS去年的top20名单吗」被判 need=false，她拿 2024 年的记忆冒充 2025 榜单。
// 命中即视为必须检索的强信号：路由说「不用查」也要查（见 services/search.js 的 skip 条件）。
const VOLATILE = /(排行|排名|榜单|名单|前十|前二十|前三|top\s*\d+|第几|冠军|亚军|季军|夺冠|卫冕|比分|战绩|胜率|连胜|销量|出货量|票房|收视率|播放量|在线人数|市场份额|市场占有率|最新版本|版本号|更新公告|补丁|赛季|段位|登顶|榜首)/i;
const DOMAINS = { bilibili: 'bilibili.com', weibo: 'weibo.com', toutiao: 'toutiao.com' };

function gate(text, mode) {
  const keyword = KEYWORDS.test(text);
  const fact = FACT.test(text) && !CHITCHAT.test(text.trim()) && !OPINION.test(text);
  // 统计事实和闲聊/观点互斥：问「你觉得谁最强」可以凭感觉答，问「谁拿了冠军」不行。
  const volatile = VOLATILE.test(text) && !CHITCHAT.test(text.trim()) && !OPINION.test(text);
  // 干嘛/干啥/咋/啥系口语疑问词必须放行：实见「马斯克最近在干嘛」没问号也没关键词，
  // 连语义路由都没被咨询就直接 local_not_needed——用户眼里的「她在装死」。
  const colloquial = /(干嘛|干啥|咋样|咋办|咋整|咋了|咋回事|啥时候|啥意思|啥情况)/.test(text);
  return { fallback: keyword || fact, volatile, route: mode === true || (mode !== false && (keyword || fact || colloquial || /[?？]|吗|呢|什么|怎么|多少|几[个号点]|谁|哪|为什么|如何|查|搜|最新|今天|现在|价格|天气/.test(text))) };
}

function inferKind(text) {
  if (/(天气|下雨|下雪|气温|多少度|冷不冷|热不热|带伞)/.test(text)) return 'weather';
  const plain = text.replace(/^(?:帮我|请)?(?:查一下|查查|搜一下|看看)?\s*/, '').replace(/[?？。！!]+$/, '');
  if (/^(?:(?:b站|哔哩哔哩|bilibili|微博|weibo|今日头条|头条)的?)?(?:今天|今日|现在|最新)?的?(?:热搜|热榜|热点榜|排行榜|热门榜)(?:是什么|有哪些|前十|前十名)?$/i.test(plain)
    || /^(?:今天|今日|现在|刚刚|最新|最近|这两天)?(?:的|有|什么|哪些|热点|重大|最新)*(?:新闻|热点|大事件|大事|头条)(?:是什么|有哪些|发生了什么)?$/.test(plain)
    || /^(?:今天|今日|最近)?发生了什么$/.test(plain)) return 'hotlist';
  return 'web';
}

function weatherSupported(text, timeRange) {
  // 中国天气网（主源）给实况 + 今天起 5 天预报 + 预警 + AQI，所以「周末/这周/后天/
  // 空气质量」都能答；只有「历史/去年/昨天」这类回看的，以及超过 5 天的才必须走网页。
  const backward = /(历史|去年|前年|昨天|前天|上周|上个月|往期)/;
  const beyond5 = /(下周|下个月|未来一周|一周天气|[6-9]\s*天|十[几多]?天|20\d{2}\s*[年\-/]|\d+\s*月\s*\d+\s*日)/;
  // 台风路径不在天气接口的数据里（实况/预报/预警/AQI 才有），硬走专用接口只会拿
  // 「当地天气」冒充路径；必须走网页搜路径动态（与路由提示词的口径一致）。
  if (backward.test(text) || beyond5.test(text) || /台风/.test(text)) return false;
  return !timeRange || ['today', 'tomorrow', 'current', 'any', 'week', 'future'].includes(timeRange);
}

function intent(text, route = {}) {
  const site = /(b站|哔哩哔哩|bilibili)/i.test(text) ? 'bilibili'
    : /(微博|weibo)/i.test(text) ? 'weibo' : /(今日头条|头条)/.test(text) ? 'toutiao' : route.site || '';
  let kind = route.kind || inferKind(text);
  if (kind === 'weather' && !weatherSupported(text, route.timeRange)) kind = 'web';
  return { kind, site, city: route.city || '', timeRange: route.timeRange || null,
    query: String(route.need && route.query ? route.query : text).trim().slice(0, 100),
    fresh: route.failed ? undefined : route.fresh };
}

function cityCandidate(text) {
  return String(text).replace(/(今天|明天|现在|早上|上午|中午|下午|晚上|夜里)/g, ' ')
    .replace(/(天气|气温|温度|怎么样|如何|多少度|冷不冷|热不热|下雨|下雪|要不要带伞|带伞)/g, ' ')
    .replace(/[?？!！。，,、\s]+/g, ' ').trim()
    .replace(/^(?:帮我|请|查一下|查查|看看|的|会不会|会|要不要|吗|呢|呀|啊|\s)+/, '')
    .replace(/(?:的|会不会|会|要不要|吗|呢|呀|啊|\s)+$/, '').trim();
}

module.exports = { gate, inferKind, intent, cityCandidate, weatherSupported, DOMAINS };
