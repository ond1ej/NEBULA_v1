// Glyphs of the Mini App shell and chat (24 px grid, same stroke as the NEBULA set). Kept separate from the
// Dashboard icon modules so the initial Mini App bundle only carries what the shell draws.
import { Base, type P } from '../components/iconBase';

export const IcChats = (p: P) => (
  <Base {...p}>
    <path d="M20 12.5c0 3.9-3.6 7-8 7-1.1 0-2.2-.2-3.1-.6L4 20l1.2-3.6C4.4 15.3 4 14 4 12.5c0-3.9 3.6-7 8-7s8 3.1 8 7Z" />
  </Base>
);

export const IcAgents = (p: P) => (
  <Base {...p}>
    <rect x="5" y="7" width="14" height="11" rx="3.5" />
    <path d="M12 4v3M9.5 12h.01M14.5 12h.01M9.5 15h5" />
  </Base>
);

export const IcActivity = (p: P) => (
  <Base {...p}>
    <path d="M3 12h3.5l2.5-6 4 12 2.5-6H21" />
  </Base>
);

export const IcSettings = (p: P) => (
  <Base {...p}>
    <path d="M10.3 3.6a1.8 1.8 0 0 1 3.4 0l.3.9a1.8 1.8 0 0 0 2.5 1l.8-.4a1.8 1.8 0 0 1 2.4 2.4l-.4.8a1.8 1.8 0 0 0 1 2.5l.9.3a1.8 1.8 0 0 1 0 3.4l-.9.3a1.8 1.8 0 0 0-1 2.5l.4.8a1.8 1.8 0 0 1-2.4 2.4l-.8-.4a1.8 1.8 0 0 0-2.5 1l-.3.9a1.8 1.8 0 0 1-3.4 0l-.3-.9a1.8 1.8 0 0 0-2.5-1l-.8.4a1.8 1.8 0 0 1-2.4-2.4l.4-.8a1.8 1.8 0 0 0-1-2.5l-.9-.3a1.8 1.8 0 0 1 0-3.4l.9-.3a1.8 1.8 0 0 0 1-2.5l-.4-.8a1.8 1.8 0 0 1 2.4-2.4l.8.4a1.8 1.8 0 0 0 2.5-1l.3-.9Z" />
    <circle cx="12" cy="12" r="3" />
  </Base>
);

export const IcSearch = (p: P) => (
  <Base {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4 4" />
  </Base>
);

export const IcCompose = (p: P) => (
  <Base {...p}>
    <path d="M12 4H7a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-5" />
    <path d="M17.6 3.6a2 2 0 0 1 2.8 2.8L13 13.8l-3.6.8.8-3.6 7.4-7.4Z" />
  </Base>
);

export const IcBack = (p: P) => (
  <Base {...p}>
    <path d="m15 5-7 7 7 7" />
  </Base>
);

export const IcChevron = (p: P) => (
  <Base {...p}>
    <path d="m9 6 6 6-6 6" />
  </Base>
);

export const IcMore = (p: P) => (
  <Base {...p}>
    <circle cx="5.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="18.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
  </Base>
);

export const IcSend = (p: P) => (
  <Base {...p}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Base>
);

export const IcMic = (p: P) => (
  <Base {...p}>
    <rect x="9" y="3.5" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" />
  </Base>
);

export const IcClip = (p: P) => (
  <Base {...p}>
    <path d="m20 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1l8.1-8.1a3.3 3.3 0 0 1 4.7 4.7l-8.1 8.1a1.7 1.7 0 0 1-2.4-2.4l7.4-7.4" />
  </Base>
);

export const IcX = (p: P) => (
  <Base {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Base>
);

export const IcCheck = (p: P) => (
  <Base {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Base>
);

export const IcCopy = (p: P) => (
  <Base {...p}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2.5" />
    <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
  </Base>
);

export const IcPlus = (p: P) => (
  <Base {...p}>
    <path d="M12 5v14M5 12h14" />
  </Base>
);

export const IcStop = (p: P) => (
  <Base {...p}>
    <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />
  </Base>
);

export const IcDesktop = (p: P) => (
  <Base {...p}>
    <rect x="3.5" y="4.5" width="17" height="11.5" rx="2" />
    <path d="M9 20h6M12 16v4" />
  </Base>
);

export const IcAlert = (p: P) => (
  <Base {...p}>
    <path d="M12 4 2.8 19.5h18.4L12 4Z" />
    <path d="M12 10v4.5M12 17h.01" />
  </Base>
);

export const IcRetry = (p: P) => (
  <Base {...p}>
    <path d="M4.5 12a7.5 7.5 0 0 1 13-5.1L20 9.5M20 4.5v5h-5M19.5 12a7.5 7.5 0 0 1-13 5.1L4 14.5M4 19.5v-5h5" />
  </Base>
);

export const IcLock = (p: P) => (
  <Base {...p}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Base>
);
