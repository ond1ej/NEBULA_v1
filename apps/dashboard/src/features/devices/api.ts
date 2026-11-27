// Typed client of the owner's paired NEBULA apps for iPhone / Mac (V4.0, routes_v40.py). Requests go through lib/http:
// in the Telegram Mini App's administration area its transport is the Mini App session, so a 403 `stepup_required`
// (pairing, approving) opens the owner confirmation and the request is retried once.
// The pairing code / link is single-use and expires after 5 minutes; it lives only in the pairing dialog's state.
import { t, tp } from '../../i18n';
import { request } from '../../lib/http';
import type { Epoch } from '../../types';

const enc = encodeURIComponent;

export type DevicePlatform = 'ios' | 'macos';
export type KeyProtection = 'secure_enclave' | 'keychain';

export interface AppDevice {
  id: string;
  name: string;
  platform: DevicePlatform | string;
  model: string | null;
  app_version: string | null;
  key_protection: KeyProtection | string;
  status: 'pending' | 'active' | string;
  created_at: Epoch;
  approved_at: Epoch | null;
  last_seen_at: Epoch | null;
  revoked_at: Epoch | null;
  key_fingerprint: string;
  push: boolean;
  /** The vault key is wrapped for this device: Face ID / Touch ID unlocks the Password Vault there. */
  vault_key: boolean;
  /** Pending devices only: the 6 digits the device shows too. */
  verification_code?: string;
}

export interface DeviceList {
  devices: AppDevice[];
  /** The public HTTPS address of the Mini App gateway (null: remote access is off — pairing is not possible). */
  gateway_url: string | null;
  server_fingerprint: string;
}

export interface Pairing {
  pairing_id: string;
  code: string;
  /** nebula://pair?… — what the QR code holds; on a Mac it is pasted into the app. */
  url: string;
  /** The QR code as SVG markup (rendered only as an <img> data URL, never as markup). */
  qr_svg: string | null;
  expires_at: Epoch;
  gateway_url: string;
  server_fingerprint: string;
}

export type PairingState = 'open' | 'claimed' | 'expired' | 'cancelled' | 'burned';

export interface PairingStatus {
  pairing_id: string;
  status: PairingState | string;
  expires_at: Epoch;
  device: AppDevice | null;
}

export const devicesApi = {
  list: (signal?: AbortSignal) => request<DeviceList>('/devices', { signal }),
  startPairing: () => request<Pairing>('/devices/pairing', { method: 'POST' }),
  pairing: (id: string, signal?: AbortSignal) => request<PairingStatus>(`/devices/pairing/${enc(id)}`, { signal }),
  cancelPairing: (id: string) => request<unknown>(`/devices/pairing/${enc(id)}`, { method: 'DELETE' }),
  approve: (id: string) => request<AppDevice>(`/devices/${enc(id)}/approve`, { method: 'POST' }),
  reject: (id: string) => request<unknown>(`/devices/${enc(id)}/reject`, { method: 'POST' }),
  rename: (id: string, name: string) => request<AppDevice>(`/devices/${enc(id)}`, { method: 'PATCH', body: { name } }),
  revoke: (id: string) => request<{ device_id: string; status: string; sessions_ended: number }>(`/devices/${enc(id)}`, { method: 'DELETE' }),
};

/** The QR code as an image URL: the SVG is never inserted as markup. */
export function qrDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** "123456" → "123 456" (easier to compare with the phone). */
export function groupCode(code: string): string {
  return /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** Relative time of a device event ("5 min ago", "just now", "never"). */
export function relativeAgo(ts: Epoch | null | undefined, now = Date.now() / 1000): string {
  if (!ts) return t('time.never');
  const d = Math.max(0, Math.round(now - ts));
  if (d < 45) return t('time.justNow');
  if (d < 3600) return t('time.minutesAgo', { n: Math.max(1, Math.round(d / 60)) });
  if (d < 86400) return t('time.hoursAgo', { n: Math.round(d / 3600) });
  const days = Math.round(d / 86400);
  return days === 1 ? t('time.yesterday') : tp('time.daysAgo', days);
}

/** mm:ss countdown. */
export function countdownText(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const platformLabel = (p: string): string => (p === 'ios' ? 'iPhone' : p === 'macos' ? 'Mac' : p);
export const protectionLabel = (k: string): string => (k === 'secure_enclave' ? t('devices.protection.secureEnclave') : k === 'keychain' ? t('devices.protection.keychain') : k);
