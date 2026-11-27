import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanHash, goBack, hidesTabBar, historyIndex, initRouter, isTabRoot, navigate, parentPath, parseMiniHash, startParamToPath, tabFor, useMiniRoute } from './router';

describe('Mini App deep links', () => {
  it('strips Telegram launch parameters appended to the hash', () => {
    expect(cleanHash('#/agents/a1/desktop?tgWebAppData=query_id%3DX&tgWebAppVersion=8.0&tgWebAppPlatform=ios')).toBe('/agents/a1/desktop');
    expect(cleanHash('#tgWebAppData=query_id%3DX&tgWebAppVersion=8.0')).toBe('/');
    expect(cleanHash('#/tasks/t1&tgWebAppData=x&tgWebAppThemeParams=%7B%7D')).toBe('/tasks/t1');
    expect(cleanHash('#/files?root=agent%3Aa1&path=src&tgWebAppVersion=8.0')).toBe('/files?root=agent%3Aa1&path=src');
    expect(cleanHash('')).toBe('/');
    expect(cleanHash('#/companies/c1/')).toBe('/companies/c1');
  });

  it('parses the routes used by NEBULA Telegram buttons', () => {
    expect(parseMiniHash('#/agents/a1').segments).toEqual(['agents', 'a1']);
    expect(parseMiniHash('#/agents/a1/desktop?tgWebAppData=x').segments).toEqual(['agents', 'a1', 'desktop']);
    expect(parseMiniHash('#/tasks/t-9').segments).toEqual(['tasks', 't-9']);
    expect(parseMiniHash('#/companies/c%201').segments).toEqual(['companies', 'c 1']);
    const f = parseMiniHash('#/files?root=agent%3Aa1&path=a%2Fb');
    expect(f.query.get('root')).toBe('agent:a1');
    expect(f.query.get('path')).toBe('a/b');
  });

  it('maps startapp parameters (only [A-Za-z0-9_-]) to routes', () => {
    const id = '3f2a9c1e-1111-4a4a-9b9b-123456789abc';
    expect(startParamToPath(`agent_${id}`)).toBe(`/agents/${id}`);
    expect(startParamToPath(`agent_${id}_desktop`)).toBe(`/agents/${id}/desktop`);
    expect(startParamToPath(`desktop_${id}`)).toBe(`/agents/${id}/desktop`);
    expect(startParamToPath(`agent_${id}_files`)).toBe(`/agents/${id}/files`);
    expect(startParamToPath(`task_${id}`)).toBe(`/tasks/${id}`);
    expect(startParamToPath(`company_${id}`)).toBe(`/companies/${id}`);
    expect(startParamToPath(`run_${id}`)).toBe(`/company-runs/${id}`);
    expect(startParamToPath('approvals')).toBe('/approvals');
    expect(startParamToPath('notifications')).toBe('/notifications');
    // V3.2: conversations, Activity, Password Vault, agent sections
    expect(startParamToPath(`chat_${id}`)).toBe(`/chats/${id}`);
    expect(startParamToPath(`conversation_${id}`)).toBe(`/chats/${id}`);
    expect(startParamToPath('activity')).toBe('/activity');
    expect(startParamToPath('chats')).toBe('/');
    expect(startParamToPath('vault')).toBe('/settings/vault');
    expect(startParamToPath(`agent_${id}_vault`)).toBe(`/agents/${id}/vault`);
    expect(startParamToPath(`agent_${id}_security`)).toBe(`/agents/${id}/security`);
    expect(startParamToPath('nonsense')).toBeNull();
    expect(startParamToPath('agent_../../x')).toBeNull();
    expect(startParamToPath(null)).toBeNull();
  });

  it('knows tabs, tab roots and logical parents for Back', () => {
    expect(tabFor({ segments: [] })).toBe('chats');
    expect(tabFor({ segments: ['chats', 'c1'] })).toBe('chats');
    expect(tabFor({ segments: ['agents', 'a1'] })).toBe('chats'); // the agent's chat
    expect(tabFor({ segments: ['agents'] })).toBe('agents');
    expect(tabFor({ segments: ['agents', 'a1', 'details'] })).toBe('agents');
    expect(tabFor({ segments: ['tasks', 't1'] })).toBe('activity');
    expect(tabFor({ segments: ['approvals'] })).toBe('activity');
    expect(tabFor({ segments: ['company-runs', 'r1'] })).toBe('settings');
    expect(tabFor({ segments: ['workflows'] })).toBe('settings');
    expect(tabFor({ segments: ['settings', 'vault'] })).toBe('settings');
    expect(isTabRoot({ path: '/' })).toBe(true);
    expect(isTabRoot({ path: '/agents' })).toBe(true);
    expect(isTabRoot({ path: '/activity' })).toBe(true);
    expect(isTabRoot({ path: '/approvals' })).toBe(true);
    expect(isTabRoot({ path: '/settings' })).toBe(true);
    expect(isTabRoot({ path: '/agents/a1' })).toBe(false);
    expect(isTabRoot({ path: '/settings/vault' })).toBe(false);
    // the Live Desktop closes back into the agent's chat; the chat goes back to Chats
    expect(parentPath({ segments: ['agents', 'a1', 'desktop'] })).toBe('/agents/a1');
    expect(parentPath({ segments: ['agents', 'a1'] })).toBe('/');
    expect(parentPath({ segments: ['chats', 'c1'] })).toBe('/');
    expect(parentPath({ segments: ['archived'] })).toBe('/');
    expect(tabFor({ segments: ['archived'] })).toBe('chats');
    expect(parentPath({ segments: ['agents', 'a1', 'details'] })).toBe('/agents');
    expect(parentPath({ segments: ['agents', 'a1', 'memory'] })).toBe('/agents/a1/details');
    expect(parentPath({ segments: ['agents', 'a1', 'vault'] })).toBe('/agents/a1/details');
    expect(parentPath({ segments: ['tasks', 't1'] })).toBe('/activity');
    expect(parentPath({ segments: ['company-runs', 'r1'] })).toBe('/companies');
    expect(parentPath({ segments: ['companies'] })).toBe('/settings');
    expect(parentPath({ segments: ['workflow-runs', 'r1'] })).toBe('/workflows');
    expect(parentPath({ segments: ['settings', 'vault'] })).toBe('/settings');
    expect(parentPath({ segments: ['notifications'] })).toBe('/settings');
    expect(parentPath({ segments: ['files'] })).toBe('/settings');
    // V3.2.2: the agent creator sits over the Agents tab; agent settings go back to the agent's details
    expect(tabFor({ segments: ['agents', 'new'] })).toBe('agents');
    expect(parentPath({ segments: ['agents', 'new'] })).toBe('/agents');
    expect(isTabRoot({ path: '/agents/new' })).toBe(false);
    expect(tabFor({ segments: ['agents', 'a1', 'settings'] })).toBe('agents');
    expect(parentPath({ segments: ['agents', 'a1', 'settings'] })).toBe('/agents/a1/details');
    expect(startParamToPath('agent_new')).toBe('/agents/new');
    expect(startParamToPath('agent_a1_settings')).toBe('/agents/a1/settings');
  });

  it('hides the tab bar only in full-screen views (a conversation, the Live Desktop)', () => {
    expect(hidesTabBar({ segments: ['chats', 'c1'] })).toBe(true);
    expect(hidesTabBar({ segments: ['agents', 'a1'] })).toBe(true);
    expect(hidesTabBar({ segments: ['agents', 'a1', 'chat'] })).toBe(true);
    expect(hidesTabBar({ segments: ['agents', 'a1', 'desktop'] })).toBe(true);
    expect(hidesTabBar({ segments: [] })).toBe(false);
    expect(hidesTabBar({ segments: ['agents'] })).toBe(false);
    expect(hidesTabBar({ segments: ['agents', 'a1', 'details'] })).toBe(false);
    expect(hidesTabBar({ segments: ['settings', 'vault'] })).toBe(false);
    expect(hidesTabBar({ segments: ['agents', 'new'] })).toBe(false);
  });
});

describe('Mini App history', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('cleans the URL at boot and applies a startapp deep link only when the hash has no route', () => {
    window.history.replaceState(null, '', '/mini/#tgWebAppData=abc&tgWebAppVersion=8.0');
    initRouter('task_t1');
    expect(window.location.hash).toBe('#/tasks/t1');
    expect(historyIndex()).toBe(0);

    window.history.replaceState(null, '', '/mini/#/companies/c1?tgWebAppData=abc');
    initRouter('task_t1');
    expect(window.location.hash).toBe('#/companies/c1');

    window.history.replaceState(null, '', '/mini/#tgWebAppData=abc');
    initRouter('chat_c1');
    expect(window.location.hash).toBe('#/chats/c1');
  });

  it('numbers history entries so Back mirrors in-app navigation, falling back to the parent for deep links', async () => {
    window.history.replaceState(null, '', '/mini/#/agents/a1/desktop');
    initRouter(null);
    const { result } = renderHook(() => useMiniRoute());
    expect(result.current.path).toBe('/agents/a1/desktop');
    expect(result.current.index).toBe(0);

    // no in-app history: Back goes to the logical parent (replace, the Telegram link is not re-entered)
    act(() => goBack('/agents'));
    expect(window.location.hash).toBe('#/agents');
    expect(historyIndex()).toBe(0);

    act(() => navigate('/agents/a2'));
    expect(result.current.path).toBe('/agents/a2');
    expect(historyIndex()).toBe(1);

    const popped = new Promise<void>((resolve) => window.addEventListener('popstate', () => resolve(), { once: true }));
    act(() => goBack('/agents'));
    await act(async () => {
      await popped;
    });
    expect(window.location.hash).toBe('#/agents');
    expect(historyIndex()).toBe(0);
  });
});
