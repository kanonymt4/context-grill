#!/usr/bin/env node
// CLAUDE.md の「未確認・次にやること」欄の書式を検査する。
//
//   node scripts/check-unverified.mjs [CLAUDE.md のパス]
//
// 検査するのは書式だけ。変更内容との突き合わせ（push しようとしている差分が
// OPEN 項目の影響ファイルを含むか）は pre-push hook 側の仕事で、ここでは行わない。
//
// 依存パッケージなし（Node 20.10+ の組み込みのみ）。

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

const SECTION = '## 未確認・次にやること';
const REQUIRED = ['status', '前提', '検証方法', '影響ファイル', '外れた場合に無効になるもの'];
const HEADING = /^###\s+(UNVERIFIED-\d{3})\s+—\s+(.+?)\s*$/;
const FIELD = /^-\s+([^:：]+)\s*[:：]\s*(.*)$/;
// 影響ファイルが未定であることを明示する書き方。パス実在の検査から除外する。
const NO_FILES = /^（.*）$/;

const mdPath = resolve(process.argv[2] ?? 'CLAUDE.md');
const repoRoot = dirname(mdPath);

function extractSection(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === SECTION);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end);
}

function parse(lines) {
  const items = [];
  let cur = null;
  for (const line of lines) {
    const h = HEADING.exec(line);
    if (h) {
      cur = { id: h[1], title: h[2], fields: new Map() };
      items.push(cur);
      continue;
    }
    if (!cur) continue;
    const f = FIELD.exec(line);
    if (f) cur.fields.set(f[1].trim(), f[2].trim());
  }
  return items;
}

function splitPaths(value) {
  return value.split(/[,、]/).map((s) => s.trim()).filter(Boolean);
}

function main() {
  if (!existsSync(mdPath)) {
    console.error(`${mdPath} が見つからない`);
    process.exit(2);
  }

  const section = extractSection(readFileSync(mdPath, 'utf8'));
  if (section === null) {
    console.error(`書式エラー:\n  「${SECTION}」の見出しがない`);
    process.exit(1);
  }

  const items = parse(section);
  const errors = [];

  if (items.length === 0) {
    errors.push('UNVERIFIED-NNN 形式の項目が 1 件もない（未移行の可能性）');
  }

  const seen = new Map();
  for (const it of items) {
    seen.set(it.id, (seen.get(it.id) ?? 0) + 1);
  }
  for (const [id, n] of seen) {
    if (n > 1) errors.push(`${id} が ${n} 箇所にある`);
  }

  for (const it of items) {
    for (const key of REQUIRED) {
      if (!it.fields.has(key)) {
        errors.push(`${it.id}: 必須欄「${key}」がない`);
        continue;
      }
      if (it.fields.get(key) === '') {
        errors.push(`${it.id}: 必須欄「${key}」が空`);
      }
    }

    const status = it.fields.get('status');
    if (status && status !== 'OPEN' && status !== 'CLOSED') {
      errors.push(`${it.id}: status は OPEN か CLOSED（実際: ${status}）`);
    }
    if (status === 'CLOSED' && !it.fields.has('解消')) {
      errors.push(`${it.id}: CLOSED なら「解消」欄が要る`);
    }

    const files = it.fields.get('影響ファイル');
    if (files && !NO_FILES.test(files)) {
      for (const p of splitPaths(files)) {
        if (!existsSync(join(repoRoot, p))) {
          errors.push(`${it.id}: 影響ファイル ${p} が存在しない`);
        }
      }
    }
  }

  const open = items.filter((i) => i.fields.get('status') === 'OPEN');
  const closed = items.filter((i) => i.fields.get('status') === 'CLOSED');

  console.log(`UNVERIFIED 項目: ${items.length} 件（OPEN ${open.length} / CLOSED ${closed.length}）`);
  if (open.length) {
    console.log('\nOPEN:');
    const w = Math.max(...open.map((i) => [...i.title].length));
    for (const i of open) {
      const pad = ' '.repeat(w - [...i.title].length);
      console.log(`  ${i.id}  ${i.title}${pad}  ${i.fields.get('影響ファイル') ?? ''}`);
    }
  }

  if (errors.length) {
    console.log('\n書式エラー:');
    for (const e of errors) console.log(`  ${e}`);
    process.exit(1);
  }
  console.log('\n書式エラー: なし');
}

main();
