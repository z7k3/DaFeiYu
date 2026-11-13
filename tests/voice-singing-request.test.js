'use strict';

/**
 * 「唱歌类请求 = 显式语音请求」的回归测试。
 *
 * 现场（2026-11-13 17:45 物体识别群）：
 *   用户：「你会唱歌吗」她：「会一点…你想听哪首」
 *   用户：「两只老虎」→ 她把歌词打字回了一遍
 *   用户：「你用语音唱啊」→ 还是文字，且她说「这条真发语音了，你听着」
 *   用户：「你这不还是打字吗」「都显式要求语音了还给我打字」
 *
 * 根因：语音通道由程序决定，判定规则只认「发/来/说/讲/回复 + 语音」，
 * 「用语音唱」「唱一首」「哼一段」都不算 → 她只能把歌词当文字发出去，
 * 还嘴硬说发了语音（露馅）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const voiceReply = require('../src/core/voiceReply');

for (const text of ['你用语音唱啊', '唱一首给我听', '哼一段来听听', '用语音唱两句', '发条语音唱个歌']) {
  test('唱歌类请求算语音：' + text, () => {
    assert.equal(voiceReply.requested(text), true);
  });
}

for (const text of ['两只老虎', '你会唱歌吗', '这歌好听吗', '别唱了', '不要语音']) {
  test('不是语音请求：' + text, () => {
    assert.equal(voiceReply.requested(text), false);
  });
}

test('原来就支持的显式语音请求不受影响', () => {
  assert.equal(voiceReply.requested('发条语音给我'), true);
  assert.equal(voiceReply.requested('用语音回复我'), true);
});
