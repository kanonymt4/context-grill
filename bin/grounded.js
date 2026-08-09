#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code ?? 0;
}).catch((err) => {
  process.stderr.write(`\n[grounded] エラー: ${err?.message ?? err}\n`);
  if (process.env.GROUNDED_DEBUG) process.stderr.write(String(err?.stack ?? '') + '\n');
  process.exitCode = 1;
});
