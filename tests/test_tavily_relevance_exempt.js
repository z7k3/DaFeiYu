'use strict';

// Tavily 结构化源与抓取源的阈值分离：
// 2026-11-14 实见「CS2 top20」：tavily 6 条高质量结果被中文 bigram 覆盖率阈值
// 砍掉 5 条，坑位被中文碎片页补满 → 她只能拼出零碎名单。
const test = require('node:test');
const assert = require('node:assert/strict');
const { keepRelevant } = require('../src/core/search/quality');

test('英文 tavily 结果（中文 bigram 低覆盖）不再被阈值砍掉，且排在抓取碎片前', () => {
  const items = [
    { provider: 'tavily', title: 'HLTV Top 20 players of 2025',
      snippet: 'complete ranking donk m0NESY ZywOo sh1ro XANTARES YEKINDAR', url: 'https://e.test/hltv' },
    { provider: 'so360', title: '零碎提及页', snippet: 'CS2 2025 top20 名单 XANTARES 第14名YEKINDAR', url: 'https://e.test/frag' },
    { provider: 'so360', title: '完全无关页', snippet: 'CS2', url: 'https://e.test/x' },
  ];
  const kept = keepRelevant('CS2 2025年top20名单', items).map(x => x.url);
  assert.ok(kept.includes('https://e.test/hltv'), '英文 tavily 证据不能被覆盖率阈值砍掉');
  assert.equal(kept[0], 'https://e.test/hltv', '结构化源排在抓取碎片之前');
  assert.ok(!kept.includes('https://e.test/x'), '纯泛词条目仍被淘汰');
});

test('tavily 条目仍受硬规则约束（年份错位/型号冲突照旧砍）', () => {
  const items = [
    { provider: 'tavily', title: 'HLTV Top 20 players of 2024',
      snippet: '2024 ranking donk first', url: 'https://e.test/2024' },
  ];
  assert.deepEqual(keepRelevant('CS 2025年top20名单', items), [], '讲 2024 的不能当 2025 的答案');
});
