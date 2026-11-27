// Screens of an agent's own Telegram bot (role "agent_bot", see ../agentBot.ts): the agent's tasks and the notice
// for everything this bot cannot reach. The chat, a task's details and the Live Desktop are the regular screens.
import type { Agent } from '../../types';
import { IcChats } from '../icons';
import { mhref } from '../router';
import { Empty, Screen, Section, tapLinkClass } from '../uiKit';
import { TasksSection } from './AgentDetailScreen';

/** The main NEBULA bot holds everything else; said on every agent-bot screen that is not the chat. */
export const onlyThisAgent = (name: string) =>
  `This bot reaches only ${name}’s chat and tasks. Approvals, files, the Password Vault and the other agents are in the main NEBULA bot.`;

export function AgentBotTasksScreen({ agent }: { agent: Agent }) {
  return (
    <Screen title={agent.name} subtitle="Tasks">
      <Section title="Tasks" footer={onlyThisAgent(agent.name)}>
        <TasksSection agentId={agent.id} />
      </Section>
      <div className="flex justify-center pb-6">
        <a href={mhref('/')} className={tapLinkClass('tinted')}>
          Back to the chat
        </a>
      </div>
    </Screen>
  );
}

export function AgentBotUnavailableScreen({ agent }: { agent: Agent | null }) {
  return (
    <Screen title="Not available here">
      <Empty
        title="Not available in this bot"
        icon={<IcChats />}
        action={
          agent ? (
            <a href={mhref('/')} className={tapLinkClass('primary')}>
              Chat with {agent.name}
            </a>
          ) : undefined
        }
      >
        {agent ? onlyThisAgent(agent.name) : 'This bot is not linked to an agent any more. Open NEBULA from the main bot.'}
      </Empty>
    </Screen>
  );
}
