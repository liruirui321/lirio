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
  'https://lirio.deltae.tech/releases'
).replace(/\/+$/, '');
const notes = parseArg('--notes') || `Lirio v${version}`;
const shouldUpload = process.argv.includes('--upload');
const remoteHost = (process.env.LIRIO_DEPLOY_HOST || '').trim();

const keyPassPath =
  process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD_PATH || `${keyPath}.pass`;
const signingPassword =
  process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??
  (fs.existsSync(keyPassPath) ? fs.readFileSync(keyPassPath, 'utf8').trim() : '');

const buildEnv = {
  ...process.env,
  VITE_LIRIO_SERVER_URL: process.env.VITE_LIRIO_SERVER_URL || 'https://lirio.deltae.tech',
  TAURI_SIGNING_PRIVATE_KEY:
    process.env.TAURI_SIGNING_PRIVATE_KEY || fs.readFileSync(keyPath, 'utf8').trim(),
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: signingPassword,
};

console.log(`[release-update] Building signed macOS updater artifacts for v${version}...`);
execFileSync(
  'npx',
  ['tauri', 'build', '--bundles', 'app', '--config', JSON.stringify({ bundle: { createUpdaterArtifacts: true } })],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: buildEnv,
  },
);

const macosBundleDir = path.join(ROOT, 'target', 'release', 'bundle', 'macos');
const tarName = 'Lirio.app.tar.gz';
const tarPath = path.join(macosBundleDir, tarName);
const sigPath = path.join(macosBundleDir, `${tarName}.sig`);
const appPath = path.join(macosBundleDir, 'Lirio.app');

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

const outDmgName = `Lirio-${version}-macos.dmg`;
const outDmgPath = path.join(DIST_DIR, outDmgName);
let copiedDmg = false;
if (fs.existsSync(appPath)) {
  console.log(`[release-update] Creating ${outDmgName} via hdiutil...`);
  execFileSync(
    'hdiutil',
    ['create', '-volname', 'Lirio', '-srcfolder', appPath, '-ov', '-format', 'UDZO', outDmgPath],
    { stdio: 'inherit' },
  );
  copiedDmg = true;
}

const signature = fs.readFileSync(sigPath, 'utf8').trim();
const platformKey = process.arch === 'arm64' ? 'darwin-aarch64' : 'darwin-x86_64';
const platforms = {
  [platformKey]: {
    signature,
    url: `${baseUrl}/${outTarName}`,
  },
};
const winSigPath = path.join(DIST_DIR, `Lirio-${version}-windows-x64-setup.exe.sig`);
if (fs.existsSync(winSigPath)) {
  platforms['windows-x86_64'] = {
    signature: fs.readFileSync(winSigPath, 'utf8').trim(),
    url: `${baseUrl}/Lirio-${version}-windows-x64-setup.exe`,
  };
}
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
};

fs.writeFileSync(path.join(DIST_DIR, 'latest.json'), JSON.stringify(manifest, null, 2));
console.log(`[release-update] Ready in ${DIST_DIR}:`);
console.log(`  - ${outTarName}`);
console.log(`  - ${outTarName}.sig`);
if (copiedDmg) console.log(`  - ${outDmgName}`);
console.log(`  - latest.json (url: ${manifest.platforms[platformKey].url})`);

if (shouldUpload) {
  if (!remoteHost) {
    console.error('[release-update] Missing LIRIO_DEPLOY_HOST environment variable for --upload.');
    process.exit(1);
  }
  console.log(`[release-update] Uploading ${DIST_DIR}/ to ${remoteHost}:/opt/lirio/releases/ ...`);
  execFileSync('rsync', ['-avz', `${DIST_DIR}/`, `${remoteHost}:/opt/lirio/releases/`], {
    stdio: 'inherit',
  });
  console.log(`[release-update] Live update check URL: https://lirio.deltae.tech/api/updates/${platformKey.replace('-', '/')}/0.0.1`);
}
