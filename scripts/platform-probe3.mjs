import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const NL = String.fromCharCode(10);
const ROOT = process.cwd();
const WS = path.join(ROOT, 'tmp-e5');
const SRC = path.join(WS, 'src');
fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(SRC, { recursive: true });
for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(SRC, 'f' + i + '.md'), '# doc ' + i + NL + 'refundPayment retryWithBackoff alpha beta gamma delta ' + i + NL);
const CFG = path.join(WS, 'c.json');
fs.writeFileSync(CFG, JSON.stringify({ project: 'e5', workspaceDir: path.join(WS, 'wsdir'), sources: [{ id: 'a', type: 'local', path: SRC, include: ['**'] }], llm: { provider: 'dry', model: 'dry' } }));
const srv = spawn(process.execPath, [path.join(ROOT, 'bin', 'context-grill.js'), 'mcp', '--config', CFG], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '', stderr = '';
const pending = new Map();
srv.stderr.on('data', (d) => { stderr += d; });
srv.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf(NL)) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m = null; try { m = JSON.parse(line); } catch (e) { continue; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
let idc = 0;
const rpc = (method, params) => new Promise((res, rej) => { const id = ++idc; pending.set(id, res); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + NL); setTimeout(() => rej(new Error('timeout')), 120000); });
const call = async (name, args) => { try { const r = await rpc('tools/call', { name, arguments: args || {} }); return JSON.stringify(r.error || r.result).slice(0, 260); } catch (e) { return 'EXC: ' + e.message; } };
const out = { platform: process.platform, node: process.version };
await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'p', version: '1' } });
out.s1_初回sync = await call('context_grill_sync');
out.s2_検索 = await call('context_grill_search', { query: 'refundPayment' });
out.s3_検索後のsync = await call('context_grill_sync');
out.s4_再検索 = await call('context_grill_search', { query: 'refundPayment' });
out.s5_さらにsync = await call('context_grill_sync');
// SIGTERM だと子が落ちきらずパイプが開いたまま残り、出力を出し切った後もこのプロセスが
// 終わらない。test/mcp.test.js と同じ理由で SIGKILL を使う（Windows には SIGTERM が無い）。
srv.kill('SIGKILL');
out.stderr末尾 = stderr.slice(-400);
console.log(JSON.stringify(out, null, 2));
try { fs.rmSync(WS, { recursive: true, force: true }); } catch (e) {}
process.exit(0);
