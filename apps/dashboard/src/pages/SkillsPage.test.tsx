import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../api';
import { ToastProvider } from '../components/Toast';
import { installFetch, ok } from '../test/fetchMock';
import { SkillsPage, skillTools } from './SkillsPage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

const skill = { id: 'browser', name: 'Browser', version: '1.0.0', description: 'Visible Chromium', kind: 'builtin', manifest: { tools: ['browser_open'], permissions: { min_level: 'STANDARD', levels: { browser_open: 'STANDARD' } } }, enabled: true, checksum: null, installed_at: 1, updated_at: 1, assigned_agents: 1, usage_count: 3 };

describe('skillTools', () => {
  it('reads built-in (names) and plugin (objects) manifests', () => {
    expect(skillTools(skill)).toEqual([{ name: 'browser_open', level: 'STANDARD' }]);
    expect(skillTools({ manifest: { tools: [{ name: 'extract', description: 'd' }], permissions: { min_level: 'ADVANCED' } } })).toEqual([{ name: 'extract', description: 'd', level: 'ADVANCED' }]);
  });
});

describe('SkillsPage', () => {
  it('uploads a plugin archive as the raw request body after confirmation', async () => {
    setCsrfToken('csrf-p');
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/agents': () => ok([]),
      'GET /api/v1/skills': () => ok([skill]),
      'POST /api/v1/skills/plugins': () => ok({ ...skill, id: 'acme', name: 'Acme', kind: 'plugin', version: '0.1.0' }, 201),
    });
    render(
      <ToastProvider>
        <SkillsPage query={new URLSearchParams()} />
      </ToastProvider>,
    );
    expect(await screen.findByText('Visible Chromium')).toBeInTheDocument();
    const file = new File([new Uint8Array([80, 75, 3, 4])], 'acme.zip', { type: 'application/zip' });
    await user.upload(screen.getByLabelText('Plugin archive (.zip)'), file);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('acme.zip')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Install plugin' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.path).toBe('/api/v1/skills/plugins');
    expect(post.headers['content-type']).toBe('application/zip');
    expect(post.headers['x-csrf-token']).toBe('csrf-p');
    expect(post.init.body).toBe(file);
  });

  it('renders the permission matrix as a table', async () => {
    installFetch({
      'GET /api/v1/agents': () => ok([]),
      'GET /api/v1/permissions/matrix': () =>
        ok({
          levels: ['READ_ONLY', 'STANDARD', 'ADVANCED'],
          tools: [{ tool: 'shell_run', description: 'Run a command', min_level: 'ADVANCED', levels: { READ_ONLY: false, STANDARD: false, ADVANCED: true }, skills: ['terminal'], gui: false, side_effect: true, always_approve: false, approval_when: 'package installs' }],
          level_permissions: { READ_ONLY: [], STANDARD: [], ADVANCED: ['shell_standard'] },
          rules: ['ADVANCED never bypasses approvals.'],
        }),
    });
    render(
      <ToastProvider>
        <SkillsPage query={new URLSearchParams('tab=permissions')} />
      </ToastProvider>,
    );
    const table = await screen.findByRole('table', { name: 'Permission matrix' });
    expect(within(table).getByText('shell_run')).toBeInTheDocument();
    expect(within(table).getAllByRole('img', { name: 'Not allowed' })).toHaveLength(2);
    expect(within(table).getByRole('img', { name: 'Allowed' })).toBeInTheDocument();
    expect(screen.getByText('ADVANCED never bypasses approvals.')).toBeInTheDocument();
  });
});
