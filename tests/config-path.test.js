'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, ensureConfigFile } = require('../src/infra/config');
const { configPath } = require('../src/infra/configPath');

test('新安装写入 data，旧目录只读兼容，两份存在只认新路径', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-config-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'config/config.example.json'), '{"chat":{"maxBubbles":3}}');
  assert.equal(ensureConfigFile(root), path.join(root, 'data/config.json'));
  assert.equal(loadConfig({ root, env: {}, readOnly: true }).chat.maxBubbles, 3);
  const legacy = path.join(root, 'config.json');
  fs.writeFileSync(legacy, '{"chat":{"maxBubbles":7}}');
  assert.equal(loadConfig({ root, env: {}, readOnly: true }).chat.maxBubbles, 3);
  fs.unlinkSync(path.join(root, 'data/config.json'));
  assert.equal(configPath(root), legacy);
  assert.equal(loadConfig({ root, env: {}, readOnly: true }).chat.maxBubbles, 7);
  assert.equal(fs.existsSync(path.join(root, 'data/config.json')), false, '读取旧版不能擅自写盘');
});

test('新配置损坏不得静默回退旧配置，避免恢复过期账号和密钥', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-config-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data/config.json'), '{broken');
  fs.writeFileSync(path.join(root, 'config.json'), '{}');
  const config = loadConfig({ root, env: {}, readOnly: true });
  assert.ok(config.configError);
  assert.equal(config.paths.configFile, path.join(root, 'data/config.json'));
});
