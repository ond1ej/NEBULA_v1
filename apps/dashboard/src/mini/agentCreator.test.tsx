// V3.2.2 Mini App agent creator and agent settings: permission gating, lazy loading (no request before the creator
// opens, models only after a provider is chosen), validation, the exact POST body and its Idempotency-Key (reused for
// retries, new after a definitive rejection), host errors, the success state, settings PATCH diffs, avatars.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, ok, type RecordedCall } from '../test/fetchMock';
import type { Agent } from '../types';
import type { AgentComposerSettings, AgentOptions, ModelChoice } from './agentConfig/types';
import { clearQueryCache } from './hooks';
import { agent, baseRoutes, installMemoryStorage, mount, PERMS, resetStream, session, telegram } from './test/kit';

vi.mock('@novnc/novnc', () => ({ default: class {} }));

const ICONS = ['robot', 'spark', 'brain', 'code', 'search', 'chart', 'briefcase', 'globe', 'shield', 'book', 'bolt', 'star', 'mail', 'calendar', 'music', 'camera'];

const OPTIONS: AgentOptions = {
  providers: [
    { id: 'anthropic-api', name: 'Anthropic', state: 'Connected (API Billing)', connected: true, reason: null },
    { id: 'openai', name: 'OpenAI', state: 'Not connected', connected: false, reason: 'Not connected — connect it on your Mac (Settings → AI providers)' },
  ],
  environments: [
    { id: 'vm', label: 'Ubuntu VM', available: true, default: true, description: 'Its own isolated Linux user, desktop and browser.' },
    { id: 'host', label: 'macOS host', available: false, default: false, description: 'Native execution in a folder you authorised.', reason: 'Native Mac execution can only be enabled on the Mac itself.', authorised_folders: 1 },
  ],
  capabilities: [
    { id: 'browser', label: 'Browser', description: 'Visible Chromium in its own desktop.', default: true, requires_level: 'STANDARD' },
    { id: 'web_research', label: 'Web research', description: 'Web search plus page reading.', default: true, requires_level: 'STANDARD' },
    { id: 'files', label: 'Files', description: 'Its own workspace.', default: true, requires_level: 'STANDARD' },
    { id: 'terminal', label: 'Terminal', description: 'Shell commands in the VM. Needs the Advanced level.', default: false, requires_level: 'ADVANCED' },
    { id: 'desktop', label: 'Desktop control', description: 'Mouse and keyboard on its VM desktop.', default: false, requires_level: 'STANDARD' },
  ],
  memory: { default: true, description: 'Remember useful facts between tasks.' },
  extra_skills: [
    { id: 'pdf', name: 'PDF tools', description: 'Read and fill PDFs', kind: 'builtin', requires_level: 'STANDARD' },
    { id: 'python', name: 'Python', description: 'Run Python', kind: 'builtin', requires_level: 'ADVANCED' },
  ],
  levels: [
    { id: 'READ_ONLY', description: 'Can read pages and files, cannot change anything.' },
    { id: 'STANDARD', description: 'Browser, desktop and its own files. No terminal.' },
    { id: 'ADVANCED', description: 'Everything in Standard plus terminal.' },
  ],
  default_level: 'STANDARD',
  vault: {
    options: [
      { id: 'none', label: 'No access', description: 'The agent cannot sign in anywhere with your help.', default: true },
      { id: 'ask', label: 'Ask me when a sign-in is needed', description: 'Smart sign-in: you answer in a secure form.' },
    ],
    granted_note: 'Using credentials saved in the Password Vault needs a grant you create on your Mac.',
  },
  approvals: { sensitive_actions_need_approval: true, always: ['payments', 'account deletion'], note: 'Approvals are the same for every agent and cannot be weakened here.' },
  advanced: { resource_modes: ['ACTIVE', 'SLEEP'], resolutions: ['1024x768', '1280x800', '1920x1080'], default_resolution: '1280x800', idle_sleep_minutes: { min: 0, max: 1440, default: null }, not_here: 'Maximum steps, model calls and time-outs are set per task.' },
  avatar: { kinds: ['emoji', 'initials', 'icon'], icons: ICONS },
  name_rules: { max: 64, pattern: 'letters, digits, spaces and . - _ ( )' },
  existing_names: ['Researcher'],
  default_instructions: 'Be concise and accurate. Ask me before doing anything irreversible.',
  limits: { instructions_max: 4000, description_max: 1000 },
};

const MODELS: ModelChoice[] = [
  { id: 'claude-x', name: 'Claude X', supports_tools: true, supports_images: true, context_tokens: 200_000 },
  { id: 'claude-y', name: 'Claude Y', supports_tools: true, supports_images: false, context_tokens: 100_000 },
  { id: 'tiny', name: 'Tiny', supports_tools: false, supports_images: false, context_tokens: 8_000 },
];

function settings(over: Partial<AgentComposerSettings> = {}): AgentComposerSettings {
  const base: AgentComposerSettings = {
    agent: { ...agent, id: 'a9', name: 'Scout', config: { avatar: { kind: 'emoji', value: '🤖' } } },
    name: 'Scout',
    description: '',
    avatar: { kind: 'emoji', value: '🤖' },
    provider_id: 'anthropic-api',
    model_id: 'claude-x',
    instructions: '',
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
  return { ...base, ...over };
}

const OWNER = [...PERMS, 'agents'];

type Handler = (c: RecordedCall) => Response | Promise<Response>;

function routes(perms: string[], extra: Record<string, Handler> = {}): Record<string, Handler> {
  return baseRoutes({
    'POST /api/mini/auth': () => ok({ ...session, permissions: perms }),
    'GET /api/v1/miniapp/me': () => ok({ session_id: 's1', telegram_user_id: 42, bot: 'main', permissions: perms, expires_in: 3600 }),
    'GET /api/v1/agents': () => ok([agent]),
    'GET /api/v1/miniapp/agent-options': () => ok(OPTIONS),
    'GET /api/v1/miniapp/agent-options/models': () => ok(MODELS),
    ...extra,
  });
}

const count = (calls: RecordedCall[], method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).length;
const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)));

/** Opens the creator from the Agents list (+ button) and waits for the form. */
async function openCreator(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'New agent' }));
  await screen.findByRole('textbox', { name: 'Name' });
  return screen.getByRole('dialog', { name: 'Create Agent' });
}

/** Fills the three required fields: name, provider (loads its models), model. */
async function fillRequired(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, name = 'Scout') {
  await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), name);
  await user.click(within(dialog).getByRole('radio', { name: /Anthropic/ }));
  const model = await within(dialog).findByRole('combobox', { name: 'Model' });
  await user.selectOptions(model, 'claude-x');
}

const EXPECTED_BODY = {
  name: 'Scout',
  provider_id: 'anthropic-api',
  model_id: 'claude-x',
  environment: 'vm',
  capabilities: { browser: true, web_research: true, files: true, terminal: false, desktop: false, memory: true },
  extra_skills: [],
  vault_access: 'none',
  permission_level: 'STANDARD',
  resource_mode: 'ACTIVE',
  desktop_resolution: '1280x800',
};

describe('Mini App agent creator', () => {
  beforeEach(() => {
    sessionStorage.clear();
    installMemoryStorage();
    clearQueryCache();
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.Telegram;
    window.history.replaceState(null, '', '/');
    resetStream();
  });

  it('shows the + button only with the `agents` permission; without it the old empty-state text stays', async () => {
    const owner = mount('#/agents', routes(OWNER, { 'GET /api/v1/agents': () => ok([]) }));
    expect(await screen.findByRole('button', { name: 'New agent' })).toBeInTheDocument();
    // empty list: a "New agent" button in the empty state too
    expect(await screen.findByText('Create your first AI agent: its own desktop and browser in the Ubuntu VM.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /New agent/ })).toHaveLength(2);
    expect(owner.calls.some((c) => c.path.startsWith('/api/v1/miniapp/agent'))).toBe(false);
    owner.view.unmount();
    clearQueryCache();
    sessionStorage.clear();

    mount('#/agents', routes(PERMS, { 'GET /api/v1/agents': () => ok([]) }));
    expect(await screen.findByText('Create agents in the NEBULA Dashboard on your Mac mini.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New agent/ })).toBeNull();
  });

  it('opens lazily from the + button (#/agents/new) and fetches the options exactly once; models only after a provider is chosen', async () => {
    const user = userEvent.setup();
    const { calls } = mount('#/agents', routes(OWNER));
    await screen.findByRole('link', { name: /Researcher/ });
    await settle();
    expect(calls.some((c) => c.path.startsWith('/api/v1/miniapp/agent'))).toBe(false);

    const dialog = await openCreator(user);
    expect(window.location.hash).toBe('#/agents/new');
    expect(within(dialog).getByText('Configure your new AI assistant.')).toBeInTheDocument();
    await settle();
    expect(count(calls, 'GET', '/api/v1/miniapp/agent-options')).toBe(1);
    expect(count(calls, 'GET', '/api/v1/miniapp/agent-options/models')).toBe(0);

    // the disconnected provider is disabled and says why; the macOS host is disabled with its reason
    const openai = within(dialog).getByRole('radio', { name: /OpenAI/ });
    expect(openai).toBeDisabled();
    expect(within(dialog).getByText('Not connected — connect it on your Mac (Settings → AI providers)')).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: /macOS host/ })).toBeDisabled();
    expect(within(dialog).getByText('Native Mac execution can only be enabled on the Mac itself.')).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: /Ubuntu VM/ })).toHaveAttribute('aria-checked', 'true');
    expect(within(dialog).getByRole('combobox', { name: 'Model' })).toBeDisabled();

    await user.click(within(dialog).getByRole('radio', { name: /Anthropic/ }));
    const model = await within(dialog).findByRole('combobox', { name: 'Model' });
    await waitFor(() => expect(model).toBeEnabled());
    expect(calls.filter((c) => c.path === '/api/v1/miniapp/agent-options/models').map((c) => c.url)).toEqual(['/api/v1/miniapp/agent-options/models?provider_id=anthropic-api']);
    // a model without tools is disabled and explained
    const tiny = within(model).getByRole('option', { name: 'Tiny — This model cannot use tools' });
    expect(tiny).toBeDisabled();
    expect(within(model).getByRole('option', { name: 'Claude X' })).toBeEnabled();
    expect(within(dialog).getByText('Greyed-out models cannot use tools, so they cannot work as agents.')).toBeInTheDocument();
    // choosing the same provider again does not refetch (cached per provider while the form is open)
    await user.click(within(dialog).getByRole('radio', { name: /Anthropic/ }));
    expect(count(calls, 'GET', '/api/v1/miniapp/agent-options/models')).toBe(1);
  });

  it('validates the required fields (name, provider, model) inline and with a summary, without any POST', async () => {
    const user = userEvent.setup();
    const { calls } = mount('#/agents', routes(OWNER));
    const dialog = await openCreator(user);
    await user.click(within(dialog).getByRole('button', { name: 'Create Agent' }));
    const summary = await within(dialog).findByTestId('form-summary');
    expect(summary).toHaveTextContent('Check 3 fields');
    expect(summary).toHaveTextContent('Name, AI provider, Model');
    expect(within(dialog).getByText('Enter a name')).toBeInTheDocument();
    expect(within(dialog).getByText('Choose an AI provider')).toBeInTheDocument();
    expect(within(dialog).getByText('Choose a model')).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toHaveAttribute('aria-invalid', 'true');
    // a name with characters the host refuses
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Scout <x>');
    expect(within(dialog).getByText('Use letters, digits, spaces and . - _ ( ) only')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/v1/miniapp/agents')).toBe(false);
  });

  it('submits exactly the expected body once with an Idempotency-Key, disables the button while creating, then shows the success state', async () => {
    const user = userEvent.setup();
    let release: (r: Response) => void = () => {};
    const { calls } = mount(
      '#/agents',
      routes(OWNER, {
        'POST /api/v1/miniapp/agents': () => new Promise<Response>((r) => (release = r)),
        'GET /api/v1/agents/a9/conversation': () => apiError(404, 'not_found', 'no'),
      }),
    );
    const dialog = await openCreator(user);
    await fillRequired(user, dialog);
    await user.click(within(dialog).getByRole('tab', { name: 'Emoji' }));
    await user.click(within(dialog).getByRole('button', { name: 'Emoji 🤖' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create Agent' }));

    expect(await within(dialog).findByText(/Creating the agent's desktop in the VM…/)).toBeInTheDocument();
    const busy = within(dialog).getByRole('button', { name: /Creating…/ });
    expect(busy).toBeDisabled();
    await user.click(busy);
    fireEvent.click(busy);
    const posts = calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/miniapp/agents');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ ...EXPECTED_BODY, avatar: { kind: 'emoji', value: '🤖' } });
    expect(posts[0].headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(posts[0].headers.authorization).toBe('Bearer tok-1');

    await act(async () => release(ok(settings(), 201)));
    expect(await screen.findByRole('dialog', { name: 'Agent created' })).toBeInTheDocument();
    expect(screen.getByText('Scout is ready.')).toBeInTheDocument();
    const openChat = screen.getByRole('button', { name: 'Open Chat' });
    await waitFor(() => expect(openChat).toHaveFocus());
    expect(screen.getByRole('button', { name: 'Agent Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to Agents' })).toBeInTheDocument();
    // the Agents list is refreshed
    await waitFor(() => expect(count(calls, 'GET', '/api/v1/agents')).toBeGreaterThanOrEqual(2));

    await user.click(openChat);
    expect(window.location.hash).toBe('#/agents/a9');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Agent created' })).toBeNull());
  });

  it('says "ready and asleep" when the agent starts asleep', async () => {
    const user = userEvent.setup();
    mount('#/agents', routes(OWNER, { 'POST /api/v1/miniapp/agents': () => ok(settings({ status: 'SLEEP', resource_mode: 'SLEEP' }), 201) }));
    const dialog = await openCreator(user);
    await fillRequired(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Create Agent' }));
    expect(await screen.findByText('Scout is ready and asleep — it wakes when you send a task.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Agent Settings' }));
    expect(window.location.hash).toBe('#/agents/a9/settings');
  });

  it('a retry after a lost connection reuses the same Idempotency-Key (never a second agent)', async () => {
    const user = userEvent.setup();
    let n = 0;
    const { calls } = mount(
      '#/agents',
      routes(OWNER, {
        'POST /api/v1/miniapp/agents': () => {
          n += 1;
          if (n === 1) throw new TypeError('Failed to fetch');
          return ok(settings(), 201);
        },
      }),
    );
    const dialog = await openCreator(user);
    await fillRequired(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Create Agent' }));
    const problem = await within(dialog).findByTestId('create-problem');
    expect(problem).toHaveTextContent('Connection lost — check whether the agent was created before retrying.');
    await user.click(within(problem).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Scout is ready.')).toBeInTheDocument();
    const keys = calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/miniapp/agents').map((c) => c.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('warns about a duplicate name, and on 409 asks before resending with allow_duplicate_name and a NEW key', async () => {
    const user = userEvent.setup();
    let n = 0;
    const { calls } = mount(
      '#/agents',
      routes(OWNER, {
        'POST /api/v1/miniapp/agents': () => {
          n += 1;
          return n === 1 ? apiError(409, 'duplicate_name', 'an agent named researcher already exists') : ok(settings({ name: 'researcher' }), 201);
        },
      }),
    );
    const dialog = await openCreator(user);
    await fillRequired(user, dialog, 'researcher');
    expect(within(dialog).getByText('An agent named “Researcher” already exists. You can still use this name.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Create Agent' }));
    const confirm = await screen.findByRole('dialog', { name: 'An agent named “researcher” already exists' });
    expect(within(confirm).getByText(/Create anyway\?/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Create anyway' }));
    expect(await screen.findByText('researcher is ready.')).toBeInTheDocument();
    const posts = calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/miniapp/agents');
    expect(posts).toHaveLength(2);
    expect((posts[0].body as Record<string, unknown>).allow_duplicate_name).toBeUndefined();
    expect((posts[1].body as Record<string, unknown>).allow_duplicate_name).toBe(true);
    expect(posts[1].headers['idempotency-key']).not.toBe(posts[0].headers['idempotency-key']);
  });

  it('switching Terminal on raises the permission level to Advanced; lowering the level turns it off again', async () => {
    const user = userEvent.setup();
    const { calls } = mount('#/agents', routes(OWNER, { 'POST /api/v1/miniapp/agents': () => ok(settings(), 201) }));
    const dialog = await openCreator(user);
    await fillRequired(user, dialog);
    const terminal = within(dialog).getByRole('switch', { name: 'Terminal' });
    expect(terminal).toHaveAttribute('aria-checked', 'false');
    await user.click(terminal);
    expect(terminal).toHaveAttribute('aria-checked', 'true');
    expect(within(dialog).getByText(/Permission level set to Advanced — Terminal needs it/)).toBeInTheDocument();
    // Advanced is collapsed by default; its state is kept while collapsed
    const adv = within(dialog).getByRole('button', { name: 'Advanced' });
    expect(adv).toHaveAttribute('aria-expanded', 'false');
    await user.click(adv);
    const levels = within(dialog).getByRole('radiogroup', { name: 'Permission level' });
    expect(within(levels).getByRole('radio', { name: /^Advanced/ })).toHaveAttribute('aria-checked', 'true');
    // Python needs Advanced: selectable now
    await user.click(within(dialog).getByRole('checkbox', { name: /Python/ }));
    await user.click(within(levels).getByRole('radio', { name: /^Standard/ }));
    expect(terminal).toHaveAttribute('aria-checked', 'false');
    expect(within(dialog).getByRole('checkbox', { name: /Python/ })).toHaveAttribute('aria-checked', 'false');
    expect(within(dialog).getByText('Turned off (needs a higher level): Terminal, Python.')).toBeInTheDocument();
    await user.click(terminal);
    await user.click(adv);
    await user.click(adv);
    expect(within(levels).getByRole('radio', { name: /^Advanced/ })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(dialog).getByRole('button', { name: 'Create Agent' }));
    await screen.findByText('Scout is ready.');
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/v1/miniapp/agents');
    expect(post?.body).toMatchObject({ permission_level: 'ADVANCED', capabilities: { terminal: true }, extra_skills: [] });
  });

  it('provisioning_failed shows the sanitized host message and never the success state', async () => {
    const user = userEvent.setup();
    mount(
      '#/agents',
      routes(OWNER, {
        'POST /api/v1/miniapp/agents': () => apiError(502, 'provisioning_failed', 'the guest agent timed out\u0007\n while creating the desktop.', { agent_id: 'a9' }),
      }),
    );
    const dialog = await openCreator(user);
    await fillRequired(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Create Agent' }));
    const problem = await within(dialog).findByTestId('create-problem');
    expect(problem).toHaveTextContent(
      "NEBULA could not prepare the agent's desktop in the VM: the guest agent timed out while creating the desktop. The agent was not started; you can remove it on your Mac.",
    );
    expect(problem.textContent).not.toContain('\u0007');
    expect(screen.queryByText('Agent created')).toBeNull();
    expect(screen.queryByText(/is ready/)).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Create Agent' })).toBeInTheDocument();
  });

  it('maps host field errors inline (model without tools, capability level) and rate limits to a friendly message', async () => {
    const user = userEvent.setup();
    let n = 0;
    mount(
      '#/agents',
      routes(OWNER, {
        'POST /api/v1/miniapp/agents': () => {
          n += 1;
          if (n === 1) return apiError(422, 'model_without_tools', 'this model cannot use tools, so it cannot work as an agent');
          if (n === 2) return apiError(422, 'capability_requires_level', 'Terminal needs the ADVANCED permission level', { capability: 'terminal', requires_level: 'ADVANCED' });
          return apiError(429, 'rate_limited', 'too many agents created recently', { retry_after: 240 });
        },
      }),
    );
    const dialog = await openCreator(user);
    await fillRequired(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Create Agent' }));
    expect(await within(dialog).findByText('This model cannot use tools, so it cannot work as an agent. Choose another model.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Create Agent' }));
    expect(await within(dialog).findByText('Terminal needs the Advanced permission level.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Create Agent' }));
    expect(await within(dialog).findByText('Try again in about 4 minutes.')).toBeInTheDocument();
  });

  it('confirms before discarding a dirty form (Cancel, Telegram BackButton, Escape) and closes a clean one directly', async () => {
    const user = userEvent.setup();
    const wa = telegram();
    mount('#/agents', routes(OWNER), wa);
    let dialog = await openCreator(user);
    // clean form: Cancel closes right away
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create Agent' })).toBeNull());
    expect(window.location.hash).toBe('#/agents');

    dialog = await openCreator(user);
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Scout');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    let confirm = await screen.findByRole('dialog', { name: 'Discard this agent?' });
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Discard this agent?' })).toBeNull();
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toHaveValue('Scout'); // nothing lost

    // Telegram BackButton
    const onBack = () => vi.mocked(wa.BackButton.onClick).mock.calls.at(-1)?.[0] as () => void;
    act(() => onBack()());
    confirm = await screen.findByRole('dialog', { name: 'Discard this agent?' });
    // Back again closes the confirmation, not the creator
    act(() => onBack()());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Discard this agent?' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Create Agent' })).toBeInTheDocument();

    // Escape
    await user.keyboard('{Escape}');
    confirm = await screen.findByRole('dialog', { name: 'Discard this agent?' });
    await user.click(within(confirm).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create Agent' })).toBeNull());
    expect(window.location.hash).toBe('#/agents');
  });

  it('a deep link to #/agents/new without the `agents` permission explains it and fetches nothing', async () => {
    const { calls } = mount('#/agents/new', routes(PERMS));
    const sheet = await screen.findByRole('dialog', { name: 'Create Agent' });
    expect(within(sheet).getByText(/Creating and changing agents needs the NEBULA owner account\./)).toBeInTheDocument();
    await settle();
    expect(calls.some((c) => c.path.startsWith('/api/v1/miniapp/agent'))).toBe(false);
  });

  it('adds no request to the first render of Chats, Agents and Activity (the creator is never preloaded)', async () => {
    for (const hash of ['#/', '#/agents', '#/activity']) {
      clearQueryCache();
      sessionStorage.clear();
      const { calls, view } = mount(
        hash,
        routes(OWNER, {
          'GET /api/v1/conversations': () => ok([]),
          'GET /api/v1/tasks': () => ok([]),
          'GET /api/v1/workflow-runs': () => ok([]),
        }),
      );
      await screen.findByRole('navigation', { name: 'Primary' });
      await settle();
      await settle();
      const paths = calls.map((c) => `${c.method} ${c.path}`);
      expect(paths.filter((p) => p.includes('/miniapp/agent'))).toEqual([]);
      const expected: Record<string, string[]> = {
        '#/': ['GET /api/v1/conversations', 'GET /api/v1/health'],
        '#/agents': ['GET /api/v1/agents'],
        '#/activity': ['GET /api/v1/tasks', 'GET /api/v1/workflow-runs'],
      };
      const screenCalls = paths.filter((p) => !['POST /api/mini/auth', 'GET /api/v1/miniapp/me', 'GET /api/v1/events', 'GET /api/v1/approval-center'].includes(p));
      expect(screenCalls.sort()).toEqual(expected[hash]);
      view.unmount();
      resetStream();
    }
  });
});

describe('Mini App agent settings', () => {
  beforeEach(() => {
    sessionStorage.clear();
    installMemoryStorage();
    clearQueryCache();
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.Telegram;
    window.history.replaceState(null, '', '/');
    resetStream();
  });

  const a1 = settings({ agent: { ...agent }, name: 'Researcher', description: 'Finds things', avatar: null, vault: { mode: 'SELECTED', grants: [{ id: 'g1', entry_name: 'GitHub', origins: ['https://github.com'], policy: 'once_per_task', enabled: true }] } });

  function settingsRoutes(perms: string[], extra: Record<string, Handler> = {}) {
    return routes(perms, {
      'GET /api/v1/miniapp/agents/a1/settings': () => ok(a1),
      'GET /api/v1/agents/a1/voice': () => ok({ agent_id: 'a1', reply_mode: 'text', provider: 'system', voice: null, language: 'en', rate: 1 }),
      ...extra,
    });
  }

  it('loads the settings (and options; no models) and PATCHes only the changed fields', async () => {
    const user = userEvent.setup();
    const { calls } = mount('#/agents/a1/settings', settingsRoutes(OWNER, { 'PATCH /api/v1/miniapp/agents/a1/settings': (c) => ok({ ...a1, ...(c.body as object) }) }));
    const name = await screen.findByRole('textbox', { name: 'Name' });
    expect(name).toHaveValue('Researcher');
    // its own name is not a "duplicate"
    expect(screen.queryByText(/already exists/)).toBeNull();
    expect(count(calls, 'GET', '/api/v1/miniapp/agents/a1/settings')).toBe(1);
    expect(count(calls, 'GET', '/api/v1/miniapp/agent-options')).toBe(1);
    expect(count(calls, 'GET', '/api/v1/miniapp/agent-options/models')).toBe(0);
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    const desc = screen.getByRole('textbox', { name: 'Description or role' });
    await user.clear(desc);
    await user.type(desc, 'Compares prices');
    await user.click(screen.getByRole('radio', { name: /Ask me when a sign-in is needed/ }));
    await user.click(screen.getByRole('switch', { name: 'Memory' }));
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(count(calls, 'PATCH', '/api/v1/miniapp/agents/a1/settings')).toBe(1));
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ description: 'Compares prices', vault_access: 'ask', capabilities: { memory: false } });
    expect(await screen.findByText('Settings saved')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
  });

  it('changing the model loads the models on demand and sends provider_id + model_id together', async () => {
    const user = userEvent.setup();
    const { calls } = mount('#/agents/a1/settings', settingsRoutes(OWNER, { 'PATCH /api/v1/miniapp/agents/a1/settings': () => ok({ ...a1, model_id: 'claude-y' }) }));
    await screen.findByRole('textbox', { name: 'Name' });
    expect(screen.getByText('claude-x')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change' }));
    const model = await screen.findByRole('combobox', { name: 'Model' });
    expect(count(calls, 'GET', '/api/v1/miniapp/agent-options/models')).toBe(1);
    await user.selectOptions(model, 'claude-y');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(count(calls, 'PATCH', '/api/v1/miniapp/agents/a1/settings')).toBe(1));
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ provider_id: 'anthropic-api', model_id: 'claude-y' });
  });

  it('asks before leaving with unsaved changes (Telegram BackButton) and discards them on confirm', async () => {
    const user = userEvent.setup();
    const wa = telegram();
    const { calls } = mount('#/agents/a1/settings', settingsRoutes(OWNER, { 'GET /api/v1/agents/a1/skills': () => ok([]) }), wa);
    const name = await screen.findByRole('textbox', { name: 'Name' });
    await user.type(name, ' 2');
    const onBack = () => vi.mocked(wa.BackButton.onClick).mock.calls.at(-1)?.[0] as () => void;
    act(() => onBack()());
    const confirm = await screen.findByRole('dialog', { name: 'Discard your changes?' });
    expect(window.location.hash).toBe('#/agents/a1/settings');
    await user.click(within(confirm).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(window.location.hash).toBe('#/agents/a1/details'));
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('shows status with Pause, the vault grants with a confirmed Revoke, the environment and the Mac-only delete', async () => {
    const user = userEvent.setup();
    const { calls } = mount(
      '#/agents/a1/settings',
      settingsRoutes(OWNER, {
        'POST /api/v1/agents/a1/pause': () => ok({ ...agent, state: 'PAUSED' }),
        'POST /api/v1/vault/grants/g1/revoke': () => ok({ id: 'g1', enabled: false }),
      }),
    );
    const status = await screen.findByTestId('agent-status');
    expect(within(status).getByText('Ready')).toBeInTheDocument();
    await user.click(within(status).getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(count(calls, 'POST', '/api/v1/agents/a1/pause')).toBe(1));

    const grant = screen.getByTestId('settings-grant');
    expect(grant).toHaveTextContent('GitHub');
    await user.click(within(grant).getByRole('button', { name: 'Revoke' }));
    const confirm = await screen.findByRole('dialog', { name: 'Revoke access to GitHub?' });
    expect(count(calls, 'POST', '/api/v1/vault/grants/g1/revoke')).toBe(0);
    await user.click(within(confirm).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(count(calls, 'POST', '/api/v1/vault/grants/g1/revoke')).toBe(1));

    expect(screen.getByText('Its own isolated Linux user, desktop and browser in the VM.')).toBeInTheDocument();
    expect(screen.getByText('Delete agent').closest('[aria-disabled="true"]')).not.toBeNull();
    expect(screen.getByText(/only available in the NEBULA Dashboard on your Mac/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('without the `agents` permission: read-only summary with the owner note, no composer requests, no Save', async () => {
    const { calls } = mount(
      '#/agents/a1/settings',
      settingsRoutes(PERMS, {
        'GET /api/v1/agents/a1': () => ok({ ...agent, config: { instructions: 'Always cite sources.', sign_in_assistance: true, avatar: { kind: 'initials', value: 'RS' } } }),
      }),
    );
    expect(await screen.findByTestId('owner-only-note')).toHaveTextContent('Creating and changing agents needs the NEBULA owner account.');
    expect(screen.getByText('Always cite sources.')).toBeInTheDocument();
    expect(screen.getByText('Ask me when a sign-in is needed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
    await settle();
    expect(calls.some((c) => c.path.startsWith('/api/v1/miniapp/agent'))).toBe(false);
  });
});

describe('agent avatars', () => {
  beforeEach(() => {
    sessionStorage.clear();
    installMemoryStorage();
    clearQueryCache();
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.Telegram;
    window.history.replaceState(null, '', '/');
    resetStream();
  });

  it('renders emoji, initials and icon avatars (unknown icon → initials of the name)', async () => {
    const agents: Agent[] = [
      { ...agent, id: 'e1', name: 'Emoji Agent', config: { avatar: { kind: 'emoji', value: '🦊' } } },
      { ...agent, id: 'i1', name: 'Initials Agent', config: { avatar: { kind: 'initials', value: 'qz' } } },
      { ...agent, id: 'c1', name: 'Icon Agent', config: { avatar: { kind: 'icon', value: 'robot' } } },
      { ...agent, id: 'u1', name: 'Unknown Icon', config: { avatar: { kind: 'icon', value: 'nope' } } },
      { ...agent, id: 'n1', name: 'Plain Name' },
    ];
    mount('#/agents', routes(PERMS, { 'GET /api/v1/agents': () => ok(agents) }));
    const row = async (name: string) => (await screen.findByRole('link', { name: new RegExp(`^${name}`) })).querySelector('[data-avatar]') as HTMLElement;
    expect(await row('Emoji Agent')).toHaveAttribute('data-avatar', 'emoji');
    expect(await row('Emoji Agent')).toHaveTextContent('🦊');
    expect(await row('Initials Agent')).toHaveTextContent('QZ');
    const icon = await row('Icon Agent');
    expect(icon).toHaveAttribute('data-avatar', 'icon');
    await waitFor(() => expect(icon.querySelector('svg[data-avatar-icon="robot"]')).not.toBeNull());
    await waitFor(() => expect(within(icon).queryByText('IA')).toBeNull());
    const unknown = await row('Unknown Icon');
    await waitFor(() => expect(unknown).toHaveTextContent('UI'));
    expect(await row('Plain Name')).toHaveAttribute('data-avatar', 'name');
    expect(await row('Plain Name')).toHaveTextContent('PN');
  });
});
