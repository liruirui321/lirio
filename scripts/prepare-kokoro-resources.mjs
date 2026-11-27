import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const ttsDir = path.join(repoRoot, 'src-tauri', 'resources', 'tts');

const MODEL_FILENAME = 'kokoro-v1.0.int8.onnx';
const MODEL_URL =
  'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx';
const VOICES_URL =
  'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin';

const REQUIRED_VOICES = ['af_heart', 'am_michael', 'bm_george'];
const EXPECTED_VOICE_BYTES = 510 * 256 * 4; // 522240 bytes float32 LE

function localKokoroCachePaths() {
  const home = os.homedir();
  const candidates = [
    path.join(home, 'Library', 'Application Support', 'local.aboboo.community', 'kokoro'),
    path.join(process.env.APPDATA || '', 'local.aboboo.community', 'kokoro'),
    path.join(home, '.local', 'share', 'local.aboboo.community', 'kokoro'),
  ];
  return candidates.filter((p) => p && fs.existsSync(p));
}

function alreadyReady() {
  const onnxPath = path.join(ttsDir, MODEL_FILENAME);
  if (!fs.existsSync(onnxPath) || fs.statSync(onnxPath).size < 50 * 1024 * 1024) {
    return false;
  }
  for (const name of REQUIRED_VOICES) {
    const vp = path.join(ttsDir, `${name}.bin`);
    if (!fs.existsSync(vp) || fs.statSync(vp).size !== EXPECTED_VOICE_BYTES) {
      return false;
    }
  }
  return true;
}

async function downloadToFile(url, destPath) {
  console.log(`[kokoro-prep] Downloading ${url} ...`);
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${resp.status}`);
  }
  const ab = await resp.arrayBuffer();
  const tmp = `${destPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, Buffer.from(ab));
  fs.renameSync(tmp, destPath);
}

function extractZipEntry(zipBuf, targetName) {
  // Locate End of Central Directory (0x06054b50) near end of file
  let eocdOff = -1;
  const minOff = Math.max(0, zipBuf.length - 65558);
  for (let i = zipBuf.length - 22; i >= minOff; i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) {
      eocdOff = i;
      break;
    }
  }
  if (eocdOff < 0) {
    throw new Error('Invalid voices zip: missing EOCD');
  }
  const totalEntries = zipBuf.readUInt16LE(eocdOff + 10);
  let cdOff = zipBuf.readUInt32LE(eocdOff + 16);

  for (let idx = 0; idx < totalEntries; idx++) {
    if (zipBuf.readUInt32LE(cdOff) !== 0x02014b50) {
      throw new Error(`Invalid central directory header at ${cdOff}`);
    }
    const method = zipBuf.readUInt16LE(cdOff + 10);
    const compSize = zipBuf.readUInt32LE(cdOff + 20);
    const nameLen = zipBuf.readUInt16LE(cdOff + 28);
    const extraLen = zipBuf.readUInt16LE(cdOff + 30);
    const commentLen = zipBuf.readUInt16LE(cdOff + 32);
    const localOff = zipBuf.readUInt32LE(cdOff + 42);
    const entryName = zipBuf.toString('utf8', cdOff + 46, cdOff + 46 + nameLen);
    cdOff += 46 + nameLen + extraLen + commentLen;

    if (entryName !== targetName) continue;
    if (zipBuf.readUInt32LE(localOff) !== 0x04034b50) {
      throw new Error(`Invalid local file header for ${entryName}`);
    }
    const lfNameLen = zipBuf.readUInt16LE(localOff + 26);
    const lfExtraLen = zipBuf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lfNameLen + lfExtraLen;
    const raw = zipBuf.subarray(dataStart, dataStart + compSize);
    if (method === 0) return Buffer.from(raw);
    if (method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`Unsupported zip compression method ${method} for ${entryName}`);
  }
  throw new Error(`Missing voice entry ${targetName} in voices archive`);
}

function stripNpyHeader(npyBuf, label) {
  if (
    npyBuf.length < 12 ||
    npyBuf[0] !== 0x93 ||
    npyBuf.toString('ascii', 1, 6) !== 'NUMPY'
  ) {
    throw new Error(`Invalid NPY header for ${label}`);
  }
  const major = npyBuf[6];
  const headerLen = major === 1 ? npyBuf.readUInt16LE(8) : npyBuf.readUInt32LE(8);
  const payloadOff = (major === 1 ? 10 : 12) + headerLen;
  const payload = npyBuf.subarray(payloadOff);
  if (payload.length !== EXPECTED_VOICE_BYTES) {
    throw new Error(
      `Unexpected voice vector payload size for ${label}: ${payload.length} !== ${EXPECTED_VOICE_BYTES}`,
    );
  }
  return payload;
}

async function main() {
  fs.mkdirSync(ttsDir, { recursive: true });
  if (alreadyReady()) {
    console.log('[kokoro-prep] All Kokoro TTS resources already present.');
    return;
  }

  const caches = localKokoroCachePaths();

  const onnxDest = path.join(ttsDir, MODEL_FILENAME);
  if (!fs.existsSync(onnxDest) || fs.statSync(onnxDest).size < 50 * 1024 * 1024) {
    let copied = false;
    for (const c of caches) {
      const candidate = path.join(c, MODEL_FILENAME);
      if (fs.existsSync(candidate) && fs.statSync(candidate).size > 50 * 1024 * 1024) {
        fs.copyFileSync(candidate, onnxDest);
        console.log(`[kokoro-prep] Copied ${MODEL_FILENAME} from local cache.`);
        copied = true;
        break;
      }
    }
    if (!copied) {
      await downloadToFile(MODEL_URL, onnxDest);
    }
  }

  let voicesZipPath = null;
  let cleanupZip = false;
  for (const c of caches) {
    const candidate = path.join(c, 'voices-v1.0.bin');
    if (fs.existsSync(candidate) && fs.statSync(candidate).size > 10 * 1024 * 1024) {
      voicesZipPath = candidate;
      break;
    }
  }
  if (!voicesZipPath) {
    voicesZipPath = path.join(os.tmpdir(), `kokoro-voices-${process.pid}.bin`);
    cleanupZip = true;
    await downloadToFile(VOICES_URL, voicesZipPath);
  }

  try {
    const zipBuf = fs.readFileSync(voicesZipPath);
    for (const voiceName of REQUIRED_VOICES) {
      const npyBuf = extractZipEntry(zipBuf, `${voiceName}.npy`);
      const vecBuf = stripNpyHeader(npyBuf, voiceName);
      fs.writeFileSync(path.join(ttsDir, `${voiceName}.bin`), vecBuf);
      console.log(`[kokoro-prep] Wrote ${voiceName}.bin (${vecBuf.length} bytes)`);
    }
  } finally {
    if (cleanupZip && voicesZipPath && fs.existsSync(voicesZipPath)) {
      fs.unlinkSync(voicesZipPath);
    }
  }
}

main().catch((err) => {
  console.error('[kokoro-prep] Error:', err);
  process.exit(1);
});
