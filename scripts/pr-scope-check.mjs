#!/usr/bin/env node
import { execSync } from 'node:child_process';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg.startsWith('--')) {
    const next = process.argv[i + 1]?.startsWith('--') ? undefined : process.argv[i + 1];
    args.set(arg, next ?? true);
    if (next && !next.startsWith('--')) i += 1;
  }
}

function runGit(command) {
  try {
    return execSync(`git ${command}`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } catch (error) {
    const msg = error.stderr?.toString?.() || error.message || 'git command failed';
    throw new Error(msg);
  }
}

const base = args.get('--base') || process.env.GITHUB_BASE_REF || 'HEAD';
const maxFiles = Number(args.get('--max-files') ?? process.env.MAX_CHANGED_FILES ?? 5);
const maxDirs = Number(args.get('--max-dirs') ?? process.env.MAX_CHANGED_DIRS ?? 3);

function getChangedFiles() {
  const baseRef = base === 'HEAD' ? 'HEAD' : base;
  const diffRange = baseRef === 'HEAD' ? 'diff --name-only HEAD' : `diff --name-only ${baseRef}`;
  const output = runGit(diffRange);
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

const files = getChangedFiles();
if (files.length === 0) {
  console.log(`No changed files detected against ${base}. Scope gate passed.`);
  process.exit(0);
}

const dirs = new Set(
  files.map((file) => {
    const clean = file.replace(/^\.\//, '');
    const segments = clean.split('/');
    return segments.length > 1 ? segments[0] : '.';
  })
);

const crossCutting = files.some((file) => file.startsWith('src/index/')) && files.some((file) => file.startsWith('src/mcp/'));
let failed = false;
const reasons = [];

if (files.length > maxFiles) {
  failed = true;
  reasons.push(`Changed files (${files.length}) exceeds limit (${maxFiles}).`);
}

if (dirs.size > maxDirs) {
  failed = true;
  reasons.push(`Changed directories (${dirs.size}) exceeds limit (${maxDirs}).`);
}

if (crossCutting) {
  failed = true;
  reasons.push('This PR touches both src/index and src/mcp; split into a dedicated fix or defer the follow-up.');
}

if (failed) {
  console.error('PR scope check failed.');
  console.error(`Changed files (${files.length}):`);
  for (const file of files) console.error(`  - ${file}`);
  console.error(`Top-level directories: ${[...dirs].join(', ')}`);
  console.error('');
  for (const reason of reasons) console.error(`- ${reason}`);
  console.error('');
  console.error('Keep PRs to one root cause and one verification path. If another problem was found, defer it into a follow-up issue.');
  process.exit(1);
}

console.log(`Scope gate passed: ${files.length} files in ${dirs.size} directories.`);
