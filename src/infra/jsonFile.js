'use strict';

/**
 * 读 JSON 文件。唯一实现：以前 config / backup / chatStore / migrate 各有一份，
 * 后三份逐字节相同，config 版多一个 fallback 形参。
 *
 * 失败（文件不存在 / JSON 坏 / 无权限）一律返回 fallback，不抛：
 * 这些调用点都是「读配置 / 读记忆，没有就用默认值」，抛出去会让启动挂掉。
 */
const fs = require('node:fs');
const path = require('node:path');

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

/** 旧快照的增量日志可能因断电留下半截行；跳过坏行，但不改写原始文件。 */
function readJournal(file) {
  let raw = '';
  try {
    raw = fs.readFileSync(file + '.journal', 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* 半截行跳过 */ }
  }
  return out;
}

/**
 * 原子写 JSON：tmp 写入 → fsync → rename。
 *
 * 为什么必须有 fsync：tmp+rename 只防「进程崩溃」（rename 要么旧要么新），
 * 防不了「断电」——文件系统可以先把 rename 的元数据落盘、数据块还在缓存里，
 * 崩溃后目标文件就是 0 字节。settings.json / meta.json 这类关键数据必须先刷下去再改名。
 *
 * spaces / trailingNewline 用来和各调用点原有的 stringify 格式逐字节保持一致。
 * @param {string} file 目标文件
 * @param {object} opts fsync 默认 true；spaces=缩进空格数；trailingNewline=末尾补 \n
 */
function writeJsonAtomic(file, value, { fsync = true, spaces = 0, trailingNewline = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify(value, null, spaces > 0 ? spaces : undefined);
  fs.writeFileSync(tmp, trailingNewline ? body + '\n' : body, 'utf8');
  if (fsync) {
    const fd = fs.openSync(tmp, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  fs.renameSync(tmp, file);
}

module.exports = { readJson, readJournal, writeJsonAtomic };
