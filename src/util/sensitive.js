import path from 'node:path';
import { matchGlob } from './misc.js';

/**
 * 索引対象から無条件で除外するパス。
 * include 設定より優先される（"**\/*" を指定しても取り込まれない）。
 */
export const SENSITIVE_DENY = [
  '**/.env', '**/.env.*', '.env', '.env.*',
  '**/.envrc', '.envrc',
  '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/*.jks', '**/*.keystore', '**/*.der', '**/*.crt.key',
  '**/id_rsa*', '**/id_dsa*', '**/id_ecdsa*', '**/id_ed25519*', 'id_rsa*', 'id_ed25519*',
  '**/.ssh/**', '.ssh/**',
  '**/.netrc', '.netrc', '**/_netrc', '**/.npmrc', '.npmrc', '**/.pypirc', '**/.git-credentials',
  '**/.aws/**', '.aws/**', '**/.azure/**', '**/.docker/config.json', '**/.kube/**',
  '**/kubeconfig', '**/*.kubeconfig',
  '**/credentials', '**/credentials.json', '**/service-account*.json', '**/serviceAccount*.json',
  '**/*.secrets.*', '**/secrets.yaml', '**/secrets.yml', '**/secrets.json', '**/secret.yaml', '**/secret.yml',
  '**/.htpasswd', '**/*.ovpn', '**/*.asc', '**/*.gpg', '**/*.pgp',
  '**/*.tfstate', '**/*.tfstate.*', '**/.terraform/**',
  '**/.context-grill/**', '.context-grill/**',
  '**/.DS_Store',
];

/** 例外的に許可するサンプルファイル */
const ALLOW_EXAMPLES = [
  '**/.env.example', '**/.env.sample', '**/.env.template', '**/.env.dist', '**/.env.test.example',
  '.env.example', '.env.sample', '.env.template', '.env.dist',
];

export function isSensitivePath(p, extraDeny = []) {
  const norm = String(p).replace(/\\/g, '/');
  for (const a of ALLOW_EXAMPLES) if (matchGlob(norm, a)) return false;
  for (const d of SENSITIVE_DENY) if (matchGlob(norm, d)) return true;
  for (const d of extraDeny) if (matchGlob(norm, d)) return true;
  // ディレクトリ名単位でも判定（walk 時の枝刈り用）
  const parts = norm.split('/');
  if (parts.some((seg) => seg === '.ssh' || seg === '.aws' || seg === '.kube' || seg === '.terraform' || seg === '.context-grill')) return true;
  return false;
}

/** walk 時にディレクトリごと降りないための判定 */
export function isSensitiveDir(name) {
  return ['.ssh', '.aws', '.azure', '.kube', '.terraform', '.context-grill', '.git', 'node_modules'].includes(name);
}

/** 相対パス p が root 配下に収まっているか（パストラバーサル防止） */
export function isInside(root, target) {
  const r = path.resolve(root) + path.sep;
  const t = path.resolve(target);
  return t === path.resolve(root) || t.startsWith(r);
}
