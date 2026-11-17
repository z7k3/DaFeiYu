'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { probe, voiceKey } = require('../src/services/apiProbe');
const { startServer } = require('../server');

function config(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-api-probe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { paths: { settingsFile: path.join(root, 'settings.json') }, voice: { enabled: true, apiKey: 'test-only', baseUrl: 'https://api.deepseek.com/v1/tools/asr' },
    websearch: { deepseek: { apiKey: 'test-only' }, zhihu: { accessSecret: 'test-only' } } };
}
function wav() {
  const b = Buffer.alloc(64);
  b.write('RIFF'); b.write('WAVE', 8);
  return b.toString('base64');
}

test('搜索测试分别调用指定服务商，不使用兜底或泄漏密钥', async t => {
  const cfg = config(t);
  for (const provider of ['deepseek', 'zhihu']) {
    let calls = 0;
    const result = await probe(cfg, { provider }, { [provider]: { search: async (q, opts) => {
      calls++; assert.equal(opts.count, 1); assert.equal(opts.timeoutMs, 15000);
      return [];
    } } });
    assert.equal(calls, 1); assert.equal(result.ok, true);
    assert.doesNotMatch(JSON.stringify(result), /test-only/);
    await assert.rejects(probe(cfg, { provider }, { [provider]: { search: async () => { throw new Error('HTTP 401'); } } }), /401/);
  }
  cfg.websearch.deepseek.apiKey = '';
  await assert.rejects(probe(cfg, { provider: 'deepseek' }), /Key/);
  await assert.rejects(probe(cfg, { provider: 'unknown' }), /不支持/);
});

test('ASR 测试上传 WAV 并校验实际转写，而不是把 HTTP 200 当成功', async t => {
  const cfg = config(t);
  const body = { provider: 'voice', audio: wav() };
  const result = await probe(cfg, body, { fetch: async (url, opts) => {
    assert.equal(opts.headers.Authorization, 'Bearer test-only');
    assert.equal(opts.redirect, 'error'); assert.ok(opts.body instanceof FormData);
    return { ok: true, json: async () => ({ text: '连接测试' }) };
  } });
  assert.equal(result.sample, '连接测试');
  for (const status of [401, 403, 429, 500])
    await assert.rejects(probe(cfg, body, { fetch: async () => ({ ok: false, status }) }), new RegExp(String(status)));
  await assert.rejects(probe(cfg, body, { fetch: async () => ({ ok: true, json: async () => ({}) }) }), /没有有效转写/);
  await assert.rejects(probe(cfg, { provider: 'voice', audio: 'bad' }), /WAV/);
  cfg.voice.enabled = false;
  await assert.rejects(probe(cfg, body), /开启/);
});

test('ASR 不同源不复用聊天密钥，百炼使用 JSON 协议', async t => {
  const cfg = config(t);
  cfg.voice = { provider: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com/test', apiKey: '', model: 'qwen3-asr-flash' };
  cfg.deepseek = { baseUrl: 'https://api.deepseek.com', apiKey: 'must-not-send' };
  assert.equal(voiceKey(cfg, cfg.voice.baseUrl), '');
  cfg.voice.apiKey = 'test-only';
  await probe(cfg, { provider: 'voice', audio: wav() }, { fetch: async (_, opts) => {
    assert.equal(JSON.parse(opts.body).model, 'qwen3-asr-flash');
    assert.equal(opts.headers['Content-Type'], 'application/json');
    return { ok: true, json: async () => ({ output: { choices: [{ message: { content: [{ text: '你好' }] } }] } }) };
  } });
});

test('HTTP 测试入口：拒绝非法类型、缺失凭据，不修改配置', async t => {
  const cfg = config(t);
  const root = path.dirname(cfg.paths.settingsFile);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ watchConfig: false, env: { autoDetect: false } }));
  const before = fs.readFileSync(path.join(root, 'config.json'));
  const app = await startServer({ root, env: { WHALE_LOG_FILE: '' }, port: 0 });
  t.after(() => app.close());
  for (const provider of ['unknown', 'deepseek', 'zhihu', 'voice']) {
    const response = await fetch(app.url + '/api/settings/test-service', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider }) });
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.equal(result.ok, false);
    assert.ok(result.error);
  }
  assert.deepEqual(fs.readFileSync(path.join(root, 'config.json')), before);
});
