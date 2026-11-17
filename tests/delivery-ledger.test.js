'use strict';

/**
 * 送达失败记账的回归测试（H2/M2/L3）。
 *
 * 背景：本地桥接从 webhook 响应拿走回复后自行发送；发送失败（send_text 四层通道
 * 全挂 / 草稿隔离暂停 / 会话静默）或被 rate_guard 丢弃时，内核毫不知情——
 * gateway.send 对 local 恒返回 {ok:true,dryRun:true,local:true}，动作账本永远记不到
 * 「她说过了但没送到」。而提示词明确让她「发没发出去只看【最近做过的事】的记录」，
 * 于是用户会看到「她说发了但我没收到」这种口径打架。
 *
 * 修复：桥接在丢弃回复时回报 /api/bridge/delivery-failed，内核记入动作账本。
 * 这里锁三件事：
 *   1. 内核路由：token 校验、记账内容（条数/原因/status）、坏输入不炸；
 *   2. 桥接侧源级断言：rate_guard 丢弃与发送失败两处必须回报（防合并丢失）；
 *   3. 路由必须存在（防合并丢失）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startServer } = require('../server');

function tempRoot({ config = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-delivery-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ watchConfig: false, ...config }));
  return root;
}

async function post(base, url, headers, payload) {
  const res = await fetch(base + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

test('送达失败回执：token 校验 + 记账 + 坏输入不炸', async (t) => {
  const root = tempRoot({ config: { gateway: { wechat: { enabled: true, inboundToken: 'tok-delivery-1' } } } });
  const instance = await startServer({ root, env: { WHALE_LOG_FILE: '' }, port: 0, host: '127.0.0.1' });
  try {
    const base = `http://127.0.0.1:${instance.port}`;
    // token 不对 → 403
    const bad = await post(base, '/api/bridge/delivery-failed', { 'x-bot-token': 'wrong' },
      { chatId: 'wxid_x', chatType: 'private', bubbles: 2, reason: 'send_failed' });
    assert.equal(bad.status, 403, 'token 不对必须 403');

    // 正常回执 → 记 send/failed 账
    const ok = await post(base, '/api/bridge/delivery-failed', { 'x-bot-token': 'tok-delivery-1' },
      { chatId: 'wxid_x', chatType: 'private', bubbles: 2, reason: 'send_failed' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.recorded, true);
    const key = instance.runtime.bot.sessionKey({ platform: 'wechat', chatType: 'private', chatId: 'wxid_x' });
    const hit = instance.runtime.bot.store.events(key).find((e) => e.type === 'send' && e.status === 'failed');
    assert.ok(hit, '动作账本必须出现 send/failed 事件');
    assert.match(hit.detail, /2 条回复未送达/, '账本要记下条数（正文不回传，隐私不进账本）');
    assert.match(hit.detail, /send_failed/, '账本要记下原因');

    // rate_limited → blocked（M2/L3：静默限流丢弃也能对上口径）
    const ok2 = await post(base, '/api/bridge/delivery-failed', { 'x-bot-token': 'tok-delivery-1' },
      { chatId: 'group777@chatroom', chatType: 'group', bubbles: 1, reason: 'rate_limited' });
    assert.equal(ok2.body.recorded, true);
    const gkey = instance.runtime.bot.sessionKey({ platform: 'wechat', chatType: 'group', chatId: 'group777@chatroom' });
    const hit2 = instance.runtime.bot.store.events(gkey).find((e) => e.type === 'send' && e.status === 'blocked');
    assert.ok(hit2, '限流丢弃要记 send/blocked 账');

    // 缺 chatId / 缺 bot → 不炸，recorded:false
    const missing = await post(base, '/api/bridge/delivery-failed', { 'x-bot-token': 'tok-delivery-1' },
      { chatType: 'private' });
    assert.equal(missing.status, 200);
    assert.equal(missing.body.recorded, false);
  } finally {
    await instance.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  }
});

test('源级断言：桥接两处丢弃路径必须回报，路由必须存在（防合并丢失）', () => {
  const receiver = fs.readFileSync(path.join(__dirname, '..', 'bridge', 'receiver_mixin.py'), 'utf8');
  assert.match(receiver, /def report_delivery_failure/, '桥接要有送达失败回执函数');
  assert.match(receiver, /report_delivery_failure\(username, len\(bubbles\), 'rate_limited'\)/,
    'rate_guard 丢弃回复时必须回报（L3/M2）');
  assert.match(receiver, /report_delivery_failure\(username, remaining, 'send_failed'\)/,
    'send_text 失败放弃剩余气泡时必须回报（H2）');

  const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'http', 'routes', 'bridge.js'), 'utf8');
  assert.match(routes, /\/api\/bridge\/delivery-failed/, '内核必须提供送达失败回执路由');
  assert.match(routes, /verifyToken\(req, body\)/, '回执路由必须过桥接 token 校验');
});
