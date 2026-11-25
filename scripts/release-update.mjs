import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONF_PATH = path.join(ROOT, 'src-tauri', 'tauri.conf.json');
const DIST_DIR = path.join(ROOT, 'dist-release');

function parseArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : '';
}

const conf = JSON.parse(fs.readFileSync(CONF_PATH, 'utf8'));
const version = conf.version;
const keyPath =
  process.env.TAURI_SIGNING_PRIVATE_KEY_PATH || path.join(os.homedir(), '.tauri', 'lirio.key');

if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !fs.existsSync(keyPath)) {
  console.error(`Missing updater private key at ${keyPath}. Run: npx tauri signer generate -w ~/.tauri/lirio.key`);
  process.exit(1);
}

const baseUrl = (
  parseArg('--base-url') ||
  process.env.LIRIO_UPDATE_BASE_URL ||
  'https://github.com/liruirui321/lirio/releases/latest/download'
).replace(/\/+$/, '');
const notes = parseArg('--notes') || `Lirio v${version}`;

console.log(`[release-update] Building signed macOS updater artifacts for v${version}...`);
execFileSync(
  'npx',
  ['tauri', 'build', '--bundles', 'app', '--config', JSON.stringify({ bundle: { createUpdaterArtifacts: true } })],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...(process.env.TAURI_SIGNING_PRIVATE_KEY ? {} : { TAURI_SIGNING_PRIVATE_KEY_PATH: keyPath }),
    },
  },
);

const macosBundleDir = path.join(ROOT, 'target', 'release', 'bundle', 'macos');
const tarName = 'Lirio.app.tar.gz';
const tarPath = path.join(macosBundleDir, tarName);
const sigPath = path.join(macosBundleDir, `${tarName}.sig`);

if (!fs.existsSync(tarPath) || !fs.existsSync(sigPath)) {
  console.error(`Expected signed updater artifacts not found under ${macosBundleDir}`);
  process.exit(1);
}

fs.mkdirSync(DIST_DIR, { recursive: true });
const outTarName = `Lirio-${version}-${process.arch}.app.tar.gz`;
const outTarPath = path.join(DIST_DIR, outTarName);
const outSigPath = path.join(DIST_DIR, `${outTarName}.sig`);
fs.copyFileSync(tarPath, outTarPath);
fs.copyFileSync(sigPath, outSigPath);

const signature = fs.readFileSync(sigPath, 'utf8').trim();
const platformKey = process.arch === 'arm64' ? 'darwin-aarch64' : 'darwin-x86_64';
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    [platformKey]: {
      signature,
      url: `${baseUrl}/${outTarName}`,
    },
  },
};

fs.writeFileSync(path.join(DIST_DIR, 'latest.json'), JSON.stringify(manifest, null, 2));
console.log(`[release-update] Ready in ${DIST_DIR}:`);
console.log(`  - ${outTarName}`);
console.log(`  - ${outTarName}.sig`);
console.log(`  - latest.json (url: ${manifest.platforms[platformKey].url})`);
