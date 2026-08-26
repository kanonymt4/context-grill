#!/usr/bin/env node
// 世代番号つきファイル名で公開するときの rename が Windows で通るかを測る。
//
// これまでの実測（platform-probe1 / 2）で分かっているのは「開いているファイルを
// rename の宛先にすると EPERM」という点。世代番号方式では宛先が毎回まだ存在しない
// 名前になるので、その条件では通るはずだが、確かめていない。
//
// あわせて、公開直後に別プロセスがその名前を開いている状態で、次の世代を公開し、
// 旧世代を unlink できるか（＝掃除が止まらないか）も見る。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const NL = String.fromCharCode(10);

if (process.argv[2] === 'holder') {
  const fds = process.argv.slice(3).map((f) => fs.openSync(f, 'r'));
  process.stdout.write('READY' + NL);
  process.stdin.on('data', () => { for (const fd of fds) { try { fs.closeSync(fd); } catch (e) {} } process.exit(0); });
  setTimeout(() => process.exit(0), 60000);
} else {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cgpub-'));
  const r = {};
  const t = (name, fn) => {
    try { const v = fn(); r[name] = v === undefined ? 'OK' : 'OK: ' + v; }
    catch (e) { r[name] = (e.code || 'ERR') + ': ' + String(e.message).split(NL)[0]; }
  };
  const holdOpen = (files) => new Promise((res) => {
    const c = spawn(process.execPath, [SELF, 'holder', ...files], { stdio: ['pipe', 'pipe', 'inherit'] });
    let b = '';
    c.stdout.on('data', (d) => { b += d; if (b.includes('READY')) res(c); });
  });
  const stop = (c) => new Promise((res) => { c.on('exit', res); c.stdin.write(NL); });

  const pad = (n) => String(n).padStart(4, '0');
  const man = (g) => path.join(base, `manifest.${pad(g)}.json`);
  const docs = (g) => path.join(base, `docs.${pad(g)}.txt`);
  const publish = (g) => {
    fs.writeFileSync(docs(g), 'GEN' + g);
    const tmp = man(g) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ gen: g }));
    fs.renameSync(tmp, man(g));
  };

  // Q1: 宛先がまだ存在しない名前への rename（世代の公開そのもの）
  t('Q1. 未使用の名前へ rename して世代 1 を公開', () => { publish(1); });
  t('Q1b. 公開した manifest の中身', () => fs.readFileSync(man(1), 'utf8'));

  // Q2: 読み手が世代 1 を開いたまま、世代 2 を公開できるか
  const c1 = await holdOpen([man(1), docs(1)]);
  t('Q2. 世代 1 を別プロセスが開いたまま、世代 2 を rename で公開', () => { publish(2); });
  t('Q2b. 世代 2 の manifest の中身', () => fs.readFileSync(man(2), 'utf8'));

  // Q3: そのまま旧世代を unlink できるか（掃除が止まらないか）
  t('Q3. 開かれている世代 1 の manifest を unlink', () => { fs.unlinkSync(man(1)); });
  t('Q4. 開かれている世代 1 の docs を unlink', () => { fs.unlinkSync(docs(1)); });
  t('Q5. unlink 後 readdir に残るか', () => {
    const left = fs.readdirSync(base).filter((f) => f.includes('0001'));
    return left.length ? '残る: ' + left.join(',') : '残らない';
  });
  t('Q6. unlink 後 existsSync は false か', () => (fs.existsSync(man(1)) ? 'true のまま' : 'false'));

  // Q7: 走査で最大世代を選べるか（消したはずの世代を掴まないか）
  t('Q7. 走査で選ばれる最大世代', () => {
    let max = -1;
    for (const f of fs.readdirSync(base)) {
      const m = /^manifest\.(\d{4})\.json$/.exec(f);
      if (m) { const g = Number(m[1]); if (g > max) max = g; }
    }
    return String(max);
  });

  await stop(c1);
  t('Q8. holder 終了後に世代 1 が消えているか', () => {
    const left = fs.readdirSync(base).filter((f) => f.includes('0001'));
    return left.length ? '残る: ' + left.join(',') : '残らない';
  });

  // Q9: 同じ世代番号を作り直す（本来しないが、踏んだら EPERM になるはずの操作）
  t('Q9. unlink 済みの名前を同じ世代番号で作り直す', () => { publish(1); });

  console.log(JSON.stringify({ platform: process.platform, node: process.version, results: r }, null, 2));
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
}
