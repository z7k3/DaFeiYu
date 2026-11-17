'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { upgradeLegacyPersona, legacyPatch } = require('../src/persona/legacy');
const { loadConfig } = require('../src/infra/config');
const store = require('../src/persona/store');
const presets = require('../src/persona/presets');

test('旧语气、要求及关闭情绪转为提示词，重复读取不叠加', () => {
  const old = { preset: '温柔', text: '回答具体一些', emotions: false, customPrompt: '原正文' };
  const migrated = upgradeLegacyPersona(old);
  assert.match(migrated.customPrompt, /原正文/);
  assert.match(migrated.customPrompt, /温柔/);
  assert.match(migrated.customPrompt, /回答具体一些/);
  assert.match(migrated.customPrompt, /保持情绪稳定/);
  assert.deepEqual(upgradeLegacyPersona(migrated), migrated);
  assert.equal(old.customPrompt, '原正文');
  assert.match(presets.toPatch(old).customPrompt, /回答具体一些/);
  assert.match(legacyPatch({ text: '新要求' }, '原正文').customPrompt, /新要求/);
  const first = legacyPatch({ text: '旧要求' }, '原正文');
  const second = legacyPatch({ text: '新要求' }, first.customPrompt);
  assert.doesNotMatch(second.customPrompt, /旧要求/);
  assert.equal((second.customPrompt.match(/【旧版表达设置】/g) || []).length, 1);
});

test('兼容读取不改旧文件，保存后可清空且不复活，新配置不被旧副本覆盖', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-compat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ persona: { ownerName: '新称呼' }, chat: { maxBubbles: 5 } }));
  const file = path.join(root, 'data/persona.json');
  const original = JSON.stringify({ text: '旧要求', customPrompt: '正文', maxBubbles: 2, ownerName: '旧称呼' });
  fs.writeFileSync(file, original);
  const cfg = loadConfig({ root, env: {}, readOnly: true });
  Object.defineProperty(cfg, 'readOnly', { value: true });
  store.apply(cfg, store.load(cfg));
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.match(cfg.persona.customPrompt, /旧要求/);
  assert.equal(cfg.chat.maxBubbles, 5);
  assert.equal(cfg.persona.ownerName, '新称呼');
  store.save(cfg, { customPrompt: '' });
  store.apply(cfg, store.load(cfg));
  assert.equal(cfg.persona.customPrompt, '');
  assert.equal(store.load(cfg).text, '旧要求');
});
