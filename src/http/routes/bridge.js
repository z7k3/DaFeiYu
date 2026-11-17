'use strict';

const { json, readBody } = require('../util');
const { tagId } = require('../../infra/privacy');

module.exports = function register(router) {
  // 桥接心跳：让状态接口知道「桥接在不在、UIA 通不通」。没这个，服务端只能看到
  // 「我收到了消息」，根本不知道回复有没有可能发出去。
  router.post('/api/bridge/heartbeat', async (runtime, req, res) => {
    const hb = await readBody(req);
    const platform = String((hb && hb.platform) || 'wechat').toLowerCase();
    const gw = runtime.gateways.get(platform);
    if (!gw) return json(res, 404, { ok: false, error: `未知平台 ${platform}` });
    if (!gw.verifyToken(req, hb)) return json(res, 403, { ok: false, error: 'token 不对' });
    return json(res, 200, gw.heartbeat(hb));
  });

  // 桥接送达失败回执：本地桥接从 webhook 响应里拿走回复后自行发送，发送失败或被
  // 限流丢弃时内核毫不知情——gateway.send 对 local 恒返回 {ok:true,dryRun:true}，
  // 动作账本永远记不到「她说过了但没送到」，模型下一轮会以为已经回过话（提示词正是
  // 让她按账本口径回答的）。桥接在这里回报，内核记入账本；正文不回传，只记条数和原因。
  router.post('/api/bridge/delivery-failed', async (runtime, req, res) => {
    const body = await readBody(req);
    const platform = String((body && body.platform) || 'wechat').toLowerCase();
    const gw = runtime.gateways.get(platform);
    if (!gw) return json(res, 404, { ok: false, error: `未知平台 ${platform}` });
    if (!gw.verifyToken(req, body)) return json(res, 403, { ok: false, error: 'token 不对' });
    const bot = runtime.bot;
    const chatId = typeof (body && body.chatId) === 'string' ? body.chatId.trim() : '';
    if (!chatId || !bot || typeof bot.sessionKey !== 'function') {
      return json(res, 200, { ok: true, recorded: false });
    }
    const chatType = body && body.chatType === 'group' ? 'group' : 'private';
    const reason = String((body && body.reason) || 'send_failed').slice(0, 40);
    const bubbles = Math.max(1, Math.min(99, Number(body && body.bubbles) || 1));
    try {
      const key = bot.sessionKey({ platform, chatType, chatId });
      bot.store.appendEvent(key, {
        type: 'send',
        detail: `${bubbles} 条回复未送达（${reason}）`,
        status: reason === 'rate_limited' ? 'blocked' : 'failed',
      });
      runtime.logger.info(`[delivery] 桥接回报未送达：${tagId(chatId)}（${reason}，${bubbles} 条），已记账`);
    } catch (err) {
      runtime.logger.warn('[delivery] 送达失败记账未写入：' + ((err && err.message) || err));
      return json(res, 200, { ok: true, recorded: false });
    }
    return json(res, 200, { ok: true, recorded: true });
  });

  // 网关入口：POST /webhook/{platform}（当前只有 wechat）
  router.pattern(/^\/webhook\/([a-zA-Z]+)$/, async (runtime, req, res, info) => {
    const { params, method, url } = info;
    const platform = params[0].toLowerCase();
    const gateway = runtime.gateways.get(platform);
    if (!gateway) return json(res, 404, { ok: false, error: `未知平台 ${platform}` });

    if (method === 'GET') {
      if (!gateway.verifyToken(req, null)) return json(res, 403, { ok: false, error: 'token 不对' });
      const challenge = url.searchParams.get('challenge') || url.searchParams.get('echostr');
      if (challenge) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(challenge);
      }
      return json(res, 200, gateway.status());
    }
    if (method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });

    const body = await readBody(req);
    if (!gateway.verifyToken(req, body)) {
      runtime.logger.warn(`[${platform}] webhook token 校验失败`);
      return json(res, 403, { ok: false, error: 'token 不对' });
    }
    if (!gateway.options.enabled) {
      return json(res, 200, { ok: true, skipped: 'adapter_disabled' });
    }
    // 本地桥接会带 x-whale-bridge: 1（或 body.local=true）。它靠 HTTP 响应拿回复，
    // 所以「没配 outboundUrl」对它是正常的，不该按「发不出去」报警。
    const isLocalBridge = String(req.headers['x-whale-bridge'] || '') === '1' || Boolean(body && body.local);
    const result = await gateway.handleInbound(body, { local: isLocalBridge });
    return json(res, 200, result);
  });
};
