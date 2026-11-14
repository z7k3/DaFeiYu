'use strict';

// Tavily 兼容搜索源（官方 api.tavily.com 或 tavily.sharyuke.com 这类 Hub 网关）。
// 结构化 JSON + 全文 content + 真实发布时间，不碰网页抓取，没有反爬/验证码问题。
// Key 为空时整个源自动缺席（web.js 按 opts.tavilyApiKey 决定要不要排班）。
const https = require('node:https');
const { remaining, searchError } = require('./transport');
const { result } = require('../../core/search/result');

function postJson(url, key, body, opts = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, data) => { if (settled) return; settled = true; if (err) reject(err); else resolve(data); };
    let target;
    try { target = new URL(url); } catch { return done(searchError('invalid_url')); }
    if (target.protocol !== 'https:') return done(searchError('unsupported_protocol'));
    const budget = remaining(opts);
    const timer = setTimeout(() => done(searchError('deadline_exceeded')), Math.max(1, budget));
    opts.signal?.addEventListener('abort', () => done(searchError('aborted')), { once: true });
    const req = https.request(target, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      timeout: budget,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => { clearTimeout(timer); if (res.statusCode !== 200) return done(searchError('http_error', res.statusCode)); try { resolve(JSON.parse(raw)); } catch { done(searchError('parse_error')); } });
    });
    req.on('timeout', () => { req.destroy(); done(searchError('deadline_exceeded')); });
    req.on('error', (err) => { clearTimeout(timer); done(searchError('network_error')); });
    req.write(JSON.stringify(body));
    req.end();
  });
}

// 网关返回 {code:0, data:{data:{results}}}；官方直连是顶层 {results}。两种都吃。
function extractResults(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.results)) return payload.results;
  const inner = payload.data && payload.data.data;
  if (inner && Array.isArray(inner.results)) return inner.results;
  if (payload.data && Array.isArray(payload.data.results)) return payload.data.results;
  return [];
}

function extractAnswer(payload) {
  const candidates = [payload, payload && payload.data, payload && payload.data && payload.data.data];
  for (const candidate of candidates) {
    const answer = String(candidate && candidate.answer || '').trim();
    if (answer) return answer;
  }
  return '';
}

async function search(query, opts = {}) {
  const started = Date.now();
  const key = String(opts.tavilyApiKey || '').trim();
  const base = String(opts.tavilyBaseUrl || 'https://tavily.sharyuke.com').trim().replace(/\/+$/, '');
  if (!key) throw searchError('tavily_disabled');
  const post = opts._post || postJson;
  const payload = await post(base + '/api/proxy/search', key, {
    query: String(query || '').slice(0, 400),
    max_results: Math.max(3, Math.min(10, Number(opts.tavilyMaxResults) || 6)),
    search_depth: 'advanced',
    include_answer: 'advanced',
    include_raw_content: 'text',
  }, opts);
  const rows = extractResults(payload);
  const items = rows.map((row) => ({
    // provider 必须在源头就带上：web.ask 的 keepRelevant 过滤发生在
    // provider 字段统一附加之前，豁免逻辑靠它识别结构化源
    // （2026-11-14 实见：漏了这个字段，豁免全部失效，6 条又只活 1 条）。
    provider: 'tavily',
    title: String(row.title || '').trim(),
    url: String(row.url || ''),
    snippet: String(row.content || '').trim(),
    rawContent: String(row.raw_content || '').trim(),
    score: row.score == null || row.score === '' || !Number.isFinite(Number(row.score)) ? null : Number(row.score),
    publishedAt: row.published_date || null,
  })).filter((it) => it.url && (it.title || it.snippet || it.rawContent));
  if (!items.length && payload && payload.code !== 0 && payload.message) {
    throw searchError('tavily_error', payload.code);
  }
  if (opts.trace) opts.trace('provider', { provider: 'tavily', status: items.length ? 'ok' : 'empty', selected: items.length, elapsedMs: Date.now() - started });
  return { items, answer: extractAnswer(payload) };
}

module.exports = { search, extractResults, extractAnswer, postJson };
