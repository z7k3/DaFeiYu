'use strict';

/**
 * 名单类回复不被整轮字数截断的回归测试（2026-11-17 CS2 top20 实见）。
 *
 * 现场：私聊问「去年CS2的top20都是谁」，回复在「11 Tw」断成半个词，且没有省略号。
 * 日志：bubbles=1 chars=119，后台通道发送成功——内容在生成收尾阶段被切。
 * 根因：finalize 的整轮硬截断（privateMaxChars=120）发生在分泡**之前**，
 * 而「名单整段合成、上限 600」的宽限在分泡器里，永远轮不到；切完补的「…」
 * 又被分泡后的尾部标点清洗剥掉，连「我没说完」的提示都没有。
 *
 * 修复：识别名单类回复（换行列表或行内连续编号）整轮上限放宽到 600（与分泡器
 * 名单分支对齐）；截断标记在最后一条气泡上补回。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Bot } = require('../src/pipeline/chat');
const { Store } = require('../src/memory/store');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const persona = require('../src/persona');

function makeBot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-list-cap-'));
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.chat.privateMaxChars = 120;
  config.chat.maxBubbles = 2;
  config.links.enabled = false;
  config.websearch.enabled = false;
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const bot = new Bot({ config, store, llm: { isMock: true, model: 'mock', reload() {}, describe() { return {}; } }, logger: null, mockChunkDelayMs: 0 });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }); });
  const decision = (text) => ({
    action: 'reply',
    key: 'wechat:u:wxid_test_peer',
    msg: { platform: 'wechat', chatType: 'private', chatId: 'wxid_test_peer', senderId: 'wxid_test_peer', senderName: '测试', cleanText: '去年CS2的top20都是谁', isMaster: false },
    reason: 'addressed',
  });
  return { bot, decision };
}

const inlineTop20 = '查到了，2025 HLTV Top20 完整名单： '
  + Array.from({ length: 20 }, (_, i) => `${i + 1} Player${i + 1}`).join(' ');

test('行内编号名单（今天的实见场景）不再被 120 字截断', (t) => {
  const { bot, decision } = makeBot(t);
  assert.ok(Array.from(inlineTop20).length > 120, '前置：这份名单超过 120 字');
  const bubbles = bot.finalize(decision(), inlineTop20);
  const joined = bubbles.join('');
  assert.ok(joined.includes('20 Player20'), '名单尾部必须保留——不能断在「11 Tw」');
  assert.ok(!joined.endsWith('…'), '没有截断就不该带省略号');
});

test('换行编号名单同样完整（单气泡，名单分支）', (t) => {
  const { bot, decision } = makeBot(t);
  const list = '2025 HLTV Top20：\n' + Array.from({ length: 20 }, (_, i) => `${i + 1}. Player${i + 1}`).join('\n');
  const bubbles = bot.finalize(decision(), list);
  const joined = bubbles.join('');
  assert.ok(joined.includes('20. Player20'), '换行名单尾部必须保留');
  // 名单本体必须合成一条且完整；名单之外允许一条随机表情（既有设计：表情单独成泡）
  const listBubbles = bubbles.filter((b) => b.includes('1. Player1'));
  assert.equal(listBubbles.length, 1, '名单本体只占一条气泡，不拆散');
  assert.ok(listBubbles[0].includes('20. Player20'), '名单气泡从头到尾完整');
  for (const b of bubbles) {
    if (!b.includes('1. Player1')) assert.ok(!/\d{1,2}\.\s*Player|20\.\s*Player/.test(b), '名单外的气泡只能是表情/颜文字，不能是名单残段');
  }
});

test('普通长文（非名单）仍按 120 字截断，且「…」提示不再被清洗掉', (t) => {
  const { bot, decision } = makeBot(t);
  const prose = '今天天气很好，我们出去玩，' + '沿途风景不错，走了很多路，'.repeat(20) + '很累';
  const bubbles = bot.finalize(decision(), prose);
  const joined = bubbles.join('');
  assert.ok(Array.from(joined).length < Array.from(prose).length, '非名单长文仍要截断');
  assert.ok(joined.endsWith('…'), '截断提示「…」必须保留在最后一条气泡上——不能无声切断');
});

test('isListReply 判定：换行列表/行内编号为真，普通文本为假', () => {
  assert.equal(persona.isListReply('1. aaa\n2. bbb\n3. ccc'), true);
  assert.equal(persona.isListReply('名单： 1 aaa 2 bbb 3 ccc 4 ddd'), true);
  assert.equal(persona.isListReply('今天天气很好，我们出去玩'), false);
  assert.equal(persona.isListReply('比分是 2 1，我们赢了'), false, '零星数字不是名单');
  assert.equal(persona.isListReply(''), false);
});

test('splitBubbles 名单分支：超 600 字的名单按上限截断并带省略号', () => {
  const huge = Array.from({ length: 120 }, (_, i) => `${i + 1}. Player${i + 1}`).join('\n');
  const bubbles = persona.splitBubbles(huge, { maxChars: 120, maxBubbles: 2 });
  assert.equal(bubbles.length, 1, '名单永远合成一条');
  assert.ok(bubbles[0].endsWith('…'), '超名单上限要带省略号');
  assert.ok(bubbles[0].includes('1. Player1'), '头部保留');
});
