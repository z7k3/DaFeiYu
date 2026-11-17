'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const policyTool = path.join(root, 'scripts/manifest-policy.js');
const generator = path.join(root, 'scripts/make-manifest.ps1');
function fixture(t, manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-update-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'release-manifest.json');
  fs.writeFileSync(file, JSON.stringify(manifest));
  return file;
}
function edit(file, args) {
  return spawnSync(process.execPath, [policyTool, '--file', file, ...args], { encoding: 'utf8' });
}
function generate(file, version, template) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', generator, '-Version', version, '-OutFile', file];
  if (template) args.push('-TemplateFile', template);
  return spawnSync('powershell.exe', args, { encoding: 'utf8', timeout: 30000 });
}

test('策略工具写入精确名单，不需要旧 force=true，序号递增', t => {
  const file = fixture(t, { latest: '4.1.8', force: false, manifest_version: 20 });
  const result = edit(file, ['--force-versions', '4.1.6,v4.1.2']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { latest: '4.1.8', force: false, manifest_version: 21, force_versions: ['4.1.6', '4.1.2'] });
});

test('精确名单可清空，也可显式删除以返回旧协议', t => {
  const file = fixture(t, { force: true, force_versions: ['4.1.6'], manifest_version: 20 });
  assert.equal(edit(file, ['--force-versions', '[]']).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).force_versions, []);
  assert.equal(edit(file, ['--force-versions', 'null']).status, 0);
  const value = JSON.parse(fs.readFileSync(file));
  assert.equal(Object.hasOwn(value, 'force_versions'), false);
  assert.equal(value.manifest_version, 22);
});

test('名单格式错误时拒绝写盘，不能靠宽松版本比较误伤用户', t => {
  for (const input of ['4.17', '4.1.6,', '["4.1.6",null]', '4.1.6-beta', '4.2147483648.0']) {
    const file = fixture(t, { force: true, force_versions: ['4.1.6'], manifest_version: 20 });
    const before = fs.readFileSync(file, 'utf8');
    const result = edit(file, ['--force-versions', input]);
    assert.notEqual(result.status, 0, input);
    assert.equal(fs.readFileSync(file, 'utf8'), before, input);
  }
});

test('4.1.7 的强制策略只进入候选清单，不提前修改公开模板', t => {
  const template = fixture(t, { latest: '4.1.6', force: false, force_versions: [], manifest_version: 20, epoch: 1, release_details: '既有说明', custom_metadata: { keep: true } });
  const before = fs.readFileSync(template, 'utf8');
  const candidate = path.join(path.dirname(template), 'candidate.json');
  const result = generate(candidate, '4.1.7', template);
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(fs.readFileSync(candidate, 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(value.latest, '4.1.7');
  assert.equal(value.force, true);
  assert.equal(value.force_from, '4.1.6');
  assert.deepEqual(value.force_versions, ['4.1.6']);
  assert.equal(value.kill_below, null);
  assert.equal(value.manifest_version, 21);
  assert.deepEqual(value.custom_metadata, { keep: true });
  assert.equal(value.epoch, 1);
  assert.equal(value.release_details, '既有说明');
  assert.equal(fs.readFileSync(template, 'utf8'), before);
});

test('4.1.8 保留事故名单，不随 latest 扩大；四段版本不自动开强制', t => {
  const file = fixture(t, { latest: '4.1.7', brand_latest: '4.1.7', target: '4.1.7', epoch: 1, force: true, force_from: '4.1.6', force_versions: ['4.1.6'], manifest_version: 20 });
  let result = generate(file, '4.1.8');
  assert.equal(result.status, 0, result.stderr);
  let value = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(value.force_versions, ['4.1.6']);
  assert.equal(value.brand_latest, '4.1.8');
  assert.equal(value.target, '4.1.8');
  assert.equal(value.manifest_version, 21);
  const reserved = fixture(t, { latest: '4.1.6', force: false, force_versions: [], manifest_version: 20 });
  result = generate(reserved, '4.1.6.1');
  assert.equal(result.status, 0, result.stderr);
  value = JSON.parse(fs.readFileSync(reserved, 'utf8'));
  assert.equal(value.force, false);
  assert.deepEqual(value.force_versions, []);
});

test('损坏的策略模板必须中止生成并保留原文件', t => {
  const file = fixture(t, {});
  fs.writeFileSync(file, '{broken');
  const result = generate(file, '4.1.8');
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('同版本重新生成不能撤销维护者的刹车', t => {
  const file = fixture(t, { latest: '4.1.7', force: false, force_from: '4.1.6', force_versions: [], manifest_version: 30 });
  const result = generate(file, '4.1.7');
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(fs.readFileSync(file));
  assert.equal(value.force, false);
  assert.deepEqual(value.force_versions, []);
});

test('brake 同时撤销新旧强制，显式旧命令可恢复兼容协议', t => {
  const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).scripts;
  const file = fixture(t, { force: true, force_versions: ['4.1.6'], manifest_version: 20 });
  for (const [command, expected] of [['brake', false], ['unbrake', null], ['force-now', true]]) {
    const result = edit(file, scripts[command].split(' ').slice(2));
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(fs.readFileSync(file));
    assert.equal(value.force, expected);
    if (command === 'brake') assert.deepEqual(value.force_versions, []);
    else assert.equal(Object.hasOwn(value, 'force_versions'), false);
  }
});

test('启动和更新横幅必须执行同一策略，后台轮询保持不打断', () => {
  const source = fs.readFileSync(path.join(root, 'launcher/MainWindow.xaml.cs'), 'utf8');
  const loaded = source.slice(source.indexOf('Loaded +='), source.indexOf('Closing +='));
  assert.match(loaded, /await SilentUpdateCheckAsync\(allowBlocking: true\)/);
  const toast = source.slice(source.indexOf('private void OnToastUpdateClick'), source.indexOf('private void OnToastDismissClick'));
  assert.match(toast, /ApplyManifestPolicy\(_lastManifest, interactive: true\)/);
  assert.doesNotMatch(toast, /askFirst: true/);
  const periodic = source.slice(source.indexOf('private async Task MaybePeriodicUpdateCheckAsync'), source.indexOf('private void ApplyManifestPolicy'));
  assert.match(periodic, /await SilentUpdateCheckAsync\(\)/);
});
