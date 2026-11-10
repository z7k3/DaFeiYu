'use strict';

/**
 * 百度百科：梗 / 流行语类查询的专用源（走官方开放词条卡 API）。
 *
 * 为什么需要它：热梗的释义集中在百度百科，通用搜索结果里排位不稳，还经常
 * 被相关性过滤器整页拒掉（实测 bing 返回 10 条全部 rejected）。
 * 为什么走 openapi 而不是直接抓词条页：baike.baidu.com/item/… 对无 Cookie
 * 的请求返回 403（实测），而 BaikeLemmaCardApi 开放接口直接给 JSON 的
 * title/abstract/url，一次请求拿到高置信度摘要。
 * 词条不存在或触发风控时返回空数组，交给通用搜索兜底，不当作错误。
 */

const { getText } = require('./transport');
const { stripTags } = require('./html');

// 梗类问句特征：查询词带这些字样才走百科，普通查询不多打这一次请求。
const MEME_RE = /梗|什么意思|啥意思|是什么意思|出处|谁说的|哪里来的|流行语|网络用语|看不懂|听不懂|为什么火|怎么火/;

function cleanTerm(query) {
  // 百科词条是专名：去掉问句骨架后把空格也收掉（“city 不 city 梗”→“城市不city”），
  // 再剥掉残留的“是/了/啊”等语气碎屑（“绝绝子 是”→“绝绝子”），否则 API 查不到词条。
  const term = String(query || '')
    .replace(/site:[a-z0-9.-]+/gi, '')
    .replace(/百度百科|是什么梗|是个什么梗|是什么意思|是个什么意思|什么梗|什么意思|啥意思|的意思|的出处|出处|网络用语|流行语|为什么火|为什么突然火|怎么火的|看不懂|听不懂|梗/g, ' ')
    .replace(/[，。！？、!?\s]+/g, '')
    .replace(/(?:是|个|吗|呢|啊|呀|吧|哦|了|么)+$/g, '');
  return term.length >= 2 ? term : '';
}

async function search(query, opts = {}) {
  const term = cleanTerm(query);
  if (!term || term.length > 40) return [];
  const url = 'https://baike.baidu.com/api/openapi/BaikeLemmaCardApi?scope=103&format=json'
    + '&appid=379020&bk_key=' + encodeURIComponent(term) + '&bk_length=600';
  let raw;
  try {
    raw = await getText(url, { ...opts, timeoutMs: Math.min(Number(opts.timeoutMs) || 6000, 6000) });
  } catch (err) {
    if (['http_error', 'deadline_exceeded', 'blocked', 'too_many_redirects'].includes(err?.code)) return [];
    throw err;
  }
  let card;
  try { card = JSON.parse(raw); } catch { return []; }
  const abstract = stripTags(String(card.abstract || card.description || '')).trim();
  if (!abstract || abstract.length < 15) return [];
  const title = stripTags(String(card.title || '')).trim() || term;
  const link = String(card.url || '').replace(/^http:/, 'https:')
    || 'https://baike.baidu.com/item/' + encodeURIComponent(term);
  return [{ title: title + ' - 百度百科', url: link, snippet: abstract.slice(0, 500) }];
}

module.exports = { search, cleanTerm, MEME_RE };
