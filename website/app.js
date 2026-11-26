const FALLBACK_STORE = {
  presets: [
    {
      id: 'pro_99',
      payYuan: 99,
      label: '¥99 Lirio Pro · 永久版（赠 ¥10 对话加油包）',
      shortTitle: 'Lirio Pro · 永久版',
      badge: '最划算 · 永久买断',
      subtitle: '一次付费终身用（3 台设备）· 送 ¥10 余额 ≈ 200+ 场模考',
      amountUnits: 100000,
      upgradeToPro: true,
    },
    {
      id: 'topup_10',
      payYuan: 10,
      label: '¥10 AI 对话加油包',
      shortTitle: '¥10 对话加油包',
      badge: '一杯奶茶钱',
      subtitle: '约 200+ 场模考 · 用多少扣多少 · 永不过期',
      amountUnits: 100000,
      upgradeToPro: false,
    },
    {
      id: 'topup_30',
      payYuan: 30,
      label: '¥30 AI 对话加油包（赠 ¥5）',
      shortTitle: '¥30 冲刺加油包',
      badge: '冲刺加赠 ¥5',
      subtitle: '实付 ¥30 到账 ¥35 · 考前刷题刷口语闭眼入',
      amountUnits: 350000,
      upgradeToPro: false,
    },
  ],
  settings: {
    wechatQr: '',
    alipayQr: '',
    shopUrlPro99: '',
    shopUrlTopup10: '',
    shopUrlTopup30: '',
    supportContact: '售后联系：support@lirio.app',
    paymentNotice: '扫码付款时请在备注栏填写订单号，确认收款后页面将自动弹出卡密兑换码。',
  },
  sandboxPayEnabled: false,
};

let storeState = FALLBACK_STORE;
let selectedPlan = null;
let currentOrder = null;
let currentBuyerEmail = '';
let pollTimer = null;

function detectPlatform() {
  const ua = (navigator.userAgent || '').toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return 'ios';
  if (/android/.test(ua)) return 'android';
  if (/windows/.test(ua)) return 'windows';
  if (/macintosh|mac os x/.test(ua)) return 'macos';
  return 'macos';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[m]);
}

function getShopUrlForPlan(planId) {
  const st = storeState.settings || {};
  if (planId === 'pro_99') return (st.shopUrlPro99 || '').trim();
  if (planId === 'topup_10') return (st.shopUrlTopup10 || '').trim();
  if (planId === 'topup_30') return (st.shopUrlTopup30 || '').trim();
  return '';
}

function getPackBullets(preset) {
  if (preset.id === 'pro_99') {
    return [
      '永久解锁精听、词卡、音频自动切分（3 台设备）',
      '附赠 ¥10 对话余额（约 200+ 场雅思考官模考）',
      '专属「提需求」通道，你的好点子作者真做',
    ];
  }
  const creditYuan = ((Number(preset.amountUnits) || 0) / 10000).toFixed(0);
  return [
    `立即到账 ¥${creditYuan} 对话余额 · 永不过期`,
    '雅思考官模考低至 4 分/场 · AI 字幕精校低至 5 厘/篇',
    '用多少扣多少，拒绝高价年卡捆绑',
  ];
}

// Theme toggle
const themeBtn = document.getElementById('themeBtn');
themeBtn.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  themeBtn.textContent = next === 'light' ? '深色' : '浅色';
});

// Product preview tabs
document.querySelectorAll('.preview-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = btn.getAttribute('data-preview');
    document.querySelectorAll('.preview-tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.preview-pane').forEach((pane) => {
      pane.classList.toggle('active', pane.getAttribute('data-pane') === key);
    });
  });
});

function renderStorefront() {
  const grid = document.getElementById('packGrid');
  if (!grid) return;
  const presets = storeState.presets?.length ? storeState.presets : FALLBACK_STORE.presets;
  grid.innerHTML = presets
    .map((p) => {
      const shopUrl = getShopUrlForPlan(p.id);
      const isFeatured = p.id === 'pro_99';
      const creditYuan = ((Number(p.amountUnits) || 0) / 10000).toFixed(0);
      const bullets = getPackBullets(p)
        .map((line) => `<li>${esc(line)}</li>`)
        .join('');
      return `
        <article class="pack-card${isFeatured ? ' featured' : ''}">
          <div class="pack-top">
            <strong>${esc(p.shortTitle || p.label)}</strong>
            <span class="tag">${esc(p.badge || (p.upgradeToPro ? '永久买断' : '余额充值'))}</span>
          </div>
          <div class="pack-price">¥${esc(p.payYuan)}<span>到账 ¥${esc(creditYuan)} 余额</span></div>
          <p class="pack-sub">${esc(p.subtitle || p.note || '')}</p>
          <ul class="pack-list">${bullets}</ul>
          <div class="pack-actions">
            ${
              shopUrl
                ? `<a class="btn-primary full-width" href="${esc(shopUrl)}" target="_blank" rel="noopener noreferrer">前往官方店铺购卡 ↗</a>
                   <button type="button" class="btn-ghost full-width buy-plan-btn" data-plan="${esc(p.id)}">官网扫码下单</button>`
                : `<button type="button" class="${isFeatured ? 'btn-primary' : 'btn-ghost'} full-width buy-plan-btn" data-plan="${esc(p.id)}">立即购买（¥${esc(p.payYuan)}）</button>`
            }
          </div>
        </article>
      `;
    })
    .join('');

  const supportEl = document.getElementById('supportContactText');
  if (supportEl && storeState.settings?.supportContact) {
    supportEl.textContent = storeState.settings.supportContact;
  }
}

function stopOrderPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function showCheckoutStep(step) {
  document.getElementById('checkoutStepForm').hidden = step !== 'form';
  document.getElementById('checkoutStepPay').hidden = step !== 'pay';
  document.getElementById('checkoutStepSuccess').hidden = step !== 'success';
}

function renderQrBox(channel) {
  const st = storeState.settings || {};
  const qr = channel === 'alipay' ? st.alipayQr : st.wechatQr;
  const label = channel === 'alipay' ? '支付宝' : '微信支付';
  const box = document.getElementById('payQrBox');
  if (qr) {
    box.innerHTML = `<img src="${esc(qr)}" alt="${label}收款码" /><span class="platform-meta">${label}扫码 · 实付 ¥${esc(selectedPlan?.payYuan || '')}</span>`;
  } else {
    box.innerHTML = `<strong>${label}收款码待店主在管理后台上传</strong><span class="platform-meta">${esc(st.supportContact || '请联系店主付款，付款后将自动出码')}</span>`;
  }
}

function showIssuedCode(code) {
  stopOrderPoll();
  document.getElementById('issuedCodeBox').textContent = code;
  showCheckoutStep('success');
}

function startOrderPoll() {
  stopOrderPoll();
  pollTimer = setInterval(async () => {
    if (!currentOrder || !currentBuyerEmail) return;
    try {
      const res = await fetch(
        `/api/orders/${encodeURIComponent(currentOrder.orderNo)}?email=${encodeURIComponent(currentBuyerEmail)}`,
      );
      if (!res.ok) return;
      const data = await res.json();
      if (data?.order?.status === 'paid' && data?.order?.issuedCode) {
        currentOrder = data.order;
        showIssuedCode(data.order.issuedCode);
      } else if (data?.order?.status === 'cancelled') {
        stopOrderPoll();
        const err = document.getElementById('checkoutPayErr');
        err.textContent = '该订单已被取消，请重新下单。';
        err.hidden = false;
      }
    } catch {}
  }, 2500);
}

function openCheckoutModal(planId) {
  const presets = storeState.presets?.length ? storeState.presets : FALLBACK_STORE.presets;
  selectedPlan = presets.find((p) => p.id === planId) || presets[0];
  currentOrder = null;
  stopOrderPoll();

  document.getElementById('checkoutTitle').textContent = selectedPlan.shortTitle || selectedPlan.label;
  document.getElementById('checkoutPlanBar').innerHTML = `
    <span>${esc(selectedPlan.label)}</span>
    <strong>¥${esc(selectedPlan.payYuan)}</strong>
  `;
  document.getElementById('checkoutFormErr').hidden = true;
  document.getElementById('checkoutPayErr').hidden = true;
  const savedEmail = localStorage.getItem('lirio-buyer-email') || '';
  if (savedEmail && !document.getElementById('checkoutEmail').value) {
    document.getElementById('checkoutEmail').value = savedEmail;
  }
  showCheckoutStep('form');
  document.getElementById('checkoutModal').hidden = false;
}

function closeCheckoutModal() {
  stopOrderPoll();
  document.getElementById('checkoutModal').hidden = true;
}

document.getElementById('packGrid').addEventListener('click', (e) => {
  const btn = e.target.closest('.buy-plan-btn');
  if (!btn) return;
  openCheckoutModal(btn.getAttribute('data-plan'));
});

document.getElementById('closeCheckoutBtn').addEventListener('click', closeCheckoutModal);
document.getElementById('checkoutModal').addEventListener('click', (e) => {
  if (e.target.id === 'checkoutModal') closeCheckoutModal();
});

document.querySelectorAll('input[name="payChannel"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    document.querySelectorAll('.channel-opt').forEach((el) => {
      el.classList.toggle('active', el.querySelector('input')?.checked);
    });
  });
});

document.getElementById('checkoutStepForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('checkoutFormErr');
  errEl.hidden = true;
  const email = document.getElementById('checkoutEmail').value.trim();
  const channel = document.querySelector('input[name="payChannel"]:checked')?.value || 'wechat';
  const btn = document.getElementById('createOrderBtn');
  btn.disabled = true;
  btn.textContent = '正在创建订单…';
  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: selectedPlan.id, buyerEmail: email, payChannel: channel }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '创建订单失败');
    currentOrder = data.order;
    currentBuyerEmail = email.toLowerCase();
    localStorage.setItem('lirio-buyer-email', currentBuyerEmail);
    if (data.settings) storeState.settings = data.settings;
    if (data.sandboxPayEnabled !== undefined) storeState.sandboxPayEnabled = data.sandboxPayEnabled;

    document.getElementById('payOrderNo').textContent = currentOrder.orderNo;
    document.getElementById('payNoticeText').textContent =
      storeState.settings?.paymentNotice || FALLBACK_STORE.settings.paymentNotice;
    renderQrBox(channel);

    const extUrl = getShopUrlForPlan(selectedPlan.id);
    const extBtn = document.getElementById('payExternalShopBtn');
    if (extUrl) {
      extBtn.href = extUrl;
      extBtn.hidden = false;
    } else {
      extBtn.hidden = true;
    }

    document.getElementById('sandboxPayBtn').hidden = !storeState.sandboxPayEnabled;
    document.getElementById('checkoutPayErr').hidden = true;
    showCheckoutStep('pay');
    startOrderPoll();
  } catch (err) {
    errEl.textContent = err.message || String(err);
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = '提交订单并获取收款码';
  }
});

document.getElementById('backToFormBtn').addEventListener('click', () => {
  stopOrderPoll();
  showCheckoutStep('form');
});

document.getElementById('copyOrderNoBtn').addEventListener('click', async () => {
  const no = document.getElementById('payOrderNo').textContent;
  await navigator.clipboard.writeText(no);
  const btn = document.getElementById('copyOrderNoBtn');
  btn.textContent = '已复制';
  setTimeout(() => { btn.textContent = '复制订单号'; }, 1500);
});

document.getElementById('sandboxPayBtn').addEventListener('click', async () => {
  if (!currentOrder || !currentBuyerEmail) return;
  const errEl = document.getElementById('checkoutPayErr');
  errEl.hidden = true;
  const btn = document.getElementById('sandboxPayBtn');
  btn.disabled = true;
  btn.textContent = '正在模拟确认并生成卡密…';
  try {
    const res = await fetch(`/api/orders/${encodeURIComponent(currentOrder.orderNo)}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ simulate: true, email: currentBuyerEmail }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '模拟发卡失败');
    currentOrder = data.order;
    showIssuedCode(data.order.issuedCode);
  } catch (err) {
    errEl.textContent = err.message || String(err);
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = '本地演示：一键模拟支付成功并生成卡密';
  }
});

document.getElementById('copyIssuedCodeBtn').addEventListener('click', async () => {
  const code = document.getElementById('issuedCodeBox').textContent.trim();
  await navigator.clipboard.writeText(code);
  const btn = document.getElementById('copyIssuedCodeBtn');
  btn.textContent = '已复制到剪贴板';
  setTimeout(() => { btn.textContent = '复制卡密兑换码'; }, 1800);
});

// Lookup orders by email
document.getElementById('lookupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('lookupEmail').value.trim();
  const orderNo = document.getElementById('lookupOrderNo').value.trim();
  const box = document.getElementById('lookupResults');
  box.hidden = false;
  box.innerHTML = '<div class="lookup-row">查询中…</div>';
  try {
    const qs = new URLSearchParams({ email, ...(orderNo ? { orderNo } : {}) });
    const res = await fetch(`/api/orders/lookup?${qs.toString()}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '查询失败');
    if (!data.orders?.length) {
      box.innerHTML = '<div class="lookup-row">未找到该邮箱下的订单记录，请确认下单邮箱是否填写一致。</div>';
      return;
    }
    box.innerHTML = data.orders
      .map((o) => {
        const statusText =
          o.status === 'paid' ? '已发卡' : o.status === 'cancelled' ? '已取消' : '待确认收款';
        return `
          <div class="lookup-row">
            <div>
              <strong>${esc(o.orderNo)}</strong> · ${esc(o.label)} · ¥${esc(o.payYuan)} · <span>${esc(statusText)}</span>
            </div>
            ${
              o.issuedCode
                ? `<div style="display:flex;align-items:center;gap:8px;">
                     <span class="lookup-code">${esc(o.issuedCode)}</span>
                     <button type="button" class="mini-btn" data-copy-code="${esc(o.issuedCode)}">复制</button>
                   </div>`
                : '<span class="platform-meta">确认收款后刷新即可查看卡密</span>'
            }
          </div>
        `;
      })
      .join('');
  } catch (err) {
    box.innerHTML = `<div class="lookup-row">${esc(err.message || String(err))}</div>`;
  }
});

document.getElementById('lookupResults').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy-code]');
  if (!btn) return;
  await navigator.clipboard.writeText(btn.getAttribute('data-copy-code'));
  btn.textContent = '已复制';
  setTimeout(() => { btn.textContent = '复制'; }, 1500);
});

async function initSite() {
  renderStorefront();

  // Fetch live storefront config from backend when served by Lirio Pro Server
  try {
    const storeRes = await fetch('/api/store/config', { cache: 'no-store' });
    if (storeRes.ok) {
      const cfg = await storeRes.json();
      if (cfg?.presets) {
        storeState = cfg;
        renderStorefront();
      }
    }
  } catch {}

  const res = await fetch('./versions.json', { cache: 'no-store' });
  if (!res.ok) return;
  const data = await res.json();
  const os = detectPlatform();

  document.getElementById('navVersion').textContent = `v${data.latestVersion}`;
  document.getElementById('footerVersion').textContent = `Version ${data.latestVersion}`;
  document.getElementById('releaseDateBadge').textContent = `${data.releaseDate} · v${data.latestVersion}`;

  const primary = data.platforms[os];
  const heroBtn = document.getElementById('primaryDownloadBtn');
  if (primary && !primary.comingSoon && primary.downloadUrl) {
    heroBtn.textContent = `下载 ${primary.label} 版（v${primary.version}）`;
    heroBtn.href = primary.downloadUrl;
  } else if (os === 'ios') {
    heroBtn.textContent = 'iPhone 端敬请期待 · 查看已支持平台';
    heroBtn.href = '#download';
  }

  const order = ['macos', 'windows', 'android', 'ios'];
  document.getElementById('platformGrid').innerHTML = order
    .map((key) => {
      const p = data.platforms[key];
      if (!p) return '';
      const isComingSoon = Boolean(p.comingSoon || !p.downloadUrl);
      const isRec = key === os && !isComingSoon;
      const badge = isRec
        ? '<span class="ver-pill">推荐</span>'
        : p.statusNote
          ? `<span class="platform-meta">${esc(p.statusNote)}</span>`
          : `<span class="platform-meta">${esc(p.format)}</span>`;
      return `
        <div class="platform-card${isRec ? ' recommended' : ''}">
          <div class="platform-top">
            <strong>${esc(p.label)}</strong>
            ${badge}
          </div>
          <div class="platform-meta">${esc(p.arch)} · ${esc(p.minOs)}</div>
          <div class="platform-ver">${isComingSoon ? '暂不支持 · 敬请期待' : `v${esc(p.version)}${p.autoUpdate ? ' · 支持自动更新' : ''}`}</div>
          ${
            isComingSoon
              ? '<span class="platform-btn disabled">iPhone 端敬请期待</span>'
              : `<a class="platform-btn" href="${esc(p.downloadUrl)}">下载 ${esc(p.format)}</a>`
          }
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
