import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { simplifyMaterialTitle } from '../../services/materialTitle';
import { CustomSelect, type SelectOption } from '../Corpus/CustomSelect';
import { IconExport, IconHeadphones, IconReplay } from '../Icons';
import './MaterialLibrary.css';

interface Material {
  id: string;
  name: string;
  duration: number;
  sentenceCount: number;
  completed: number;
  favorites: number;
}

type TierId = 'all' | 'L1' | 'L2' | 'L3' | 'L4';

interface TierDef {
  id: Exclude<TierId, 'all'>;
  code: string;
  title: string;
  subtitle: string;
  cefr: string;
}

const TIERS: TierDef[] = [
  { id: 'L1', code: 'L1', title: '基础生活', subtitle: 'Part 1 日常对话 · 慢速精听', cefr: 'A2–B1' },
  { id: 'L2', code: 'L2', title: '进阶叙事', subtitle: 'Part 2 场景独白 · 日常播客', cefr: 'B1–B2' },
  { id: 'L3', code: 'L3', title: '高阶研讨', subtitle: 'Part 3 学术讨论 · 机经考点', cefr: 'B2–C1' },
  { id: 'L4', code: 'L4', title: '专业讲座', subtitle: 'Part 4 学术独白 · 深度播客', cefr: 'C1–C2' },
];

interface AwesomePodcast {
  slug: string;
  tier: Exclude<TierId, 'all'>;
  name: string;
  desc: string;
  rssUrl: string;
}

// Curated from github.com/yvoronoy/awesome-english (Listening > Podcasts by level)
const AWESOME_PODCASTS: AwesomePodcast[] = [
  {
    slug: 'bbc-6min',
    tier: 'L1',
    name: 'BBC 6 Minute English',
    desc: '经典 6 分钟英音慢速精听，每周聚焦一个生活与社会话题，结构清晰',
    rssUrl: 'https://podcasts.files.bbci.co.uk/p02pc9tn.rss',
  },
  {
    slug: 'all-ears-english',
    tier: 'L2',
    name: 'All Ears English',
    desc: '自然美式口语对话与文化习语，适合从应试过渡到真实语速',
    rssUrl: 'https://feeds.megaphone.fm/allearsenglish',
  },
  {
    slug: 'lukes-english',
    tier: 'L2',
    name: "Luke's English Podcast",
    desc: '英国喜剧演员兼英语老师主持，英音自然幽默，词汇表达丰富',
    rssUrl: 'https://audioboom.com/channels/4997220.rss',
  },
  {
    slug: 'curious-minds',
    tier: 'L3',
    name: 'English Learning for Curious Minds',
    desc: '历史、哲学、科技与文化深度话题，语速适中、逻辑严密',
    rssUrl: 'https://feeds.transistor.fm/english-learning-for-curious-minds',
  },
  {
    slug: 'this-american-life',
    tier: 'L4',
    name: 'This American Life',
    desc: '美国深度纪实叙事广播，真实连读、多口音与复杂叙事结构',
    rssUrl: 'https://www.thisamericanlife.org/podcast/rss.xml',
  },
  {
    slug: 'hard-fork',
    tier: 'L4',
    name: 'Hard Fork (NYT Tech)',
    desc: '纽约时报科技与 AI 前沿对谈播客，高语速真实访谈精听挑战',
    rssUrl: 'https://feeds.simplecast.com/l2i9YnTd',
  },
];

function classifyMaterial(name: string) {
  const book = name.match(/(?:剑桥(?:雅思)?|剑雅|Cambridge(?:\s+IELTS)?)\s*(\d+)|IELTS\s*(\d+)/i);
  const kind = /机经/.test(name) ? 'recalled' : book ? 'cambridge' : 'other';
  const month = name.match(/20\d{2}[-.]\d{1,2}/)?.[0].replace('.', '-') || '';
  const group = kind === 'cambridge' ? `剑雅 ${book?.[1] || book?.[2]}` : kind === 'recalled' ? month : '';
  const test = name.match(/Test\s*(\d+)/i)?.[1];
  const recalledSet = name.match(/·\s*(\d+)\s*·/)?.[1];
  const part = name.match(/Part\s*(\d+)/i)?.[1] || '';

  const explicitTier = name.match(/^\[(L[1-4])\]/i)?.[1]?.toUpperCase() as Exclude<TierId, 'all'> | undefined;
  let tier: Exclude<TierId, 'all'> = explicitTier || 'L2';
  if (!explicitTier) {
    if (part === '1' || /bbc|6\s*min|beginner|esl/i.test(name)) tier = 'L1';
    else if (part === '2' || /all\s*ears|luke|culips/i.test(name)) tier = 'L2';
    else if (part === '3' || (kind === 'recalled' && !part) || /curious/i.test(name)) tier = 'L3';
    else if (part === '4' || /american\s*life|hard\s*fork|lecture|ted/i.test(name)) tier = 'L4';
  }

  return {
    kind,
    group,
    set: test ? `Test ${test}` : recalledSet ? `第 ${recalledSet} 套` : '',
    part,
    tier,
  };
}

export function MaterialLibrary({
  onOpen,
  onOpenLocalPath,
  onImportDownloadedPodcast,
  refreshKey = 0,
}: {
  onOpen: (id: string) => Promise<void>;
  onOpenLocalPath?: (path: string, title?: string) => Promise<void>;
  onImportDownloadedPodcast?: (
    path: string,
    title?: string,
    tier?: Exclude<TierId, 'all'>,
  ) => Promise<void>;
  refreshKey?: number;
}) {
  const [items, setItems] = useState<Material[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState('');
  const [downloadingSlug, setDownloadingSlug] = useState('');
  const [subTab, setSubTab] = useState<'local' | 'podcasts'>('local');

  const [tier, setTier] = useState<TierId>('all');
  const [kind, setKind] = useState('');
  const [group, setGroup] = useState('');
  const [search, setSearch] = useState('');

  const refresh = () => {
    setError('');
    setLoading(true);
    invoke<Material[]>('library_list')
      .then(setItems)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(refresh, [refreshKey]);

  const tagged = useMemo(() => items.map((item) => ({ item, ...classifyMaterial(item.name) })), [items]);

  const resumeInfo = useMemo(() => {
    if (!items.length) return null;
    try {
      const raw = localStorage.getItem('aboboo-last-listening');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { libraryId?: string; title?: string; index?: number; total?: number };
      const match =
        (parsed.libraryId ? items.find((m) => m.id === parsed.libraryId) : undefined) ||
        (parsed.title ? items.find((m) => simplifyMaterialTitle(m.name).shortTitle === parsed.title) : undefined);
      if (!match) return null;
      return {
        item: match,
        title: simplifyMaterialTitle(match.name).shortTitle,
        index: parsed.index ?? 0,
        total: parsed.total || match.sentenceCount,
      };
    } catch {
      return null;
    }
  }, [items]);

  const tierStats = useMemo(() => {
    const map: Record<Exclude<TierId, 'all'>, { total: number; started: number }> = {
      L1: { total: 0, started: 0 },
      L2: { total: 0, started: 0 },
      L3: { total: 0, started: 0 },
      L4: { total: 0, started: 0 },
    };
    for (const m of tagged) {
      map[m.tier].total++;
      if (m.item.completed > 0) map[m.tier].started++;
    }
    return map;
  }, [tagged]);

  const inTierAndKind = useMemo(
    () => tagged.filter((m) => (tier === 'all' || m.tier === tier) && (!kind || m.kind === kind)),
    [tagged, tier, kind],
  );

  const groups = useMemo(
    () => [...new Set(inTierAndKind.map((m) => m.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    [inTierAndKind],
  );

  const shown = useMemo(
    () =>
      inTierAndKind.filter(
        (m) =>
          (!group || m.group === group) &&
          m.item.name.toLowerCase().includes(search.trim().toLowerCase()),
      ),
    [inTierAndKind, group, search],
  );

  const kindOptions: SelectOption[] = useMemo(
    () => [
      { value: '', label: '全部来源' },
      { value: 'cambridge', label: '剑桥雅思' },
      { value: 'recalled', label: '机经真题' },
      { value: 'other', label: '播客与其他' },
    ],
    [],
  );

  const groupOptions: SelectOption[] = useMemo(
    () => [
      { value: '', label: '全部册数/月份' },
      ...groups.map((g) => ({ value: g, label: g })),
    ],
    [groups],
  );

  const handleDownloadPodcast = async (pod: AwesomePodcast) => {
    setError('');
    setDownloadingSlug(pod.slug);
    try {
      const res = await invoke<{ path: string; title: string }>('podcast_download_latest', {
        rssUrl: pod.rssUrl,
        slug: pod.slug,
      });
      if (onImportDownloadedPodcast) {
        await onImportDownloadedPodcast(res.path, `[${pod.tier}] ${pod.name} · ${res.title}`, pod.tier);
      } else if (onOpenLocalPath) {
        await onOpenLocalPath(res.path, `[${pod.tier}] ${pod.name} · ${res.title}`);
      }
    } catch (e) {
      setError(`拉取「${pod.name}」失败：${String(e)}`);
    } finally {
      setDownloadingSlug('');
    }
  };

  return (
    <section className="material-library" aria-label="阶梯听力材料库">
      <header className="library-head">
        <div>
          <h1>阶梯精听库</h1>
          <p>按难度阶梯循序精听，所有音频与拓展播客均优先存储于外接 SSD。</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div className="corpus-tabs">
            <button className={subTab === 'local' ? 'active' : ''} onClick={() => setSubTab('local')}>
              本机阶梯库 ({items.length})
            </button>
            <button className={subTab === 'podcasts' ? 'active' : ''} onClick={() => setSubTab('podcasts')}>
              拓展播客 (awesome-english)
            </button>
          </div>
          {subTab === 'local' && (
            <button
              className="icon-btn"
              title="刷新材料库"
              aria-label="刷新材料库"
              disabled={loading || !!opening}
              onClick={refresh}
            >
              <IconReplay size={15} />
            </button>
          )}
        </div>
      </header>

      {/* Resume Last Listening Session */}
      {subTab === 'local' && resumeInfo && (
        <div className="library-resume-bar">
          <div className="library-resume-info">
            <span className="tier-badge small">继续上次</span>
            <strong>{resumeInfo.title}</strong>
            <small>
              第 {resumeInfo.index + 1} / {resumeInfo.total} 句
            </small>
          </div>
          <button
            type="button"
            className="primary"
            disabled={!!opening}
            onClick={() => {
              setError('');
              setOpening(resumeInfo.item.id);
              onOpen(resumeInfo.item.id)
                .catch((e) => setError(String(e)))
                .finally(() => setOpening(''));
            }}
          >
            {opening === resumeInfo.item.id ? '打开中…' : '继续听写'}
          </button>
        </div>
      )}

      {/* 4-Tier Ladder Cards */}
      <div className="tier-grid">
        {TIERS.map((t) => {
          const stat = tierStats[t.id];
          const active = tier === t.id;
          return (
            <button
              key={t.id}
              type="button"
              className={`tier-card${active ? ' active' : ''}`}
              onClick={() => {
                setTier((prev) => (prev === t.id ? 'all' : t.id));
                setGroup('');
              }}
            >
              <div className="tier-card-top">
                <span className="tier-badge">{t.code}</span>
                <span className="tier-cefr">{t.cefr}</span>
              </div>
              <strong>{t.title}</strong>
              <small>{t.subtitle}</small>
              <div className="tier-meta">
                {subTab === 'local'
                  ? `${stat.total} 份材料 · 已练 ${stat.started}`
                  : `${AWESOME_PODCASTS.filter((p) => p.tier === t.id).length} 档精选播客`}
              </div>
            </button>
          );
        })}
      </div>

      {error && (
        <div className="app-error" style={{ borderRadius: 8, marginBottom: 14 }} onClick={() => setError('')}>
          {error}（点击关闭）
        </div>
      )}

      {/* SUBTAB 1: Local Graded Materials */}
      {subTab === 'local' && (
        <>
          <div className="library-filter">
            <CustomSelect
              value={kind}
              options={kindOptions}
              minWidth={116}
              onChange={(val) => {
                setKind(val);
                setGroup('');
              }}
            />
            <CustomSelect
              value={group}
              options={groupOptions}
              minWidth={132}
              onChange={(val) => setGroup(val)}
            />
            <input
              aria-label="搜索材料"
              placeholder="搜索材料标题…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {(tier !== 'all' || kind || group || search) && (
              <button
                onClick={() => {
                  setTier('all');
                  setKind('');
                  setGroup('');
                  setSearch('');
                }}
              >
                清除筛选
              </button>
            )}
          </div>

          {loading ? (
            <p className="corpus-empty">正在读取材料…</p>
          ) : !items.length ? (
            <p className="corpus-empty">材料库为空。点击上方打开音频，或去「拓展播客」一键拉取最新一期到 SSD。</p>
          ) : !shown.length ? (
            <p className="corpus-empty">当前阶梯筛选下没有匹配的材料。</p>
          ) : (
            <div className="library-list">
              {shown.map(({ item: m, tier: mTier }) => {
                const { shortTitle, badge } = simplifyMaterialTitle(m.name);
                return (
                  <button
                    className="material-row"
                    key={m.id}
                    title={m.name}
                    disabled={!!opening}
                    onClick={() => {
                      setError('');
                      setOpening(m.id);
                      onOpen(m.id)
                        .catch((e) => setError(String(e)))
                        .finally(() => setOpening(''));
                    }}
                  >
                    <span className="tier-badge small">{mTier}</span>
                    {badge && <span className="material-badge">{badge}</span>}
                    <span className="material-name">
                      <strong>{shortTitle}</strong>
                      <small>
                        {m.sentenceCount} 句 · 已练 {m.completed} 句
                      </small>
                    </span>
                    <span className="material-duration">
                      {Math.floor(m.duration / 60)}:{String(Math.floor(m.duration % 60)).padStart(2, '0')}
                    </span>
                    <span className="material-action">
                      {opening === m.id ? '打开中…' : m.completed ? '继续' : '开始'}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* SUBTAB 2: awesome-english Graded Podcasts -> Direct Download to SSD */}
      {subTab === 'podcasts' && (
        <div className="library-list">
          {AWESOME_PODCASTS.filter((p) => tier === 'all' || p.tier === tier).map((pod) => {
            const busy = downloadingSlug === pod.slug;
            return (
              <div key={pod.slug} className="material-row podcast-row">
                <span className="tier-badge small">{pod.tier}</span>
                <span className="material-name">
                  <strong>{pod.name}</strong>
                  <small>{pod.desc}</small>
                </span>
                <button
                  type="button"
                  className="icon-btn primary"
                  disabled={!!downloadingSlug}
                  title="拉取最新一集 MP3 到外接 SSD 并直接打开精听"
                  aria-label={`下载 ${pod.name} 最新一集`}
                  onClick={() => handleDownloadPodcast(pod)}
                >
                  {busy ? <IconHeadphones size={15} /> : <IconExport size={15} />}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
