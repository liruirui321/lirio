import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function patchManifestXml(xml) {
  let out = String(xml || '');
  const perms = [
    '<uses-permission android:name="android.permission.RECORD_AUDIO" />',
    '<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />',
  ];
  const missing = perms.filter((p) => {
    const attr = p.match(/android:name="([^"]+)"/)?.[1] || '';
    return !out.includes(attr);
  });
  if (missing.length > 0) {
    const idx = out.indexOf('<application');
    if (idx >= 0) {
      out = `${out.slice(0, idx)}${missing.map((m) => `    ${m}\n`).join('')}${out.slice(idx)}`;
    } else {
      const mIdx = out.indexOf('</manifest>');
      if (mIdx >= 0) {
        out = `${out.slice(0, mIdx)}${missing.map((m) => `    ${m}\n`).join('')}${out.slice(mIdx)}`;
      }
    }
  }
  return out;
}

export function patchMainActivityKt(kt) {
  let out = String(kt || '');
  const imports = [
    'import android.Manifest',
    'import android.content.pm.PackageManager',
    'import android.os.Bundle',
    'import androidx.core.app.ActivityCompat',
    'import androidx.core.content.ContextCompat',
  ];

  const missingImports = imports.filter((imp) => !out.includes(imp));
  if (missingImports.length > 0) {
    const pkgMatch = out.match(/^package\s+[^\r\n]+\r?\n/m);
    if (pkgMatch) {
      const insertAt = pkgMatch.index + pkgMatch[0].length;
      out = `${out.slice(0, insertAt)}${missingImports.join('\n')}\n${out.slice(insertAt)}`;
    } else {
      out = `${missingImports.join('\n')}\n${out}`;
    }
  }

  if (!out.includes('RECORD_AUDIO')) {
    const checkSnippet = [
      '    if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {',
      '      ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.RECORD_AUDIO), 1001)',
      '    }',
    ].join('\n');

    const superOnCreateMatch = out.match(/super\.onCreate\([^\)]*\)[ \t]*\r?\n/);
    if (superOnCreateMatch) {
      const insertAt = superOnCreateMatch.index + superOnCreateMatch[0].length;
      out = `${out.slice(0, insertAt)}${checkSnippet}\n${out.slice(insertAt)}`;
    } else {
      const classMatch = out.match(/class\s+MainActivity[^\n{]*\{[ \t]*\r?\n/);
      if (classMatch) {
        const insertAt = classMatch.index + classMatch[0].length;
        const methodBlock = [
          '  override fun onCreate(savedInstanceState: Bundle?) {',
          '    super.onCreate(savedInstanceState)',
          checkSnippet,
          '  }',
        ].join('\n');
        out = `${out.slice(0, insertAt)}${methodBlock}\n${out.slice(insertAt)}`;
      }
    }
  }

  return out;
}

function findMainActivityKt(javaRoot) {
  if (!fs.existsSync(javaRoot)) return null;
  const stack = [javaRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && ent.name === 'MainActivity.kt') return full;
    }
  }
  return null;
}

export function patchAndroidProject(androidRoot = path.resolve('src-tauri/gen/android')) {
  const manifestPath = path.join(androidRoot, 'app/src/main/AndroidManifest.xml');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`AndroidManifest.xml not found at ${manifestPath}`);
  }
  const origManifest = fs.readFileSync(manifestPath, 'utf8');
  const nextManifest = patchManifestXml(origManifest);
  if (nextManifest !== origManifest) {
    fs.writeFileSync(manifestPath, nextManifest, 'utf8');
  }

  const javaRoot = path.join(androidRoot, 'app/src/main/java');
  const mainActPath = findMainActivityKt(javaRoot);
  if (!mainActPath) {
    throw new Error(`MainActivity.kt not found under ${javaRoot}`);
  }
  const origKt = fs.readFileSync(mainActPath, 'utf8');
  const nextKt = patchMainActivityKt(origKt);
  if (nextKt !== origKt) {
    fs.writeFileSync(mainActPath, nextKt, 'utf8');
  }
  return { manifestPath, mainActPath };
}

function runSelfTest() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lirio-android-mic-'));
  try {
    const manifestPath = path.join(tmpRoot, 'app/src/main/AndroidManifest.xml');
    const mainActPath = path.join(tmpRoot, 'app/src/main/java/local/aboboo/community/MainActivity.kt');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.mkdirSync(path.dirname(mainActPath), { recursive: true });

    fs.writeFileSync(
      manifestPath,
      `<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n    <uses-permission android:name="android.permission.INTERNET" />\n    <application android:label="Lirio">\n    </application>\n</manifest>\n`,
      'utf8',
    );
    fs.writeFileSync(
      mainActPath,
      `package local.aboboo.community\n\nclass MainActivity : TauriActivity()\n`,
      'utf8',
    );

    // Note: test both empty class and class with block braces
    fs.writeFileSync(
      mainActPath,
      `package local.aboboo.community\n\nclass MainActivity : TauriActivity() {\n}\n`,
      'utf8',
    );

    patchAndroidProject(tmpRoot);
    const firstManifest = fs.readFileSync(manifestPath, 'utf8');
    const firstKt = fs.readFileSync(mainActPath, 'utf8');
    assert.ok(firstManifest.includes('android.permission.RECORD_AUDIO'));
    assert.ok(firstManifest.includes('android.permission.MODIFY_AUDIO_SETTINGS'));
    assert.ok(firstKt.includes('ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.RECORD_AUDIO), 1001)'));
    assert.ok(firstKt.includes('override fun onCreate(savedInstanceState: Bundle?)'));

    // Re-run to assert idempotency
    patchAndroidProject(tmpRoot);
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), firstManifest);
    assert.equal(fs.readFileSync(mainActPath, 'utf8'), firstKt);
    console.log('patch-android-mic self-test PASSED');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
} else if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const res = patchAndroidProject();
  console.log('Patched Android microphone permissions:', res);
}
