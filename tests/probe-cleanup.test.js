'use strict';

// 编码探测的测试字「鲸」绝不能留在输入框：失败/中断路径必须有兜底清理。
// 2026-11-14 实见：探测中断后「鲸」残留数小时，每条回复被 input_not_empty 拒掉。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'bridge', 'bg_sender.py'), 'utf8');

test('编码探测：失败与中断路径都要调用测试字兜底清理', () => {
  assert.match(src, /def _cleanup_probe_char/, '兜底清理函数要存在');
  const fn = src.slice(src.indexOf('def _calibrate_char_mode'), src.indexOf('def _expected_text'));
  const count = (fn.match(/_cleanup_probe_char\(/g) || []).length;
  assert.ok(count >= 2, '失败路径和中断路径都要调用（当前 ' + count + ' 处）');
  // 兜底只清恰好是测试字的框：防止误清用户草稿
  const helper = src.slice(src.indexOf('def _cleanup_probe_char'), src.indexOf('def _calibrate_char_mode'));
  assert.match(helper, /== '鲸'/, '只清恰好是测试字的框');
});
