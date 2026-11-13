'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

for (const script of ['test_bg_live_encoding.py', 'test_uia_recovery.py', 'test_mention_names.py', 'test_ffmpeg_runtime.py', 'test_bridge_startup_ready.py']) {
  test('离线微信回归：' + script, () => {
    const run = spawnSync(process.env.PYTHON || 'python', ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', script], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, PYTHONUTF8: '1' },
      // 每个模块单独跑一遍：test_bg_live_encoding 有 27 个用例且含真实 sleep，
      // 本地实测约 50 秒（上游 15 秒是更快的 CI 机器上的余量）。
      encoding: 'utf8', timeout: 120000,
    });
    assert.equal(run.status, 0, run.stdout + run.stderr + (run.error ? String(run.error) : ''));
  });
}
