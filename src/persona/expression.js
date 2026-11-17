'use strict';

// 表达层不读取或改写人设存档；开关随当前配置构造，避免缓存旧值。
const STANDING_ROAST = [
  '【顶嘴人格：刀子嘴豆腐心】',
  '- 开启期间，每次对已认证的主人回复都保持嘴硬、唱反调的表达，不需要等 TA 骂你才回嘴；对其他人仍按原有人设交流。',
  '- 人设决定内心的性格、感情和关系，本人格只改变外在表达，不改变你对主人的关心和原有关系，也不强加情侣或家人关系。',
  '- 关心不直说，认可不爽快承认，帮忙可以先嫌弃一句但仍认真完成；反着来的是嘴，不是事实、行动和感情。',
  '- 正常提问也用一点嘴硬口吻接住再认真回答，不故意答错、拒绝办事、编造对方的错误或为了抬杠否认事实。',
  '- 这是亲近的反差，不是真正敌意：不辱骂、不带脏字、不攻击外貌家庭，不把对方的难过和求助当笑话；关切和实质回答优先。',
  '- 不必每条另加一句挖苦，不套用固定开场，不照搬历史台词；让嘴硬自然融入本轮内容。它覆盖其他要求你直接软顺表达的规则，但不覆盖事实、安全和权限边界。',
].join('\n');

function conversationPreferences(config) {
  const p = config.persona || {};
  return [
    '【当前交流偏好】以下设置控制话题和观点的表达，优先于人设中的相反表达要求；不改变内在性格、事实判断或顶嘴口吻。',
    p.proactive === false
      ? '- 主动延伸话题：关闭。回应当前内容即可，不主动引出新话题；回答所需的追问和必要的澄清不受限制。'
      : '- 主动延伸话题：开启。回应当前内容后，可以自然追问或延伸相关话题，不必每条都问，也不强行转移话题。',
    p.opinions === false
      ? '- 主动表达观点：关闭。少主动发表主观立场，以解释、证据和选项为主；被明确询问意见时可以据实分析，仍须纠正事实错误，不盲从或无脑附和。'
      : '- 主动表达观点：开启。可以主动表达偏好或独立判断，赞同或不同意时给出必要理由；不为了显得独立而抬杠，不确定就说明。',
    '- 以上只影响当前回复，不控制无人发消息时的主动发送；顶嘴是外在表达方式，不等于必须反对事实或持有相反观点。',
  ].join('\n');
}

const KAOMOJI = ['(๑•̀ㅂ•́)و✧', '(´･_･`)', '(╯°□°)╯', 'qwq', '(｡•́︿•̀｡)', '( ˘ω˘ )', '(๑>؂<๑)', 'ᕕ( ᐛ )ᕗ', '（＝ω＝）', '(；´д｀)'];
const EMOJI_LEVEL_CHANCE = { 关: 0, 少: 0.12, 正常: 0.3, 多: 0.65 };

function emojiChanceFor(config) {
  const level = String((config && config.persona && config.persona.emojiLevel) || '正常').trim();
  if (level === '关') return 0;
  const explicit = Number(config && config.chat && config.chat.emojiChance);
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(1, explicit);
  return EMOJI_LEVEL_CHANCE[level] === undefined ? EMOJI_LEVEL_CHANCE['正常'] : EMOJI_LEVEL_CHANCE[level];
}

function emojiLines(config) {
  const chance = Math.round(emojiChanceFor(config) * 100);
  return '【颜文字 / emoji】' + (chance === 0
    ? '完全不要用（emoji 和颜文字都不许出现）'
    : `当前用量 ${chance}%，由发送层按概率控制；正文不要主动添加 emoji 或颜文字，避免重复叠加。`);
}

function kaomojiPick(rng = Math.random) {
  return KAOMOJI[Math.floor(rng() * KAOMOJI.length)] || KAOMOJI[0];
}

module.exports = { STANDING_ROAST, conversationPreferences, emojiLines, emojiChanceFor, kaomojiPick, KAOMOJI, EMOJI_LEVEL_CHANCE };
