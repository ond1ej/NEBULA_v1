// Attachment icons (same grid/stroke as components/icons).
import type { ReactNode, SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;

function Base({ children, ...rest }: P & { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false" className="size-[18px] shrink-0" {...rest}>
      {children}
    </svg>
  );
}

export const IconPaperclip = (p: P) => (
  <Base {...p}>
    <path d="m20.5 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" />
  </Base>
);

const FileBase = (p: P & { children?: ReactNode }) => (
  <Base {...p}>
    <path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8l-4.5-4.5Z" />
    <path d="M14 3.5V8h4.5" />
    {p.children}
  </Base>
);

export function KindIcon({ kind, ...p }: P & { kind: string }) {
  switch (kind) {
    case 'image':
      return (
        <Base {...p}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
          <circle cx="9" cy="10" r="1.6" />
          <path d="m20.5 15.5-4.5-4.5-8.5 8.5" />
        </Base>
      );
    case 'video':
      return (
        <Base {...p}>
          <rect x="3.5" y="6" width="12.5" height="12" rx="2.2" />
          <path d="m16 10.5 4.5-2.5v8L16 13.5" />
        </Base>
      );
    case 'audio':
    case 'voice':
      return (
        <Base {...p}>
          <path d="M5 10v4M8.5 7v10M12 4.5v15M15.5 8v8M19 10.5v3" />
        </Base>
      );
    case 'zip':
      return (
        <FileBase {...p}>
          <path d="M11 9.5h1M11 12h1M11 14.5h1" />
        </FileBase>
      );
    case 'code':
    case 'json':
      return (
        <FileBase {...p}>
          <path d="m10 12.5-1.8 1.8L10 16M14 12.5l1.8 1.8L14 16" />
        </FileBase>
      );
    case 'csv':
      return (
        <FileBase {...p}>
          <path d="M8.5 12h7M8.5 15h7M12 10.5v6.5" />
        </FileBase>
      );
    default:
      return (
        <FileBase {...p}>
          <path d="M8.5 12.5h7M8.5 15.5h5" />
        </FileBase>
      );
  }
}
