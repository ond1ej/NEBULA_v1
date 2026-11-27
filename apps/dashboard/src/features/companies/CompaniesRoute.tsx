// Router for #/companies/... (segments after "companies"):
//   []                          list
//   ['new']                     creation wizard
//   [id, tab?]                  company dashboard
//   [id, 'projects', pid, tab?] project workspace
//   [id, 'runs', rid, tab?]     run view (project workspace with the run selected)
// The pages are loaded on demand (own chunk) so the main bundle stays small.
import { lazy, Suspense } from 'react';
import { LoadingCards } from '../../components/ui';

const CompaniesList = lazy(() => import('./CompaniesList').then((m) => ({ default: m.CompaniesList })));
const CompanyWizard = lazy(() => import('./CompanyWizard').then((m) => ({ default: m.CompanyWizard })));
const CompanyDashboard = lazy(() => import('./CompanyDashboard').then((m) => ({ default: m.CompanyDashboard })));
const ProjectWorkspace = lazy(() => import('./ProjectWorkspace').then((m) => ({ default: m.ProjectWorkspace })));
const RunRoute = lazy(() => import('./ProjectWorkspace').then((m) => ({ default: m.RunRoute })));

function Page({ segments, query }: { segments: string[]; query: URLSearchParams }) {
  const [id, s1, s2, s3] = segments;
  if (!id) return <CompaniesList />;
  if (id === 'new') return <CompanyWizard />;
  if (s1 === 'projects' && s2) return <ProjectWorkspace key={s2} companyId={id} projectId={s2} tab={s3} query={query} />;
  if (s1 === 'runs' && s2) return <RunRoute key={s2} companyId={id} runId={s2} tab={s3} query={query} />;
  return <CompanyDashboard key={id} companyId={id} tab={s1 ?? 'overview'} query={query} />;
}

export function CompaniesRoute({ segments, query }: { segments: string[]; query: URLSearchParams }) {
  return (
    <Suspense fallback={<LoadingCards count={3} label="Loading AI Companies…" />}>
      <Page segments={segments} query={query} />
    </Suspense>
  );
}
