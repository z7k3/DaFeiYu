'use strict';

/**
 * 仲裁器 addressing.analyze 的回归测试（阶段 1：影子模式的数据来源）。
 *
 * 目标不是「猜得更准」，而是把这些曾经翻车的场景**变成可断言的结论**：
 *   2026-11-13 一天内三次错判，全部来自「谁在跟谁说话」被分散在各处各算一遍。
 *
 * 三个必须成立的原则：
 *   1. 结构证据一票通过（回复她 / @她 / 上一句是她说的 + 「你」）；
 *   2. 话题提及永不否决（引用块里 @ 的人不算本条消息的 @ 对象）；
 *   3. 明摆着跟别人说话时不乱接（@ 了别人 / 第三人称且没用「你」）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { analyze } = require('../src/core/addressing');

const NOW = new Date('2026-11-13T16:58:32+08:00').getTime();
const NAMES = ['鲸鲸', '小鲸'];
const bot = { config: { persona: { name: '鲸鲸', aliases: ['小鲸'] } } };

function ctx(extra = {}) {
  return {
    msg: { senderId: 'wxid_a', chatType: 'group', text: '', ...extra.msg },
    text: extra.text || '',
    atMe: extra.atMe || 0,
    isGroup: extra.isGroup !== false,
    state: { engagedUntil: 0, engagedBy: '', lastReplyAt: 0, engagedSet: {}, ...extra.state },
    nowMs: NOW,
    isMaster: Boolean(extra.isMaster),
    names: NAMES,
    guardOn: extra.guardOn !== false,
    botSpokeLast: Boolean(extra.botSpokeLast),
  };
}

test('私聊一律算在跟她说话', () => {
  const v = analyze(bot, ctx({ isGroup: false, text: '在吗' }));
  assert.equal(v.addressee, 'her');
  assert.deepEqual(v.evidence, ['private_chat']);
});

test('@ 她 / 回复她：结构证据一票通过', () => {
  assert.equal(analyze(bot, ctx({ atMe: 1, text: '你好' })).addressee, 'her');
  const r = analyze(bot, ctx({ text: '这个怎么看', msg: { senderId: 'wxid_a', replyToBot: true } }));
  assert.equal(r.addressee, 'her');
  assert.ok(r.evidence.includes('reply_to_her'));
});

test('叫出她的名字（含别名）就算在跟她说话', () => {
  const v = analyze(bot, ctx({ text: '小鲸你怎么看' }));
  assert.equal(v.addressee, 'her');
  assert.equal(v.reason, 'named_her');
});

test('引用块里 @ 了别人，但本条在问「你」——不能被话题提及否决', () => {
  // 现场：引用「…对 @十七 的印象…」+ 正文「你为什么不回复我这条消息啊」
  const v = analyze(bot, ctx({
    text: '你为什么不回复我这条消息啊',
    msg: {
      senderId: 'wxid_a', replyToName: '张梓锟', replyToUserId: 'wxid_b',
      // 修复后 bridge 只从正文取 @，所以结构提及为空；
      // 引用块里的「@十七」只是话题（topicMentions），永不参与 addressee 判定。
      mentionedNames: [], topicMentions: ['十七'], replyBody: '你为什么不回复我这条消息啊',
      text: '你为什么不回复我这条消息啊',
    },
    state: { lastReplyAt: NOW - 27 * 1000 },
  }));
  assert.equal(v.addressee, 'her', '引用别人的消息但正文问「你」、且她刚说过话 → 就是在问她');
  assert.ok(v.topicMentions.includes('十七'), '话题里的人要单独记录，供上层参考');
});

test('她刚说完、对方紧接着说「你」→ 判定为她（今天漏回的那句）', () => {
  const v = analyze(bot, ctx({
    text: '那我超级反弹你不炸了',
    botSpokeLast: true,
    state: { lastReplyAt: NOW - 27 * 1000, engagedUntil: NOW + 60000, engagedBy: 'someone-else' },
  }));
  assert.equal(v.addressee, 'her');
  assert.equal(v.reason, 'bot_spoke_last_you');
  assert.ok(v.evidence.includes('bot_spoke_last'));
});

test('没有「上一句是她说的」信号时，光一个「你」不能乱接', () => {
  const v = analyze(bot, ctx({ text: '那我超级反弹你不炸了', botSpokeLast: false }));
  assert.notEqual(v.addressee, 'her');
});

test('@ 了别人：判定为别人（不乱接）', () => {
  const v = analyze(bot, ctx({
    text: '你今天考得怎么样',
    msg: { senderId: 'wxid_a', mentionedNames: ['张梓锟'] },
  }));
  assert.equal(v.addressee, 'other');
  assert.ok(v.evidence.includes('at_other'));
});

test('第三人称说别人、没有「你」：判定为别人', () => {
  const v = analyze(bot, ctx({ text: '他昨天说的那个事你们知道吗' }));
  assert.notEqual(v.addressee, 'her');
});

test('群里泛问（有问号、没指向任何人）：交给上层按概率接', () => {
  const v = analyze(bot, ctx({ text: '有人知道这个怎么弄吗？' }));
  assert.equal(v.addressee, 'group');
});

test('沉默状态下的消息不产生"在跟她说话"的高置信结论', () => {
  const v = analyze(bot, ctx({
    text: '随便说一句',
    state: { silentUntil: NOW + 60000 },
  }));
  assert.notEqual(v.addressee, 'her');
});
