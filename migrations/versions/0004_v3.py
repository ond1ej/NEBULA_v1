"""NEBULA V3: host execution roots + command audit, AI Company Mode 2.0, per-agent Telegram bots, live task cards,
callback dedup, Mini App replay protection, multimodal attachments; tasks.execution, telegram notify levels.

Revision ID: 0004
Revises: 0003

New tables come from DDL frozen when this migration was written (later model edits never change it). New columns
are nullable or have server defaults, so every V2 row stays valid. Downgrade drops exactly what upgrade added.
"""
import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

NEW_TABLES = ['host_project_roots', 'host_commands', 'companies', 'company_roles', 'company_members', 'company_projects', 'project_members', 'company_runs', 'company_work_items', 'company_knowledge', 'company_activity', 'telegram_bots', 'telegram_bot_users', 'telegram_bot_updates', 'telegram_task_cards', 'telegram_callbacks', 'miniapp_auth', 'attachments']

DDL = [
    'CREATE TABLE host_project_roots (\n\tid VARCHAR(36) NOT NULL, \n\tname VARCHAR(128) NOT NULL, \n\tpath TEXT NOT NULL, \n\tmode VARCHAR(16) NOT NULL, \n\tallow_network BOOLEAN NOT NULL, \n\tallowed_tools JSON NOT NULL, \n\tenabled BOOLEAN NOT NULL, \n\tcreated_by VARCHAR(128) NOT NULL, \n\tcreated_at FLOAT NOT NULL, \n\tupdated_at FLOAT NOT NULL, \n\tPRIMARY KEY (id), \n\tUNIQUE (path)\n)',
    'CREATE TABLE host_commands (\n\tid INTEGER NOT NULL, \n\tts FLOAT NOT NULL, \n\tagent_id VARCHAR(36), \n\ttask_id VARCHAR(36), \n\troot_id VARCHAR(36), \n\ttool VARCHAR(64) NOT NULL, \n\tcommand TEXT, \n\tcwd TEXT, \n\tstatus VARCHAR(16) NOT NULL, \n\texit_code INTEGER, \n\tduration_ms INTEGER, \n\tdetail TEXT, \n\tPRIMARY KEY (id)\n)',
    'CREATE INDEX ix_host_commands_root ON host_commands (root_id, ts)',
    'CREATE TABLE companies (\n\tid VARCHAR(36) NOT NULL, \n\tname VARCHAR(96) NOT NULL, \n\tdescription TEXT NOT NULL, \n\tobjective TEXT NOT NULL, \n\tindustry VARCHAR(96) NOT NULL, \n\tdefault_environment VARCHAR(8) NOT NULL, \n\tdefault_root_id VARCHAR(36), \n\tprovider_prefs JSON NOT NULL, \n\tresource_policy JSON NOT NULL, \n\tbudget JSON NOT NULL, \n\tapproval_policy JSON NOT NULL, \n\tceo_agent_id VARCHAR(36), \n\tworkspace_dir VARCHAR(64), \n\tstatus VARCHAR(16) NOT NULL, \n\tcreated_at FLOAT NOT NULL, \n\tupdated_at FLOAT NOT NULL, \n\tPRIMARY KEY (id), \n\tUNIQUE (name), \n\tFOREIGN KEY(ceo_agent_id) REFERENCES agents (id) ON DELETE SET NULL\n)',
    'CREATE TABLE company_roles (\n\tcompany_id VARCHAR(36) NOT NULL, \n\t"key" VARCHAR(48) NOT NULL, \n\ttitle VARCHAR(96) NOT NULL, \n\tresponsibilities TEXT NOT NULL, \n\tstage INTEGER NOT NULL, \n\tposition INTEGER NOT NULL, \n\tPRIMARY KEY (company_id, "key"), \n\tFOREIGN KEY(company_id) REFERENCES companies (id) ON DELETE CASCADE\n)',
    'CREATE TABLE company_members (\n\tcompany_id VARCHAR(36) NOT NULL, \n\tagent_id VARCHAR(36) NOT NULL, \n\trole_key VARCHAR(48) NOT NULL, \n\ttitle VARCHAR(96) NOT NULL, \n\treports_to VARCHAR(36), \n\tenvironment VARCHAR(8), \n\tinstructions TEXT NOT NULL, \n\tposition INTEGER NOT NULL, \n\tcreated_at FLOAT NOT NULL, \n\tPRIMARY KEY (company_id, agent_id), \n\tFOREIGN KEY(company_id) REFERENCES companies (id) ON DELETE CASCADE, \n\tUNIQUE (agent_id), \n\tFOREIGN KEY(agent_id) REFERENCES agents (id) ON DELETE CASCADE\n)',
    'CREATE TABLE company_projects (\n\tid VARCHAR(36) NOT NULL, \n\tcompany_id VARCHAR(36) NOT NULL, \n\tname VARCHAR(128) NOT NULL, \n\tdescription TEXT NOT NULL, \n\tobjective TEXT NOT NULL, \n\tstatus VARCHAR(16) NOT NULL, \n\tenvironment VARCHAR(8), \n\thost_root_id VARCHAR(36), \n\tgit JSON NOT NULL, \n\tmilestones JSON NOT NULL, \n\tbudget JSON NOT NULL, \n\tvm_dir VARCHAR(64), \n\tcreated_at FLOAT NOT NULL, \n\tupdated_at FLOAT NOT NULL, \n\tPRIMARY KEY (id), \n\tCONSTRAINT uq_company_project_name UNIQUE (company_id, name), \n\tFOREIGN KEY(company_id) REFERENCES companies (id) ON DELETE CASCADE, \n\tFOREIGN KEY(host_root_id) REFERENCES host_project_roots (id) ON DELETE SET NULL\n)',
    'CREATE TABLE project_members (\n\tproject_id VARCHAR(36) NOT NULL, \n\tagent_id VARCHAR(36) NOT NULL, \n\tenvironment VARCHAR(8), \n\tcreated_at FLOAT NOT NULL, \n\tPRIMARY KEY (project_id, agent_id), \n\tFOREIGN KEY(project_id) REFERENCES company_projects (id) ON DELETE CASCADE, \n\tFOREIGN KEY(agent_id) REFERENCES agents (id) ON DELETE CASCADE\n)',
    'CREATE TABLE company_runs (\n\tid VARCHAR(36) NOT NULL, \n\tcompany_id VARCHAR(36) NOT NULL, \n\tproject_id VARCHAR(36) NOT NULL, \n\tobjective TEXT NOT NULL, \n\tstate VARCHAR(24) NOT NULL, \n\tplanner VARCHAR(16) NOT NULL, \n\t"plan" JSON, \n\tsource VARCHAR(16) NOT NULL, \n\treply_target JSON, \n\tmax_model_calls INTEGER, \n\tresult JSON, \n\terror TEXT, \n\tcreated_by VARCHAR(128) NOT NULL, \n\tcreated_at FLOAT NOT NULL, \n\tupdated_at FLOAT NOT NULL, \n\tfinished_at FLOAT, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(company_id) REFERENCES companies (id) ON DELETE CASCADE, \n\tFOREIGN KEY(project_id) REFERENCES company_projects (id) ON DELETE CASCADE\n)',
    'CREATE TABLE company_work_items (\n\tid VARCHAR(36) NOT NULL, \n\trun_id VARCHAR(36) NOT NULL, \n\tcompany_id VARCHAR(36) NOT NULL, \n\tproject_id VARCHAR(36) NOT NULL, \n\tkind VARCHAR(16) NOT NULL, \n\ttitle VARCHAR(200) NOT NULL, \n\tprompt TEXT NOT NULL, \n\trole_key VARCHAR(48) NOT NULL, \n\tagent_id VARCHAR(36), \n\tdepends_on JSON NOT NULL, \n\tstate VARCHAR(16) NOT NULL, \n\tpriority INTEGER NOT NULL, \n\tenvironment VARCHAR(8), \n\tenv_source VARCHAR(32), \n\ttask_id VARCHAR(36), \n\tattempts INTEGER NOT NULL, \n\tmax_attempts INTEGER NOT NULL, \n\tresult_summary TEXT, \n\tartifacts JSON NOT NULL, \n\ttransfers JSON NOT NULL, \n\tposition INTEGER NOT NULL, \n\tcreated_at FLOAT NOT NULL, \n\tupdated_at FLOAT NOT NULL, \n\tstarted_at FLOAT, \n\tfinished_at FLOAT, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(run_id) REFERENCES company_runs (id) ON DELETE CASCADE\n)',
    'CREATE INDEX ix_company_items_run ON company_work_items (run_id, state)',
    'CREATE TABLE company_knowledge (\n\tid VARCHAR(36) NOT NULL, \n\tcompany_id VARCHAR(36) NOT NULL, \n\tproject_id VARCHAR(36), \n\tkind VARCHAR(16) NOT NULL, \n\ttitle VARCHAR(200) NOT NULL, \n\tcontent TEXT NOT NULL, \n\tauthor VARCHAR(128) NOT NULL, \n\tcreated_at FLOAT NOT NULL, \n\tupdated_at FLOAT NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(company_id) REFERENCES companies (id) ON DELETE CASCADE\n)',
    'CREATE INDEX ix_company_knowledge ON company_knowledge (company_id, kind)',
    'CREATE TABLE company_activity (\n\tid INTEGER NOT NULL, \n\tcompany_id VARCHAR(36) NOT NULL, \n\tproject_id VARCHAR(36), \n\trun_id VARCHAR(36), \n\tagent_id VARCHAR(36), \n\tkind VARCHAR(24) NOT NULL, \n\tcontent TEXT NOT NULL, \n\tpayload JSON, \n\tts FLOAT NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(company_id) REFERENCES companies (id) ON DELETE CASCADE\n)',
    'CREATE INDEX ix_company_activity ON company_activity (company_id, ts)',
    'CREATE TABLE telegram_bots (\n\tid VARCHAR(36) NOT NULL, \n\tagent_id VARCHAR(36) NOT NULL, \n\tbot_id INTEGER NOT NULL, \n\tusername VARCHAR(64), \n\tdisplay_name VARCHAR(128), \n\tkeychain_ref VARCHAR(128) NOT NULL, \n\tenabled BOOLEAN NOT NULL, \n\tstatus VARCHAR(16) NOT NULL, \n\tupdate_offset INTEGER NOT NULL, \n\tleader_id VARCHAR(64), \n\tleader_lease_until FLOAT, \n\tlast_poll_at FLOAT, \n\tlast_update_at FLOAT, \n\tlast_error TEXT, \n\tcreated_at FLOAT NOT NULL, \n\tupdated_at FLOAT NOT NULL, \n\tPRIMARY KEY (id), \n\tUNIQUE (agent_id), \n\tFOREIGN KEY(agent_id) REFERENCES agents (id) ON DELETE CASCADE, \n\tUNIQUE (bot_id)\n)',
    'CREATE TABLE telegram_bot_users (\n\tid VARCHAR(36) NOT NULL, \n\tbot_row_id VARCHAR(36) NOT NULL, \n\ttelegram_user_id INTEGER NOT NULL, \n\tchat_id INTEGER NOT NULL, \n\tusername VARCHAR(64), \n\tdisplay_name VARCHAR(128), \n\tstatus VARCHAR(16) NOT NULL, \n\tpairing_id VARCHAR(36), \n\tnotify_level VARCHAR(16) NOT NULL, \n\tapproved_at FLOAT, \n\tcreated_at FLOAT NOT NULL, \n\tPRIMARY KEY (id), \n\tCONSTRAINT uq_bot_user UNIQUE (bot_row_id, telegram_user_id), \n\tFOREIGN KEY(bot_row_id) REFERENCES telegram_bots (id) ON DELETE CASCADE\n)',
    'CREATE TABLE telegram_bot_updates (\n\tbot_row_id VARCHAR(36) NOT NULL, \n\tupdate_id INTEGER NOT NULL, \n\tprocessed BOOLEAN NOT NULL, \n\treceived_at FLOAT NOT NULL, \n\terror TEXT, \n\tPRIMARY KEY (bot_row_id, update_id)\n)',
    'CREATE TABLE telegram_task_cards (\n\ttask_id VARCHAR(36) NOT NULL, \n\tbot_key VARCHAR(36) NOT NULL, \n\tchat_id INTEGER NOT NULL, \n\tthread_id INTEGER, \n\tmessage_id INTEGER NOT NULL, \n\tstate VARCHAR(32), \n\tlast_hash VARCHAR(64), \n\tlast_edit_at FLOAT, \n\tcreated_at FLOAT NOT NULL, \n\tPRIMARY KEY (task_id, bot_key, chat_id)\n)',
    'CREATE TABLE telegram_callbacks (\n\tcallback_id VARCHAR(64) NOT NULL, \n\tbot_key VARCHAR(36) NOT NULL, \n\tdata VARCHAR(128), \n\tprocessed_at FLOAT NOT NULL, \n\tPRIMARY KEY (callback_id)\n)',
    'CREATE TABLE miniapp_auth (\n\thash VARCHAR(64) NOT NULL, \n\ttelegram_user_id INTEGER NOT NULL, \n\tbot_key VARCHAR(36) NOT NULL, \n\tsession_id VARCHAR(36), \n\tused_at FLOAT NOT NULL, \n\texpires_at FLOAT NOT NULL, \n\tPRIMARY KEY (hash)\n)',
    'CREATE TABLE attachments (\n\tid VARCHAR(36) NOT NULL, \n\tsource VARCHAR(16) NOT NULL, \n\tbot_key VARCHAR(36), \n\tchat_id INTEGER, \n\ttelegram_user_id INTEGER, \n\tuser_id VARCHAR(36), \n\tagent_id VARCHAR(36), \n\ttask_id VARCHAR(36), \n\tconversation VARCHAR(96), \n\tkind VARCHAR(16) NOT NULL, \n\tmime VARCHAR(128) NOT NULL, \n\tname VARCHAR(200) NOT NULL, \n\tsize INTEGER NOT NULL, \n\tsha256 VARCHAR(64) NOT NULL, \n\tstorage TEXT NOT NULL, \n\tstatus VARCHAR(16) NOT NULL, \n\textracted JSON NOT NULL, \n\tworkspace_path TEXT, \n\terror TEXT, \n\tcreated_at FLOAT NOT NULL, \n\texpires_at FLOAT, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(agent_id) REFERENCES agents (id) ON DELETE CASCADE\n)',
    'CREATE INDEX ix_attachments_agent ON attachments (agent_id, created_at)',
    'CREATE INDEX ix_attachments_task ON attachments (task_id)',
]


def upgrade() -> None:
    for stmt in DDL:
        op.execute(stmt)
    # plain ALTER TABLE ADD COLUMN: existing rows and rowids stay untouched
    op.add_column("tasks", sa.Column("execution", sa.JSON))
    op.add_column("telegram_users", sa.Column("notify_level", sa.String(16), nullable=False,
                                              server_default="important"))
    op.add_column("telegram_pairings", sa.Column("bot_row_id", sa.String(36)))


def downgrade() -> None:
    for t in reversed(NEW_TABLES):
        op.execute(f"DROP TABLE IF EXISTS {t}")
    with op.batch_alter_table("telegram_pairings") as b:
        b.drop_column("bot_row_id")
    with op.batch_alter_table("telegram_users") as b:
        b.drop_column("notify_level")
    with op.batch_alter_table("tasks") as b:
        b.drop_column("execution")
