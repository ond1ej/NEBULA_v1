// Class maps of <SmartAuthRequest> per app: the Mini App (mini.css tokens, iOS sizes, 16 px inputs so iOS does not zoom)
// and the Dashboard (components/ui look). Only shared colour tokens are used, so both stylesheets resolve them.
export type SkinVariant = 'mini' | 'dashboard';

export interface Skin {
  root: string;
  title: string;
  text: string;
  small: string;
  strong: string;
  label: string;
  input: string;
  code: string;
  btn: string;
  primary: string;
  secondary: string;
  danger: string;
  ghost: string;
  panel: string;
  option: string;
  check: string;
  actions: string;
  mono: string;
}

const MINI: Skin = {
  root: 'space-y-4 text-subhead',
  title: 'text-headline font-semibold text-text',
  text: 'text-subhead text-muted',
  small: 'text-footnote text-muted',
  strong: 'text-subhead font-semibold text-text',
  label: 'mb-1.5 block text-footnote font-medium text-muted',
  input:
    'nb-field min-h-12 w-full min-w-0 rounded-xl bg-panel-2 px-3.5 text-[16px] text-text outline-none placeholder:text-subtle disabled:opacity-55 aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-danger/60',
  code: 'text-center font-mono text-[22px] tracking-[0.25em]',
  btn: 'nb-press inline-flex min-h-11 select-none items-center justify-center gap-2 rounded-xl px-4 text-body font-semibold focus-ring disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:size-[18px]',
  primary: 'bg-accent-fill text-on-accent',
  secondary: 'bg-panel-2 text-text',
  danger: 'bg-danger/15 text-danger',
  ghost: 'text-accent-soft',
  panel: 'rounded-xl bg-panel-2 px-3.5 py-3',
  option: 'nb-row flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-xl bg-panel-2 px-3.5 py-2.5 text-left',
  check: 'size-5 shrink-0 accent-accent',
  actions: 'flex flex-col gap-2 pt-1 sm:flex-row-reverse',
  mono: 'font-mono text-[14px] break-all',
};

const DASHBOARD: Skin = {
  root: 'space-y-4 text-sm',
  title: 'text-base font-semibold text-text',
  text: 'text-sm text-muted',
  small: 'text-xs text-muted',
  strong: 'text-sm font-semibold text-text',
  label: 'mb-1.5 block text-[13px] font-medium text-text',
  input:
    'h-10 w-full min-w-0 rounded-lg border border-border-strong bg-input px-3 text-sm text-text placeholder:text-subtle hover:border-border-hover focus:border-accent focus:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-55 aria-[invalid=true]:border-danger/70',
  code: 'h-12 text-center font-mono text-xl tracking-[0.25em]',
  btn: 'inline-flex h-9 select-none items-center justify-center gap-2 rounded-lg px-3.5 text-sm font-medium transition-colors focus-ring disabled:cursor-not-allowed disabled:opacity-50 touch:h-11 [&_svg]:size-4',
  primary: 'bg-accent text-white hover:bg-accent-hover',
  secondary: 'border border-border-strong bg-panel-2 text-text hover:bg-panel-3',
  danger: 'border border-danger/35 bg-danger/10 text-danger hover:bg-danger/[0.16]',
  ghost: 'text-muted hover:bg-white/[0.05] hover:text-text',
  panel: 'rounded-lg border border-border bg-panel-2 px-3.5 py-3',
  option: 'flex w-full cursor-pointer items-center gap-3 rounded-lg border border-border bg-panel-2 px-3.5 py-2.5 text-left hover:border-border-hover',
  check: 'size-4 shrink-0 accent-accent',
  actions: 'flex flex-wrap justify-end gap-2 pt-1',
  mono: 'font-mono text-[13px] break-all',
};

export const SKINS: Record<SkinVariant, Skin> = { mini: MINI, dashboard: DASHBOARD };

export const TONE_BOX: Record<'warning' | 'danger' | 'success' | 'info' | 'neutral', string> = {
  warning: 'border border-warn/30 bg-warn/10',
  danger: 'border border-danger/40 bg-danger/10',
  success: 'border border-success/30 bg-success/10',
  info: 'border border-info/25 bg-info/10',
  neutral: 'border border-border bg-panel-2',
};

export const TONE_TITLE: Record<'warning' | 'danger' | 'success' | 'info' | 'neutral', string> = {
  warning: 'text-warn',
  danger: 'text-danger',
  success: 'text-success',
  info: 'text-info',
  neutral: 'text-text',
};
