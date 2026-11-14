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

test('首轮结果数量充足（6 条新闻页）也要发完整名单变体', async () => {
  const bodies = [];
  const opts = { timeoutMs: 8000, tavilyApiKey: 'thb-test', tavilyMaxResults: 6,
    _post: async (url, key, body) => {
      bodies.push(body.query);
      return String(body.query).includes('完整名单')
        ? { code: 0, data: { data: { results: [
            { title: '完整名单汇总页', url: 'https://e.test/all20', content: '1 ZywOo 2 donk …… 20 人齐全' }] } } }
        : { code: 0, data: { data: { results: [
            { title: '颁奖前三新闻', url: 'https://e.test/news' + bodies.length, content: 'ZywOo donk ropz 获得年度前三' }] } } };
    } };
  const value = await web.searchResult('去年CS2的top20都是谁', opts);
  const firstQuery = bodies[0];
  assert.match(firstQuery, /top20|名单|榜单|排名|排名/, '首轮就是名单类查询');
  assert.ok(bodies.some(q => q.includes('完整名单')), '数量充足也要发变体——新闻页不含完整名单');
  assert.ok(value.items.some(x => x.url === 'https://e.test/all20'), '汇总页要进证据');
});
