// Route base (V3.3): the Mini App mounts the Dashboard's pages under #/admin; href()/navigate() add the base and
// useHashRoute() removes it. Without a base (the Dashboard) nothing changes.
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { getRouteBase, href, navigate, setRouteBase, stripRouteBase, useHashRoute, withRouteBase } from './useHashRoute';

describe('route base', () => {
  afterEach(() => {
    setRouteBase('');
    window.history.replaceState(null, '', '/');
  });

  it('without a base: Dashboard links are unchanged', () => {
    expect(getRouteBase()).toBe('');
    expect(href('/agents/a1')).toBe('#/agents/a1');
    expect(href('agents')).toBe('#/agents');
    expect(href('/')).toBe('#/');
    navigate('/tasks?state=FAILED');
    expect(window.location.hash).toBe('#/tasks?state=FAILED');
  });

  it("under '/admin': href() and navigate() stay inside the Mini App's administration area", () => {
    setRouteBase('/admin');
    expect(href('/agents/a1')).toBe('#/admin/agents/a1');
    expect(href('/agents/a1/tasks?task=t1')).toBe('#/admin/agents/a1/tasks?task=t1');
    expect(href('/')).toBe('#/admin');
    expect(withRouteBase('/admin/files')).toBe('/admin/files'); // never twice
    navigate('/workflows/w1');
    expect(window.location.hash).toBe('#/admin/workflows/w1');
    navigate(href('/files?root=ws')); // a hash from href() is kept as is
    expect(window.location.hash).toBe('#/admin/files?root=ws');
  });

  it('replace keeps the history entry state (the Mini App numbers its entries there)', () => {
    setRouteBase('/admin');
    window.history.replaceState({ nbIdx: 7 }, '', '#/admin/agents');
    navigate('/agents/a1', { replace: true });
    expect(window.location.hash).toBe('#/admin/agents/a1');
    expect(window.history.state).toEqual({ nbIdx: 7 });
  });

  it('useHashRoute() reports the Dashboard path without the base', async () => {
    setRouteBase('/admin');
    window.history.replaceState(null, '', '#/admin/workflows/w1?run=r1');
    const { result } = renderHook(() => useHashRoute());
    expect(result.current.path).toBe('/workflows/w1');
    expect(result.current.segments).toEqual(['workflows', 'w1']);
    expect(result.current.query.get('run')).toBe('r1');
    navigate('/files');
    await waitFor(() => expect(result.current.segments).toEqual(['files']));
    expect(stripRouteBase('/admin')).toBe('/');
  });
});
