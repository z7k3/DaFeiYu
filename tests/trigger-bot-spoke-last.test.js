'use strict';

/**
 * 「她刚说完话，群里有人用『你』接茬」必须回 —— 回归测试。
 *
 * 现场（2026-11-13 16:58 物体识别群）：
 *   她：「再说我先反弹你那句小学生」
 *   群友：「那我超级反弹你不炸了」   ← 没回
 *   群友：「你为什么不回复我这条消息啊」← 没回（引用了含 @十七 的旧消息）
 *
 * 两个不同原因：
 *   1. groupAddressGuard 在「接话窗口」分支要求出现她的名字，光有「你」不算，
 *      于是最自然的接话被当成「在跟别人说话」。
 *   2. 引用消息把引用块里的 @十七 当成了本条消息的 @ 对象（话题对象泄漏），
 *      于是判「在跟别人说话」。修法：@ 只从本条正文（replyBody）提取。
 *
 * 这里测第 1 条（纯函数层）：botSpokeLast=true + 「你」→ 唤醒；
 * 没有这个信号、或另有他人在对话 → 仍然不插嘴。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { computeTrigger } = require('../src/core/trigger');

const NOW = new Date('2026-11-13T16:58:32+08:00').getTime();

function bot({ guard = true } = {}) {
  return {
    config: {
      group: { requireAt: true, freeChat: false, freeChatChance: 0, engagedMinutes: 6, maxRepliesPerMinute: 0 },
      features: { groupAddressGuard: guard },
      persona: { name: '鲸鲸', aliases: ['小鲸'] },
    },
    store: { messages: () => [] },
    rng: () => 0.99,
  };
}

// 她 27 秒前刚在这个群说过话
function state() {
  return { engagedUntil: NOW + 5 * 60000, engagedBy: 'someone-else', lastReplyAt: NOW - 27 * 1000, replyTimes: [] };
}

function args({ text, botSpokeLast, talkingNames = [] }) {
  return {
    msg: { senderId: 'wxid_a', chatType: 'group', mentionedNames: talkingNames, text },
    atMe: 0, clean: { text }, isGroup: true, state: state(), nowMs: NOW,
    isMaster: false, key: 'k', muted: false, botSpokeLast,
  };
}

test('她刚说完，群友紧接着用「你」接茬 → 唤醒', () => {
  const r = computeTrigger(bot(), args({ text: '那我超级反弹你不炸了', botSpokeLast: true }));
  assert.equal(r.wake, true);
  assert.equal(r.reason, 'engaged_reply');
});

test('没有「上一句是她说的」这个信号时，不因为一个「你」就插嘴', () => {
  const r = computeTrigger(bot(), args({ text: '那我超级反弹你不炸了', botSpokeLast: false }));
  assert.equal(r.wake, false);
});

test('对方明摆着在跟别人说话（@/提到别人）时，仍然不接', () => {
  const r = computeTrigger(bot(), args({ text: '你今天考得怎么样', botSpokeLast: true, talkingNames: ['张梓锟'] }));
  assert.equal(r.wake, false);
});

test('整段没有「你」的旁白不唤醒（防止变成乱插话）', () => {
  const r = computeTrigger(bot(), args({ text: '我今天去打篮球了', botSpokeLast: true }));
  assert.equal(r.wake, false);
});
