'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { stripInternalTimestamps } = require('../src/core/text');
const { buildTurns } = require('../src/core/context');

test('私聊群聊的历史与当前正文都不附加时间或间隔，原始 ts 不修改', () => {
  for (const chatType of ['private', 'group']) {
    const msg = { chatType, chatId: 'test', senderId: 'peer', text: '现在', ts: 1800000000000 };
    const history = [{ role: 'user', text: '之前', ts: msg.ts - 86400000 }];
    const turns = buildTurns(msg, history);
    const body = JSON.stringify(turns);
    assert.doesNotMatch(body, /\[\d{2}-\d{2} \d{2}:\d{2}\]|间隔约/);
    assert.match(body, /之前/);
    assert.equal(msg.ts, 1800000000000);
  }
});

test('超长群聊历史压缩仍能解析事件，不因 history 参数遮蔽模块而崩溃', () => {
  const history = Array.from({ length: 160 }, (_, i) => ({ role: 'user', uid: String(i),
    name: '参与者', text: '长历史内容'.repeat(300), ts: 1800000000000 + i }));
  const turns = buildTurns({ chatType: 'group', chatId: 'test', senderId: 'peer', text: '当前问题' }, history);
  assert.match(turns[0].content, /当前问题/);
  assert.match(turns[0].content, /更早的对话/);
});

test('去掉模型复制的内部行首时间标记，不删除正常时间回答', () => {
  assert.equal(stripInternalTimestamps('[11-06 20:49] hi'), 'hi');
  assert.equal(stripInternalTimestamps('[2026-11-06 20:49:01] hi\n[11-06 20:50] 好呀'), 'hi\n好呀');
  assert.equal(stripInternalTimestamps('现在是20:49，明天11月7日见'), '现在是20:49，明天11月7日见');
  assert.equal(stripInternalTimestamps('格式示例：[11-06 20:49] hi'), '格式示例：[11-06 20:49] hi');
});
