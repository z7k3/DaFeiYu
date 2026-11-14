'use strict';

// free_chat 抽签的仲裁器否决：unknown/other 且 conf≥0.5 → 否决；
// her（在叫她）与 group（在聊她相关话题）不否决——后者是 free_chat 的设计场景。
const test = require('node:test');
const assert = require('node:assert/strict');
const { freeChatVeto } = require('../src/core/addressing');

test('unknown/other 且置信度足够 → 否决抽签醒来', () => {
  assert.equal(freeChatVeto({ addressee: 'unknown', confidence: 0.2 }), true);
  assert.equal(freeChatVeto({ addressee: 'unknown', confidence: 0.6 }), true);
  assert.equal(freeChatVeto({ addressee: 'other', confidence: 0.9 }), true);
});

test('her（在叫她）与 group（聊她相关话题）→ 不否决', () => {
  assert.equal(freeChatVeto({ addressee: 'her', confidence: 0.9 }), false);
  assert.equal(freeChatVeto({ addressee: 'group', confidence: 0.8 }), false);
});

test('置信度不足 0.5 或坏输入 → 不否决（宁可让她说话）', () => {
  assert.equal(freeChatVeto({ addressee: 'unknown', confidence: 0.4 }), false);
  assert.equal(freeChatVeto(null), false);
  assert.equal(freeChatVeto({}), false);
});
