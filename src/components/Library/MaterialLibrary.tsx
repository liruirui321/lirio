import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { simplifyMaterialTitle } from '../../services/materialTitle';
import { CustomSelect, type SelectOption } from '../Corpus/CustomSelect';
import {
  IconCheck,
  IconClose,
  IconExport,
  IconFolderAudio,
  IconHeadphones,
  IconLibrary,
  IconPlay,
  IconReplay,
  IconTrash,
  IconUpload,
} from '../Icons';
import './MaterialLibrary.css';

interface Material {
  id: string;
  name: string;
  sourceKind?: 'user' | 'builtin' | 'podcast';
  createdAt?: string;
  duration: number;
  sentenceCount: number;
  completed: number;
  favorites: number;
}

const BUILTIN_NAME_RE = /^(?:\[L[1-4]\]|剑桥雅思|机经|IOT\b)/i;

function isUserUpload(m: Material): boolean {
  if (m.sourceKind === 'user') return true;
  if (m.sourceKind === 'builtin' || m.sourceKind === 'podcast') return false;
  return !BUILTIN_NAME_RE.test(m.name.trim());
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
  { id: 'L1', code: 'L1', title: '初学者', subtitle: '零基础 / 初中 · 慢速清晰短句', cefr: 'A1–A2' },
  { id: 'L2', code: 'L2', title: '高中生', subtitle: '高中 / 四级 · 慢速日常话题', cefr: 'A2–B1' },
  { id: 'L3', code: 'L3', title: '大学生', subtitle: '六级 / 雅思 Part 1–2 · 日常原声', cefr: 'B1–B2' },
  { id: 'L4', code: 'L4', title: '高阶进阶', subtitle: '雅思 Part 3–4 · 学术讲座与深度播客', cefr: 'C1–C2' },
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
    slug: 'voa-everyday-grammar',
    tier: 'L1',
    name: 'VOA Everyday Grammar',
    desc: '美音慢速基础语法与短句精听，语速清晰缓慢，适合零基础与初学者入门',
    rssUrl: 'https://learningenglish.voanews.com/podcast/?zoneId=4456',
  },
  {
    slug: 'bbc-6min-grammar',
    tier: 'L1',
    name: 'BBC 6 Minute Grammar',
    desc: '6 分钟英音慢速基础句型精讲，结构清晰、短句好听写',
    rssUrl: 'https://podcasts.files.bbci.co.uk/p02pc9s1.rss',
  },
  {
    slug: 'bbc-vocab',
    tier: 'L1',
    name: 'BBC Learning English Vocabulary',
    desc: '慢速高频核心词与生活例句，初学者积累听觉词汇首选',
    rssUrl: 'https://podcasts.files.bbci.co.uk/p02pc9xz.rss',
  },
  {
    slug: 'voa-as-it-is',
    tier: 'L2',
    name: 'VOA Learning English (As It Is)',
    desc: '经典美音慢速新闻与生活故事（约 100 词/分），高中生与四级过渡必备',
    rssUrl: 'https://learningenglish.voanews.com/podcast/?zoneId=3521',
  },
  {
    slug: 'bbc-6min',
    tier: 'L2',
    name: 'BBC 6 Minute English',
    desc: '经典 6 分钟英音生活与社会话题，适合高中与四级进阶精听',
    rssUrl: 'https://podcasts.files.bbci.co.uk/p02pc9tn.rss',
  },
  {
    slug: 'bbc-ew-speak',
    tier: 'L2',
    name: 'BBC The English We Speak',
    desc: '3 分钟地道日常短语与情景小对话，轻巧易跟听',
    rssUrl: 'https://podcasts.files.bbci.co.uk/p02pc9zn.rss',
  },
  {
    slug: 'all-ears-english',
    tier: 'L3',
    name: 'All Ears English',
    desc: '自然美式日常对话与文化习语，衔接大学六级、雅思与真实语速',
    rssUrl: 'https://feeds.megaphone.fm/allearsenglish',
  },
  {
    slug: 'lukes-english',
    tier: 'L3',
    name: "Luke's English Podcast",
    desc: '英国老师兼喜剧演员主持，英音自然幽默，表达地道丰富',
    rssUrl: 'https://audioboom.com/channels/4997220.rss',
  },
  {
    slug: 'npr-news',
    tier: 'L3',
    name: 'NPR News Now',
    desc: 'awesome-english 首页精选，5 分钟标准美音新闻快报，大学生与雅思基础精听标配',
    rssUrl: 'https://feeds.npr.org/500005/podcast.xml',
  },
  {
    slug: 'this-american-life',
    tier: 'L4',
    name: 'This American Life',
    desc: 'awesome-english 高阶精选，美国深度纪实叙事广播，真实连读、多口音与复杂叙事',
    rssUrl: 'https://www.thisamericanlife.org/podcast/rss.xml',
  },
  {
    slug: 'hard-fork',
    tier: 'L4',
    name: 'Hard Fork (NYT Tech)',
    desc: 'awesome-english 首页精选，纽约时报科技与 AI 前沿高语速访谈精听挑战',
    rssUrl: 'https://feeds.simplecast.com/l2i9YnTd',
  },
];

function classifyMaterial(name: string) {
  const book = name.match(/(?:剑桥(?:雅思)?|剑雅|Cambridge(?:\s+IELTS)?)\s*(\d+)|IELTS\s*(\d+)/i);
  const kind = /机经/.test(name) ? 'recalled' : book ? 'cambridge' : 'other';
  const month = name.match(/20\d{2}[-.]\d{1,2}/)?.[0].replace('.', '-') || '';
  const explicitTierMatch = name.match(/^\[(L[1-4])\]\s*(.+)$/i);
  const explicitTier = explicitTierMatch?.[1]?.toUpperCase() as Exclude<TierId, 'all'> | undefined;
  const bracketRest = explicitTierMatch?.[2]?.trim() || '';
  const bracketCategory =
    !book && kind !== 'recalled' && bracketRest.includes('·')
      ? bracketRest.split('·')[0].trim()
      : '';
  const group =
    kind === 'cambridge'
      ? `剑雅 ${book?.[1] || book?.[2]}`
      : kind === 'recalled'
        ? month
        : bracketCategory;
  const test = name.match(/Test\s*(\d+)/i)?.[1];
  const recalledSet = name.match(/·\s*(\d+)\s*·/)?.[1];
  const part = name.match(/Part\s*(\d+)/i)?.[1] || '';

  let tier: Exclude<TierId, 'all'> = explicitTier || 'L2';
  if (!explicitTier) {
    if (
      /everyday\s*grammar|6\s*minute\s*grammar|learning\s*english\s*vocab|beginner|elementary|esl|零基础|初级|初中|入门|新概念\s*[1一]/i.test(
        name,
      )
    ) {
      tier = 'L1';
    } else if (
      /6\s*min(?:ute)?\s*english|english\s*we\s*speak|as\s*it\s*is|voa|culips|高中|高考|四级|cet-?4|新概念\s*[2二]|intermediate/i.test(
        name,
      )
    ) {
      tier = 'L2';
    } else if (
      part === '1' ||
      part === '2' ||
      /all\s*ears|luke|npr|cnn\s*10|六级|cet-?6|考研|托福|toefl|新概念\s*[3三]/i.test(name)
    ) {
      tier = 'L3';
    } else if (
      part === '3' ||
      part === '4' ||
      kind === 'recalled' ||
      /american\s*life|hard\s*fork|curious|lecture|ted|专八|tem-?8|高阶|新概念\s*[4四]/i.test(name)
    ) {
      tier = 'L4';
    }
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
  onOpenImport,
  refreshKey = 0,
}: {
  onOpen: (id: string) => Promise<void>;
  onOpenLocalPath?: (path: string, title?: string) => Promise<void>;
  onImportDownloadedPodcast?: (
    path: string,
    title?: string,
    tier?: Exclude<TierId, 'all'>,
  ) => Promise<void>;
  onOpenImport?: () => void;
  refreshKey?: number;
}) {
  const [items, setItems] = useState<Material[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState('');
  const [downloadingSlug, setDownloadingSlug] = useState('');
  const [subTab, setSubTab] = useState<'local' | 'uploads'>('local');

  const [tier, setTier] = useState<TierId>('all');
  const [kind, setKind] = useState('');
  const [group, setGroup] = useState('');
  const [search, setSearch] = useState('');
  const [uploadSearch, setUploadSearch] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState('');
  const [deletingId, setDeletingId] = useState('');

  const refresh = () => {
    setError('');
    setLoading(true);
    invoke<Material[]>('library_list')
      .then(setItems)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(refresh, [refreshKey]);
  useEffect(() => {
    const onUpdated = () => refresh();
    window.addEventListener('lirio-library-updated', onUpdated);
    return () => window.removeEventListener('lirio-library-updated', onUpdated);
  }, []);

  const gradedItems = useMemo(() => items.filter((m) => !isUserUpload(m)), [items]);

  const userItems = useMemo(
    () =>
      items
        .filter(isUserUpload)
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')),
    [items],
  );

  const tagged = useMemo(
    () => gradedItems.map((item) => ({ item, ...classifyMaterial(item.name) })),
    [gradedItems],
  );

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
        isUpload: isUserUpload(match),
        title: simplifyMaterialTitle(match.name).shortTitle,
        index: parsed.index ?? 0,
        total: parsed.total || match.sentenceCount,
      };
    } catch {
      return null;
    }
  }, [items]);

  const shownUploads = useMemo(() => {
    const q = uploadSearch.trim().toLowerCase();
    return q ? userItems.filter((m) => m.name.toLowerCase().includes(q)) : userItems;
  }, [userItems, uploadSearch]);

  const handleDeleteUpload = async (m: Material) => {
    if (confirmDeleteId !== m.id) {
      setConfirmDeleteId(m.id);
      return;
    }
    setError('');
    setDeletingId(m.id);
    try {
      await invoke('library_delete', { id: m.id });
      setConfirmDeleteId('');
      setItems((prev) => prev.filter((x) => x.id !== m.id));
      window.dispatchEvent(new CustomEvent('lirio-library-updated'));
    } catch (e) {
      setError(`删除失败：${String(e)}`);
    } finally {
      setDeletingId('');
    }
  };

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
    () =>
      kind === 'podcast'
        ? []
        : tagged.filter((m) => (tier === 'all' || m.tier === tier) && (!kind || m.kind === kind)),
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

  const shownPodcasts = useMemo(() => {
    if ((kind && kind !== 'podcast') || group) return [];
    const q = search.trim().toLowerCase();
    return AWESOME_PODCASTS.filter(
      (p) =>
        (tier === 'all' || p.tier === tier) &&
        (!q || p.name.toLowerCase().includes(q) || p.desc.toLowerCase().includes(q)),
    );
  }, [tier, kind, group, search]);

  const kindOptions: SelectOption[] = useMemo(
    () => [
      { value: '', label: '全部来源' },
      { value: 'cambridge', label: '剑桥雅思' },
      { value: 'recalled', label: '机经真题' },
      { value: 'podcast', label: '在线播客' },
      { value: 'other', label: '阶梯精选' },
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

  const showResume =
    resumeInfo &&
    ((subTab === 'local' && !resumeInfo.isUpload) ||
      (subTab === 'uploads' && resumeInfo.isUpload));

  return (
    <section className="material-library" aria-label="听力材料仓库">
      <header className="library-head">
        <div>
          <h1>{subTab === 'uploads' ? '我的上传' : '阶梯精听库'}</h1>
          <p>
            {subTab === 'uploads'
              ? '你自主上传并完成切句 / AI 精校的个人听写材料，独立保存不与阶梯库混杂。'
              : '按听写能力分为四级循序精听（初学者 → 高中生 → 大学生 → 高阶进阶），音频自动保存在你的数据目录中。'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {onOpenImport && (
            <button
              type="button"
              className="icon-btn primary library-import-btn"
              disabled={loading || !!opening}
              title="上传本地音频，自动制作个人精听材料"
              aria-label="导入我的音频"
              onClick={onOpenImport}
            >
              <IconUpload size={16} />
            </button>
          )}
          <div className="corpus-tabs" role="tablist" aria-label="材料仓库切换">
            <button
              type="button"
              className={subTab === 'local' ? 'active' : ''}
              title={`阶梯精听库（${gradedItems.length} 份）`}
              aria-label={`阶梯精听库 (${gradedItems.length})`}
              onClick={() => {
                setConfirmDeleteId('');
                setSubTab('local');
              }}
            >
              <IconLibrary size={14} />
              <span>{gradedItems.length}</span>
            </button>
            <button
              type="button"
              className={subTab === 'uploads' ? 'active' : ''}
              title={`我的上传仓库（${userItems.length} 份）`}
              aria-label={`我的上传 (${userItems.length})`}
              onClick={() => {
                setConfirmDeleteId('');
                setSubTab('uploads');
              }}
            >
              <IconFolderAudio size={14} />
              <span>{userItems.length}</span>
            </button>
          </div>
          <button
            type="button"
            className="icon-btn"
            title="刷新材料库"
            aria-label="刷新材料库"
            disabled={loading || !!opening}
            onClick={refresh}
          >
            <IconReplay size={15} />
          </button>
        </div>
      </header>

      {/* Resume Last Listening Session */}
      {showResume && resumeInfo && (
        <button
          type="button"
          className="library-resume-bar"
          disabled={!!opening}
          title={`继续听写：${resumeInfo.title}`}
          aria-label={`继续听写：${resumeInfo.title}`}
          onClick={() => {
            setError('');
            setOpening(resumeInfo.item.id);
            onOpen(resumeInfo.item.id)
              .catch((e) => setError(String(e)))
              .finally(() => setOpening(''));
          }}
        >
          <div className="library-resume-info">
            <span className="tier-badge small">继续上次</span>
            <strong>{resumeInfo.title}</strong>
            <small>
              第 {resumeInfo.index + 1} / {resumeInfo.total} 句
            </small>
          </div>
          <span className="library-resume-play" aria-hidden="true">
            {opening === resumeInfo.item.id ? '…' : <IconPlay size={16} />}
          </span>
        </button>
      )}

      {/* 4-Tier Ladder Cards (Graded Library only, hidden in My Uploads) */}
      {subTab === 'local' && (
        <div className="tier-grid">
          {TIERS.map((t) => {
            const stat = tierStats[t.id];
            const podCount = AWESOME_PODCASTS.filter((p) => p.tier === t.id).length;
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
                  {`${stat.total} 份材料 · ${podCount} 档播客${stat.started > 0 ? ` · 已练 ${stat.started}` : ''}`}
                </div>
              </button>
            );
          })}
        </div>
      )}

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
                type="button"
                className="icon-btn"
                title="清除筛选"
                aria-label="清除筛选"
                onClick={() => {
                  setTier('all');
                  setKind('');
                  setGroup('');
                  setSearch('');
                }}
              >
                <IconClose size={14} />
              </button>
            )}
          </div>

          {loading ? (
            <p className="corpus-empty">正在读取材料…</p>
          ) : !shown.length && !shownPodcasts.length ? (
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
                    <span className="material-action" aria-label={m.completed ? '继续' : '开始'}>
                      {opening === m.id ? '…' : <IconPlay size={14} />}
                    </span>
                  </button>
                );
              })}

              {shown.length > 0 && shownPodcasts.length > 0 && (
                <div className="library-section-label">在线播客 · 点击拉取最新一集</div>
              )}

              {shownPodcasts.map((pod) => {
                const busy = downloadingSlug === pod.slug;
                return (
                  <div key={pod.slug} className="material-row podcast-row">
                    <span className="tier-badge small">{pod.tier}</span>
                    <span className="material-badge">播客</span>
                    <span className="material-name">
                      <strong>{pod.name}</strong>
                      <small>{pod.desc}</small>
                    </span>
                    <button
                      type="button"
                      className="icon-btn primary"
                      disabled={!!downloadingSlug}
                      title="拉取最新一集 MP3 到阶梯库并直接打开精听"
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
        </>
      )}

      {/* SUBTAB 2: User Uploads Repository */}
      {subTab === 'uploads' && (
        <>
          {userItems.length > 0 && (
            <div className="library-filter">
              <input
                aria-label="搜索我上传的材料"
                placeholder="搜索我上传的材料…"
                value={uploadSearch}
                onChange={(e) => setUploadSearch(e.target.value)}
              />
              {uploadSearch && (
                <button
                  type="button"
                  className="icon-btn"
                  title="清除搜索"
                  aria-label="清除搜索"
                  onClick={() => setUploadSearch('')}
                >
                  <IconClose size={14} />
                </button>
              )}
            </div>
          )}

          {loading ? (
            <p className="corpus-empty">正在读取个人上传…</p>
          ) : !userItems.length ? (
            <div className="upload-empty-card">
              <div className="upload-empty-icon">
                <IconFolderAudio size={28} />
              </div>
              <strong>还没有自主上传的音频</strong>
              <p>选择你的本地音频（MP3 / M4A / WAV / MP4），自动完成切句转写与 AI 字幕精校后，全部保存在这里。</p>
              {onOpenImport && (
                <button
                  type="button"
                  className="icon-action-btn primary"
                  title="上传本地音频"
                  aria-label="上传本地音频"
                  onClick={onOpenImport}
                >
                  <IconUpload size={20} />
                </button>
              )}
            </div>
          ) : !shownUploads.length ? (
            <p className="corpus-empty">没有匹配「{uploadSearch}」的上传材料。</p>
          ) : (
            <div className="library-list">
              {shownUploads.map((m) => {
                const { shortTitle } = simplifyMaterialTitle(m.name);
                const confirming = confirmDeleteId === m.id;
                const deleting = deletingId === m.id;
                return (
                  <div key={m.id} className="material-row-wrap">
                    <button
                      type="button"
                      className="material-row"
                      title={m.name}
                      disabled={!!opening || deleting}
                      onClick={() => {
                        setError('');
                        setOpening(m.id);
                        onOpen(m.id)
                          .catch((e) => setError(String(e)))
                          .finally(() => setOpening(''));
                      }}
                    >
                      <span className="tier-badge small pro" aria-hidden="true">
                        <IconFolderAudio size={12} />
                      </span>
                      <span className="material-name">
                        <strong>{shortTitle}</strong>
                        <small>
                          {m.sentenceCount} 句 · 已练 {m.completed} 句
                        </small>
                      </span>
                      <span className="material-duration">
                        {Math.floor(m.duration / 60)}:{String(Math.floor(m.duration % 60)).padStart(2, '0')}
                      </span>
                      <span className="material-action" aria-label={m.completed ? '继续' : '开始'}>
                        {opening === m.id ? '…' : <IconPlay size={14} />}
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`icon-btn upload-del-btn${confirming ? ' confirming' : ''}`}
                      disabled={deleting || !!opening}
                      title={confirming ? '再次点击确认删除' : '删除这份上传材料'}
                      aria-label={confirming ? '确认删除' : '删除'}
                      onClick={() => void handleDeleteUpload(m)}
                    >
                      {confirming ? <IconCheck size={14} /> : <IconTrash size={14} />}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}
