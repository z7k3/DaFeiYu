'use strict';

/**
 * 微信消息必须有会话标识（M3）。
 *
 * 背景：normalizeInbound 对缺 chat_id 的消息会兜底成 sender_id 再兜底「unknown」。
 * 自建中转若漏传 chat_id，不同人的私聊会被并进同一个会话——记忆、人物卡、上下文
 * 全部串门。本地桥接永远带 chat_id，所以这个坑只咬自建中转用户，且表现为
 * 「两个陌生人聊成一个她」，极难排查。
 * 修复：wechat 平台缺 chat_id 直接拒收（skipped: missing_chat_id）；
 * 非微信渠道（无稳定会话概念的接入）保持原兜底行为。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Gateway, normalizeInbound } = require('../src/adapters/gateway');

function makeGateway(platform = 'wechat') {
  const calls = [];
  const bot = {
    calls,
    async handle() { calls.push(1); return { action: 'ignore', reason: 'unit_test' }; },
    config: {},
  };
  const gw = new Gateway({ platform, options: { enabled: true, inboundToken: '' }, bot, logger: null });
  return { gw, calls };
}

test('wechat 消息缺 chat_id 拒收，不再兜底 sender_id/unknown', async () => {
  const { gw, calls } = makeGateway();
  const out = await gw.handleInbound({ sender_id: 'wxid_a', text: '你好' });
  assert.equal(out.skipped, 'missing_chat_id', '缺 chat_id 必须拒收');
  assert.equal(calls.length, 0, '拒收的消息不能进管线');
});

test('chat_id 为空串/空白同样算缺失', async () => {
  const { gw, calls } = makeGateway();
  const a = await gw.handleInbound({ chat_id: '', sender_id: 'wxid_a', text: '在吗' });
  const b = await gw.handleInbound({ chat_id: '   ', text: '在吗' });
  assert.equal(a.skipped, 'missing_chat_id');
  assert.equal(b.skipped, 'missing_chat_id');
  assert.equal(calls.length, 0);
});

test('带 chat_id 的消息正常进管线；chat_type/正文原样传递', async () => {
  const { gw, calls } = makeGateway();
  const out = await gw.handleInbound({ chat_id: 'wxid_peer', chat_type: 'private', text: '在吗' });
  assert.ok(out.action === 'ignore', '假 bot 返回 ignore，网关原样转述');
  assert.equal(calls.length, 1, '带 chat_id 必须进管线');
});

test('normalizeInbound 暴露 chatIdExplicit；非微信渠道保留旧兜底（缺省 unknown）', () => {
  const noChat = normalizeInbound({ sender_id: 'u1', text: 'hi' }, 'wechat');
  assert.equal(noChat.chatIdExplicit, false);
  assert.equal(noChat.chatId, 'u1', '兜底字段保留（拒收逻辑在 handleInbound）');
  const withChat = normalizeInbound({ chat_id: 'c1', text: 'hi' }, 'wechat');
  assert.equal(withChat.chatIdExplicit, true);
  const other = normalizeInbound({ sender_id: 'u1', text: 'hi' }, 'other');
  assert.equal(other.chatIdExplicit, false);
  assert.equal(other.chatId, 'u1', '非微信渠道不影响旧兜底');
});
