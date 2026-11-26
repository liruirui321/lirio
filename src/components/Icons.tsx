import { useId, type SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const base = (size = 16): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
});

export const IconSun = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.5v2.2M12 19.3v2.2M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6" />
  </svg>
);

export const IconMoon = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M20.2 14.8A8.3 8.3 0 0 1 9.2 3.8a8.5 8.5 0 1 0 11 11Z" />
  </svg>
);

export const IconPlay = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M7.5 5.2 18.8 12 7.5 18.8Z" />
  </svg>
);

export const IconPause = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M8.5 5.5v13M15.5 5.5v13" />
  </svg>
);

export const IconReplay = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9" />
    <path d="M4.5 4.5V9H9" />
  </svg>
);

export const IconVolume = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M5 9.5h3.5L13 5.8v12.4L8.5 14.5H5a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z" />
    <path d="M16.5 9.2a4.2 4.2 0 0 1 0 5.6M19 6.8a7.4 7.4 0 0 1 0 10.4" />
  </svg>
);

export const IconPrev = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M15 6 9 12l6 6" />
  </svg>
);

export const IconNext = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M9 6l6 6-6 6" />
  </svg>
);

export const IconCheck = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M5 12.5 9.8 17.2 19 7.2" />
  </svg>
);

export const IconEye = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
    <circle cx="12" cy="12" r="2.6" />
  </svg>
);

export const IconShuffle = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M16.5 4.5h3.5V8M4 18l5.5-5.5M20 4.5l-6.2 6.2M16.5 19.5H20V16M4 6l16 13.5" />
  </svg>
);

export const IconRepeat = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M17 3.8 20 6.8 17 9.8" />
    <path d="M4 11V9a2.2 2.2 0 0 1 2.2-2.2H20" />
    <path d="M7 20.2 4 17.2 7 14.2" />
    <path d="M20 13v2a2.2 2.2 0 0 1-2.2 2.2H4" />
  </svg>
);

export const IconCardView = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <rect x="4" y="5.5" width="16" height="13" rx="2.5" />
    <path d="M8.5 12h7" />
  </svg>
);

export const IconListView = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M8 7h12M8 12h12M8 17h12M4.5 7h.01M4.5 12h.01M4.5 17h.01" />
  </svg>
);

export const IconBulb = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M9.5 18h5M10 21h4M12 3.5a5.5 5.5 0 0 0-3.3 9.9c.7.6 1.1 1.4 1.2 2.3h4.2c.1-.9.5-1.7 1.2-2.3A5.5 5.5 0 0 0 12 3.5Z" />
  </svg>
);

export const IconFolderAudio = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M9 17.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM19 15.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z" />
    <path d="M9 17.5V6.5l10-2v11" />
  </svg>
);

export const IconFolderOpen = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M3.5 7a2 2 0 0 1 2-2h4.2l2 2.2h6.8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7Z" />
  </svg>
);

export const IconSave = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M5 4.5h11.2L19.5 7.8V19a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V6A1.5 1.5 0 0 1 6 4.5Z" />
    <path d="M8 4.5v4.5h7V4.5M8.5 20.5v-6h7v6" />
  </svg>
);

export const IconBookmark = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M6.5 4.5h11a1 1 0 0 1 1 1v14.5L12 16l-6.5 4V5.5a1 1 0 0 1 1-1Z" />
  </svg>
);

export const IconExport = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M12 4.5v10.5M8 11l4 4 4-4M4.5 16.5v2a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2" />
  </svg>
);

export const IconTrash = ({ size = 15, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M5 7h14M9.5 7V5.2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7M7.5 7l.8 11.5a1.5 1.5 0 0 0 1.5 1.4h4.4a1.5 1.5 0 0 0 1.5-1.4L16.5 7" />
  </svg>
);

export const IconLibrary = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M5 5.5v13M9.5 5.5v13M14 6l4.8 12.2" />
  </svg>
);

export const IconCorpus = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <rect x="4" y="4.5" width="16" height="15" rx="2.5" />
    <path d="M8 9.5h8M8 14h5" />
  </svg>
);

export const IconChart = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M4.5 18.5h15M7.5 15v-4.5M12 15V7.5M16.5 15v-7" />
  </svg>
);

export const IconPlus = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M12 5.5v13M5.5 12h13" />
  </svg>
);

export const IconWave = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M4 12v0M8 8.5v7M12 5.5v13M16 8.5v7M20 12v0" />
  </svg>
);

export const IconBack = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M15 18l-6-6 6-6" />
  </svg>
);

export const IconHeadphones = ({ size = 22, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M4.5 14v-2a7.5 7.5 0 0 1 15 0v2" />
    <rect x="3.5" y="13.5" width="3.5" height="6" rx="1.5" />
    <rect x="17" y="13.5" width="3.5" height="6" rx="1.5" />
  </svg>
);

export const IconChat = ({ size = 22, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M5 18.5 3.8 21l3.6-1.2A8.5 8.5 0 1 0 5 18.5Z" />
    <path d="M8.5 11.2h7M8.5 14.5h4.5" />
  </svg>
);

export const IconMic = ({ size = 20, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <rect x="9" y="3.5" width="6" height="10.5" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.8 21h6.4" />
  </svg>
);

export const IconStop = ({ size = 18, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
  </svg>
);

export const IconSend = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M20 4 10 14M20 4l-6 16-3.6-6.4L4 10 20 4Z" />
  </svg>
);

export const IconSettings = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const IconUser = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <circle cx="12" cy="8.5" r="3.6" />
    <path d="M5 19.5a7 7 0 0 1 14 0" />
  </svg>
);

export const IconSparkle = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M12 3.5 14 9.5 20 11.5 14 13.5 12 19.5 10 13.5 4 11.5 10 9.5 12 3.5Z" />
  </svg>
);

export const IconUpload = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M12 15.5V5M8 9l4-4 4 4M4.5 16.5v2a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2" />
  </svg>
);

export const IconClipboard = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <rect x="5" y="4.5" width="14" height="16" rx="2.5" />
    <path d="M9 4.5h6v2a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-2Z" />
    <path d="M8.5 11.5h7M8.5 15h4.5" />
  </svg>
);

export const IconClose = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const IconKeyboard = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <rect x="3" y="6.5" width="18" height="11" rx="2.2" />
    <path d="M7 10.5h.01M10.5 10.5h.01M14 10.5h.01M17 10.5h.01M8 14h8" />
  </svg>
);

export const IconTranslate = ({ size = 15, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M4.5 6.5h7.5M8.25 4.5v2c0 3.2-1.8 5.6-3.75 7M6.3 9.2c.8 1.5 2 2.8 3.6 3.7" />
    <path d="M12.5 19l3.2-8.5L19 19M13.5 16.5h4.4" />
  </svg>
);

export const IconLirioMark = ({ size = 24, ...p }: IconProps) => {
  const uid = useId().replace(/:/g, '');
  const bgId = `lirio-bg-${uid}`;
  const glowId = `lirio-glow-${uid}`;
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" fill="none" aria-hidden="true" {...p}>
      <defs>
        <linearGradient id={bgId} x1="14%" y1="8%" x2="86%" y2="94%">
          <stop offset="0%" stopColor="#698F73" />
          <stop offset="54%" stopColor="#4A6B53" />
          <stop offset="100%" stopColor="#35503D" />
        </linearGradient>
        <radialGradient id={glowId} cx="28%" cy="20%" r="65%">
          <stop offset="0%" stopColor="#B9D5BF" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#4A6B53" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="48" y="48" width="928" height="928" rx="220" fill={`url(#${bgId})`} />
      <rect x="48" y="48" width="928" height="928" rx="220" fill={`url(#${glowId})`} />
      <rect x="52" y="52" width="920" height="920" rx="216" stroke="#FFFFFF" strokeOpacity="0.16" strokeWidth="6" />
      <g transform="translate(512 512) scale(1.42) translate(-512 -480)">
        <path d="M 512 384 L 512 346" stroke="#A7CCB0" strokeWidth="18" strokeLinecap="round" />
        <path d="M 510 350 C 452 338 398 290 398 226 C 460 226 506 274 510 350 Z" fill="#A7CCB0" />
        <path d="M 494 334 Q 452 292 422 250" stroke="#4A6B53" strokeWidth="10" strokeLinecap="round" />
        <path d="M 514 350 C 572 338 626 290 626 226 C 564 226 518 274 514 350 Z" fill="#CBE2D0" />
        <path d="M 530 334 Q 572 292 602 250" stroke="#4A6B53" strokeWidth="10" strokeLinecap="round" />
        <circle cx="352" cy="404" r="64" fill="#FAF7F0" />
        <ellipse cx="356" cy="408" rx="33" ry="37" transform="rotate(-18 356 408)" fill="#8CB095" />
        <circle cx="672" cy="404" r="64" fill="#FAF7F0" />
        <ellipse cx="668" cy="408" rx="33" ry="37" transform="rotate(18 668 408)" fill="#8CB095" />
        <path
          d="M 512 374 C 612 374 674 414 692 474 C 724 508 752 548 752 596 C 752 678 656 734 512 734 C 368 734 272 678 272 596 C 272 548 300 508 332 474 C 350 414 412 374 512 374 Z"
          fill="#FAF7F0"
        />
        <ellipse cx="362" cy="604" rx="42" ry="24" fill="#EAC4B2" opacity="0.72" />
        <ellipse cx="662" cy="604" rx="42" ry="24" fill="#EAC4B2" opacity="0.72" />
        <ellipse cx="428" cy="526" rx="22" ry="28" fill="#2A4030" />
        <ellipse cx="596" cy="526" rx="22" ry="28" fill="#2A4030" />
        <path
          d="M 488 570 C 488 558 536 558 536 570 C 536 584 522 596 512 596 C 502 596 488 584 488 570 Z"
          fill="#D98262"
        />
        <path
          d="M 470 614 Q 491 634 512 608 Q 533 634 554 614"
          stroke="#2A4030"
          strokeWidth="15"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
};

export const IconPhone = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M5.5 4.5h3.2l1.6 4.1-2.1 1.7a12.5 12.5 0 0 0 5.5 5.5l1.7-2.1 4.1 1.6v3.2a1.8 1.8 0 0 1-1.9 1.8C10 19.9 4.1 14 3.7 6.4A1.8 1.8 0 0 1 5.5 4.5Z" />
  </svg>
);

export const IconIncognito = ({ size = 16, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M3.5 11.5h17" />
    <path d="M6.5 11.5 8 6.5a1.5 1.5 0 0 1 1.4-1h5.2a1.5 1.5 0 0 1 1.4 1l1.5 5" />
    <circle cx="8.5" cy="16.2" r="2.3" />
    <circle cx="15.5" cy="16.2" r="2.3" />
    <path d="M10.8 16.2h2.4" />
  </svg>
);
