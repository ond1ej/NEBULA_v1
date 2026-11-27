# AI Company Mode

**Status: Experimental.** Company runs are covered by automated tests with a scripted model; CEO planning with a real
model has not been part of the release test.

AI Company Mode organises existing agents into a company with roles, projects and budgets, and runs objectives through
them. It is built on the same tasks as everything else, so policy and approvals apply unchanged.

## Model

- **Company:** name, description, objective, default environment (VM, or Mac plus a default folder), a provider
  preference (informational; employees keep their own models), parallelism (1 to 4 work items), a budget (model
  requests per run, optional total) and an approval policy (approve CEO plans, CEO final review).
- **Roles:** a catalogue of 16 roles (CEO, CTO, COO, product and project manager, architect, designer, frontend,
  backend and full-stack developer, QA, security, DevOps, researcher, marketing, data analyst) plus custom roles.
- **Employees:** existing agents with a role, title, reporting line (loops and a second CEO are refused), optional
  environment and instructions. An agent works for at most one company.
- **Projects:** objective, environment override, Mac folder, git remote and branch, milestones, budget, assigned
  employees, and a VM folder `/srv/nebula/shared/<company>/<project>`.
- **Knowledge:** requirements, decisions, documents and run reports, added to prompts as data and only for the own
  company. Secrets are refused.

## Runs

Start a run on a project with an objective and a planner:

- **Template:** deterministic, one work item per assigned employee ordered by role stage (research and product →
  architecture → design → build → QA and security → DevOps), optional CEO review. No model request for planning.
- **CEO:** the CEO agent plans with the `company_plan` tool (at most 12 items, known roles only, dependencies only on
  earlier items). You can require approval of the plan.

Each item picks an agent by role, resolves its environment, transfers artifacts between the Mac and the VM when
needed, builds a prompt with company knowledge and dependency results, and enqueues a normal task with the remaining
run budget. Failures retry once, dependants are skipped, items can be retried later, runs can be paused, resumed and
cancelled, and they are reconciled after a restart. The org chart shows each agent as idle, assigned, running,
waiting, paused, completed, failed or sleeping.

## Mixed environments

The environment of a work item is resolved from company default → project → member → assignment; the most specific
wins and the UI shows the chain. For example, a developer agent can work natively on the Mac in a project folder,
NEBULA copies its output to the VM company folder, and a tester agent reviews it in the VM.

## Telegram

`/companies`, `/company <name>`, `/project <company> | <project> | <request>`, `/progress`, plan approval and run
buttons, completion reports. Plan approval cards and the **Approve plan** buttons are shown only to the owner, and
`/project` needs the `companies` permission for other accounts
([telegram.md](../telegram.md#who-can-do-what-in-the-chat)). The Mini App has a Companies screen.

## Limits

- The company budget is checked whenever a work item starts; a running task can still use its own step budget.
- The provider preference is informational.
- Company and project create and update endpoints accept JSON objects without a detailed OpenAPI schema.
