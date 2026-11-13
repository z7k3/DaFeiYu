'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const web = require('../src/adapters/websearch');

test('全部过期的资料不能恢复为有效结果', () => {
  assert.deepEqual(web.dropStaleResults('今天显卡价格', [
    { title: '显卡报价', snippet: '2010年3月4日 价格表' },
  ]), []);
});

test('摘要正文提到今天不能覆盖开头的旧发布日期', () => {
  const now = new Date(2026, 10, 6).getTime();
  assert.ok(web.parseSnippetAgeDays('2020年1月1日 今天我们介绍这款手机', now) > 2000);
  assert.equal(web.parseSnippetAgeDays('这款手机今天依然值得买', now), null);
});

test('指定型号时品牌命中不能抵消型号冲突', () => {
  const results = [
    { title: 'iPhone 15 Pro 价格', snippet: '苹果手机', url: 'https://example.test/15' },
    { title: 'iPhone 16 Pro 价格', snippet: '报价', url: 'https://example.test/16' },
    { title: 'iPhone 16 Pro Max 价格', snippet: '报价', url: 'https://example.test/max' },
  ];
  assert.deepEqual(web.keepRelevant('iPhone 16 Pro 多少钱', results).map(x => x.url), ['https://example.test/16']);
});

test('模糊的苹果机器查询不能直接改成 iPhone', () => {
  assert.doesNotMatch(web.cleanQuery('苹果最新的机器是什么'), /iphone/i);
  assert.match(web.cleanQuery('苹果最新的笔记本'), /Mac/);
});

test('中文主体不匹配时不能只凭价格或汽车等泛词保留资料', () => {
  const items = [
    { title: '华为汽车价格', snippet: '汽车报价', url: 'https://example.test/other' },
    { title: '小米汽车官方报价', snippet: '汽车价格', url: 'https://example.test/right' },
  ];
  assert.deepEqual(web.keepRelevant('小米汽车价格', items).map(x => x.url), ['https://example.test/right']);
});

test('模型 any 标签不能放宽用户明确要求的今天和本周', () => {
  assert.equal(web.effectiveMaxAgeDays('今天新闻', 'any'), 2);
  assert.equal(web.effectiveMaxAgeDays('本周赛事', 'any'), 7);
  assert.equal(web.effectiveMaxAgeDays('红楼梦作者', 'any'), null);
});


const quality = require('../src/core/search/quality');

test('相对时间词锚定成具体年份（以查询时刻为准，幂等）', () => {
  const now = new Date(2026, 10, 13);
  assert.equal(quality.anchorYears('CS去年的top20名单', now), 'CS2025年的top20名单');
  assert.equal(quality.anchorYears('今年出的新机', now), '2026年出的新机');
  assert.equal(quality.anchorYears('前年的冠军和大前年的纪录', now), '2024年的冠军和2023年的纪录');
  assert.equal(quality.anchorYears('南昌今天天气', now), '南昌今天天气');
  const once = quality.anchorYears('去年冠军今年赛程', now);
  assert.equal(quality.anchorYears(once, now), once);
});

test('查询带年份时，通篇讲别的年份的资料不能当答案', () => {
  const items = [
    { title: 'HLTV 2024年度top20', snippet: '2024 年度排名 donk 第一', url: 'https://e.test/2024' },
    { title: '2025年CS年度top20名单', snippet: '2025 年度排名出炉', url: 'https://e.test/2025' },
  ];
  assert.deepEqual(quality.keepRelevant('CS 2025年 top20 名单', items).map(x => x.url), ['https://e.test/2025']);
});

test('「去年/最近」这类回看词也算时效敏感，过期资料不再无限放行', () => {
  assert.equal(quality.isTimeSensitive('CS去年的top20名单'), true);
  assert.equal(quality.isTimeSensitive('最近的比赛结果'), true);
});
