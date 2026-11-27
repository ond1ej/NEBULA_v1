// The Dashboard's page routes (#/<section>/…): rendered by the Dashboard shell (App.tsx) and, under #/admin/…, by the
// Telegram Mini App's administration area (mini/admin/AdminArea.tsx). Every page is its own lazy chunk.
import { ButtonLink, EmptyState } from '../components/ui';
import { href, type Route } from '../hooks/useHashRoute';
import {
  AgentDetailPage,
  AgentsPage,
  ApprovalCenterPage,
  BotNetworkPage,
  CompaniesRoute,
  CreateAgentPage,
  DevicesPage,
  FilesPage,
  HostAccessPage,
  MemoryPage,
  OverviewPage,
  ProvidersPage,
  RemoteAccessPage,
  ResourcesPage,
  ScheduleDetailPage,
  SchedulesPage,
  SettingsPage,
  SkillsPage,
  SystemPage,
  TasksPage,
  TeamDetailPage,
  TeamRunPage,
  TeamsPage,
  TelegramPage,
  VaultPage,
  VoiceSettingsPage,
  WorkflowsPage,
} from './lazyPages';

export function DashboardRoutes({
  route,
  username,
  onLogout,
  onSignedOut,
  loggingOut,
}: {
  route: Route;
  username: string | null;
  onLogout: () => void;
  onSignedOut: () => void;
  loggingOut: boolean;
}) {
  const [s0, s1, s2, s3] = route.segments;
  switch (s0) {
    case undefined:
    case 'overview':
    case 'setup':
    case 'login':
      return <OverviewPage />;
    case 'agents':
      if (!s1) return <AgentsPage />;
      if (s1 === 'new') return <CreateAgentPage query={route.query} />;
      return <AgentDetailPage key={s1} agentId={s1} tab={s2 ?? 'chat'} query={route.query} />;
    case 'companies':
      return <CompaniesRoute segments={route.segments.slice(1)} query={route.query} />;
    case 'approvals':
      return <ApprovalCenterPage />;
    case 'bots':
      return <BotNetworkPage />;
    case 'host':
      return <HostAccessPage />;
    case 'remote':
      return <RemoteAccessPage />;
    case 'voice':
      return <VoiceSettingsPage />;
    case 'teams':
      if (!s1) return <TeamsPage query={route.query} />;
      if (s2 === 'runs' && s3) return <TeamRunPage key={s3} teamId={s1} runId={s3} />;
      return <TeamDetailPage key={s1} teamId={s1} />;
    case 'tasks':
      return <TasksPage query={route.query} />;
    case 'schedules':
      if (s1) return <ScheduleDetailPage key={s1} scheduleId={s1} />;
      return <SchedulesPage query={route.query} />;
    case 'workflows':
      return <WorkflowsPage />;
    case 'memory':
      return <MemoryPage query={route.query} />;
    case 'files':
      return <FilesPage />;
    case 'skills':
      return <SkillsPage query={route.query} />;
    case 'resources':
      return <ResourcesPage />;
    case 'providers':
      return <ProvidersPage query={route.query} />;
    case 'telegram':
      return <TelegramPage />;
    case 'system':
      return <SystemPage />;
    case 'vault':
      return <VaultPage query={route.query} />;
    case 'devices':
      return <DevicesPage />;
    case 'settings':
      return <SettingsPage username={username} onLogout={onLogout} onSignedOut={onSignedOut} loggingOut={loggingOut} />;
    default:
      return (
        <EmptyState
          title="Page not found"
          action={
            <ButtonLink href={href('/overview')} variant="primary">
              Go to Command Center
            </ButtonLink>
          }
        >
          <code>{route.path}</code> does not exist.
        </EmptyState>
      );
  }
}
