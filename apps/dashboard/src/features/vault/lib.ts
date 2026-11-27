// Pure helpers of the Password Vault UI: labels, passphrase strength, password generator, countdowns.
import { isApiError } from '../../lib/http';
import type { ApprovalPolicy, AgentVaultMode, CredentialType } from './types';
import { MIN_PASSPHRASE } from './types';

export const TYPE_LABEL: Record<CredentialType, string> = {
  website: 'Website',
  application: 'Application',
  api_token: 'API token',
};

export const POLICY_LABEL: Record<ApprovalPolicy, string> = {
  always_ask: 'Always ask',
  once_per_task: 'Ask once per task',
  auto: 'Automatic',
};

export const POLICY_HINT: Record<ApprovalPolicy, string> = {
  always_ask: 'You approve every sign-in (default).',
  once_per_task: 'You approve the first sign-in of each task; later sign-ins in that task need no approval.',
  auto: 'No approval. Only possible for sign-in to exactly one origin.',
};

export const MODE_LABEL: Record<AgentVaultMode, string> = {
  NONE: 'No vault access',
  SELECTED: 'Selected credentials',
  MANAGED: 'Managed collection',
};

export const ACTION_LABEL: Record<string, string> = { sign_in: 'Sign in' };

/** Audited vault operations (vault.py `record(...)`, vault_broker.py). */
export const VAULT_OP_LABEL: Record<string, string> = {
  create: 'Vault created',
  unlock: 'Unlock',
  reauth: 'Passphrase confirmed',
  rotate_passphrase: 'Passphrase changed',
  lock: 'Locked',
  settings: 'Settings changed',
  'entry.create': 'Credential added',
  'entry.update': 'Credential edited',
  'entry.delete': 'Credential deleted',
  'reveal.password': 'Password revealed',
  'reveal.username': 'Username revealed',
  'reveal.notes': 'Notes revealed',
  export: 'Export',
  import: 'Import',
  'agent.mode': 'Agent access mode',
  'grant.create': 'Grant created',
  'grant.update': 'Grant edited',
  'grant.revoke': 'Grant revoked',
  'grant.delete': 'Grant deleted',
  'use.sign_in': 'Agent sign-in',
};


/** Human readable "mm:ss" / "h:mm:ss" for a countdown in seconds. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(r).padStart(2, '0')}`;
}

export interface Strength {
  /** 0–100 for a meter. */
  score: number;
  label: string;
  tone: 'danger' | 'warn' | 'accent' | 'success';
  ok: boolean;
}

/**
 * Rough client-side passphrase strength (length × character variety). Only a hint: the host enforces the minimum
 * length, rejects repetitive passphrases and the NEBULA login password.
 */
export function passphraseStrength(p: string): Strength {
  if (!p) return { score: 0, label: `At least ${MIN_PASSPHRASE} characters`, tone: 'danger', ok: false };
  const unique = new Set(p).size;
  if (p.length < MIN_PASSPHRASE) return { score: Math.min(30, (p.length / MIN_PASSPHRASE) * 30), label: `Too short (${p.length}/${MIN_PASSPHRASE})`, tone: 'danger', ok: false };
  if (unique < 5) return { score: 15, label: 'Too repetitive', tone: 'danger', ok: false };
  let pool = 0;
  if (/[a-z]/.test(p)) pool += 26;
  if (/[A-Z]/.test(p)) pool += 26;
  if (/[0-9]/.test(p)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(p)) pool += 33;
  const bits = Math.min(p.length, unique * 2) * Math.log2(Math.max(pool, 2));
  if (bits < 55) return { score: 40, label: 'Fair — longer is better', tone: 'warn', ok: true };
  if (bits < 80) return { score: 70, label: 'Good', tone: 'accent', ok: true };
  return { score: 100, label: 'Strong', tone: 'success', ok: true };
}

const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!#$%&*+-=?@^_~';
const ALPHABET = LOWER + UPPER + DIGITS + SYMBOLS;

/** Uniformly random index below `n` (rejection sampling on crypto.getRandomValues). */
function randomIndex(n: number): number {
  const limit = 256 - (256 % n);
  const b = new Uint8Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(b);
    if (b[0] < limit) return b[0] % n;
  }
}

/** Random password from the Web Crypto CSPRNG with lower, upper, digit and symbol characters. */
export function generatePassword(length = 20): string {
  const n = Math.max(12, Math.min(128, Math.floor(length)));
  for (;;) {
    let out = '';
    for (let i = 0; i < n; i += 1) out += ALPHABET[randomIndex(ALPHABET.length)];
    if ([LOWER, UPPER, DIGITS, SYMBOLS].every((set) => [...out].some((c) => set.includes(c)))) return out;
  }
}

/** "work, Shared Finance" -> ['work', 'shared-finance'] (host rules: lower-case, a-z 0-9 - _ ., max 10). */
export function parseTags(s: string): string[] {
  const out: string[] = [];
  for (const raw of s.split(/[,\n]/)) {
    const t = raw
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9._-]/g, '')
      .slice(0, 32);
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 10);
}

/** Canonical-ish origin of a URL the owner typed ('' when not parseable). The host validates for real. */
export function originOf(url: string): string {
  try {
    return new URL(url.trim()).origin;
  } catch {
    return '';
  }
}

export const errCode = (e: unknown): string | null => (isApiError(e) ? e.code : null);

/** `<input type="datetime-local">` value -> epoch seconds (null when empty / invalid). */
export function localInputToEpoch(v: string): number | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t / 1000 : null;
}

/** epoch seconds -> `<input type="datetime-local">` value in local time. */
export function epochToLocalInput(ts: number | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
