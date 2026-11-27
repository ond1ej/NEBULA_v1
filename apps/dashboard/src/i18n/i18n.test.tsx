import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { relativeAgo } from '../features/devices/api';
import { confirmErrorText } from '../mini/stepup/ConfirmSheet';
import { cs } from './cs';
import { en } from './en';
import { getLocale, setLocale, t, tp } from './index';
import { rich } from './rich';

let store: Map<string, string>;
beforeEach(() => {
  store = new Map();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
});
afterEach(() => {
  setLocale('en');
  vi.unstubAllGlobals();
});

describe('i18n', () => {
  it('is English by default', () => {
    expect(getLocale()).toBe('en');
    expect(t('devices.pair')).toBe('Pair an iPhone or Mac');
  });

  it('fills {params}', () => {
    expect(t('devices.rename', { name: 'My iPhone' })).toBe('Rename My iPhone');
  });

  it('switches to Czech, remembers the choice, and falls back to English for keys Czech does not define', () => {
    setLocale('cs');
    expect(getLocale()).toBe('cs');
    expect(store.get('nebula.locale')).toBe('cs');
    expect(t('devices.pair')).toBe('Spárovat iPhone nebo Mac');
    const bundle = cs as Record<string, string | undefined>;
    delete bundle['devices.remove.body2'];
    try {
      expect(t('devices.remove.body2')).toBe(en['devices.remove.body2']);
    } finally {
      bundle['devices.remove.body2'] = 'Aby se mohlo znovu připojit, bude potřeba ho spárovat znovu.';
    }
  });

  it('plural forms follow the language (Czech has a separate 2-4 form)', () => {
    expect(tp('confirm.attempts', 1)).toBe('1 attempt left');
    expect(tp('confirm.attempts', 4)).toBe('4 attempts left');
    setLocale('cs');
    expect(tp('confirm.attempts', 1)).toBe('Zbývá 1 pokus');
    expect(tp('confirm.attempts', 4)).toBe('Zbývají 4 pokusy');
    expect(tp('confirm.attempts', 5)).toBe('Zbývá 5 pokusů');
  });

  it('every Czech message has an English source with the same {placeholders}', () => {
    const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    for (const [key, value] of Object.entries(cs)) {
      const source = (en as Record<string, string>)[key] ?? (en as Record<string, string>)[key.replace(/\.(zero|two|few|many)$/, '.other')];
      expect(source, `${key} has no English source`).toBeDefined();
      expect(names(value as string), key).toBe(names(source));
    }
  });

  it('rich() renders **bold** as <strong>', () => {
    render(<p>{rich('devices.remove.body1')}</p>);
    expect(screen.getByText('signed out').tagName).toBe('STRONG');
    expect(screen.getByText('Password Vault key').tagName).toBe('STRONG');
  });

  it('relative times and confirmation errors are in the current language', () => {
    expect(relativeAgo(null)).toBe('never');
    expect(relativeAgo(1000, 1100)).toBe('2 min ago');
    expect(relativeAgo(1000, 1000 + 86400)).toBe('yesterday');
    expect(relativeAgo(1000, 1000 + 3 * 86400)).toBe('3 days ago');
    setLocale('cs');
    expect(relativeAgo(null)).toBe('nikdy');
    expect(relativeAgo(1000, 1100)).toBe('před 2 min');
    expect(confirmErrorText(new Error('boom'))).toBe('boom');
  });
});
