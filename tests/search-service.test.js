'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { search } = require('../src/services/search');
const { result, formatResult } = require('../src/core/search/result');
const { parseRoute, systemFor } = require('../src/adapters/searchRouter');
const { weatherSnippet } = require('../src/adapters/search/weather');

const evidence = provider => result([{ title: '测试资料', snippet: '可核实的事实', url: 'https://example.test/source',
  provider, fetchedAt: '2026-11-06T00:00:00Z', publishedAt: null }]);

function fixture(route = {}) {
  const calls = [];
  const deps = {
    route: async () => ({ need: true, query: '测试检索', fresh: 'normal', ...route }),
    providers: Object.fromEntries(['weatherResult', 'hotlistResult', 'searchResult'].map(method => [method, async (...args) => {
      calls.push({ method, args });
      return evidence(method);
    }])),
    places: { geocodeCity: async () => null, ipCity: async () => '' },
  };
  const run = (text, extra = {}) => search({ text, config: { semanticRoute: true, timeoutMs: 1000 }, ...extra }, deps);
  return { calls, deps, run };
}

test('路由完整意图直接驱动数据源，旧格式仍能回退规则', async () => {
  const parsed = parseRoute('{"need":true,"kind":"weather","query":"北京 降水","city":"北京","timeRange":"tomorrow"}');
  assert.equal(parsed.kind, 'weather');
  assert.equal(parsed.timeRange, 'tomorrow');
  assert.equal(parseRoute('{"need":true,"kind":"unknown","query":"x"}'), null);
  assert.equal(parseRoute('{"need":true,"query":"x","timeRange":"broken"}'), null);
  const f = fixture(parsed);
  const value = await f.run('明天出门需要带点什么');
  assert.equal(f.calls[0].method, 'weatherResult');
  assert.equal(value.status, 'ok');
  assert.match(value.text, /open|weatherResult/);
});

test('空气质量/后天/周末走天气专用接口；台风路径、远期和指定日期走网页', async () => {
  // 中国天气网给实况 + 未来 5 天 + 预警 + AQI（1425037 起），这三类用专用接口答得更好；
  // 台风路径不在接口数据里，回看类和超 5 天的也拿不到——都走网页（policy.weatherSupported）。
  for (const text of ['北京空气质量', '北京后天天气', '北京周末天气']) {
    const f = fixture({ kind: 'weather', city: '北京' });
    await f.run(text);
    assert.deepEqual(f.calls.map(x => x.method), ['weatherResult'], text);
  }
  for (const text of ['北京台风路径', '北京2027年1月1日天气', '北京去年天气']) {
    const f = fixture({ kind: 'weather', city: '北京' });
    await f.run(text);
    assert.deepEqual(f.calls.map(x => x.method), ['searchResult'], text);
  }
});

test('模型明确要求普通检索时不再用关键词覆盖为热榜', async () => {
  const f = fixture({ kind: 'web', site: 'weibo', query: '微博 某事件 热搜 原因' });
  await f.run('微博某事件为什么上热搜');
  assert.equal(f.calls[0].method, 'searchResult');
  assert.match(f.calls[0].args[0], /site:weibo\.com$/);
});

test('路由失败时具体主题新闻仍查主题，不取全站榜单', async () => {
  const f = fixture({ need: false, failed: true });
  await f.run('今天小米汽车的新闻有哪些');
  assert.equal(f.calls[0].method, 'searchResult');
  assert.match(f.calls[0].args[0], /小米汽车/);
});

test('问题地点优先于默认城市，无法解析也不偷偷换成默认城市', async () => {
  const f = fixture({ kind: 'weather', query: '杭州 明天 天气' });
  const place = { name: '杭州', latitude: 30, longitude: 120, timezone: 'Asia/Shanghai' };
  f.deps.places.geocodeCity = async name => { assert.equal(name, '杭州'); return place; };
  await f.run('杭州明天会下雨吗', { config: { city: '上海' } });
  assert.equal(f.calls[0].args[0], '杭州');
  assert.equal(f.calls[0].args[1].place, place, '已解析地点不重复地理编码');
  f.calls.length = 0;
  f.deps.places.geocodeCity = async () => null;
  await f.run('杭州明天会下雨吗', { config: { city: '上海' } });
  assert.equal(f.calls[0].method, 'searchResult');
  assert.doesNotMatch(f.calls[0].args[0], /上海/);
});

test('省略地点时使用配置或 IP，天气失败保留明天需求', async () => {
  const f = fixture({ kind: 'weather', query: '明天 下雨' });
  f.deps.places.ipCity = async () => '杭州';
  f.deps.providers.weatherResult = async (city, opts) => {
    assert.equal(city, '杭州');
    assert.ok(opts.timeoutMs < 1000);
    return result([], { status: 'failed', reason: 'http_error', attempts: [{ provider: 'open-meteo', status: 'failed', statusCode: 503 }] });
  };
  const value = await f.run('明天会下雨吗');
  assert.equal(value.status, 'ok');
  assert.match(f.calls[0].args[0], /杭州.*明天/);
  assert.ok(value.attempts.some(x => x.provider === 'open-meteo' && x.status === 'failed'));
});

test('关闭联网不读取历史，空结果与异常有不同状态', async () => {
  const f = fixture();
  const off = await f.run('查一下价格', { config: { enabled: false }, history: () => { throw new Error('must not read'); } });
  assert.equal(off.status, 'skipped');
  assert.equal(f.calls.length, 0);
  f.deps.providers.searchResult = async () => result();
  assert.equal((await f.run('查一下价格')).status, 'empty');
  f.deps.providers.searchResult = async () => { throw new Error('query and private response'); };
  const logs = [];
  const failed = await f.run('查一下价格', { trace: (stage, data) => logs.push({ stage, ...data }) });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.text, '');
  assert.ok(logs.some(x => x.description?.includes('detail=network_error')));
  assert.doesNotMatch(JSON.stringify(logs), /private|查一下价格/);
});

test('调用者取消能打断路由，不触发后续检索', async () => {
  const controller = new AbortController();
  let routeSignal;
  const value = await search({ text: '查一下显卡价格', signal: controller.signal, llm: { complete: args => {
    routeSignal = args.signal;
    queueMicrotask(() => controller.abort());
    return new Promise(() => {});
  } }, config: { timeoutMs: 1000 } });
  assert.equal(value.status, 'failed');
  assert.equal(value.reason, 'aborted');
  assert.equal(routeSignal.aborted, true);
});

test('总预算为零不启动任何路由或网络', async () => {
  const f = fixture();
  f.deps.route = async () => { throw new Error('must not route'); };
  const value = await f.run('查一下价格', { config: { timeoutMs: 0 } });
  assert.equal(value.status, 'failed');
  assert.equal(value.reason, 'deadline_exceeded');
  assert.equal(f.calls.length, 0);
});

test('天气缺失温度不能只凭标题伪装成成功，缺失降水不能写成零', () => {
  const place = { timezone: 'Asia/Shanghai' };
  assert.equal(weatherSnippet(place, {}), '');
  const text = weatherSnippet(place, { current: { time: '2026-11-06T12:00', temperature_2m: 10 },
    daily: { time: ['2026-11-06'], temperature_2m_min: [5], temperature_2m_max: [15] } });
  assert.match(text, /2026-11-06/);
  assert.doesNotMatch(text, /undefined|null|降水概率 0%/);
});

test('格式化保留来源和获取时间，不把它们写成发布时间', () => {
  const value = evidence('bing');
  value.items[0].snippet = '长摘要'.repeat(1000);
  const text = formatResult(value, { maxChars: 300 });
  assert.ok(text.length <= 300);
  assert.match(text, /https:\/\/example\.test\/source/);
  assert.match(text, /发布时间未确认/);
  assert.match(text, /获取时间：2026-11-06/);
});

test('路由北京时间与机器本地时区无关', () => {
  assert.match(systemFor(new Date('2026-11-06T20:30:00Z')), /2026-11-07 周六 04:30（北京时间）/);
});

test('模型识别出的时间范围不会在改写查询后丢失', async () => {
  const f = fixture({ kind: 'web', timeRange: 'today', fresh: 'any', query: '发布会 新闻' });
  await f.run('今儿有什么发布会消息');
  assert.equal(f.calls[0].args[1].maxAgeDays, 2);
});


test('路由说不用查，但会变的统计事实仍强制检索（volatile_forced）', async () => {
  // 现场：2026-11-13 问「你知道CS去年的top20名单吗」被判 need=false，她拿 2024 记忆冒充 2025 榜单。
  // 这类榜单/排名/冠军是逐年更替的统计事实，模型记忆不可靠，路由说「不用查」也必须查。
  const f = fixture({ need: false });
  const value = await f.run('你知道CS去年的top20名单吗', { now: new Date(2026, 10, 13) });
  assert.equal(f.calls[0].method, 'searchResult');
  assert.match(f.calls[0].args[0], /2025年/, '「去年」要按注入的 now 锚成 2025');
  assert.doesNotMatch(f.calls[0].args[0], /去年|你知道/, '口语词不进检索词');
  assert.equal(value.status, 'ok');
});

test('路由给的检索词仍带相对时间时兜底锚定年份', async () => {
  const f = fixture({ need: true, query: 'CS 去年 top20 名单', kind: 'web' });
  await f.run('CS去年的top20名单', { now: new Date(2026, 10, 13) });
  assert.equal(f.calls[0].method, 'searchResult');
  assert.match(f.calls[0].args[0], /2025年/);
  assert.doesNotMatch(f.calls[0].args[0], /去年/);
});


test('名单类查询抓结果页正文，把完整名单带进资料；闲聊不抓', async () => {
  // 用户标准：「CS去年top20名单」就该直接拿到完整名单。搜索摘要只有前几名，
  // 不抓正文她最多报半截——所以名单/榜单/top N 必须触发正文抓取。
  const pages = [];
  const f = fixture({ need: true, query: 'CS 2025年 top20 名单', kind: 'web' });
  f.deps.describeLink = async (url) => {
    pages.push(url);
    return { ok: true, title: 'HLTV 2025年度top20', url,
      article: 'CS 2025年 top20 名单完整版：1 m0NESY 2 donk 3 ZywOo …… 共20位选手与所属战队逐一盘点。' };
  };
  const value = await f.run('你知道CS 2025年的top20名单吗');
  assert.equal(pages.length, 1, '名单类要抓结果页正文');
  assert.equal(value.items[0].provider, 'page');
  assert.match(value.items[0].snippet, /m0NESY/);

  const idle = [];
  const f2 = fixture({ need: true, query: '测试检索', kind: 'web' });
  f2.deps.describeLink = async (url) => { idle.push(url); return { ok: true, title: 't', url, article: '正文'.repeat(60) }; };
  await f2.run('随便聊聊今天怎么样');
  assert.equal(idle.length, 0, '非原文/名单类不浪费预算抓正文');
});
