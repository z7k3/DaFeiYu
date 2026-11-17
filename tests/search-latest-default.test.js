'use strict';

// 资料冲突时默认取最新直接回答——像天气默认报现在，而不是翻昨天的。
// 2026-11-17 实见：Falcons 阵容多来源混杂多套名单，她回"对不上号"而不是给最新阵容。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const promptSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'persona', 'prompt.js'), 'utf8');

test('webSearchContext：来源冲突时默认采用时间最新的版本直接回答', () => {
  assert.match(promptSrc, /默认采用时间最新的那个直接回答/, '规则文本要存在');
  assert.match(promptSrc, /来源之间的差异不用罗列/, '不要求罗列各来源差异');
  assert.match(promptSrc, /对方明确问历史时才提旧版本/, '问历史才提旧版');
  // 上游另有「实在对不上号就确认一句」的兜底规则——与本规则互补：
  // 默认先给最新；真冲突到无法确认时才用确认话术。两者都要在。
  assert.match(promptSrc, /实在对不上号，就用自己的话确认一句/);
});
