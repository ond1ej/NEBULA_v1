import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../api';
import { installFetch, ok } from '../test/fetchMock';
import type { Agent, MemoryEntry } from '../types';
import { MemoryManager, memoryPatch } from './MemoryManager';
import { ToastProvider } from './Toast';

const agent = { id: 'a1', name: 'Researcher', state: 'READY', permission_level: 'STANDARD', config: {} } as unknown as Agent;

const entry = (id: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id,
  agent_id: 'a1',
  key: `key ${id}`,
  value: `value ${id}`,
  source: 'agent',
  tags: '',
  updated_at: 1,
  kind: 'note',
  scope: 'private',
  shared_with: [],
  project: null,
  importance: 3,
  pinned: false,
  trust: 'agent',
  use_count: 0,
  created_at: 1,
  ...extra,
});

function routes(list: MemoryEntry[]) {
  return {
    'GET /api/v1/agents/a1/memory': () => ok(list),
    'GET /api/v1/agents/a1/memory/stats': () =>
      ok({ total: list.length, bytes: 10, oldest: 1, newest: 1, pinned: 0, shared: 0, quarantined: 0, by_kind: { note: 1, fact: 1 }, cap: 1000, auto_save: true, semantic: { enabled: false, model: null, fallback: 'FTS' } }),
    'GET /api/v1/memory/semantic': () => ok({ enabled: false, model: null, fallback: 'SQLite FTS5 (bm25)', configured: {}, model_installed: false }),
    'GET /api/v1/agents': () => ok([agent, { id: 'a2', name: 'Writer', state: 'READY' }]),
    'GET /api/v1/teams': () => ok([]),
    'DELETE /api/v1/agents/a1/memory/m1': () => ok({ deleted: 1 }),
    'DELETE /api/v1/agents/a1/memory': () => ok({ deleted: 1 }),
    'PATCH /api/v1/agents/a1/memory/m1': (c: { body: unknown }) => ok({ ...list[0], ...(c.body as object), trust: 'owner' }),
    'PATCH /api/v1/agents/a1/config': (c: { body: unknown }) => ok({ config: c.body }),
  };
}

function renderManager() {
  return render(
    <ToastProvider>
      <MemoryManager agent={agent} />
    </ToastProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

describe('memoryPatch', () => {
  it('sends only changed fields', () => {
    const e = entry('m1', { tags: 'a', shared_with: ['a2'], scope: 'shared' });
    expect(memoryPatch(e, { key: 'key m1', value: 'value m1', kind: 'note', tags: 'a', importance: 3, pinned: false, project: null, scope: 'shared', shared_with: ['a2'] })).toEqual({});
    expect(memoryPatch(e, { key: 'key m1', value: 'new', kind: 'fact', tags: 'a', importance: 5, pinned: true, project: 'P', scope: 'shared', shared_with: ['a2', 'team:t1'] })).toEqual({
      value: 'new',
      kind: 'fact',
      importance: 5,
      pinned: true,
      project: 'P',
      shared_with: ['a2', 'team:t1'],
    });
  });
});

describe('MemoryManager', () => {
  it('deletes an entry only after confirmation', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const { calls } = installFetch(routes([entry('m1')]));
    renderManager();
    expect(await screen.findByText('key m1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More actions for key m1' }));
    await user.click(await screen.findByRole('menuitem', { name: /Delete/ }));
    const dialog = await screen.findByRole('dialog');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Delete entry' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/agents/a1/memory/m1')).toBe(true));
  });

  it('pins with PATCH {pinned} and clears one kind with confirm=true', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const { calls } = installFetch(routes([entry('m1')]));
    renderManager();
    await screen.findByText('key m1');
    await user.click(screen.getByRole('button', { name: 'Pin entry' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH' && c.path.endsWith('/memory/m1'))?.body).toEqual({ pinned: true }));

    await user.click(screen.getByRole('button', { name: 'Bulk actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Clear entries/ }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('Which entries'), 'note');
    await user.click(within(dialog).getByRole('button', { name: 'Delete all note entries' }));
    await waitFor(() => {
      const del = calls.find((c) => c.method === 'DELETE' && c.path === '/api/v1/agents/a1/memory');
      expect(del?.url).toBe('/api/v1/agents/a1/memory?kind=note&confirm=true');
    });
  });

  it('toggles automatic memory through the agent config', async () => {
    setCsrfToken('c');
    const user = userEvent.setup();
    const { calls } = installFetch(routes([]));
    renderManager();
    const sw = await screen.findByRole('switch', { name: 'Automatic memory for Researcher' });
    await waitFor(() => expect(sw).toBeEnabled());
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await user.click(sw);
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH' && c.path === '/api/v1/agents/a1/config')?.body).toEqual({ memory_auto_save: false }));
  });
});
