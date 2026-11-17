'use strict';

// 只转换数据，不回滚旧提示词实现，也不在读取时改写用户文件。
function upgradeLegacyPersona(data = {}) {
  if (data.legacyPersonaVersion === 1) return { ...data };
  const lines = [];
  const preset = typeof data.preset === 'string' ? data.preset.trim() : '';
  const text = typeof data.text === 'string' ? data.text.trim() : '';
  if (preset) lines.push('整体语气：' + preset);
  if (text) lines.push('具体要求：' + text);
  if (data.emotions === false) lines.push('保持情绪稳定，不主动撒娇、闹别扭或随机切换心情。');
  const prompt = typeof data.customPrompt === 'string' ? data.customPrompt : '';
  return { ...data, ...(lines.length || Object.hasOwn(data, 'customPrompt') ? {
    customPrompt: [prompt, lines.length ? '【旧版表达设置】\n' + lines.join('\n') : ''].filter(Boolean).join('\n\n') } : {}),
    legacyPersonaVersion: 1 };
}

function legacyPatch(body, currentPrompt = '') {
  if (!['preset', 'text', 'emotions'].some(key => Object.hasOwn(body, key))) return {};
  // 旧接口重复保存不能把已转换的表达段无限追加；只替换兼容层生成的末尾段。
  const base = String(body.customPrompt ?? currentPrompt).replace(/(?:\n\n)?【旧版表达设置】\n[\s\S]*$/, '');
  const data = upgradeLegacyPersona({ ...body, legacyPersonaVersion: undefined, customPrompt: base });
  return { customPrompt: data.customPrompt, legacyPersonaVersion: 1,
    ...Object.fromEntries(['preset', 'text', 'emotions'].filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]])) };
}

module.exports = { upgradeLegacyPersona, legacyPatch };
