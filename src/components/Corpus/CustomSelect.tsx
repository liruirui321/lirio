import { useState, useRef, useEffect } from 'react';
import { IconCheck } from '../Icons';

export interface SelectOption {
  value: string;
  label: string;
  meta?: string;
  status?: 'done' | 'warn' | 'idle';
}

interface CustomSelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  title?: string;
  minWidth?: number;
  menuWidth?: number;
}

export function CustomSelect({
  value,
  options,
  onChange,
  disabled,
  title,
  minWidth = 90,
  menuWidth,
}: CustomSelectProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);

  const selected = options.find((o) => o.value === value) || options[0];

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open && activeItemRef.current) {
      activeItemRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [open]);

  return (
    <div className={`cselect${open ? ' open' : ''}`} ref={wrapRef} style={{ minWidth }}>
      <button
        type="button"
        className="cselect-trigger"
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {selected?.status && <span className={`cselect-dot ${selected.status}`} />}
        <span className="cselect-label">{selected?.label || '—'}</span>
        {selected?.meta && <span className="cselect-trigger-meta">{selected.meta}</span>}
        <svg className="cselect-chevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          className="cselect-menu"
          role="listbox"
          style={menuWidth ? { minWidth: menuWidth } : undefined}
        >
          {options.map((opt) => {
            const isSel = opt.value === value;
            return (
              <button
                key={opt.value}
                ref={isSel ? activeItemRef : undefined}
                type="button"
                role="option"
                aria-selected={isSel}
                className={`cselect-option${isSel ? ' selected' : ''}`}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
              >
                {opt.status && <span className={`cselect-dot ${opt.status}`} />}
                <span className="cselect-opt-label">{opt.label}</span>
                {opt.meta && <span className={`cselect-opt-meta ${opt.status || ''}`}>{opt.meta}</span>}
                <span className="cselect-opt-check">{isSel ? <IconCheck size={13} /> : null}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
