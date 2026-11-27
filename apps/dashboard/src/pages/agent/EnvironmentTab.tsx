// Agent tab "Environment": the Execution Environment Selector (features/environment), loaded on demand.
import { lazy, Suspense } from 'react';
import { Card, LoadingRows } from '../../components/ui';
import type { Agent } from '../../types';

const EnvironmentSelector = lazy(() => import('../../features/environment/EnvironmentSelector').then((m) => ({ default: m.EnvironmentSelector })));

export function EnvironmentTab({ agent, onChanged }: { agent: Agent; onChanged: () => void }) {
  return (
    <Suspense
      fallback={
        <Card>
          <LoadingRows label="Loading execution environment…" />
        </Card>
      }
    >
      <EnvironmentSelector agent={agent} onChanged={onChanged} />
    </Suspense>
  );
}
