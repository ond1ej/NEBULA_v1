// Host Permissions Manager (#/host). The page is loaded on demand (own chunk); see HostAccess.tsx.
import { lazy, Suspense } from 'react';
import { LoadingCards } from '../../components/ui';

const HostAccess = lazy(() => import('./HostAccess').then((m) => ({ default: m.HostAccess })));

export function HostAccessPage(_props: Record<string, never>) {
  return (
    <Suspense fallback={<LoadingCards count={3} label="Loading Host Access…" />}>
      <HostAccess />
    </Suspense>
  );
}
