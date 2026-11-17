'use strict';

// window_mixin 调 G.note_raised（置顶窗口被抬时记状态）——engine 必须从
// send_state 把它挂进模块环境。4.1.7 合并时漏了这条导入，bg_send 内部
// 触发它就 AttributeError → 后台通道整轮跳过 → 文字回复全走前台。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const engine = fs.readFileSync(path.join(__dirname, '..', 'bridge', 'engine.py'), 'utf8');
const wm = fs.readFileSync(path.join(__dirname, '..', 'bridge', 'window_mixin.py'), 'utf8');
const ss = fs.readFileSync(path.join(__dirname, '..', 'bridge', 'send_state.py'), 'utf8');

test('engine 要挂 note_raised：window_mixin 的置顶路径依赖它', () => {
  assert.match(wm, /G\.note_raised\(|note_raised\(hwnd/, 'window_mixin 要调用它');
  assert.match(engine, /from send_state import[^\n]*note_raised/, 'engine 要从 send_state 导入并挂到模块环境');
  assert.match(ss, /def note_raised/, 'send_state 是实现所在');
});
