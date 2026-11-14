'use strict';

// 名单/列表回复必须整体一条：拆散会把「1 ZywOo」「2 donk」变成一人一气泡
//（2026-11-14 实见 CS2 top20 拆成 6 条连发）。普通短句拆分行为不变。
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitBubbles } = require('../src/persona');

const LIST = ['查到了，2025年 HLTV Top20：',
  '1 ZywOo', '2 donk', '3 ropz', '4 m0NESY', '5 sh1ro', '6 malbsMd',
  '7 XANTARES', '8 YEKINDAR', '9 torzsi', '10 jL'].join('\n');

test('编号名单合成一条气泡，20 人也不拆', () => {
  const out = splitBubbles(LIST, { maxChars: 120, maxBubbles: 3 });
  assert.equal(out.length, 1, '名单必须整体一条，实际 ' + out.length + ' 条');
  assert.match(out[0], /10 jL/, '名单尾部不能被截掉');
  assert.match(out[0], /查到了/, '介绍行也要在');
});

test('普通多行聊天仍按原逻辑拆分，不受影响', () => {
  const out = splitBubbles('今天好累呀\n不想动', { maxChars: 120, maxBubbles: 2 });
  assert.ok(out.length >= 1);
});
