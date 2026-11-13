'use strict';

/**
 * 中国天气网（weather.com.cn）源的回归测试。
 *
 * 为什么加它：open-meteo 是国外接口（本机实测会被 ECONNRESET），失败后只能退网页
 * 搜索，拿到「南昌地图/城市百科」这种非实时资料。中国天气网给的是国内气象站实况 +
 * 5 天预报 + 气象预警 + AQI，一次请求全拿到。
 *
 * 踩过的坑（都写进断言）：
 *   · 只有 HTTPS 可用（搜索传输层只放行 https）；
 *   · 城市代码接口返回 `([{...}])`，外面裹了一层圆括号，直接 JSON.parse 会失败；
 *   · weather_index 里 cityDZ.temp 可能是哨兵值 999（缺数据），不能念成温度。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');

const weather = require('../src/adapters/search/weather');

const CN_CODE_BODY = '( [{"ref":"101240101~jiangxi~南昌~Nanchang~南昌~Nanchang~791~330000~NC~江西"}])';
const CN_INDEX_BODY = [
  'var cityDZ ={"weatherinfo":{"city":"101240101","temp":"999","tempn":"16","weather":"多云转阴","wd":"西南风转东南风","ws":"<3级"}};',
  'var alarmDZ ={"w":[{"w5":"大雾","w7":"黄色","w8":"2026-11-13 17:46","w9":"南昌市气象台：预计未来12小时内可能出现能见度小于500米的雾，请注意防范。"}]};',
  'var dataSK ={"cityname":"南昌","temp":"15.8","WD":"东风","WS":"2级","SD":"95%","aqi":"62","rain":"0.2","time":"19:20","weather":"雨"};',
  'var fc ={"f":[{"fa":"01","fb":"02","fc":"17","fd":"15","fe":"西南风","fg":"<3级","fi":"11\\/13","fj":"今天"},{"fa":"02","fb":"02","fc":"21","fd":"15","fe":"东风","fg":"<3级","fi":"11\\/14","fj":"星期六"}]};',
].join('');

/** 假的 https.get：按 URL 返回固定 body，并记录请求。 */
function fakeHttps(t, routes) {
  const calls = [];
  t.mock.method(https, 'get', (url, options, callback) => {
    calls.push({ url: String(url) });
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => {};
    const matched = Object.keys(routes).find(k => String(url).includes(k));
    queueMicrotask(() => {
      if (!matched) return req.emit('error', new Error('unexpected url ' + url));
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = { 'content-type': 'text/html' };
      res.resume = () => res;
      res.destroy = () => {};
      callback(res);
      res.emit('data', Buffer.from(routes[matched]));
      res.emit('end');
    });
    return req;
  });
  return calls;
}

test('城市代码接口的外层圆括号能被剥掉，并解析出 9 位代码', async t => {
  fakeHttps(t, { 'toy1.weather.com.cn': CN_CODE_BODY });
  const place = await weather.cnCityCode('测试城', { timeoutMs: 3000 });
  assert.equal(place.code, '101240101');
});

test('天气主接口能解析实况/预报/预警，且 999 哨兵值不会被当成温度', async t => {
  const calls = fakeHttps(t, {
    'toy1.weather.com.cn': CN_CODE_BODY,
    'd1.weather.com.cn': CN_INDEX_BODY,
  });
  const r = await weather.cnWeatherResult('测试城', { timeoutMs: 5000 });
  assert.equal(r.status, 'ok');
  const snip = r.items[0].snippet;
  assert.match(snip, /实况（19:20 观测）：15\.8°C/);
  assert.match(snip, /今天（11\\?\/13）：15~17°C/);
  assert.match(snip, /星期六（11\\?\/14）：15~21°C/);
  assert.match(snip, /大雾黄色预警/);
  assert.doesNotMatch(snip, /999/, '999 是缺数据的哨兵值，不能出现在给模型的资料里');
  assert.ok(calls.some(c => c.url.startsWith('https://')), '必须走 https（传输层只放行 https）');
});

test('城市代码解析失败时返回空结果，不抛未捕获异常', async t => {
  // 换个城市名：同一个名字会命中结果缓存（5 分钟），测不到本次失败路径
  fakeHttps(t, { 'toy1.weather.com.cn': '([{"bad":1}])' });
  const r = await weather.cnWeatherResult('查不到的城市名', { timeoutMs: 3000 });
  assert.ok(['empty', 'failed'].includes(r.status), '解析不到城市代码时应是空/失败，不能是 ok');
  assert.equal((r.items || []).length, 0);
});
