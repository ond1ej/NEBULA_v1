// Dashboard client of Smart Authentication (routes_v321.py). Typed values, the submission token and the remote PIN travel
// only in POST / PUT bodies — never in a URL or query string — and are not kept by this module.
import { request } from '../../lib/http';
import type { AuthSession, SmartAuthClient, SmartAuthPinStatus, SmartAuthSettings, SmartAuthSettingsPatch, SubmitBody, SubmitToken, TrustConfig } from './core/types';

const enc = encodeURIComponent;

export interface SessionQuery {
  conversationId?: string;
  agentId?: string;
  taskId?: string;
  active?: boolean;
  limit?: number;
}

export const smartAuthApi = {
  sessions: (q: SessionQuery = {}, signal?: AbortSignal) =>
    request<AuthSession[]>('/smart-auth/sessions', {
      query: {
        conversation_id: q.conversationId,
        agent_id: q.agentId,
        task_id: q.taskId,
        active: q.active === undefined ? undefined : q.active ? 'true' : 'false',
        limit: q.limit,
      },
      signal,
    }),
  get: (id: string, signal?: AbortSignal) => request<AuthSession>(`/smart-auth/sessions/${enc(id)}`, { signal }),
  token: (id: string) => request<SubmitToken>(`/smart-auth/sessions/${enc(id)}/token`, { method: 'POST' }),
  submit: (id: string, body: SubmitBody) => request<AuthSession>(`/smart-auth/sessions/${enc(id)}/submit`, { method: 'POST', body }),
  cancel: (id: string) => request<AuthSession>(`/smart-auth/sessions/${enc(id)}/cancel`, { method: 'POST' }),

  // ---------------------------------------------------------------- owner settings (this Mac, or the owner's Mini App with step-up)
  settings: (signal?: AbortSignal) => request<SmartAuthSettings>('/smart-auth/settings', { signal }),
  updateSettings: (patch: SmartAuthSettingsPatch) => request<SmartAuthSettings>('/smart-auth/settings', { method: 'PUT', body: patch }),
  /** Set (no PIN yet) or change (needs the current PIN). */
  setPin: (pin: string, currentPin?: string) =>
    request<SmartAuthPinStatus>('/smart-auth/pin', { method: 'PUT', body: currentPin ? { pin, current_pin: currentPin } : { pin } }),
  clearPin: () => request<SmartAuthPinStatus>('/smart-auth/pin', { method: 'DELETE' }),

  // ---------------------------------------------------------------- trusted sign-in providers (exact https origins only)
  trust: (signal?: AbortSignal) => request<TrustConfig>('/smart-auth/trust', { signal }),
  addRelationship: (service: string, idp: string, firstParty = false) =>
    request<TrustConfig>('/smart-auth/trust/relationships', { method: 'POST', body: { service, idp, first_party: firstParty } }),
  removeRelationship: (service: string, idp: string) => request<TrustConfig>('/smart-auth/trust/relationships', { method: 'DELETE', query: { service, idp } }),
  verifySite: (origin: string) => request<TrustConfig>('/smart-auth/trust/sites', { method: 'POST', body: { origin } }),
  unverifySite: (origin: string) => request<TrustConfig>('/smart-auth/trust/sites', { method: 'DELETE', query: { origin } }),
};

/** The calls <SmartAuthRequest> needs (on this Mac the owner is always freshly confirmed: no ensureFresh). */
export const dashboardAuthClient: SmartAuthClient = {
  token: smartAuthApi.token,
  submit: smartAuthApi.submit,
  cancel: smartAuthApi.cancel,
  unlockVault: (passphrase: string) => request<unknown>('/vault/unlock', { method: 'POST', body: { passphrase } }),
};

// The Telegram Mini App's administration area reuses these pages on the phone: while it is shown it installs the owner's
// unified confirmation (V4.0) here, so the sign-in modal asks ONE confirmation instead of the remote PIN / passphrase.
let ownerConfirm: SmartAuthClient['confirmOwner'] | null = null;

export function setOwnerConfirmBridge(fn: SmartAuthClient['confirmOwner'] | null): () => void {
  ownerConfirm = fn;
  return () => {
    if (ownerConfirm === fn) ownerConfirm = null;
  };
}

/** The client of the sign-in modal right now (with the Mini App owner's confirmation while it is installed). */
export function currentAuthClient(): SmartAuthClient {
  return ownerConfirm ? { token: dashboardAuthClient.token, submit: dashboardAuthClient.submit, cancel: dashboardAuthClient.cancel, confirmOwner: ownerConfirm } : dashboardAuthClient;
}
