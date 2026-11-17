'use strict';

/**
 * 改 release-manifest.json 的策略字段，并自动把 manifest_version +1。
 *
 * 为什么要 +1：客户端同时读 4 个源，取 manifest_version 最大的那份。
 * 你只改 main 上的文件、不抬序号的话，Release 资产里那份同序号的旧清单
 * 会先被选中——刹车就失效了。这个脚本替你保证这一点。
 *
 * 用法：
 *   npm run brake                          # force=false：只提示，不强制
 *   npm run unbrake                        # force=null ：恢复时间闸
 *   npm run force-now                      # force=true ：立即强制
 *   node scripts/manifest-policy.js --force-from 4.0.8      # 只强制 >= 4.0.8
 *   node scripts/manifest-policy.js --force-from null       # 取消强制范围
 *   node scripts/manifest-policy.js --force-versions 4.1.6  # 新客户端精确名单
 *   node scripts/manifest-policy.js --force-versions '[]'   # 新客户端不强制
 *   node scripts/manifest-policy.js --force-versions null   # 删除字段，返回旧协议
 *   node scripts/manifest-policy.js --kill-below 4.0.2     # 熔断
 *   node scripts/manifest-policy.js --kill-below null      # 取消熔断
 *   node scripts/manifest-policy.js --force-after-hours 6  # 时间闸改成 6 小时
 *
 * 正式清单只在安装包可用后发布；运行中的客户端通常每 6 小时检查一次。
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const fileArg = arg('file');
const file = fileArg ? path.resolve(fileArg) : path.join(root, 'release-manifest.json');

const wantHelp = process.argv.includes('--help') || process.argv.length <= 2;
if (wantHelp) {
  console.log(`改更新策略（会自动把 manifest_version +1）

  npm run brake                          刹车：force=false（只提示，不强制）
  npm run unbrake                        恢复：force=null（按时间闸）
  npm run force-now                      立即强制：force=true
  node scripts/manifest-policy.js --force-from 4.0.8      只强制 >= 4.0.8
  node scripts/manifest-policy.js --force-from null       取消强制范围
  node scripts/manifest-policy.js --force-versions 4.1.6,4.1.2  精确版本名单，与旧 force 独立
  node scripts/manifest-policy.js --force-versions '[]'        清空名单，不回落旧强制
  node scripts/manifest-policy.js --force-versions null        删除字段，返回旧协议（慎用）
  node scripts/manifest-policy.js --kill-below 4.0.2       熔断：低于 4.0.2 不许启动
  node scripts/manifest-policy.js --kill-below null        取消熔断
  node scripts/manifest-policy.js --force-after-hours 6    时间闸改成 6 小时

brake 会同时清空新名单；--force 单独使用时只改旧协议字段。
改完确认安装包已可用再发布；运行中通常每 6 小时检查一次。`);
  process.exit(0);
}

if (!fs.existsSync(file)) {
  console.error(`找不到 ${file}`);
  process.exit(1);
}

let m;
try {
  m = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  console.error('release-manifest.json 不是合法 JSON：' + e.message);
  process.exit(1);
}

let touched = false;

function validVersion(value) {
  return typeof value === 'string' && /^[vV]?[0-9]+\.[0-9]+\.[0-9]+(?:\.[0-9]+)?$/.test(value)
    && value.replace(/^[vV]/, '').split('.').every(part => Number(part) <= 2147483647);
}

const versionsArg = arg('force-versions');
if (versionsArg !== undefined) {
  if (versionsArg === 'null') delete m.force_versions;
  else {
    let versions;
    try { versions = versionsArg.startsWith('[') ? JSON.parse(versionsArg) : versionsArg.split(','); }
    catch { console.error('--force-versions 必须是版本列表或 JSON 数组'); process.exit(1); }
    if (!Array.isArray(versions) || versions.length > 256 || !versions.every(validVersion)) {
      console.error('--force-versions 每项必须是 x.y.z 或 x.y.z.w，最多 256 项；清空用 []');
      process.exit(1);
    }
    m.force_versions = [...new Set(versions.map(version => version.replace(/^[vV]/, '')))];
  }
  touched = true;
}

const forceArg = arg('force');
if (forceArg !== undefined) {
  if (forceArg === 'true') m.force = true;
  else if (forceArg === 'false') m.force = false;
  else if (forceArg === 'null') m.force = null;
  else {
    console.error('--force 只能是 true / false / null');
    process.exit(1);
  }
  touched = true;
}

const killArg = arg('kill-below');
if (killArg !== undefined) {
  if (killArg !== 'null' && killArg !== '' && !validVersion(killArg)) { console.error('--kill-below 必须是 x.y.z / x.y.z.w 或 null'); process.exit(1); }
  m.kill_below = killArg === 'null' || killArg === '' ? null : killArg.replace(/^[vV]/, '');
  touched = true;
}

const forceFromArg = arg('force-from');
if (forceFromArg !== undefined) {
  if (forceFromArg !== 'null' && forceFromArg !== '' && !validVersion(forceFromArg)) { console.error('--force-from 必须是 x.y.z / x.y.z.w 或 null'); process.exit(1); }
  m.force_from = forceFromArg === 'null' || forceFromArg === '' ? null : forceFromArg.replace(/^[vV]/, '');
  touched = true;
}

const hoursArg = arg('force-after-hours');
if (hoursArg !== undefined) {
  const n = Number(hoursArg);
  if (!Number.isFinite(n) || n < 0) {
    console.error('--force-after-hours 要是非负数字');
    process.exit(1);
  }
  m.force_after_hours = n;
  touched = true;
}

if (!touched) {
  console.error('没给任何策略参数，什么也没改。加 --help 看用法。');
  process.exit(1);
}

// 关键一步：抬序号，否则旧清单会赢
m.manifest_version = (Number(m.manifest_version) || 0) + 1;

fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n', 'utf8');

const forceText = m.force === null ? 'null（按时间闸自动）' : String(m.force);
const killText = m.kill_below === null || m.kill_below === undefined ? 'null（不熔断）' : m.kill_below;

console.log('已更新 ' + path.relative(root, file));
console.log('  manifest_version   ' + m.manifest_version);
console.log('  latest             ' + m.latest);
console.log('  force              ' + forceText);
console.log('  force_from         ' + (m.force_from || 'null'));
console.log('  force_versions     ' + (Object.hasOwn(m, 'force_versions') ? JSON.stringify(m.force_versions) : '缺失（旧协议）'));
console.log('  kill_below         ' + killText);
console.log('  force_after_hours  ' + m.force_after_hours);
console.log('');
console.log('下一步：git add release-manifest.json && git commit -m "chore: 更新更新策略" && git push');
