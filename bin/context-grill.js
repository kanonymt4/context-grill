#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code ?? 0;
}).catch((err) => {
  process.stderr.write(`\n[context-grill] エラー: ${err?.message ?? err}\n`);
  if (process.env.CONTEXT_GRILL_DEBUG) process.stderr.write(String(err?.stack ?? '') + '\n');
  process.exitCode = 1;
});
