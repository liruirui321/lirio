import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { history, analyze, type Submission } from '../../services/submissions';
import { isExamInstruction } from '../../services/examInstructions';
import { addMistakeToWordBook, loadCorpusState } from '../../services/corpusService';
import { simplifyMaterialTitle } from '../../services/materialTitle';
import { ReviewAudio } from '../../services/reviewAudio';
import { listeningInsights, type ListeningInsight, type Pronunciations } from '../../services/listeningInsights';
import {
  generateListeningDiagnosis,
  loadSpeakState,
  type ListeningDiagnosis,
} from '../../services/speakService';
import { useProjectStore } from '../../stores/projectStore';
import pronunciationUrl from '../../data/pronunciations.json?url';
import {
  IconCheck,
  IconClose,
  IconPlus,
  IconReplay,
  IconSparkle,
  IconStop,
  IconVolume,
} from '../Icons';

type ScopeFilter = 'all' | 'first' | 'current';
type AnalysisTab = 'words' | 'patterns' | 'sentences';

export function SubmissionAnalysis({
  onJumpToSentence,
}: {
  onJumpToSentence?: (projectId: string, sentenceId: string, start: number) => void;
}) {
  const project = useProjectStore((s) => s.project);
  const [records, setRecords] = useState<Submission[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<ScopeFilter>('all');
  const [tab, setTab] = useState<AnalysisTab>('words');
  const [selectedWord, setSelectedWord] = useState('');
  const [rowLimit, setRowLimit] = useState(15);

  const [addedWords, setAddedWords] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    try {
      const { mistakes } = loadCorpusState();
      for (const k of Object.keys(mistakes)) initial[k] = true;
    } catch {}
    return initial;
  });

  // Audio playback
  const playerRef = useRef(new ReviewAudio());
  const [audioStatus, setAudioStatus] = useState('');
  const [playingKey, setPlayingKey] = useState<string | null>(null);

  // Lazy dictionary for connected speech tab
  const [dict, setDict] = useState<Pronunciations | null>(null);
  const [dictLoading, setDictLoading] = useState(false);

  // On-demand AI diagnosis
  const [diagnosis, setDiagnosis] = useState<ListeningDiagnosis | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagError, setDiagError] = useState('');

  const refresh = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const result = await history(project);
      setRecords(result.records);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [project]);

  useEffect(() => {
    void refresh();
    return () => {
      playerRef.current.dispose();
    };
  }, []);

  // Lazy-load CMU pronunciation dictionary only when user opens "连读与弱读" tab
  useEffect(() => {
    if (tab !== 'patterns' || dict || dictLoading) return;
    let active = true;
    setDictLoading(true);
    fetch(pronunciationUrl)
      .then((r) => {
        if (!r.ok) throw new Error('读音词典加载失败');
        return r.json();
      })
      .then((d) => {
        if (active) setDict(d);
      })
      .catch(() => {
        if (active) setDict({});
      })
      .finally(() => {
        if (active) setDictLoading(false);
      });
    return () => {
      active = false;
    };
  }, [tab, dict, dictLoading]);

  const selected = useMemo(
    () =>
      records.filter((r) => {
        if (isExamInstruction(r.expected)) return false;
        if (filter === 'first' && r.attempt !== 1) return false;
        if (filter === 'current' && r.projectId !== project?.libraryId && r.projectId !== project?.id) return false;
        return true;
      }),
    [records, filter, project?.id, project?.libraryId],
  );

  const stats = useMemo(() => analyze(selected), [selected]);

  // Actionable connected-speech & weak-form clues (deduped, noise filtered)
  const cleanInsights = useMemo(() => {
    if (!dict) return [] as ListeningInsight[];
    const raw = listeningInsights(selected, dict).filter((item) => item.kind !== '原因待核对');
    const seen = new Set<string>();
    const out: ListeningInsight[] = [];
    for (const item of raw) {
      const key = `${item.kind}::${item.word}::${item.phrase}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out.slice(0, 15);
  }, [selected, dict]);

  const errorRows = useMemo(
    () =>
      stats.errorTimeline.filter(
        (r) =>
          !selectedWord ||
          r.result.edits.some((e) => e.expected === selectedWord && (e.kind === 'wrong' || e.kind === 'missing')),
      ),
    [stats.errorTimeline, selectedWord],
  );

  const playClip = async (key: string, record: Submission, phrase: string | null) => {
    if (playingKey === key) {
      playerRef.current.stop();
      setPlayingKey(null);
      setAudioStatus('');
      return;
    }
    setAudioStatus('');
    setPlayingKey(key);
    try {
      await playerRef.current.play(record, phrase, 1, () => {
        setPlayingKey((cur) => (cur === key ? null : cur));
      });
    } catch (e) {
      setPlayingKey(null);
      setAudioStatus('无法重听原句：' + String(e));
    }
  };

  const handleAddSingleWord = (word: string, sourceTitle?: string) => {
    addMistakeToWordBook(word, sourceTitle || '听力复盘');
    setAddedWords((prev) => ({ ...prev, [word.toLowerCase()]: true }));
  };

  const topUnsavedWords = useMemo(
    () => stats.contentMistakes.slice(0, 20).filter((w) => !addedWords[w.word.toLowerCase()]),
    [stats.contentMistakes, addedWords],
  );

  const handleBulkAddWords = () => {
    if (!topUnsavedWords.length) return;
    const nextAdded: Record<string, boolean> = {};
    for (const item of topUnsavedWords) {
      addMistakeToWordBook(item.word, item.latestRecord ? simplifyMaterialTitle(item.latestRecord.projectName).shortTitle : '听力复盘');
      nextAdded[item.word.toLowerCase()] = true;
    }
    setAddedWords((prev) => ({ ...prev, ...nextAdded }));
    setAudioStatus(`已将 ${topUnsavedWords.length} 个实词加入「单词 → 错词本」`);
  };

  const handleRunAiDiagnosis = async () => {
    if (!selected.length || diagnosing) return;
    setDiagnosing(true);
    setDiagError('');
    try {
      const { config } = loadSpeakState();
      const res = await generateListeningDiagnosis(config, {
        totalSentences: selected.length,
        avgScore: stats.avgScore,
        topContentMistakes: stats.contentMistakes.slice(0, 12).map((w) => ({
          word: w.word,
          count: w.totalErrors,
          confusions: Object.entries(w.confusions)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([actual, n]) => `${actual}(${n})`),
        })),
        topWeakWords: stats.missedFunctionWords.slice(0, 6).map((w) => ({
          word: w.word,
          missed: w.missing,
          seen: w.seen,
        })),
        sampleErrors: stats.errorTimeline.slice(0, 8).map((r) => ({
          expected: r.expected,
          answer: r.answer,
        })),
      });
      setDiagnosis(res);
    } catch (e) {
      setDiagError('AI 诊断失败：' + String(e));
    } finally {
      setDiagnosing(false);
    }
  };

  const topWeakSummary = stats.missedFunctionWords
    .slice(0, 3)
    .map((w) => w.word)
    .join(' · ');

  return (
    <section className="submission-analysis" aria-label="听力复盘">
      <div className="analysis-wrap">
        {/* Clean Header: Title + Scope Pill + AI Diagnosis & Refresh */}
        <div className="analysis-head">
          <div className="analysis-head-left">
            <h1>听力复盘</h1>
            <div className="seg-pill" role="tablist" aria-label="分析范围">
              <button
                type="button"
                className={filter === 'all' ? 'active' : ''}
                onClick={() => setFilter('all')}
              >
                全部
              </button>
              <button
                type="button"
                className={filter === 'first' ? 'active' : ''}
                onClick={() => setFilter('first')}
              >
                仅首次
              </button>
              {project && (
                <button
                  type="button"
                  className={filter === 'current' ? 'active' : ''}
                  onClick={() => setFilter('current')}
                >
                  当前材料
                </button>
              )}
            </div>
          </div>

          <div className="analysis-head-actions">
            <button
              type="button"
              className="analysis-ai-btn"
              disabled={diagnosing || !selected.length}
              onClick={() => void handleRunAiDiagnosis()}
              title="使用当前对话模型分析薄弱点"
            >
              <IconSparkle size={14} />
              {diagnosing ? '诊断中…' : 'AI 诊断'}
            </button>
            <button
              type="button"
              className="icon-btn"
              disabled={busy}
              title="刷新记录"
              aria-label="刷新记录"
              onClick={() => void refresh()}
            >
              <IconReplay size={15} />
            </button>
          </div>
        </div>

        {error && (
          <div className="corpus-banner" onClick={() => setError('')}>
            {error}
          </div>
        )}
        {audioStatus && (
          <div className="corpus-banner" onClick={() => setAudioStatus('')}>
            {audioStatus}
          </div>
        )}

        {/* 3 Clean KPI Cards */}
        <div className="analysis-kpi-row">
          <div className="analysis-kpi">
            <span className="analysis-kpi-label">平均正确率</span>
            <div className="analysis-kpi-val">
              <strong>{stats.avgScore}%</strong>
              {stats.recentTrend !== null && stats.recentTrend !== 0 && (
                <span className={`analysis-trend${stats.recentTrend < 0 ? ' down' : ''}`}>
                  {stats.recentTrend > 0 ? `+${stats.recentTrend}%` : `${stats.recentTrend}%`}
                </span>
              )}
            </div>
            <small>{stats.recentTrend !== null ? '近 5 句相对前 5 句趋势' : '提交满 10 句后显示走势'}</small>
          </div>

          <div className="analysis-kpi">
            <span className="analysis-kpi-label">累计听写</span>
            <div className="analysis-kpi-val">
              <strong>{selected.length} 句</strong>
            </div>
            <small>
              {stats.improved > 0 ? `重听后有 ${stats.improved} 句明显进步` : '每次提交会自动沉淀在这里'}
            </small>
          </div>

          <div className="analysis-kpi">
            <span className="analysis-kpi-label">实词盲区</span>
            <div className="analysis-kpi-val">
              <strong>{stats.contentMistakes.length} 词</strong>
            </div>
            <small>{topWeakSummary ? `弱读高频：${topWeakSummary}` : '未发现高频弱读漏词'}</small>
          </div>
        </div>

        {/* On-Demand AI Diagnosis Result */}
        {(diagnosis || diagError) && (
          <div className="analysis-ai-card">
            <div className="analysis-ai-head">
              <strong>{diagError || diagnosis?.headline}</strong>
              <button
                type="button"
                className="icon-btn"
                title="收起诊断"
                aria-label="收起诊断"
                onClick={() => {
                  setDiagnosis(null);
                  setDiagError('');
                }}
              >
                <IconClose size={14} />
              </button>
            </div>
            {diagnosis && (diagnosis.patterns.length > 0 || diagnosis.nextActions.length > 0) && (
              <div className="analysis-ai-cols">
                <div>
                  <h4>主要失分模式</h4>
                  <ul>
                    {diagnosis.patterns.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h4>下一步怎么练</h4>
                  <ul>
                    {diagnosis.nextActions.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Single Focused Card with 3 Clean Tabs */}
        <div className="analysis-card">
          <div className="analysis-card-head">
            <div className="seg-pill" role="tablist" aria-label="复盘维度">
              <button
                type="button"
                className={tab === 'words' ? 'active' : ''}
                onClick={() => setTab('words')}
              >
                高频错词 ({stats.contentMistakes.length})
              </button>
              <button
                type="button"
                className={tab === 'patterns' ? 'active' : ''}
                onClick={() => setTab('patterns')}
              >
                连读与弱读
              </button>
              <button
                type="button"
                className={tab === 'sentences' ? 'active' : ''}
                onClick={() => setTab('sentences')}
              >
                错句回看 ({errorRows.length})
              </button>
            </div>

            {tab === 'words' && stats.contentMistakes.length > 0 && (
              <button
                type="button"
                className="analysis-bulk-btn"
                disabled={!topUnsavedWords.length}
                onClick={handleBulkAddWords}
              >
                {topUnsavedWords.length ? `全部加入错词本 (${topUnsavedWords.length})` : '已全部加入错词本'}
              </button>
            )}

            {tab === 'sentences' && selectedWord && (
              <span className="analysis-filter-chip">
                筛选：{selectedWord}
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="清除筛选"
                  onClick={() => setSelectedWord('')}
                >
                  <IconClose size={12} />
                </button>
              </span>
            )}
          </div>

          {/* TAB 1: High-Frequency Content Mistakes */}
          {tab === 'words' && (
            <div className="analysis-word-list">
              {stats.contentMistakes.length === 0 ? (
                <div className="corpus-empty">当前范围暂无高频实词漏听或拼错记录。</div>
              ) : (
                stats.contentMistakes.slice(0, 20).map((w) => {
                  const key = `word:${w.word}`;
                  const added = !!addedWords[w.word.toLowerCase()];
                  const confusions = Object.entries(w.confusions)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 2)
                    .map(([v, n]) => `误写成 ${v} (${n})`)
                    .join(' · ');
                  return (
                    <div key={w.word} className="analysis-word-row">
                      <button
                        type="button"
                        className="analysis-word-btn"
                        title="点击查看相关错句"
                        onClick={() => {
                          setSelectedWord(w.word);
                          setRowLimit(15);
                          setTab('sentences');
                        }}
                      >
                        {w.word}
                      </button>

                      <div className="analysis-word-meta">
                        <span>错 {w.totalErrors} / {w.seen} 次</span>
                        {w.missing > 0 && <span>漏听 {w.missing} 次</span>}
                        {confusions && <span>{confusions}</span>}
                      </div>

                      <div className="analysis-row-actions">
                        {w.latestRecord && (
                          <button
                            type="button"
                            className={`icon-btn${playingKey === key ? ' active' : ''}`}
                            title="重听最近出错原句"
                            aria-label="重听原句"
                            onClick={() => void playClip(key, w.latestRecord!, null)}
                          >
                            {playingKey === key ? <IconStop size={14} /> : <IconVolume size={14} />}
                          </button>
                        )}
                        <button
                          type="button"
                          className={`icon-btn${added ? ' active' : ''}`}
                          title={added ? '已在单词本中' : '加入单词错词本'}
                          aria-label="加入错词本"
                          onClick={() =>
                            handleAddSingleWord(
                              w.word,
                              w.latestRecord ? simplifyMaterialTitle(w.latestRecord.projectName).shortTitle : '听力复盘',
                            )
                          }
                        >
                          {added ? <IconCheck size={14} /> : <IconPlus size={14} />}
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {/* TAB 2: Actionable Connected Speech & Weak Forms */}
          {tab === 'patterns' && (
            <div className="analysis-pattern-list">
              {dictLoading ? (
                <div className="corpus-empty">正在匹配连读与弱读线索…</div>
              ) : cleanInsights.length === 0 ? (
                <div className="corpus-empty">当前范围暂无明显的连读、同音或弱读失分线索。</div>
              ) : (
                cleanInsights.map((item, idx) => {
                  const phraseKey = `phrase:${item.record.id}:${idx}`;
                  const fullKey = `full:${item.record.id}:${idx}`;
                  return (
                    <div key={phraseKey} className="analysis-pattern-row">
                      <div className="analysis-pattern-top">
                        <span className="tier-badge small">{item.kind}</span>
                        <div className="analysis-row-actions">
                          <button
                            type="button"
                            onClick={() => void playClip(phraseKey, item.record, item.phrase)}
                          >
                            {playingKey === phraseKey ? '停止' : '听语块'}
                          </button>
                          <button
                            type="button"
                            onClick={() => void playClip(fullKey, item.record, null)}
                          >
                            {playingKey === fullKey ? '停止' : '听原句'}
                          </button>
                        </div>
                      </div>
                      <div className="analysis-pattern-phrase">{item.phrase}</div>
                      <div className="analysis-pattern-diff">
                        参考：<b>{item.word}</b> · 你写的是：<b>{item.actual}</b>
                        {item.otherCorrect > 0 && (
                          <span style={{ marginLeft: 8, color: 'var(--accent-bright)' }}>
                            （你在其他句里写对过 {item.otherCorrect} 次，多为连读干扰）
                          </span>
                        )}
                      </div>
                      <div className="analysis-pattern-reason">{item.reason}</div>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {/* TAB 3: Sentence Replay & Inline Diff */}
          {tab === 'sentences' && (
            <div className="analysis-sentence-list">
              {errorRows.length === 0 ? (
                <div className="corpus-empty">当前范围没有包含错误的句子记录。</div>
              ) : (
                <>
                  {errorRows.slice(0, rowLimit).map((r) => {
                    const key = `sent:${r.id}`;
                    const { shortTitle } = simplifyMaterialTitle(r.projectName);
                    return (
                      <div key={r.id} className="analysis-sentence-row">
                        <div className="analysis-sentence-top">
                          <span>
                            {shortTitle} · 第 {r.attempt} 次 · {r.result.score}%
                          </span>
                          <div className="analysis-row-actions">
                            {onJumpToSentence && (
                              <button
                                type="button"
                                className="dict-slow-btn"
                                title="跳转到原文这一句继续精听"
                                onClick={() => onJumpToSentence(r.projectId, r.sentenceId, r.start)}
                              >
                                去原句重听写
                              </button>
                            )}
                            <button
                              type="button"
                              className={`icon-btn${playingKey === key ? ' active' : ''}`}
                              title="重听原句"
                              aria-label="重听原句"
                              onClick={() => void playClip(key, r, null)}
                            >
                              {playingKey === key ? <IconStop size={14} /> : <IconVolume size={14} />}
                            </button>
                          </div>
                        </div>
                        <div className="analysis-diff-inline">
                          {r.result.edits.map((e, i) => {
                            if (e.kind === 'correct') {
                              return <span key={i} className="edit-token correct">{e.actual}</span>;
                            }
                            if (e.kind === 'wrong') {
                              return (
                                <span key={i} className="edit-token wrong" title={`你写了 ${e.actual || '空白'}`}>
                                  {e.expected} ({e.actual})
                                </span>
                              );
                            }
                            if (e.kind === 'missing') {
                              return (
                                <span key={i} className="edit-token missing">
                                  {e.expected}
                                </span>
                              );
                            }
                            if (e.kind === 'extra') {
                              return (
                                <span key={i} className="edit-token extra">
                                  +{e.actual}
                                </span>
                              );
                            }
                            return (
                              <span key={i} className="edit-token">
                                {e.expected}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                  {errorRows.length > rowLimit && (
                    <button
                      type="button"
                      style={{ alignSelf: 'center', marginTop: 10 }}
                      onClick={() => setRowLimit((n) => n + 15)}
                    >
                      再看 15 句 ({errorRows.length - rowLimit})
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
