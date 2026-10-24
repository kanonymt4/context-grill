// git の実際の接続先（url.<base>.insteadOf）の検査と、失敗した git の監査ログの記録。
// 実際の git を使うが、接続先は 127.0.0.1 のダミー TCP サーバーか名前解決できない
// ホスト（.invalid）だけで、外部には出ない。ホストの gitconfig に依存しないよう、
// HOME / GIT_CONFIG_GLOBAL を一時ディレクトリに差し替えて実行する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { syncGithub, assertGitSubcommand } from '../src/connectors/github.js';
import { initEgress } from '../src/util/egress.js';

/** 接続数を数えるだけの TCP サーバー（受けたら即切る） */
function startSink() {
  return new Promise((resolve) => {
    const state = { connections: 0 };
    const server = net.createServer((s) => { state.connections++; s.destroy(); });
    server.listen(0, '127.0.0.1', () => {
      state.port = server.address().port;
      state.close = () => new Promise((r) => { server.close(r); });
      resolve(state);
    });
  });
}

const ENV_KEYS = ['HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'];

/**
 * 一時ディレクトリで git の環境を隔離し、fn({ tmp, repos, workspaceDir }) を実行して戻す。
 * gitconfig には insteadOf を書ける（rules: [[base, from]]）。
 */
async function withIsolatedGit(rules, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-git-egress-'));
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const gitconfig = path.join(tmp, 'gitconfig');
  const body = rules.map(([base, from]) => `[url "${base}"]\n\tinsteadOf = ${from}\n`).join('');
  fs.writeFileSync(gitconfig, body);
  process.env.HOME = tmp;
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  const repos = path.join(tmp, 'repos');
  const workspaceDir = path.join(tmp, 'ws');
  fs.mkdirSync(repos, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  try {
    return await fn({ tmp, repos, workspaceDir });
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function makeCtx({ host, allowHosts = [], workspaceDir, repos, repo = 'acme/api' }) {
  const src = { id: 'g', type: 'github', repo, host };
  const config = { sources: [src], security: { allowHosts }, workspaceDir };
  initEgress(config);
  return { src, ctx: { config, paths: { repos } } };
}

function readAudit(workspaceDir) {
  const p = path.join(workspaceDir, 'egress.log');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('git: insteadOf で許可リスト外のホストへ書き換わる clone は、接続する前にブロックされる', async () => {
  const sink = await startSink();
  try {
    await withIsolatedGit([[`https://127.0.0.1:${sink.port}/`, 'https://git.example.invalid/']], async ({ repos, workspaceDir }) => {
      const { src, ctx } = makeCtx({ host: 'git.example.invalid', workspaceDir, repos });
      await assert.rejects(
        () => syncGithub(src, ctx),
        (e) => {
          assert.equal(e.name, 'EgressBlocked', `EgressBlocked ではなく: ${e.name}: ${String(e.message).slice(0, 200)}`);
          assert.match(e.message, /insteadOf/);
          assert.match(e.message, new RegExp(`127\\.0\\.0\\.1:${sink.port}`));
          return true;
        },
      );
    });
    assert.equal(sink.connections, 0, 'ブロックされるべき接続先に git が接続した');
  } finally {
    await sink.close();
  }
});

test('git: insteadOf で書き換わった fetch（既存クローン）も、接続する前にブロックされる', async () => {
  const sink = await startSink();
  try {
    await withIsolatedGit([[`https://127.0.0.1:${sink.port}/`, 'https://git.example.invalid/']], async ({ repos, workspaceDir }) => {
      const { src, ctx } = makeCtx({ host: 'git.example.invalid', workspaceDir, repos });
      // 管理下の既存クローンを模す（.git とマーカー）
      const dir = path.join(repos, 'g');
      fs.mkdirSync(dir, { recursive: true });
      execFileSync('git', ['init', '-q', dir], { env: process.env });
      fs.writeFileSync(path.join(dir, '.context-grill-managed'), 'test\n');
      await assert.rejects(
        () => syncGithub(src, ctx),
        (e) => {
          assert.equal(e.name, 'EgressBlocked', `EgressBlocked ではなく: ${e.name}: ${String(e.message).slice(0, 200)}`);
          return true;
        },
      );
    });
    assert.equal(sink.connections, 0);
  } finally {
    await sink.close();
  }
});

test('git(回帰): insteadOf が無ければ従来どおり許可されたホストへ進む（EgressBlocked にならない）', async () => {
  await withIsolatedGit([], async ({ repos, workspaceDir }) => {
    const { src, ctx } = makeCtx({ host: 'git.example.invalid', workspaceDir, repos });
    await assert.rejects(
      () => syncGithub(src, ctx),
      (e) => {
        assert.notEqual(e.name, 'EgressBlocked', `想定外のブロック: ${e.message}`);
        return true;
      },
    );
  });
});

test('git(回帰): 書き換え先が allowHosts にあれば insteadOf でも通る（接続する）', async () => {
  const sink = await startSink();
  try {
    await withIsolatedGit([[`https://127.0.0.1:${sink.port}/`, 'https://git.example.invalid/']], async ({ repos, workspaceDir }) => {
      const { src, ctx } = makeCtx({
        host: 'git.example.invalid', allowHosts: [`127.0.0.1:${sink.port}`], workspaceDir, repos,
      });
      await assert.rejects(
        () => syncGithub(src, ctx),
        (e) => {
          assert.notEqual(e.name, 'EgressBlocked', `想定外のブロック: ${e.message}`);
          return true;
        },
      );
    });
    assert.ok(sink.connections >= 1, `許可した書き換え先に接続していない: ${sink.connections}`);
  } finally {
    await sink.close();
  }
});

test('git: clone が失敗したら、失敗が egress.log に 1 件残り、URL 中の認証情報は残らない', async () => {
  await withIsolatedGit([], async ({ repos, workspaceDir }) => {
    const host = 'user:secret123@git.example.invalid';
    const { src, ctx } = makeCtx({ host, workspaceDir, repos });
    let message = '';
    await assert.rejects(() => syncGithub(src, ctx), (e) => { message = e.message; return e.name !== 'EgressBlocked'; });
    const lines = readAudit(workspaceDir).filter((e) => e.purpose === 'git:g');
    assert.equal(lines.length, 1, `git:g の行が 1 件ではない: ${JSON.stringify(lines)}`);
    assert.match(lines[0].detail, /^failed: /);
    assert.equal(lines[0].method, 'GIT');
    const raw = fs.readFileSync(path.join(workspaceDir, 'egress.log'), 'utf8');
    assert.ok(!raw.includes('secret123'), `認証情報がログに残っている: ${raw}`);
    assert.ok(message.length > 0);
  });
});

test('git: エラーの最終行にトークン形式の文字列が含まれても、egress.log には残らない', async () => {
  await withIsolatedGit([], async ({ repos, workspaceDir }) => {
    // git のエラーの最終行は URL を含む。リポジトリ名にトークン形式の文字列を入れて、墨消しを通ることを見る
    const fake = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const { src, ctx } = makeCtx({ host: 'git.example.invalid', workspaceDir, repos, repo: `acme/${fake}` });
    let message = '';
    await assert.rejects(() => syncGithub(src, ctx), (e) => { message = e.message; return e.name !== 'EgressBlocked'; });
    assert.ok(message.includes('git.example.invalid'), '前提: エラー本文に URL が含まれる');
    const raw = fs.readFileSync(path.join(workspaceDir, 'egress.log'), 'utf8');
    assert.ok(raw.includes('failed: '), raw);
    assert.ok(!raw.includes(fake), `トークン形式の文字列がログに残っている: ${raw}`);
  });
});

test('git: ls-remote は読み取り専用として許可され、破壊的なサブコマンドは従来どおり拒否される', () => {
  assert.ok(assertGitSubcommand('ls-remote', false));
  assert.throws(() => assertGitSubcommand('push', true), /破壊的な git サブコマンド/);
  assert.throws(() => assertGitSubcommand('push', false), /破壊的な git サブコマンド/);
  assert.throws(() => assertGitSubcommand('ls-remote-evil', true), /許可されていない/);
});
