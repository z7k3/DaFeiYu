'use strict';

// 名单类查询：tavily 第二轮「完整名单」变体要真的发出去，并把汇总页带回来。
// 2026-11-14 实见 HLTV top20：单轮只有颁奖前三的新闻，20 人汇总页搜不到。
const test = require('node:test');
const assert = require('node:assert/strict');
const web = require('../src/adapters/search/web');

const HUB1 = { code: 0, data: { data: { results: [
  { title: 'Top3 颁奖新闻', url: 'https://e.test/top3', content: 'ZywOo donk ropz 获得年度前三' },
] } } };
const HUB2 = { code: 0, data: { data: { results: [
  { title: 'HLTV top20 完整名单汇总', url: 'https://e.test/full20', content: '完整名单 1 ZywOo 2 donk 3 ropz 4 m0NESY 5 sh1ro …… 20 名单到此齐全' },
] } } };

test('名单类查询发第二轮「完整名单」变体并带回汇总页', async () => {
  const bodies = [];
  const opts = { timeoutMs: 8000, tavilyApiKey: 'thb-test', tavilyMaxResults: 6,
    _post: async (url, key, body) => {
      bodies.push(body.query);
      return String(body.query).includes('完整名单') ? JSON.parse(JSON.stringify(HUB2)) : JSON.parse(JSON.stringify(HUB1));
    } };
  const value = await web.searchResult('Falcons 队员名单', opts);
  const tavCalls = bodies.filter(q => q.includes('完整名单')).length;
  assert.ok(tavCalls >= 1, '要有一轮完整名单变体查询');
  assert.ok(value.items.some(x => x.url === 'https://e.test/full20'), '汇总页要进证据');
});
