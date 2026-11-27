import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../api';
import { ToastProvider } from '../components/Toast';
import { installFetch, ok } from '../test/fetchMock';
import { CreateAgentPage } from './CreateAgentPage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

function renderPage(query?: URLSearchParams) {
  installFetch({ 'GET /api/v1/providers': () => ok([]), 'GET /api/v1/settings': () => ok({ config: {}, permission_levels: {} }) });
  render(
    <ToastProvider>
      <CreateAgentPage query={query} />
    </ToastProvider>,
  );
}

describe('CreateAgentPage', () => {
  it('starts empty normally and pre-fills a friendly name when opened from the first-run checklist', async () => {
    renderPage();
    expect(await screen.findByLabelText(/^Name/)).toHaveValue('');
    cleanup();
    renderPage(new URLSearchParams('first=1'));
    expect(await screen.findByLabelText(/^Name/)).toHaveValue('Assistant');
  });
});
