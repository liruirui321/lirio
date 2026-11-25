import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { addMistakeToWordBook, getWordAudio } from '../services/corpusService';
import {
  loadSpeakState,
  synthesizeSpeech,
  translateSelection,
  type SelectionTranslation,
} from '../services/speakService';
import { IconCheck, IconPlus, IconStop, IconTranslate, IconVolume } from './Icons';

interface ActiveSelection {
  text: string;
  context: string;
  anchorX: number;
  rectTop: number;
  rectBottom: number;
}

const IGNORE_INPUT_RE = /^(INPUT|TEXTAREA|SELECT)$/;

export function SelectionTools() {
  const [sel, setSel] = useState<ActiveSelection | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const [translateOpen, setTranslateOpen] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [translation, setTranslation] = useState<SelectionTranslation | null>(null);
  const [translateError, setTranslateError] = useState('');
  const [savedWord, setSavedWord] = useState(false);

  const [speaking, setSpeaking] = useState(false);

  const popRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const transReqRef = useRef(0);
  const speakReqRef = useRef(0);

  const stopAudio = () => {
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.pause();
      audioRef.current.src = '';
    }
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    setSpeaking(false);
  };

  const dismiss = (clearBrowserSelection: boolean) => {
    transReqRef.current++;
    speakReqRef.current++;
    stopAudio();
    setSel(null);
    setPos(null);
    setTranslateOpen(false);
    setTranslating(false);
    setTranslation(null);
    setTranslateError('');
    setSavedWord(false);
    if (clearBrowserSelection) {
      try {
        window.getSelection()?.removeAllRanges();
      } catch {}
    }
  };

  useLayoutEffect(() => {
    if (!sel || !popRef.current) {
      setPos(null);
      return;
    }
    const w = popRef.current.offsetWidth || 150;
    const h = popRef.current.offsetHeight || 40;
    const left = Math.max(12, Math.min(window.innerWidth - w - 12, sel.anchorX - w / 2));
    let top = sel.rectBottom + 8;
    if (top + h > window.innerHeight - 12) {
      const above = sel.rectTop - h - 8;
      top = above >= 12 ? above : Math.max(12, window.innerHeight - h - 12);
    }
    setPos({ left, top });
  }, [sel, translateOpen, translation, translating, translateError]);

  useEffect(() => {
    const readSelection = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      if (target && popRef.current?.contains(target)) return;
      if (target && (IGNORE_INPUT_RE.test(target.tagName) || target.isContentEditable)) return;

      window.requestAnimationFrame(() => {
        const s = window.getSelection();
        const raw = s?.toString().trim() || '';
        if (!s || s.rangeCount === 0 || !raw || raw.length > 220) {
          return;
        }
        const range = s.getRangeAt(0);
        const anchorEl =
          range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
            ? (range.commonAncestorContainer as HTMLElement)
            : range.commonAncestorContainer.parentElement;
        if (anchorEl && (IGNORE_INPUT_RE.test(anchorEl.tagName) || anchorEl.isContentEditable)) {
          return;
        }
        const rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;

        const context = (range.commonAncestorContainer.textContent || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 240);

        transReqRef.current++;
        speakReqRef.current++;
        stopAudio();
        setTranslateOpen(false);
        setTranslating(false);
        setTranslation(null);
        setTranslateError('');
        setSavedWord(false);
        setSel({
          text: raw,
          context,
          anchorX: rect.left + rect.width / 2,
          rectTop: rect.top,
          rectBottom: rect.bottom,
        });
      });
    };

    const onMouseDown = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      if (target && popRef.current?.contains(target)) return;
      if (popRef.current) {
        dismiss(true);
      }
    };

    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && popRef.current) {
        dismiss(true);
      }
    };

    const onScroll = (ev: Event) => {
      const target = ev.target as Node | null;
      if (target && popRef.current?.contains(target)) return;
      if (popRef.current) {
        dismiss(false);
      }
    };

    document.addEventListener('mouseup', readSelection);
    document.addEventListener('dblclick', readSelection);
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('scroll', onScroll, true);

    return () => {
      stopAudio();
      document.removeEventListener('mouseup', readSelection);
      document.removeEventListener('dblclick', readSelection);
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, []);

  const handleTranslate = async () => {
    if (!sel) return;
    if (translateOpen && (translation || translating)) {
      setTranslateOpen(false);
      return;
    }
    setTranslateOpen(true);
    if (!speaking) {
      void handleSpeak(true);
    }
    if (translation) return;

    const myReq = ++transReqRef.current;
    setTranslating(true);
    setTranslateError('');
    try {
      const res = await translateSelection(sel.text, sel.context);
      if (transReqRef.current !== myReq) return;
      setTranslation(res);
    } catch (e) {
      if (transReqRef.current !== myReq) return;
      setTranslateError('翻译失败：' + String(e));
    } finally {
      if (transReqRef.current === myReq) {
        setTranslating(false);
      }
    }
  };

  const handleSpeak = async (silentOnError = false) => {
    if (!sel) return;
    if (speaking) {
      speakReqRef.current++;
      stopAudio();
      return;
    }
    stopAudio();
    const myReq = ++speakReqRef.current;
    const clean =
      sel.text.replace(/^[\s"'“”‘’.,!?;:()[\]]+|[\s"'“”‘’.,!?;:()[\]]+$/g, '').trim() || sel.text;
    const accent = loadSpeakState().config.accent || 'uk';
    setSpeaking(true);
    try {
      let url = '';
      if (/^[A-Za-z][A-Za-z'-]*$/.test(clean)) {
        try {
          const hit = await getWordAudio(clean, accent);
          url = hit.url;
        } catch {
          url = await synthesizeSpeech(clean, accent);
        }
      } else {
        url = await synthesizeSpeech(clean, accent);
      }
      if (speakReqRef.current !== myReq) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      blobUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        if (audioRef.current === audio) stopAudio();
      };
      audio.onerror = () => {
        if (audioRef.current === audio) stopAudio();
      };
      await audio.play();
    } catch (e) {
      if (speakReqRef.current === myReq) {
        setSpeaking(false);
        if (!silentOnError) {
          setTranslateOpen(true);
          setTranslateError('朗读失败：' + String(e));
        }
      }
    }
  };

  if (!sel) return null;

  return (
    <div
      ref={popRef}
      className="selection-popover"
      onMouseDown={(e) => e.preventDefault()}
      style={{
        left: pos?.left ?? Math.max(12, sel.anchorX - 75),
        top: pos?.top ?? sel.rectBottom + 8,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      <div className="selection-bar" role="toolbar" aria-label="划词工具">
        <button
          type="button"
          className={`selection-action-btn${translateOpen ? ' active' : ''}`}
          onClick={() => void handleTranslate()}
        >
          <IconTranslate size={14} />
          <span>翻译</span>
        </button>
        <span className="selection-divider" />
        <button
          type="button"
          className={`selection-action-btn${speaking ? ' active' : ''}`}
          onClick={() => void handleSpeak()}
        >
          {speaking ? <IconStop size={14} /> : <IconVolume size={14} />}
          <span>{speaking ? '停止' : '朗读'}</span>
        </button>
      </div>

      {translateOpen && (
        <div className="selection-translate-drop">
          {translating ? (
            <div className="selection-trans-meaning" style={{ color: 'var(--muted)' }}>
              正在翻译…
            </div>
          ) : translateError ? (
            <div className="selection-trans-err">{translateError}</div>
          ) : translation ? (
            <>
              <div className="selection-trans-head">
                <span className="selection-trans-word">{translation.text}</span>
                {translation.phonetic && <span className="selection-trans-ipa">{translation.phonetic}</span>}
              </div>
              <div className="selection-trans-meaning">{translation.meaning}</div>
              {translation.note && <div className="selection-trans-note">{translation.note}</div>}
              {/[A-Za-z]/.test(translation.text) && translation.text.length <= 48 && (
                <div className="selection-trans-foot">
                  <button
                    type="button"
                    className={`selection-save-btn${savedWord ? ' saved' : ''}`}
                    onClick={() => {
                      addMistakeToWordBook(translation.text, '划词翻译', translation.meaning);
                      setSavedWord(true);
                    }}
                  >
                    {savedWord ? <IconCheck size={13} /> : <IconPlus size={13} />}
                    <span>{savedWord ? '已收进错词本' : '收进错词本'}</span>
                  </button>
                </div>
              )}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
