import { useEffect, useState } from 'react';

export interface LirioAndroidBridge {
  isAndroid?: () => boolean;
  hasNativeInsets?: () => boolean;
  setSystemBarStyle?: (isDark: boolean) => void;
  openAppSettings?: () => void;
  setKeepScreenOn?: (enabled: boolean) => void;
  requestMicPermission?: () => void;
}

declare global {
  interface Window {
    LirioAndroid?: LirioAndroidBridge;
    __lirioHandleAndroidBack?: () => boolean;
    __lirioSetAndroidInsets?: (imeVisible: boolean) => void;
  }
}

export function isAndroidNative(): boolean {
  if (typeof window !== 'undefined' && window.LirioAndroid?.isAndroid?.()) {
    return true;
  }
  return typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent || '');
}

export function isIosNative(): boolean {
  return typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent || '');
}

export function isMobileDevice(): boolean {
  return isAndroidNative() || isIosNative();
}

export function hasNativeAndroidInsets(): boolean {
  return typeof window !== 'undefined' && Boolean(window.LirioAndroid?.hasNativeInsets?.());
}

export function syncNativeSystemBars(theme: 'light' | 'dark'): void {
  const isDark = theme === 'dark';
  const color = isDark ? '#141311' : '#f6f3ec';
  if (typeof document !== 'undefined') {
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', color);
  }
  try {
    window.LirioAndroid?.setSystemBarStyle?.(isDark);
  } catch {}
}

export function setNativeKeepScreenOn(enabled: boolean): void {
  try {
    window.LirioAndroid?.setKeepScreenOn?.(enabled);
  } catch {}
}

export function openNativeAppSettings(): boolean {
  try {
    if (window.LirioAndroid?.openAppSettings) {
      window.LirioAndroid.openAppSettings();
      return true;
    }
  } catch {}
  return false;
}

export function requestNativeMicPermission(): boolean {
  try {
    if (window.LirioAndroid?.requestMicPermission) {
      window.LirioAndroid.requestMicPermission();
      return true;
    }
  } catch {}
  return false;
}

function computeIsMobileLayout(breakpoint: number): boolean {
  if (isMobileDevice()) return true;
  if (typeof window === 'undefined') return false;
  return window.innerWidth <= breakpoint;
}

export function useIsMobileLayout(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => computeIsMobileLayout(breakpoint));

  useEffect(() => {
    const sync = () => {
      const next = computeIsMobileLayout(breakpoint);
      setIsMobile(next);
      if (typeof document !== 'undefined') {
        const root = document.documentElement;
        root.dataset.mobile = next ? 'true' : 'false';
        root.dataset.platform = isAndroidNative() ? 'android' : isIosNative() ? 'ios' : 'desktop';
        root.dataset.androidInsets = hasNativeAndroidInsets() ? 'native' : 'css';
      }
    };
    sync();
    window.addEventListener('resize', sync);
    window.addEventListener('orientationchange', sync);
    return () => {
      window.removeEventListener('resize', sync);
      window.removeEventListener('orientationchange', sync);
    };
  }, [breakpoint]);

  return isMobile;
}

export function useKeyboardVisible(): boolean {
  const [kbOpen, setKbOpen] = useState(false);

  useEffect(() => {
    let baseHeight = typeof window !== 'undefined' ? window.innerHeight : 0;

    const updateDom = (visible: boolean) => {
      setKbOpen(visible);
      if (typeof document !== 'undefined') {
        document.documentElement.dataset.kbOpen = visible ? 'true' : 'false';
      }
    };

    window.__lirioSetAndroidInsets = (imeVisible: boolean) => {
      updateDom(Boolean(imeVisible));
    };

    const onViewportResize = () => {
      if (!isMobileDevice() && window.innerWidth > 768) {
        updateDom(false);
        return;
      }
      const vv = window.visualViewport;
      if (vv) {
        if (vv.height > baseHeight) baseHeight = vv.height;
        const shrunk = baseHeight - vv.height > 120 || window.innerHeight - vv.height > 120;
        updateDom(shrunk);
      }
    };

    window.visualViewport?.addEventListener('resize', onViewportResize);
    return () => {
      window.visualViewport?.removeEventListener('resize', onViewportResize);
      if (window.__lirioSetAndroidInsets) {
        delete window.__lirioSetAndroidInsets;
      }
    };
  }, []);

  return kbOpen;
}
