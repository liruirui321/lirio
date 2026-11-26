import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function patchManifestXml(xml) {
  let out = String(xml || '');
  const perms = [
    '<uses-permission android:name="android.permission.RECORD_AUDIO" />',
    '<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />',
    '<uses-permission android:name="android.permission.INTERNET" />',
    '<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />',
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

  // Ensure MainActivity uses adjustResize so the soft keyboard doesn't cover chat/input bars
  out = out.replace(/<activity\b[^>]*android:name="[^"]*MainActivity"[^>]*>/g, (tag) => {
    if (/android:windowSoftInputMode=/.test(tag)) {
      return tag.replace(
        /android:windowSoftInputMode="[^"]*"/,
        'android:windowSoftInputMode="adjustResize"',
      );
    }
    if (tag.endsWith('/>')) {
      return `${tag.slice(0, -2)} android:windowSoftInputMode="adjustResize" />`;
    }
    return `${tag.slice(0, -1)} android:windowSoftInputMode="adjustResize">`;
  });

  return out;
}

const REQUIRED_KOTLIN_IMPORTS = [
  'import android.Manifest',
  'import android.content.Intent',
  'import android.content.pm.PackageManager',
  'import android.graphics.Color',
  'import android.net.Uri',
  'import android.os.Bundle',
  'import android.provider.Settings',
  'import android.view.View',
  'import android.view.WindowManager',
  'import android.webkit.JavascriptInterface',
  'import android.webkit.WebView',
  'import android.widget.Toast',
  'import androidx.activity.OnBackPressedCallback',
  'import androidx.core.app.ActivityCompat',
  'import androidx.core.content.ContextCompat',
  'import androidx.core.view.ViewCompat',
  'import androidx.core.view.WindowCompat',
  'import androidx.core.view.WindowInsetsCompat',
  'import androidx.core.view.WindowInsetsControllerCompat',
];

const MAIN_ACTIVITY_BODY = `  // LIRIO_ANDROID_PATCH_V2
  private var lirioWebView: WebView? = null
  private var lastBackPressAt: Long = 0L

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setupSystemBarsAndInsets()
    setupBackHandler()
    ensureMicPermissionOnLaunch()
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    lirioWebView = webView
    webView.overScrollMode = View.OVER_SCROLL_NEVER
    webView.addJavascriptInterface(LirioAndroidBridge(), "LirioAndroid")
  }

  private fun setupSystemBarsAndInsets() {
    WindowCompat.setDecorFitsSystemWindows(window, false)
    applySystemBarStyle(isDark = false)
    val contentView = findViewById<View>(android.R.id.content) ?: return
    ViewCompat.setOnApplyWindowInsetsListener(contentView) { v, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or
          WindowInsetsCompat.Type.displayCutout() or
          WindowInsetsCompat.Type.ime()
      )
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      val imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
      lirioWebView?.post {
        lirioWebView?.evaluateJavascript(
          "window.__lirioSetAndroidInsets && window.__lirioSetAndroidInsets(" + (if (imeVisible) "true" else "false") + ")",
          null
        )
      }
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(contentView)
  }

  private fun applySystemBarStyle(isDark: Boolean) {
    val bg = Color.parseColor(if (isDark) "#141311" else "#F6F3EC")
    window.decorView.setBackgroundColor(bg)
    @Suppress("DEPRECATION")
    window.statusBarColor = bg
    @Suppress("DEPRECATION")
    window.navigationBarColor = bg
    val ctrl = WindowInsetsControllerCompat(window, window.decorView)
    ctrl.isAppearanceLightStatusBars = !isDark
    ctrl.isAppearanceLightNavigationBars = !isDark
  }

  private fun setupBackHandler() {
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val wv = lirioWebView
        if (wv != null) {
          wv.evaluateJavascript(
            "(function(){try{return !!(window.__lirioHandleAndroidBack && window.__lirioHandleAndroidBack());}catch(e){return false;}})()"
          ) { res ->
            if (res != "true") {
              handleExitBack()
            }
          }
        } else {
          handleExitBack()
        }
      }
    })
  }

  private fun handleExitBack() {
    val now = System.currentTimeMillis()
    if (now - lastBackPressAt < 2000L) {
      finish()
    } else {
      lastBackPressAt = now
      Toast.makeText(this@MainActivity, "再按一次退出 Lirio", Toast.LENGTH_SHORT).show()
    }
  }

  private fun ensureMicPermissionOnLaunch() {
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.RECORD_AUDIO), 1001)
    }
  }

  inner class LirioAndroidBridge {
    @JavascriptInterface
    fun isAndroid(): Boolean = true

    @JavascriptInterface
    fun hasNativeInsets(): Boolean = true

    @JavascriptInterface
    fun setSystemBarStyle(isDark: Boolean) {
      runOnUiThread { applySystemBarStyle(isDark) }
    }

    @JavascriptInterface
    fun openAppSettings() {
      runOnUiThread {
        val intent = Intent(
          Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
          Uri.fromParts("package", packageName, null)
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        startActivity(intent)
      }
    }

    @JavascriptInterface
    fun setKeepScreenOn(enabled: Boolean) {
      runOnUiThread {
        if (enabled) {
          window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
          window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
      }
    }

    @JavascriptInterface
    fun requestMicPermission() {
      runOnUiThread {
        ActivityCompat.requestPermissions(this@MainActivity, arrayOf(Manifest.permission.RECORD_AUDIO), 1001)
      }
    }
  }`;

export function patchMainActivityKt(kt) {
  let out = String(kt || '');
  if (out.includes('// LIRIO_ANDROID_PATCH_V2')) {
    return out;
  }

  const missingImports = REQUIRED_KOTLIN_IMPORTS.filter((imp) => !out.includes(imp));
  if (missingImports.length > 0) {
    const pkgMatch = out.match(/^package\s+[^\r\n]+\r?\n/m);
    if (pkgMatch) {
      const insertAt = pkgMatch.index + pkgMatch[0].length;
      out = `${out.slice(0, insertAt)}${missingImports.join('\n')}\n${out.slice(insertAt)}`;
    } else {
      out = `${missingImports.join('\n')}\n${out}`;
    }
  }

  // Case 1: Braced class `class MainActivity : TauriActivity() { ... }`
  const bracedClassMatch = out.match(/class\s+MainActivity\s*:[^{\r\n]*\{/);
  if (bracedClassMatch) {
    const openBraceIdx = bracedClassMatch.index + bracedClassMatch[0].length - 1;
    // Find matching closing brace
    let depth = 0;
    let closeBraceIdx = -1;
    for (let i = openBraceIdx; i < out.length; i++) {
      if (out[i] === '{') depth++;
      else if (out[i] === '}') {
        depth--;
        if (depth === 0) {
          closeBraceIdx = i;
          break;
        }
      }
    }
    if (closeBraceIdx > openBraceIdx) {
      return `${out.slice(0, openBraceIdx + 1)}\n${MAIN_ACTIVITY_BODY}\n${out.slice(closeBraceIdx)}`;
    }
  }

  // Case 2: Brace-less class `class MainActivity : TauriActivity()` (default `tauri android init` output)
  const bracelessMatch = out.match(/class\s+MainActivity\s*:\s*TauriActivity\(\)[^\r\n]*/);
  if (bracelessMatch) {
    const header = bracelessMatch[0].trimEnd();
    return out.replace(bracelessMatch[0], `${header} {\n${MAIN_ACTIVITY_BODY}\n}`);
  }

  throw new Error('Unsupported MainActivity.kt structure');
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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lirio-android-patch-'));
  try {
    const manifestPath = path.join(tmpRoot, 'app/src/main/AndroidManifest.xml');
    const mainActPath = path.join(tmpRoot, 'app/src/main/java/local/aboboo/community/MainActivity.kt');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.mkdirSync(path.dirname(mainActPath), { recursive: true });

    const baseManifest = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
      '    <application android:label="Lirio">',
      '        <activity android:name=".MainActivity" android:exported="true">',
      '        </activity>',
      '    </application>',
      '</manifest>',
      '',
    ].join('\n');

    // Case 1: Brace-less MainActivity (exact output of `tauri android init`)
    fs.writeFileSync(manifestPath, baseManifest, 'utf8');
    fs.writeFileSync(
      mainActPath,
      `package local.aboboo.community\n\nclass MainActivity : TauriActivity()\n`,
      'utf8',
    );
    patchAndroidProject(tmpRoot);
    const bracelessManifest = fs.readFileSync(manifestPath, 'utf8');
    const bracelessKt = fs.readFileSync(mainActPath, 'utf8');
    assert.ok(bracelessManifest.includes('android.permission.RECORD_AUDIO'));
    assert.ok(bracelessManifest.includes('android.permission.MODIFY_AUDIO_SETTINGS'));
    assert.ok(bracelessManifest.includes('android.permission.INTERNET'));
    assert.ok(bracelessManifest.includes('android.permission.ACCESS_NETWORK_STATE'));
    assert.ok(bracelessManifest.includes('android:windowSoftInputMode="adjustResize"'));
    assert.ok(bracelessKt.includes('// LIRIO_ANDROID_PATCH_V2'));
    assert.ok(bracelessKt.includes('WindowCompat.setDecorFitsSystemWindows(window, false)'));
    assert.ok(bracelessKt.includes('ViewCompat.setOnApplyWindowInsetsListener'));
    assert.ok(bracelessKt.includes('addJavascriptInterface(LirioAndroidBridge(), "LirioAndroid")'));
    assert.ok(bracelessKt.includes('onBackPressedDispatcher.addCallback'));

    // Idempotency for Case 1
    patchAndroidProject(tmpRoot);
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), bracelessManifest);
    assert.equal(fs.readFileSync(mainActPath, 'utf8'), bracelessKt);

    // Case 2: Braced MainActivity
    fs.writeFileSync(
      mainActPath,
      `package local.aboboo.community\n\nclass MainActivity : TauriActivity() {\n}\n`,
      'utf8',
    );
    patchAndroidProject(tmpRoot);
    const bracedKt = fs.readFileSync(mainActPath, 'utf8');
    assert.ok(bracedKt.includes('// LIRIO_ANDROID_PATCH_V2'));
    assert.ok(bracedKt.includes('ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.RECORD_AUDIO), 1001)'));
    assert.ok(bracedKt.includes('override fun onCreate(savedInstanceState: Bundle?)'));

    // Idempotency for Case 2
    patchAndroidProject(tmpRoot);
    assert.equal(fs.readFileSync(mainActPath, 'utf8'), bracedKt);

    console.log('patch-android-mic self-test PASSED');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
} else if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const res = patchAndroidProject();
  console.log('Patched Android project:', res);
}
