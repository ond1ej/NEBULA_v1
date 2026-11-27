// The conversation screen against the V3.2 conversation API (fetch mocked, events streamed).
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, ok, type RecordedCall } from '../test/fetchMock';
import { clearAllPending } from './chat/pending';
import { clearQueryCache } from './hooks';
import { navigate } from './router';
import { baseRoutes, conversation, emit, installMemoryStorage, installXhrOverFetch, message, mount, NOW, resetStream } from './test/kit';

vi.mock('@novnc/novnc', () => ({ default: class {} }));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const convRoutes = (extra: Record<string, (c: RecordedCall) => Response | Promise<Response>> = {}) =>
  baseRoutes({
    'GET /api/v1/conversations': () => ok([conversation({ unread_count: 3 }), conversation({ id: 'c2', title: 'Second chat', is_default: false })]),
    'GET /api/v1/conversations/c1': () => ok(conversation({ unread_count: 3 })),
    'GET /api/v1/conversations/c2': () => ok(conversation({ id: 'c2', title: 'Second chat', is_default: false })),
    'GET /api/v1/conversations/c1/messages': () => ok({ items: [message()], has_more: false }),
    'GET /api/v1/conversations/c2/messages': () => ok({ items: [message({ id: 'm9', conversation_id: 'c2', content: 'Second hello' })], has_more: false }),
    'POST /api/v1/conversations/c1/read': () => ok({ unread_count: 0 }),
    'GET /api/v1/voice/stt': () => ok({ backend: null }),
    ...extra,
  });

const sentBody = (c: RecordedCall) => c.body as { content: string; client_id: string; attachment_ids?: string[] };

describe('Conversation', () => {
  beforeEach(() => {
    sessionStorage.clear();
    installMemoryStorage();
    clearQueryCache();
    clearAllPending();
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.Telegram;
    window.history.replaceState(null, '', '/');
    resetStream();
  });

  it('opens from Chats: messages, read marker, no tab bar, Markdown from the agent', async () => {
    const user = userEvent.setup();
    const { calls } = mount(
      '#/',
      convRoutes({ 'GET /api/v1/conversations/c1/messages': () => ok({ items: [message({ content: 'Found **3 flights** — see `results.csv`' })], has_more: false }) }),
    );
    await user.click(await screen.findByRole('link', { name: /^Researcher, 3 unread/ }));
    expect(window.location.hash).toBe('#/chats/c1');
    const list = await screen.findByRole('list', { name: 'Conversation with Researcher' });
    expect(within(list).getByText('3 flights').tagName).toBe('STRONG');
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/v1/conversations/c1/read')).toBe(true));
    expect(document.querySelector('nav.mini-tabbar')).toHaveAttribute('data-hidden', '1');
    expect(screen.getByLabelText('Message to Researcher')).toBeInTheDocument();
  });

  it('sends optimistically ("Sending…") and reconciles with the server message (no duplicate)', async () => {
    const user = userEvent.setup();
    const gate = deferred<void>();
    const { calls } = mount(
      '#/chats/c1',
      convRoutes({
        'POST /api/v1/conversations/c1/messages': async (c) => {
          await gate.promise;
          const b = sentBody(c);
          return ok({ message: message({ id: 'm2', role: 'user', content: b.content, client_id: b.client_id, task_id: 't1', created_at: NOW }), task: { id: 't1', state: 'QUEUED' } }, 201);
        },
      }),
    );
    await screen.findByText('Hello, how can I help?');
    await user.type(screen.getByLabelText('Message to Researcher'), 'Find flights to Prague');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    const pending = await screen.findByTestId('msg-pending');
    expect(pending).toHaveAttribute('data-status', 'sending');
    expect(within(pending).getByText('Find flights to Prague')).toBeInTheDocument();
    expect(within(pending).getByText('Sending…')).toBeInTheDocument();
    expect(screen.getByLabelText('Message to Researcher')).toHaveValue('');

    await act(async () => gate.resolve());
    const sent = await screen.findByTestId('msg-user');
    expect(screen.queryByTestId('msg-pending')).toBeNull();
    expect(sent).toHaveAttribute('data-client-id', sentBody(calls.find((c) => c.method === 'POST' && c.path.endsWith('/messages')) as RecordedCall).client_id);
    expect(within(sent).getByTestId('task-inline')).toHaveAttribute('data-state', 'QUEUED');
    expect(screen.getAllByText('Find flights to Prague')).toHaveLength(1);
    // the chat list preview follows
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/conversations/c1/messages')).toHaveLength(1);
  });

  it('a failed send shows "Not sent · Retry"; Retry reuses the same client_id (idempotent)', async () => {
    const user = userEvent.setup();
    let n = 0;
    const { calls } = mount(
      '#/chats/c1',
      convRoutes({
        'POST /api/v1/conversations/c1/messages': (c) => {
          n += 1;
          if (n === 1) return apiError(503, 'unavailable', 'NEBULA is restarting');
          const b = sentBody(c);
          return ok({ message: message({ id: 'm3', role: 'user', content: b.content, client_id: b.client_id, created_at: NOW }), task: null }, 201);
        },
      }),
    );
    await screen.findByText('Hello, how can I help?');
    await user.type(screen.getByLabelText('Message to Researcher'), 'Hello again');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    const failed = await screen.findByRole('alert');
    expect(failed).toHaveTextContent('Not sent · NEBULA is restarting');
    expect(screen.getByTestId('msg-pending')).toHaveAttribute('data-status', 'failed');
    await user.click(within(failed).getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(screen.queryByTestId('msg-pending')).toBeNull());
    const posts = calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/conversations/c1/messages');
    expect(posts).toHaveLength(2);
    expect(sentBody(posts[0]).client_id).toBe(sentBody(posts[1]).client_id);
    expect(posts[1].headers['idempotency-key']).toBe(sentBody(posts[0]).client_id);
    expect(screen.getByTestId('msg-user')).toHaveTextContent('Hello again');
  });

  it('keeps a draft per conversation in localStorage and restores it on return', async () => {
    const user = userEvent.setup();
    mount('#/chats/c1', convRoutes());
    await screen.findByText('Hello, how can I help?');
    await user.type(screen.getByLabelText('Message to Researcher'), 'half-written thought');
    await waitFor(() => expect(window.localStorage.getItem('nebula.mini.draft.c1')).toBe('half-written thought'));

    act(() => navigate('/chats/c2'));
    await screen.findByText('Second hello');
    expect(screen.getByLabelText('Message to Researcher')).toHaveValue('');
    await user.type(screen.getByLabelText('Message to Researcher'), 'other');
    act(() => navigate('/chats/c1'));
    await screen.findByText('Hello, how can I help?');
    expect(screen.getByLabelText('Message to Researcher')).toHaveValue('half-written thought');
    expect(window.localStorage.getItem('nebula.mini.draft.c2')).toBe('other');
  });

  it('inline task status follows task.stage / task.step / task.completed events without refetching', async () => {
    const user = userEvent.setup();
    const owner = message({ id: 'm5', role: 'user', content: 'Book it', task_id: 't1', task: { id: 't1', state: 'EXECUTING', started_at: NOW - 5, finished_at: null, failure_reason: null } });
    const { calls } = mount(
      '#/chats/c1',
      convRoutes({
        'GET /api/v1/conversations/c1/messages': () => ok({ items: [message(), owner], has_more: false }),
        'GET /api/v1/tasks/t1': () =>
          ok({ id: 't1', agent_id: 'a1', agent_name: 'Researcher', prompt: 'Book it', state: 'EXECUTING', current_step: 1, max_steps: 40, retry_count: 0, tool_calls_done: 1, source_channel: 'web', steps: [], approvals: [], created_at: NOW - 6, updated_at: NOW, started_at: NOW - 5, finished_at: null, result: null, failure_reason: null }),
      }),
    );
    const inline = await screen.findByTestId('task-inline');
    expect(inline).toHaveTextContent('Working');
    const before = calls.length;
    await emit('task.stage', { stage: 'tool', detail: 'browser.open', elapsed_ms: 4000, at: NOW }, { task_id: 't1', timestamp: NOW });
    await waitFor(() => expect(screen.getByTestId('task-inline')).toHaveTextContent('Working· Running browser.open'));
    await emit('task.step', { seq: 2, tool: 'browser.open', status: 'ok', summary: 'Opened the airline site' }, { task_id: 't1' });
    // expanding shows the live tool step (details are fetched once, on demand)
    await user.click(screen.getByTestId('task-inline'));
    const details = await screen.findByTestId('task-details');
    expect(await within(details).findByText('Opened the airline site')).toBeInTheDocument();
    await emit('task.completed', { result: { summary: 'Booked' } }, { task_id: 't1', timestamp: NOW + 7 });
    await waitFor(() => expect(screen.getByTestId('task-inline')).toHaveAttribute('data-state', 'COMPLETED'));
    expect(screen.getByTestId('task-inline')).toHaveTextContent('Completed· 12 s');
    // stage / step / lifecycle events refetched nothing except the opened task details
    expect(calls.slice(before).filter((c) => c.path !== '/api/v1/tasks/t1')).toHaveLength(0);
  });

  it('validates attachments on the device (50 MB, no executables) and lets chips be removed', async () => {
    const user = userEvent.setup({ applyAccept: false });
    installXhrOverFetch();
    const { calls } = mount('#/chats/c1', convRoutes());
    await screen.findByText('Hello, how can I help?');
    const big = new File(['x'], 'video.mov', { type: 'video/quicktime' });
    Object.defineProperty(big, 'size', { value: 51 * 1024 * 1024 });
    const exe = new File(['MZ'], 'setup.exe', { type: 'application/x-msdownload' });
    await user.upload(screen.getByLabelText('Choose files to attach'), [big, exe]);
    const chips = await screen.findAllByTestId('attachment-chip');
    expect(chips.map((c) => c.getAttribute('data-status'))).toEqual(['error', 'error']);
    expect(chips[0]).toHaveTextContent('Larger than 50 MB');
    expect(chips[1]).toHaveTextContent('Executables and installers are not accepted');
    expect(calls.some((c) => c.path.endsWith('/attachments'))).toBe(false);
    // a message cannot go out with broken files attached
    await user.type(screen.getByLabelText('Message to Researcher'), 'see attached');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Remove the files that could not be attached')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove video.mov' }));
    await user.click(screen.getByRole('button', { name: 'Remove setup.exe' }));
    expect(screen.queryByTestId('attachment-chip')).toBeNull();
  });

  it('without microphone access the mic explains why and text chat keeps working', async () => {
    const user = userEvent.setup();
    mount('#/chats/c1', convRoutes());
    await screen.findByText('Hello, how can I help?');
    const mic = screen.getByRole('button', { name: 'Voice messages unavailable' });
    expect(mic).toHaveAttribute('aria-disabled', 'true');
    await user.click(mic);
    expect(await screen.findByText(/This view has no microphone access\. You can still type your message\./)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Message to Researcher'), 'typed instead');
    expect(screen.getByRole('button', { name: 'Send' })).not.toHaveAttribute('aria-disabled');
  });

  it('records a voice message (MediaRecorder), uploads voice.ogg and says honestly that transcription is not configured', async () => {
    const user = userEvent.setup();
    installXhrOverFetch();
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] };
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn(async () => stream) }, configurable: true });
    class FakeRecorder {
      static isTypeSupported = (t: string) => t === 'audio/ogg;codecs=opus';
      mimeType = 'audio/ogg;codecs=opus';
      state = 'inactive';
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['OggS-voice'], { type: 'audio/ogg' }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    const { calls } = mount(
      '#/chats/c1',
      convRoutes({
        'POST /api/v1/agents/a1/attachments': () =>
          ok({ id: 'att-v', name: 'voice.ogg', kind: 'voice', mime: 'audio/ogg', size: 10, status: 'PROCESSED', created_at: NOW, extracted: { transcript: { ok: false, error: 'speech-to-text not configured (nothing was sent anywhere)' } } }, 201),
        'POST /api/v1/conversations/c1/messages': (c) => {
          const b = sentBody(c);
          return ok({ message: message({ id: 'm8', role: 'user', content: b.content, client_id: b.client_id, created_at: NOW, attachments: [] }), task: { id: 't8', state: 'QUEUED' } }, 201);
        },
      }),
    );
    await screen.findByText('Hello, how can I help?');
    await user.click(screen.getByRole('button', { name: 'Record a voice message' }));
    expect(await screen.findByTestId('recording')).toHaveTextContent('Recording');
    await user.click(screen.getByRole('button', { name: 'Send voice message' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/v1/conversations/c1/messages')).toBe(true));
    const up = calls.find((c) => c.path === '/api/v1/agents/a1/attachments');
    expect(((up?.init.body as FormData).get('file') as File).name).toBe('voice.ogg');
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/v1/conversations/c1/messages') as RecordedCall;
    expect(sentBody(post).attachment_ids).toEqual(['att-v']);
    expect(sentBody(post).content).toMatch(/^Voice message/);
    expect(stop).toHaveBeenCalled(); // the microphone is released
    expect(await screen.findByText('Transcription not configured')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play voice message' })).toBeInTheDocument();
  });

  it('archives a conversation (confirmation) and finds it again under Archived', async () => {
    const user = userEvent.setup();
    const archived = conversation({ id: 'c2', title: 'Second chat', is_default: false, archived: true });
    const { calls } = mount(
      '#/chats/c2',
      convRoutes({
        'PATCH /api/v1/conversations/c2': () => ok(archived),
        'GET /api/v1/conversations': (c) => ok(c.url.includes('archived=true') ? [archived] : [conversation()]),
      }),
    );
    await screen.findByText('Second hello');
    await user.click(screen.getByRole('button', { name: 'Conversation options' }));
    await user.click(await screen.findByRole('button', { name: /Archive conversation/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive this conversation?' });
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(window.location.hash).toBe('#/'));
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ archived: true });
    await user.click(await screen.findByRole('link', { name: 'Archived conversations' }));
    expect(await screen.findByRole('link', { name: /^Researcher, Second chat/ })).toHaveAttribute('href', '#/chats/c2');
  });

  it('loads earlier messages with the before cursor and keeps them above', async () => {
    const user = userEvent.setup();
    const { calls } = mount(
      '#/chats/c1',
      convRoutes({
        'GET /api/v1/conversations/c1/messages': (c) =>
          c.url.includes('before=')
            ? ok({ items: [message({ id: 'm0', content: 'The very first message', created_at: NOW - 9000 })], has_more: false })
            : ok({ items: [message({ id: 'm1', created_at: NOW - 100 })], has_more: true }),
      }),
    );
    await screen.findByText('Hello, how can I help?');
    await user.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    expect(await screen.findByText('The very first message')).toBeInTheDocument();
    expect(calls.some((c) => c.url === `/api/v1/conversations/c1/messages?before=${NOW - 100}&limit=50`)).toBe(true);
    const texts = [...screen.getByRole('list', { name: 'Conversation with Researcher' }).querySelectorAll('[data-testid="msg-agent"]')].map((li) => li.textContent);
    expect(texts[0]).toContain('The very first message');
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull();
  });
});
