'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RELEASE_URL = 'https://github.com/Banan1cee/whale_girl/releases/tag/';
const dateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short' });

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function shortText(text, max) {
  const characters = Array.from(text);
  return characters.length > max ? characters.slice(0, max - 1).join('') + '…' : text;
}

/**
 * 去掉 HTML 注释和标签片段，只留文字。
 *
 * 为什么不用 `/<[^>]*>/g`：这种「多字符替换」在扫描器看来不完整（重叠的
 * `<scr<script>ipt>` 一类输入可能留下能拼回的片段），所以改成逐字符扫描，
 * 扫完文本里不会再有任何尖括号。真正的注入防护仍然是输出前的 escapeHtml()，
 * 这一层只负责把发布说明变成好看的纯文本。
 */
function stripMarkupSpans(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text[i] === '<') {
      const end = text.indexOf('>', i + 1);
      i = end >= 0 ? end + 1 : i + 1;      // 孤立的尖括号直接丢掉，后面的文字保留
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

function notesFrom(body) {
  return stripMarkupSpans(String(body || ''))
    .replace(/^```[^]*?^```[^\n]*/gm, '')
    .split(/\r?\n/)
    .filter(line => !/^\s*(?:#|>|!\[|[-*_]{3,}\s*$)/.test(line))
    .map(line => line
      .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[`*_]/g, '')
      .trim())
    .filter(Boolean)
    .slice(0, 5);
}

function isPublished(release) {
  return release && !release.draft && !release.prerelease && typeof release.tag_name === 'string'
    && release.tag_name && release.published_at && Number.isFinite(Date.parse(release.published_at));
}

function details(release) {
  const version = release.tag_name.replace(/^v(?=\d)/i, '');
  const title = String(release.name || '').trim().replace(/^鲸鲸\s+v?[\d.]+\s*[·—:：-]\s*/i, '');
  const date = dateFormat.format(new Date(release.published_at));
  return {
    version: escapeHtml(shortText(version, 25)),
    title: escapeHtml(shortText(title || '鲸鲸 ' + version, 80)),
    date,
    link: RELEASE_URL + encodeURIComponent(release.tag_name),
    notes: notesFrom(release.body),
  };
}

function render(template, latest, releases, { localLinks = false } = {}) {
  if (!isPublished(latest) || !Array.isArray(releases)) throw new Error('GitHub 正式发行数据无效');

  const current = details(latest);
  const recent = releases.filter(release => isPublished(release) && release.tag_name !== latest.tag_name)
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  const rows = [latest, ...recent.slice(0, 2)].map((release, index) => {
    const item = details(release);
    const note = item.notes[0] ? '<small>' + escapeHtml(shortText(item.notes[0], 105)) + '</small>' : '';
    const badge = index === 0 ? ' <i>最新</i>' : '';
    const href = localLinks ? `./downloads/${encodeURIComponent(release.tag_name)}/` : item.link;
    return `<a class="release-row" href="${href}"${localLinks ? '' : ' target="_blank" rel="noopener noreferrer"'}><span class="release-version">${item.version}${badge}</span><span class="release-info"><strong>${item.title}</strong>${note}</span><time datetime="${item.date}">${item.date.replaceAll('-', '.')}</time><span class="release-arrow" aria-hidden="true">↗</span></a>`;
  });
  const content = {
    hero: `探索 ${current.version} 的新变化`,
    version: current.version,
    title: current.title,
    summary: escapeHtml(shortText(current.notes.slice(0, 2).join(' ') || '完整更新说明见 GitHub。', 180)),
    rows: rows.join('\n        '),
    'dialog-title': `${current.version} · ${current.title}`,
    'dialog-notes': current.notes.map(note => `<p>${escapeHtml(shortText(note, 300))}</p>`).join('\n    ') || '<p>完整更新说明见 GitHub。</p>',
    'dialog-link': localLinks
      ? `<a class="button" href="./downloads/${encodeURIComponent(latest.tag_name)}/">查看下载与完整更新说明 ↗</a>`
      : `<a class="button" href="${current.link}" target="_blank" rel="noopener noreferrer">查看完整更新说明 ↗</a>`,
  };
  for (const [name, html] of Object.entries(content)) {
    const slot = new RegExp(`<!-- release:${name} -->[\\s\\S]*?<!-- /release:${name} -->`);
    if (!slot.test(template)) throw new Error(`官网模板缺少发行区占位符：${name}`);
    template = template.replace(slot, () => html);
  }
  return template;
}

if (require.main === module) {
  const [latestFile, recentFile, output] = process.argv.slice(2);
  const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const site = path.resolve(__dirname, '../website');
  const html = render(fs.readFileSync(path.join(site, 'index.html'), 'utf8'), readJson(latestFile), readJson(recentFile));
  fs.cpSync(site, output, { recursive: true });
  fs.writeFileSync(path.join(output, 'index.html'), html);
}

module.exports = { render, notesFrom };
