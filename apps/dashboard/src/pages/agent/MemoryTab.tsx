import { MemoryManager } from '../../components/MemoryManager';
import type { Agent } from '../../types';

export function MemoryTab({ agent, onAgentChanged }: { agent: Agent; onAgentChanged?: () => void }) {
  return <MemoryManager agent={agent} onAgentChanged={onAgentChanged} />;
}
