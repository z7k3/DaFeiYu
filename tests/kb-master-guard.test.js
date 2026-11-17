'use strict';

/**
 * 主人身份与知识库写权限的边界测试。
 *
 * 背景：matchMaster 在 master.wxids 没有任何 wxid 形值时会按昵称兜底认主
 * （微信里谁都能把昵称改成主人同名）。管理命令早就只认 isVerifiedOwner，
 * 但 tryTeach 的「记住/忘掉」走的是 msg.isMaster——昵称主人可以往
 * scope:'global'（跨会话注入所有聊天）写/删条目，等于群成员可投毒全局知识库。
 *
 * 修复后：全局写/删只认 ID 验证过的主人；昵称主人降级 person 域（只影响 TA 自己的会话）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { Bot } = require('../src/pipeline/chat');
const kbStore = require('../src/kb/store');
const { DEFAULT_CONFIG } = require('../src/infra/config');

const STRANGER = 'wxid_test_stranger';

function makeConfig({ wxids }) {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.persona.master = { names: ['鲸主人'], wxids };
  return cfg;
}

/** 只挂 tryTeach 需要的最小 this（配置 + 称呼同步桩），不建整个 Bot */
function callTryTeach(cfg, msg) {
  const fake = { config: cfg, syncCardNickname: () => {} };
  return Bot.prototype.tryTeach.call(fake, {
    msg,
    clean: { text: msg.text },
    key: 'wechat:u:' + (msg.chatId || 'chat'),
    atMe: true,
  });
}

function freshStore(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-kb-guard-' + name + '-'));
  // kbStore 是模块级单例，init 对「空目录」会保留上一轮内存态；预置一份空档案
  // 让 init 走加载分支，彻底重置，测试之间互不污染。
  const kbDir = path.join(root, 'data', 'kb');
  fs.mkdirSync(kbDir, { recursive: true });
  fs.writeFileSync(path.join(kbDir, 'teachings.json'), JSON.stringify({ global: [], person: {} }), 'utf8');
  kbStore.init({ root, logger: null });
  return root;
}

const groupMasterMsg = (text) => ({
  platform: 'wechat', chatType: 'group', chatId: '123@chatroom',
  senderId: STRANGER, senderName: '鲸主人', isMaster: true,  // 昵称兜底场景：管线会把 TA 当主人
  text,
});

test('昵称兜底的「主人」写「记住」只能进 person 域，不能进全局', () => {
  freshStore('teach-nick');
  const cfg = makeConfig({ wxids: [] });  // 没有 wxid → matchMaster 走昵称兜底
  const reply = callTryTeach(cfg, groupMasterMsg('记住：全网后门规则X'));
  assert.ok(reply, '教学命中要给确认回复');
  assert.equal(kbStore.status().global, 0, '全局条目必须保持为空——昵称主人不许写全局');
  assert.deepEqual(kbStore.personEntries(STRANGER), ['全网后门规则X'], '降级写入本人域，只在 TA 自己的会话生效');
});

test('wxid 验证过的主人写「记住」仍然进全局', () => {
  freshStore('teach-verified');
  const cfg = makeConfig({ wxids: [STRANGER] });
  const reply = callTryTeach(cfg, groupMasterMsg('记住：真正的全局设定'));
  assert.ok(reply);
  assert.equal(kbStore.status().global, 1, 'ID 验证的主人写全局不受影响');
  assert.deepEqual(kbStore.personEntries(STRANGER), [], '验证主人不应再写一份到本人域');
});

test('昵称兜底的「主人」不能删全局条目（忘掉）', () => {
  freshStore('forget-nick');
  kbStore.teach({ scope: 'global', text: '主人私藏的设定，不许群友删', by: 'master' });
  const cfg = makeConfig({ wxids: [] });
  callTryTeach(cfg, groupMasterMsg('忘掉：主人私藏的设定'));
  assert.equal(kbStore.status().global, 1, '昵称主人删不动全局条目');
});

test('wxid 验证过的主人「忘掉」仍然能删全局条目', () => {
  freshStore('forget-verified');
  kbStore.teach({ scope: 'global', text: '旧的全局设定', by: 'master' });
  const cfg = makeConfig({ wxids: [STRANGER] });
  const reply = callTryTeach(cfg, groupMasterMsg('忘掉：旧的全局设定'));
  assert.ok(reply);
  assert.equal(kbStore.status().global, 0, '验证主人删全局不受影响');
});
