'use strict';

/**
 * 影子仲裁器（_addrShadow）的回归测试。
 *
 * 背景：`return verdict` 原来写在 try 块**外面**——const 块级作用域出不来，
 * 只要影子判定与旧判定出现分歧（这正是影子模式要收集的核心样本）就抛
 * ReferenceError → decide 整个抛错 → 这条消息静默不回话。
 * addressShadow 开着时必现（2026-11-17 16:23 / 16:30 两次实见）。
 *
 * 锁三件事：分歧路径返回 verdict（不再抛错）、一致路径返回 falsy、
 * 配置关闭返回 null 且根本不计算。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { Bot } = require('../src/pipeline/chat');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const addressing = require('../src/core/addressing');

const realAnalyze = addressing.analyze;
test.after(() => { addressing.analyze = realAnalyze; });

function makeFake(over = {}) {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.group = { ...config.group, addressShadow: true };
  return {
    config,
    logger: { info() {}, warn() {} },
    ...over,
  };
}

const args = (text) => ({
  msg: { platform: 'wechat', chatType: 'group', chatId: '123@chatroom', senderId: 'wxid_test_s', senderName: '测试', text },
  clean: { text },
  atMe: false,
  isGroup: true,
  state: {},
  nowMs: Date.now(),
  isMaster: false,
  botSpokeLast: false,
});

test('分歧路径返回 verdict，不再抛 ReferenceError（合并前就存在的老 bug）', () => {
  // 影子判「不是在跟她说话」，旧判定 wake=true → 分歧
  addressing.analyze = () => ({ addressee: 'other', confidence: 0.9, reason: 'test_diverge', evidence: [], topicMentions: [] });
  const verdict = Bot.prototype._addrShadow.call(makeFake(), args('@别人 你看这个'), { wake: true, reason: 'addressed' });
  assert.ok(verdict, '分歧时必须返回 verdict 对象');
  assert.equal(verdict.addressee, 'other');
});

test('一致路径返回 falsy，不产生样本日志', () => {
  addressing.analyze = () => ({ addressee: 'her', confidence: 0.9, reason: 'test_agree', evidence: [], topicMentions: [] });
  const out = Bot.prototype._addrShadow.call(makeFake(), args('@鲸鲸 在吗'), { wake: true, reason: 'addressed' });
  assert.ok(!out, '新旧判定一致时返回 falsy');
});

test('判定计算抛错时返回 null（不影响正常流程）', () => {
  addressing.analyze = () => { throw new Error('unit-test boom'); };
  const out = Bot.prototype._addrShadow.call(makeFake(), args('随便说点'), { wake: false, reason: 'not_addressed' });
  assert.equal(out, null);
});

test('addressShadow 关闭时直接返回 null，不做影子计算', () => {
  addressing.analyze = () => { throw new Error('不该被调用'); };
  const fake = makeFake();
  fake.config.group.addressShadow = false;
  const out = Bot.prototype._addrShadow.call(fake, args('随便说点'), { wake: false, reason: 'not_addressed' });
  assert.equal(out, null);
});
