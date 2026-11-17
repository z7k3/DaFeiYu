'use strict';

/**
 * 自建人设预设：另存、自动回写、删除守卫，在线和离线行为一致。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startServer } = require('../server');
const presets = require('../src/persona/presets');
const { saveLocalConfiguration } = require('../src/services/launcherSnapshot');

const rootRepo = path.resolve(__dirname, '..');

async function boot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-user-preset-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    env: { autoDetect: false }, features: { memorySnapshot: false }, watchConfig: false,
    log: { level: 'error' },
  }));
  fs.mkdirSync(path.join(root, 'assets', 'personas'), { recursive: true });
  for (const name of ['persona-standard.json', 'persona-zhainan.json']) {
    fs.copyFileSync(path.join(rootRepo, 'assets', 'personas', name), path.join(root, 'assets', 'personas', name));
  }
  const app = await startServer({ root, env: { WHALE_LOG_FILE: '' }, port: 0 });
  t.after(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { ...app, root };
}

const post = async (app, route, body) => {
  const res = await fetch(app.url + route, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, ...(await res.json()) };
};
const get = async (app, route) => (await fetch(app.url + route)).json();

test('在线：另存为预设 → 自动回写 → 当前预设不能删 → 删除别的自建预设', async (t) => {
  const app = await boot(t);
  await post(app, '/api/persona', { name: '小鱼', personality: '旧性格', customPrompt: '' });

  const saved = await post(app, '/api/persona/preset/save', { name: '我的小鱼' });
  assert.equal(saved.status, 200, saved.error);
  assert.match(saved.preset.id, /^user-/);
  const listed = (await get(app, '/api/persona/presets')).presets;
  const mine = listed.find((x) => x.id === saved.preset.id);
  assert.equal(mine.source, 'user');
  assert.equal((await get(app, '/api/persona')).persona.sourcePreset, saved.preset.id);
  assert.equal((await get(app, '/api/persona')).presetSource, 'user', '自建预设允许继续修改');

  // 改名只改标题，内容不动
  const renamed = await post(app, '/api/persona/preset/rename', { id: saved.preset.id, name: '改过的标题' });
  assert.equal(renamed.status, 200, renamed.error);
  assert.equal(renamed.preset.name, '改过的标题');
  assert.equal(JSON.parse(fs.readFileSync(path.join(app.root, 'data', 'personas', saved.preset.id + '.json'), 'utf8')).personality, '旧性格');

  // 保存人设时自动回写来源预设
  await post(app, '/api/persona', { personality: '新性格' });
  const file = path.join(app.root, 'data', 'personas', saved.preset.id + '.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).personality, '新性格');

  // 正在使用的预设不允许删除
  const denied = await post(app, '/api/persona/preset/delete', { id: saved.preset.id });
  assert.equal(denied.status, 400);
  assert.match(denied.error, /正在使用/);

  // 换成内置预设后，自建预设可以删
  const applied = await post(app, '/api/persona/preset', { id: 'persona-standard' });
  assert.equal(applied.ok, true);
  assert.equal((await get(app, '/api/persona')).presetSource, 'builtin', '内置预设要锁住编辑');
  const removed = await post(app, '/api/persona/preset/delete', { id: saved.preset.id });
  assert.equal(removed.status, 200, removed.error);
  assert.equal(removed.kind, 'user');
  assert.equal(fs.existsSync(file), false);
});

test('在线：内置预设只隐藏，删除当前内置预设被拒绝', async (t) => {
  const app = await boot(t);
  const applied = await post(app, '/api/persona/preset', { id: 'persona-zhainan' });
  assert.equal(applied.ok, true);

  const denied = await post(app, '/api/persona/preset/delete', { id: 'persona-zhainan' });
  assert.equal(denied.status, 400);
  assert.match(denied.error, /正在使用/);
  assert.ok(fs.existsSync(path.join(app.root, 'assets', 'personas', 'persona-zhainan.json')));

  const removed = await post(app, '/api/persona/preset/delete', { id: 'persona-standard' });
  assert.equal(removed.status, 200, removed.error);
  assert.equal(removed.kind, 'builtin');
  assert.ok(fs.existsSync(path.join(app.root, 'assets', 'personas', 'persona-standard.json')), '内置文件不能被删');
  const ids = (await get(app, '/api/persona/presets')).presets.map((x) => x.id);
  assert.ok(!ids.includes('persona-standard'));
});

test('离线：启动器不在线时也能另存和删除', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-user-preset-offline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ watchConfig: false, env: { autoDetect: false } }));
  fs.mkdirSync(path.join(root, 'assets', 'personas'), { recursive: true });
  fs.copyFileSync(path.join(rootRepo, 'assets', 'personas', 'persona-standard.json'), path.join(root, 'assets', 'personas', 'persona-standard.json'));

  const saved = await saveLocalConfiguration(root, {
    path: '/api/persona/preset/save', body: { name: '离线预设' },
  });
  assert.equal(saved.ok, true, saved.error);
  const config = { paths: { root, dataDir: path.join(root, 'data') } };
  const ids = presets.list(config).map((x) => x.id);
  assert.ok(ids.includes(saved.preset.id));

  const listed = await saveLocalConfiguration(root, { path: '/api/persona/presets', body: {} });
  assert.equal(listed.ok, false, '不在离线清单里的接口要明确拒绝');

  const deleted = await saveLocalConfiguration(root, {
    path: '/api/persona/preset/delete', body: { id: 'persona-standard' },
  });
  assert.equal(deleted.ok, true, deleted.error);
  assert.ok(!presets.list(config).map((x) => x.id).includes('persona-standard'));
});
