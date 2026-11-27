// Composer drafts per conversation in localStorage (`nebula.mini.draft.<conversationId>`): text only — attachments,
// recordings and anything else are never persisted.
import { draftKey } from './keys';

const MAX = 8000;

export function loadDraft(id: string): string {
  try {
    return window.localStorage.getItem(draftKey(id)) ?? '';
  } catch {
    return '';
  }
}

export function saveDraft(id: string, text: string): void {
  try {
    if (text.trim()) window.localStorage.setItem(draftKey(id), text.slice(0, MAX));
    else window.localStorage.removeItem(draftKey(id));
  } catch {
    // private mode / quota: the draft lives as long as the screen
  }
}
