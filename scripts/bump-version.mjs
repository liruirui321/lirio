import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function parseArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : '';
}

const nextVersion = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!nextVersion || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(nextVersion)) {
  console.error('Usage: npm run version:bump -- <semver> [--notes "更新说明"]');
  process.exit(1);
}

const notes = parseArg('--notes') || `Lirio v${nextVersion} 跨端同步更新`;
const today = new Date().toISOString().slice(0, 10);

// 1. package.json
const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = nextVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// 2. src-tauri/tauri.conf.json
const tauriConfPath = path.join(ROOT, 'src-tauri', 'tauri.conf.json');
const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
tauriConf.version = nextVersion;
fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');

// 3. src-tauri/Cargo.toml
const cargoPath = path.join(ROOT, 'src-tauri', 'Cargo.toml');
const cargoRaw = fs.readFileSync(cargoPath, 'utf8');
const cargoUpdated = cargoRaw.replace(
  /^version\s*=\s*"[^"]+"/m,
  `version = "${nextVersion}"`,
);
fs.writeFileSync(cargoPath, cargoUpdated);

// 4. website/versions.json
const versionsPath = path.join(ROOT, 'website', 'versions.json');
if (fs.existsSync(versionsPath)) {
  const vJson = JSON.parse(fs.readFileSync(versionsPath, 'utf8'));
  const base = (vJson.releaseBaseUrl || 'https://github.com/liruirui321/lirio/releases/latest/download').replace(/\/+$/, '');
  vJson.latestVersion = nextVersion;
  vJson.releaseDate = today;
  vJson.platforms = {
    ...vJson.platforms,
    macos: {
      ...vJson.platforms.macos,
      version: nextVersion,
      filename: `Lirio-${nextVersion}-macos.dmg`,
      downloadUrl: `${base}/Lirio-${nextVersion}-macos.dmg`,
    },
    windows: {
      ...vJson.platforms.windows,
      version: nextVersion,
      filename: `Lirio-${nextVersion}-windows-x64-setup.exe`,
      downloadUrl: `${base}/Lirio-${nextVersion}-windows-x64-setup.exe`,
    },
    android: {
      ...vJson.platforms.android,
      version: nextVersion,
      filename: `Lirio-${nextVersion}-android.apk`,
      downloadUrl: `${base}/Lirio-${nextVersion}-android.apk`,
    },
    ios: {
      ...vJson.platforms.ios,
      version: nextVersion,
      filename: `Lirio-${nextVersion}-ios.ipa`,
      downloadUrl: `${base}/Lirio-${nextVersion}-ios.ipa`,
    },
  };
  const existing = Array.isArray(vJson.history) ? vJson.history : [];
  vJson.history = [
    { version: nextVersion, date: today, highlights: [notes] },
    ...existing.filter((item) => item.version !== nextVersion),
  ].slice(0, 12);
  fs.writeFileSync(versionsPath, JSON.stringify(vJson, null, 2) + '\n');
}

// 5. CHANGELOG.md
const changelogPath = path.join(ROOT, 'CHANGELOG.md');
if (fs.existsSync(changelogPath)) {
  const raw = fs.readFileSync(changelogPath, 'utf8');
  const entry = `## ${nextVersion} — ${today}\n\n- ${notes}\n\n\n`;
  if (!raw.includes(`## ${nextVersion}`)) {
    const updated = raw.startsWith('# Changelog\n')
      ? raw.replace('# Changelog\n\n', `# Changelog\n\n${entry}`)
      : `${entry}${raw}`;
    fs.writeFileSync(changelogPath, updated);
  }
}

console.log(`[version:bump] Synced version v${nextVersion} across package.json, Cargo.toml, tauri.conf.json, website/versions.json, and CHANGELOG.md.`);
