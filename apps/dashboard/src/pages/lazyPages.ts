// Route-level code splitting of the Dashboard: every page is its own chunk, loaded on first visit.
// (The sign-in / setup pages are declared in App.tsx: the Mini App's administration area reuses this module and must
// not reach them.)
// `preloadSection` fetches a page's chunk ahead of time (in parallel with the auth check on boot, and when the pointer
// or keyboard focus reaches a navigation link), so most navigations never show the skeleton.
import { lazyNamed } from '../lib/lazy';

const overview = () => import('./OverviewPage');
const agents = () => import('./AgentsPage');
const agentDetail = () => import('./AgentDetailPage');
const createAgent = () => import('./CreateAgentPage');
const companies = () => import('../features/companies/CompaniesRoute');
const approvals = () => import('../features/approvals/ApprovalCenterPage');
const bots = () => import('../features/bots/BotNetworkPage');
const host = () => import('../features/hostaccess/HostAccessPage');
const remote = () => import('../features/remote/RemoteAccessPage');
const voice = () => import('../features/voice/VoiceSettingsPage');
const teams = () => import('./TeamsPage');
const tasks = () => import('./TasksPage');
const schedules = () => import('./SchedulesPage');
const workflows = () => import('../features/workflows/WorkflowsPage');
const memory = () => import('./MemoryPage');
const files = () => import('../features/files/FilesPage');
const skills = () => import('./SkillsPage');
const resources = () => import('./ResourcesPage');
const providers = () => import('./ProvidersPage');
const telegram = () => import('./TelegramPage');
const system = () => import('./SystemPage');
const settings = () => import('./SettingsPage');
const vault = () => import('../features/vault/VaultPage');
const devices = () => import('../features/devices/DevicesPage');

export const OverviewPage = lazyNamed(overview, 'OverviewPage');
export const AgentsPage = lazyNamed(agents, 'AgentsPage');
export const AgentDetailPage = lazyNamed(agentDetail, 'AgentDetailPage');
export const CreateAgentPage = lazyNamed(createAgent, 'CreateAgentPage');
export const CompaniesRoute = lazyNamed(companies, 'CompaniesRoute');
export const ApprovalCenterPage = lazyNamed(approvals, 'ApprovalCenterPage');
export const BotNetworkPage = lazyNamed(bots, 'BotNetworkPage');
export const HostAccessPage = lazyNamed(host, 'HostAccessPage');
export const RemoteAccessPage = lazyNamed(remote, 'RemoteAccessPage');
export const VoiceSettingsPage = lazyNamed(voice, 'VoiceSettingsPage');
export const TeamsPage = lazyNamed(teams, 'TeamsPage');
export const TeamDetailPage = lazyNamed(teams, 'TeamDetailPage');
export const TeamRunPage = lazyNamed(teams, 'TeamRunPage');
export const TasksPage = lazyNamed(tasks, 'TasksPage');
export const SchedulesPage = lazyNamed(schedules, 'SchedulesPage');
export const ScheduleDetailPage = lazyNamed(schedules, 'ScheduleDetailPage');
export const WorkflowsPage = lazyNamed(workflows, 'WorkflowsPage');
export const MemoryPage = lazyNamed(memory, 'MemoryPage');
export const FilesPage = lazyNamed(files, 'FilesPage');
export const SkillsPage = lazyNamed(skills, 'SkillsPage');
export const ResourcesPage = lazyNamed(resources, 'ResourcesPage');
export const ProvidersPage = lazyNamed(providers, 'ProvidersPage');
export const TelegramPage = lazyNamed(telegram, 'TelegramPage');
export const SystemPage = lazyNamed(system, 'SystemPage');
export const SettingsPage = lazyNamed(settings, 'SettingsPage');
export const VaultPage = lazyNamed(vault, 'VaultPage');
export const DevicesPage = lazyNamed(devices, 'DevicesPage');

const SECTIONS: Record<string, { preload: () => Promise<unknown> }> = {
  overview: OverviewPage,
  agents: AgentsPage,
  companies: CompaniesRoute,
  approvals: ApprovalCenterPage,
  bots: BotNetworkPage,
  host: HostAccessPage,
  remote: RemoteAccessPage,
  voice: VoiceSettingsPage,
  teams: TeamsPage,
  tasks: TasksPage,
  schedules: SchedulesPage,
  workflows: WorkflowsPage,
  memory: MemoryPage,
  files: FilesPage,
  skills: SkillsPage,
  resources: ResourcesPage,
  providers: ProvidersPage,
  telegram: TelegramPage,
  system: SystemPage,
  settings: SettingsPage,
  vault: VaultPage,
  devices: DevicesPage,
};

/** Starts loading the chunk of a route (`segments` as in useHashRoute). Safe to call repeatedly. */
export function preloadRoute(segments: string[]): void {
  const [s0, s1] = segments;
  if (s0 === 'agents' && s1) {
    void (s1 === 'new' ? CreateAgentPage : AgentDetailPage).preload();
    return;
  }
  void (SECTIONS[s0 ?? 'overview'] ?? OverviewPage).preload();
}
