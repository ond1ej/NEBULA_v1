// Icons used by Dashboard pages and Mini App screens beyond the first screen. Import from './icons'.
import { Base, type P } from './iconBase';
import { IconResources } from './iconsNav';

export const IconPlus = (p: P) => (
  <Base {...p}>
    <path d="M12 5v14M5 12h14" />
  </Base>
);
export const IconSearch = (p: P) => (
  <Base {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </Base>
);
export const IconCheck = (p: P) => (
  <Base {...p}>
    <path d="m5 12.5 4.2 4.2L19 7" />
  </Base>
);
export const IconChevronDown = (p: P) => (
  <Base {...p}>
    <path d="m6 9 6 6 6-6" />
  </Base>
);
export const IconArrowLeft = (p: P) => (
  <Base {...p}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Base>
);
export const IconArrowRight = (p: P) => (
  <Base {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Base>
);
export const IconTrash = (p: P) => (
  <Base {...p}>
    <path d="M4.5 7h15M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M6.5 7l.8 12a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5l.8-12" />
    <path d="M10 11v5.5M14 11v5.5" />
  </Base>
);
export const IconEdit = (p: P) => (
  <Base {...p}>
    <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z" />
    <path d="m13.5 6.5 4 4" />
  </Base>
);
export const IconPin = (p: P) => (
  <Base {...p}>
    <path d="M9 4h6l-1 5 3.5 3.5v1.5h-11v-1.5L10 9 9 4Z" />
    <path d="M12 14v6" />
  </Base>
);
export const IconShare = (p: P) => (
  <Base {...p}>
    <circle cx="6" cy="12" r="2.4" />
    <circle cx="17.5" cy="6" r="2.4" />
    <circle cx="17.5" cy="18" r="2.4" />
    <path d="m8.2 10.9 7.1-3.7M8.2 13.1l7.1 3.7" />
  </Base>
);
export const IconPlay = (p: P) => (
  <Base {...p}>
    <path d="M7.5 5.5v13l11-6.5-11-6.5Z" />
  </Base>
);
export const IconPause = (p: P) => (
  <Base {...p}>
    <rect x="6.5" y="5" width="3.8" height="14" rx="1" />
    <rect x="13.7" y="5" width="3.8" height="14" rx="1" />
  </Base>
);
export const IconStop = (p: P) => (
  <Base {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Base>
);
export const IconExternal = (p: P) => (
  <Base {...p}>
    <path d="M14 4h6v6M20 4l-9 9" />
    <path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
  </Base>
);
export const IconCopy = (p: P) => (
  <Base {...p}>
    <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2" />
    <path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5" />
  </Base>
);
export const IconUpload = (p: P) => (
  <Base {...p}>
    <path d="M12 15.5V4M7 8.5l5-5 5 5" />
    <path d="M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" />
  </Base>
);
export const IconDownload = (p: P) => (
  <Base {...p}>
    <path d="M12 4v11.5M7 10.5l5 5 5-5" />
    <path d="M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" />
  </Base>
);
export const IconLock = (p: P) => (
  <Base {...p}>
    <rect x="5" y="10.5" width="14" height="10" rx="2.2" />
    <path d="M8.5 10.5V7.8a3.5 3.5 0 0 1 7 0v2.7" />
  </Base>
);
export const IconClock = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Base>
);
export const IconChat = (p: P) => (
  <Base {...p}>
    <path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-7.5L7 21v-3.5H5A1.5 1.5 0 0 1 3.5 16V7A1.5 1.5 0 0 1 5 5.5Z" />
  </Base>
);
export const IconCpu = (p: P) => (
  <Base {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <rect x="9.5" y="9.5" width="5" height="5" rx="0.8" />
    <path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3" />
  </Base>
);
export const IconChip = (p: P) => (
  <Base {...p}>
    <rect x="3.5" y="7" width="17" height="10" rx="1.6" />
    <path d="M7 7v10M11 7v10M15 7v10M3.5 20h17M6 4h12" />
  </Base>
);
export const IconDisk = (p: P) => (
  <Base {...p}>
    <ellipse cx="12" cy="6.5" rx="7.5" ry="2.8" />
    <path d="M4.5 6.5v11c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-11M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" />
  </Base>
);
export const IconQueue = (p: P) => (
  <Base {...p}>
    <rect x="4" y="4" width="16" height="4.5" rx="1.3" />
    <rect x="4" y="10.5" width="16" height="4.5" rx="1.3" />
    <path d="M4 18.5h10" />
  </Base>
);
export const IconLink = (p: P) => (
  <Base {...p}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </Base>
);
export const IconFilter = (p: P) => (
  <Base {...p}>
    <path d="M4 5.5h16l-6.2 7.2v5.5L10.2 20v-7.3L4 5.5Z" />
  </Base>
);
export const IconEye = (p: P) => (
  <Base {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="2.8" />
  </Base>
);
export const IconMic = (p: P) => (
  <Base {...p}>
    <rect x="9" y="3.5" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
  </Base>
);
export const IconBolt = (p: P) => (
  <Base {...p}>
    <path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z" />
  </Base>
);
export const IconSparkle = (p: P) => (
  <Base {...p}>
    <path d="M12 3.5 13.6 9a2 2 0 0 0 1.4 1.4l5.5 1.6-5.5 1.6a2 2 0 0 0-1.4 1.4L12 20.5l-1.6-5.5A2 2 0 0 0 9 13.6L3.5 12 9 10.4A2 2 0 0 0 10.4 9L12 3.5Z" />
  </Base>
);
export const IconGitHub = (p: P) => (
  <Base {...p}>
    <path d="M9 19c-4 1.3-4-2-6-2.5M15 21v-3.4a3 3 0 0 0-.8-2.3c2.8-.3 5.8-1.4 5.8-6.2a4.8 4.8 0 0 0-1.3-3.3 4.5 4.5 0 0 0-.1-3.3s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6.2 0C6.6 2.2 5.6 2.5 5.6 2.5a4.5 4.5 0 0 0-.1 3.3 4.8 4.8 0 0 0-1.3 3.3c0 4.8 3 5.9 5.8 6.2a3 3 0 0 0-.8 2.3V21" />
  </Base>
);
export const IconGraph = (p: P) => (
  <Base {...p}>
    <circle cx="5.5" cy="12" r="2.3" />
    <circle cx="18.5" cy="6" r="2.3" />
    <circle cx="18.5" cy="18" r="2.3" />
    <path d="M7.8 12h3.4M11.2 12 16.3 6.8M11.2 12l5.1 5.2" />
  </Base>
);
export const IconList = (p: P) => (
  <Base {...p}>
    <path d="M9 6.5h11M9 12h11M9 17.5h11" />
    <circle cx="4.8" cy="6.5" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="4.8" cy="12" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="4.8" cy="17.5" r="0.9" fill="currentColor" stroke="none" />
  </Base>
);
export const IconGrid = (p: P) => (
  <Base {...p}>
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <rect x="13" y="4" width="7" height="7" rx="1.5" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" />
    <rect x="13" y="13" width="7" height="7" rx="1.5" />
  </Base>
);
export const IconRepeat = (p: P) => (
  <Base {...p}>
    <path d="M17 3.5 20 6.5l-3 3" />
    <path d="M4 11.5V10a3.5 3.5 0 0 1 3.5-3.5H20M7 20.5l-3-3 3-3" />
    <path d="M20 12.5V14a3.5 3.5 0 0 1-3.5 3.5H4" />
  </Base>
);
export const IconFullscreen = (p: P) => (
  <Base {...p}>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </Base>
);
export const IconFit = (p: P) => (
  <Base {...p}>
    <rect x="3.5" y="5" width="17" height="14" rx="2" />
    <path d="M8 9.5 6 12l2 2.5M16 9.5l2 2.5-2 2.5" />
  </Base>
);
export const IconCamera = (p: P) => (
  <Base {...p}>
    <path d="M4 8.5a2 2 0 0 1 2-2h1.8l1.5-2h5.4l1.5 2H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9Z" />
    <circle cx="12" cy="13" r="3.4" />
  </Base>
);
export const IconHand = (p: P) => (
  <Base {...p}>
    <path d="M8 11.5V5.8a1.5 1.5 0 0 1 3 0v4.7M11 10V4.5a1.5 1.5 0 0 1 3 0V10M14 10V6a1.5 1.5 0 0 1 3 0v7.5a7 7 0 0 1-7 7h-.6a6.4 6.4 0 0 1-5.1-2.6L2.8 15.4a1.5 1.5 0 0 1 2.3-1.9L8 15.8v-4.3" />
  </Base>
);
export const IconPower = (p: P) => (
  <Base {...p}>
    <path d="M12 3.5v8" />
    <path d="M7 6.3a7.5 7.5 0 1 0 10 0" />
  </Base>
);
export const IconMoon = (p: P) => (
  <Base {...p}>
    <path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10Z" />
  </Base>
);
export const IconSun = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="3.8" />
    <path d="M12 3v1.8M12 19.2V21M3 12h1.8M19.2 12H21M5.6 5.6l1.3 1.3M17.1 17.1l1.3 1.3M5.6 18.4l1.3-1.3M17.1 6.9l1.3-1.3" />
  </Base>
);
export const IconHash = (p: P) => (
  <Base {...p}>
    <path d="M5 9h15M4 15h15M10 4 8 20M16 4l-2 16" />
  </Base>
);
export const IconTag = (p: P) => (
  <Base {...p}>
    <path d="M3.5 11.5V5a1.5 1.5 0 0 1 1.5-1.5h6.5l9 9-8 8-9-9Z" />
    <circle cx="8" cy="8" r="1.4" />
  </Base>
);
export const IconStar = (p: P) => (
  <Base {...p}>
    <path d="m12 4 2.4 5 5.4.7-4 3.7 1 5.4L12 16.2l-4.8 2.6 1-5.4-4-3.7 5.4-.7L12 4Z" />
  </Base>
);
export const IconActivity = IconResources;
export const IconKey = (p: P) => (
  <Base {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2" />
  </Base>
);
export const IconDot = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
  </Base>
);
export const IconEnvironment = (p: P) => (
  <Base {...p}>
    <rect x="3" y="4" width="8" height="7" rx="1.5" />
    <rect x="13" y="13" width="8" height="7" rx="1.5" />
    <path d="M7 11v3.5a2 2 0 0 0 2 2h4M17 13V9.5a2 2 0 0 0-2-2h-4" />
  </Base>
);
