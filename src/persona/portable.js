'use strict';

// 可分享字段必须显式列出，绝不把整个 config、主人账号或权限配置放入人设包。
const NUMBERS = Object.freeze({
  age: [1, 120], privateMaxChars: [40, 800], groupMaxChars: [20, 300],
  historyTurns: [4, 400], groupHistoryTurns: [2, 300], maxBubbles: [1, 8],
  discussionMaxChars: [20, 4000], emojiChance: [0, 1],
});
const STRINGS = Object.freeze({
  personaName: 40, job: 80, appearance: 400, personality: 500, background: 500,
  customPrompt: 24000, ownerName: 24,
});
const BOOLEANS = Object.freeze(['masterRoast', 'proactive', 'opinions']);

function portableFields(data = {}, { local = false } = {}) {
  const out = {};
  for (const [key, max] of Object.entries(STRINGS)) {
    if (typeof data[key] === 'string') out[key] = key === 'customPrompt' && local
      ? data[key].trim() : data[key].trim().slice(0, max);
  }
  for (const [key, [min, max]] of Object.entries(NUMBERS)) {
    if (typeof data[key] !== 'number' || !Number.isFinite(data[key])) continue;
    const value = key === 'emojiChance' ? data[key] : Math.trunc(data[key]);
    out[key] = Math.max(min, Math.min(max, value));
  }
  for (const key of BOOLEANS) if (typeof data[key] === 'boolean') out[key] = data[key];
  if (['关', '少', '正常', '多'].includes(data.emoji)) out.emoji = data.emoji;
  if (Array.isArray(data.aliases)) out.aliases = data.aliases.filter(v => typeof v === 'string')
    .map(v => v.trim().slice(0, 40)).filter(Boolean).slice(0, 30);
  return out;
}

module.exports = { portableFields, NUMBERS, STRINGS, BOOLEANS };
