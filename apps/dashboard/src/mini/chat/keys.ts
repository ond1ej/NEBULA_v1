// Query-cache keys and the cached shape of a conversation's messages (shared by Chats, which prefetches on touch,
// and the conversation screen). Kept tiny: it ships with the initial shell.
import type { Message } from '../types';

/** Messages of one conversation in the query cache: ascending, older pages appended as they load. */
export interface ChatData {
  items: Message[];
  hasMore: boolean;
}

export const CONVERSATIONS_KEY = 'conversations';
export const convKey = (id: string) => `conversation:${id}`;
export const msgsKey = (id: string) => `conv-msgs:${id}`;
export const agentConvKey = (agentId: string) => `agent-conv:${agentId}`;
export const legacyMsgsKey = (agentId: string) => `messages:${agentId}`;
export const draftKey = (id: string) => `nebula.mini.draft.${id}`;

/** One-line preview of a message for the chat list (markdown markers and whitespace collapsed). */
export function previewText(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
