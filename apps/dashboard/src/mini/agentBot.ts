// An agent's own Telegram bot (session role "agent_bot"). The host lets such a session reach only that one agent's
// chat, its tasks, commands and screenshot (authz.AGENT_BOT_ROUTES); everything else answers 403
// `not_available_to_agent_bot`. The Mini App therefore shows just that agent's chat (its home), the agent's tasks and
// a task's details, plus the Live Desktop when the session holds the desktop permission (the owner watching their own
// agent). There is no tab bar, no approval badge and no settings. Pure route logic, tested on its own.

export type AgentBotView =
  /** The agent's chat (`conversationId`: one of its other conversations). */
  | { kind: 'chat'; agentId: string; conversationId?: undefined }
  | { kind: 'chat'; conversationId: string; agentId?: undefined }
  | { kind: 'desktop'; agentId: string }
  | { kind: 'tasks'; agentId: string }
  | { kind: 'task'; taskId: string }
  /** Another agent, or a screen this bot cannot reach. */
  | { kind: 'unavailable' };

/** What a route shows for the agent bot whose agent is `mine`. */
export function agentBotView(segments: string[], mine: string): AgentBotView {
  const [a = '', b, c] = segments;
  switch (a) {
    case '':
      return { kind: 'chat', agentId: mine };
    case 'chats':
      return b ? { kind: 'chat', conversationId: b } : { kind: 'chat', agentId: mine };
    case 'agents':
      if (!b) return { kind: 'chat', agentId: mine };
      if (b !== mine) return { kind: 'unavailable' };
      if (!c || c === 'chat') return { kind: 'chat', agentId: mine };
      if (c === 'desktop') return { kind: 'desktop', agentId: mine };
      return { kind: 'tasks', agentId: mine }; // details, tasks and the other agent sections: the agent's tasks
    case 'tasks':
      return b ? { kind: 'task', taskId: b } : { kind: 'tasks', agentId: mine };
    case 'activity':
      return { kind: 'tasks', agentId: mine };
    default:
      return { kind: 'unavailable' };
  }
}

/**
 * Where Back goes (Telegram's BackButton when there is no in-app history); null on the agent's chat, the home of an
 * agent bot, where the BackButton is hidden (Android back closes the Mini App there).
 */
export function agentBotParent(segments: string[]): string | null {
  const [a = '', b, c] = segments;
  if (a === '' || (a === 'chats' && !b) || (a === 'agents' && (!c || c === 'chat'))) return null;
  if (a === 'tasks' && b) return '/tasks';
  return '/';
}

/** Full-screen routes (the chat and the Live Desktop viewer), whichever agent the path names. */
export function agentBotFullScreen(segments: string[]): boolean {
  const kind = agentBotView(segments, segments[0] === 'agents' ? (segments[1] ?? '') : '').kind;
  return kind === 'chat' || kind === 'desktop';
}
