import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const SELF = fileURLToPath(import.meta.url);
const NL = String.fromCharCode(10);

if (process.argv[2] === 'child') {
  const fds = process.argv.slice(3).map(f => fs.openSync(f, 'r'));
  process.stdout.write('READY' + NL);
  process.stdin.on('data', () => { for (const fd of fds) { try { fs.closeSync(fd); } catch (e) {} } process.exit(0); });
  setTimeout(() => process.exit(0), 60000);
} else {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cgwin2-'));
  const r = {};
  const t = (name, fn) => { try { const v = fn(); r[name] = v === undefined ? 'OK' : 'OK: ' + v; } catch (e) { r[name] = (e.code || 'ERR') + ': ' + String(e.message).split(NL)[0]; } };
  const holdOpen = (files) => new Promise((res) => {
    const c = spawn(process.execPath, [SELF, 'child', ...files], { stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    c.stdout.on('data', (d) => { buf += d; if (buf.includes('READY')) res(c); });
  });
  const stop = (c) => new Promise((res) => { c.on('exit', res); c.stdin.write(NL); });
  const mkgen = (name) => { const d = path.join(base, name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'docs.txt'), 'OLD-BODY'); fs.writeFileSync(path.join(d, 'docs.txt.tmp'), 'NEW-BODY'); return d; };

  // --- 別プロセスが docs.txt を開いている最中の各操作（finish() の実際の状況） ---
  { const d = mkgen('s1'); const c = await holdOpen([path.join(d, 'docs.txt')]);
    t('P1. 保持中に rename(docs.txt.tmp -> docs.txt) = finish() の実動作', () => { fs.renameSync(path.join(d, 'docs.txt.tmp'), path.join(d, 'docs.txt')); });
    t('P1b. 上書き後の docs.txt の中身', () => fs.readFileSync(path.join(d, 'docs.txt'), 'utf8'));
    t('P2. 保持中に writeFile で docs.txt を上書き', () => { fs.writeFileSync(path.join(d, 'docs.txt'), 'W-BODY'); });
    t('P3. 保持中に unlink(docs.txt)', () => { fs.unlinkSync(path.join(d, 'docs.txt')); });
    t('P4. 保持中に rmSync(世代ディレクトリ, recursive)', () => { fs.rmSync(d, { recursive: true, force: true }); return fs.existsSync(d) ? '残っている' : '消えた'; });
    await stop(c); }

  { const d = mkgen('s2'); const c = await holdOpen([path.join(d, 'docs.txt')]);
    t('P5. 保持中に世代ディレクトリを rename', () => { fs.renameSync(d, path.join(base, 's2-retired')); });
    t('P5b. rename が通った場合、握った側から旧世代を読めるか(親側で再確認)', () => fs.existsSync(path.join(base, 's2-retired')) ? 'rename された' : 'rename されていない');
    await stop(c); }

  // --- ポインタファイルの差し替え（別プロセス版） ---
  { const p = path.join(base, 'current'), tmp = path.join(base, 'current.tmp');
    fs.writeFileSync(p, 'g1'); fs.writeFileSync(tmp, 'g2');
    const c = await holdOpen([p]);
    t('P6. 別プロセスが開いているポインタを rename で上書き', () => { fs.renameSync(tmp, p); });
    t('P6b. 上書き後のポインタの中身', () => fs.readFileSync(p, 'utf8'));
    await stop(c); }

  // --- マーカーの部品（作成・排他・削除） ---
  { const m = path.join(base, 'building.marker');
    t('P7. openSync(marker, wx) 不在時の排他作成', () => { const f = fs.openSync(m, 'wx'); fs.closeSync(f); });
    t('P8. openSync(marker, wx) 存在時は EEXIST になるか', () => { const f = fs.openSync(m, 'wx'); fs.closeSync(f); return '例外にならなかった'; });
    const c = await holdOpen([m]);
    t('P9. 別プロセスが開いている marker を unlink', () => { fs.unlinkSync(m); });
    t('P10. unlink 後に existsSync が false になるか', () => fs.existsSync(m) ? 'true のまま' : 'false になった');
    t('P11. unlink 後に同名を wx で作り直せるか', () => { const f = fs.openSync(m, 'wx'); fs.closeSync(f); });
    await stop(c); }

  // --- ベースライン（誰も開いていない） ---
  { const d = mkgen('s3');
    t('P12. 誰も開いていない時の rename 上書き', () => { fs.renameSync(path.join(d, 'docs.txt.tmp'), path.join(d, 'docs.txt')); return fs.readFileSync(path.join(d, 'docs.txt'), 'utf8'); }); }

  console.log(JSON.stringify({ platform: process.platform, node: process.version, results: r }, null, 2));
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) {}
}