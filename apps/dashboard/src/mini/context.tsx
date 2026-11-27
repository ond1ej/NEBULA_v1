import { createContext, useContext, type ReactNode } from 'react';
import type { MiniApi } from './api';
import type { MiniClient, MiniSession } from './client';
import type { MiniMe, MiniRole } from './types';

export interface MiniContextValue {
  client: MiniClient;
  api: MiniApi;
  session: MiniSession | null;
  me: MiniMe | null;
  username: string | null;
  /** True inside Telegram (native BackButton, haptics, theme). */
  inTelegram: boolean;
}

const Ctx = createContext<MiniContextValue | null>(null);

export function MiniProvider({ value, children }: { value: MiniContextValue; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMini(): MiniContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMini must be used inside <MiniProvider>');
  return v;
}

/** The verified owner of the main bot: full administration (the Dashboard's pages under #/admin). */
export function isAdmin(ctx: Pick<MiniContextValue, 'me'>): boolean {
  return ctx.me?.admin === true;
}

/** The owner manages the Password Vault here (the local browser preview is the Dashboard owner's own session). */
export function canManageVault(ctx: Pick<MiniContextValue, 'me' | 'client'>): boolean {
  return isAdmin(ctx) || ctx.client.mode === 'cookie';
}

export function hasPermission(ctx: Pick<MiniContextValue, 'me' | 'session' | 'client'>, perm: string): boolean {
  if (ctx.client.mode === 'cookie') return true; // dashboard owner session: every local check applies on the host
  const perms = ctx.session?.permissions ?? ctx.me?.permissions ?? [];
  return perms.includes(perm);
}

/**
 * The role of this session as the host reports it (`GET /miniapp/me`). Without that answer an agent's own bot is still
 * recognised by its bot key (the host does the same: every bot other than "main" is an agent bot); anything else stays
 * unknown and gets no owner-only controls.
 */
export function sessionRole(ctx: Pick<MiniContextValue, 'me' | 'session' | 'client'>): MiniRole | null {
  if (ctx.client.mode === 'cookie') return 'owner'; // the Dashboard session on this Mac
  const role = ctx.me?.role;
  if (role === 'owner' || role === 'operator' || role === 'agent_bot') return role;
  const bot = ctx.session?.bot ?? ctx.me?.bot ?? null;
  return bot && bot !== 'main' ? 'agent_bot' : null;
}

/**
 * Approvals (task, owner, vault, company plans) and sign-in answers belong to the owner: the host answers 403
 * `owner_only` to every other remote role, so operators and agent bots never see the controls. A non-fresh owner still
 * gets `stepup_required` for vault, host and system approvals; the client confirms and retries (StepUpProvider).
 */
export function canDecide(ctx: Pick<MiniContextValue, 'me' | 'session' | 'client'>): boolean {
  if (ctx.client.mode === 'cookie') return true;
  return sessionRole(ctx) === 'owner' && hasPermission(ctx, 'approvals');
}

/** An agent's own bot: only that agent's chat and tasks are reachable (the host answers 403 `not_available_to_agent_bot` to the rest). */
export function isAgentBot(ctx: Pick<MiniContextValue, 'me' | 'session' | 'client'>): boolean {
  return sessionRole(ctx) === 'agent_bot';
}
