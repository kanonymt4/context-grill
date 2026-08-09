import { syncGithub } from './github.js';
import { syncConfluence } from './confluence.js';
import { syncJira } from './jira.js';
import { syncLocal } from './local.js';

export const CONNECTORS = {
  github: syncGithub,
  confluence: syncConfluence,
  jira: syncJira,
  local: syncLocal,
};

export async function syncSource(src, ctx) {
  const fn = CONNECTORS[src.type];
  if (!fn) throw new Error(`未対応のソース種別: ${src.type}`);
  return fn(src, ctx);
}
