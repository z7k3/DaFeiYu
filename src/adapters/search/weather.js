'use strict';

const { getJson, getText, remaining, searchError } = require('./transport');

// 浏览器 UA：weather.com.cn 对默认 UA 会 403
const CN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const { createCache } = require('./cache');
const { providerResult } = require('./providerResult');
const cache = createCache();
const WMO = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴', 45: '有雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨', 56: '冻毛毛雨', 57: '强冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒', 80: '阵雨', 81: '强阵雨', 82: '暴雨',
  85: '阵雪', 86: '强阵雪', 95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷暴伴冰雹',
};
function wmoText(code) {
  if (code == null) return '未知';
  const n = Number(code);
  return WMO[n] || (Number.isFinite(n) ? '天气代码' + n : '未知');
}

async function geocodeCity(city, opts = {}) {
  const name = String(city || '').trim().slice(0, 80);
  if (!name) return null;
  return cache.get('geo:' + name.toLowerCase(), async shared => {
    const data = await getJson('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(name)
      + '&count=1&language=zh&format=json', shared);
    if (!data || typeof data !== 'object' || (data.results != null && !Array.isArray(data.results))) throw searchError('parse_error');
    const row = data.results?.[0];
    if (!row) return null;
    if (!Number.isFinite(row.latitude) || !Number.isFinite(row.longitude)) throw searchError('parse_error');
    return { name: row.name || name, admin1: row.admin1 || '', latitude: row.latitude, longitude: row.longitude, timezone: row.timezone || 'Asia/Shanghai' };
  }, { ...opts, ttlMs: 6 * 3600000 });
}

async function ipCity(opts = {}) {
  return cache.get('ip-city', async shared => {
    const data = await getJson('https://ipinfo.io/json', shared);
    return String(data?.city || '').trim();
  }, { ...opts, ttlMs: 6 * 3600000 });
}

function weatherSnippet(place, data) {
  const cur = data.current || {}, daily = data.daily || {};
  const lines = [];
  if (Number.isFinite(cur.temperature_2m)) {
    const extras = [];
    if (Number.isFinite(cur.apparent_temperature)) extras.push(`体感 ${cur.apparent_temperature}°C`);
    extras.push(wmoText(cur.weather_code));
    if (Number.isFinite(cur.relative_humidity_2m)) extras.push(`湿度 ${cur.relative_humidity_2m}%`);
    if (Number.isFinite(cur.wind_speed_10m)) extras.push(`风 ${cur.wind_speed_10m} km/h`);
    lines.push(`${cur.time || '当前'}：${cur.temperature_2m}°C（${extras.join('，')}）`);
  }
  for (let i = 0; i < 2; i++) {
    if (!daily.time?.[i] || !Number.isFinite(daily.temperature_2m_max?.[i]) || !Number.isFinite(daily.temperature_2m_min?.[i])) continue;
    const rain = daily.precipitation_probability_max?.[i];
    lines.push(`${daily.time[i]}：${wmoText(daily.weather_code?.[i])}，${daily.temperature_2m_min[i]}~${daily.temperature_2m_max[i]}°C`
      + (Number.isFinite(rain) ? `，降水概率 ${rain}%` : ''));
  }
  if (!lines.length) return '';
  return lines.join('\n') + `\n（按预报当地时区 ${place.timezone}；只含接口列出的日期）`;
}

// ——— 中国天气网（weather.com.cn）———
// 国内实况/预报比 open-meteo 更贴实际预期（实况来自气象站观测、带预警和生活指数），
// 而且一次 weather_index 请求就能拿到：实况 dataSK、今日 cityDZ、未来 5 天 fc、预警 alarmDZ。
// 需要 Referer，缺了会 403（openresty）。
const CN_DIRECT = {
  0: '晴', 1: '多云', 2: '阴', 3: '阵雨', 4: '雷阵雨', 5: '雷阵雨伴冰雹', 6: '雨夹雪',
  7: '小雨', 8: '中雨', 9: '大雨', 10: '暴雨', 11: '大暴雨', 12: '特大暴雨',
  13: '阵雪', 14: '小雪', 15: '中雪', 16: '大雪', 17: '暴雪', 18: '雾', 19: '冻雨',
  20: '沙尘暴', 21: '小到中雨', 22: '中到大雨', 23: '大到暴雨', 24: '暴雨到大暴雨',
  25: '大暴雨到特大暴雨', 26: '小到中雪', 27: '中到大雪', 28: '大到暴雪',
  29: '浮尘', 30: '扬沙', 31: '强沙尘暴', 53: '霾',
};

function cnWeatherText(code) {
  const s = String(code || '').trim();
  if (!s) return '';
  const n = Number(s);
  if (!Number.isFinite(n)) return '';
  return CN_DIRECT[n] || ('天气代码' + s);
}

/** 查一次城市代码接口，返回 [{code, label}]（已剥 JSONP 圆括号）。 */
async function cnSearchCities(name, opts = {}) {
  // 必须用 HTTPS：搜索模块的传输层只放行 https（SSRF 加固）。
  const text = await getText('https://toy1.weather.com.cn/search?cityname=' + encodeURIComponent(name), {
    ...opts,
    headers: { Referer: 'https://www.weather.com.cn/', 'User-Agent': CN_UA },
  });
  // 这个接口返回的是 `([{...}])`，外面裹了一层圆括号（JSONP 风格），先把括号剥掉。
  const raw = String(text || '').trim().replace(/^\(+/, '').replace(/\)+;?$/, '');
  const rows = JSON.parse(raw || '[]');
  if (!Array.isArray(rows)) throw searchError('parse_error');
  return rows
    .filter(x => x && typeof x.ref === 'string')
    .map(x => {
      const parts = x.ref.split('~');
      return { code: String(parts[0] || ''), label: String(parts[2] || '').trim() };
    })
    .filter(x => /^\d{9}(\d{3})?$/.test(x.code));
}

/**
 * 城市/区县名 → 中国天气网城市代码。带 24 小时缓存。
 *
 * 实测（2026-11-13）：直接拿「新建区」查只有一条 12 位的乡镇代码，而 12 位代码
 * 的 weather_index 会 302（不支持）；「进贤县」「西湖区」这类带行政后缀的直接查
 * 是 0 条。所以：
 *   1. 原名查不到就去掉「区/县/市/旗/镇」再查；
 *   2. 同名多地时（西湖→东西湖/杭州西湖/南昌西湖），用父城市代码前缀挑对；
 *   3. 只拿到 12 位乡镇代码时截断成 9 位（退到上级区县/市，聊天气够用）。
 */
async function cnCityCode(city, opts = {}) {
  const name = String(city || '').trim().slice(0, 40);
  if (!name) return null;
  const parentName = String(opts.parent || '').trim();
  const candidates = [...new Set([
    name,
    name.replace(/(特别行政区|自治区|自治州|新区|区|县|市|旗|镇)$/u, ''),
  ].map(x => x.trim()).filter(Boolean))];

  let parentCode = '';
  if (parentName && parentName !== name) {
    try {
      const pc = await cnCityCode(parentName, { ...opts, parent: '' });
      parentCode = pc ? String(pc.code).slice(0, 7) : '';
    } catch { parentCode = ''; }
  }

  // 所有候选一起评分再挑最优：只取「第一个有结果的候选」会选错——
  // 「新建区」直接在库里的是一条 12 位乡镇代码，而「新建」能查到 9 位的区县级 101240102。
  const pool = [];
  for (const candidate of candidates) {
    let rows = [];
    for (let attempt = 0; attempt < 2 && !rows.length; attempt += 1) {
      try {
        rows = await cache.get('cncity:' + candidate, async shared => cnSearchCities(candidate, shared),
          { ...opts, ttlMs: 24 * 3600 * 1000 });
      } catch { rows = []; }
      if (!rows.length && attempt === 0) await new Promise(r => setTimeout(r, 250));
    }
    if (!Array.isArray(rows)) continue;
    rows.forEach((row, index) => {
      let score = 0;
      if (row.label === name) score += 200;
      else if (row.label === candidate) score += 140;
      else if (row.label.startsWith(candidate)) score += 80;
      if (parentCode && row.code.startsWith(parentCode)) score += 120;
      if (row.code.length === 9) score += 60;   // 区县级/市级，weather_index 支持
      else score -= 40;                          // 12 位乡镇级，接口不支持
      pool.push({ row, score, order: pool.length });
    });
  }
  if (!pool.length) return null;
  pool.sort((a, b) => b.score - a.score || a.order - b.order);
  const best = pool[0].row;
  const truncated = best.code.length > 9;
  // 12 位是乡镇级：weather_index 不支持，退到 9 位（上级区县/市），标签说明来源
  const code = truncated ? best.code.slice(0, 9) : best.code;
  const label = truncated && parentName ? (parentName + '（' + best.label + '无独立站点）') : (best.label || name);
  return { code, label, district: name.endsWith('区') || name.endsWith('县') };
}

/** 从 "var x = {...};" 这种 JS 赋值里抠出 JSON 对象。 */
function cnVar(text, name) {
  // 不用正则：反斜杠转义在字符串里叠两层极易写错（第一版就写错了 → parse_error）。
  // 这里按 "var name" → '=' → '{' 定位，再做括号配平取完整对象。
  const src = String(text || '');
  const tag = 'var ' + name;
  let i = src.indexOf(tag);
  if (i < 0) return null;
  const start = src.indexOf('{', src.indexOf('=', i + tag.length));
  if (start < 0) return null;
  let depth = 0;
  for (let j = start; j < src.length; j += 1) {
    const ch = src[j];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(src.slice(start, j + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/**
 * 中国天气网天气结果：实况 + 今天 + 未来几天 + 预警，一次请求拿齐。
 */
// 失败冷却：中国天气网对高频请求会限流（实测连续二十多次后整站超时）。
// 连续失败 2 次就先停 10 分钟，让 open-meteo/wttr 顶上——否则每个天气问题都要
// 先白等一次超时。
const CN_COOLDOWN = { fails: 0, until: 0 };
const CN_RESULT_CACHE = new Map();   // key -> { until, item }，5 分钟

async function cnWeatherResult(city, opts = {}) {
  const deadline = Math.min(opts.deadline ?? Infinity, Date.now() + remaining(opts));
  const now = Date.now();
  if (CN_COOLDOWN.until > now) {
    return providerResult('cnweather', async () => {
      throw searchError('cooldown');
    }, opts);
  }
  const out = await providerResult('cnweather', async () => {
    // 传父城市（配置里的 home city）：同名区县很多（西湖/东湖/新建），靠它挑对。
    // 结果缓存 5 分钟：同一城市反复问（群里几个人问同一天气）不必重复打接口——
    // 高频请求正是被限流的主因。命中时一个网络请求都不发。
    const cacheKey = String(city || '').trim().toLowerCase() + '|' + String(opts.parent || '');
    const hit = CN_RESULT_CACHE.get(cacheKey);
    if (hit && hit.until > Date.now()) return [hit.item];
    let place = await cnCityCode(city, { ...opts, deadline, parent: opts.parent || '' });
    if (!place && opts.parent && String(opts.parent).trim() && String(opts.parent).trim() !== String(city).trim()) {
      // 区县名在库里查不到（或被限流）：退回配置的常住城市，至少给城市级实况，
      // 比让整个天气问题掉到网页搜索强。
      const fallback = await cnCityCode(String(opts.parent).trim(), { ...opts, deadline, parent: '' });
      if (fallback) place = { ...fallback, label: fallback.label + '（' + String(city).trim() + '暂无区县数据）' };
    }
    if (!place) return [];
    const url = 'https://d1.weather.com.cn/weather_index/' + place.code + '.html?_=' + Date.now();
    const text = await getText(url, {
      ...opts, deadline,
      headers: { Referer: 'https://www.weather.com.cn/weather_index/' + place.code + '.shtml', 'User-Agent': CN_UA },
    });
    const sk = cnVar(text, 'dataSK');
    const dz = cnVar(text, 'cityDZ');
    const fc = cnVar(text, 'fc');
    const alarm = cnVar(text, 'alarmDZ');
    if (!sk && !dz && !fc) throw searchError('parse_error');

    const lines = [];
    if (sk && sk.temp) {
      const bits = [];
      if (sk.weather) bits.push(String(sk.weather));
      if (sk.WD) bits.push(String(sk.WD) + (sk.WS ? String(sk.WS) : ''));
      if (sk.SD) bits.push('湿度 ' + String(sk.SD));
      if (sk.aqi && Number(sk.aqi) > 0) bits.push('AQI ' + String(sk.aqi));
      if (sk.rain && Number(sk.rain) > 0) bits.push('降雨 ' + String(sk.rain) + 'mm');
      lines.push('实况（' + String(sk.time || '') + ' 观测）：' + sk.temp + '°C'
        + (bits.length ? '，' + bits.join('，') : ''));
    }
    const wi = dz && dz.weatherinfo;
    const days = fc && Array.isArray(fc.f) ? fc.f : [];
    const num = (v) => {
      const n = Number(String(v == null ? '' : v).replace(/[^\d.-]/g, ''));
      // 999 是这家的哨兵值（缺数据），别当成温度念出来
      return Number.isFinite(n) && n > -90 && n < 60 ? n : null;
    };
    const hi = wi ? num(wi.temp) : null;
    const lo = wi ? num(wi.tempn) : null;
    // 只在 fc 没有今日数据时才用 cityDZ 兜底，避免同一句「今天」出现两遍
    if (wi && hi != null && lo != null && !days.length) {
      lines.push('今天：' + lo + '~' + hi + '°C，' + [String(wi.weather || ''),
        String(wi.wd || ''), String(wi.ws || '')].filter(Boolean).join('，'));
    }
    for (let i = 0; i < Math.min(3, days.length); i += 1) {
      const d = days[i];
      const label = i === 0 ? '今天' : (String(d.fj || '') || String(d.fi || ''));
      const w = [cnWeatherText(d.fa), cnWeatherText(d.fb)].filter(Boolean);
      const desc = w.length === 2 && w[0] !== w[1] ? w[0] + '转' + w[1] : (w[0] || '');
      lines.push(label + '（' + String(d.fi || '') + '）：' + String(d.fd || '') + '~' + String(d.fc || '') + '°C'
        + (desc ? '，' + desc : '') + (d.fe ? '，' + String(d.fe) + (d.fg ? String(d.fg) : '') : ''));
    }
    const warns = alarm && Array.isArray(alarm.w) ? alarm.w : [];
    if (warns.length) {
      const w0 = warns[0];
      const detail = String(w0.w9 || '').replace(/^[^：]*：/, '').slice(0, 100);
      lines.push('⚠ ' + String(w0.w5 || '') + String(w0.w7 || '') + '预警（' + String(w0.w8 || '') + '）：' + detail);
    }
    if (!lines.length) throw searchError('missing_weather_data');
    const item = {
      title: (place.label || city) + ' 天气',
      url,
      snippet: lines.join('\n'),
      provider: 'cnweather',
      fetchedAt: new Date().toISOString(),
      publishedAt: null,
      weather: { place: { name: place.label || city, timezone: 'Asia/Shanghai' }, current: sk || null, daily: days },
    };
    // 成功：缓存 5 分钟 + 清零失败计数
    maxCacheEntries(CN_RESULT_CACHE);
    CN_RESULT_CACHE.set(cacheKey, { until: Date.now() + 5 * 60 * 1000, item });
    CN_COOLDOWN.fails = 0;
    return [item];
  }, opts);
  if (out.status !== 'ok') {
    CN_COOLDOWN.fails += 1;
    if (CN_COOLDOWN.fails >= 2) {
      // 连续 2 次失败 → 停 10 分钟：限流/被墙时别让每个天气问题都白等一次超时
      CN_COOLDOWN.until = Date.now() + 10 * 60 * 1000;
      CN_COOLDOWN.fails = 0;
    }
  }
  return out;
}

/** 缓存别无限长：超过 64 条就清掉过期的。 */
function maxCacheEntries(map) {
  if (map.size < 64) return;
  const now = Date.now();
  for (const [k, v] of map) if (!v || v.until <= now) map.delete(k);
}

async function weatherResult(city, opts = {}) {
  const deadline = Math.min(opts.deadline ?? Infinity, Date.now() + remaining(opts));
  return providerResult('open-meteo', async () => {
    const place = opts.place || await geocodeCity(city, { ...opts, deadline });
    if (!place) return [];
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + place.latitude + '&longitude=' + place.longitude
      + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m'
      + '&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max'
      + '&timezone=' + encodeURIComponent(place.timezone) + '&forecast_days=2';
    const data = await getJson(url, { ...opts, deadline });
    if (!data || typeof data !== 'object') throw searchError('parse_error');
    const snippet = weatherSnippet(place, data);
    if (!snippet) throw searchError('missing_weather_data');
    return [{ title: `${place.name}${place.admin1 && place.admin1 !== place.name ? '（' + place.admin1 + '）' : ''} 天气`,
      url, snippet, provider: 'open-meteo', fetchedAt: new Date().toISOString(), publishedAt: null,
      weather: { place, current: data.current || null, daily: data.daily || null } }];
  }, opts);
}

/**
 * wttr.in 兜底天气源：open-meteo 在部分网络下会被重置（ECONNRESET），
 * 这时再走一次备用源，比退化到网页搜索拿「城市百科」强得多。
 * 返回结构对齐 weatherResult，便于上层统一走 splitFreshness/格式化。
 */
async function wttrResult(city, opts = {}) {
  const deadline = Math.min(opts.deadline ?? Infinity, Date.now() + remaining(opts));
  return providerResult('wttr', async () => {
    const name = String(city || '').trim();
    if (!name) return [];
    const url = 'https://wttr.in/' + encodeURIComponent(name) + '?format=j1&lang=zh';
    const data = await getJson(url, { ...opts, deadline });
    const cur = data && Array.isArray(data.current_condition) ? data.current_condition[0] : null;
    if (!cur) throw searchError('missing_weather_data');
    const today = data.weather && data.weather[0];
    const place = { name, timezone: 'Asia/Shanghai', admin1: '' };
    const lines = ['现在 ' + cur.temp_C + '°C（体感 ' + cur.FeelsLikeC + '°C，'
      + (cur.lang_zh && cur.lang_zh[0] ? cur.lang_zh[0].value : '天气 ' + cur.weatherDesc[0].value) + '）'];
    if (today) {
      lines.push(today.date + '：' + today.mintempC + '~' + today.maxtempC + '°C');
      if (today.hourly) {
        const rain = today.hourly.map((h) => Number(h.chanceofrain)).filter(Number.isFinite);
        if (rain.length) lines.push('降水概率最高 ' + Math.max.apply(null, rain) + '%');
      }
    }
    return [{ title: name + ' 天气', url, snippet: lines.join('\n'), provider: 'wttr',
      fetchedAt: new Date().toISOString(), publishedAt: null, weight: 1 }];
  }, opts);
}

module.exports = { geocodeCity, ipCity, weatherResult, wttrResult, cnWeatherResult, cnCityCode, cnSearchCities, weatherSnippet, wmoText };
