import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

import { loadConfig } from '../src/config.js';
import { validatePresets } from '../src/presets.js';

// 設定中の ${VAR} の展開を検証する。設定は生の JSON 文字列で書く（"${" をそのまま入れるため）。
// 一時ディレクトリに置くので、リポジトリ直下の .env は読まれない。外部通信は起こさない。
const LLM = '"llm":{"provider":"dry","model":"d"}';
const SRC = (p) => `"sources":[{"id":"w","type":"local","path":${JSON.stringify(p)}}]`;

async function withConfig(text, fn, { dotenv } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-env-'));
  try {
    const file = path.join(dir, 'context-grill.config.json');
    await fsp.writeFile(file, text);
    if (dotenv !== undefined) await fsp.writeFile(path.join(dir, '.env'), dotenv);
    return await fn(file);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// name を value にして fn を実行し、終了時に元へ戻す（value が undefined なら未定義にする）
async function withEnv(vars, fn) {
  const before = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = Object.hasOwn(process.env, k) ? process.env[k] : undefined;
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const rejectsWith = (file, ...patterns) => assert.rejects(
  () => loadConfig(file),
  (e) => {
    assert.match(e.message, /^設定エラー:\n {2}- /, `実際: ${e.message}`);
    for (const p of patterns) assert.match(e.message, p, `実際: ${e.message}`);
    return true;
  },
);

test('env: 未定義の変数はエラーになり、変数名とパスを示す', async () => {
  await withEnv({ CG_T_UNDEF: undefined }, async () => {
    const text = `{"project":"x",${SRC('${CG_T_UNDEF}/proj')},${LLM}}`;
    await withConfig(text, (file) => rejectsWith(file,
      /sources\[0\]\.path の \$\{CG_T_UNDEF\} は環境変数が未定義です/));
  });
});

test('env: 最上位のキーのパスは project のように示す', async () => {
  await withEnv({ CG_T_UNDEF: undefined }, async () => {
    const text = `{"project":"env-\${CG_T_UNDEF}",${SRC('/tmp')},${LLM}}`;
    await withConfig(text, (file) => rejectsWith(file, /- project の \$\{CG_T_UNDEF\} は環境変数が未定義です/));
  });
});

test('env: 複数箇所が未定義なら 1 回の throw に全部列挙する', async () => {
  await withEnv({ CG_T_UNDEF: undefined, CG_T_UNDEF2: undefined }, async () => {
    const text = `{"project":"\${CG_T_UNDEF}",${SRC('${CG_T_UNDEF2}/a/${CG_T_UNDEF}')},"llm":{"provider":"dry","model":"\${CG_T_UNDEF2}"}}`;
    await withConfig(text, (file) => rejectsWith(file,
      /- project の \$\{CG_T_UNDEF\} は環境変数が未定義です/,
      /- sources\[0\]\.path の \$\{CG_T_UNDEF2\} は環境変数が未定義です/,
      /- sources\[0\]\.path の \$\{CG_T_UNDEF\} は環境変数が未定義です/,
      /- llm\.model の \$\{CG_T_UNDEF2\} は環境変数が未定義です/));
  });
});

test('env: エラーメッセージに他の変数の値を出さない', async () => {
  await withEnv({ CG_T_UNDEF: undefined, CG_T_SHOWN: 'visible-value-should-not-leak' }, async () => {
    const text = `{"project":"\${CG_T_SHOWN}",${SRC('${CG_T_UNDEF}/p')},${LLM}}`;
    await withConfig(text, (file) => assert.rejects(
      () => loadConfig(file),
      (e) => {
        assert.match(e.message, /sources\[0\]\.path の \$\{CG_T_UNDEF\} は環境変数が未定義です/);
        assert.doesNotMatch(e.message, /visible-value-should-not-leak/);
        return true;
      },
    ));
  });
});

test('env: 定義済みの変数は展開される（回帰ガード）', async () => {
  await withEnv({ CG_T_DEF: 'abc' }, async () => {
    const text = `{"project":"p-\${CG_T_DEF}",${SRC('/tmp/${CG_T_DEF}')},${LLM}}`;
    await withConfig(text, async (file) => {
      const c = await loadConfig(file);
      assert.equal(c.project, 'p-abc');
      assert.equal(c.sources[0].path, '/tmp/abc');
    });
  });
});

test('env: 定義済みで値が空文字なら空文字に展開して読み込める', async () => {
  await withEnv({ CG_T_EMPTY: '' }, async () => {
    const text = `{"project":"p-\${CG_T_EMPTY}-q",${SRC('/tmp')},${LLM}}`;
    await withConfig(text, async (file) => {
      const c = await loadConfig(file);
      assert.equal(c.project, 'p--q');
    });
  });
});

test('env: 設定と同じディレクトリの .env で定義した変数は展開される', async () => {
  await withEnv({ CG_T_FROMDOTENV: undefined }, async () => {
    const text = `{"project":"p-\${CG_T_FROMDOTENV}",${SRC('/tmp')},${LLM}}`;
    await withConfig(text, async (file) => {
      const c = await loadConfig(file);
      assert.equal(c.project, 'p-dotenv-value');
    }, { dotenv: 'CG_T_FROMDOTENV=dotenv-value\n' });
  });
});

test('env: ${constructor} / ${__proto__} / ${toString} は prototype を引かず未定義として拒否する', async () => {
  for (const name of ['constructor', '__proto__', 'toString']) {
    await withConfig(`{"project":"x",${SRC('/tmp')},"llm":{"provider":"dry","model":"\${${name}}"}}`, (file) => rejectsWith(file,
      new RegExp(`- llm\\.model の \\$\\{${name}\\} は環境変数が未定義です`)));
  }
});

test('env: 正規表現に一致しない ${} / ${1x} / ${a-b} / ${x は文字のまま通す', async () => {
  const cases = ['${}', '${1x}', '${a-b}', '${x'];
  for (const s of cases) {
    const text = `{"project":${JSON.stringify(`k-${s}-k`)},${SRC('/tmp')},${LLM}}`;
    await withConfig(text, async (file) => {
      const c = await loadConfig(file);
      assert.equal(c.project, `k-${s}-k`);
    });
  }
});

test('env: _ で始まるキー（配下のオブジェクト・配列を含む）は展開せず文字のまま通す', async () => {
  await withEnv({ CG_T_UNDEF: undefined, CG_T_DEF: 'abc' }, async () => {
    const text = '{"_comment":"a ${CG_T_UNDEF} b ${CG_T_DEF}","project":"x",'
      + '"_README":{"n":{"m":["${CG_T_UNDEF}",{"k":"${CG_T_UNDEF}"}]}},'
      + `"sources":[{"id":"w","type":"local","path":"/tmp","_comment":"\${CG_T_UNDEF}"}],`
      + '"llm":{"provider":"dry","model":"d","_note":["${CG_T_UNDEF}"]}}';
    await withConfig(text, async (file) => {
      const c = await loadConfig(file);
      assert.equal(c._comment, 'a ${CG_T_UNDEF} b ${CG_T_DEF}');
      assert.deepEqual(c._README, { n: { m: ['${CG_T_UNDEF}', { k: '${CG_T_UNDEF}' }] } });
      assert.equal(c.sources[0]._comment, '${CG_T_UNDEF}');
      assert.deepEqual(c.llm._note, ['${CG_T_UNDEF}']);
    });
  });
});

test('env: presets の instruction の未定義の ${VAR} はエラーにならず文字のまま通る', async () => {
  await withEnv({ CG_T_UNDEF: undefined }, async () => {
    const text = `{"project":"x",${SRC('/tmp')},${LLM},"presets":[`
      + '{"name":"a","task":"spec","instruction":"調べる ${CG_T_UNDEF} を"}]}';
    await withConfig(text, async (file) => {
      const c = await loadConfig(file);
      assert.equal(c.presets[0].instruction, '調べる ${CG_T_UNDEF} を');
      assert.deepEqual(validatePresets(c), []);
    });
  });
});

test('env: 秘密値を含む変数が展開された設定は従来どおり拒否される（回帰ガード）', async () => {
  await withEnv({ CG_T_API_TOKEN: 'env-test-secret-value-123' }, async () => {
    const text = `{"project":"x","sources":[{"id":"w","type":"confluence","baseUrl":"https://example.invalid/\${CG_T_API_TOKEN}"}],${LLM}}`;
    await withConfig(text, (file) => assert.rejects(() => loadConfig(file), /CG_T_API_TOKEN の値が展開/));
  });
});
