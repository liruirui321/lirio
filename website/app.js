function detectPlatform() {
  const ua = (navigator.userAgent || '').toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return 'ios';
  if (/android/.test(ua)) return 'android';
  if (/windows/.test(ua)) return 'windows';
  if (/macintosh|mac os x/.test(ua)) return 'macos';
  return 'macos';
}

const themeBtn = document.getElementById('themeBtn');
themeBtn.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  themeBtn.textContent = next === 'light' ? '深色' : '浅色';
});

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[m]);
}

async function initSite() {
  const res = await fetch('./versions.json', { cache: 'no-store' });
  if (!res.ok) return;
  const data = await res.json();
  const os = detectPlatform();

  document.getElementById('navVersion').textContent = `v${data.latestVersion}`;
  document.getElementById('footerVersion').textContent = `Version ${data.latestVersion}`;
  document.getElementById('releaseDateBadge').textContent = `${data.releaseDate} · v${data.latestVersion}`;

  const primary = data.platforms[os];
  const heroBtn = document.getElementById('primaryDownloadBtn');
  if (primary) {
    heroBtn.textContent = `下载 ${primary.label} 版（v${primary.version}）`;
    heroBtn.href = primary.downloadUrl;
  }

  const order = ['macos', 'windows', 'android', 'ios'];
  document.getElementById('platformGrid').innerHTML = order
    .map((key) => {
      const p = data.platforms[key];
      if (!p) return '';
      const isRec = key === os;
      return `
        <div class="platform-card${isRec ? ' recommended' : ''}">
          <div class="platform-top">
            <strong>${esc(p.label)}</strong>
            ${isRec ? '<span class="ver-pill">推荐</span>' : `<span class="platform-meta">${esc(p.format)}</span>`}
          </div>
          <div class="platform-meta">${esc(p.arch)} · ${esc(p.minOs)}</div>
          <div class="platform-ver">v${esc(p.version)}${p.autoUpdate ? ' · 支持自动更新' : ''}</div>
          <a class="platform-btn" href="${esc(p.downloadUrl)}">下载 ${esc(p.format)}</a>
        </div>
      `;
    })
    .join('');

  document.getElementById('historyList').innerHTML = (data.history || [])
    .map(
      (h) => `
      <div class="history-card">
        <div class="history-head">
          <strong>v${esc(h.version)}</strong>
          <span>${esc(h.date)}</span>
        </div>
        <ul>${(h.highlights || []).map((line) => `<li>${esc(line)}</li>`).join('')}</ul>
      </div>
    `,
    )
    .join('');
}

initSite().catch(() => {});
