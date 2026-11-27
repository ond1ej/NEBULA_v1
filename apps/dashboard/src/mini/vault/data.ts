// Password Vault data of the Mini App: every response is reduced to an explicit whitelist of fields before it reaches
// component state (clean*), and loaded per screen (useLocal) — never into the shared query cache, never into storage.
// Secrets (a revealed password, passphrases, the remote PIN) never pass through here: they live only in the state of
// the component that asked for them and in one request body.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNebulaEvents } from '../../hooks/useEvents';
import { isApiError } from '../../lib/http';
import type { NebulaEvent } from '../../types';
import type { AgentVault, VaultAuditRow, VaultEntry, VaultGrant, VaultStatus } from '../types';

// ---------------------------------------------------------------- whitelist
const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strs = (v: unknown, max = 40): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max).map((x) => x.slice(0, 200)) : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const list = <T>(v: unknown, f: (x: unknown) => T, max = 500): T[] => (Array.isArray(v) ? v.slice(0, max).map(f) : []);

export interface ManagedStatus extends VaultStatus {
  lockout_until: number | null;
  /** Agent credential use through the sign-in broker. */
  broker_enabled: boolean;
}

export function cleanStatus(raw: unknown): ManagedStatus {
  const o = obj(raw);
  const b = obj(o.broker);
  const st = obj(o.settings);
  return {
    exists: o.exists === true,
    locked: o.locked !== false,
    entry_count: num(o.entry_count) ?? 0,
    auto_lock_minutes: num(o.auto_lock_minutes),
    unlocked_at: num(o.unlocked_at),
    lock_at: num(o.lock_at),
    lockout_until: num(o.lockout_until),
    broker: { enabled: b.enabled === true, available: b.available === true, reason: str(b.reason, 300) },
    broker_enabled: st.broker_enabled === undefined ? b.enabled === true : st.broker_enabled === true,
    management_local: o.management_local !== false,
  };
}

export function cleanEntry(raw: unknown): VaultEntry {
  const o = obj(raw);
  return {
    id: str(o.id) ?? '',
    display_name: str(o.display_name) ?? 'Unnamed credential',
    app_name: str(o.app_name),
    origin: str(o.origin, 300),
    credential_type: str(o.credential_type, 40) ?? 'website',
    tags: strs(o.tags, 12),
    created_at: num(o.created_at) ?? 0,
    updated_at: num(o.updated_at) ?? 0,
    grant_count: num(o.grant_count) ?? 0,
  };
}

/** Owner detail: metadata + the user name and flags. A password or notes in a response are never kept. */
export interface EntryDetail extends VaultEntry {
  username: string;
  has_password: boolean;
  has_notes: boolean;
  login_url: string;
}

export function cleanEntryDetail(raw: unknown): EntryDetail {
  const o = obj(raw);
  return { ...cleanEntry(o), username: str(o.username, 512) ?? '', has_password: o.has_password === true, has_notes: o.has_notes === true, login_url: str(o.login_url, 2048) ?? '' };
}

export function cleanAudit(raw: unknown): VaultAuditRow {
  const o = obj(raw);
  return {
    id: str(o.id) ?? '',
    ts: num(o.ts) ?? 0,
    actor_type: str(o.actor_type, 40) ?? '',
    actor_id: str(o.actor_id),
    agent_id: str(o.agent_id),
    agent_name: str(o.agent_name),
    entry_id: str(o.entry_id),
    entry_name: str(o.entry_name),
    operation: str(o.operation, 60) ?? 'access',
    destination_origin: str(o.destination_origin, 300),
    approval_id: str(o.approval_id),
    outcome: str(o.outcome, 40) ?? 'unknown',
    reason_code: str(o.reason_code, 80),
  };
}

export type ManagedGrant = VaultGrant & { agent_id: string | null };

export function cleanGrant(raw: unknown): ManagedGrant {
  const o = obj(raw);
  return {
    id: str(o.id) ?? '',
    entry_id: str(o.entry_id) ?? '',
    entry_name: str(o.entry_name) ?? 'Credential',
    credential_type: str(o.credential_type, 40) ?? 'website',
    agent_id: str(o.agent_id),
    allowed_origins: strs(o.allowed_origins),
    allowed_actions: strs(o.allowed_actions),
    approval_policy: str(o.approval_policy, 40) ?? 'always_ask',
    enabled: o.enabled === true,
    expires_at: num(o.expires_at),
    created_at: num(o.created_at) ?? 0,
    last_used_at: num(o.last_used_at),
  };
}

export function cleanAgentVault(raw: unknown): AgentVault {
  const o = obj(raw);
  return {
    agent_id: str(o.agent_id) ?? '',
    mode: str(o.mode, 20) ?? 'NONE',
    managed_tags: strs(o.managed_tags, 20),
    grants: list(o.grants, cleanGrant, 200),
    recent: list(o.recent, cleanAudit, 50),
  };
}

export const cleanEntries = (raw: unknown) => list(raw, cleanEntry);
export const cleanGrants = (raw: unknown) => list(raw, cleanGrant);
export const cleanAudits = (raw: unknown) => list(raw, cleanAudit, 300);

/** Smart sign-in owner settings (no PIN, no secrets: the PIN status only). */
export interface SignInSettings {
  enabled: boolean;
  remote_submission: boolean;
  allow_local_network: boolean;
  /** V3.4: a passkey / security key request — the site's password option by itself, or ask first. */
  passkey_fallback: 'password' | 'ask';
  pin: { configured: boolean; set_at: number | null; locked_until: number | null };
}

export function cleanSignInSettings(raw: unknown): SignInSettings {
  const o = obj(raw);
  const p = obj(o.pin);
  return {
    enabled: o.enabled !== false,
    remote_submission: o.remote_submission === true,
    allow_local_network: o.allow_local_network === true,
    passkey_fallback: o.passkey_fallback === 'ask' ? 'ask' : 'password',
    pin: { configured: p.configured === true, set_at: num(p.set_at), locked_until: num(p.locked_until) },
  };
}

export interface TrustView {
  builtin: { id: string; name: string; sign_in_hosts: string[] }[];
  relationships: { service: string; idp: string; first_party: boolean }[];
  verified_sites: { origin: string }[];
}

export function cleanTrust(raw: unknown): TrustView {
  const o = obj(raw);
  return {
    builtin: list(o.builtin, (x) => {
      const b = obj(x);
      return { id: str(b.id, 60) ?? '', name: str(b.name, 80) ?? '', sign_in_hosts: strs(b.sign_in_hosts, 12) };
    }, 50),
    relationships: list(o.relationships, (x) => {
      const r = obj(x);
      return { service: str(r.service, 300) ?? '', idp: str(r.idp, 300) ?? '', first_party: r.first_party === true };
    }, 50),
    verified_sites: list(o.verified_sites, (x) => ({ origin: str(obj(x).origin, 300) ?? '' }), 100),
  };
}

// ---------------------------------------------------------------- screen-local loading (never the shared cache)
export function useLocal<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[], refreshOn?: (ev: NebulaEvent) => boolean) {
  const [state, setState] = useState<{ data: T | null; error: unknown }>({ data: null, error: null });
  const [n, setN] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const ctl = new AbortController();
    loadRef.current(ctl.signal).then(
      (data) => !ctl.signal.aborted && setState({ data, error: null }),
      (error: unknown) => {
        if (ctl.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
        setState((s) => ({ data: s.data, error }));
      },
    );
    return () => ctl.abort();
  }, [...deps, n]); // the caller's explicit dependency list
  useEffect(() => () => setState({ data: null, error: null }), []);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useNebulaEvents((ev) => {
    if (!refreshOn?.(ev)) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setN((x) => x + 1), 300);
  });
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const reload = useCallback(() => setN((x) => x + 1), []);
  const set = useCallback((fn: (prev: T | null) => T | null) => setState((s) => ({ data: fn(s.data), error: s.error })), []);
  return { ...state, reload, set };
}

export const vaultEvent = (ev: NebulaEvent) => ev.type === 'vault.status.changed' || ev.type === 'vault.access';

// ---------------------------------------------------------------- labels + errors
export const TYPE_LABEL: Record<string, string> = { website: 'Website', application: 'App', api_token: 'API token' };
export const MODE_LABEL: Record<string, string> = { NONE: 'No vault access', SELECTED: 'Selected credentials', MANAGED: 'Managed by tags' };
export const POLICY_LABEL: Record<string, string> = { always_ask: 'Ask every time', once_per_task: 'Ask once per task', auto: 'No approval needed' };

export function unavailable(e: unknown): string | null {
  if (!isApiError(e)) return null;
  if (e.status === 404) return 'The Password Vault is not available on this NEBULA version.';
  if (e.status === 403 && e.code !== 'stepup_required' && e.code !== 'reauth_required')
    return 'The Password Vault is not available through the Mini App on this NEBULA.';
  return null;
}

const wait = (s: number) => (s >= 90 ? `${Math.ceil(s / 60)} min` : `${Math.max(1, Math.round(s))} s`);

/** Owner-facing message for a failed vault call. Never contains what was typed. */
export function vaultErrorText(e: unknown): string {
  if (!isApiError(e)) return e instanceof Error ? e.message : 'Something went wrong.';
  const left = typeof e.details?.attempts_left === 'number' ? e.details.attempts_left : null;
  const retry = typeof e.details?.retry_after === 'number' ? e.details.retry_after : null;
  switch (e.code) {
    case 'wrong_passphrase':
      return `Wrong vault passphrase.${left !== null ? ` ${left} attempt${left === 1 ? '' : 's'} left before a temporary lock.` : ''}`;
    case 'rate_limited':
      return `Too many attempts. Try again${retry !== null ? ` in ${wait(retry)}` : ' later'}.`;
    case 'weak_passphrase':
      return e.message ? `${e.message[0].toUpperCase()}${e.message.slice(1)}.` : 'The passphrase is too weak.';
    case 'passphrase_reused':
      return 'Use a dedicated vault passphrase, not your NEBULA login password.';
    case 'vault_locked':
      return 'The vault is locked. Unlock it first.';
    case 'no_vault':
      return 'There is no Password Vault yet. Create it first.';
    case 'vault_exists':
      return 'The vault already exists.';
    case 'reauth_required':
      return 'Confirm your vault passphrase to continue.';
    case 'stepup_required':
      return 'Not confirmed. This change needs a confirmation that it’s you.';
    case 'bad_export':
      return 'Wrong export passphrase, or the file is not a NEBULA vault export.';
    case 'agent_vault_disabled':
      return 'Give the agent vault access first (Selected credentials).';
    case 'auto_too_broad':
      return '“No approval needed” is only possible for sign-in to exactly one website.';
    case 'invalid_relationship':
    case 'invalid_site':
    case 'invalid_origin':
    case 'insecure_origin':
      return e.message ? `${e.message[0].toUpperCase()}${e.message.slice(1)}.` : 'That address is not accepted.';
    case 'network_error':
      return 'NEBULA cannot be reached. Check your connection and try again.';
    default:
      return e.message || 'The request failed.';
  }
}

/** "example.com" → "https://example.com"; a full URL → its origin; '' when it is not an address. */
export function normalizeOrigin(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(withScheme);
    if (!u.hostname || !/^https?:$/.test(u.protocol)) return '';
    return u.origin;
  } catch {
    return '';
  }
}

/** Exact https origin for trust settings (the host refuses anything else; this is a hint only). */
export function httpsOrigin(raw: string): string {
  const o = normalizeOrigin(raw);
  return o.startsWith('https://') ? o : '';
}
