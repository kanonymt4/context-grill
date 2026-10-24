import test from 'node:test';
import assert from 'node:assert/strict';

import { isIndexable } from '../src/connectors/base.js';
import { isSensitivePath } from '../src/util/sensitive.js';

// 拒否リストの穴（credentials.yml / private_key.txt / 大文字小文字）を塞ぐ。

test('機密パス: credentials.* / private_key.* / 大文字小文字違いは索引されない', () => {
  const must = [
    'credentials.yml', 'credentials.yaml', 'config/credentials.toml', 'a/credentials.ini',
    'Credentials.YML', 'private_key.txt', 'PRIVATE_KEY.TXT', 'keys/private-key.json',
    'deploy/server_private_key.pem', 'deploy/my_private_key.txt', 'ID_RSA', 'config/.ENV',
    'a/.Env.Local', 'KEYS/Server.PEM',
  ];
  for (const p of must) assert.equal(isIndexable(p), false, `${p} は索引されないべき`);
});

test('機密パス(回帰): 既存の除外 8 件は引き続き除外される', () => {
  for (const p of ['.env', '.env.local', 'config/.env.production', 'server.key', 'keys/server.pem',
                   'id_ed25519', '.npmrc', 'secrets.yaml']) {
    assert.equal(isIndexable(p), false, `${p} は索引されないべき`);
  }
});

test('機密パス(回帰): サンプルは大文字小文字を問わず許可され、一般の文書・コードは除外されない', () => {
  const allowed = [
    '.env.example', '.ENV.EXAMPLE', 'config/.Env.Sample', 'credentials.md', 'private_key_rotation.md',
    'docs/credentials-guide.md', 'src/privateKeyUtil.js', 'src/credentials.js', 'src/private_key.ts',
    'docs/private_key.md', 'README.md', 'src/app.js',
  ];
  for (const p of allowed) assert.equal(isIndexable(p), true, `${p} は索引されるべき`);
});

test('機密パス: denySensitivePaths:false なら従来どおり素通し', () => {
  assert.equal(isIndexable('credentials.yml', { denySensitivePaths: false }), true);
});

test('機密パス: extraDenyPaths は従来どおり効く', () => {
  assert.equal(isSensitivePath('internal/notes.txt', ['internal/**']), true);
  assert.equal(isSensitivePath('public/notes.txt', ['internal/**']), false);
});
