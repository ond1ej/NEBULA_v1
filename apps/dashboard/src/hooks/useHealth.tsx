import { createContext, useContext, type ReactNode } from 'react';
import { api } from '../api';
import type { Health } from '../types';
import { useApi } from './useApi';
import { useLiveRefresh } from './useEvents';

interface HealthCtx {
  health: Health | null;
  error: unknown;
  reload: () => void;
}

const Ctx = createContext<HealthCtx>({ health: null, error: null, reload: () => {} });

/**
 * GET /api/v1/health: refreshed on VM / provider / health events; polled every 60 s as a safety net while the event
 * stream is connected, every 15 s while it is not (and never in a hidden tab).
 */
export function HealthProvider({ children }: { children: ReactNode }) {
  const { data, error, reload } = useApi(() => api.health(), [], { pollMs: 15_000, livePollMs: 60_000 });
  useLiveRefresh(reload, (ev) => ev.type === 'vm.state.changed' || ev.type === 'system.health' || ev.type.startsWith('provider.'), 500);
  return <Ctx.Provider value={{ health: data, error, reload }}>{children}</Ctx.Provider>;
}

export function useHealth(): HealthCtx {
  return useContext(Ctx);
}
