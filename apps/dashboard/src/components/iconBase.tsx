// Base of the inline SVG icon set (24 px grid, 1.7 px stroke, round caps).
import type { ReactNode, SVGProps } from 'react';

export type P = SVGProps<SVGSVGElement>;

export function Base(props: P & { children: ReactNode }) {
  const { children, ...rest } = props;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      className="size-[18px] shrink-0"
      {...rest}
    >
      {children}
    </svg>
  );
}
