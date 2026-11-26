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

// Theme toggle
const themeBtn = document.getElementById('themeBtn');
themeBtn.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  themeBtn.textContent = next === 'light' ? '深色' : '浅色';
});

// Interactive Live Product Usage Demos & Scroll Reveal
const DEMO_ORDER = ['speak', 'dictation', 'vocab'];
const DEMO_WAVE_HEIGHTS = [24, 48, 72, 38, 86, 62, 34, 78, 92, 54, 40, 68, 84, 30, 58, 90, 74, 42, 64, 88, 52, 36, 70, 82, 46, 60, 32, 22];

const demoController = (() => {
  const tabBtns = Array.from(document.querySelectorAll('.preview-tab'));
  const panes = Array.from(document.querySelectorAll('.preview-pane'));
  const jumpCards = Array.from(document.querySelectorAll('[data-jump-preview]'));
  const previewShell = document.querySelector('.preview-shell');
  const progressBar = document.getElementById('previewProgressBar');
  const liveBadge = document.getElementById('previewLiveBadge');

  let currentKey = 'speak';
  let autoRotate = true;
  let timers = [];
  let rafId = null;

  function clearAllTimers() {
    for (const id of timers) clearTimeout(id);
    timers = [];
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    stopVoicePulse();
  }

  function later(ms, fn) {
    const id = setTimeout(fn, ms);
    timers.push(id);
    return id;
  }

  function setProgressDuration(ms) {
    if (!progressBar) return;
    progressBar.style.transition = 'none';
    progressBar.style.width = '0%';
    void progressBar.offsetWidth;
    progressBar.style.transition = `width ${ms}ms linear`;
    progressBar.style.width = '100%';
  }

  function ensureWaveformBars() {
    const waveEl = document.getElementById('demoWaveform');
    if (!waveEl || waveEl.childElementCount > 0) return waveEl;
    waveEl.innerHTML = DEMO_WAVE_HEIGHTS.map(
      (h, idx) => `<span class="demo-wave-bar" style="--h:${h}%;--d:${(idx % 6) * 0.08}s"></span>`,
    ).join('');
    return waveEl;
  }

  function runDictationDemo(onDone) {
    const DURATION = 8800;
    setProgressDuration(DURATION);
    const waveEl = ensureWaveformBars();
    const waveBox = waveEl?.closest('.demo-wave-box');
    const playhead = document.getElementById('demoPlayhead');
    const playLabel = document.getElementById('demoPlayLabel');
    const slotsEl = document.getElementById('demoDictSlots');
    const aiBtn = document.getElementById('demoAiBtn');
    const toastEl = document.getElementById('demoMistakeToast');
    const zhEl = document.getElementById('demoZhLine');
    if (!slotsEl || !waveEl) return later(DURATION, onDone);

    const words = [
      { raw: 'The', fixed: 'The', err: false },
      { raw: 'coastal', fixed: 'coastal', err: false },
      { raw: 'ecosystem', fixed: 'ecosystem', err: false },
      { raw: 'is', fixed: 'is', err: false },
      { raw: 'chaing', fixed: 'changing', err: true },
      { raw: 'rapidly.', fixed: 'rapidly.', err: false },
    ];

    slotsEl.innerHTML = words.map(() => '<span class="demo-slot">_</span>').join('');
    const slotNodes = Array.from(slotsEl.children);
    const barNodes = Array.from(waveEl.children);
    if (aiBtn) {
      aiBtn.className = 'demo-ai-pill';
      aiBtn.textContent = 'AI 精校';
    }
    if (toastEl) {
      toastEl.hidden = true;
      toastEl.className = 'demo-mistake-pop';
    }
    if (zhEl) zhEl.hidden = true;
    waveBox?.classList.add('is-playing');
    if (playLabel) {
      const span = playLabel.querySelector('span');
      if (span) span.textContent = '本句播音中…';
    }
    barNodes.forEach((b) => b.classList.remove('played'));

    // Smooth playhead sweep over 4.2s
    const startTs = performance.now();
    const waveWidth = Math.max(120, waveEl.clientWidth - 4);
    if (playhead && waveEl) {
      playhead.style.left = `${waveEl.offsetLeft}px`;
    }
    function tickWave(now) {
      const ratio = Math.min(1, (now - startTs) / 4200);
      if (playhead) playhead.style.transform = `translateX(${ratio * waveWidth}px)`;
      const litCount = Math.floor(ratio * barNodes.length);
      barNodes.forEach((b, i) => b.classList.toggle('played', i <= litCount));
      if (ratio < 1) {
        rafId = requestAnimationFrame(tickWave);
      } else {
        waveBox?.classList.remove('is-playing');
        if (playLabel) {
          const span = playLabel.querySelector('span');
          if (span) span.textContent = '已自动断句 · 提交批改';
        }
      }
    }
    rafId = requestAnimationFrame(tickWave);

    // Character-by-character typing timeline
    let t = 420;
    words.forEach((w, wIdx) => {
      const node = slotNodes[wIdx];
      later(t, () => {
        slotNodes.forEach((n) => n.classList.remove('typing'));
        node.classList.add('typing');
        node.textContent = '';
      });
      for (let c = 1; c <= w.raw.length; c++) {
        const sub = w.raw.slice(0, c);
        later(t + c * 62, () => {
          node.textContent = sub;
        });
      }
      t += w.raw.length * 62 + 95;
    });

    // Grade + highlight typo
    later(t + 160, () => {
      slotNodes.forEach((node, idx) => {
        node.classList.remove('typing');
        node.classList.add(words[idx].err ? 'err' : 'ok');
      });
      if (toastEl) {
        toastEl.hidden = false;
        toastEl.textContent = 'chaing → changing ＋加入错词本';
      }
    });

    // Capture mistake + trigger optional AI polish pulse
    later(t + 1250, () => {
      if (toastEl) {
        toastEl.classList.add('saved');
        toastEl.textContent = 'changing 已收进错词本 ✓';
      }
      if (aiBtn) {
        aiBtn.classList.add('pulsing');
        aiBtn.textContent = 'AI 精校中…';
      }
    });

    // Finish AI polish & glide in Chinese reference
    later(t + 2250, () => {
      if (aiBtn) {
        aiBtn.classList.remove('pulsing');
        aiBtn.classList.add('done');
        aiBtn.textContent = 'AI 已精校 ✓';
      }
      const errSlot = slotNodes[4];
      if (errSlot) {
        errSlot.classList.remove('err');
        errSlot.classList.add('ok');
        errSlot.textContent = words[4].fixed;
      }
      if (zhEl) zhEl.hidden = false;
    });

    later(DURATION, onDone);
  }

  const SPEAK_PERSONAS = {
    clara: {
      name: 'Clara',
      initial: 'C',
      topic: '日常研究 · 随口聊',
      opener: "Hey, good to hear from you again! How's that research project going?",
      userChunks: [
        '还行，就是最近数据有点 ',
        'messy, ',
        'I feel a bit stuck on ',
        'the analysis part.',
      ],
      reply:
        'Totally get that. Stepping back for a day helps you spot the pattern—want to walk me through it?',
      upgradeFrom: '“a bit stuck on”',
      upgradeTo: '“hit a bit of a roadblock on”',
    },
    noah: {
      name: 'Noah',
      initial: 'N',
      topic: '职场复盘 · 简洁直接',
      opener: 'Morning! Quick check-in—what is the one bottleneck blocking your sprint right now?',
      userChunks: [
        '主要是接口这边有点 ',
        'delayed, ',
        'we feel a bit stuck on ',
        'the integration tests.',
      ],
      reply:
        'Got it. Isolate the flaky endpoint first and ship the core flow—want to prioritize the checklist?',
      upgradeFrom: '“a bit stuck on”',
      upgradeTo: '“bottlenecked at”',
    },
    oliver: {
      name: 'Oliver',
      initial: 'O',
      topic: 'IELTS Part 3 · 英式考官',
      opener:
        'Right, let us explore this further—why do you think young people delay major career decisions today?',
      userChunks: [
        '因为选择太多了，',
        'many graduates feel ',
        'a bit stuck on ',
        'their first step.',
      ],
      reply:
        'A thoughtful point. Would you say university courses prepare students well enough for that transition?',
      upgradeFrom: '“a bit stuck on”',
      upgradeTo: '“hesitant when taking”',
    },
  };
  let activePersonaKey = 'clara';
  let speakOrbVoiceRaf = null;

  function stopVoicePulse() {
    if (speakOrbVoiceRaf) {
      cancelAnimationFrame(speakOrbVoiceRaf);
      speakOrbVoiceRaf = null;
    }
    document.getElementById('demoPhoneOrbWrap')?.style.removeProperty('--voice-scale');
    document.getElementById('demoChatOrbWrap')?.style.removeProperty('--voice-scale');
  }

  function startVoicePulse(wrapEl) {
    stopVoicePulse();
    if (!wrapEl) return;
    const t0 = performance.now();
    function tick(now) {
      if (!wrapEl.classList.contains('is-listening')) {
        wrapEl.style.removeProperty('--voice-scale');
        speakOrbVoiceRaf = null;
        return;
      }
      const s = (now - t0) / 1000;
      const lvl = 1 + 0.09 * Math.abs(Math.sin(s * 6.4)) + 0.05 * Math.sin(s * 13.2 + 0.8);
      wrapEl.style.setProperty('--voice-scale', lvl.toFixed(3));
      speakOrbVoiceRaf = requestAnimationFrame(tick);
    }
    speakOrbVoiceRaf = requestAnimationFrame(tick);
  }

  function setOrbState(wrapEl, state) {
    if (!wrapEl) return;
    wrapEl.classList.remove('is-speaking', 'is-listening', 'is-thinking');
    if (state) wrapEl.classList.add(`is-${state}`);
    if (state === 'listening') startVoicePulse(wrapEl);
    else stopVoicePulse();
  }

  function runVocabDemo(onDone) {
    const DURATION = 8200;
    setProgressDuration(DURATION);
    const cardEl = document.getElementById('demoCorpusCard');
    const audioBtn = document.getElementById('demoVocabAudio');
    const barEl = document.getElementById('demoVocabBar');
    const counterEl = document.getElementById('demoVocabCounter');
    const dotsEl = document.getElementById('demoVocabDots');
    const wordEl = document.getElementById('demoVocabWord');
    const metaEl = document.getElementById('demoVocabMeta');
    const streakEl = document.getElementById('demoVocabStreak');
    const lettersEl = document.getElementById('demoVocabLetters');
    if (!lettersEl) return later(DURATION, onDone);

    const deck = [
      { word: 'SUSTAINABLE', meaning: 'adj. 可持续的', meta: '/səˈsteɪnəbl/ · 雅思 807 高频词', streak: 13, pct: '33%', counter: '1 / 3', dotIdx: 0 },
      { word: 'RESILIENT', meaning: 'adj. 有韧性的', meta: '/rɪˈzɪliənt/ · 错词本专杀', streak: 14, pct: '66%', counter: '2 / 3', dotIdx: 1 },
    ];
    if (streakEl) streakEl.textContent = '连对 12 🔥';
    cardEl?.classList.remove('is-correct');

    let offset = 0;
    deck.forEach((card) => {
      later(offset, () => {
        cardEl?.classList.remove('is-correct');
        if (barEl) barEl.style.width = card.pct;
        if (counterEl) counterEl.textContent = card.counter;
        if (dotsEl) {
          Array.from(dotsEl.children).forEach((d, i) => d.classList.toggle('active', i === card.dotIdx));
        }
        if (wordEl) wordEl.textContent = card.meaning;
        if (metaEl) metaEl.textContent = card.meta;
        audioBtn?.classList.add('is-playing');
        lettersEl.innerHTML = Array.from(card.word)
          .map((_, idx) => `<span class="demo-letter-tile${idx === 0 ? ' active' : ''}"></span>`)
          .join('');
      });

      const tiles = () => Array.from(lettersEl.children);
      let cursor = offset + 520;
      Array.from(card.word).forEach((ch, idx) => {
        later(cursor, () => {
          const list = tiles();
          const tile = list[idx];
          if (tile) {
            tile.classList.remove('active');
            tile.classList.add('filled');
            tile.textContent = ch.toLowerCase();
          }
          if (list[idx + 1]) list[idx + 1].classList.add('active');
        });
        cursor += 155;
      });

      later(cursor + 120, () => {
        audioBtn?.classList.remove('is-playing');
        cardEl?.classList.add('is-correct');
        lettersEl.innerHTML = `<span class="demo-word-passed">${card.word.toLowerCase()}</span>`;
        if (streakEl) {
          streakEl.textContent = `连对 ${card.streak} 🔥`;
          streakEl.classList.add('bump');
          later(260, () => streakEl.classList.remove('bump'));
        }
      });

      offset += 4000;
    });

    later(DURATION, onDone);
  }

  function applySpeakPersona(key) {
    activePersonaKey = SPEAK_PERSONAS[key] ? key : 'clara';
    const p = SPEAK_PERSONAS[activePersonaKey];
    document.querySelectorAll('.lirio-persona-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-persona') === activePersonaKey);
    });
    document.querySelectorAll('.lirio-mode-pill').forEach((btn) => {
      const m = btn.getAttribute('data-speak-mode');
      btn.classList.toggle('active', activePersonaKey === 'oliver' ? m === 'examiner' : m === 'chat');
    });
    const topicEl = document.getElementById('demoSpeakTopic');
    const promptEl = document.getElementById('demoPhonePrompt');
    const a1 = document.getElementById('demoAiAvatar1');
    const aT = document.getElementById('demoAiAvatarT');
    const a2 = document.getElementById('demoAiAvatar2');
    const n1 = document.getElementById('demoAiName1');
    const n2 = document.getElementById('demoAiName2');
    const t1 = document.getElementById('demoAiText1');
    const t2 = document.getElementById('demoAiText2');
    const reviewEl = document.getElementById('demoSpeakReview');
    if (topicEl) topicEl.textContent = p.topic;
    if (promptEl) promptEl.textContent = `“${p.opener}”`;
    if (a1) a1.textContent = p.initial;
    if (aT) aT.textContent = p.initial;
    if (a2) a2.textContent = p.initial;
    if (n1) n1.textContent = p.name;
    if (n2) n2.textContent = p.name;
    if (t1) t1.textContent = p.opener;
    if (t2) t2.textContent = p.reply;
    if (reviewEl) {
      const delEl = reviewEl.querySelector('.lirio-upgrade-line del');
      const strongEl = reviewEl.querySelector('.lirio-upgrade-line strong');
      if (delEl) delEl.textContent = p.upgradeFrom;
      if (strongEl) strongEl.textContent = p.upgradeTo;
    }
    return p;
  }

  function playChatBargeInTimeline(p, baseDelay, totalDuration, onDone) {
    const chatOrbWrap = document.getElementById('demoChatOrbWrap');
    const chatStatus = document.getElementById('demoChatStatus');
    const spaceCap = document.getElementById('demoSpaceKeyCap');
    const aiEl = document.getElementById('demoSpeakAi');
    const thinkingEl = document.getElementById('demoSpeakThinking');
    const ai2El = document.getElementById('demoSpeakAi2');
    const userEl = document.getElementById('demoSpeakUser');
    const userTextEl = document.getElementById('demoSpeakUserText');
    const reviewEl = document.getElementById('demoSpeakReview');
    if (!aiEl || !userEl || !userTextEl || !reviewEl) return;

    later(baseDelay, () => {
      aiEl.classList.add('visible');
    });

    // Barge-in interruption via Space key / orb tap
    later(baseDelay + 1200, () => {
      spaceCap?.classList.add('is-pressed');
      setOrbState(chatOrbWrap, 'listening');
      if (chatStatus) chatStatus.textContent = '已打断 · 正在聆听中英混说…';
      userEl.classList.add('visible');
    });
    later(baseDelay + 1530, () => {
      spaceCap?.classList.remove('is-pressed');
    });

    // Stream bilingual response while orb breathes with voice energy
    let t = baseDelay + 1600;
    let acc = '';
    p.userChunks.forEach((part) => {
      acc += part;
      const snap = acc;
      later(t, () => {
        userTextEl.textContent = snap;
      });
      t += 620;
    });

    // Orb enters thinking state + thinking dots bubble
    later(baseDelay + 4350, () => {
      setOrbState(chatOrbWrap, 'thinking');
      if (chatStatus) chatStatus.textContent = '思考中…';
      if (thinkingEl) thinkingEl.hidden = false;
    });

    // Reply bubble appears + orb returns to speaking
    later(baseDelay + 5450, () => {
      if (thinkingEl) thinkingEl.hidden = true;
      setOrbState(chatOrbWrap, 'speaking');
      if (chatStatus) chatStatus.textContent = `${p.name} 回复中…`;
      ai2El?.classList.add('visible');
    });

    // Native expression upgrade card slides in
    later(baseDelay + 6650, () => {
      reviewEl.classList.add('visible');
    });

    if (onDone) {
      later(totalDuration, onDone);
    }
  }

  function runSpeakDemo(onDone, opts) {
    const startInChat = Boolean(opts?.startInChat);
    const DURATION = startInChat ? 8600 : 11400;
    setProgressDuration(DURATION);
    const p = applySpeakPersona(activePersonaKey);

    const phoneStage = document.getElementById('demoSpeakPhone');
    const chatStage = document.getElementById('demoSpeakChat');
    const phoneOrbWrap = document.getElementById('demoPhoneOrbWrap');
    const chatOrbWrap = document.getElementById('demoChatOrbWrap');
    const phoneStatus = document.getElementById('demoPhoneStatus');
    const chatStatus = document.getElementById('demoChatStatus');
    const toChatBtn = document.getElementById('demoToChatBtn');
    const spaceCap = document.getElementById('demoSpaceKeyCap');

    const aiEl = document.getElementById('demoSpeakAi');
    const thinkingEl = document.getElementById('demoSpeakThinking');
    const ai2El = document.getElementById('demoSpeakAi2');
    const userEl = document.getElementById('demoSpeakUser');
    const userTextEl = document.getElementById('demoSpeakUserText');
    const reviewEl = document.getElementById('demoSpeakReview');
    if (!phoneStage || !chatStage || !aiEl || !userEl || !userTextEl || !reviewEl) {
      return later(DURATION, onDone);
    }

    phoneStage.hidden = startInChat;
    chatStage.hidden = !startInChat;
    toChatBtn?.classList.remove('is-pressed');
    spaceCap?.classList.remove('is-pressed');
    aiEl.classList.remove('visible');
    ai2El?.classList.remove('visible');
    userEl.classList.remove('visible');
    reviewEl.classList.remove('visible');
    if (thinkingEl) thinkingEl.hidden = true;
    userTextEl.textContent = '';

    setOrbState(phoneOrbWrap, 'speaking');
    setOrbState(chatOrbWrap, 'speaking');
    if (phoneStatus) phoneStatus.textContent = `${p.name} 正在说…`;
    if (chatStatus) chatStatus.textContent = `${p.name} 正在说 · 空格随时插话`;

    if (startInChat) {
      playChatBargeInTimeline(p, 80, DURATION, onDone);
      return;
    }

    // 1. Tap the Chat dock button -> morph to Chat Bubble Stage
    later(2500, () => {
      toChatBtn?.classList.add('is-pressed');
    });
    later(2950, () => {
      toChatBtn?.classList.remove('is-pressed');
      phoneStage.hidden = true;
      chatStage.hidden = false;
    });

    // 2-6. Play interactive barge-in timeline inside Chat Bubble Stage
    playChatBargeInTimeline(p, 2950, DURATION, onDone);
  }

  // Interactive Phone ↔ Chat toggle, Orb/Mic barge-in, Vocab speaker, and Persona switching
  document.getElementById('demoToChatBtn')?.addEventListener('click', () => {
    autoRotate = false;
    clearAllTimers();
    runSpeakDemo(() => {
      if (!document.hidden) startTab('speak');
    }, { startInChat: true });
  });

  document.getElementById('demoToPhoneBtn')?.addEventListener('click', () => {
    autoRotate = false;
    clearAllTimers();
    const phoneStage = document.getElementById('demoSpeakPhone');
    const chatStage = document.getElementById('demoSpeakChat');
    if (chatStage) chatStage.hidden = true;
    if (phoneStage) phoneStage.hidden = false;
    setOrbState(document.getElementById('demoPhoneOrbWrap'), 'speaking');
  });

  function toggleOrbBargeIn(wrap, statusEl) {
    if (!wrap) return;
    const next = wrap.classList.contains('is-listening') ? 'speaking' : 'listening';
    setOrbState(wrap, next);
    const p = SPEAK_PERSONAS[activePersonaKey];
    if (statusEl) {
      statusEl.textContent = next === 'listening' ? '已插话 · 正在听你说…' : `${p.name} 正在说…`;
    }
  }

  [document.getElementById('demoPhoneOrb'), document.getElementById('demoChatOrb')].forEach((btn) => {
    btn?.addEventListener('click', () => {
      autoRotate = false;
      const wrap = btn.closest('.lirio-orb-wrap');
      const statusEl = wrap?.id === 'demoPhoneOrbWrap'
        ? document.getElementById('demoPhoneStatus')
        : document.getElementById('demoChatStatus');
      toggleOrbBargeIn(wrap, statusEl);
    });
  });

  document.getElementById('demoPhoneMicBtn')?.addEventListener('click', (e) => {
    autoRotate = false;
    const btn = e.currentTarget;
    btn.classList.remove('is-pressed');
    void btn.offsetWidth;
    btn.classList.add('is-pressed');
    later(420, () => btn.classList.remove('is-pressed'));
    toggleOrbBargeIn(
      document.getElementById('demoPhoneOrbWrap'),
      document.getElementById('demoPhoneStatus'),
    );
  });

  document.getElementById('demoVocabAudio')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    btn.classList.add('is-playing');
    later(1100, () => btn.classList.remove('is-playing'));
  });

  document.querySelectorAll('.lirio-persona-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      autoRotate = false;
      activePersonaKey = btn.getAttribute('data-persona') || 'clara';
      startTab('speak');
    });
  });

  document.querySelectorAll('.lirio-mode-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      autoRotate = false;
      const mode = btn.getAttribute('data-speak-mode');
      activePersonaKey = mode === 'examiner' ? 'oliver' : 'clara';
      startTab('speak');
    });
  });

  function startTab(key) {
    clearAllTimers();
    currentKey = DEMO_ORDER.includes(key) ? key : 'speak';
    tabBtns.forEach((b) => b.classList.toggle('active', b.getAttribute('data-preview') === currentKey));
    panes.forEach((p) => p.classList.toggle('active', p.getAttribute('data-pane') === currentKey));
    jumpCards.forEach((c) => c.classList.toggle('active', c.getAttribute('data-jump-preview') === currentKey));

    if (liveBadge) {
      liveBadge.textContent = autoRotate
        ? '● 实机功能演示中'
        : '● 已切换至当前功能演示';
    }

    const onDone = () => {
      if (document.hidden) return;
      const nextKey = autoRotate
        ? DEMO_ORDER[(DEMO_ORDER.indexOf(currentKey) + 1) % DEMO_ORDER.length]
        : currentKey;
      startTab(nextKey);
    };

    if (currentKey === 'dictation') runDictationDemo(onDone);
    else if (currentKey === 'vocab') runVocabDemo(onDone);
    else runSpeakDemo(onDone);
  }

  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      autoRotate = false;
      startTab(btn.getAttribute('data-preview'));
    });
  });

  jumpCards.forEach((card) => {
    card.addEventListener('click', () => {
      autoRotate = false;
      startTab(card.getAttribute('data-jump-preview'));
      previewShell?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearAllTimers();
    } else {
      startTab(currentKey);
    }
  });

  if (tabBtns.length && panes.length) {
    startTab('speak');
  }
})();

// Scroll-reveal observer for pain cards, bento grid, VS cards & closing CTA
(() => {
  const targets = Array.from(document.querySelectorAll('[data-reveal]'));
  if (!targets.length) return;
  if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    targets.forEach((el) => el.classList.add('is-visible'));
    return;
  }
  const obs = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          obs.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.14 },
  );
  targets.forEach((el) => obs.observe(el));
})();

function renderCommunity(c) {
  if (!c) return;
  const nameEl = document.getElementById('communityGroupName');
  const noteEl = document.getElementById('communityNote');
  const numEl = document.getElementById('communityGroupNumber');
  const copyBtn = document.getElementById('copyQqBtn');
  const joinLink = document.getElementById('joinQqLink');
  const contactEl = document.getElementById('communityContact');
  const qrBox = document.getElementById('communityQrBox');

  if (nameEl && c.qqGroupName) nameEl.textContent = c.qqGroupName;
  if (noteEl && c.communityNote) noteEl.textContent = c.communityNote;

  const num = (c.qqGroupNumber || '').trim();
  if (numEl) {
    numEl.textContent = num ? `QQ 群号：${num}` : '群号待管理员在后台补充';
  }
  if (copyBtn) {
    copyBtn.hidden = !num;
    copyBtn.onclick = async () => {
      if (!num) return;
      await navigator.clipboard.writeText(num);
      copyBtn.textContent = '已复制';
      setTimeout(() => { copyBtn.textContent = '复制群号'; }, 1600);
    };
  }
  if (joinLink) {
    const link = (c.qqGroupLink || '').trim();
    if (link) {
      joinLink.href = link;
      joinLink.hidden = false;
    } else {
      joinLink.hidden = true;
    }
  }
  if (contactEl) {
    const contact = (c.supportContact || '').trim();
    if (contact) {
      contactEl.textContent = `联系：${contact}`;
      contactEl.hidden = false;
    } else {
      contactEl.hidden = true;
    }
  }
  if (qrBox) {
    const qr = (c.qqGroupQr || '').trim();
    qrBox.innerHTML = qr
      ? `<img src="${esc(qr)}" alt="QQ 交流群二维码" />`
      : '<span>QQ 群二维码待上传</span>';
  }
}

async function initSite() {
  // Fetch live community config (QQ group) from backend
  try {
    const commRes = await fetch('/api/community/config', { cache: 'no-store' });
    if (commRes.ok) {
      const data = await commRes.json();
      if (data?.community) renderCommunity(data.community);
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
  } else {
    heroBtn.textContent = `${primary?.label || '当前平台'} ${primary?.statusNote || '即将上线'} · 查看已支持版本`;
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
      const pendingText = p.statusNote ? `${p.label} ${p.statusNote}` : `${p.label} 敬请期待`;
      return `
        <div class="platform-card${isRec ? ' recommended' : ''}">
          <div class="platform-top">
            <strong>${esc(p.label)}</strong>
            ${badge}
          </div>
          <div class="platform-meta">${esc(p.arch)} · ${esc(p.minOs)}</div>
          <div class="platform-ver">${isComingSoon ? esc(p.statusNote || '暂不支持 · 敬请期待') : `v${esc(p.version)}${p.autoUpdate ? ' · 支持自动更新' : ''}`}</div>
          ${
            isComingSoon
              ? `<span class="platform-btn disabled">${esc(pendingText)}</span>`
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
