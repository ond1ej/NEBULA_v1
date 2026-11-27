import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../../api';
import { ToastProvider } from '../../components/Toast';
import { installFetch, ok } from '../../test/fetchMock';
import { HostAccess } from './HostAccess';
import { pathCrumbs } from './FolderPicker';
import type { HostRoot } from '../environment/types';

beforeEach(() => setCsrfToken('csrf'));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

const existing: HostRoot = { id: 'r1', name: 'Website', path: '/Users/me/Projects/Website', mode: 'read_write', allow_network: true, allowed_tools: [], enabled: true, exists: true, created_by: 'owner', created_at: 1, updated_at: 1 };
const tools = {
  tools: {
    git: { available: true, path: '/usr/bin/git', version: 'git version 2.50.1' },
    node: { available: true, path: '/opt/homebrew/bin/node', version: 'v22.1.0' },
    flutter: { available: false, path: null, version: null, note: 'SDK cache is read-only in the sandbox' },
  },
  sandbox: true,
  gui_control: {
    available: false,
    accessibility: 'not_requested',
    screen_recording: 'not_requested',
    detail: 'Host GUI control (mouse/keyboard/screen of macOS) is not part of NEBULA V3.',
  },
};
const command = { id: 7, ts: 1_700_000_000, agent_id: 'a1', task_id: 't1', root_id: 'r1', tool: 'shell.execute', command: 'npm test', cwd: '.', status: 'error', exit_code: 1, duration_ms: 1500, detail: null };

describe('pathCrumbs', () => {
  it('splits an absolute path into navigable crumbs', () => {
    expect(pathCrumbs('/Users/me/App')).toEqual([
      { label: 'Users', path: '/Users' },
      { label: 'me', path: '/Users/me' },
      { label: 'App', path: '/Users/me/App' },
    ]);
  });
});

describe('Host Access page', () => {
  it('lists folders, tools, the GUI-control notice and the command log; authorises a folder via the picker; revokes only after confirmation', async () => {
    const user = userEvent.setup();
    let rootList: HostRoot[] = [existing];
    const { calls } = installFetch({
      'GET /api/v1/host/roots': () => ok(rootList),
      'GET /api/v1/host/tools': () => ok(tools),
      'GET /api/v1/host/commands': () => ok([command]),
      'GET /api/v1/agents': () => ok([{ id: 'a1', name: 'Ada' }]),
      'GET /api/v1/host/browse': (c) =>
        ok(
          c.url.includes('path=')
            ? {
                path: '/Users/me/Projects',
                parent: '/Users/me',
                dirs: [
                  { name: 'App', path: '/Users/me/Projects/App', authorisable: true, reason: null, git: true, project_markers: ['package.json'] },
                  { name: 'Website', path: '/Users/me/Projects/Website', authorisable: true, reason: null, git: false, project_markers: [] },
                ],
              }
            : {
                path: '/Users/me',
                parent: null,
                dirs: [
                  { name: 'Projects', path: '/Users/me/Projects', authorisable: true, reason: null, git: false, project_markers: [] },
                  { name: 'Documents', path: '/Users/me/Documents', authorisable: false, reason: '/Users/me/Documents contains the protected location', git: false, project_markers: [] },
                ],
              },
        ),
      'POST /api/v1/host/roots': (c) => {
        const b = c.body as { path: string; name: string; mode: string; allow_network: boolean; allowed_tools: string[] };
        const r = { ...existing, id: 'r2', ...b, enabled: true };
        rootList = [...rootList, { ...r, exists: true }];
        return ok(r, 201);
      },
      'DELETE /api/v1/host/roots/r1': () => {
        rootList = rootList.filter((r) => r.id !== 'r1');
        return ok({ revoked: 'r1', projects_unlinked: ['Mobile app'] });
      },
    });
    render(
      <ToastProvider>
        <HostAccess />
      </ToastProvider>,
    );

    const table = await screen.findByRole('table', { name: 'Authorised project folders' });
    expect(within(table).getByText('/Users/me/Projects/Website')).toBeInTheDocument();
    expect(within(table).getByText('All detected tools')).toBeInTheDocument();
    expect(screen.getByText('Host GUI control is not available')).toBeInTheDocument();
    expect(screen.getByText(/is not part of NEBULA V3/)).toBeInTheDocument();
    const toolList = await screen.findByRole('list', { name: 'Developer tools' });
    expect(within(toolList).getByText('git version 2.50.1')).toBeInTheDocument();
    expect(within(toolList).getByText('not installed')).toBeInTheDocument();
    expect(within(toolList).getByText('SDK cache is read-only in the sandbox')).toBeInTheDocument();
    const log = await screen.findByRole('table', { name: 'Host command log' });
    expect(within(log).getByText('npm test')).toBeInTheDocument();
    expect(within(log).getByText(/error · exit 1/).closest('[class*="text-danger"]')).not.toBeNull();
    expect(within(log).getByRole('link', { name: 'Ada' })).toHaveAttribute('href', '#/agents/a1/tasks?task=t1');

    // command log filter
    await user.selectOptions(screen.getByLabelText('Agent'), 'a1');
    await waitFor(() => expect(calls.some((c) => c.path === '/api/v1/host/commands' && c.url.includes('agent_id=a1'))).toBe(true));

    // ---- authorise a folder through the directory picker
    await user.click(screen.getByRole('button', { name: 'Authorise folder' }));
    const picker = await screen.findByRole('dialog', { name: 'Choose a project folder' });
    expect(await within(picker).findByRole('button', { name: /^Choose Documents/ })).toBeDisabled();
    expect(within(picker).getByText('/Users/me/Documents contains the protected location')).toBeInTheDocument();
    await user.click(within(picker).getByRole('button', { name: 'Open Projects' }));
    expect(await within(picker).findByRole('button', { name: /^Choose Website.*Already authorised/ })).toBeDisabled();
    expect(within(picker).getByText('package.json')).toBeInTheDocument();
    await user.click(within(picker).getByRole('button', { name: 'Choose App' }));

    const form = await screen.findByRole('dialog', { name: 'Authorise this folder' });
    expect(within(form).getByText('/Users/me/Projects/App')).toBeInTheDocument();
    await user.click(within(form).getByRole('radio', { name: 'Read only' }));
    // network is off by default for a new folder (VM-03); left off here
    expect(within(form).getByRole('switch', { name: 'Network access' })).toHaveAttribute('aria-checked', 'false');
    await user.click(within(form).getByRole('checkbox', { name: 'git' }));
    await user.click(within(form).getByRole('button', { name: 'Authorise folder' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/v1/host/roots')).toBe(true));
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/v1/host/roots');
    expect(post?.body).toEqual({ path: '/Users/me/Projects/App', name: 'App', mode: 'read_only', allow_network: false, allowed_tools: ['git'] });
    expect(await within(table).findByText('/Users/me/Projects/App')).toBeInTheDocument();

    // ---- revoke: confirmation first, never deletes files
    await user.click(within(table).getByRole('button', { name: 'Revoke access to Website' }));
    const confirm = await screen.findByRole('dialog', { name: 'Revoke access to Website?' });
    expect(within(confirm).getByText('The folder and its files are never deleted.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(within(confirm).getByRole('button', { name: 'Revoke access' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/host/roots/r1')).toBe(true));
    expect(calls.find((c) => c.method === 'DELETE')?.url).toContain('confirm=true');
    await waitFor(() => expect(within(table).queryByText('/Users/me/Projects/Website')).not.toBeInTheDocument());
    expect(await screen.findByText(/Projects unlinked: Mobile app/)).toBeInTheDocument();
  });
});
