// A tiny typed i18n helper. English is the default and the only required locale: `en.ts` is the source of truth and its
// keys are the type of every `t()` call, so a misspelled key or a missing {param} fails `pnpm typecheck`. Czech (`cs.ts`)
// is an optional, partial translation — any key it does not define falls back to English.
//
// The locale is a per-browser preference (localStorage `nebula.locale`); nothing is detected from the browser language,
// so a fresh install always starts in English. `setLocale()` stores the choice; the next page load picks it up.
import { cs } from './cs';
import { en } from './en';

export type Locale = 'en' | 'cs';
export const LOCALES: readonly { id: Locale; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'cs', label: 'Čeština' },
];

type Messages = typeof en;
export type MessageKey = keyof Messages;

/** "Hello {name}" → "name". */
type ParamNames<S extends string> = S extends `${string}{${infer P}}${infer Rest}` ? P | ParamNames<Rest> : never;
export type Args<K extends MessageKey> = [ParamNames<Messages[K]>] extends [never] ? [] : [params: Record<ParamNames<Messages[K]>, string | number>];

export type MessageBundle = Partial<Record<MessageKey | `${PluralBase}.${'zero' | 'two' | 'few' | 'many'}`, string>>;

/** `foo.bar` for every `foo.bar.other` key: those messages come in plural forms (`.one`, `.few`, `.other`). */
export type PluralBase = MessageKey extends infer K ? (K extends `${infer B}.other` ? B : never) : never;

const BUNDLES: Record<Locale, MessageBundle> = { en, cs };
const STORAGE_KEY = 'nebula.locale';

function readStored(): Locale {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_KEY);
    return v === 'cs' || v === 'en' ? v : 'en';
  } catch {
    return 'en'; // storage can be blocked (private window, embedded view)
  }
}

let current: Locale = readStored();

export const getLocale = (): Locale => current;

/** Switches the language for the messages looked up from now on, and remembers the choice in this browser. */
export function setLocale(locale: Locale): void {
  current = locale;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, locale);
  } catch {
    // not remembered; this page still switches
  }
}

function format(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

function lookup(key: string): string {
  const bundle = BUNDLES[current] as Record<string, string | undefined>;
  return bundle[key] ?? (en as Record<string, string>)[key] ?? key;
}

/** The message for `key` in the current language, with `{param}` placeholders filled in. */
export function t<K extends MessageKey>(key: K, ...args: Args<K>): string {
  return format(lookup(key), args[0] as Record<string, string | number> | undefined);
}

/** A counted message: `tp('foo.bar', 3)` picks `foo.bar.one|few|other` by the language's plural rules; `{n}` is the count. */
export function tp(base: PluralBase, n: number, params?: Record<string, string | number>): string {
  const category = new Intl.PluralRules(current).select(n);
  const bundle = BUNDLES[current] as Record<string, string | undefined>;
  const key = bundle[`${base}.${category}`] !== undefined ? `${base}.${category}` : `${base}.other`;
  return format(lookup(key), { n, ...params });
}
