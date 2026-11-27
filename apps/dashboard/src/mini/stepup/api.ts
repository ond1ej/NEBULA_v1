// Owner confirmation endpoints. The confirmation requests themselves are `confirmation` requests: never handed to the
// challenge handler, and their 401 (wrong password / passphrase, bad token, expired challenge) does not end the session.
// Request bodies carry the password / passphrase / device token only in memory, for this one request.
//
// V4.0: POST /auth/confirm is ONE owner confirmation — Telegram Face ID, the vault passphrase or the NEBULA password —
// that makes this session fresh and, with `unlock_vault`, also unlocks the Password Vault (or re-confirms it for
// showing / exporting secrets). The V3.3 POST /auth/stepup stays on the host for older clients only.
import type { MiniClient } from '../client';
import type { Assurance } from '../types';

const enc = encodeURIComponent;

export type ConfirmMethod = 'telegram_biometric' | 'vault_passphrase' | 'password';

export interface ConfirmBody {
  method: ConfirmMethod;
  device_id?: string;
  challenge_id?: string;
  token?: string;
  passphrase?: string;
  password?: string;
  unlock_vault?: boolean;
  enroll_vault_key?: boolean;
}

export interface ConfirmVault {
  exists: boolean;
  locked: boolean;
  entry_count: number;
  /** 'unlocked' | 'confirmed' | 'rewrapped' | 'unlocked_passphrase' | 'confirmed_passphrase' | '…+enrolled' | 'device_key_invalid' | null */
  result: string | null;
  reauth_until: number | null;
  device_key: boolean;
}

export interface ConfirmResult {
  fresh_until: number | null;
  /** telegram_biometric: the rotated device token — store it right away (the old one is no longer accepted). */
  next_token?: string | null;
  vault: ConfirmVault | null;
  /** The vault was asked for but is still locked (e.g. no vault key for this device yet). */
  vault_unlock_needed?: boolean;
}

export function stepUpApi(c: MiniClient) {
  return {
    assurance: (signal?: AbortSignal) => c.request<Assurance>('/auth/assurance', { signal }),
    challenge: (deviceId: string) =>
      c.request<{ challenge_id: string; expires_at: number }>('/auth/stepup/challenge', { method: 'POST', body: { device_id: deviceId }, confirmation: true }),
    /** The unified owner confirmation (V4.0). */
    confirm: (body: ConfirmBody) => c.request<ConfirmResult>('/auth/confirm', { method: 'POST', body, confirmation: true }),
    /** Needs a fresh confirmation itself: a 403 step-up answer opens the confirmation sheet and is retried once. */
    addDevice: (name: string) => c.request<{ device_id: string; token: string }>('/auth/devices', { method: 'POST', body: { name } }),
    removeDevice: (id: string) => c.request<unknown>(`/auth/devices/${enc(id)}`, { method: 'DELETE' }),
  };
}

export type StepUpApi = ReturnType<typeof stepUpApi>;
