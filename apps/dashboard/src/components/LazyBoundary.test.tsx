import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lazyNamed } from '../lib/lazy';
import { isChunkError, LazyBoundary } from './LazyBoundary';

describe('LazyBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a skeleton (never a blank screen) while the chunk loads, then the screen', async () => {
    let resolve: (m: { Page: () => JSX.Element }) => void = () => {};
    const Page = lazyNamed(() => new Promise<{ Page: () => JSX.Element }>((r) => (resolve = r)), 'Page');
    render(
      <LazyBoundary>
        <Page />
      </LazyBoundary>,
    );
    expect(screen.getByTestId('page-skeleton')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    resolve({ Page: () => <h1>Ready</h1> });
    expect(await screen.findByRole('heading', { name: 'Ready' })).toBeInTheDocument();
  });

  it('explains a chunk that cannot be loaded and offers a reload', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Broken = lazyNamed(() => Promise.reject<{ X: () => JSX.Element }>(new TypeError('Failed to fetch dynamically imported module: /assets/X.js')), 'X');
    render(
      <LazyBoundary>
        <Broken />
      </LazyBoundary>,
    );
    expect(await screen.findByText('Could not load this screen')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload NEBULA' })).toBeInTheDocument();
    expect(isChunkError(new Error('Importing a module script failed.'))).toBe(true);
    expect(isChunkError(new Error('boom'))).toBe(false);
  });
});
