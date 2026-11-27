import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../../api';
import { ToastProvider } from '../../components/Toast';
import { ChatTab } from '../../pages/agent/ChatTab';
import { installFetch, ok } from '../../test/fetchMock';
import type { Agent } from '../../types';
import { contentUrl, extractionSummary, thumbnailPath, visionState, type Attachment } from './api';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

const att = (over: Partial<Attachment> = {}): Attachment => ({
  id: 'att1',
  source: 'web',
  agent_id: 'ag1',
  task_id: null,
  kind: 'image',
  mime: 'image/png',
  name: 'screen.png',
  size: 2048,
  status: 'PROCESSED',
  extracted: { width: 1280, height: 720, model_image: 'derived/model.jpg', vision: { used: null, note: 'analysed by the agent’s model when the task runs (if it supports images)' } },
  error: null,
  created_at: 1_700_000_000,
  ...over,
});

describe('attachment helpers', () => {
  it('summarises what was extracted per kind', () => {
    expect(extractionSummary(att())).toBe('1280×720');
    expect(extractionSummary(att({ kind: 'pdf', extracted: { pages: 3, chars: 5120 } }))).toBe('3 pages · 5,120 chars');
    expect(extractionSummary(att({ kind: 'csv', extracted: { table: { rows: 120, columns: ['a', 'b'], column_count: 2 } } }))).toBe('~120 rows · 2 columns');
    expect(extractionSummary(att({ kind: 'zip', extracted: { archive: { entries: 14, unsafe_entries: ['../evil'] } } }))).toBe('14 entries · 1 unsafe ignored');
    expect(extractionSummary(att({ kind: 'voice', extracted: { media: { duration_s: 12.4 }, transcript: { ok: true, text: 'ahoj' } } }))).toBe('12 s · transcribed');
    expect(
      extractionSummary(att({ kind: 'video', extracted: { media: { duration_s: 75, video: { width: 1920, height: 1080 } }, frames: [{ t: 0, file: 'derived/frames/frame-00.jpg' }, { t: 30, file: 'derived/frames/frame-01.jpg' }] } })),
    ).toBe('1:15 min · 1920×1080 · 2 frames');
    expect(extractionSummary(att({ status: 'FAILED', error: 'pdftotext (poppler) is not installed' }))).toBe('Processing failed: pdftotext (poppler) is not installed');
  });

  it('builds derived thumbnails and reports vision honestly', () => {
    expect(thumbnailPath(att())).toBe('derived/model.jpg');
    expect(thumbnailPath(att({ kind: 'video', extracted: { frames: [{ t: 0, file: 'derived/frames/frame-00.jpg' }] } }))).toBe('derived/frames/frame-00.jpg');
    expect(contentUrl('att1', 'derived/frames/frame-00.jpg')).toBe('/api/v1/attachments/att1/content?derived=derived%2Fframes%2Fframe-00.jpg');
    expect(visionState(att())?.tone).toBe('neutral');
    expect(visionState(att({ extracted: { vision: { used: false, note: 'the agent’s model cannot see images; the image was NOT analysed' } } }))?.text).toMatch(/NOT analysed/);
    expect(visionState(att({ extracted: { vision: { used: true, model: 'gpt-4o' } } }))?.text).toBe('Seen by the model (gpt-4o)');
    expect(visionState(att({ kind: 'pdf' }))).toBeNull();
  });
});

// Minimal XMLHttpRequest stand-in: reports progress, then answers with the processed attachment.
class FakeXHR {
  static sent: FakeXHR[] = [];
  static respond: (x: FakeXHR) => { status: number; body: unknown } = () => ({ status: 201, body: { data: att() } });
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  responseText = '';
  withCredentials = false;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(m: string, u: string) {
    this.method = m;
    this.url = u;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k.toLowerCase()] = v;
  }
  getResponseHeader() {
    return null;
  }
  abort() {
    this.onabort?.();
  }
  send(body: unknown) {
    this.body = body;
    FakeXHR.sent.push(this);
    setTimeout(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 1024, total: 2048 });
      const r = FakeXHR.respond(this);
      this.status = r.status;
      this.responseText = JSON.stringify(r.body);
      this.onload?.();
    }, 5);
  }
}

const agent = { id: 'ag1', name: 'Researcher', state: 'READY', provider_id: 'ollama-local', model_id: 'llava', description: '' } as unknown as Agent;

describe('multimodal chat', () => {
  it('uploads an attachment, shows its chip and sends the task with attachment_ids', async () => {
    setCsrfToken('c');
    FakeXHR.sent = [];
    FakeXHR.respond = () => ({ status: 201, body: { data: att() } });
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/agents/ag1/messages': () => ok([]),
      'GET /api/v1/agents/ag1/tasks': () => ok([]),
      'GET /api/v1/approvals': () => ok([]),
      'GET /api/v1/agents/ag1/attachments': () => ok([]),
      'POST /api/v1/agents/ag1/tasks': () => ok({ id: 'task9999', agent_id: 'ag1', state: 'QUEUED', prompt: 'x' }, 201),
    });
    const { container } = render(
      <ToastProvider>
        <ChatTab agent={agent} />
      </ToastProvider>,
    );
    await screen.findByText('No messages yet');
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array(2048)], 'screen.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });

    const chip = await screen.findByTestId('attachment-chip');
    await waitFor(() => expect(chip).toHaveAttribute('data-status', 'PROCESSED'));
    expect(within(chip).getByText('screen.png')).toBeInTheDocument();
    expect(within(chip).getByText('1280×720')).toBeInTheDocument();
    expect(within(chip).getByText(/Analysed when the task runs|analysed by the agent/)).toBeInTheDocument();
    expect(within(chip).getByRole('img', { name: 'Preview of screen.png' })).toHaveAttribute('src', '/api/v1/attachments/att1/content?derived=derived%2Fmodel.jpg');
    const xhr = FakeXHR.sent[0];
    expect(xhr.url).toBe('/api/v1/agents/ag1/attachments');
    expect(xhr.headers['x-csrf-token']).toBe('c');
    expect((xhr.body as FormData).get('file')).toBeInstanceOf(File);

    await user.type(screen.getByLabelText('Task for Researcher'), 'What is wrong on this screen?');
    await user.click(screen.getByRole('button', { name: 'Send (1)' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ prompt: 'What is wrong on this screen?', attachment_ids: ['att1'] }));
    expect(calls.find((c) => c.method === 'POST')?.headers['idempotency-key']).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('attachment-chip')).toBeNull());
  });

  it('shows a rejection error on the chip and does not send rejected files', async () => {
    setCsrfToken('c');
    FakeXHR.sent = [];
    FakeXHR.respond = () => ({ status: 415, body: { error: { code: 'mime_mismatch', message: 'declared image/png but the content is application/x-msdownload' } } });
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    const { calls } = installFetch({
      'GET /api/v1/agents/ag1/messages': () => ok([]),
      'GET /api/v1/agents/ag1/tasks': () => ok([]),
      'GET /api/v1/approvals': () => ok([]),
      'GET /api/v1/agents/ag1/attachments': () => ok([]),
      'POST /api/v1/agents/ag1/tasks': () => ok({ id: 'task1', agent_id: 'ag1', state: 'QUEUED', prompt: 'x' }, 201),
    });
    const { container } = render(
      <ToastProvider>
        <ChatTab agent={agent} />
      </ToastProvider>,
    );
    await screen.findByText('No messages yet');
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(10)], 'fake.png', { type: 'image/png' })] } });
    const chip = await screen.findByTestId('attachment-chip');
    await waitFor(() => expect(chip).toHaveAttribute('data-status', 'error'));
    expect(within(chip).getByRole('alert')).toHaveTextContent('Rejected: declared image/png but the content is application/x-msdownload');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Task for Researcher'), 'Check the file');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ prompt: 'Check the file' }));
  });

  it('lists attachments linked to a sent task under the message', async () => {
    installFetch({
      'GET /api/v1/agents/ag1/messages': () => ok([{ id: 'm1', agent_id: 'ag1', task_id: 'tk1', role: 'user', channel: 'telegram', content: 'Look at this', attachments: [], created_at: 1_700_000_000 }]),
      'GET /api/v1/agents/ag1/tasks': () => ok([]),
      'GET /api/v1/approvals': () => ok([]),
      'GET /api/v1/agents/ag1/attachments': () =>
        ok([att({ task_id: 'tk1', extracted: { width: 10, height: 10, model_image: 'derived/model.jpg', vision: { used: false, note: 'the agent’s model cannot see images; the image was NOT analysed' } } })]),
    });
    render(
      <ToastProvider>
        <ChatTab agent={agent} />
      </ToastProvider>,
    );
    const list = await screen.findByRole('list', { name: 'Attachments' });
    expect(within(list).getByText('screen.png')).toBeInTheDocument();
    expect(within(list).getByText(/NOT analysed/)).toBeInTheDocument();
    expect(within(list).getByRole('link')).toHaveAttribute('href', '/api/v1/attachments/att1/content');
  });
});
