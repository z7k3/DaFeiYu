'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../server');
const presets = require('../src/persona/presets');
const { saveLocalConfiguration, readSnapshot } = require('../src/services/launcherSnapshot');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-portable-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    watchConfig: false, env: { autoDetect: false }, features: { memorySnapshot: false },
    persona: { master: { names: ['private-owner'], wxids: ['wxid_test_owner'] } },
  }));
  const app = await startServer({ root, env: { WHALE_LOG_FILE: '' }, port: 0 });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return { ...app, root };
}

async function post(app, route, body) {
  const response = await fetch(app.url + route, { method: 'POST', headers: { 'content-type': 'application/json',
    ...(route === '/api/care/sent' ? { 'x-bot-token': app.runtime.gateways.get('wechat').options.inboundToken, 'x-whale-bridge': '1' } : {}) }, body: JSON.stringify(body) });
  const result = await response.json();
  assert.equal(result.ok, true, result.error);
  return result;
}

const fields = {
  name: '小鱼', age: 31, job: '画家', appearance: '', personality: '沉静',
  background: '', customPrompt: '', ownerName: '老大', aliases: ['小鱼儿'],
  masterRoast: true, proactive: false, opinions: false, emoji: '少', emojiChance: 0.8,
  privateMaxChars: 188, groupMaxChars: 88, historyTurns: 350, groupHistoryTurns: 250,
  maxBubbles: 4, discussionMaxChars: 600,
};

test('单文件完整保存表达设置，导出白名单不包含账号与运行配置', async t => {
  const app = await fixture(t);
  await post(app, '/api/persona', fields);
  const result = await post(app, '/api/persona/preset/save', { name: '安静的小鱼' });
  const file = path.join(app.root, 'data/personas', result.preset.id + '.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.personaName, fields.name);
  for (const key of Object.keys(fields).filter(k => k !== 'name')) assert.deepEqual(saved[key], fields[key], key);
  const exported = (await post(app, '/api/persona/export', {})).persona;
  assert.equal(exported.schemaVersion, 1);
  assert.deepEqual(presets.toPatch(exported), fields);
  assert.doesNotMatch(JSON.stringify(exported), /private-owner|wxid_test_owner|apiKey|permissions|mutedGroups/);
});

test('启用包直接可见，应用设置并编辑本地副本，切换和离线重载保留', async t => {
  const app = await fixture(t);
  const dir = path.join(app.root, 'data/plugins');
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, 'gentle.persona.json');
  const document = { schemaVersion: 1, name: '温和人设包', customPrompt: '补充细节', personaName: '小鱼',
    personality: '沉静', ownerName: '老大', aliases: ['小鱼'], masterRoast: true, proactive: false,
    opinions: false, emojiChance: 0.8, emoji: '正常', maxBubbles: 4, historyTurns: 350,
    master: { wxids: ['must-not-import'] }, apiKey: 'must-not-import', permissions: ['system.full'] };
  fs.writeFileSync(marker, JSON.stringify(document));
  const config = app.runtime.config;
  assert.ok(presets.list(config).some(p => p.id === 'market-gentle'));
  await post(app, '/api/persona/preset', { id: 'market-gentle' });
  assert.equal(config.persona.masterRoast, true);
  assert.equal(config.chat.emojiChance, 0.8);
  assert.equal(config.chat.historyTurns, 350);
  assert.deepEqual(config.persona.master.wxids, ['wxid_test_owner']);
  await post(app, '/api/persona', { personality: '修改后的性格', customPrompt: '', emojiChance: 0, emoji: '关', masterRoast: false, ownerName: '朋友' });
  const edited = path.join(app.root, 'data/personas/market-gentle.json');
  assert.equal(JSON.parse(fs.readFileSync(edited, 'utf8')).personality, '修改后的性格');
  assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).personality, '沉静', '原始包内容不改');
  const loaded = presets.toPatch(presets.load(config, 'market-gentle'));
  assert.equal(loaded.personality, '修改后的性格');
  assert.equal(loaded.customPrompt, '');
  assert.equal(loaded.masterRoast, false);
  assert.equal(loaded.ownerName, '朋友');
  fs.unlinkSync(marker);
  assert.equal(presets.load(config, 'market-gentle'), null, '停用时即使有本地副本也不再列出');
  assert.equal(config.persona.personality, '修改后的性格', '当前已应用人设保留');
  fs.writeFileSync(marker, JSON.stringify(document));
  await saveLocalConfiguration(app.root, { path: '/api/persona/preset', body: { id: 'market-gentle' } }, {});
  const snapshot = readSnapshot(app.root, {});
  assert.equal(snapshot['/api/persona'].persona.personality, '修改后的性格');
  assert.equal(snapshot['/api/config'].config.persona.ownerName, '朋友');
  assert.equal(snapshot['/api/settings'].userName, '朋友');
  const exported = await saveLocalConfiguration(app.root, { path: '/api/persona/export', body: {} }, {});
  assert.equal(exported.persona.emojiChance, 0);
  assert.equal(exported.persona.masterRoast, false);
  const longPrompt = '鱼'.repeat(25000);
  await post(app, '/api/persona', { customPrompt: longPrompt });
  assert.equal(presets.toPatch(presets.load(config, 'market-gentle')).customPrompt, longPrompt, '本地编辑不因分享包上限静默截断');
  const denied = await fetch(app.url + '/api/persona/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 400);
  assert.equal(config.persona.customPrompt, longPrompt);
});

test('空字段跨重载保留，市场首次应用不生成副本，可恢复作者版本', async t => {
  const app = await fixture(t);
  const dir = path.join(app.root, 'data/plugins');
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, 'reset.persona.json');
  fs.writeFileSync(marker, JSON.stringify({ schemaVersion: 1, name: '测试', personaName: '鱼',
    personality: '安静', job: '', appearance: '', background: '', customPrompt: '' }));
  await post(app, '/api/persona/preset', { id: 'market-reset' });
  const copy = path.join(app.root, 'data/personas/market-reset.json');
  assert.equal(fs.existsSync(copy), false);
  let snapshot = readSnapshot(app.root, {});
  for (const key of ['job', 'appearance', 'background', 'customPrompt'])
    assert.equal(snapshot['/api/persona'].persona[key], '', key);
  await post(app, '/api/persona', { personality: '本地修改' });
  assert.equal(fs.existsSync(copy), true);
  await post(app, '/api/persona/preset/reset-market', { id: 'market-reset' });
  assert.equal(app.runtime.config.persona.personality, '本地修改');
  assert.equal(presets.load(app.runtime.config, 'market-reset').personality, '安静');
  const result = await saveLocalConfiguration(app.root, { path: '/api/persona/preset', body: { id: 'market-reset' } }, {});
  assert.equal(result.ok, true);
  snapshot = readSnapshot(app.root, {});
  assert.equal(snapshot['/api/persona'].persona.job, '');
  assert.equal(snapshot['/api/persona'].persona.personality, '安静');
});

test('人设页气泡数保存后读取和离线重载一致', async t => {
  const app = await fixture(t);
  await post(app, '/api/persona', { maxBubbles: 5, historyTurns: 180 });
  const current = await (await fetch(app.url + '/api/persona')).json();
  assert.equal(current.persona.maxBubbles, 5);
  assert.equal(readSnapshot(app.root, {})['/api/persona'].persona.maxBubbles, 5);
});

test('主动搭话成功记录进入对应私聊上下文', async t => {
  const app = await fixture(t);
  await post(app, '/api/care/sent', { chat: 'contact-test', text: '刚才主动说的话', group: false });
  const messages = app.runtime.store.messages('wechat:u:contact-test', 10);
  assert.equal(messages.at(-1).role, 'assistant');
  assert.equal(messages.at(-1).text, '刚才主动说的话');
  assert.equal(app.runtime.store.messages('wechat:g:contact-test', 10).length, 0);
  const receipt = { id: 'same-receipt', chat: 'contact-test', text: '有回执的主动消息' };
  await post(app, '/api/care/sent', receipt);
  const repeated = await post(app, '/api/care/sent', receipt);
  assert.equal(repeated.duplicate, true);
  assert.equal(app.runtime.store.messages('wechat:u:contact-test', 10).filter(m => m.text === receipt.text).length, 1);
  app.runtime.gateways.get('wechat').options.inboundToken = 'test-only-token';
  const rejected = await fetch(app.url + '/api/care/sent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(receipt) });
  assert.equal(rejected.status, 403);
});
