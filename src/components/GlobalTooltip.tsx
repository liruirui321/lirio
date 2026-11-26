import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isMobileDevice } from '../services/platform';

interface TooltipState {
  text: string;
  anchorCenterX: number;
  y: number;
  placement: 'top' | 'bottom';
}

const TARGET_SELECTOR =
  'button[title], button.icon-btn, button.dock-circle, button.corpus-action-btn, button.corpus-card-play, button.fluid-orb-wrap, [data-tip]';

export function GlobalTooltip() {
  const [tip, setTip] = useState<TooltipState | null>(null);
  const [leftPx, setLeftPx] = useState<number | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const activeElRef = useRef<HTMLElement | null>(null);
  const suppressedTitleRef = useRef<{ el: HTMLElement; title: string } | null>(null);

  const restoreSuppressedTitle = () => {
    const prev = suppressedTitleRef.current;
    if (prev) {
      if (!prev.el.hasAttribute('title')) {
        prev.el.setAttribute('title', prev.title);
      }
      suppressedTitleRef.current = null;
    }
  };

  useLayoutEffect(() => {
    if (!tip || !tipRef.current) {
      setLeftPx(null);
      return;
    }
    const width = tipRef.current.offsetWidth;
    const rawLeft = tip.anchorCenterX - width / 2;
    const clamped = Math.max(10, Math.min(window.innerWidth - width - 10, rawLeft));
    setLeftPx(clamped);
  }, [tip]);

  useEffect(() => {
    if (isMobileDevice()) return;
    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const hide = () => {
      clearTimer();
      activeElRef.current = null;
      restoreSuppressedTitle();
      setTip(null);
    };

    const showFor = (el: HTMLElement) => {
      const text = (
        el.getAttribute('title') ||
        (suppressedTitleRef.current?.el === el ? suppressedTitleRef.current.title : '') ||
        el.getAttribute('data-tip') ||
        el.getAttribute('aria-label') ||
        ''
      ).trim();

      if (!text) {
        hide();
        return;
      }

      if (el.hasAttribute('title')) {
        const nativeTitle = el.getAttribute('title') || '';
        if (nativeTitle) {
          restoreSuppressedTitle();
          suppressedTitleRef.current = { el, title: nativeTitle };
          el.removeAttribute('title');
        }
      }

      activeElRef.current = el;
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        if (!el.isConnected) return;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        const placement: 'top' | 'bottom' = rect.top < 46 ? 'bottom' : 'top';
        setTip({
          text,
          anchorCenterX: rect.left + rect.width / 2,
          y: placement === 'bottom' ? rect.bottom + 8 : rect.top - 8,
          placement,
        });
      }, 130);
    };

    const onMouseOver = (e: MouseEvent) => {
      const rawTarget = e.target as HTMLElement | null;
      const target = rawTarget?.closest?.(TARGET_SELECTOR) as HTMLElement | null;
      if (!target) {
        if (activeElRef.current) hide();
        return;
      }
      if (target === activeElRef.current) return;
      showFor(target);
    };

    const onMouseOut = (e: MouseEvent) => {
      const current = activeElRef.current;
      if (!current) return;
      const related = e.relatedTarget as Node | null;
      if (related && current.contains(related)) return;
      if (e.target instanceof Node && current.contains(e.target)) {
        hide();
      }
    };

    const onFocusIn = (e: FocusEvent) => {
      const target = (e.target as HTMLElement | null)?.closest?.(TARGET_SELECTOR) as HTMLElement | null;
      if (target) showFor(target);
    };

    const onFocusOut = () => {
      hide();
    };

    document.addEventListener('mouseover', onMouseOver);
    document.addEventListener('mouseout', onMouseOut);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('scroll', hide, true);

    return () => {
      clearTimer();
      restoreSuppressedTitle();
      document.removeEventListener('mouseover', onMouseOver);
      document.removeEventListener('mouseout', onMouseOut);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('scroll', hide, true);
    };
  }, []);

  if (isMobileDevice() || !tip) return null;

  return (
    <div
      ref={tipRef}
      role="tooltip"
      className={`app-tooltip ${tip.placement}`}
      style={{
        left: leftPx ?? Math.max(10, tip.anchorCenterX),
        top: tip.y,
        visibility: leftPx === null ? 'hidden' : 'visible',
      }}
    >
      {tip.text}
    </div>
  );
}
