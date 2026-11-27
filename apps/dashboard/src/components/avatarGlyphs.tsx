// The 16 fixed agent avatar icons (V3.2.2 agent creator: avatar kind "icon"). Simple monochrome glyphs on the NEBULA
// 24 px grid; shared by the Dashboard and the Mini App (where this module is its own lazy chunk).
import type { ReactNode } from 'react';
import { Base, type P } from './iconBase';

export const AVATAR_ICON_IDS = [
  'robot',
  'spark',
  'brain',
  'code',
  'search',
  'chart',
  'briefcase',
  'globe',
  'shield',
  'book',
  'bolt',
  'star',
  'mail',
  'calendar',
  'music',
  'camera',
] as const;

export type AvatarIconId = (typeof AVATAR_ICON_IDS)[number];

const PATHS: Record<AvatarIconId, ReactNode> = {
  robot: (
    <>
      <rect x="5" y="8" width="14" height="11" rx="3.5" />
      <path d="M12 4.5V8M9.5 13h.01M14.5 13h.01M9.5 16.2h5M3 12.5v2M21 12.5v2" />
    </>
  ),
  spark: <path d="M12 3.5 13.8 10l6.7 2-6.7 2L12 20.5 10.2 14l-6.7-2 6.7-2L12 3.5Z" />,
  brain: (
    <>
      <path d="M9.5 4.5a3 3 0 0 0-3 3 3 3 0 0 0-2 5.2 3 3 0 0 0 2 4.8 3 3 0 0 0 5.5 1.5V6a2.2 2.2 0 0 0-2.5-1.5Z" />
      <path d="M14.5 4.5a3 3 0 0 1 3 3 3 3 0 0 1 2 5.2 3 3 0 0 1-2 4.8 3 3 0 0 1-5.5 1.5" />
    </>
  ),
  code: <path d="m8.5 7.5-4.5 4.5 4.5 4.5M15.5 7.5l4.5 4.5-4.5 4.5M13.5 5l-3 14" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 5 5" />
    </>
  ),
  chart: <path d="M4 4.5v15h16M8 16v-4M12 16V8M16 16v-6.5" />,
  briefcase: (
    <>
      <rect x="3.5" y="7.5" width="17" height="12" rx="2.5" />
      <path d="M9 7.5V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v1.5M3.5 12.5h17" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.3 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.3-3.5-8.5S9.6 5.9 12 3.5Z" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.5 19 6v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-2.5Z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </>
  ),
  book: <path d="M12 6.5c-1.8-1.4-4.3-2-7.5-2v13c3.2 0 5.7.6 7.5 2 1.8-1.4 4.3-2 7.5-2v-13c-3.2 0-5.7.6-7.5 2Zm0 0v13" />,
  bolt: <path d="M13 3.5 5.5 13.5H12l-1 7 7.5-10H12l1-7Z" />,
  star: <path d="m12 4 2.4 5 5.4.7-4 3.8 1 5.4-4.8-2.6-4.8 2.6 1-5.4-4-3.8 5.4-.7L12 4Z" />,
  mail: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
      <path d="m4.5 7.5 7.5 5.5 7.5-5.5" />
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5.5" width="16" height="14.5" rx="2.5" />
      <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
    </>
  ),
  music: (
    <>
      <path d="M9.5 17.5V6l10-2v11.5" />
      <circle cx="7" cy="17.5" r="2.5" />
      <circle cx="17" cy="15.5" r="2.5" />
    </>
  ),
  camera: (
    <>
      <path d="M4 8.5A2 2 0 0 1 6 6.5h2l1.5-2h5l1.5 2h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9Z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
};

export function isAvatarIcon(id: unknown): id is AvatarIconId {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(PATHS, id);
}

/** One avatar icon; an unknown id renders `fallback` (the initials). */
export function AvatarGlyph({ id, fallback = null, ...rest }: { id: string; fallback?: ReactNode } & P) {
  if (!isAvatarIcon(id)) return <>{fallback}</>;
  return (
    <Base data-avatar-icon={id} {...rest}>
      {PATHS[id]}
    </Base>
  );
}
