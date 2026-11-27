// Code splitting helpers: React.lazy for named exports, with a preload handle so a chunk can be fetched before it
// renders (e.g. in parallel with the auth check, or when the pointer reaches a navigation link).
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>;

export type Preloadable<C extends AnyComponent> = LazyExoticComponent<C> & { preload: () => Promise<unknown> };

/** The component type of a module export, with its own props (not widened to `any`). */
type ComponentOf<T> = T extends ComponentType<infer P> ? ComponentType<P> : never;

/** One cached dynamic import: every caller (preload or render) shares the same promise. */
export function once<M>(load: () => Promise<M>): () => Promise<M> {
  let p: Promise<M> | null = null;
  return () => {
    if (!p) {
      p = load().catch((e: unknown) => {
        p = null; // a failed chunk (offline, redeploy) may be retried
        throw e;
      });
    }
    return p;
  };
}

/** React.lazy for a named export: `lazyNamed(() => import('./pages/X'), 'XPage')`. */
export function lazyNamed<M, K extends keyof M>(load: () => Promise<M>, key: K): Preloadable<ComponentOf<M[K]>> {
  const get = once(load);
  const C = lazy(() => get().then((m) => ({ default: m[key] as ComponentOf<M[K]> }))) as Preloadable<ComponentOf<M[K]>>;
  C.preload = () => get().catch(() => undefined);
  return C;
}
