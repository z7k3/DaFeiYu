'use strict';

function aliasList(config, extraNames = []) {
  const aliases = (config.persona && config.persona.aliases) || [];
  const name = config.persona && config.persona.name;
  const extra = Array.isArray(extraNames) ? extraNames : [];
  return [...new Set([name, ...aliases, ...extra].map((x) => String(x || '').trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
}

function cleanIncomingForPersona(text, config, extraNames = []) {
  let s = String(text || '').replace(/\u2005/g, ' ').replace(/\u200b/g, '');
  const aliases = aliasList(config, extraNames);
  let hadAlias = false;
  // 系统生成的图片说明可能含角色名，但不代表用户真的点名。
  if (/^（对方/.test(s)) return { text: s.trim(), atMe: false, hadAlias: false };
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const atBoundary = '(?=$|[\\s，,：:！!~～…?？。\\-—])';
    const atRe = new RegExp(`@\\s*${escaped}${atBoundary}`, 'g');
    if (atRe.test(s)) { hadAlias = true; s = s.replace(atRe, ' '); }
    const bareBoundary = '(?=$|[\\s，,：:！!~～…?？。\\-—]|[你我他她它今明昨在有是想要能会可帮给跟来去看听说问怎为干做吃喝睡别快先再这那真太好还就又请把让])';
    const bareRe = new RegExp(`^\\s*${escaped}${bareBoundary}\\s*[，,：:！!~～\\-—]*\\s*`, 'g');
    if (bareRe.test(s)) { hadAlias = true; s = s.replace(bareRe, ''); }
    if (alias.length >= 2) {
      const midRe = new RegExp(`${escaped}(?![娘鱼鲸乐妹姐哥儿仔])\\s*[，,：:！!~～\\-—]*`, 'g');
      if (midRe.test(s)) { hadAlias = true; s = s.replace(midRe, ' ').replace(/[ \t]{2,}/g, ' ').trim(); }
    }
  }
  s = s.replace(/[ \t]{2,}/g, ' ').trim();
  return { text: s, atMe: hadAlias, hadAlias };
}

// 名单行：以编号/序号/项目符号开头的行（1. xx / 1、xx / ① xx / - xx）
const LIST_LINE = /^\s*(?:\d{1,2}[.、)）]?\s*\S|[\u2460-\u2473]\s*\S|[-*•]\s*\S)/;
// 行内连续编号：模型经常把名单写在一行里（「1 ZywOo 2 donk 3 ropz …」），
// 没有换行时靠「≥3 组连续的『编号+词条』」识别。误伤后果只是这条回复
// 放宽到名单上限（600），比漏伤（名单被 120 字硬切）轻得多。
const INLINE_LIST_RUN = /(?:^|[\s：:，,（(])\d{1,2}[.、)）]?\s+\S+(?:\s+\d{1,2}[.、)）]?\s+\S+){2,}/;
// 名单类回复的整轮字数上限：与 splitBubbles 名单分支的宽限一致。
// chat.js 的整轮硬截断必须认这个数，否则名单宽限永远轮不到（2026-11-17
// 实见 CS2 top20 在 privateMaxChars=120 下被切成「11 Tw」半个词）。
const LIST_REPLY_CAP = 600;

/** 这条回复是不是名单/列表（换行列表或行内连续编号） */
function isListReply(text) {
  const raw = String(text || '').replace(/\r/g, '');
  if (!raw) return false;
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const hits = lines.filter((l) => LIST_LINE.test(l)).length;
  if (hits >= 3 && hits >= lines.length - 2) return true;
  return INLINE_LIST_RUN.test(raw);
}

function splitBubbles(text, { maxChars = 120, maxBubbles = 2, preferSeparate = false } = {}) {
  const raw = String(text || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
  if (!raw) return [];
  const limit = Math.max(8, Number(maxChars) || 120);
  const maxN = Math.max(1, Math.floor(Number(maxBubbles) || 1));
  // 名单/列表回复是一个整体：≥3 行以编号或项目符号开头的行拆散会把
  // 「1 ZywOo」「2 donk」变成一条人名一个气泡（2026-11-14 实见 CS2 top20
  // 被拆成 6 条连发）。行内连续编号（「1 ZywOo 2 donk …」不带换行）同理：
  // 按句切会把尾巴硬切丢掉（2026-11-17 实见 11 Tw）。整段合成一条，
  // 上限放宽到 600 字。
  if (isListReply(raw)) {
    const cap = Math.max(LIST_REPLY_CAP, limit * 6);
    return [raw.length > cap ? raw.slice(0, cap - 1).trimEnd() + '…' : raw];
  }

  let separate = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  let separator = '\n';
  if (separate.length === 1 && preferSeparate) {
    separate = raw.split(/(?<=[。！？!?；;])(?=\s*[^。！？!?；;\s])/);
    if (separate.length === 1) separate = raw.split(/(?<=，)(?=\s*\S)/);
    separator = '';
  }
  if (maxN > 1 && separate.length > 1) {
    const out = separate.slice(0, maxN - 1).concat(separate.slice(maxN - 1).join(separator)).map((line) => line.trim());
    if (out.every((line) => line.length <= limit)) return out;
  }
  const bubbles = Math.max(1, Math.min(maxN, Math.ceil(raw.length / Math.max(24, limit * 0.9))));
  if (raw.length <= limit) return [raw];
  const sentences = raw.match(/[^。！？!?～~…\n]+[。！？!?～~…\n]*/g) || [raw];
  const parts = sentences.map((p) => p.trim()).filter(Boolean);
  if (bubbles === 1) return [raw.length > limit ? raw.slice(0, Math.max(1, limit - 1)).trimEnd() + '…' : raw];
  const perBubble = Math.ceil(Math.min(raw.length, limit * bubbles) / bubbles);
  const out = [];
  let cur = '';
  for (const p of parts) {
    if (!cur) cur = p;
    else if ((cur + p).length <= perBubble || out.length === bubbles - 1) cur += p;
    else { out.push(cur); cur = p; }
    if (out.length === bubbles - 1 && cur.length > perBubble * 1.5) break;
  }
  if (cur) out.push(cur);
  return out.slice(0, bubbles).map((b) => {
    const hard = Math.max(1, Math.ceil(Math.min(raw.length, limit * bubbles) / bubbles) + 8);
    return b.length > hard ? b.slice(0, hard - 1).trimEnd() + '…' : b;
  });
}

module.exports = { aliasList, cleanIncomingForPersona, splitBubbles, isListReply, LIST_REPLY_CAP };
