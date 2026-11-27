"""NEBULA V2: memory layers, teams, schedules, workflows, owner approvals, skills, resource history, file history

Revision ID: 0003
Revises: 0002

The new tables are created from DDL frozen at the time this migration was written, so later model edits never
change what this revision does. Downgrade drops exactly what upgrade added (V1 data is untouched).
"""
import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

NEW_TABLES = ['memory_embeddings', 'teams', 'team_members', 'team_runs', 'team_subtasks', 'agent_messages', 'schedules', 'schedule_runs', 'workflows', 'workflow_runs', 'workflow_steps', 'owner_approvals', 'skills', 'agent_skills', 'skill_usage', 'resource_samples', 'file_events']

DDL = [
    'CREATE TABLE memory_embeddings (\n\tmemory_id VARCHAR(36) NOT NULL, \n\tmodel VARCHAR(128) NOT NULL, \n\tdim INTEGER NOT NULL, \n\tvector TEXT NOT NULL, \n\tcreated_at FLOAT NOT NULL, \n\tPRIMARY KEY (memory_id), \n\tFOREIGN KEY(memory_id) REFERENCES agent_memory (id) ON DELETE CASCADE\n)',
    'CREATE TABLE teams (\n\tid VARCHAR(36) NOT NULL, \n\tname VARCHAR(64) NOT NULL, \n\tdescription TEXT NOT NULL, \n\tlead_agent_id VARCHAR(36), \n\tmode VARCHAR(16) NOT NULL, \n\tmax_delegation_depth INTEGER NOT NULL, \n\tmax_subtasks INTEGER NOT NULL, \n\tshare_memory BOOLEAN NOT NULL, \n\tshared_dir VARCHAR(64), \n\tcreated_at FLOAT NOT NULL, \n\tupdated_at FLOAT NOT NULL, \n\tPRIMARY KEY (id), \n\tUNIQUE (name), \n\tFOREIGN KEY(lead_agent_id) REFERENCES agents (id) ON DELETE SET NULL\n)',
    'CREATE TABLE team_members (\n\tteam_id VARCHAR(36) NOT NULL, \n\tagent_id VARCHAR(36) NOT NULL, \n\trole VARCHAR(64) NOT NULL, \n\tinstructions TEXT NOT NULL, \n\tposition INTEGER NOT NULL, \n\tPRIMARY KEY (team_id, agent_id), \n\tFOREIGN KEY(team_id) REFERENCES teams (id) ON DELETE CASCADE, \n\tFOREIGN KEY(agent_id) REFERENCES agents (id) ON DELETE CASCADE\n)',
    'CREATE TABLE team_runs (\n\tid VARCHAR(36) NOT NULL, \n\tteam_id VARCHAR(36) NOT NULL, \n\tprompt TEXT NOT NULL, \n\tstate VARCHAR(24) NOT NULL, \n\tsource VARCHAR(16) NOT NULL, \n\treply_target JSON, \n\tparent_ref JSON, \n\torigin_depth INTEGER NOT NULL, \n\tmax_model_calls INTEGER, \n\tresult JSON, \n\terror TEXT, \n\tcreated_at FLOAT NOT NULL, \n\tupdated_at FLOAT NOT NULL, \n\tfinished_at FLOAT, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(team_id) REFERENCES teams (id) ON DELETE CASCADE\n)',
    'CREATE TABLE team_subtasks (\n\tid VARCHAR(36) NOT NULL, \n\trun_id VARCHAR(36) NOT NULL, \n\tparent_subtask_id VARCHAR(36), \n\tagent_id VARCHAR(36) NOT NULL, \n\trole VARCHAR(64) NOT NULL, \n\ttitle VARCHAR(200) NOT NULL, \n\tprompt TEXT NOT NULL, \n\tdepends_on JSON NOT NULL, \n\tstate VARCHAR(24) NOT NULL, \n\ttask_id VARCHAR(36), \n\tattempts INTEGER NOT NULL, \n\tmax_attempts INTEGER NOT NULL, \n\tdepth INTEGER NOT NULL, \n\tresult_summary TEXT, \n\tartifacts JSON NOT NULL, \n\tcreated_at FLOAT NOT NULL, \n\tupdated_at FLOAT NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(run_id) REFERENCES team_runs (id) ON DELETE CASCADE, \n\tFOREIGN KEY(agent_id) REFERENCES agents (id) ON DELETE CASCADE\n)',
    'CREATE INDEX ix_team_subtasks_run ON team_subtasks (run_id, state)',
    'CREATE TABLE agent_messages (\n\tid VARCHAR(36) NOT NULL, \n\trun_id VARCHAR(36), \n\tfrom_agent_id VARCHAR(36), \n\tto_agent_id VARCHAR(36), \n\tkind VARCHAR(24) NOT NULL, \n\tcontent TEXT NOT NULL, \n\tpayload JSON, \n\tcreated_at FLOAT NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(run_id) REFERENCES team_runs (id) ON DELETE CASCADE\n)',
    'CREATE TABLE schedules (\n\tid VARCHAR(36) NOT NULL, \n\tname VARCHAR(128) NOT NULL, \n\ttarget_type VARCHAR(16) NOT NULL, \n\ttarget_id VARCHAR(36) NOT NULL, \n\tprompt TEXT NOT NULL, \n\tkind VARCHAR(16) NOT NULL, \n\tspec JSON NOT NULL, \n\ttimezone VARCHAR(64) NOT NULL, \n\tenabled BOOLEAN NOT NULL, \n\tmisfire_policy VARCHAR(16) NOT NULL, \n\toverlap_policy VARCHAR(16) NOT NULL, \n\tretry_max INTEGER NOT NULL, \n\tretry_delay_s INTEGER NOT NULL, \n\tmax_runtime_s INTEGER NOT NULL, \n\tmax_model_calls INTEGER NOT NULL, \n\tnotify JSON NOT NULL, \n\tnext_run_at FLOAT, \n\tlast_run_at FLOAT, \n\tcreated_at FLOAT NOT NULL, \n\tupdated_at FLOAT NOT NULL, \n\tPRIMARY KEY (id)\n)',
    'CREATE TABLE schedule_runs (\n\tid VARCHAR(36) NOT NULL, \n\tschedule_id VARCHAR(36) NOT NULL, \n\tscheduled_for FLOAT NOT NULL, \n\tattempt INTEGER NOT NULL, \n\t"trigger" VARCHAR(16) NOT NULL, \n\tstate VARCHAR(24) NOT NULL, \n\ttarget_ref JSON, \n\tdetail TEXT, \n\tstarted_at FLOAT, \n\tfinished_at FLOAT, \n\tcreated_at FLOAT NOT NULL, \n\tPRIMARY KEY (id), \n\tCONSTRAINT uq_schedule_run_slot UNIQUE (schedule_id, scheduled_for, attempt), \n\tFOREIGN KEY(schedule_id) REFERENCES schedules (id) ON DELETE CASCADE\n)',
    'CREATE TABLE workflows (\n\tid VARCHAR(36) NOT NULL, \n\tname VARCHAR(128) NOT NULL, \n\tdescription TEXT NOT NULL, \n\tversion INTEGER NOT NULL, \n\tdefinition JSON NOT NULL, \n\tenabled BOOLEAN NOT NULL, \n\ttrigger_types JSON NOT NULL, \n\tmax_runs_per_hour INTEGER NOT NULL, \n\tcreated_at FLOAT NOT NULL, \n\tupdated_at FLOAT NOT NULL, \n\tPRIMARY KEY (id)\n)',
    'CREATE TABLE workflow_runs (\n\tid VARCHAR(36) NOT NULL, \n\tworkflow_id VARCHAR(36) NOT NULL, \n\tworkflow_version INTEGER NOT NULL, \n\tdefinition JSON NOT NULL, \n\tstate VARCHAR(24) NOT NULL, \n\t"trigger" VARCHAR(32) NOT NULL, \n\ttrigger_payload JSON, \n\tcontext JSON NOT NULL, \n\torigin_depth INTEGER NOT NULL, \n\terror TEXT, \n\tcreated_at FLOAT NOT NULL, \n\tupdated_at FLOAT NOT NULL, \n\tfinished_at FLOAT, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(workflow_id) REFERENCES workflows (id) ON DELETE CASCADE\n)',
    'CREATE TABLE workflow_steps (\n\tid VARCHAR(36) NOT NULL, \n\trun_id VARCHAR(36) NOT NULL, \n\tnode_id VARCHAR(64) NOT NULL, \n\tnode_type VARCHAR(32) NOT NULL, \n\tstate VARCHAR(24) NOT NULL, \n\tattempt INTEGER NOT NULL, \n\toutput JSON, \n\tref JSON, \n\terror TEXT, \n\tstarted_at FLOAT NOT NULL, \n\tfinished_at FLOAT, \n\tPRIMARY KEY (id), \n\tCONSTRAINT uq_workflow_step UNIQUE (run_id, node_id, attempt), \n\tFOREIGN KEY(run_id) REFERENCES workflow_runs (id) ON DELETE CASCADE\n)',
    'CREATE TABLE owner_approvals (\n\tid VARCHAR(36) NOT NULL, \n\tkind VARCHAR(32) NOT NULL, \n\tref JSON NOT NULL, \n\tsummary TEXT NOT NULL, \n\tpreview JSON, \n\tdecision VARCHAR(16), \n\tresolved_by VARCHAR(64), \n\tcreated_at FLOAT NOT NULL, \n\texpires_at FLOAT NOT NULL, \n\tresolved_at FLOAT, \n\tPRIMARY KEY (id)\n)',
    'CREATE TABLE skills (\n\tid VARCHAR(64) NOT NULL, \n\tname VARCHAR(128) NOT NULL, \n\tversion VARCHAR(32) NOT NULL, \n\tdescription TEXT NOT NULL, \n\tkind VARCHAR(16) NOT NULL, \n\tmanifest JSON NOT NULL, \n\tenabled BOOLEAN NOT NULL, \n\tchecksum VARCHAR(64), \n\tinstalled_at FLOAT NOT NULL, \n\tupdated_at FLOAT NOT NULL, \n\tPRIMARY KEY (id)\n)',
    'CREATE TABLE agent_skills (\n\tagent_id VARCHAR(36) NOT NULL, \n\tskill_id VARCHAR(64) NOT NULL, \n\tenabled BOOLEAN NOT NULL, \n\tconfig JSON NOT NULL, \n\tassigned_at FLOAT NOT NULL, \n\tPRIMARY KEY (agent_id, skill_id), \n\tFOREIGN KEY(agent_id) REFERENCES agents (id) ON DELETE CASCADE, \n\tFOREIGN KEY(skill_id) REFERENCES skills (id) ON DELETE CASCADE\n)',
    'CREATE TABLE skill_usage (\n\tid INTEGER NOT NULL, \n\tskill_id VARCHAR(64) NOT NULL, \n\tagent_id VARCHAR(36), \n\ttask_id VARCHAR(36), \n\ttool VARCHAR(64) NOT NULL, \n\tstatus VARCHAR(16) NOT NULL, \n\tts FLOAT NOT NULL, \n\tPRIMARY KEY (id)\n)',
    'CREATE TABLE resource_samples (\n\tts FLOAT NOT NULL, \n\thost_mem_used_pct FLOAT, \n\thost_pressure VARCHAR(16), \n\thost_cpu_pct FLOAT, \n\thost_swap_used_mb FLOAT, \n\tdisk_free_gb FLOAT, \n\tvm_rss_mb FLOAT, \n\tguest_mem_avail_mb FLOAT, \n\tguest_load1 FLOAT, \n\tactive_agents INTEGER, \n\tqueued_tasks INTEGER, \n\tprofile VARCHAR(16), \n\tPRIMARY KEY (ts)\n)',
    'CREATE TABLE file_events (\n\tid INTEGER NOT NULL, \n\tts FLOAT NOT NULL, \n\tactor VARCHAR(128) NOT NULL, \n\troot VARCHAR(96) NOT NULL, \n\top VARCHAR(24) NOT NULL, \n\tpath TEXT NOT NULL, \n\tdest TEXT, \n\tsize INTEGER, \n\tPRIMARY KEY (id)\n)',
    'CREATE INDEX ix_file_events_root ON file_events (root, ts)',
    'CREATE INDEX ix_memory_agent_kind ON agent_memory (agent_id, kind)',
]

MEMORY_COLS = [
    sa.Column("kind", sa.String(16), nullable=False, server_default="fact"),
    sa.Column("scope", sa.String(16), nullable=False, server_default="private"),
    sa.Column("shared_with", sa.JSON, nullable=False, server_default="[]"),
    sa.Column("project", sa.String(128)),
    sa.Column("importance", sa.Integer, nullable=False, server_default="3"),
    sa.Column("pinned", sa.Boolean, nullable=False, server_default="0"),
    sa.Column("trust", sa.String(16), nullable=False, server_default="agent"),
    sa.Column("use_count", sa.Integer, nullable=False, server_default="0"),
    sa.Column("last_used_at", sa.Float),
    sa.Column("content_hash", sa.String(64)),
    sa.Column("created_at", sa.Float),
]
TASK_COLS = [
    sa.Column("priority", sa.Integer, nullable=False, server_default="0"),
    sa.Column("parent_ref", sa.JSON),
    sa.Column("project", sa.String(128)),
    sa.Column("deadline_at", sa.Float),
    sa.Column("origin_depth", sa.Integer, nullable=False, server_default="0"),
]


def upgrade() -> None:
    # agent_memory is the FTS5 content table; its rowids must survive, so columns are added in place
    # (ALTER TABLE ADD COLUMN) instead of a batch table copy.
    for c in MEMORY_COLS:
        op.add_column("agent_memory", c)
    op.execute("UPDATE agent_memory SET created_at = updated_at WHERE created_at IS NULL")
    op.add_column("agents", sa.Column("config", sa.JSON, nullable=False, server_default="{}"))
    for c in TASK_COLS:
        op.add_column("tasks", c)
    for stmt in DDL:
        op.execute(stmt)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_memory_agent_kind")
    for t in reversed(NEW_TABLES):
        op.execute(f"DROP TABLE IF EXISTS {t}")
    with op.batch_alter_table("tasks") as b:
        for c in reversed(TASK_COLS):
            b.drop_column(c.name)
    with op.batch_alter_table("agents") as b:
        b.drop_column("config")
    for c in reversed(MEMORY_COLS):  # SQLite >= 3.35 supports DROP COLUMN; keeps rowids for the FTS index
        op.execute(f"ALTER TABLE agent_memory DROP COLUMN {c.name}")
