import { useEffect, useState } from 'react';
import { open as openExternalUrl } from '@tauri-apps/plugin-shell';
import {
  createStoreOrder,
  fetchStoreConfig,
  fetchStoreOrder,
  formatPoints,
  getStoreWebsiteUrl,
  loginAccount,
  logoutAccount,
  redeemCode,
  refreshAccountMe,
  registerAccount,
  simulatePayStoreOrder,
  validateAccountId,
  validatePassword,
  type AccountState,
  type LocalAccessResult,
  type StoreConfig,
  type StoreOrder,
} from '../../services/accountService';
import { IconLirioMark } from '../Icons';

export function LicenseGateModal({
  access,
  account,
}: {
  access: LocalAccessResult;
  account: AccountState;
}) {
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState(() => account.user?.email || '');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [statusMsg, setStatusMsg] = useState('');

  const [redeemInput, setRedeemInput] = useState('');
  const [showBuy, setShowBuy] = useState(false);
  const [storeConfig, setStoreConfig] = useState<StoreConfig | null>(null);
  const [buyChannel, setBuyChannel] = useState<'wechat' | 'alipay'>('wechat');
  const [activeOrder, setActiveOrder] = useState<StoreOrder | null>(null);

  useEffect(() => {
    if (!showBuy || !activeOrder || activeOrder.status !== 'pending') return;
    const mail = activeOrder.buyerEmail || account.user?.email || '';
    if (!mail) return;
    const timer = window.setInterval(() => {
      fetchStoreOrder(activeOrder.orderNo, mail)
        .then((res) => {
          if (res.order) setActiveOrder(res.order);
        })
        .catch(() => {});
    }, 2500);
    return () => window.clearInterval(timer);
  }, [showBuy, activeOrder, account.user?.email]);

  const openUrlSafe = async (url: string) => {
    try {
      await openExternalUrl(url);
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  const handleAuthSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const acctErr = validateAccountId(email);
    if (acctErr) {
      setErrorMsg(acctErr);
      return;
    }
    const pwdErr = validatePassword(password);
    if (pwdErr) {
      setErrorMsg(pwdErr);
      return;
    }
    if (authMode === 'register' && nickname.trim().length > 24) {
      setErrorMsg('昵称最多 24 个字符。');
      return;
    }
    setBusy(true);
    setErrorMsg('');
    setStatusMsg('');
    try {
      if (authMode === 'register') {
        await registerAccount({ email: email.trim(), password, name: nickname.trim() });
        setStatusMsg('注册成功，已开通 3 天全功能免费体验');
      } else {
        await loginAccount({ email: email.trim(), password });
        setStatusMsg('登录成功');
      }
      setPassword('');
    } catch (err) {
      setErrorMsg(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRedeem = async (overrideCode?: string) => {
    const code = (overrideCode ?? redeemInput).trim();
    if (!code) {
      setErrorMsg('请输入 Lirio 终身通行证兑换码。');
      return;
    }
    setBusy(true);
    setErrorMsg('');
    setStatusMsg('');
    try {
      const res = await redeemCode(code);
      setRedeemInput('');
      setActiveOrder(null);
      setShowBuy(false);
      setStatusMsg(`激活成功 +${formatPoints(res.entry.amountUnits)}`);
    } catch (err) {
      setErrorMsg(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleOpenBuyPro = async () => {
    const next = !showBuy;
    setShowBuy(next);
    setErrorMsg('');
    if (next && !storeConfig) {
      setBusy(true);
      try {
        setStoreConfig(await fetchStoreConfig());
      } catch (err) {
        setErrorMsg(String(err));
      } finally {
        setBusy(false);
      }
    }
  };

  const handleCreateProOrder = async () => {
    const buyerEmail = account.user?.email || email.trim();
    if (!buyerEmail) {
      setErrorMsg('请先登录账号后再下单。');
      return;
    }
    setBusy(true);
    setErrorMsg('');
    try {
      const res = await createStoreOrder({
        planId: 'pro_99',
        buyerEmail,
        payChannel: buyChannel,
      });
      setActiveOrder(res.order);
      setStoreConfig((prev) => ({
        presets: prev?.presets || [],
        settings: res.settings,
        sandboxPayEnabled: res.sandboxPayEnabled,
      }));
    } catch (err) {
      setErrorMsg(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSimulatePay = async () => {
    if (!activeOrder) return;
    setBusy(true);
    setErrorMsg('');
    try {
      const res = await simulatePayStoreOrder(activeOrder.orderNo, activeOrder.buyerEmail);
      setActiveOrder(res.order);
    } catch (err) {
      setErrorMsg(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleOnlineRefresh = async () => {
    setBusy(true);
    setErrorMsg('');
    try {
      await refreshAccountMe();
    } catch (err) {
      setErrorMsg(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="license-gate-backdrop" role="dialog" aria-modal="true" aria-label="Lirio 账号授权">
      <div className="license-gate-card">
        <div className="license-gate-head">
          <div className="brand-mark-badge">
            <IconLirioMark size={28} />
          </div>
          <div>
            <h2>
              {access.reason === 'trial_expired'
                ? '3 天免费体验已结束'
                : access.reason === 'offline_expired'
                  ? '需要联网续期离线授权'
                  : authMode === 'register'
                    ? '注册 Lirio'
                    : '登录 Lirio'}
            </h2>
            <p>
              {access.reason === 'trial_expired'
                ? '激活「Lirio Pro · 永久版（¥99）」即可永久使用精听、词卡与本地语音功能（含 1,000 积分 + 专属提需求通道）。'
                : access.reason === 'offline_expired'
                  ? '离线连续使用已超过 14 天，请联网校验一次你的 Pro · 永久版授权。'
                  : '新用户免费试 3 天 · 赠 50 积分'}
            </p>
          </div>
        </div>

        {(errorMsg || access.message) && (
          <div className="app-error" style={{ borderRadius: 10 }}>
            {errorMsg || access.message}
          </div>
        )}
        {statusMsg && <div className="license-gate-ok">{statusMsg}</div>}

        {access.reason === 'unauthenticated' && (
          <form className="license-gate-form" onSubmit={(e) => void handleAuthSubmit(e)}>
            <div className="settings-row-between">
              <div className="seg-pill">
                <button
                  type="button"
                  className={authMode === 'login' ? 'active' : ''}
                  onClick={() => {
                    setAuthMode('login');
                    setErrorMsg('');
                  }}
                >
                  登录
                </button>
                <button
                  type="button"
                  className={authMode === 'register' ? 'active' : ''}
                  onClick={() => {
                    setAuthMode('register');
                    setErrorMsg('');
                  }}
                >
                  注册
                </button>
              </div>
            </div>

            <div className="speak-field">
              <label>账号</label>
              <input
                type="text"
                value={email}
                placeholder="4–32 位字母、数字或下划线"
                minLength={4}
                maxLength={32}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div className="speak-field">
              <label>密码</label>
              <input
                type="password"
                value={password}
                placeholder="6–32 位，不含空格"
                minLength={6}
                maxLength={32}
                required
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            {authMode === 'register' && (
              <div className="speak-field">
                <label>昵称</label>
                <input
                  type="text"
                  value={nickname}
                  placeholder="选填"
                  maxLength={24}
                  onChange={(e) => setNickname(e.target.value)}
                />
              </div>
            )}

            <button
              type="submit"
              className="primary-btn full-width"
              disabled={busy || email.trim().length < 4 || password.length < 6}
            >
              {busy ? '请稍候…' : authMode === 'register' ? '注册' : '登录'}
            </button>

            <button
              type="button"
              className="link-inline-btn"
              onClick={() => void openUrlSafe(getStoreWebsiteUrl())}
            >
              了解 Lirio Pro · 永久版 ↗
            </button>
          </form>
        )}

        {access.reason === 'trial_expired' && (
          <div className="license-gate-form">
            <div className="license-account-bar">
              <span>当前账号：{account.user?.email}</span>
              <button type="button" className="ghost-pill-btn" onClick={logoutAccount}>
                切换账号
              </button>
            </div>

            <div className="redeem-code-wrap">
              <div className="redeem-code-row">
                <input
                  type="text"
                  value={redeemInput}
                  onChange={(e) => setRedeemInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !busy) {
                      e.preventDefault();
                      void handleRedeem();
                    }
                  }}
                  placeholder="输入通行证激活码（如 LIRIO-XXXX-XXXX-XXXX）"
                  spellCheck={false}
                  autoCapitalize="characters"
                  disabled={busy}
                />
                <button
                  type="button"
                  className="primary-btn"
                  disabled={busy || !redeemInput.trim()}
                  onClick={() => void handleRedeem()}
                >
                  激活解锁
                </button>
              </div>
            </div>

            <div className="redeem-actions-row">
              <button type="button" className="ghost-pill-btn" onClick={() => void handleOpenBuyPro()}>
                {showBuy ? '收起下单' : '开通 ¥99 Lirio Pro · 永久版'}
              </button>
              <button
                type="button"
                className="ghost-pill-btn"
                onClick={() => void openUrlSafe(getStoreWebsiteUrl())}
              >
                前往官网购卡页 ↗
              </button>
            </div>

            {showBuy && (
              <div className="buy-code-panel">
                {!activeOrder ? (
                  <>
                    <div className="buy-channel-bar">
                      <span>付款方式</span>
                      <div className="buy-channel-pills">
                        <button
                          type="button"
                          className={buyChannel === 'wechat' ? 'active' : ''}
                          onClick={() => setBuyChannel('wechat')}
                        >
                          微信支付
                        </button>
                        <button
                          type="button"
                          className={buyChannel === 'alipay' ? 'active' : ''}
                          onClick={() => setBuyChannel('alipay')}
                        >
                          支付宝
                        </button>
                      </div>
                    </div>
                    <div className="buy-pack-card">
                      <div className="buy-pack-head">
                        <strong>Lirio Pro · 永久版（含 1,000 积分）</strong>
                        <span>¥99</span>
                      </div>
                      <small>一码永久解锁本人 3 台设备 + 专属提需求通道，本地语音与转写 0 积分免费（云端模式更快）</small>
                      <div className="buy-pack-btns">
                        {storeConfig?.settings?.shopUrlPro99 && (
                          <button
                            type="button"
                            className="ghost-pill-btn"
                            onClick={() => void openUrlSafe(storeConfig.settings.shopUrlPro99)}
                          >
                            店铺购卡 ↗
                          </button>
                        )}
                        <button
                          type="button"
                          className="primary-btn"
                          disabled={busy}
                          onClick={() => void handleCreateProOrder()}
                        >
                          立即下单支付
                        </button>
                      </div>
                    </div>
                  </>
                ) : activeOrder.status === 'paid' && activeOrder.issuedCode ? (
                  <div className="buy-order-box">
                    <div className="sub">收款已确认 · 通行证已生成（{activeOrder.orderNo}）</div>
                    <div className="buy-issued-code">{activeOrder.issuedCode}</div>
                    <button
                      type="button"
                      className="primary-btn"
                      disabled={busy}
                      onClick={() => void handleRedeem(activeOrder.issuedCode!)}
                    >
                      一键激活并解锁软件
                    </button>
                  </div>
                ) : (
                  <div className="buy-order-box">
                    <div className="buy-pack-head">
                      <strong>订单 {activeOrder.orderNo}</strong>
                      <span>实付 ¥{activeOrder.payYuan}</span>
                    </div>
                    {(buyChannel === 'alipay' ? storeConfig?.settings?.alipayQr : storeConfig?.settings?.wechatQr) ? (
                      <img
                        className="buy-qr-img"
                        src={
                          buyChannel === 'alipay'
                            ? storeConfig!.settings.alipayQr
                            : storeConfig!.settings.wechatQr
                        }
                        alt="收款码"
                      />
                    ) : (
                      <div className="sub">店主尚未上传收款码，可前往官网购卡页或使用测试按钮</div>
                    )}
                    <div className="sub">
                      {storeConfig?.settings?.paymentNotice || '付款后每 2.5 秒自动查询核实并弹出激活码…'}
                    </div>
                    <div className="redeem-actions-row">
                      {storeConfig?.sandboxPayEnabled && (
                        <button
                          type="button"
                          className="ghost-pill-btn"
                          disabled={busy}
                          onClick={() => void handleSimulatePay()}
                        >
                          本地演示：模拟支付并出码
                        </button>
                      )}
                      <button
                        type="button"
                        className="ghost-pill-btn"
                        onClick={() => setActiveOrder(null)}
                      >
                        返回
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {access.reason === 'offline_expired' && (
          <div className="license-gate-form">
            <div className="license-account-bar">
              <span>当前账号：{account.user?.email}</span>
              <button type="button" className="ghost-pill-btn" onClick={logoutAccount}>
                切换账号
              </button>
            </div>
            <button
              type="button"
              className="primary-btn full-width"
              disabled={busy}
              onClick={() => void handleOnlineRefresh()}
            >
              {busy ? '正在联网验证…' : '立即联网续期终身通行证授权'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
