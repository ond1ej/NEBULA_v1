// Teams and schedules (read-only lists through the gateway; edit them in the local Dashboard).
import { StatusPill, BUSY_STATES } from '../../components/StatusPill';
import { relativeTime } from '../../lib/format';
import type { Schedule, Team, TeamRunSummary } from '../../types';
import { useMini } from '../context';
import { useQuery } from '../hooks';
import { Clamp, Empty, List, QueryView, Row, Screen, Section } from '../uiKit';
import { OwnerNote } from '../uiExtra';
import { IconSchedules, IconTeams } from '../../components/icons';

export function TeamsScreen() {
  const { api } = useMini();
  const teams = useQuery<Team[]>('teams', (s) => api.teams.list(s), { refreshOn: (ev) => ev.type.startsWith('team.') });
  const runs = useQuery<TeamRunSummary[]>('team-runs', (s) => api.teams.runs(s), { refreshOn: (ev) => ev.type.startsWith('team.run') });
  return (
    <Screen title="Teams">
      <Section title="Teams">
        <QueryView q={teams} isEmpty={(d) => d.length === 0} empty={<Empty title="No teams" icon={<IconTeams />}>Create teams in the NEBULA Dashboard.</Empty>}>
          {(list) => (
            <List>
              {list.map((t) => (
                <Row
                  key={t.id}
                  title={t.name}
                  subtitle={
                    <>
                      <Clamp lines={2}>{t.description || `${t.members.length} member${t.members.length === 1 ? '' : 's'} · ${t.mode}`}</Clamp>
                      <span className="block text-subtle">{t.members.map((m) => m.agent_name ?? m.role).join(', ')}</span>
                    </>
                  }
                  trailing={t.last_run ? <StatusPill state={t.last_run.state} pulse={BUSY_STATES.has(t.last_run.state)} /> : undefined}
                  chevron={false}
                />
              ))}
            </List>
          )}
        </QueryView>
      </Section>
      {runs.data && runs.data.length > 0 && (
        <Section title="Recent team runs">
          <List>
            {runs.data.slice(0, 10).map((r) => (
              <Row
                key={r.id}
                title={r.team_name ?? 'Team run'}
                subtitle={<Clamp lines={2}>{`${relativeTime(r.created_at)} · ${r.prompt}`}</Clamp>}
                trailing={<StatusPill state={r.state} pulse={BUSY_STATES.has(r.state)} />}
                chevron={false}
              />
            ))}
          </List>
        </Section>
      )}
      <OwnerNote to="/admin/teams" link="Create and edit teams in Administration">
        Create and edit teams in the local Dashboard.
      </OwnerNote>
    </Screen>
  );
}

export function SchedulesScreen() {
  const { api } = useMini();
  const q = useQuery<Schedule[]>('schedules', (s) => api.schedules.list(s), { refreshOn: (ev) => ev.type.startsWith('schedule.') });
  return (
    <Screen title="Schedules">
      <QueryView q={q} isEmpty={(d) => d.length === 0} empty={<Empty title="No schedules" icon={<IconSchedules />}>Create schedules in the NEBULA Dashboard.</Empty>}>
        {(list) => (
          <List>
            {list.map((s) => (
              <Row
                key={s.id}
                title={s.name}
                subtitle={`${s.target_name ?? s.target_type} · ${s.kind}${s.next_run_at ? ` · next ${relativeTime(s.next_run_at)}` : ''}${s.enabled ? '' : ' · disabled'}`}
                trailing={s.last_run ? <StatusPill state={s.last_run.state} /> : undefined}
                chevron={false}
              />
            ))}
          </List>
        )}
      </QueryView>
      <OwnerNote className="mt-3" to="/admin/schedules" link="Create and edit schedules in Administration">
        Create and edit schedules in the local Dashboard.
      </OwnerNote>
    </Screen>
  );
}
