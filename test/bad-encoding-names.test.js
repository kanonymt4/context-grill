import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { syncSources } from '../src/index/ingest.js';

// UTF-8 として不正なファイルを除外したとき、どのファイルかをパスだけで警告する。
// 外部通信なし（ローカルの一時ディレクトリのみ）。

function baseConfig(root) {
  return {
    rootDir: root,
    workspaceDir: path.join(root, 'ws'),
    sources: [{ id: 'docs', type: 'local', path: 'docs' }],
    llm: { provider: 'dry' },
    retrieval: { embedding: { provider: 'none' } },
    security: { networkMode: 'normal', auditLog: false },
  };
}

async function captureStderr(fn) {
  const orig = process.stderr.write;
  let out = '';
  process.stderr.write = (chunk) => { out += String(chunk); return true; };
  try { await fn(); } finally { process.stderr.write = orig; }
  return out;
}

// 本文に混ぜる不正バイトの目印（出力に現れてはいけない）
const BAD_BODY = Buffer.concat([Buffer.from('secret-body-'), Buffer.from([0xA9, 0xFF, 0xFE]), Buffer.from('-tail')]);

test('不正な UTF-8 のファイルは 5 件までパスを警告し、残りは「ほか N 件」にする', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-badenc-'));
  try {
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'ok.md'), '# ok\n');
    for (let i = 1; i <= 7; i++) fs.writeFileSync(path.join(root, 'docs', `bad${i}.md`), BAD_BODY);
    let report;
    const err = await captureStderr(async () => { report = await syncSources(baseConfig(root), {}); });
    assert.equal(report[0].state.skipped.badEncoding, 7);
    const warnLines = err.split('\n').filter((l) => l.includes('[context-grill:warn]'));
    const joined = warnLines.join('\n');
    const named = [1, 2, 3, 4, 5, 6, 7].filter((i) => joined.includes(`bad${i}.md`));
    assert.equal(named.length, 5, `警告: ${joined}`);
    assert.ok(joined.includes('ほか 2 件'), `警告: ${joined}`);
    assert.ok(!err.includes('secret-body'), `本文が出ている: ${err}`);
    assert.ok(!err.includes('�'), 'U+FFFD が出ている');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('ちょうど 5 件なら「ほか」は出さない', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-badenc-five-'));
  try {
    fs.mkdirSync(path.join(root, 'docs'));
    for (let i = 1; i <= 5; i++) fs.writeFileSync(path.join(root, 'docs', `bad${i}.md`), BAD_BODY);
    const err = await captureStderr(async () => { await syncSources(baseConfig(root), {}); });
    for (let i = 1; i <= 5; i++) assert.ok(err.includes(`bad${i}.md`), `出力: ${err}`);
    assert.ok(!err.includes('ほか'), `出力: ${err}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('正常なファイルだけなら文字コードの警告は出ない', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-badenc-none-'));
  try {
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'ok.md'), '# ok 日本語\n');
    let report;
    const err = await captureStderr(async () => { report = await syncSources(baseConfig(root), {}); });
    assert.equal(report[0].state.skipped.badEncoding, 0);
    assert.ok(!err.includes('[context-grill:warn]'), `出力: ${err}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('github(作業ディレクトリ参照) でも同じ警告が出る', async () => {
  const { syncGithub } = await import('../src/connectors/github.js');
  const { initEgress } = await import('../src/util/egress.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-badenc-gh-'));
  try {
    fs.mkdirSync(path.join(root, 'repo'));
    fs.writeFileSync(path.join(root, 'repo', 'ok.md'), '# ok\n');
    for (let i = 1; i <= 6; i++) fs.writeFileSync(path.join(root, 'repo', `bad${i}.md`), BAD_BODY);
    const config = baseConfig(root);
    config.sources = [{ id: 'gh', type: 'github', path: path.join(root, 'repo') }];
    initEgress(config);
    let state;
    const err = await captureStderr(async () => {
      ({ state } = await syncGithub(config.sources[0], { config, paths: { repos: path.join(root, 'repos') } }));
    });
    assert.equal(state.skipped.badEncoding, 6);
    assert.ok(err.includes('ほか 1 件'), `出力: ${err}`);
    assert.ok(!err.includes('secret-body'), `出力: ${err}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
