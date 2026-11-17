'use strict';

/**
 * 回归：「状态播报」权重太高，她句句「我刚泡完脚，手还湿着呢」，人机感重。
 * 规则：时间照给；「在干嘛」按小时抽样，只当背景，并明确要求不要说出来。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../src/infra/config');
const { assemblePrompt } = require('./support/prompt');

function makeConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-status-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({}));
  const config = loadConfig({ root, env: {} });
  return { config, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }) };
}

const msg = (extra = {}) => ({
  platform: 'wechat',
  chatId: 'wxid_status_self',
  chatType: 'private',
  senderId: 'wxid_status_self',
  senderName: 'Banan',
  text: '在吗',
  isMaster: false,
  ...extra,
});

// 心情/「此刻在干嘛」在尾部，时间和场景在 system：断言拼装后的全文
function promptAt(config, date) {
  return assemblePrompt({ config, msg: msg({ ts: date.getTime() }), profile: {}, notes: [], now: date }).prompt;
}

test('提示词不鼓励虚构生活状态', () => {
  const { config, cleanup } = makeConfig();
  const sys = promptAt(config, new Date());
  assert.match(sys, /不硬塞口癖、角色主题或虚构的生活状态/);
  cleanup();
});

test('不再要求她把心情说出来', () => {
  const { config, cleanup } = makeConfig();
  const sys = promptAt(config, new Date());
  assert.doesNotMatch(sys, /今天的心情：/, '心情不应该被当成一句话说出来');
  assert.doesNotMatch(sys, /语气底子/);
  cleanup();
});

test('所有小时均不注入随机生活背景', () => {
  const { config, cleanup } = makeConfig();
  let shown = 0;
  for (let h = 0; h < 24; h += 1) {
    const date = new Date(2026, 9, 26, h, 30, 0);
    const sys = promptAt(config, date);
    if (sys.includes('你大概')) {
      shown += 1;
      assert.match(sys, /不要主动说出来/, '给了背景也必须要求她别说出来');
    } else {
      assert.match(sys, /不用说自己正在干什么/);
    }
  }
  assert.equal(shown, 0);
  cleanup();
});

test('保留当前日期但不再给模型注入消息具体时刻', () => {
  const { config, cleanup } = makeConfig();
  const sys = promptAt(config, new Date(2026, 9, 26, 15, 42, 0));
  assert.match(sys, /2026年10月26日/, '当前日期仍然可用');
  assert.doesNotMatch(sys, /15:42/, '消息时间不注入模型正文');
  cleanup();
});
