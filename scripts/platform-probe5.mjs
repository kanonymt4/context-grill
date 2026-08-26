import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const SELF = fileURLToPath(import.meta.url);
const NL = String.fromCharCode(10);
if (process.argv[2] === 'holder') {
  const fds = process.argv.slice(3).map((f) => fs.openSync(f, 'r'));
  process.stdout.write('READY' + NL);
  process.stdin.on('data', () => { for (const fd of fds) { try { fs.closeSync(fd); } catch (e) {} } process.exit(0); });
  setTimeout(() => process.exit(0), 120000);
} else {
  const DIR = path.join(process.cwd(), 'tmp-e7');
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const pad = (n) => String(n).padStart(4, '0');
  const body = 'x'.repeat(256 * 1024);
  const filesOf = (g) => [path.join(DIR, 'docs.' + pad(g) + '.txt'), path.join(DIR, 'idx.' + pad(g) + '.json')];
  const writeGen = (g) => { const [d, i] = filesOf(g); fs.writeFileSync(d, 'GEN' + g + NL + body); fs.writeFileSync(i, JSON.stringify({ gen: g })); };
  const out = { platform: process.platform, node: process.version };
  writeGen(1);
  fs.writeFileSync(path.join(DIR, 'state.json'), JSON.stringify({ gen: 1 }));
  const holder = await new Promise((res) => { const p = spawn(process.execPath, [SELF, 'holder', ...filesOf(1)], { stdio: ['pipe', 'pipe', 'inherit'] }); let b = ''; p.stdout.on('data', (d) => { b += d; if (b.includes('READY')) res(p); }); });
  const unlinkFails = [];
  const CYCLES = 20;
  for (let g = 2; g <= CYCLES + 1; g++) {
    writeGen(g);
    fs.writeFileSync(path.join(DIR, 'state.json'), JSON.stringify({ gen: g }));
    for (const f of filesOf(g - 1)) { try { fs.unlinkSync(f); } catch (e) { unlinkFails.push({ file: path.basename(f), code: e.code }); } }
  }
  const listing = fs.readdirSync(DIR).sort();
  out.保持中の残存ファイル = listing;
  out.残存ファイル数 = listing.length;
  out.残存合計バイト = listing.reduce((a, f) => { try { return a + fs.statSync(path.join(DIR, f)).size; } catch (e) { return a; } }, 0);
  out.unlink失敗 = unlinkFails;
  out.gen1がexistsSyncで見えるか = fs.existsSync(filesOf(1)[0]);
  await new Promise((res) => { holder.on('exit', res); holder.stdin.write(NL); });
  const after = fs.readdirSync(DIR).sort();
  out.holder終了後の残存ファイル = after;
  try { fs.unlinkSync(filesOf(1)[0]); out.holder終了後にgen1を再unlink = 'OK'; } catch (e) { out.holder終了後にgen1を再unlink = e.code + ': ' + String(e.message).split(NL)[0]; }
  out.最終残存ファイル = fs.readdirSync(DIR).sort();
  console.log(JSON.stringify(out, null, 2));
  fs.rmSync(DIR, { recursive: true, force: true });
}