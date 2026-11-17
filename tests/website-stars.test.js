'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../website/site.js'), 'utf8');
const script = source.slice(0, source.indexOf('  const root =')) + '})();';

async function run(response, error) {
  const count = { textContent: '☆ 123' };
  const link = { title: '部署快照', querySelector: () => count, setAttribute(name, value) { this[name] = value; } };
  let calls = 0;
  vm.runInNewContext(script, {
    document: { querySelectorAll: () => [link] }, Intl, AbortSignal,
    fetch: async (url, options) => {
      calls += 1;
      assert.equal(url, 'https://api.github.com/repos/Banan1cee/whale_girl');
      assert.equal(options.credentials, 'omit');
      assert.ok(options.signal);
      if (error) throw error;
      return response;
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  return { count, link };
}

async function main() {
  const result = await run({ ok: true, json: async () => ({ stargazers_count: 5678 }) });
  assert.equal(result.count.textContent, '☆ 5,678');
  assert.equal(result.link['aria-label'], 'GitHub · 5,678 Stars');
  const zero = await run({ ok: true, json: async () => ({ stargazers_count: 0 }) });
  assert.equal(zero.count.textContent, '☆ 0');
  for (const value of [-1, '99', null, 1.5]) {
    const invalid = await run({ ok: true, json: async () => ({ stargazers_count: value }) });
    assert.equal(invalid.count.textContent, '☆ 123');
  }
  for (const [response, error] of [[{ ok: false }, null], [null, new Error('offline')], [{ ok: true, json: async () => { throw new Error('invalid JSON'); } }, null]]) {
    const fallback = await run(response, error);
    assert.equal(fallback.count.textContent, '☆ 123');
    assert.equal(fallback.link.title, '部署快照');
  }
  console.log('website stars: live count, zero, invalid data and network fallback passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
