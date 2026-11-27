// One pending owner approval (CEO plan) with approve / deny.
import { api } from '../../api';
import { Button } from '../../components/ui';
import { useAction } from '../../hooks/useApi';
import { formatTime, relativeTime } from '../../lib/format';
import type { OwnerApproval } from '../../types';

export function ApprovalRow({ a, onDone }: { a: OwnerApproval; onDone: () => void }) {
  const { run, isPending } = useAction();
  const decide = async (decision: 'approved' | 'denied') => {
    const r = await run(decision, () => api.ownerApprovals.resolve(a.id, decision), { success: decision === 'approved' ? 'Plan approved' : 'Plan denied — run cancelled' });
    if (r) onDone();
  };
  return (
    <li className="list-none rounded-lg border border-warn/30 bg-warn/[0.05] p-3">
      <p className="text-sm break-words whitespace-pre-wrap text-text">{a.summary}</p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" loading={isPending('approved')} disabled={isPending('denied')} onClick={() => void decide('approved')}>
          Approve plan
        </Button>
        <Button size="sm" variant="danger" loading={isPending('denied')} disabled={isPending('approved')} onClick={() => void decide('denied')}>
          Deny
        </Button>
        <span className="ml-auto text-xs text-subtle" title={formatTime(a.expires_at)}>
          expires {relativeTime(a.expires_at)}
        </span>
      </div>
    </li>
  );
}
