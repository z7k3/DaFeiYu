'use strict';

// Tavily 兼容源：解析、无 Key 缺席、以及「给了足量结果就不再打扰 bing/360」的编排。
const test = require('node:test');
const assert = require('node:assert/strict');
const { search, extractResults, extractAnswer } = require('../src/adapters/search/tavily');
const web = require('../src/adapters/search/web');

const HUB = { code: 0, data: { ok: true, data: {
  answer: '已整理出可核实的队员资料。',
  results: [
    { title: 'Falcons 阵容', url: 'https://liquipedia.net/cs2/Falcons', content: 'CS2 Player Roster: m0NESY NiKo karrigan',
      raw_content: '完整来源正文。'.repeat(100), score: 0.92, published_date: '2026-11-12' },
    { title: 'Falcons 战队百科', url: 'https://baike.test/falcons', content: 'Falcons 是沙特电竞组织',
      raw_content: '', score: 0.6, published_date: '2026-10-01' },
  ],
} } };

test('网关双层包裹与官方顶层 results 两种结构都能解析', () => {
  assert.equal(extractResults(HUB).length, 2);
  assert.equal(extractResults({ results: [{ title: 't', url: 'u', content: 'c' }] }).length, 1);
  assert.deepEqual(extractResults({}), []);
  assert.equal(extractAnswer(HUB), HUB.data.data.answer);
  assert.equal(extractAnswer({ data: { answer: 'outer', data: { results: [] } } }), 'outer');
});

test('请求高级答案和正文，并保留摘要、原文、分数与发布时间', async () => {
  let sent;
  const response = await search('Falcons 阵容', {
    timeoutMs: 1000, tavilyApiKey: 'thb-test', _post: async (_url, _key, body) => { sent = body; return HUB; },
  });
  assert.equal(sent.search_depth, 'advanced');
  assert.equal(sent.include_answer, 'advanced');
  assert.equal(sent.include_raw_content, 'text');
  assert.equal(response.answer, HUB.data.data.answer);
  assert.equal(response.items[0].rawContent, HUB.data.data.results[0].raw_content);
  assert.equal(response.items[0].score, 0.92);
  assert.equal(response.items[0].publishedAt, '2026-11-12');
});

test('未配置 Key：tavily 直接缺席不抛错', async () => {
  await assert.rejects(search('q', {}), /tavily_disabled/);
});

test('tavily 给足 ≥2 条有效结果时，bing/360 整轮不再被调用', async (t) => {
  const calls = [];
  const https = require('node:https');
  t.mock.method(https, 'get', () => { calls.push('get'); return { on() {}, destroy() {} }; });
  const opts = { timeoutMs: 3000, tavilyApiKey: 'thb-test', tavilyMaxResults: 6,
    _post: async () => JSON.parse(JSON.stringify(HUB)) };
  const value = await web.searchResult('Falcons 队员名单', opts);
  assert.equal(value.status, 'ok');
  assert.equal(value.items[0].provider, 'tavily');
  assert.equal(value.answer, HUB.data.data.answer);
  assert.equal(value.items[0].rawContent, HUB.data.data.results[0].raw_content);
  assert.equal(value.items[0].publishedAt, '2026-11-12');
  assert.ok(value.items.length >= 2, '至少 tavily 两条');
  assert.deepEqual(calls, [], 'bing/360 整轮跳过（连 http get 都不发）');
});

test('tavily 结果不足 2 条时，bing/360 照常并行补位', async (t) => {
  const one = { code: 0, data: { data: { results: [HUB.data.data.results[0]] } } };
  const calls = [];
  const https = require('node:https');
  t.mock.method(https, 'get', (url, options, cb) => { calls.push(String(url)); const res = { on(e, h) { if (e === 'data') h(Buffer.from('<li class="b_algo"><h2><a href="https://example.test/b">补位</a></h2></li>')); if (e === 'end') h(); }, statusCode: 200, headers: {}, destroy() {}, resume() {} }; cb(res); });
  const opts = { timeoutMs: 3000, tavilyApiKey: 'thb-test', _post: async () => one };
  const value = await web.searchResult('Falcons 队员名单', opts);
  assert.ok(value.items.length >= 1);
  assert.ok(calls.some(u => u.includes('bing.com')), '不足时 bing 要补位');
});
