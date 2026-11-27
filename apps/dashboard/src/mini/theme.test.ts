import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMemoryStorage, telegram } from './test/kit';
import { applyTheme, getThemeMode, initTheme, resolveScheme, setThemeMode, THEME_KEY } from './theme';

// mini.css imports its tokens from tokens.css (shared with the administration area's stylesheet)
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, 'mini.css'), 'utf8') + readFileSync(join(here, 'tokens.css'), 'utf8');
const block = (start: string) => {
  const i = css.indexOf(start);
  return css.slice(i, css.indexOf('\n}', i));
};

function mockPrefersLight(light: boolean) {
  const listeners: (() => void)[] = [];
  const mq = { matches: light, addEventListener: (_: string, cb: () => void) => listeners.push(cb), removeEventListener: vi.fn() };
  vi.stubGlobal('matchMedia', vi.fn(() => mq));
  window.matchMedia = globalThis.matchMedia;
  return { mq, fire: () => listeners.forEach((l) => l()) };
}

describe('Mini App theme', () => {
  beforeEach(() => {
    installMemoryStorage();
    setThemeMode('system', null);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.Telegram;
    delete document.documentElement.dataset.theme;
    // @ts-expect-error jsdom has no matchMedia by default
    delete window.matchMedia;
  });

  it('defines the NEBULA dark palette by default and the light palette under [data-theme=light]', () => {
    const dark = block('@theme {');
    for (const [name, value] of [
      ['--color-bg', '#101114'],
      ['--color-panel', '#191b20'],
      ['--color-panel-2', '#22252b'],
      ['--color-panel-3', '#2a2d35'],
      ['--color-text', '#f5f6f8'],
      ['--color-muted', '#9b9fa9'],
      ['--color-accent', '#8b7cf6'],
      ['--color-accent-hover', '#a397ff'],
      ['--color-success', '#36c991'],
      ['--color-warn', '#f4b860'],
      ['--color-danger', '#f07178'],
    ]) {
      expect(dark).toContain(`${name}: ${value};`);
    }
    const light = block(":root[data-theme='light'] {");
    for (const [name, value] of [
      ['--color-bg', '#f7f8fa'],
      ['--color-panel', '#ffffff'],
      ['--color-panel-2', '#f0f2f5'],
      ['--color-text', '#17191e'],
      ['--color-muted', '#666c78'],
      ['--color-accent', '#7464e8'],
    ]) {
      expect(light).toContain(`${name}: ${value};`);
    }
    expect(dark).toContain("--font-sans: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it('Dark / Light are stored in localStorage (nebula.mini.theme) and applied with Telegram chrome to match', () => {
    const wa = telegram({ colorScheme: 'dark' });
    setThemeMode('light', wa);
    expect(window.localStorage.getItem(THEME_KEY)).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(wa.setHeaderColor).toHaveBeenLastCalledWith('#F7F8FA');
    expect(wa.setBottomBarColor).toHaveBeenLastCalledWith('#FFFFFF');
    setThemeMode('dark', wa);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(wa.setBackgroundColor).toHaveBeenLastCalledWith('#101114');
    // System forgets the explicit choice
    setThemeMode('system', wa);
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
    expect(getThemeMode()).toBe('system');
  });

  it('System follows Telegram colorScheme and its themeChanged event', () => {
    const wa = telegram({ colorScheme: 'light' });
    const stop = initTheme(wa);
    expect(document.documentElement.dataset.theme).toBe('light');
    const onTheme = vi.mocked(wa.onEvent).mock.calls.find(([e]) => e === 'themeChanged')?.[1] as () => void;
    wa.colorScheme = 'dark';
    onTheme();
    expect(document.documentElement.dataset.theme).toBe('dark');
    // an explicit choice wins over Telegram
    setThemeMode('light', wa);
    wa.colorScheme = 'dark';
    onTheme();
    expect(document.documentElement.dataset.theme).toBe('light');
    stop();
    expect(wa.offEvent).toHaveBeenCalledWith('themeChanged', onTheme);
  });

  it('outside Telegram, System follows prefers-color-scheme', () => {
    const media = mockPrefersLight(true);
    expect(resolveScheme('system', null)).toBe('light');
    const stop = initTheme(null);
    expect(document.documentElement.dataset.theme).toBe('light');
    media.mq.matches = false;
    media.fire();
    expect(document.documentElement.dataset.theme).toBe('dark');
    stop();
    expect(applyTheme(null)).toBe('dark');
  });
});
