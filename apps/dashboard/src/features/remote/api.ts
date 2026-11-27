// Typed client for remote access / the Telegram Mini App gateway (routes_v3.py "remote access / Mini App", remote.py).
import { request } from '../../api';
import type { Epoch } from '../../types';

const enc = encodeURIComponent;

/** `tailscale_serve`: private, tailnet-only (recommended). `tailscale_funnel` and `cloudflared_quick`: public Internet. */
export type TunnelKind = 'none' | 'tailscale_serve' | 'tailscale_funnel' | 'cloudflared_quick' | 'custom';

/** Tunnels that make the gateway reachable from the public Internet (everything else stays inside the tailnet / your own proxy). */
export const PUBLIC_TUNNELS: ReadonlySet<string> = new Set(['tailscale_funnel', 'cloudflared_quick']);

export interface MiniAppSession {
  id: string;
  created_at: Epoch;
  expires_at: Epoch;
  last_seen_at: Epoch | null;
  active: boolean;
  telegram_user_id: string | null;
  bot: string | null;
}

export interface GatewayStats {
  requests: number;
  denied: number;
  rate_limited: number;
}

export interface RemoteStatus {
  enabled: boolean;
  port: number;
  public_url: string | null;
  tunnel: TunnelKind | string;
  rate_limit_per_min: number;
  listening: boolean;
  local_url: string;
  public_mini_url: string | null;
  last_error: string | null;
  tools: { tailscale?: boolean; cloudflared?: boolean; [k: string]: boolean | undefined };
  tunnel_running: boolean;
  stats: GatewayStats | null;
  sessions: MiniAppSession[];
  setup_required: string | null;
}

export interface RemotePatch {
  enabled?: boolean;
  port?: number;
  public_url?: string | null;
  tunnel?: TunnelKind;
  rate_limit_per_min?: number;
}

/** Same rule as remote.configure(): an https origin without a path. */
export const PUBLIC_URL_RE = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/;

export const remoteApi = {
  status: (signal?: AbortSignal) => request<RemoteStatus>('/remote', { signal }),
  configure: (body: RemotePatch) => request<RemoteStatus>('/remote', { method: 'PATCH', body }),
  /** Starts a tunnel to the gateway. The public kinds (Funnel, Cloudflare) publish it on the Internet: call only after the explicit confirmation dialog. */
  startTunnel: (kind: Exclude<TunnelKind, 'none' | 'custom'>) => request<RemoteStatus>('/remote/tunnel/start', { method: 'POST', body: { kind, confirm: true } }),
  stopTunnel: () => request<RemoteStatus>('/remote/tunnel/stop', { method: 'POST' }),
  menuButtons: () => request<Record<string, string>>('/remote/menu-buttons', { method: 'POST' }),
  sessions: (signal?: AbortSignal) => request<MiniAppSession[]>('/miniapp/sessions', { signal }),
  revokeSession: (id: string) => request<{ revoked: number }>(`/miniapp/sessions/${enc(id)}`, { method: 'DELETE' }),
  revokeAll: () => request<{ revoked: number }>('/miniapp/sessions', { method: 'DELETE' }),
};
