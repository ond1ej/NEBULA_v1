// Icons used only by the remote access page (same 24 px grid / 1.7 px stroke as components/icons).
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;

function Base({ children, ...rest }: P) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false" className="size-[18px] shrink-0" {...rest}>
      {children}
    </svg>
  );
}

export const IconGlobe = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5S9.7 5.9 12 3.5Z" />
  </Base>
);

export const IconPhone = (p: P) => (
  <Base {...p}>
    <rect x="7" y="2.8" width="10" height="18.4" rx="2.2" />
    <path d="M11 18.2h2" />
  </Base>
);

export const IconServer = (p: P) => (
  <Base {...p}>
    <rect x="4" y="4" width="16" height="7" rx="1.8" />
    <rect x="4" y="13" width="16" height="7" rx="1.8" />
    <path d="M8 7.5h.01M8 16.5h.01M12 7.5h4M12 16.5h4" />
  </Base>
);
