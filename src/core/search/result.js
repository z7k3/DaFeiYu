'use strict';

function result(items = [], { reason = '', attempts = [], staleItems = [], elapsedMs = 0, status, answer = '' } = {}) {
  const value = { status: status || (items.length ? 'ok' : attempts.some(a => a.status === 'failed') && !attempts.some(a => a.status === 'ok' || a.status === 'empty') ? 'failed' : 'empty'),
    reason: reason || (items.length ? 'available' : staleItems.length ? 'stale_only' : 'no_results'),
    items, staleItems, attempts, elapsedMs };
  if (String(answer || '').trim()) value.answer = String(answer).trim();
  return value;
}

function formatResult(value, { maxChars = 1400 } = {}) {
  if (!value || value.status !== 'ok') return '';
  let text = '';
  const answer = String(value.answer || '').trim();
  if (answer) {
    const answerBudget = Math.min(1200, Math.floor(maxChars * 0.35));
    text = `搜索接口摘要（下方附来源材料）\n${answer.slice(0, answerBudget)}\n\n`;
  }
  for (const [index, item] of value.items.entries()) {
    const meta = [item.provider, item.publishedAt ? `发布时间：${item.publishedAt}` : '发布时间未确认',
      item.fetchedAt ? `获取时间：${item.fetchedAt}` : ''].filter(Boolean).join('；');
    const head = `${index + 1}. ${String(item.title || '（无标题）').slice(0, 120)}\n${meta}\n${item.url || ''}\n`;
    const available = maxChars - text.length - head.length - 2;
    if (available < 0) break;
    const snippet = String(item.rawContent || item.snippet || '').slice(0, available);
    text += head + snippet + '\n\n';
  }
  return text.trim();
}

module.exports = { result, formatResult };
