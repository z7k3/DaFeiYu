'use strict';

/**
 * webhook 读超时的回归测试（M1）。
 *
 * 背景：桥接 POST /webhook/wechat 用的是 timeout=(10, None)——读方向永不超时。
 * 内核事件循环一旦卡死（同步 IO / 磁盘挂起），该会话 worker 永久阻塞占死，
 * 会话停摆到重启桥接；心跳是独立线程，状态页还显示「在线」，极难排查。
 * 修复：读超时上限 WEBHOOK_READ_TIMEOUT（240s，覆盖内核侧 LLM ≤120s 硬顶 +
 * 检索/关怀路由等短调用），超时放弃本轮并记节流日志。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const engine = fs.readFileSync(path.join(__dirname, '..', 'bridge', 'engine.py'), 'utf8');
const receiver = fs.readFileSync(path.join(__dirname, '..', 'bridge', 'receiver_mixin.py'), 'utf8');

test('engine 定义 WEBHOOK_READ_TIMEOUT，webhook 调用必须带上读超时', () => {
  assert.match(engine, /WEBHOOK_READ_TIMEOUT\s*=\s*240/, 'engine 要定义 240s 读超时上限');
  assert.match(receiver, /timeout=\(10,\s*G\.WEBHOOK_READ_TIMEOUT\)/,
    'webhook 请求必须带读超时——不能回到 (10, None) 的无限等待');
  assert.ok(!receiver.includes('timeout=(10, None)'), '不允许残留无限读超时');
});

test('读超时要有独立的节流日志分支（能回答「为什么这条没回」）', () => {
  assert.match(receiver, /webhook-read-timeout/, '超时原因要有专属节流日志 key');
  assert.match(receiver, /ReadTimeout/, 'requests 超时异常要单独识别');
});
