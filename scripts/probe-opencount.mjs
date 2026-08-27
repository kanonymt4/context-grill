#!/usr/bin/env node
// close() したストアを読もうとしたときの振る舞いを測る。
//
// fd を open() の時点で確保する前は、close() 後の読み取りが遅延オープンで黙って
// 開き直していた。そのため所有権違反（呼ばれた側がストアを閉じる）を直接には
// 検知できず、IndexStore.openCount の増分という間接証拠に頼っていた。
//
// 今は open() で確保するので、close() 後の読み取りは開き直さずに例外になる。
// openCount は増えないので、その検知手段は使えない（CLAUDE.md の UNVERIFIED-008）。
// このスクリプトはその 2 点を実測で示す。遅延オープンが戻ったら出力が変わる。
//
//   node scripts/probe-opencount.mjs
//
import fsp from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path';
import { IndexBuilder, IndexStore } from '../src/index/store.js';
const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cg-probe-'));
const b = new IndexBuilder(dir); await b.start();
b.add({ id:'s:a.js#0', docId:'s:a.js', sourceId:'s', sourceType:'local', path:'a.js', title:'a.js', kind:'code', lang:'js', url:null, version:'1', meta:{}, start:1, end:3, hash:'0', ntok:10, text:'function refundPayment() {}' });
await b.finish({ indexKey:'k' });
const store = await IndexStore.open(dir);
console.log('open 直後      : _fd=' + (store._fd !== null) + ' openCount=' + IndexStore.openCount);
console.log('1回目 textOf   : ' + JSON.stringify(store.textOf(0)));
const before = IndexStore.openCount;
await store.close();
console.log('close 後       : _fd=' + (store._fd !== null) + ' openCount=' + IndexStore.openCount);
try { const t = store.textOf(0); console.log('2回目 textOf   : 成功 ' + JSON.stringify(t)); }
catch (e) { console.log('2回目 textOf   : 例外 ' + e.code + ' / ' + e.message.slice(0,60)); }
console.log('openCount 差分 : ' + (IndexStore.openCount - before) + '  (>0 なら開き直しが起きた)');
await fsp.rm(dir, { recursive:true, force:true });
