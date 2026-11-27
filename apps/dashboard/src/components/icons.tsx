// Inline SVG icon set (24 px grid, 1.7 px stroke, round caps). No icon font, no external assets.
// Split by where icons are first needed so a screen downloads only its own: this module holds the icons of the
// Telegram Mini App and the shared UI kit, iconsNav the Dashboard shell's, iconsMore the pages'. Import from here.
import { Base, type P } from './iconBase';

export * from './iconsNav';
export * from './iconsMore';

export const IconOverview = (p: P) => (
  <Base {...p}>
    <rect x="3.5" y="3.5" width="7" height="8" rx="1.6" />
    <rect x="13.5" y="3.5" width="7" height="5" rx="1.6" />
    <rect x="13.5" y="11.5" width="7" height="9" rx="1.6" />
    <rect x="3.5" y="14.5" width="7" height="6" rx="1.6" />
  </Base>
);
export const IconAgents = (p: P) => (
  <Base {...p}>
    <rect x="4" y="7" width="16" height="12" rx="3.2" />
    <path d="M12 3.5V7M9 12.2h.01M15 12.2h.01M9.6 15.6h4.8" />
  </Base>
);
export const IconTelegram = (p: P) => (
  <Base {...p}>
    <path d="m21 4.2-18 7 6 2.2 2.2 6 3.2-4.1 4.9 3.7L21 4.2Z" />
    <path d="m9 13.4 7.2-5.1" />
  </Base>
);
export const IconSettings = (p: P) => (
  <Base {...p}>
    <path d="M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1" />
    <circle cx="15" cy="6.5" r="2" />
    <circle cx="9" cy="12" r="2" />
    <circle cx="17" cy="17.5" r="2" />
  </Base>
);
export const IconMenu = (p: P) => (
  <Base {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Base>
);
export const IconWorkflows = (p: P) => (
  <Base {...p}>
    <rect x="3" y="4" width="6.5" height="5" rx="1.4" />
    <rect x="14.5" y="4" width="6.5" height="5" rx="1.4" />
    <rect x="8.75" y="15" width="6.5" height="5" rx="1.4" />
    <path d="M6.25 9v1.8a1.5 1.5 0 0 0 1.5 1.5h8.5a1.5 1.5 0 0 0 1.5-1.5V9M12 12.3V15" />
  </Base>
);
export const IconFiles = (p: P) => (
  <Base {...p}>
    <path d="M3.5 7.2a2 2 0 0 1 2-2h3.6l2 2.2h7.4a2 2 0 0 1 2 2v8.4a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.2Z" />
  </Base>
);
export const IconX = (p: P) => (
  <Base {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Base>
);
export const IconChevronRight = (p: P) => (
  <Base {...p}>
    <path d="m9 6 6 6-6 6" />
  </Base>
);
export const IconChevronLeft = (p: P) => (
  <Base {...p}>
    <path d="m15 6-6 6 6 6" />
  </Base>
);
export const IconRefresh = (p: P) => (
  <Base {...p}>
    <path d="M20 12a8 8 0 0 1-13.7 5.7M4 12a8 8 0 0 1 13.7-5.7" />
    <path d="M18 3v3.5h-3.5M6 21v-3.5h3.5" />
  </Base>
);
export const IconBell = (p: P) => (
  <Base {...p}>
    <path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 1.5h-15L6 16.5Z" />
    <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
  </Base>
);
export const IconAlert = (p: P) => (
  <Base {...p}>
    <path d="M10.3 4.3 2.9 17.5A2 2 0 0 0 4.6 20.5h14.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9.5v4.2M12 16.9h.01" />
  </Base>
);
export const IconInfo = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.2M12 7.9h.01" />
  </Base>
);
export const IconCheckCircle = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m8.3 12.3 2.5 2.5 5-5" />
  </Base>
);
export const IconXCircle = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6" />
  </Base>
);
export const IconMonitor = (p: P) => (
  <Base {...p}>
    <rect x="3" y="4" width="18" height="12.5" rx="2.2" />
    <path d="M8.5 20.5h7M12 16.5v4" />
    <path d="m10.3 8.3 3.7 2-3.7 2z" />
  </Base>
);
export const IconWifi = (p: P) => (
  <Base {...p}>
    <path d="M3 9a13 13 0 0 1 18 0M6 12.5a8.5 8.5 0 0 1 12 0M9 16a4 4 0 0 1 6 0" />
    <circle cx="12" cy="19" r="0.9" fill="currentColor" stroke="none" />
  </Base>
);
// ---- V3
export const IconCompanies = (p: P) => (
  <Base {...p}>
    <path d="M4 20V7.5L10 4v16M10 20V9l10 3.5V20" />
    <path d="M3 20h18M6.5 9h1M6.5 12.5h1M6.5 16h1M13.5 14h1M16.5 14h1M13.5 17h1M16.5 17h1" />
  </Base>
);
export const IconApprovals = (p: P) => (
  <Base {...p}>
    <path d="M12 3.5 5 6.5v5c0 4.2 3 7.6 7 9 4-1.4 7-4.8 7-9v-5l-7-3Z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </Base>
);
