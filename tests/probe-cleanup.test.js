'use strict';

// 编码探测的测试字不再残留：上游 4.1.7 用 _PROBE_TEXTS 在发送前识别并删除探测字，
// 取代了 fork 的 _cleanup_probe_char（机制已被上游官方方案覆盖）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'bridge', 'bg_sender.py'), 'utf8');

test('编码探测测试字有防残留机制（_PROBE_TEXTS 识别后删除再发送）', () => {
  assert.match(src, /_PROBE_TEXTS/, '上游 _PROBE_TEXTS 机制要存在');
  const fn = src.slice(src.indexOf('def _calibrate_char_mode'), src.indexOf('def _expected_text'));
  assert.match(fn, /_PROBE_TEXTS|reset_typed|清空/, '探测后要有清理路径');
});
