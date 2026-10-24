// github コネクタの git 実行まわりの 4 つの抜けと、sources[].host の検査。
//  1. gitEnv が GIT_DIR などを継承し、利用者の別リポジトリを書き換える
//  2. 初回 clone の insteadOf 検査が、実際の取得と違う設定（cwd）で行われる
//  3. insteadOf による https -> http の降格を素通しする
//  4. ref が git のオプションとして解釈される
//  5. host に userinfo などを書ける
// 実際の git を使うが、接続先は 127.0.0.1 のダミーサーバー（git http-backend / TCP シンク）だけで外部には出ない。
// HOME / GIT_CONFIG_GLOBAL は一時ディレクトリに差し替え、ホストの gitconfig に依存しない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { syncGithub, gitEnv } from '../src/connectors/github.js';
import { initEgress } from '../src/util/egress.js';
import { loadConfig } from '../src/config.js';

// 実 git の HTTPS サーバー（git http-backend + openssl の自己署名証明書）が要るテストの実行可否。
// 満たさない環境ではそのテストだけを skip する（失敗・クラッシュにしない）。
// Windows は Git に同梱の openssl が PATH に無い・http-backend が .exe・パス表記が違うため対象外。
function skipReason() {
  if (process.platform === 'win32') return 'win32 では git http-backend / openssl / gitdir: のパス表記を前提にしたテストを実行しない';
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { return 'openssl を実行できない'; }
  try {
    const exec = path.join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), 'git-http-backend');
    if (!fs.existsSync(exec)) return 'git --exec-path 配下に git-http-backend が無い';
  } catch { return 'git --exec-path を実行できない'; }
  return null;
}
const SKIP = skipReason();
const NEEDS_SERVER = SKIP ? { skip: SKIP } : {};

const ENV_KEYS =['HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GITHUB_TOKEN', 'GIT_DIR'];

/** 子プロセス用の環境（GIT_DIR などを持ち込まない） */
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE)$/.test(k)) delete env[k];
  return env;
}
const sh = (args, cwd) => execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** 自己署名証明書を 1 回だけ作る（git 側は sslVerify=false で使う） */
let CERT = null;
function cert(tmp) {
  if (CERT) return CERT;
  const key = path.join(tmp, 'k.pem');
  const crt = path.join(tmp, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '2',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  CERT = { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
  return CERT;
}

/** upstream の bare リポジトリ（acme/api.git）を作り、コミット sha を返す */
function makeUpstream(root) {
  const work = path.join(root, 'work');
  fs.mkdirSync(work, { recursive: true });
  sh(['init', '-q', '-b', 'main', work]);
  fs.writeFileSync(path.join(work, 'README.md'), '# hello\n');
  sh(['add', '-A'], work);
  sh(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init'], work);
  fs.mkdirSync(path.join(root, 'srv', 'acme'), { recursive: true });
  sh(['clone', '-q', '--bare', work, path.join(root, 'srv', 'acme', 'api.git')]);
  return sh(['rev-parse', 'HEAD'], work);
}

/** git http-backend を CGI として動かす HTTPS サーバー。接続数と Authorization の有無を数える */
function startGitHttps(root, tls) {
  const exec = path.join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), 'git-http-backend');
  const state = { connections: 0, requests: 0 };
  const server = https.createServer(tls, (req, res) => {
    state.requests++;
    const u = new URL(req.url, 'https://x');
    const env = {
      PATH: process.env.PATH, GIT_PROJECT_ROOT: path.join(root, 'srv'), GIT_HTTP_EXPORT_ALL: '1',
      REQUEST_METHOD: req.method, PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1),
      CONTENT_TYPE: req.headers['content-type'] || '', REMOTE_ADDR: '127.0.0.1',
      HTTP_CONTENT_ENCODING: req.headers['content-encoding'] || '', HTTP_GIT_PROTOCOL: req.headers['git-protocol'] || '',
    };
    if (req.headers['content-length']) env.CONTENT_LENGTH = req.headers['content-length'];
    const p = spawn(exec, [], { env });
    const chunks = [];
    p.stdout.on('data', (c) => chunks.push(c));
    p.on('close', () => {
      const out = Buffer.concat(chunks);
      const i = out.indexOf('\r\n\r\n');
      const head = out.subarray(0, i).toString().split('\r\n');
      let status = 200;
      for (const line of head) {
        const [k, ...v] = line.split(':');
        const val = v.join(':').trim();
        if (k.toLowerCase() === 'status') status = parseInt(val, 10);
        else res.setHeader(k, val);
      }
      res.statusCode = status;
      res.end(out.subarray(i + 4));
    });
    req.pipe(p.stdin);
  });
  server.on('secureConnection', () => { state.connections++; });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      state.port = server.address().port;
      state.close = () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
      resolve(state);
    });
  });
}

/** 接続数と受け取った生データを記録するだけの TCP サーバー（受けたら即切る） */
function startSink() {
  return new Promise((resolve) => {
    const state = { connections: 0, data: '' };
    const server = net.createServer((s) => {
      state.connections++;
      s.on('data', (d) => { state.data += d.toString('latin1'); });
      s.on('error', () => {});
      setTimeout(() => s.destroy(), 50);
    });
    server.listen(0, '127.0.0.1', () => {
      state.port = server.address().port;
      state.close = () => new Promise((r) => { server.close(r); });
      resolve(state);
    });
  });
}

/**
 * git の環境を隔離して fn({ tmp, repos, workspaceDir, upstream }) を実行する。
 * gitconfig は fn の中で書き換えられる（setGitconfig）。
 */
async function withIsolatedGit(fn, { gitconfig = '' } = {}) {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cg-git-hard-'));
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const gc = path.join(tmp, 'gitconfig');
  const setGitconfig = (text) => fs.writeFileSync(gc, '[http]\n\tsslVerify = false\n' + text);
  setGitconfig(gitconfig);
  process.env.HOME = tmp;
  process.env.GIT_CONFIG_GLOBAL = gc;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  delete process.env.GITHUB_TOKEN;
  delete process.env.GIT_DIR;
  const repos = path.join(tmp, 'ws', 'repos');
  const workspaceDir = path.join(tmp, 'ws');
  fs.mkdirSync(repos, { recursive: true });
  try {
    return await fn({ tmp, repos, workspaceDir, setGitconfig });
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function makeCtx({ host, allowHosts = [], workspaceDir, repos, repo = 'acme/api', extra = {} }) {
  const src = { id: 'g', type: 'github', repo, host, ...extra };
  const config = { sources: [src], security: { allowHosts }, workspaceDir };
  initEgress(config);
  return { src, ctx: { config, paths: { repos } } };
}

/** upstream + HTTPS サーバーを立てて fn に渡す */
async function withServer(tmp, fn) {
  const sha = makeUpstream(path.join(tmp, 'up'));
  const srv = await startGitHttps(path.join(tmp, 'up'), cert(tmp));
  try {
    return await fn({ srv, sha, host: `127.0.0.1:${srv.port}` });
  } finally {
    await srv.close();
  }
}

const blocked = (re) => (e) => {
  assert.equal(e.name, 'EgressBlocked', `EgressBlocked ではなく: ${e.name}: ${String(e.message).slice(0, 300)}`);
  if (re) assert.match(e.message, re);
  return true;
};

// ------------------------------------------------------------ 回帰ガード（実装前から通る）
test('回帰: insteadOf の無い初回 sync が成功し、マーカーと HEAD が期待どおり。2 回目（fetch/reset）も成功する', NEEDS_SERVER, async () => {
  await withIsolatedGit(async ({ tmp, repos, workspaceDir }) => {
    await withServer(tmp, async ({ srv, sha, host }) => {
      const { src, ctx } = makeCtx({ host, allowHosts: [host], workspaceDir, repos });
      const r1 = await syncGithub(src, ctx);
      assert.equal(r1.state.sha, sha);
      assert.ok(r1.docs.some((d) => d.path === 'README.md'));
      const dir = path.join(repos, 'g');
      assert.ok(fs.existsSync(path.join(dir, '.context-grill-managed')), 'マーカーが無い');
      assert.equal(sh(['rev-parse', 'HEAD'], dir), sha);
      assert.ok(srv.requests > 0);
      const r2 = await syncGithub(src, ctx);
      assert.equal(r2.state.sha, sha);
    });
  });
});

test('回帰: 取得に失敗して .git だけが残っても、再実行で復旧する（既存クローンとして fetch の経路に入る）', NEEDS_SERVER, async () => {
  await withIsolatedGit(async ({ tmp, repos, workspaceDir }) => {
    await withServer(tmp, async ({ sha, host }) => {
      const bad = makeCtx({ host, allowHosts: [host], workspaceDir, repos, extra: { ref: 'no-such-branch' } });
      await assert.rejects(() => syncGithub(bad.src, bad.ctx), (e) => e.name !== 'EgressBlocked');
      const dir = path.join(repos, 'g');
      // 途中で失敗した状態を作る（取得が失敗する実装でもしない実装でも同じ前提にそろえる）
      if (!fs.existsSync(path.join(dir, '.git'))) { fs.mkdirSync(dir, { recursive: true }); sh(['init', '-q', dir]); }
      if (!fs.existsSync(path.join(dir, '.context-grill-managed'))) fs.writeFileSync(path.join(dir, '.context-grill-managed'), 'x\n');
      const ok = makeCtx({ host, allowHosts: [host], workspaceDir, repos });
      const r = await syncGithub(ok.src, ok.ctx);
      assert.equal(r.state.sha, sha);
    });
  });
});

test('回帰: マーカーが無い非空ディレクトリには触らない', async () => {
  await withIsolatedGit(async ({ repos, workspaceDir }) => {
    const dir = path.join(repos, 'g');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mine.txt'), 'x');
    const { src, ctx } = makeCtx({ host: '127.0.0.1:1', allowHosts: ['127.0.0.1:1'], workspaceDir, repos });
    await assert.rejects(() => syncGithub(src, ctx), /context-grill が作成したクローンではない/);
    assert.deepEqual(fs.readdirSync(dir), ['mine.txt']);
  });
});

test('スキーム: scp 風・ローカルパス・file:// への書き換えは、ホストを特定できないので従来どおり拒否される', async () => {
  const cases = {
    'scp 風': 'git@evil.invalid:',
    'ローカルパス': '/tmp/cg-no-such-dir/',
    'file://': 'file:///tmp/cg-no-such-dir/',
  };
  for (const [name, base] of Object.entries(cases)) {
    await withIsolatedGit(async ({ repos, workspaceDir }) => {
      const { src, ctx } = makeCtx({ host: 'git.example.invalid', workspaceDir, repos });
      await assert.rejects(() => syncGithub(src, ctx), blocked(/insteadOf/), name);
    }, { gitconfig: `[url "${base}"]\n\tinsteadOf = https://git.example.invalid/\n` });
  }
});

// ------------------------------------------------------------ 1. GIT_DIR などの継承
test('gitEnv: GIT_DIR などの位置指定・設定注入の環境変数を継承しない。GIT_CONFIG_GLOBAL / SYSTEM は残る', async () => {
  const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
    'GIT_CONFIG_KEY_7', 'GIT_CONFIG_VALUE_7', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GITHUB_TOKEN'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) process.env[k] = '/x';
    delete process.env.GITHUB_TOKEN;
    const env = gitEnv({});
    for (const k of keys.slice(0, -3)) assert.ok(!(k in env), `${k} を継承している`);
    assert.equal(env.GIT_CONFIG_GLOBAL, '/x');
    assert.equal(env.GIT_CONFIG_SYSTEM, '/x');
    // トークンがあるときの自前の GIT_CONFIG_* は従来どおり（利用者の値は混ざらない）
    process.env.GITHUB_TOKEN = 'dummy-token-value';
    const withTk = gitEnv({});
    assert.equal(withTk.GIT_CONFIG_COUNT, '1');
    assert.equal(withTk.GIT_CONFIG_KEY_0, 'http.extraHeader');
    assert.match(withTk.GIT_CONFIG_VALUE_0, /^Authorization: Basic /);
    assert.ok(!('GIT_CONFIG_KEY_7' in withTk));
    assert.ok(!('GIT_DIR' in withTk));
  } finally {
    for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

test('GIT_DIR が設定された環境でも、sync は利用者の別リポジトリの HEAD・shallow・index を変えない', NEEDS_SERVER, async () => {
  await withIsolatedGit(async ({ tmp, repos, workspaceDir }) => {
    await withServer(tmp, async ({ sha, host }) => {
      const { src, ctx } = makeCtx({ host, allowHosts: [host], workspaceDir, repos });
      await syncGithub(src, ctx);   // マネージドクローンを作る

      // 利用者の別リポジトリ（victim）
      const victim = path.join(tmp, 'victim');
      fs.mkdirSync(victim);
      sh(['init', '-q', '-b', 'main', victim]);
      fs.writeFileSync(path.join(victim, 'mine.txt'), 'mine\n');
      sh(['add', '-A'], victim);
      sh(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'mine'], victim);
      const gitdir = path.join(victim, '.git');
      const snap = () => ({
        head: sh(['rev-parse', 'HEAD'], victim),
        shallow: fs.existsSync(path.join(gitdir, 'shallow')),
        index: fs.readFileSync(path.join(gitdir, 'index')).toString('hex'),
      });
      const before = snap();
      assert.notEqual(before.head, sha);

      process.env.GIT_DIR = gitdir;   // git フックの中などで継承される状況
      try {
        await syncGithub(src, ctx);
      } finally {
        delete process.env.GIT_DIR;
      }
      assert.deepEqual(snap(), before, '利用者の別リポジトリが書き換えられた');
      assert.equal(sh(['rev-parse', 'HEAD'], path.join(repos, 'g')), sha);
    });
  });
});

// ------------------------------------------------------------ 2. 初回 clone の insteadOf
test('includeIf "gitdir:" 内の insteadOf（ファイルへの書き換え）でも、初回 sync は接続・取得の前にブロックされる', NEEDS_SERVER, async () => {
  await withIsolatedGit(async ({ tmp, repos, workspaceDir, setGitconfig }) => {
    const up = path.join(tmp, 'up');
    makeUpstream(up);
    const bare = path.join(up, 'srv', 'acme', 'api.git');
    const inc = path.join(tmp, 'inc.gitconfig');
    fs.writeFileSync(inc, `[url "file://${bare.replace(/api\.git$/, '')}"]\n\tinsteadOf = https://git.example.invalid/acme/\n`);
    setGitconfig(`[includeIf "gitdir:${repos}/**"]\n\tpath = ${inc}\n`);
    const { src, ctx } = makeCtx({ host: 'git.example.invalid', workspaceDir, repos });
    await assert.rejects(() => syncGithub(src, ctx), blocked(/insteadOf/));
    // 書き換え先から取得していないこと（作業ツリーに README が出ていない）
    assert.ok(!fs.existsSync(path.join(repos, 'g', 'README.md')), '書き換え先から取得された');
  });
});

test('includeIf "gitdir:" 内の insteadOf（許可外ホストへの書き換え）でも、書き換え先への接続は 0 件', NEEDS_SERVER, async () => {
  const sink = await startSink();
  try {
    await withIsolatedGit(async ({ tmp, repos, workspaceDir, setGitconfig }) => {
      const inc = path.join(tmp, 'inc.gitconfig');
      fs.writeFileSync(inc, `[url "https://127.0.0.1:${sink.port}/"]\n\tinsteadOf = https://git.example.invalid/\n`);
      setGitconfig(`[includeIf "gitdir:${repos}/**"]\n\tpath = ${inc}\n`);
      const { src, ctx } = makeCtx({ host: 'git.example.invalid', workspaceDir, repos });
      await assert.rejects(() => syncGithub(src, ctx), blocked(new RegExp(`127\\.0\\.0\\.1:${sink.port}`)));
    });
    assert.equal(sink.connections, 0, '書き換え先に接続した');
  } finally {
    await sink.close();
  }
});

test('条件なしの insteadOf（従来の検査）も引き続き初回 sync を拒否する', async () => {
  const sink = await startSink();
  try {
    await withIsolatedGit(async ({ repos, workspaceDir }) => {
      const { src, ctx } = makeCtx({ host: 'git.example.invalid', workspaceDir, repos });
      await assert.rejects(() => syncGithub(src, ctx), blocked(/insteadOf/));
    }, { gitconfig: `[url "https://127.0.0.1:${sink.port}/"]\n\tinsteadOf = https://git.example.invalid/\n` });
    assert.equal(sink.connections, 0);
  } finally {
    await sink.close();
  }
});

// ------------------------------------------------------------ 3. https -> http の降格
test('insteadOf で https から http へ降格されたら、同じホストでもブロックされ、トークンは平文で送られない', async () => {
  const sink = await startSink();
  const saved = process.env.GITHUB_TOKEN;
  try {
    await withIsolatedGit(async ({ repos, workspaceDir, setGitconfig }) => {
      process.env.GITHUB_TOKEN = 'dummy-token-value';
      const host = `127.0.0.1:${sink.port}`;
      setGitconfig(`[url "http://${host}/"]\n\tinsteadOf = https://${host}/\n`);
      const { src, ctx } = makeCtx({ host, allowHosts: [host], workspaceDir, repos });
      await assert.rejects(() => syncGithub(src, ctx), blocked(/https 以外のスキーム/));
    });
    assert.equal(sink.connections, 0, '平文の http サーバーに接続した');
    assert.ok(!/Authorization/i.test(sink.data), 'Authorization が平文で送られた');
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = saved;
    await sink.close();
  }
});

test('https から http への降格: 既存クローン（fetch の経路）でも同様にブロックされる', async () => {
  const sink = await startSink();
  try {
    await withIsolatedGit(async ({ tmp, repos, workspaceDir, setGitconfig }) => {
      const host = `127.0.0.1:${sink.port}`;
      setGitconfig(`[url "http://${host}/"]\n\tinsteadOf = https://${host}/\n`);
      const dir = path.join(repos, 'g');
      fs.mkdirSync(dir, { recursive: true });
      sh(['init', '-q', dir]);
      fs.writeFileSync(path.join(dir, '.context-grill-managed'), 'x\n');
      const { src, ctx } = makeCtx({ host, allowHosts: [host], workspaceDir, repos });
      await assert.rejects(() => syncGithub(src, ctx), blocked(/https 以外のスキーム/));
    });
    assert.equal(sink.connections, 0);
  } finally {
    await sink.close();
  }
});

// ------------------------------------------------------------ 4. ref のオプション解釈
test('ref が - で始まる値（git のオプション）は形式不正として拒否される', async () => {
  for (const ref of ['--recurse-submodules', '-ofoo', '-']) {
    await withIsolatedGit(async ({ repos, workspaceDir }) => {
      const { src, ctx } = makeCtx({ host: '127.0.0.1:1', allowHosts: ['127.0.0.1:1'], workspaceDir, repos, extra: { ref } });
      await assert.rejects(() => syncGithub(src, ctx), /sources\[g\]\.ref の形式が不正です/, ref);
    });
  }
});

test('ref: ブランチ名・タグ名・refs/ 形式は従来どおり取得できる', NEEDS_SERVER, async () => {
  await withIsolatedGit(async ({ tmp, repos, workspaceDir }) => {
    await withServer(tmp, async ({ sha, host }) => {
      for (const ref of ['main', 'refs/heads/main']) {
        const { src, ctx } = makeCtx({ host, allowHosts: [host], workspaceDir, repos, extra: { ref } });
        const r = await syncGithub(src, ctx);
        assert.equal(r.state.sha, sha, ref);
      }
    });
  });
});

// ------------------------------------------------------------ 5. host の形式
async function withConfigText(text, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-host-cfg-'));
  try {
    const file = path.join(dir, 'context-grill.config.json');
    fs.writeFileSync(file, text);
    return await fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const cfgWithHost = (host) => JSON.stringify({
  project: 'x', llm: { provider: 'dry', model: 'd' },
  sources: [{ id: 'g', type: 'github', repo: 'acme/api', host }],
});

test('config: github の host に userinfo・パス・スキームを書くと設定エラー（値は出さない）', async () => {
  for (const host of ['github.com@127.0.0.1:1', 'github.com/x', 'https://github.com', 'user:pw@github.com', 'a b', 'host:abc']) {
    await withConfigText(cfgWithHost(host), async (file) => {
      await assert.rejects(() => loadConfig(file), (e) => {
        assert.match(e.message, /^設定エラー:/, host);
        assert.match(e.message, /sources\[0\]\.host/, host);
        assert.ok(!e.message.includes(host), `host の値がエラーに出ている: ${e.message}`);
        return true;
      });
    });
  }
});

test('config: github の host が ホスト名 / ホスト名:ポート なら通る。host 省略も通る', async () => {
  for (const host of ['github.com', 'github.example.com', 'ghe.example.com:8443', '127.0.0.1:9']) {
    await withConfigText(cfgWithHost(host), async (file) => {
      const c = await loadConfig(file);
      assert.equal(c.sources[0].host, host);
    });
  }
  await withConfigText(JSON.stringify({
    project: 'x', llm: { provider: 'dry', model: 'd' }, sources: [{ id: 'g', type: 'github', repo: 'acme/api' }],
  }), async (file) => { await loadConfig(file); });
});
