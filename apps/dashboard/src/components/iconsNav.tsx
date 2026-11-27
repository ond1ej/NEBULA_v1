// Icons of the Dashboard shell (navigation, top bar, approvals). Import from './icons'.
import { Base, type P } from './iconBase';

export const IconTasks = (p: P) => (
  <Base {...p}>
    <path d="M10 6.5h10M10 12h10M10 17.5h10" />
    <path d="m3.6 6.5 1.3 1.3L7.4 5.3M3.6 12l1.3 1.3 2.5-2.5M3.6 17.5l1.3 1.3 2.5-2.5" />
  </Base>
);
export const IconProviders = (p: P) => (
  <Base {...p}>
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
    <rect x="7" y="7" width="10" height="10" rx="2.4" />
    <path d="M10 10h4v4h-4z" />
  </Base>
);
export const IconSystem = (p: P) => (
  <Base {...p}>
    <rect x="3" y="4" width="18" height="12.5" rx="2.2" />
    <path d="M8.5 20.5h7M12 16.5v4" />
  </Base>
);
export const IconTeams = (p: P) => (
  <Base {...p}>
    <circle cx="9" cy="8.5" r="3" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
    <circle cx="17" cy="9.5" r="2.4" />
    <path d="M15.5 14.3a4.5 4.5 0 0 1 5.5 4.7" />
  </Base>
);
export const IconMemory = (p: P) => (
  <Base {...p}>
    <path d="M9.5 4.5a3 3 0 0 0-3 3v.2A3 3 0 0 0 4.5 13a3 3 0 0 0 2 2.8v.2a3 3 0 0 0 5.5 1.6V6.1a3 3 0 0 0-2.5-1.6Z" />
    <path d="M14.5 4.5a3 3 0 0 1 3 3v.2a3 3 0 0 1 2 5.3 3 3 0 0 1-2 2.8v.2a3 3 0 0 1-5.5 1.6" />
    <path d="M12 9.5h1.8M12 14h2.2" />
  </Base>
);
export const IconSchedules = (p: P) => (
  <Base {...p}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.4" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
    <path d="M12 13.2v2.6l1.8 1.2" />
  </Base>
);
export const IconSkills = (p: P) => (
  <Base {...p}>
    <path d="M10 4.5a2 2 0 1 1 4 0V6h3a1 1 0 0 1 1 1v3h-1.5a2 2 0 1 0 0 4H18v3a1 1 0 0 1-1 1h-3v-1.5a2 2 0 1 0-4 0V18H7a1 1 0 0 1-1-1v-3h1.5a2 2 0 1 0 0-4H6V7a1 1 0 0 1 1-1h3V4.5Z" />
  </Base>
);
export const IconResources = (p: P) => (
  <Base {...p}>
    <path d="M3 12h3.5l2.5-6 4 12 2.6-6H21" />
  </Base>
);
export const IconMore = (p: P) => (
  <Base {...p}>
    <circle cx="5.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="18.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
  </Base>
);
export const IconShield = (p: P) => (
  <Base {...p}>
    <path d="M12 3.5 5 6v5.5c0 4.3 2.9 7.7 7 9 4.1-1.3 7-4.7 7-9V6l-7-2.5Z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </Base>
);
export const IconLogout = (p: P) => (
  <Base {...p}>
    <path d="M14 4.5h3.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14" />
    <path d="M10 16.5 5.5 12 10 7.5M5.5 12H15" />
  </Base>
);
export const IconUser = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="8.5" r="3.8" />
    <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
  </Base>
);
export const IconCalendar = (p: P) => (
  <Base {...p}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.4" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </Base>
);
export const IconTerminal = (p: P) => (
  <Base {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="2.2" />
    <path d="m7 9.5 3 2.5-3 2.5M12.5 15h4.5" />
  </Base>
);
export const IconPackage = (p: P) => (
  <Base {...p}>
    <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
    <path d="m4 7.5 8 4.5 8-4.5M12 12v9M8 5.2l8 4.6" />
  </Base>
);
export const IconBots = (p: P) => (
  <Base {...p}>
    <rect x="5" y="8" width="14" height="11" rx="3" />
    <path d="M12 4v4M9.5 13h.01M14.5 13h.01M9.5 16.2h5" />
    <circle cx="12" cy="3.5" r="1" />
  </Base>
);
export const IconHost = (p: P) => (
  <Base {...p}>
    <rect x="3.5" y="5" width="17" height="11" rx="2" />
    <path d="M8.5 20h7M12 16v4" />
    <path d="m8 9.5 2 1.5-2 1.5M12 12.5h3" />
  </Base>
);
export const IconRemote = (p: P) => (
  <Base {...p}>
    <rect x="7" y="2.8" width="10" height="18.4" rx="2.2" />
    <path d="M11 18.2h2" />
    <path d="M3 9.5a9 9 0 0 1 0 5M21 9.5a9 9 0 0 1 0 5" />
  </Base>
);
export const IconVoice = (p: P) => (
  <Base {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
  </Base>
);
/** Password Vault (padlock with keyhole). */
/** V4.0: paired NEBULA apps (a laptop with a phone in front of it). */
export const IconDevices = (p: P) => (
  <Base {...p}>
    <path d="M4.5 15.5V6.2A1.7 1.7 0 0 1 6.2 4.5h11.6a1.7 1.7 0 0 1 1.7 1.7v2.3" />
    <path d="M2.5 18.5h10" />
    <rect x="15" y="10.5" width="6.5" height="10" rx="1.6" />
    <path d="M17.6 18.2h1.3" />
  </Base>
);
export const IconVault = (p: P) => (
  <Base {...p}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.4" />
    <path d="M8 10.5V7.6a4 4 0 0 1 8 0v2.9M12 14.6v2.2" />
  </Base>
);
