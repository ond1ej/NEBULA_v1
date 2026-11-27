// Typed client for the V3 Telegram bot network (routes_v3.py "Telegram bot network" + notification levels).
// Bot tokens are only ever sent once (POST /bots); no endpoint returns them and the UI never keeps them.
import { request } from '../../api';
import type { Agent, Epoch } from '../../types';

const enc = encodeURIComponent;

export const NOTIFY_LEVELS = ['all', 'important', 'completion', 'errors', 'silent'] as const;
export type NotifyLevel = (typeof NOTIFY_LEVELS)[number];

export const NOTIFY_LABEL: Record<NotifyLevel, string> = {
  all: 'All updates',
  important: 'Important only',
  completion: 'Completion only',
  errors: 'Errors only',
  silent: 'Silent',
};

export const NOTIFY_HINT: Record<NotifyLevel, string> = {
  all: 'Progress, questions, approvals, results and failures',
  important: 'Questions, approvals, results and failures',
  completion: 'Approvals, results and failures',
  errors: 'Approvals and failures only',
  silent: 'Only approvals (delivered silently)',
};

export type BotStatus = 'ACTIVE' | 'DISABLED' | 'ERROR' | 'REVOKED' | string;
export type BotUserStatus = 'pending' | 'approved' | 'revoked' | string;

export interface MainBotUser {
  id: string;
  telegram_user_id: number;
  username: string | null;
  display_name: string | null;
  status: BotUserStatus;
  notify_level: NotifyLevel | string | null;
}

export interface MainBot {
  enabled: boolean | null;
  configured: boolean | null;
  polling: boolean | null;
  bot_username: string | null;
  bot_id: number | null;
  last_poll_at: Epoch | null;
  last_error: string | null;
  users: MainBotUser[];
}

export interface AgentBotUser {
  id: string;
  bot_row_id: string;
  telegram_user_id: number;
  chat_id: number;
  username: string | null;
  display_name: string | null;
  status: BotUserStatus;
  pairing_id: string | null;
  notify_level: NotifyLevel | string;
  approved_at: Epoch | null;
  created_at: Epoch;
}

export interface AgentBot {
  id: string;
  agent_id: string;
  agent_name: string | null;
  bot_id: number;
  username: string | null;
  display_name: string | null;
  enabled: boolean;
  status: BotStatus;
  update_offset: number;
  last_poll_at: Epoch | null;
  last_update_at: Epoch | null;
  last_error: string | null;
  created_at: Epoch;
  updated_at: Epoch;
  polling: boolean;
  token_stored: boolean;
  users: AgentBotUser[];
}

/** Result of configure(): one entry per Bot API call ("ok" | "failed: …"), plus the avatar note. */
export type BotMetadataResult = Record<string, string>;

export interface AddedBot extends AgentBot {
  metadata: BotMetadataResult;
}

export interface BotNetworkStatus {
  bots: number;
  polling: number;
  errors: number;
}

export interface BotNetwork {
  main: MainBot;
  agent_bots: AgentBot[];
  status: BotNetworkStatus;
}

export interface BotPairing {
  pairing_id: string;
  code: string;
  expires_at: Epoch;
  deep_link: string | null;
  instructions: string;
}

/** Same shape check as the host (multibot.TOKEN_RE); only used for a friendly hint before submitting. */
export const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;

export const botsApi = {
  list: (signal?: AbortSignal) => request<BotNetwork>('/bots', { signal }),
  get: (id: string) => request<AgentBot>(`/bots/${enc(id)}`),
  add: (agent_id: string, token: string, configure = true) =>
    request<AddedBot>('/bots', { method: 'POST', body: { agent_id, token, configure } }),
  pairing: (id: string) => request<BotPairing>(`/bots/${enc(id)}/pairing`, { method: 'POST' }),
  approveUser: (id: string, userRowId: string) => request<AgentBot>(`/bots/${enc(id)}/users/${enc(userRowId)}/approve`, { method: 'POST' }),
  revokeUser: (id: string, userRowId: string) => request<AgentBot>(`/bots/${enc(id)}/users/${enc(userRowId)}/revoke`, { method: 'POST' }),
  setEnabled: (id: string, enabled: boolean) => request<AgentBot>(`/bots/${enc(id)}/enabled`, { method: 'POST', body: { enabled } }),
  reconnect: (id: string) => request<AgentBot>(`/bots/${enc(id)}/reconnect`, { method: 'POST' }),
  configure: (id: string) => request<BotMetadataResult>(`/bots/${enc(id)}/configure`, { method: 'POST' }),
  /** Removes the binding (the bot keeps existing in Telegram). Call only after the user confirmed. */
  remove: (id: string) => request<{ removed: string; note: string }>(`/bots/${enc(id)}`, { method: 'DELETE', query: { confirm: true } }),
  setNotifyLevel: (userRowId: string, level: NotifyLevel) =>
    request<{ id: string; notify_level: NotifyLevel }>(`/telegram/users/${enc(userRowId)}/notify`, { method: 'PATCH', body: { level } }),
  agents: (signal?: AbortSignal) => request<Agent[]>('/agents', { signal }),
};

export function isNotifyLevel(v: unknown): v is NotifyLevel {
  return typeof v === 'string' && (NOTIFY_LEVELS as readonly string[]).includes(v);
}

export function userLabel(u: { display_name: string | null; username: string | null; telegram_user_id: number }): string {
  return u.display_name || (u.username ? `@${u.username}` : `Telegram user ${u.telegram_user_id}`);
}
