import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../../api';
import { ToastProvider } from '../../components/Toast';
import { Avatar } from '../../components/ui';
import { installFetch, ok } from '../../test/fetchMock';
import { MiniSettingsCard } from './MiniSettingsCard';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

const s = {
  agent: { id: 'a1', name: 'Researcher' },
  name: 'Researcher',
  description: '',
  avatar: null,
  provider_id: 'p',
  model_id: 'm',
  instructions: 'Be brief.',
  permission_level: 'STANDARD',
  capabilities: { browser: true, web_research: true, files: true, terminal: false, desktop: false, memory: true },
  extra_skills: [],
  vault_access: 'none',
  vault: { mode: 'NONE', grants: [] },
  environment: { env: 'vm', root_id: null, source: 'agent' },
  status: 'READY',
  resource_mode: 'ACTIVE',
  idle_sleep_minutes: null,
  desktop_resolution: '1280x800',
  ready: true,
};

describe('Dashboard: Instructions & Mini App settings card', () => {
  it('edits instructions, avatar and Smart sign-in through the composer endpoint, sending only changes', async () => {
    setCsrfToken('csrf-d');
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const { calls } = installFetch({
      'GET /api/v1/miniapp/agents/a1/settings': () => ok(s),
      'PATCH /api/v1/miniapp/agents/a1/settings': (c) => ok({ ...s, ...(c.body as object) }),
    });
    render(
      <ToastProvider>
        <MiniSettingsCard agentId="a1" name="Researcher" onChanged={onChanged} />
      </ToastProvider>,
    );
    const instr = await screen.findByLabelText('System instructions');
    expect(instr).toHaveValue('Be brief.');
    expect(screen.getByRole('button', { name: /^Save/ })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Avatar'), 'icon');
    await user.selectOptions(screen.getByLabelText('Icon'), 'brain');
    await user.selectOptions(screen.getByLabelText('Smart sign-in (Password Vault access)'), 'ask');
    expect(document.querySelector('svg[data-avatar-icon="brain"]')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: /^Save/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toEqual({ avatar: { kind: 'icon', value: 'brain' }, vault_access: 'ask' });
    expect(patch?.headers['x-csrf-token']).toBe('csrf-d');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('the Dashboard avatar renders emoji, initials and icons', () => {
    const { container } = render(
      <>
        <Avatar name="Fox" avatar={{ kind: 'emoji', value: '🦊' }} />
        <Avatar name="Quiz" avatar={{ kind: 'initials', value: 'qz' }} />
        <Avatar name="Robo" avatar={{ kind: 'icon', value: 'robot' }} />
        <Avatar name="Plain Name" />
      </>,
    );
    const spans = [...container.querySelectorAll('[data-avatar]')];
    expect(spans.map((x) => x.getAttribute('data-avatar'))).toEqual(['emoji', 'initials', 'icon', 'name']);
    expect(spans[0]).toHaveTextContent('🦊');
    expect(spans[1]).toHaveTextContent('QZ');
    expect(spans[2].querySelector('svg[data-avatar-icon="robot"]')).not.toBeNull();
    expect(spans[3]).toHaveTextContent('PN');
  });
});
