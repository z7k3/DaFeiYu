'use strict';

/**
 * 「这条消息是不是在跟她说」的唯一判定入口。
 *
 * 以前 atMe / clean.atMe / addressedToBot / replyToBot / namedHerIn 分散在
 * trigger、chat、canned 里各算一遍，同一条消息在不同分支可能得到不同结论。
 * 这里只做纯函数，不读写 state，方便单测。
 */

/** 她当前可能被叫到的名字：人设名 + 别名 + 桥接上报的账号昵称/备注等。 */
function herNames(bot, msg) {
  const persona = (bot && bot.config && bot.config.persona) || {};
  const extra = msg && Array.isArray(msg.selfNames) ? msg.selfNames : [];
  return [...new Set([persona.name, ...(persona.aliases || []), ...extra]
    .map((x) => String(x || '').trim()).filter(Boolean))];
}

/** 正文里是否出现她的名字/外号（含「你机器人」这类明确指代）。 */
function namedHerIn(text, names = []) {
  const s = String(text || '');
  const list = Array.isArray(names) && names.length ? names : ['鲸鲸', '小鲸', '肥鱼'];
  if (list.some((name) => name && s.includes(name))) return true;
  return /(这个|那个|你|破|臭|傻|烂|死)\s*机器人/.test(s);
}

/** 显式 @ 或回复她；名字命中属于「叫到名字」，由调用方单独处理。 */
function isAddressed(atMe, msg) {
  return Boolean(atMe || (msg && msg.replyToBot));
}

/** 把桥接传来的提及名单过滤掉她自己和广播词，避免把自己当第三人。 */
function filterSelfMentions(list, names = []) {
  const self = new Set(
    (Array.isArray(names) ? names : [])
      .map((x) => String(x || '').trim().toLowerCase())
      .filter(Boolean),
  );
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const name = String(raw || '').trim();
    const key = name.toLowerCase();
    if (!name || self.has(key) || seen.has(key)) continue;
    if (key === '所有人' || key === '全体成员') continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** 这条消息是不是明显在跟别人说（@ 了别人 / 第三人称 / 提了别的成员）。 */
function talkingToOthers({ msg, text, guardOn = true, names = [] }) {
  if (!guardOn) return false;
  const others = filterSelfMentions(msg && msg.mentionedNames, names);
  if (others.length) return true;
  const s = String(text || '');
  return /(他|她|楼上|楼下|那谁|某人|刚才那个)/.test(s) && !/你|你们/.test(s);
}

/**
 * 仲裁器：统一回答「这条消息是不是在跟她说话」，并给出置信度和证据。
 *
 * 为什么要有它：以前这个问题在 trigger、chat（directedElsewhere/targets）、
 * fight、care 里各回答一遍，12 个文件里 79 处判定，改一处就破坏另一处
 * （2026-11-13 一天内三次翻车：引用块里的 @ 被当成"在跟别人说话"、
 * 接话窗口只认名字不看「你」、主人喊别名又被 directedElsewhere 挡住）。
 *
 * 三条原则：
 *   1. 结构证据优先且一票通过：回复她 / @她 / 上一句是她说的+对方说「你」。
 *   2. 语义证据只影响置信度；**话题提及永不否决**（引用块里的人、正文提到的人
 *      是"在聊谁"，不是"在跟谁说"）。
 *   3. 输出证据列表，日志能回答「她为什么认为在跟别人说话」。
 *
 * 纯函数：不读写 state、不调 IO，便于单测和影子对比。
 *
 * @returns {{addressee:'her'|'other'|'group'|'unknown', confidence:number,
 *            evidence:string[], topicMentions:string[], reason:string}}
 */
function analyze(bot, {
  msg, text, atMe, isGroup = true, state = {}, nowMs = Date.now(),
  isMaster = false, names = [], guardOn = true, botSpokeLast = false,
}) {
  const said = String(text || '');
  const evidence = [];
  const list = Array.isArray(names) && names.length ? names : herNames(bot, msg);
  const m = msg || {};
  // 结构提及：本条消息**显式 @** 的人 —— 这是结构证据，意味着"在跟别人说"。
  const others = filterSelfMentions(m.mentionedNames, list);
  // 话题提及：被聊到的人（引用块里的、正文提到的）—— 只记录，**永不参与 addressee 判定**。
  const topicMentions = [...new Set([
    ...others,
    ...filterSelfMentions(m.topicMentions, list),
  ])].slice(0, 4);
  const verdict = (addressee, confidence, reason) =>
    ({ addressee, confidence, evidence: evidence.slice(), topicMentions, reason });

  // —— 结构证据（一票通过）——
  if (!isGroup) {
    evidence.push('private_chat');
    return verdict('her', 1, 'private');
  }
  if (isAddressed(atMe, m)) {
    evidence.push(m && m.replyToBot ? 'reply_to_her' : 'at_her');
    // 引用别人的消息 + 又 @ 了她：以 @ 为准（她确实被叫到了）
    return verdict('her', 0.98, m && m.replyToBot ? 'reply_to_her' : 'at_her');
  }
  if (namedHerIn(said, list)) {
    evidence.push('named_her');
    return verdict('her', 0.92, 'named_her');
  }

  // 引用了别人的消息。注意：引用谁 ≠ 在跟谁说话（有人引用别人的话再来问她，
  // 也有人引用了她的话却是在跟另一个人聊）。这里只降置信度，不单独定论。
  const quotedOther = Boolean(m.replyToName || m.replyToUserId);
  if (quotedOther) evidence.push('reply_to_other');

  // 她刚说完这句，对方紧接着用「你」接话 —— 最自然的接话，结构上就是一问一答。
  const justSpoke = Number(state.lastReplyAt) > 0 && nowMs - Number(state.lastReplyAt) <= 90 * 1000;
  const engagedBySender = String(state.engagedBy || '') === String(m.senderId || '')
    && Number(state.engagedUntil) > nowMs;
  const engagedSet = hasEngagedSet(state, m.senderId, nowMs);
  if (engagedBySender) evidence.push('engaged_with_sender');
  if (engagedSet) evidence.push('engaged_set_has_sender');
  if (botSpokeLast) evidence.push('bot_spoke_last');

  const hasYou = /你|你们/.test(said);
  const short = said.trim().length <= 60;
  // 明确在跟别人说话：显式 @ 别人，或第三人称提到别人却不用「你」。
  const atOther = Boolean(guardOn && others.length);
  const thirdPerson = guardOn && /(他|她|楼上|楼下|那谁|某人|刚才那个)/.test(said) && !hasYou;
  if (atOther) evidence.push('at_other');
  if (thirdPerson) evidence.push('third_person_no_you');

  if (botSpokeLast && hasYou && short && !atOther && !thirdPerson) {
    return verdict('her', 0.82, 'bot_spoke_last_you');
  }
  if (engagedBySender && hasYou && short && !atOther) {
    return verdict('her', 0.78, 'engaged_you');
  }
  if (justSpoke && hasYou && short && !atOther && !thirdPerson) {
    return verdict('her', 0.66, 'just_spoke_you');
  }
  if (engagedSet && short && !atOther) {
    return verdict('her', 0.6, 'engaged_set_turn');
  }
  // 被主人点名/主人在说话：主人有专门的策略，这里只标 her（低置信，交由上层）。
  if (isMaster && !atOther) {
    evidence.push('from_master');
    return verdict('her', 0.55, 'from_master');
  }
  if (atOther) return verdict('other', 0.8, 'at_other');
  if (thirdPerson) return verdict('other', 0.5, 'third_person_no_you');
  // 群里没人被点名、也没指向别人：可能是泛问（「有谁知道…」），交给上层按概率接。
  if (/[?？]/.test(said)) {
    evidence.push('open_question');
    return verdict('group', 0.4, 'open_question');
  }
  return verdict('unknown', 0.2, 'no_signal');
}

/** 多人接话集合里有没有这个说话人（没有就返回 false）。 */
function hasEngagedSet(state, senderId, nowMs) {
  const set = state && state.engagedSet;
  if (!set) return false;
  const ts = Number(set[String(senderId || '')] || 0);
  if (!ts) return false;
  const win = Math.max(1, Number((state && state.engagedMinutes) || 6)) * 60000;
  return nowMs - ts <= win;
}

module.exports = { herNames, namedHerIn, isAddressed, filterSelfMentions, talkingToOthers, analyze, hasEngagedSet };
