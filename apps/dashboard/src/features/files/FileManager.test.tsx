import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../../api';
import { ToastProvider } from '../../components/Toast';
import { installFetch, ok } from '../../test/fetchMock';
import { FileManager } from './FileManager';

const roots = [
  { id: 'agent:a1', type: 'agent', label: 'Ada', agent_id: 'a1', status: 'READY' },
  { id: 'exchange', type: 'exchange', label: 'Mac exchange folder', host_path: '/Users/x/exchange' },
];

const rootList = {
  path: '.',
  entries: [
    { name: 'docs', path: 'docs', type: 'dir', size: 96, mtime: 1_700_000_000 },
    { name: 'notes.txt', path: 'notes.txt', type: 'file', size: 2048, mtime: 1_700_000_100 },
  ],
};

function renderFm() {
  return render(
    <ToastProvider>
      <FileManager root="agent:a1" />
    </ToastProvider>,
  );
}

beforeEach(() => setCsrfToken('csrf'));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

describe('FileManager', () => {
  it('lists a folder, navigates into sub-folders and back via the breadcrumb', async () => {
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/files/roots': () => ok(roots),
      'GET /api/v1/files/usage': () => ok({ bytes: 4096, files: 3 }),
      'GET /api/v1/files/list': (c) =>
        ok(
          c.url.includes('path=docs')
            ? { path: 'docs', entries: [{ name: 'plan.md', path: 'docs/plan.md', type: 'file', size: 10, mtime: 1_700_000_000 }] }
            : rootList,
        ),
    });
    renderFm();
    expect(await screen.findByRole('button', { name: /^notes\.txt/ })).toBeInTheDocument();
    expect(await screen.findByText(/3 file\(s\) · 4\.0 KB in Ada/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^docs, folder/ }));
    expect(await screen.findByRole('button', { name: /^plan\.md/ })).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/v1/files/list' && c.url.includes('root=agent%3Aa1') && c.url.includes('path=docs'))).toBe(true);
    const crumbs = screen.getByRole('navigation', { name: 'Folder path' });
    await user.click(within(crumbs).getByRole('button', { name: 'Ada' }));
    expect(await screen.findByRole('button', { name: /^notes\.txt/ })).toBeInTheDocument();
  });

  it('deletes through the actions menu only after confirmation', async () => {
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/files/roots': () => ok(roots),
      'GET /api/v1/files/usage': () => ok({ bytes: 1, files: 1 }),
      'GET /api/v1/files/list': () => ok(rootList),
      'DELETE /api/v1/files': () => ok({ deleted: 'docs' }),
    });
    renderFm();
    await user.click(await screen.findByRole('button', { name: 'Actions for docs' }));
    const menu = await screen.findByRole('menu', { name: 'docs' });
    expect(within(menu).queryByRole('menuitem', { name: /Send to/ })).not.toBeInTheDocument(); // files only
    await user.click(within(menu).getByRole('menuitem', { name: 'Delete…' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByLabelText(/Also delete everything inside this folder/));
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(del.url).toContain('confirm=true');
    expect(del.url).toContain('recursive=true');
    expect(del.url).toContain('path=docs');
    expect(del.headers['x-csrf-token']).toBe('csrf');
  });

  it('creates a folder and refuses names that already exist', async () => {
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/files/roots': () => ok(roots),
      'GET /api/v1/files/usage': () => ok({ bytes: 1, files: 1 }),
      'GET /api/v1/files/list': () => ok(rootList),
      'POST /api/v1/files/mkdir': () => ok({ path: 'reports' }, 201),
    });
    renderFm();
    await screen.findByRole('button', { name: /^notes\.txt/ });
    await user.click(screen.getByRole('button', { name: /New folder/ }));
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText('Folder name');
    await user.type(input, 'docs');
    expect(within(dialog).getByText('“docs” already exists here.')).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, 'reports');
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ root: 'agent:a1', path: 'reports' }));
  });

  it('previews a text file and saves edits with PUT /files/text', async () => {
    const user = userEvent.setup();
    const { calls } = installFetch({
      'GET /api/v1/files/roots': () => ok(roots),
      'GET /api/v1/files/usage': () => ok({ bytes: 1, files: 1 }),
      'GET /api/v1/files/list': () => ok(rootList),
      'GET /api/v1/files/preview': () => ok({ path: 'notes.txt', kind: 'text', size: 5, mtime: 1, truncated: false, text: 'hello' }),
      'PUT /api/v1/files/text': () => ok({ path: 'notes.txt', size: 11 }),
    });
    renderFm();
    await user.click(await screen.findByRole('button', { name: /^notes\.txt/ }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('hello')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Edit' }));
    const editor = within(dialog).getByRole('textbox');
    await user.clear(editor);
    await user.type(editor, 'hello world');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ root: 'agent:a1', path: 'notes.txt', content: 'hello world' }));
  });
});
