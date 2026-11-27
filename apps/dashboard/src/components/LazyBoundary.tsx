// Suspense + error boundary for code-split screens: a skeleton while the chunk loads (never a blank screen) and a
// recoverable error when it cannot be loaded (offline, or the host was updated and the old chunk is gone).
import { Component, Suspense, type ErrorInfo, type ReactNode } from 'react';
import { Button, ErrorBanner, Skeleton } from './ui';

/** Dynamic import failures look like this in Chromium, Firefox and Safari. */
export function isChunkError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /dynamically imported module|Importing a module script failed|error loading dynamically|Failed to fetch|ChunkLoadError/i.test(msg);
}

interface BoundaryProps {
  children: ReactNode;
  /** Changing it clears a shown error (e.g. the route path). */
  resetKey?: string;
  compact?: boolean;
}

class ChunkErrorBoundary extends Component<BoundaryProps, { error: unknown; key?: string }> {
  state: { error: unknown; key?: string } = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: { error: unknown; key?: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('NEBULA: screen failed to render', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const chunk = isChunkError(error);
    return (
      <div className={this.props.compact ? 'py-2' : 'py-6'}>
        <ErrorBanner
          error={chunk ? new Error('This part of NEBULA could not be loaded. The host may have been updated or the connection dropped.') : error}
          title={chunk ? 'Could not load this screen' : 'This screen failed to render'}
          onRetry={() => this.setState({ error: null })}
        />
        {chunk && (
          <div className="mt-3">
            <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>
              Reload NEBULA
            </Button>
          </div>
        )}
      </div>
    );
  }
}

/** Placeholder with the rough shape of a page (header + content) while its chunk loads. */
export function PageSkeleton({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="animate-fade-in space-y-5" data-testid="page-skeleton">
      <span className="sr-only" role="status">
        {label}
      </span>
      <div className="space-y-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-3.5 w-full max-w-md" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}

/** Smaller placeholder for a lazily loaded panel / tab inside a page. */
export function PanelSkeleton({ label = 'Loading…', className = 'h-72' }: { label?: string; className?: string }) {
  return (
    <div className="animate-fade-in" data-testid="panel-skeleton">
      <span className="sr-only" role="status">
        {label}
      </span>
      <Skeleton className={`w-full rounded-xl ${className}`} />
    </div>
  );
}

export function LazyBoundary({ children, fallback, resetKey, compact }: BoundaryProps & { fallback?: ReactNode }) {
  return (
    <ChunkErrorBoundary resetKey={resetKey} compact={compact}>
      <Suspense fallback={fallback ?? <PageSkeleton />}>{children}</Suspense>
    </ChunkErrorBoundary>
  );
}
