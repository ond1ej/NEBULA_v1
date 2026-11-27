// Shared tone → class maps (status colours are reserved for state; always paired with text or an icon).
export type Tone = 'success' | 'warn' | 'danger' | 'info' | 'accent' | 'neutral';

export const TONE_BADGE: Record<Tone, string> = {
  success: 'bg-success/10 text-success ring-success/25',
  warn: 'bg-warn/10 text-warn ring-warn/25',
  danger: 'bg-danger/10 text-danger ring-danger/30',
  info: 'bg-info/10 text-info ring-info/25',
  accent: 'bg-accent/15 text-accent-soft ring-accent/35',
  neutral: 'bg-white/[0.04] text-muted ring-white/10',
};

export const TONE_DOT: Record<Tone, string> = {
  success: 'bg-success',
  warn: 'bg-warn',
  danger: 'bg-danger',
  info: 'bg-info',
  accent: 'bg-accent-soft',
  neutral: 'bg-subtle',
};

export const TONE_TEXT: Record<Tone, string> = {
  success: 'text-success',
  warn: 'text-warn',
  danger: 'text-danger',
  info: 'text-info',
  accent: 'text-accent-soft',
  neutral: 'text-muted',
};

export const TONE_PANEL: Record<Tone, string> = {
  success: 'border-success/25 bg-success/[0.06]',
  warn: 'border-warn/30 bg-warn/[0.06]',
  danger: 'border-danger/30 bg-danger/[0.07]',
  info: 'border-info/25 bg-info/[0.06]',
  accent: 'border-accent/35 bg-accent/[0.08]',
  neutral: 'border-border bg-panel-2',
};
