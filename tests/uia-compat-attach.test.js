'use strict';
// uia_compat 补丁装配完整性：工厂里定义且经 self.X() 调用的方法，必须出现在
// cls.X = 装配清单里。2026-11-14 实见上游 4.1.3 漏挂 _chat_page_visible，
// ensure_chat_page 一走过早退分支就 AttributeError，发送流程退化成前台重试风暴。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'examples', 'uia_compat.py'), 'utf8');

test('uia_compat：定义且以 self. 调用的补丁方法必须全部挂到驱动类上', () => {
  const defined = new Set([...src.matchAll(/^ {4}def (_\w+)\(self[,)]/gm)].map(m => m[1]));
  const attached = new Set([...src.matchAll(/^ {4}cls\.(\w+)\s*=/gm)].map(m => m[1]));
  const called = new Set([...src.matchAll(/self\.(_\w+)\(/g)].map(m => m[1]));
  const missing = [...called].filter(n => defined.has(n) && !attached.has(n));
  assert.deepEqual(missing, [], '漏挂的方法：' + missing.join(', '));
});
