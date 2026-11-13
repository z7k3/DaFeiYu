'use strict';

const crypto = require('node:crypto');

/**
 * 恒定时间字符串比较：避免靠响应时间猜 token。
 *
 * 放在 infra 而不是 http/security：适配层 gateway 也要用它比较网关 token，
 * 而分层规则不允许 adapters → http（tests/layers.test.js 会拦）。
 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a), 'utf8');
  const bb = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (ba.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

module.exports = { safeEqual };
