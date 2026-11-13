'use strict';

/**
 * 会话状态的唯一读写入口：静默 / 禁言 / 接话窗口。
 *
 * 这些字段以前在 trigger、chat、canned 里分别手写，写入时机不同，
 * 于是出现「被静音的消息还续了接话窗口」「退场后一个问号就能解除」。
 * 这里不做策略判断，只保证时间语义和边界一致。
 */

function nowMsOf(value, fallback = Date.now()) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isSilent(state, nowMs) {
  return Number(state && state.silentUntil) > nowMsOf(nowMs);
}

function isMuted(state, nowMs) {
  return Number(state && state.mutedUntil) > nowMsOf(nowMs);
}

function engagedWith(state, senderId, nowMs) {
  return Boolean(
    state
    && Number(state.engagedUntil) > nowMsOf(nowMs)
    && String(state.engagedBy || '') === String(senderId || ''),
  );
}

function touchEngagement(state, senderId, nowMs, minutes) {
  if (!state) return 0;
  const mins = Math.max(1, Number(minutes) || 6);
  state.engagedUntil = nowMsOf(nowMs) + mins * 60000;
  state.engagedBy = String(senderId || '');
  return state.engagedUntil;
}

function clearEngagement(state) {
  if (!state) return;
  state.engagedUntil = 0;
  state.engagedBy = '';
}

function clearSilent(state) {
  if (state) state.silentUntil = 0;
}

/**
 * 「正在对话」集合：engagedMinutes 内和她说过话的人都算在窗口内。
 *
 * 单值 engagedBy 只记得最后一个人：甲 @ 她聊完、乙紧接着问她一句（没 @）
 * 会被当成旁听漏答。这里按人记录时间戳，两人同时对话都能接住。
 */
function engagedSetHas(state, senderId, nowMs) {
  const set = state && state.engagedSet;
  if (!set) return false;
  const ts = Number(set[String(senderId || '')] || 0);
  if (!ts) return false;
  const win = Math.max(1, Number((state && state.engagedMinutes) || 6)) * 60000;
  return nowMsOf(nowMs) - ts <= win;
}

function touchEngagedSet(state, senderId, nowMs, minutes) {
  if (!state) return;
  const mins = Math.max(1, Number(minutes) || 6);
  const set = state.engagedSet || (state.engagedSet = {});
  const now = nowMsOf(nowMs);
  set[String(senderId || '')] = now;
  // 顺手清理过期条目，避免 meta.json 里长期堆积死键
  for (const [uid, ts] of Object.entries(set)) {
    if (now - Number(ts) > mins * 60000) delete set[uid];
  }
}

module.exports = {
  isSilent,
  isMuted,
  engagedWith,
  engagedSetHas,
  touchEngagedSet,
  touchEngagement,
  clearEngagement,
  clearSilent,
};
