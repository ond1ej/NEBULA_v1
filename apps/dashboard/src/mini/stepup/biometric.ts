// Face ID / Touch ID / fingerprint confirmations through Telegram's BiometricManager (Bot API 7.2+).
//
// Enrolment: the host issues a random device token (POST /auth/devices) and keeps only its SHA-256. The token is stored
// ONLY in Telegram's BiometricManager (the device's secure storage) — never in localStorage/sessionStorage, never in a
// URL, never logged. A confirmation unlocks it with the device's biometrics and sends it once, bound to a single-use
// challenge; the host answers with the next token (rotation), which replaces the stored one right away.
//
// The stored value is `nebula1.<device id>.<token>`: the device id the challenge needs comes from the same secure
// storage (it survives relaunches of the Mini App; the device id is not a secret).
import { getWebApp, isInTelegram, supports, type TgBiometricManager, type TgWebApp } from '../telegram';
import { t } from '../../i18n';

const PREFIX = 'nebula1';

export type BiometricKind = 'face' | 'finger' | 'unknown';

/** BiometricManager when this Mini App runs inside a Telegram that has it (7.2+); null otherwise. */
export function biometricManager(wa: TgWebApp | null = getWebApp()): TgBiometricManager | null {
  if (!wa || !isInTelegram(wa) || !supports(wa, '7.2')) return null;
  return wa.BiometricManager ?? null;
}

export function biometricLabel(kind: BiometricKind | undefined | null): string {
  return kind === 'face' ? 'Face ID' : kind === 'finger' ? 'Touch ID / fingerprint' : 'biometrics';
}

/** Initialises the manager once (Telegram loads its state asynchronously). */
export function initBiometrics(bm: TgBiometricManager): Promise<TgBiometricManager> {
  if (bm.isInited) return Promise.resolve(bm);
  return new Promise((resolve) => {
    try {
      bm.init(() => resolve(bm));
    } catch {
      resolve(bm);
    }
  });
}

function callback<T>(start: (done: (v: T) => void) => void, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    try {
      start(resolve);
    } catch {
      resolve(fallback);
    }
  });
}

export const requestBiometricAccess = (bm: TgBiometricManager, reason: string): Promise<boolean> =>
  bm.isAccessGranted ? Promise.resolve(true) : callback((done) => bm.requestAccess({ reason }, (granted) => done(Boolean(granted))), false);

/** Stores (or with '' removes) the device token in the BiometricManager. */
export const storeBiometricToken = (bm: TgBiometricManager, value: string): Promise<boolean> =>
  callback((done) => bm.updateBiometricToken(value, (updated) => done(Boolean(updated))), false);

export function encodeDeviceToken(deviceId: string, token: string): string {
  return `${PREFIX}.${deviceId}.${token}`;
}

export function decodeDeviceToken(value: string | null | undefined): { deviceId: string; token: string } | null {
  if (!value || !value.startsWith(`${PREFIX}.`)) return null;
  const rest = value.slice(PREFIX.length + 1);
  const dot = rest.indexOf('.');
  if (dot <= 0 || dot === rest.length - 1) return null;
  return { deviceId: rest.slice(0, dot), token: rest.slice(dot + 1) };
}

export type UnlockResult = { status: 'ok'; deviceId: string; token: string } | { status: 'cancelled' } | { status: 'invalid' };

/** Unlocks the stored device token with the device's biometrics (only after a successful Face ID / fingerprint). */
export async function unlockDeviceToken(bm: TgBiometricManager, reason: string): Promise<UnlockResult> {
  const r = await callback<{ ok: boolean; value: string | null }>((done) => bm.authenticate({ reason }, (ok, token) => done({ ok: Boolean(ok), value: token ?? null })), {
    ok: false,
    value: null,
  });
  if (!r.ok) return { status: 'cancelled' };
  const d = decodeDeviceToken(r.value);
  return d ? { status: 'ok', ...d } : { status: 'invalid' };
}

/** A short device name for the enrolment ("iPhone / iPad · Telegram"). */
export function deviceName(wa: TgWebApp | null = getWebApp()): string {
  const p = (wa?.platform ?? '').toLowerCase();
  const kind = p === 'ios' ? 'iPhone / iPad' : p === 'android' || p === 'android_x' ? 'Android' : p === 'macos' ? 'Mac' : p ? p : 'This device';
  return `${kind} · Telegram`;
}

/** Name of the device's biometrics (the V4.0 owner confirmation). */
export function biometricName(kind: BiometricKind | undefined | null): string {
  return kind === 'face' ? 'Face ID' : kind === 'finger' ? 'Touch ID' : t('confirm.bio.generic');
}

// After a rotation the host no longer accepts the old token; when the new one could not be stored, biometric
// confirmations are off for this Mini App session until the owner sets them up again (Settings → Security).
let stale = false;
export const biometricStale = (): boolean => stale;
export function markBiometricStale(v = true): void {
  stale = v;
}

// Which enrolled NEBULA device this Telegram holds (learnt from the last biometric unlock or enrolment). Not a secret;
// kept in memory only, so the confirmation knows whether this device already has the vault key.
let thisDevice: string | null = null;
export const rememberedDevice = (): string | null => thisDevice;
export function rememberDevice(id: string | null): void {
  thisDevice = id;
}
