'use strict';

/**
 * 知识库（v1）：主人/群友「教」的条目 + 自喂文档，给聊天管线提供可靠的长期知识。
 *
 * 和自动记忆（data/memory 的人物卡/事件/episode）的分工：
 *   自动记忆 = 模型自动抽取、滚动、会衰减、聊天范围内；
 *   知识库   = 主人手动校准、永久、跨会话全局生效；冲突时以知识库为准。
 *
 * 检索用 BM25（中文二元分词 + 拉丁词），纯 JS 零依赖：个人知识库几百到几千个
 * 片段完全够用，对歌名/人名/梗名这类精确词反而比向量检索更准。查询 <1ms，
 * 所以每条消息都检索、分数不够就不注入，没有网络成本。
 *
 * 写入权限在管线层控制（主人 → global；群友 → 只能写自己的 person 条目），
 * 这一层只管存取、配额和去重。
 */

const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic, readJson } = require('../infra/jsonFile');

const DOCS_DIRNAME = 'docs';
const TEACH_FILE = 'teachings.json';

// 配额：防群聊灌水与提示词注入攻击的硬闸
const LIMITS = {
  personPerUser: 20,     // 每个群友最多教多少条
  globalTotal: 200,      // 全局条目上限（只有主人能写）
  personTextMax: 200,    // 单条群友条目字数上限（防大段注入）
  globalTextMax: 300,    // 单条全局条目字数上限
  docFileMax: 500000,    // 单个文档字数上限
};

// BM25 参数（标准取值）
const BM25 = { k1: 1.5, b: 0.75 };

/* ------------------------------ 分词 ------------------------------ */

// 中文按二元组切（「绝绝子」→ 绝绝/绝子），拉丁/数字按整词；和 quality.js 的思路一致，
// 但这里服务于检索召回，所以保留长度 1 的拉丁词（型号/版本号里常见）。
function tokenize(text) {
  const s = String(text || '').toLowerCase()
    // 书名号/引号/逗号等标点先剥掉：「这，就是爱」是张杰 → 这就是爱是张杰，
    // 否则「这就是爱」和「就是爱」的二元组对不上，检索就漏。
    .replace(/[^\u4e00-\u9fa5a-z0-9]+/g, ' ');
  const out = [];
  for (const w of s.match(/[a-z0-9][a-z0-9+._-]*/g) || []) out.push(w);
  for (const run of s.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    if (run.length <= 4) out.push(run);
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out.filter(Boolean);
}

/* ------------------------------ 状态 ------------------------------ */

const state = {
  root: '',
  logger: null,
  teachings: { global: [], person: {} },
  docs: [],
  docsSig: '',
  docsDir: '',
  avgLen: 1,
};

/* ------------------------------ 文档加载与分块 ------------------------------ */

function docsDir() {
  return path.join(state.root, 'data', 'kb', DOCS_DIRNAME);
}

function docsSignature() {
  try {
    const entries = fs.readdirSync(docsDir(), { withFileTypes: true })
      .filter(e => e.isFile() && /\.(txt|md)$/i.test(e.name));
    // Dirent 没有 mtimeMs/size（实测 undefined）——签名会退化成「文件名集合」，
    // 改文件内容不触发重载。必须 statSync 才能感知内容变更。
    return entries.map(e => {
      let sig = e.name;
      try { const st = fs.statSync(path.join(docsDir(), e.name)); sig += ':' + st.mtimeMs + ':' + st.size; } catch { /* 删了就算了 */ }
      return sig;
    }).join('|');
  } catch {
    return '';
  }
}

/** 按空行和长度切粗段，再合并到 ≤600 字的块（带「来自 file#n」的出处标题）。 */
function chunkText(name, raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n').trim();
  if (!text) return [];
  const rough = text.split(/\n(?:\s*\n)+/).map(s => s.trim()).filter(Boolean);
  const segments = [];
  for (const seg of rough) {
    if (seg.length <= 600) { segments.push(seg); continue; }
    // 长段按句子边界二次切
    let cur = '';
    for (const sentence of seg.split(/(?<=[。！？!?；;])/)) {
      if ((cur + sentence).length > 600 && cur) { segments.push(cur); cur = sentence; }
      else cur += sentence;
    }
    if (cur.trim()) segments.push(cur.trim());
  }
  const chunks = [];
  let cur = '';
  const flush = () => {
    cur = cur.trim();
    if (cur.length < 8) return;
    chunks.push({ id: name + '#' + (chunks.length + 1), title: name + ' 第' + (chunks.length + 1) + '段', text: cur, name });
  };
  for (const seg of segments) {
    if ((cur + '\n' + seg).length > 600 && cur) flush();
    cur = cur ? cur + '\n' + seg : seg;
  }
  flush();
  return chunks.map(c => Object.assign(c, { terms: tokenize(c.title + ' ' + c.text) }));
}

function indexDocs() {
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(docsDir(), { withFileTypes: true }).filter(e => e.isFile() && /\.(txt|md)$/i.test(e.name));
  } catch { files = []; }
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(docsDir(), f.name), 'utf8');
      if (raw.length > LIMITS.docFileMax) continue;
      out.push(...chunkText(f.name.replace(/\.(txt|md)$/i, ''), raw));
    } catch (err) {
      if (state.logger) state.logger.warn('知识库文档读取失败 ' + f.name + '：' + (err && err.message));
    }
  }
  // IDF 表：全局统计一次，查询时只做点积
  const df = new Map();
  let totalLen = 0;
  for (const c of out) {
    c.tf = new Map();
    for (const t of c.terms) c.tf.set(t, (c.tf.get(t) || 0) + 1);
    c.len = c.terms.length || 1;
    totalLen += c.len;
    for (const t of new Set(c.terms)) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = out.length || 1;
  state.docs = out.map(c => Object.assign(c, {
    idf: new Map([...c.tf.keys()].map(t => [t, Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5))])),
  }));
  state.avgLen = totalLen / N;
  return { docs: files.length, chunks: out.length };
}

/* ------------------------------ BM25 查询 ------------------------------ */

function bm25Search(chunks, query, k) {
  const qTokens = [...new Set(tokenize(query))];
  if (!qTokens.length) return [];
  const avg = state.avgLen || 1;
  const scored = [];
  for (const c of chunks) {
    if (!c.tf) continue;
    let score = 0, hits = 0;
    for (const t of qTokens) {
      const tf = c.tf.get(t) || 0;
      if (!tf) continue;
      hits += 1;
      const idf = c.idf ? (c.idf.get(t) || 0.3) : 0.3;
      score += idf * (tf * (BM25.k1 + 1)) / (tf + BM25.k1 * (1 - BM25.b + BM25.b * c.len / avg));
    }
    if (hits >= 1 && score > 0) scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score);
  // 相对阈值而非绝对阈值：个人语料很小，IDF 会塌缩（N=1 时单词条只有 log(4/3)≈0.29），
  // 绝对分数线（如 1.2）必然把正确匹配全部拒掉。改用「不低于最高分 30%」——
  // 纯泛词尾巴自动被压下去，正确的匹配也不会漏。
  const top = scored.length ? scored[0].score : 0;
  if (top <= 0) return [];
  return scored.filter(x => x.score >= top * 0.3).slice(0, k).map(x => x.c);
}

/* ------------------------------ 教学条目 ------------------------------ */

function normText(text) {
  return String(text || '').replace(/\s+/g, '').toLowerCase();
}

/** 教学写入：去重（同文本 = 更新）、配额（满了报 full）、长度硬闸。 */
function teach({ scope, uid = '', text, by = '' }) {
  const content = String(text || '').trim();
  if (!content) return { ok: false, reason: 'empty' };
  const norm = normText(content);
  if (scope === 'global') {
    if (content.length > LIMITS.globalTextMax) return { ok: false, reason: 'too_long' };
    const existing = state.teachings.global.find(e => normText(e.text) === norm);
    if (existing) { existing.text = content; existing.by = by || existing.by; existing.at = Date.now(); saveTeach(); return { ok: true, action: 'updated', entry: existing }; }
    if (state.teachings.global.length >= LIMITS.globalTotal) return { ok: false, reason: 'full' };
    const entry = { text: content, by: by || 'master', at: Date.now() };
    state.teachings.global.push(entry);
    saveTeach();
    return { ok: true, action: 'added', entry };
  }
  // person：群友只能写自己命名空间（uid 由管线传入 senderId，不可伪造）
  const key = String(uid || '').trim();
  if (!key) return { ok: false, reason: 'no_uid' };
  if (content.length > LIMITS.personTextMax) return { ok: false, reason: 'too_long' };
  const list = state.teachings.person[key] || (state.teachings.person[key] = []);
  const existing = list.find(e => normText(e.text) === norm);
  if (existing) { existing.text = content; existing.at = Date.now(); saveTeach(); return { ok: true, action: 'updated', entry: existing }; }
  if (list.length >= LIMITS.personPerUser) return { ok: false, reason: 'full' };
  const entry = { text: content, by: by || key, at: Date.now() };
  list.push(entry);
  saveTeach();
  return { ok: true, action: 'added', entry };
}

/** 删除：群友只能删自己的；匹配方式 = 子串（大小写/空白不敏感），text 空则删光本人条目。 */
function forget({ uid, text = '' }) {
  const key = String(uid || '').trim();
  if (!key) return { ok: false, removed: 0 };
  const list = state.teachings.person[key] || [];
  const norm = normText(text);
  const kept = norm ? list.filter(e => !normText(e.text).includes(norm)) : [];
  const removed = list.length - kept.length;
  if (removed) {
    if (kept.length) state.teachings.person[key] = kept;
    else delete state.teachings.person[key];
    saveTeach();
  }
  return { ok: removed > 0, removed };
}

/** 主人删除：可指定全局（按子串或序号）或某人的条目。 */
function masterForget({ scope = 'global', uid = '', index = 0, text = '' }) {
  if (scope === 'global') {
    const norm = normText(text);
    let removed = 0;
    if (norm) {
      const before = state.teachings.global.length;
      state.teachings.global = state.teachings.global.filter(e => !normText(e.text).includes(norm));
      removed = before - state.teachings.global.length;
    } else if (index > 0 && index <= state.teachings.global.length) {
      state.teachings.global.splice(index - 1, 1);
      removed = 1;
    }
    if (removed) saveTeach();
    return { ok: removed > 0, removed };
  }
  return forget({ uid, text });
}

function personEntries(uid) {
  return (state.teachings.person[String(uid || '').trim()] || []).map(e => e.text);
}

function saveTeach() {
  const file = path.join(state.root, 'data', 'kb', TEACH_FILE);
  writeJsonAtomic(file, state.teachings, { spaces: 2 });
}

/* ------------------------------ 对外 API ------------------------------ */

/** 检索：本人的条目必带（就几条），全局条目 ≤5 条全带否则 BM25 取 2，文档 BM25 取 k。 */
function query(text, { uid = '', k = 3 } = {}) {
  maybeReloadDocs();
  const q = String(text || '').trim();
  if (!q) return { person: [], global: [], docs: [] };
  const person = personEntries(uid).slice(0, 6);
  let global = [];
  if (state.teachings.global.length <= 5) global = state.teachings.global.map(e => e.text);
  else {
    const fake = state.teachings.global.map(e => Object.assign({ title: '', text: e.text }, indexTerms(e.text)));
    global = bm25Search(fake, q, 2).map(c => c.text);
  }
  const docs = bm25Search(state.docs, q, k)
    .map(c => ({ title: c.title, snippet: c.text, source: c.name }));
  return { person, global, docs };
}

function indexTerms(text) {
  const terms = tokenize(text);
  const tf = {};
  for (const t of terms) tf[t] = (tf[t] || 0) + 1;
  // tf 必须带：bm25Search 对没有 tf 的块直接跳过——不带的后果是全局条目
  // 超过 5 条后检索恒为空（主人第 6 条起的教学全部失效，且极难自查）。
  return { terms, len: terms.length || 1, tf };
}

function maybeReloadDocs() {
  const sig = docsSignature();
  if (sig !== state.docsSig) {
    state.docsSig = sig;
    const out = indexDocs();
    if (state.logger) state.logger.info('知识库文档已加载：' + out.docs + ' 个文件 / ' + out.chunks + ' 个片段');
  }
}

function init({ root, logger } = {}) {
  state.root = String(root || '');
  state.logger = logger || null;
  state.docsDir = docsDir();
  try {
    fs.mkdirSync(state.docsDir, { recursive: true });
  } catch { /* 已存在 */ }
  const file = path.join(state.root, 'data', 'kb', TEACH_FILE);
  const loaded = readJson(file, null);
  if (loaded && typeof loaded === 'object') {
    state.teachings = {
      global: Array.isArray(loaded.global) ? loaded.global : [],
      person: loaded.person && typeof loaded.person === 'object' ? loaded.person : {},
    };
  } else {
    writeJsonAtomic(file, state.teachings, { spaces: 2 });
  }
  maybeReloadDocs();
  return status();
}

function setDoc(name, text) {
  const safe = String(name || '').replace(/[\\/:*?"<>|]/g, '').trim();
  if (!safe) return { ok: false, error: 'invalid_name' };
  const body = String(text || '');
  if (!body.trim() || body.length > LIMITS.docFileMax) return { ok: false, error: 'invalid_text' };
  fs.mkdirSync(docsDir(), { recursive: true });
  fs.writeFileSync(path.join(docsDir(), safe + '.txt'), body, 'utf8');
  state.docsSig = '';
  maybeReloadDocs();
  return { ok: true, chunks: state.docs.filter(c => c.name === safe).length };
}

function removeDoc(name) {
  const safe = String(name || '').replace(/[\\/:*?"<>|]/g, '').trim();
  const file = path.join(docsDir(), safe + '.txt');
  let removed = false;
  try { fs.unlinkSync(file); removed = true; } catch { /* 不存在就算了 */ }
  state.docsSig = '';
  maybeReloadDocs();
  return { ok: removed, removed };
}

function status() {
  const personUsers = Object.keys(state.teachings.person).length;
  const personCount = Object.values(state.teachings.person).reduce((n, l) => n + l.length, 0);
  return { docs: new Set(state.docs.map(c => c.name)).size, chunks: state.docs.length,
    global: state.teachings.global.length, persons: personUsers, personEntries: personCount,
    docsDir: state.docsDir };
}

function docsReload() {
  state.docsSig = '';
  maybeReloadDocs();
  return Object.assign({ docsDir: state.docsDir }, status());
}

module.exports = { init, query, teach, forget, masterForget, personEntries, setDoc, removeDoc, docsReload, status, tokenize, chunkText, LIMITS };
