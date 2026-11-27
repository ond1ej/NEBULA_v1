// Employees tab: edit roles, members, reporting lines and per-employee environment overrides (PATCH /companies/{id}).
import { useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '../../api';
import { IconUser } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { Button, Card, ErrorBanner, LoadingRows, Notice, TextLink } from '../../components/ui';
import { useApi } from '../../hooks/useApi';
import { href } from '../../hooks/useHashRoute';
import { EnvBadge } from '../environment/EnvBadge';
import { agentCompanyMap, companiesApi } from './api';
import { draftOrgNodes, MembersEditor, RolesEditor } from './editors';
import { membersBody, membersFromCompany, rolesBody, rolesFromCompany, validateMembers, validateRoles, type MemberDraft, type RoleDraft } from './lib';
import { LifecycleBadge } from './OrgChart';
import { OrgChart } from './OrgChart';
import type { CompanyDetail } from './types';

export function CompanyEmployees({ co, onSaved }: { co: CompanyDetail; onSaved: (c: CompanyDetail) => void }) {
  const toast = useToast();
  const catalog = useApi((s) => companiesApi.roles(s), []);
  const agents = useApi(() => api.agents.list(), []);
  const taken = useApi((s) => agentCompanyMap(s), [co.id]);
  const [roles, setRoles] = useState<RoleDraft[] | null>(null);
  const [members, setMembers] = useState<MemberDraft[]>(() => membersFromCompany(co.members));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => {
    if (catalog.data && roles === null) setRoles(rolesFromCompany(co.roles, catalog.data));
    if (catalog.error && roles === null) setRoles(rolesFromCompany(co.roles, []));
  }, [catalog.data, catalog.error, co.roles, roles]);

  const initial = useMemo(
    () => JSON.stringify({ r: rolesBody(rolesFromCompany(co.roles, catalog.data ?? [])), m: membersBody(membersFromCompany(co.members)) }),
    [co, catalog.data],
  );
  const current = roles ? JSON.stringify({ r: rolesBody(roles), m: membersBody(members) }) : initial;
  const dirty = current !== initial;
  const roleErrs = roles ? validateRoles(roles) : [];
  const memberErrs = roles ? validateMembers(members, roles) : {};
  const invalid = roleErrs.length > 0 || Object.keys(memberErrs).length > 0;
  const used = useMemo(() => new Set(members.map((m) => m.role_key).filter(Boolean)), [members]);
  const byAgent = useMemo(() => new Map(co.members.map((m) => [m.agent_id, m])), [co.members]);
  const busy = co.stats.runs_active > 0;

  const reset = () => {
    setRoles(rolesFromCompany(co.roles, catalog.data ?? []));
    setMembers(membersFromCompany(co.members));
    setError(null);
    setShowErrors(false);
  };
  const save = async () => {
    if (!roles) return;
    if (invalid) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const c = await companiesApi.update(co.id, { roles: rolesBody(roles), members: membersBody(members) });
      toast.success('Employees saved');
      onSaved(c);
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  const saveBar = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {dirty && <span className="mr-auto text-xs text-warn">Unsaved changes</span>}
      <Button variant="ghost" onClick={reset} disabled={!dirty || saving}>
        Discard
      </Button>
      <Button variant="primary" loading={saving} disabledReason={!dirty ? 'No changes' : null} onClick={() => void save()}>
        Save employees
      </Button>
    </div>
  );

  return (
    <div className="space-y-5">
      {busy && (
        <Notice tone="info" title="Runs are in progress">
          Changes apply to work items that start after saving. Removing an employee also removes them from every project of the company.
        </Notice>
      )}
      {error ? (
        <ErrorBanner
          error={error}
          title={error instanceof ApiError && error.code === 'agent_in_other_company' ? 'An agent already works for another company' : 'Employees not saved'}
        />
      ) : null}
      <Card
        title="Employees"
        icon={<IconUser />}
        subtitle="Assign agents to roles, set reporting lines and per-employee environment overrides (company → project → employee → assignment)."
        footer={saveBar}
      >
        {!roles || !agents.data ? (
          <LoadingRows label="Loading employees…" />
        ) : (
          <MembersEditor
            agents={agents.data}
            roles={roles}
            members={members}
            onChange={setMembers}
            errors={showErrors ? memberErrs : {}}
            takenBy={taken.data ?? {}}
            companyId={co.id}
            defaultEnv={co.default_environment}
            rowExtra={(m) => {
              const cur = byAgent.get(m.agent_id);
              if (!cur) return <span className="text-xs text-subtle">New employee — saved on “Save employees”.</span>;
              return (
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span>Now:</span>
                  <EnvBadge env={cur.environment_effective?.env} source={cur.environment_effective?.source} chain={cur.environment_effective?.chain} showSource />
                  <LifecycleBadge lifecycle={cur.lifecycle} />
                  {cur.current_item && <span className="truncate">Working on “{cur.current_item.title}”</span>}
                  <TextLink href={href(`/agents/${m.agent_id}`)}>Open agent</TextLink>
                </span>
              );
            }}
          />
        )}
      </Card>
      <Card title="Roles" subtitle="Positions available in this company. Roles held by an employee cannot be removed." footer={saveBar}>
        {!roles ? <LoadingRows /> : <RolesEditor catalog={catalog.data} roles={roles} onChange={setRoles} used={used} error={showErrors && roleErrs.length ? roleErrs.join(' · ') : undefined} />}
      </Card>
      {roles && members.some((m) => m.agent_id) && (
        <Card title="Organisation preview" subtitle={dirty ? 'Includes unsaved changes.' : 'As saved.'}>
          <OrgChart nodes={draftOrgNodes(members, roles, agents.data, co.default_environment)} label="Organisation preview" />
        </Card>
      )}
    </div>
  );
}
