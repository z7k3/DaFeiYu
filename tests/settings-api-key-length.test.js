'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../server');

test('自定义聊天和看图 Key 接受短值，最多 250 字符，拒绝超长且不截断', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-key-length-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ server: { port: 0, openBrowser: false } }));
  const app = await startServer({ root: dir, env: {}, port: 0, openBrowser: false });
  try {
    const post = body => fetch(app.url + '/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    for (const field of ['apiKey', 'visionApiKey']) {
      for (const value of ['magpie', 'x', 'k'.repeat(250)]) {
        const response = await post({ provider: 'custom', [field]: value });
        assert.equal(response.status, 200, `${field} 应接受 ${value.length} 字符`);
        const saved = JSON.parse(fs.readFileSync(path.join(dir, 'data/settings.json'), 'utf8'));
        assert.equal(saved[field], value);
      }
      const response = await post({ [field]: 'k'.repeat(251) });
      assert.equal(response.status, 400, `${field} 应拒绝超过 250 字符`);
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'data/settings.json'), 'utf8'));
      assert.equal(saved[field], 'k'.repeat(250), '拒绝时保留旧值，不截断新值');
    }
    assert.equal((await post({ apiKey: '' })).status, 200, '保留无 Key 本地服务的支持');
    // 粘贴时带进的空格/换行仍要拒绝：那会让请求头失效，但跟最小长度无关。
    assert.equal((await post({ apiKey: 'bad key with spaces' })).status, 400, '不能包含空格');
    for (const field of ['deepseek.apiKey', 'vision.apiKey', 'voice.apiKey', 'websearch.deepseek.apiKey', 'websearch.zhihu.accessSecret']) {
      for (const length of [1, 6, 250, 251]) {
        const response = await fetch(app.url + '/api/config', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ patch: { [field]: 'k'.repeat(length) } }),
        });
        assert.equal(response.status, length <= 250 ? 200 : 400, `${field} 统一校验 ${length} 字符`);
      }
    }
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  }
});
