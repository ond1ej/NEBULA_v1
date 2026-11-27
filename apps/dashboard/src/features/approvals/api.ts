// Typed client for the V3 approval center (GET /approval-center) and the two decision endpoints.
import { request } from '../../api';
import type { Epoch, Json } from '../../types';
import type { SignInItem } from '../smartauth/core/types';

const enc = encodeURIComponent;

export type Decision = 'approved' | 'denied';

export interface TaskApprovalItem {
  kind: 'task';
  id: string;
  task_id: string;
  agent_id: string;
  agent_name: string | null;
  tool: string;
  action_summary: string;
  action_preview: Json | null;
  reason: string | null;
  requested_by: string;
  resolved_by: string | null;
  decision: string | null;
  created_at: Epoch;
  expires_at: Epoch;
  resolved_at: Epoch | null;
  prompt: string;
  environment: 'vm' | 'host' | string;
  parent_ref: Json | null;
}

export interface OwnerApprovalItem {
  kind: 'workflow' | 'command' | 'schedule_misfire' | 'package_install' | 'plugin' | 'company_plan' | string;
  id: string;
  ref: Json | null;
  summary: string;
  preview: Json | null;
  decision: string | null;
  resolved_by: string | null;
  created_at: Epoch;
  expires_at: Epoch;
  resolved_at: Epoch | null;
}

export type CenterItem = TaskApprovalItem | OwnerApprovalItem;

export interface RecentDecision {
  id: string;
  tool: string;
  decision: 'approved' | 'denied' | 'expired' | string;
  resolved_by: string | null;
  resolved_at: Epoch | null;
  action_summary: string;
}

export interface ApprovalCenterData {
  pending: CenterItem[];
  recent: RecentDecision[];
  /** NEBULA 3.2.1: active Smart Authentication sessions (same objects as GET /smart-auth/sessions). */
  sign_ins?: SignInItem[];
}

export const approvalsApi = {
  center: (signal?: AbortSignal) => request<ApprovalCenterData>('/approval-center', { signal }),
  decideTask: (id: string, decision: Decision) => request<{ id: string; decision: string | null }>(`/approvals/${enc(id)}`, { method: 'POST', body: { decision } }),
  decideOwner: (id: string, decision: Decision) => request<{ id: string; decision: string | null }>(`/owner-approvals/${enc(id)}`, { method: 'POST', body: { decision } }),
};

export function isTaskItem(a: CenterItem): a is TaskApprovalItem {
  return a.kind === 'task';
}

/** Policy categories (nebula_runtime/policy.py) whose approval can destroy data, change the system or spend money. */
export const DESTRUCTIVE_CATEGORIES = ['mass_delete', 'host_delete', 'system_change', 'system_install', 'privileged', 'payment', 'credential_entry'];
export const DESTRUCTIVE_OWNER_KINDS = ['package_install', 'command', 'plugin'];

const CATEGORY_RE = /\b(privileged|mass_delete|external_share|payment|credential_entry|outbound_message|system_change|system_install|host_delete|sensitive_file|explicit_request)\b/g;

export function riskCategories(reason: string | null | undefined): string[] {
  return [...new Set((reason ?? '').match(CATEGORY_RE) ?? [])];
}

export function isDestructive(a: CenterItem): boolean {
  if (isTaskItem(a)) return riskCategories(a.reason).some((c) => DESTRUCTIVE_CATEGORIES.includes(c));
  return DESTRUCTIVE_OWNER_KINDS.includes(a.kind);
}

/** "telegram:123" -> Telegram · 123, "miniapp:…" -> Mini App · …, "user:…" -> Dashboard · … */
export function describeDecider(by: string | null | undefined): { channel: string; who: string } {
  if (!by) return { channel: '—', who: '' };
  if (by === 'system:ttl') return { channel: 'Expired', who: 'no decision in time' };
  const i = by.indexOf(':');
  const pre = i >= 0 ? by.slice(0, i) : by;
  const who = i >= 0 ? by.slice(i + 1) : '';
  const channel =
    pre === 'telegram' ? 'Telegram' : pre === 'miniapp' ? 'Mini App' : pre === 'user' || pre === 'web' ? 'Dashboard' : pre === 'system' ? 'System' : pre === 'agentbot' ? 'Agent bot' : pre;
  return { channel, who };
}
