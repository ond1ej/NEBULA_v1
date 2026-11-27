// The administration area's sections, grouped like the Dashboard's navigation. Each one opens the Dashboard page at
// #/admin/<dashboard path> (Password Vault: the Mini App's own vault screen).
import type { ReactNode } from 'react';
import {
  IconAgents,
  IconApprovals,
  IconBots,
  IconCompanies,
  IconDevices,
  IconFiles,
  IconHost,
  IconKey,
  IconMemory,
  IconOverview,
  IconProviders,
  IconRemote,
  IconResources,
  IconSchedules,
  IconSettings,
  IconSkills,
  IconSystem,
  IconTasks,
  IconTeams,
  IconTelegram,
  IconVoice,
  IconWorkflows,
} from '../../components/icons';
import type { Tone } from '../ui';
import { t } from '../../i18n';

export interface AdminSection {
  id: string;
  group: string;
  title: string;
  subtitle: string;
  icon: ReactNode;
  tone: Tone;
  /** Mini App route (hash path). */
  to: string;
}

export const ADMIN_GROUPS = ['Agents & Automation', 'Work', 'Data', 'Connections', 'System'];

export const ADMIN_SECTIONS: AdminSection[] = [
  { id: 'agents', group: 'Agents & Automation', title: 'Agents', subtitle: 'Create, edit, permissions, environment, delete', icon: <IconAgents />, tone: 'accent', to: '/admin/agents' },
  { id: 'companies', group: 'Agents & Automation', title: 'AI Companies', subtitle: 'Org chart, projects, runs', icon: <IconCompanies />, tone: 'info', to: '/admin/companies' },
  { id: 'teams', group: 'Agents & Automation', title: 'Teams', subtitle: 'Create and run teams', icon: <IconTeams />, tone: 'success', to: '/admin/teams' },
  { id: 'workflows', group: 'Agents & Automation', title: 'Workflows', subtitle: 'Edit the canvas, runs', icon: <IconWorkflows />, tone: 'warning', to: '/admin/workflows' },
  { id: 'schedules', group: 'Agents & Automation', title: 'Schedules', subtitle: 'Create and edit schedules', icon: <IconSchedules />, tone: 'danger', to: '/admin/schedules' },
  { id: 'skills', group: 'Agents & Automation', title: 'Skills', subtitle: 'Install, assign, compatibility', icon: <IconSkills />, tone: 'neutral', to: '/admin/skills' },

  { id: 'overview', group: 'Work', title: 'Command Center', subtitle: 'Everything at a glance', icon: <IconOverview />, tone: 'accent', to: '/admin/overview' },
  { id: 'tasks', group: 'Work', title: 'Tasks', subtitle: 'All tasks, filters, details', icon: <IconTasks />, tone: 'info', to: '/admin/tasks' },
  { id: 'approvals', group: 'Work', title: 'Approvals', subtitle: 'Approval Center and history', icon: <IconApprovals />, tone: 'warning', to: '/admin/approvals' },

  { id: 'files', group: 'Data', title: 'Files', subtitle: 'Workspaces, shared folders, versions', icon: <IconFiles />, tone: 'success', to: '/admin/files' },
  { id: 'memory', group: 'Data', title: 'Memory', subtitle: 'Edit and delete memories', icon: <IconMemory />, tone: 'info', to: '/admin/memory' },
  { id: 'vault', group: 'Data', title: 'Password Vault', subtitle: 'Credentials, grants, access log', icon: <IconKey />, tone: 'accent', to: '/settings/vault' },

  { id: 'providers', group: 'Connections', title: 'AI Providers', subtitle: 'Connect providers, keys, models', icon: <IconProviders />, tone: 'accent', to: '/admin/providers' },
  { id: 'telegram', group: 'Connections', title: 'Telegram', subtitle: 'Bot, pairing, topics, notifications', icon: <IconTelegram />, tone: 'info', to: '/admin/telegram' },
  { id: 'bots', group: 'Connections', title: 'Bot Network', subtitle: 'Agent bots', icon: <IconBots />, tone: 'neutral', to: '/admin/bots' },
  { id: 'voice', group: 'Connections', title: 'Voice', subtitle: 'Speech-to-text and voice replies', icon: <IconVoice />, tone: 'success', to: '/admin/voice' },
  { id: 'remote', group: 'Connections', title: 'Remote Access', subtitle: 'Mini App gateway, tunnel, Mini App sessions', icon: <IconRemote />, tone: 'neutral', to: '/admin/remote' },
  { id: 'host', group: 'Connections', title: 'Host Access', subtitle: 'Folders agents may use on the Mac', icon: <IconHost />, tone: 'warning', to: '/admin/host' },

  { id: 'system', group: 'System', title: 'System', subtitle: 'Health, VM, backups, logs, audit', icon: <IconSystem />, tone: 'success', to: '/admin/system' },
  { id: 'resources', group: 'System', title: 'Resources', subtitle: 'CPU, memory, limits, profiles', icon: <IconResources />, tone: 'info', to: '/admin/resources' },
  { id: 'settings', group: 'System', title: 'Settings & Security', subtitle: 'LAN access, password, approval defaults', icon: <IconSettings />, tone: 'neutral', to: '/admin/settings' },
  { id: 'devices', group: 'System', title: t('admin.devices.title'), subtitle: t('admin.devices.subtitle'), icon: <IconDevices />, tone: 'accent', to: '/admin/devices' },
];

/** Page titles of the top bar (first segment under #/admin). */
export const ADMIN_TITLES: Record<string, string> = Object.fromEntries(ADMIN_SECTIONS.map((s) => [s.id, s.title]));
