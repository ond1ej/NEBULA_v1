// Authenticated binary URLs (V3.3): with the Dashboard's cookie session /api/v1 URLs are used directly; with the Mini
// App's Bearer transport the bytes are fetched with the token and shown through object URLs (revoked on unmount).
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StepScreenshot } from '../components/TaskDetail';
import { AttachmentStrip } from '../features/attachments/AttachmentChip';
import type { Attachment } from '../features/attachments/api';
import { MiniClient } from '../mini/client';
import { installFetch } from '../test/fetchMock';
import { setTransport } from './http';

const att: Attachment = {
  id: 'att1',
  source: 'web',
  agent_id: 'a1',
  task_id: 't1',
  kind: 'image',
  mime: 'image/png',
  name: 'shot.png',
  size: 2048,
  status: 'PROCESSED',
  extracted: { model_image: 'derived/model.jpg' },
  error: null,
  created_at: 1,
};

const png = () => new Response(new Blob(['png'], { type: 'image/png' }), { status: 200 });

describe('authenticated images and links', () => {
  let n = 0;
  const create = vi.fn(() => `blob:nebula/${++n}`);
  const revoke = vi.fn();
  let restore: (() => void) | null = null;
  beforeEach(() => {
    n = 0;
    create.mockClear();
    revoke.mockClear();
    Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true, writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true, writable: true });
  });
  afterEach(() => {
    restore?.();
    restore = null;
    vi.unstubAllGlobals();
  });

  it('cookie session (Dashboard): the artifact URL is used as is, nothing is fetched', () => {
    const net = installFetch({});
    render(<StepScreenshot refPath="t1/step-3.png" alt="Step 3" />);
    expect(screen.getByRole('img', { name: 'Step 3' })).toHaveAttribute('src', '/api/v1/artifacts/t1/step-3.png');
    expect(screen.getByRole('link')).toHaveAttribute('href', '/api/v1/artifacts/t1/step-3.png');
    expect(net.calls).toHaveLength(0);
  });

  it('Bearer session (Mini App): the screenshot is fetched with the token and shown as a blob URL, revoked on unmount', async () => {
    const net = installFetch({ 'GET /api/v1/artifacts/t1/step-3.png': png });
    restore = setTransport(new MiniClient({ mode: 'telegram', token: 'tok-1' }).transport());
    const view = render(<StepScreenshot refPath="t1/step-3.png" alt="Step 3" />);
    // placeholder while loading, never the raw (unauthenticated) URL
    expect(screen.queryByRole('link')).toBeNull();
    await waitFor(() => expect(screen.getByRole('link')).toHaveAttribute('href', 'blob:nebula/1'));
    expect(screen.getByRole('img', { name: 'Step 3' })).toHaveAttribute('src', 'blob:nebula/1');
    expect(net.calls[0].headers.authorization).toBe('Bearer tok-1');
    expect(net.calls[0].init.credentials).toBe('omit');
    view.unmount();
    expect(revoke).toHaveBeenCalledWith('blob:nebula/1');
  });

  it('Bearer session: attachment thumbnails are fetched; opening the original downloads it through the transport', async () => {
    const net = installFetch({ 'GET /api/v1/attachments/att1/content': png });
    restore = setTransport(new MiniClient({ mode: 'telegram', token: 'tok-1' }).transport());
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<AttachmentStrip atts={[att]} />);
    await waitFor(() => expect(screen.getByAltText('Preview of shot.png')).toHaveAttribute('src', 'blob:nebula/1'));
    expect(net.calls[0].url).toBe('/api/v1/attachments/att1/content?derived=derived%2Fmodel.jpg');
    fireEvent.click(screen.getByTitle('shot.png — open the original'));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(net.calls[1].url).toBe('/api/v1/attachments/att1/content');
    expect(net.calls.every((c) => c.headers.authorization === 'Bearer tok-1')).toBe(true);
  });
});
