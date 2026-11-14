'use strict';

// 回归：tavily 源必须在源头带 provider 字段——web.ask 的 keepRelevant
// 发生在 provider 统一附加之前，漏了字段豁免就全部失效
//（2026-11-14 实见：17:30 查询 tavily 6 条又只活 1 条）。
const test = require('node:test');
const assert = require('node:assert/strict');
const web = require('../src/adapters/search/web');

const HUB = { code: 0, data: { data: { results: [
  { title: 'HLTV Top 20 players of 2025', url: 'https://www.hltv.org/news/x/top20',
    content: 'complete ranking of the best CS2 players: donk m0NESY ZywOo sh1ro and more' },
  { title: 'HLTV 年度榜单发布', url: 'https://www.hltv.org/news/y/ranking',
    content: 'The annual top20 ranking was revealed today with donk first' },
  { title: '无关页', url: 'https://x.test/other', content: 'unrelated content here' },
] } } };

test('真实管道：英文 tavily 结果不再被中文覆盖率阈值砍掉', async () => {
  const value = await web.searchResult('你知道去年CS2的top20都是谁吗', {
    timeoutMs: 3000, tavilyApiKey: 'thb-test',
    _post: async () => JSON.parse(JSON.stringify(HUB)),
  });
  const tav = value.items.filter(x => x.provider === 'tavily');
  assert.ok(tav.length >= 2, '英文证据必须存活（实际 ' + tav.length + ' 条）');
  assert.equal(value.items[0].provider, 'tavily', '结构化源排最前');
});
