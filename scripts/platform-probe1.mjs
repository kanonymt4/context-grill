import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const NL = String.fromCharCode(10);
const r = {};
const t = (name, fn) => { try { const v = fn(); r[name] = v === undefined ? 'OK' : 'OK: ' + v; } catch (e) { r[name] = (e.code || 'ERR') + ': ' + String(e.message).split(NL)[0]; } };
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cgwin-'));

// 世代ディレクトリを模す: base/g1/docs.txt を開いたまま各操作を試す
const mkGen = (name, body) => { const d = path.join(base, name); fs.mkdirSync(path.join(d, 'postings'), { recursive: true }); fs.writeFileSync(path.join(d, 'docs.txt'), body); fs.writeFileSync(path.join(d, 'postings', '0.json'), '{}'); return d; };

const g1 = mkGen('g1', 'OLD-GENERATION-BODY');
const fd = fs.openSync(path.join(g1, 'docs.txt'), 'r');

t('A. fd を握ったまま世代ディレクトリを rm -rf', () => { fs.rmSync(g1, { recursive: true, force: true }); });
t('A2. rm 後もディレクトリが残っているか', () => fs.existsSync(g1) ? '残っている' : '消えた');

const g1b = fs.existsSync(g1) ? g1 : mkGen('g1', 'OLD-GENERATION-BODY');
t('B. fd を握ったまま世代ディレクトリを rename', () => { fs.renameSync(g1b, path.join(base, 'g1-retired')); });
t('B2. rename 後に握っていた fd から読めるか', () => { const b = Buffer.alloc(19); fs.readSync(fd, b, 0, 19, 0); return JSON.stringify(b.toString()); });

t('C. 開いているファイルを unlink', () => { const p = path.join(base, 'u.txt'); fs.writeFileSync(p, 'x'); const f = fs.openSync(p, 'r'); try { fs.unlinkSync(p); } finally { fs.closeSync(f); } });

// ポインタファイルの差し替え: 読み手が開いている最中に rename で上書きできるか
t('D. 読み手が開いているポインタファイルを rename で上書き', () => { const p = path.join(base, 'current'), tmp = path.join(base, 'current.tmp'); fs.writeFileSync(p, 'g1'); fs.writeFileSync(tmp, 'g2'); const f = fs.openSync(p, 'r'); try { fs.renameSync(tmp, p); } finally { fs.closeSync(f); } });
t('D2. 上書き後のポインタの中身', () => fs.readFileSync(path.join(base, 'current'), 'utf8'));

t('E. fd を閉じた後なら rm できるか', () => { fs.closeSync(fd); const d = fs.existsSync(path.join(base, 'g1-retired')) ? path.join(base, 'g1-retired') : g1b; fs.rmSync(d, { recursive: true, force: true }); return fs.existsSync(d) ? '残っている' : '消えた'; });

console.log(JSON.stringify({ platform: process.platform, node: process.version, results: r }, null, 2));
try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) {}