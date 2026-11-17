'use strict';

// 自动复用密钥只适用于已知官方同源接口；中转地址必须由用户手动指定能力。
function officialChat(baseUrl) {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    const path = u.pathname.replace(/\/+$/, '');
    if (u.hostname === 'api.deepseek.com' && ['', '/v1'].includes(path)) return { provider: 'deepseek', origin: u.origin };
    const qwen = ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'].includes(u.hostname)
      || /^[a-z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(u.hostname);
    if (qwen && path === '/compatible-mode/v1') return { provider: 'qwen', origin: u.origin };
  } catch { /* 无法确认来源时不自动搬运凭据。 */ }
  return null;
}

function followVoice(rt) {
  const official = officialChat(rt.baseUrl);
  if (!official || rt.provider !== official.provider) return { supported: false, provider: 'follow', baseUrl: '', model: '', apiKey: '', hint: '当前聊天接口尚未适配语音识别，请手动选择语音服务并填写对应 Key。' };
  return { supported: true, provider: official.provider === 'qwen' ? 'dashscope' : 'deepseek',
    baseUrl: official.origin + (official.provider === 'qwen' ? '/api/v1/services/aigc/multimodal-generation/generation' : '/v1/tools/asr'),
    model: official.provider === 'qwen' ? 'qwen3-asr-flash' : '', apiKey: rt.apiKey,
    hint: official.provider === 'qwen' ? '跟随聊天配置：千问 qwen3-asr-flash，复用聊天 Key。' : '跟随聊天配置：DeepSeek 语音识别，复用聊天 Key。' };
}

function followSearch(rt, websearch = {}) {
  const official = officialChat(rt.baseUrl);
  if (!official || rt.provider !== official.provider) return { ...websearch, api: { ...websearch.api, providers: [] }, followHint: '当前接口尚未适配搜索 API；使用聊天模型判断是否联网，再走本地 Bing/360，也可关闭跟随后手动指定搜索服务。' };
  const provider = official.provider;
  return { ...websearch, api: { ...websearch.api, providers: [provider] },
    [provider]: { apiKey: rt.apiKey, model: rt.model, baseUrl: official.origin },
    followHint: `搜索自动跟随 ${provider === 'qwen' ? '千问' : 'DeepSeek'}，复用聊天 Key；失败回退本地搜索。` };
}

module.exports = { officialChat, followVoice, followSearch };
