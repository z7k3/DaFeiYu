'use strict';
const fs = require('node:fs');
const path = require('node:path');
// 唱歌类请求：原来的规则只认「发/来/说/讲/回复 + 语音」，于是
// 「你用语音唱啊」「唱一首」「哼一段」都不算语音请求 → 她只能把歌词打成文字，
// 还嘴硬「这条发语音了」，被用户当场识破（2026-11-13 17:47 物体识别群）。
const SING_RE = /(?:唱|哼)(?:一?首|一段|一句|一个|个|给我听|来听|听听)|用语音(?:唱|哼)|语音(?:唱|哼)|(?:发|来)(?:一)?条?语音(?:唱|哼)/u;

function requested(text) {
  const value = String(text || '');
  return value.length <= 500 && !/不要|别(?:再)?|不想|不用|不能|怎么|如何|他说|她说|有人说|关闭|取消|["“”‘’]/u.test(value)
    && (/(?:发|来|说|讲|回复)(?:给我|个|一条|一句|句|段|一段|条|一下|点|一段话|个回复|次|一)?\s*语音|用语音(?:回|说|讲)|语音(?:回我|回复|说一句)/u.test(value)
      || SING_RE.test(value));
}
function enabled(config, isGroup) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(config.paths.dataDir, 'voice-send.json'), 'utf8').replace(/^\uFEFF/, ''));
    const scope = value[isGroup ? 'Groups' : 'Private'];
    return value.Enabled === true && (scope === undefined || scope === true);
  } catch { return false; }
}
module.exports = { requested, enabled };
