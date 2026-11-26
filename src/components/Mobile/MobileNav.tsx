import {
  IconBack,
  IconBookmark,
  IconChart,
  IconChat,
  IconCorpus,
  IconFolderAudio,
  IconHeadphones,
  IconLibrary,
  IconLirioMark,
  IconMoon,
  IconSettings,
  IconSun,
  IconUser,
  IconWave,
} from '../Icons';

export type MobileHubSection = 'home' | 'listening' | 'words' | 'speak';
export type MobileListeningMode = 'library' | 'audio' | 'dictation' | 'favorites' | 'analysis';

interface MobileTopBarProps {
  hub: MobileHubSection;
  listeningMode: MobileListeningMode;
  projectName?: string;
  favoritesCount: number;
  hasProject: boolean;
  busy: boolean;
  userName?: string | null;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onOpenSettings: (tab: 'ai' | 'data' | 'feedback') => void;
  onBackListeningLibrary: () => void;
  onSelectListeningMode: (mode: MobileListeningMode) => void;
  onOpenImport: () => void;
}

export function MobileTopBar({
  hub,
  listeningMode,
  projectName,
  favoritesCount,
  hasProject,
  busy,
  userName,
  theme,
  onToggleTheme,
  onOpenSettings,
  onBackListeningLibrary,
  onSelectListeningMode,
  onOpenImport,
}: MobileTopBarProps) {
  const showListeningBack = hub === 'listening' && listeningMode !== 'library';

  const titleText =
    hub === 'home'
      ? 'Lirio'
      : hub === 'words'
        ? '单词精听'
        : hub === 'speak'
          ? '口语对话'
          : listeningMode === 'library'
            ? '听力材料库'
            : listeningMode === 'analysis'
              ? '听力复盘'
              : listeningMode === 'favorites'
                ? `收藏词卡 (${favoritesCount})`
                : projectName || (listeningMode === 'audio' ? '音频跟读' : '单句精听');

  return (
    <header className="mobile-topbar">
      <div className="mobile-topbar-left">
        {hub === 'home' ? (
          <span className="mobile-brand">
            <IconLirioMark size={22} />
            <span>Lirio</span>
          </span>
        ) : showListeningBack ? (
          <button
            type="button"
            className="mobile-back-btn"
            disabled={busy}
            aria-label="返回材料库"
            onClick={onBackListeningLibrary}
          >
            <IconBack size={18} />
            <span className="mobile-topbar-title">{titleText}</span>
          </button>
        ) : (
          <span className="mobile-topbar-title">{titleText}</span>
        )}
      </div>

      <div className="mobile-topbar-right">
        {hub === 'listening' && (
          <>
            {hasProject && listeningMode !== 'library' && (
              <button
                type="button"
                className={`icon-btn${listeningMode === 'dictation' || listeningMode === 'audio' ? ' active' : ''}`}
                disabled={busy}
                aria-label="听写与音频切换"
                onClick={() => onSelectListeningMode(listeningMode === 'dictation' ? 'audio' : 'dictation')}
              >
                <IconWave size={17} />
              </button>
            )}
            {hasProject && (
              <button
                type="button"
                className={`icon-btn${listeningMode === 'favorites' ? ' active' : ''}`}
                disabled={busy}
                aria-label="收藏词卡"
                onClick={() => onSelectListeningMode(listeningMode === 'favorites' ? 'library' : 'favorites')}
              >
                <IconBookmark size={17} />
              </button>
            )}
            <button
              type="button"
              className={`icon-btn${listeningMode === 'analysis' ? ' active' : ''}`}
              disabled={busy}
              aria-label="听力复盘"
              onClick={() => onSelectListeningMode(listeningMode === 'analysis' ? 'library' : 'analysis')}
            >
              <IconChart size={17} />
            </button>
            <button
              type="button"
              className="icon-btn"
              disabled={busy}
              aria-label="导入音频"
              onClick={onOpenImport}
            >
              <IconFolderAudio size={17} />
            </button>
          </>
        )}

        {hub === 'home' && (
          <button
            type="button"
            className="icon-btn"
            aria-label="切换日夜主题"
            onClick={onToggleTheme}
          >
            {theme === 'light' ? <IconMoon size={17} /> : <IconSun size={17} />}
          </button>
        )}

        {userName && hub === 'home' ? (
          <button
            type="button"
            className="account-topbar-pill mobile-acct-pill"
            aria-label="账号与设置"
            onClick={() => onOpenSettings('ai')}
          >
            <IconUser size={14} />
            <span>{userName}</span>
          </button>
        ) : (
          <button
            type="button"
            className="icon-btn"
            aria-label="设置"
            onClick={() => onOpenSettings(hub === 'home' ? 'ai' : 'data')}
          >
            {hub === 'home' ? <IconUser size={17} /> : <IconSettings size={17} />}
          </button>
        )}
      </div>
    </header>
  );
}

interface MobileBottomNavProps {
  hub: MobileHubSection;
  disabled: boolean;
  hidden?: boolean;
  onSelectHub: (next: MobileHubSection) => void;
}

const NAV_ITEMS: Array<{ id: MobileHubSection; label: string }> = [
  { id: 'home', label: '首页' },
  { id: 'listening', label: '听力' },
  { id: 'words', label: '单词' },
  { id: 'speak', label: '对话' },
];

export function MobileBottomNav({ hub, disabled, hidden, onSelectHub }: MobileBottomNavProps) {
  if (hidden) return null;

  return (
    <nav className="mobile-bottom-nav" aria-label="主导航">
      {NAV_ITEMS.map((item) => {
        const active = hub === item.id;
        return (
          <button
            key={item.id}
            type="button"
            disabled={disabled}
            className={`mobile-nav-tab${active ? ' active' : ''}`}
            aria-current={active ? 'page' : undefined}
            onClick={() => onSelectHub(item.id)}
          >
            <span className="mobile-nav-icon">
              {item.id === 'home' ? (
                <IconLibrary size={19} />
              ) : item.id === 'listening' ? (
                <IconHeadphones size={19} />
              ) : item.id === 'words' ? (
                <IconCorpus size={19} />
              ) : (
                <IconChat size={19} />
              )}
            </span>
            <span className="mobile-nav-label">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
