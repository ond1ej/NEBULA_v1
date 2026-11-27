"""SQLite schema (spec §11). SQLAlchemy Core tables; migrations in /migrations (Alembic)."""

from __future__ import annotations

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    Float,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    UniqueConstraint,
)

metadata = MetaData()

users = Table(
    "users", metadata,
    Column("id", String(36), primary_key=True),
    Column("username", String(64), nullable=False, unique=True),
    Column("password_hash", Text, nullable=False),  # Argon2id
    Column("role", String(16), nullable=False, default="admin"),
    Column("recovery_policy", String(32), nullable=False, default="local_reset_cli"),
    Column("failed_attempts", Integer, nullable=False, default=0),
    Column("locked_until", Float),
    Column("created_at", Float, nullable=False),
    Column("last_login_at", Float),
)

sessions = Table(
    "sessions", metadata,
    Column("id", String(36), primary_key=True),
    Column("user_id", String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("token_hash", String(64), nullable=False, unique=True),
    Column("csrf_token", String(64), nullable=False),
    Column("created_at", Float, nullable=False),
    Column("expires_at", Float, nullable=False),
    Column("last_seen_at", Float, nullable=False),
    Column("user_agent", String(256)),
    # V3.3: when the owner last re-verified themselves on THIS session (step-up), and how
    Column("stepup_at", Float),
    Column("stepup_method", String(16)),
)

# V3.3: phones enrolled for Face ID / fingerprint confirmations through Telegram's BiometricManager. Only the SHA-256
# of the device token is stored; the token lives in the phone's biometric-protected storage and rotates on every use.
miniapp_devices = Table(
    "miniapp_devices", metadata,
    Column("id", String(24), primary_key=True),
    Column("telegram_user_id", Integer, nullable=False),
    Column("name", String(60), nullable=False),
    Column("token_hash", String(64), nullable=False),
    Column("created_at", Float, nullable=False),
    Column("last_used_at", Float),
    Column("revoked_at", Float),
)

# V4.0: the owner's native NEBULA apps (iPhone / Mac), paired from the dashboard with a one-time QR code. Each device
# holds two P-256 keys that never leave it (Secure Enclave where available): `identity_key` signs session challenges
# (no user interaction), `confirm_key` signs owner confirmations and is usable only after Face ID / Touch ID / the
# device passcode. Only the PUBLIC keys are stored here.
app_devices = Table(
    "app_devices", metadata,
    Column("id", String(24), primary_key=True),
    Column("name", String(60), nullable=False),
    Column("platform", String(16), nullable=False),  # ios | macos
    Column("model", String(60)),
    Column("app_version", String(24)),
    Column("identity_key", Text, nullable=False),  # base64 X9.63 P-256 public key
    Column("confirm_key", Text, nullable=False),
    Column("key_protection", String(24), nullable=False),  # secure_enclave | keychain
    Column("status", String(12), nullable=False),  # pending | active | rejected | revoked
    Column("pairing_digest", String(64), nullable=False),
    Column("created_at", Float, nullable=False),
    Column("approved_at", Float),
    Column("approved_by", String(64)),
    Column("last_seen_at", Float),
    Column("revoked_at", Float),
    Column("push_token", String(200)),
    Column("push_env", String(12)),
    Column("push_updated_at", Float),
)

# V4.0 unified owner authentication: the vault data key (DEK) wrapped for ONE owner device with a key derived from a
# 256-bit secret that only that device holds (released by Face ID / Touch ID / passcode on the phone or Mac, or by
# Telegram's BiometricManager). The server never stores the secret, so at rest the vault stays exactly as strong as
# before; revoking the device deletes its wrap.
owner_vault_keys = Table(
    "owner_vault_keys", metadata,
    Column("id", String(24), primary_key=True),
    Column("device_kind", String(12), nullable=False),  # app | telegram
    Column("device_id", String(24), nullable=False),
    Column("vault_id", String(36), nullable=False),
    Column("salt", String(32), nullable=False),
    Column("wrapped_dek", Text, nullable=False),
    Column("created_at", Float, nullable=False),
    Column("last_used_at", Float),
    UniqueConstraint("device_kind", "device_id", name="uq_owner_vault_keys_device"),
)

host_installation = Table(
    "host_installation", metadata,
    Column("id", Integer, primary_key=True),
    Column("installation_id", String(36), nullable=False),
    Column("state", String(32), nullable=False),
    Column("state_detail", Text),
    Column("app_version", String(32), nullable=False),
    Column("vm_image_version", String(64)),
    Column("guest_version", String(32)),
    Column("last_health", JSON),
    Column("updated_at", Float, nullable=False),
)

install_jobs = Table(
    "install_jobs", metadata,
    Column("id", String(36), primary_key=True),
    Column("kind", String(32), nullable=False),  # install | repair | uninstall | delete_agent | export
    Column("state", String(32), nullable=False),
    Column("current_step", String(64)),
    Column("steps", JSON, nullable=False, default=list),
    Column("progress", Float, nullable=False, default=0.0),
    Column("error", Text),
    Column("result", JSON),
    Column("idempotency_key", String(128)),
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float, nullable=False),
)

vm_instances = Table(
    "vm_instances", metadata,
    Column("id", String(36), primary_key=True),
    Column("status", String(32), nullable=False),
    Column("bundle_path", Text, nullable=False),
    Column("disk_path", Text, nullable=False),
    Column("memory_mb", Integer, nullable=False),
    Column("cpu_count", Integer, nullable=False),
    Column("disk_gb", Integer, nullable=False),
    Column("config_hash", String(64)),
    Column("image_version", String(64)),
    Column("mac_address", String(32)),
    Column("guest_ip", String(64)),
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float, nullable=False),
)

agents = Table(
    "agents", metadata,
    Column("id", String(36), primary_key=True),
    Column("name", String(64), nullable=False),
    Column("description", Text, nullable=False, default=""),
    Column("status", String(32), nullable=False),  # CREATING READY ACTIVE IDLE SLEEP PAUSED STOPPED ERROR DELETING
    Column("linux_user", String(32), unique=True),
    Column("display_id", String(32)),
    Column("provider_id", String(64)),
    Column("model_id", String(128)),
    Column("task_type", String(64), nullable=False, default="general"),
    Column("permission_level", String(16), nullable=False, default="STANDARD"),
    Column("permissions", JSON, nullable=False, default=list),
    Column("capabilities", JSON, nullable=False, default=list),
    Column("resource_mode", String(16), nullable=False, default="ACTIVE"),
    Column("desktop_resolution", String(16), nullable=False, default="1280x800"),
    Column("fallback_provider_id", String(64)),
    Column("fallback_model_id", String(128)),
    Column("desktop_health", JSON),
    Column("last_error", Text),
    Column("last_active_at", Float),
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float, nullable=False),
)

agent_workspaces = Table(
    "agent_workspaces", metadata,
    Column("id", String(64), primary_key=True),
    Column("agent_id", String(36), ForeignKey("agents.id", ondelete="CASCADE"), nullable=False, unique=True),
    Column("guest_path", Text, nullable=False),
    Column("quota_mb", Integer, nullable=False),
    Column("backup_pointer", Text),
    Column("created_at", Float, nullable=False),
)

tasks = Table(
    "tasks", metadata,
    Column("id", String(36), primary_key=True),
    Column("agent_id", String(36), ForeignKey("agents.id", ondelete="CASCADE"), nullable=False),
    Column("prompt", Text, nullable=False),
    Column("state", String(32), nullable=False),
    Column("current_step", Integer, nullable=False, default=0),
    Column("retry_count", Integer, nullable=False, default=0),
    Column("tool_calls_done", Integer, nullable=False, default=0),
    Column("max_steps", Integer, nullable=False, default=30),
    Column("checkpoint_id", String(36)),
    Column("requires_approval", Boolean, nullable=False, default=False),
    Column("pause_requested", String(16)),  # smart | immediate
    Column("source_channel", String(16), nullable=False, default="web"),
    Column("reply_target", JSON),  # e.g. telegram chat/thread to report to
    Column("result", JSON),
    Column("failure_reason", Text),
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float, nullable=False),
    Column("started_at", Float),
    Column("finished_at", Float),
)
Index("ix_tasks_agent_state_created", tasks.c.agent_id, tasks.c.state, tasks.c.created_at)

task_steps = Table(
    "task_steps", metadata,
    Column("id", String(36), primary_key=True),
    Column("task_id", String(36), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False),
    Column("seq", Integer, nullable=False),
    Column("tool_type", String(64), nullable=False),
    Column("args_sanitized", JSON),
    Column("result_status", String(32), nullable=False),
    Column("result_summary", Text),
    Column("screenshot_ref", Text),
    Column("elapsed_ms", Integer),
    Column("created_at", Float, nullable=False),
    UniqueConstraint("task_id", "seq", name="uq_task_steps_seq"),
)

task_checkpoints = Table(
    "task_checkpoints", metadata,
    Column("id", String(36), primary_key=True),
    Column("task_id", String(36), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False),
    Column("version", Integer, nullable=False, default=1),
    Column("state", JSON, nullable=False),
    Column("pending_side_effects", JSON, nullable=False, default=list),
    Column("resume_token", String(64)),
    Column("created_at", Float, nullable=False),
)
Index("ix_task_checkpoints_task", task_checkpoints.c.task_id, task_checkpoints.c.version)

messages = Table(
    "messages", metadata,
    Column("id", String(36), primary_key=True),
    Column("agent_id", String(36), ForeignKey("agents.id", ondelete="CASCADE"), nullable=False),
    Column("task_id", String(36)),
    Column("role", String(16), nullable=False),  # user | assistant | system | tool
    Column("channel", String(16), nullable=False),  # web | telegram | system
    Column("content", Text, nullable=False),
    Column("attachments", JSON, nullable=False, default=list),
    Column("created_at", Float, nullable=False),
)
Index("ix_messages_agent_time", messages.c.agent_id, messages.c.created_at)

agent_memory = Table(
    "agent_memory", metadata,
    Column("id", String(36), primary_key=True),
    Column("agent_id", String(36), ForeignKey("agents.id", ondelete="CASCADE"), nullable=False),
    Column("key", String(200), nullable=False),
    Column("value", Text, nullable=False),
    Column("source", String(64), nullable=False, default="agent"),
    Column("tags", String(400), nullable=False, default=""),
    Column("updated_at", Float, nullable=False),
    Column("expires_at", Float),
)

providers = Table(
    "providers", metadata,
    Column("id", String(64), primary_key=True),
    Column("adapter_type", String(32), nullable=False),
    Column("display_name", String(128), nullable=False),
    Column("state", String(32), nullable=False),
    Column("auth_mode", String(32), nullable=False),  # api_key | subscription | local | cli
    Column("keychain_ref", String(128)),
    Column("capabilities", JSON, nullable=False, default=list),
    Column("config", JSON, nullable=False, default=dict),
    Column("last_checked_at", Float),
    Column("last_error", Text),
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float, nullable=False),
)

telegram_config = Table(
    "telegram_config", metadata,
    Column("id", Integer, primary_key=True),
    Column("enabled", Boolean, nullable=False, default=False),
    Column("bot_id", Integer),
    Column("bot_username", String(64)),
    Column("keychain_ref", String(128)),
    Column("has_topics_enabled", Boolean),
    Column("allows_users_to_create_topics", Boolean),
    Column("update_offset", Integer, nullable=False, default=0),
    Column("leader_id", String(64)),
    Column("leader_lease_until", Float),
    Column("last_poll_at", Float),
    Column("last_error", Text),
    Column("updated_at", Float, nullable=False),
)

telegram_users = Table(
    "telegram_users", metadata,
    Column("id", String(36), primary_key=True),
    Column("telegram_user_id", Integer, nullable=False),
    Column("chat_id", Integer, nullable=False),
    Column("username", String(64)),
    Column("display_name", String(128)),
    Column("status", String(16), nullable=False),  # pending | approved | revoked
    Column("permissions", JSON, nullable=False, default=list),
    Column("selected_agent_id", String(36)),
    Column("pairing_id", String(36)),
    Column("approved_at", Float),
    Column("created_at", Float, nullable=False),
    UniqueConstraint("telegram_user_id", "chat_id", name="uq_tg_user_chat"),
)

telegram_pairings = Table(
    "telegram_pairings", metadata,
    Column("id", String(36), primary_key=True),
    Column("code_hash", String(64), nullable=False, unique=True),
    Column("expires_at", Float, nullable=False),
    Column("used_at", Float),
    Column("telegram_user_id", Integer),
    Column("chat_id", Integer),
    Column("created_at", Float, nullable=False),
)

telegram_topics = Table(
    "telegram_topics", metadata,
    Column("id", String(36), primary_key=True),
    Column("agent_id", String(36), ForeignKey("agents.id", ondelete="CASCADE"), nullable=False),
    Column("telegram_chat_id", Integer, nullable=False),
    Column("message_thread_id", Integer),
    Column("mapping_type", String(24), nullable=False),  # private_topic | supergroup_topic | command_fallback
    Column("topic_name", String(128)),
    Column("archived", Boolean, nullable=False, default=False),
    Column("created_at", Float, nullable=False),
    UniqueConstraint("telegram_chat_id", "message_thread_id", name="uq_tg_topic_thread"),
)

telegram_updates = Table(
    "telegram_updates", metadata,
    Column("update_id", Integer, primary_key=True),  # UNIQUE by PK — dedup
    Column("processed", Boolean, nullable=False, default=False),
    Column("received_at", Float, nullable=False),
    Column("error", Text),
    Column("retries", Integer, nullable=False, default=0),
)

live_sessions = Table(
    "live_sessions", metadata,
    Column("id", String(36), primary_key=True),
    Column("agent_id", String(36), ForeignKey("agents.id", ondelete="CASCADE"), nullable=False),
    Column("viewer_session_id", String(36), nullable=False),
    Column("token_hash", String(64), nullable=False),
    Column("state", String(24), nullable=False),  # CONNECTING VIEWING DISCONNECTING DISCONNECTED ERROR_RETRYABLE
    Column("control_lease", Boolean, nullable=False, default=False),
    Column("lease_expires_at", Float),
    Column("bytes_to_viewer", Integer, nullable=False, default=0),
    Column("created_at", Float, nullable=False),
    Column("expires_at", Float, nullable=False),
    Column("last_seen_at", Float),
    Column("ended_at", Float),
)

approvals = Table(
    "approvals", metadata,
    Column("id", String(36), primary_key=True),
    Column("task_id", String(36), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False),
    Column("agent_id", String(36), nullable=False),
    Column("tool", String(64), nullable=False),
    Column("action_summary", Text, nullable=False),
    Column("action_preview", JSON),
    Column("reason", Text),
    Column("requested_by", String(64), nullable=False, default="agent"),
    Column("resolved_by", String(64)),
    Column("decision", String(16)),  # approved | denied | expired
    Column("created_at", Float, nullable=False),
    Column("expires_at", Float, nullable=False),
    Column("resolved_at", Float),
)

audit_events = Table(
    "audit_events", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("ts", Float, nullable=False),
    Column("actor", String(128), nullable=False),
    Column("action", String(128), nullable=False),
    Column("target", String(256)),
    Column("metadata", JSON),
    Column("request_id", String(36)),
)
Index("ix_audit_events_ts", audit_events.c.ts)

events = Table(
    "events", metadata,
    Column("sequence", Integer, primary_key=True, autoincrement=True),
    Column("id", String(36), nullable=False, unique=True),
    Column("type", String(64), nullable=False),
    Column("agent_id", String(36)),
    Column("task_id", String(36)),
    Column("timestamp", Float, nullable=False),
    Column("payload", JSON, nullable=False),
)
Index("ix_events_type_seq", events.c.type, events.c.sequence)  # V3 perf (0005): notifications, retention

idempotency_keys = Table(
    "idempotency_keys", metadata,
    Column("key", String(128), primary_key=True),
    Column("route", String(256), nullable=False),
    Column("status_code", Integer, nullable=False),
    Column("response", JSON, nullable=False),
    Column("created_at", Float, nullable=False),
)

settings = Table(
    "settings", metadata,
    Column("key", String(128), primary_key=True),
    Column("value", JSON),
    Column("updated_at", Float, nullable=False),
)


# ============================================================================ NEBULA V2 (migration 0003)
# Module 1 memory columns live on agent_memory (kind/scope/importance/...); see migrations/versions/0003_v2.py.
for _c in (
    Column("kind", String(16), nullable=False, server_default="fact"),  # fact preference decision episode project note
    Column("scope", String(16), nullable=False, server_default="private"),  # private | shared
    Column("shared_with", JSON, nullable=False, server_default="[]"),  # agent ids, "team:<id>", or "*"
    Column("project", String(128)),
    Column("importance", Integer, nullable=False, server_default="3"),  # 1..5
    Column("pinned", Boolean, nullable=False, server_default="0"),
    Column("trust", String(16), nullable=False, server_default="agent"),  # owner | agent | system | web
    Column("use_count", Integer, nullable=False, server_default="0"),
    Column("last_used_at", Float),
    Column("content_hash", String(64)),
    Column("created_at", Float),
):
    agent_memory.append_column(_c)
Index("ix_memory_agent_kind", agent_memory.c.agent_id, agent_memory.c.kind)

agents.append_column(Column("config", JSON, nullable=False, server_default="{}"))  # per-agent V2 settings
for _c in (
    Column("priority", Integer, nullable=False, server_default="0"),  # higher runs first (interactive > scheduled)
    Column("parent_ref", JSON),  # {"type": team_run|workflow_run|schedule_run, "id": ..., ...}
    Column("project", String(128)),
    Column("deadline_at", Float),  # max runtime (schedules/workflows): cancelled when exceeded
    Column("origin_depth", Integer, nullable=False, server_default="0"),  # automation nesting depth
):
    tasks.append_column(_c)
tasks.append_column(Column("max_model_calls", Integer))  # V3 perf (0005): optional hard cap on model requests
Index("ix_tasks_state_priority", tasks.c.state, tasks.c.priority, tasks.c.created_at)  # V3 perf (0005)

memory_embeddings = Table(
    "memory_embeddings", metadata,
    Column("memory_id", String(36), ForeignKey("agent_memory.id", ondelete="CASCADE"), primary_key=True),
    Column("model", String(128), nullable=False),
    Column("dim", Integer, nullable=False),
    Column("vector", Text, nullable=False),  # base64 float32
    Column("created_at", Float, nullable=False),
)

# ---- Module 2: teams
teams = Table(
    "teams", metadata,
    Column("id", String(36), primary_key=True),
    Column("name", String(64), nullable=False, unique=True),
    Column("description", Text, nullable=False, default=""),
    Column("lead_agent_id", String(36), ForeignKey("agents.id", ondelete="SET NULL")),
    Column("mode", String(16), nullable=False, default="sequential"),  # sequential | parallel
    Column("max_delegation_depth", Integer, nullable=False, default=2),
    Column("max_subtasks", Integer, nullable=False, default=8),
    Column("share_memory", Boolean, nullable=False, default=True),
    Column("shared_dir", String(64)),  # guest /srv/nebula/shared/<shared_dir>
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float, nullable=False),
)

team_members = Table(
    "team_members", metadata,
    Column("team_id", String(36), ForeignKey("teams.id", ondelete="CASCADE"), primary_key=True),
    Column("agent_id", String(36), ForeignKey("agents.id", ondelete="CASCADE"), primary_key=True),
    Column("role", String(64), nullable=False, default="member"),
    Column("instructions", Text, nullable=False, default=""),
    Column("position", Integer, nullable=False, default=0),
)

team_runs = Table(
    "team_runs", metadata,
    Column("id", String(36), primary_key=True),
    Column("team_id", String(36), ForeignKey("teams.id", ondelete="CASCADE"), nullable=False),
    Column("prompt", Text, nullable=False),
    Column("state", String(24), nullable=False),  # RUNNING COMPLETED FAILED CANCELLED
    Column("source", String(16), nullable=False, default="web"),
    Column("reply_target", JSON),
    Column("parent_ref", JSON),
    Column("origin_depth", Integer, nullable=False, default=0),
    Column("max_model_calls", Integer),
    Column("result", JSON),
    Column("error", Text),
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float, nullable=False),
    Column("finished_at", Float),
)

team_subtasks = Table(
    "team_subtasks", metadata,
    Column("id", String(36), primary_key=True),
    Column("run_id", String(36), ForeignKey("team_runs.id", ondelete="CASCADE"), nullable=False),
    Column("parent_subtask_id", String(36)),
    Column("agent_id", String(36), ForeignKey("agents.id", ondelete="CASCADE"), nullable=False),
    Column("role", String(64), nullable=False),
    Column("title", String(200), nullable=False),
    Column("prompt", Text, nullable=False),
    Column("depends_on", JSON, nullable=False, default=list),
    Column("state", String(24), nullable=False),  # PENDING READY RUNNING COMPLETED FAILED SKIPPED CANCELLED
    Column("task_id", String(36)),
    Column("attempts", Integer, nullable=False, default=0),
    Column("max_attempts", Integer, nullable=False, default=2),
    Column("depth", Integer, nullable=False, default=0),
    Column("result_summary", Text),
    Column("artifacts", JSON, nullable=False, default=list),
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float, nullable=False),
)
Index("ix_team_subtasks_run", team_subtasks.c.run_id, team_subtasks.c.state)

agent_messages = Table(  # Agent Message Bus + Collaboration Audit Log
    "agent_messages", metadata,
    Column("id", String(36), primary_key=True),
    Column("run_id", String(36), ForeignKey("team_runs.id", ondelete="CASCADE")),
    Column("from_agent_id", String(36)),
    Column("to_agent_id", String(36)),
    Column("kind", String(24), nullable=False),  # handoff | delegate | result | failure | review | system
    Column("content", Text, nullable=False),
    Column("payload", JSON),
    Column("created_at", Float, nullable=False),
)

# ---- Module 3: schedules
schedules = Table(
    "schedules", metadata,
    Column("id", String(36), primary_key=True),
    Column("name", String(128), nullable=False),
    Column("target_type", String(16), nullable=False),  # agent | team | workflow
    Column("target_id", String(36), nullable=False),
    Column("prompt", Text, nullable=False, default=""),
    Column("kind", String(16), nullable=False),  # once | interval | daily | weekly | monthly | cron
    Column("spec", JSON, nullable=False, default=dict),  # {at, every_s, time, weekdays, day, cron}
    Column("timezone", String(64), nullable=False, default="UTC"),
    Column("enabled", Boolean, nullable=False, default=True),
    Column("misfire_policy", String(16), nullable=False, default="run_once"),  # skip | run_once | ask
    Column("overlap_policy", String(16), nullable=False, default="skip"),  # skip | queue
    Column("retry_max", Integer, nullable=False, default=0),
    Column("retry_delay_s", Integer, nullable=False, default=300),
    Column("max_runtime_s", Integer, nullable=False, default=1800),
    Column("max_model_calls", Integer, nullable=False, default=20),
    Column("notify", JSON, nullable=False, default=dict),  # {"telegram": true}
    Column("next_run_at", Float),
    Column("last_run_at", Float),
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float, nullable=False),
)

schedule_runs = Table(
    "schedule_runs", metadata,
    Column("id", String(36), primary_key=True),
    Column("schedule_id", String(36), ForeignKey("schedules.id", ondelete="CASCADE"), nullable=False),
    Column("scheduled_for", Float, nullable=False),
    Column("attempt", Integer, nullable=False, default=1),
    Column("trigger", String(16), nullable=False, default="timer"),  # timer | manual | retry | misfire
    Column("state", String(24), nullable=False),  # RUNNING COMPLETED FAILED SKIPPED AWAITING_CONFIRMATION CANCELLED
    Column("target_ref", JSON),  # {"task_id"} | {"team_run_id"} | {"workflow_run_id"}
    Column("detail", Text),
    Column("started_at", Float),
    Column("finished_at", Float),
    Column("created_at", Float, nullable=False),
    UniqueConstraint("schedule_id", "scheduled_for", "attempt", name="uq_schedule_run_slot"),  # no duplicate runs
)

# ---- Module 6: workflows
workflows = Table(
    "workflows", metadata,
    Column("id", String(36), primary_key=True),
    Column("name", String(128), nullable=False),
    Column("description", Text, nullable=False, default=""),
    Column("version", Integer, nullable=False, default=1),
    Column("definition", JSON, nullable=False),  # schema_version 1: {nodes, edges}
    Column("enabled", Boolean, nullable=False, default=True),
    Column("trigger_types", JSON, nullable=False, default=list),
    Column("max_runs_per_hour", Integer, nullable=False, default=20),
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float, nullable=False),
)

workflow_runs = Table(
    "workflow_runs", metadata,
    Column("id", String(36), primary_key=True),
    Column("workflow_id", String(36), ForeignKey("workflows.id", ondelete="CASCADE"), nullable=False),
    Column("workflow_version", Integer, nullable=False),
    Column("definition", JSON, nullable=False),  # snapshot: edits never change a running workflow
    Column("state", String(24), nullable=False),  # RUNNING COMPLETED FAILED CANCELLED WAITING
    Column("trigger", String(32), nullable=False),
    Column("trigger_payload", JSON),
    Column("context", JSON, nullable=False, default=dict),
    Column("origin_depth", Integer, nullable=False, default=0),
    Column("error", Text),
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float, nullable=False),
    Column("finished_at", Float),
)

workflow_steps = Table(
    "workflow_steps", metadata,
    Column("id", String(36), primary_key=True),
    Column("run_id", String(36), ForeignKey("workflow_runs.id", ondelete="CASCADE"), nullable=False),
    Column("node_id", String(64), nullable=False),
    Column("node_type", String(32), nullable=False),
    Column("state", String(24), nullable=False),  # RUNNING COMPLETED FAILED SKIPPED WAITING UNKNOWN
    Column("attempt", Integer, nullable=False, default=1),
    Column("output", JSON),
    Column("ref", JSON),  # e.g. {"task_id"} so a restarted engine re-attaches instead of re-running
    Column("error", Text),
    Column("started_at", Float, nullable=False),
    Column("finished_at", Float),
    UniqueConstraint("run_id", "node_id", "attempt", name="uq_workflow_step"),
)

# Generic owner approvals for automation (workflow Wait-for-Approval, approved commands, missed schedules,
# package installs). Task tool approvals keep using `approvals`.
owner_approvals = Table(
    "owner_approvals", metadata,
    Column("id", String(36), primary_key=True),
    Column("kind", String(32), nullable=False),  # workflow | command | schedule_misfire | package_install | plugin
    Column("ref", JSON, nullable=False),
    Column("summary", Text, nullable=False),
    Column("preview", JSON),
    Column("decision", String(16)),  # approved | denied | expired
    Column("resolved_by", String(64)),
    Column("created_at", Float, nullable=False),
    Column("expires_at", Float, nullable=False),
    Column("resolved_at", Float),
)

# ---- Module 9: skills & plugins
skills = Table(
    "skills", metadata,
    Column("id", String(64), primary_key=True),
    Column("name", String(128), nullable=False),
    Column("version", String(32), nullable=False),
    Column("description", Text, nullable=False, default=""),
    Column("kind", String(16), nullable=False),  # builtin | plugin
    Column("manifest", JSON, nullable=False),
    Column("enabled", Boolean, nullable=False, default=True),
    Column("checksum", String(64)),
    Column("installed_at", Float, nullable=False),
    Column("updated_at", Float, nullable=False),
)

agent_skills = Table(
    "agent_skills", metadata,
    Column("agent_id", String(36), ForeignKey("agents.id", ondelete="CASCADE"), primary_key=True),
    Column("skill_id", String(64), ForeignKey("skills.id", ondelete="CASCADE"), primary_key=True),
    Column("enabled", Boolean, nullable=False, default=True),
    Column("config", JSON, nullable=False, default=dict),
    Column("assigned_at", Float, nullable=False),
)

skill_usage = Table(
    "skill_usage", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("skill_id", String(64), nullable=False),
    Column("agent_id", String(36)),
    Column("task_id", String(36)),
    Column("tool", String(64), nullable=False),
    Column("status", String(16), nullable=False),
    Column("ts", Float, nullable=False),
)

# ---- Module 7: resource history
resource_samples = Table(
    "resource_samples", metadata,
    Column("ts", Float, primary_key=True),
    Column("host_mem_used_pct", Float),
    Column("host_pressure", String(16)),
    Column("host_cpu_pct", Float),
    Column("host_swap_used_mb", Float),
    Column("disk_free_gb", Float),
    Column("vm_rss_mb", Float),
    Column("guest_mem_avail_mb", Float),
    Column("guest_load1", Float),
    Column("active_agents", Integer),
    Column("queued_tasks", Integer),
    Column("profile", String(16)),
    Column("host_free_pct", Float),  # V3 perf: kern.memorystatus_level
    Column("swap_growth_mb", Float),  # V3 perf: swap growth over the admission window
    Column("vm_footprint_mb", Float),  # V3 perf: real VM footprint (libproc phys_footprint)
)

# ---- Module 8: file history
file_events = Table(
    "file_events", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("ts", Float, nullable=False),
    Column("actor", String(128), nullable=False),
    Column("root", String(96), nullable=False),  # agent:<id> | team:<id> | exchange
    Column("op", String(24), nullable=False),
    Column("path", Text, nullable=False),
    Column("dest", Text),
    Column("size", Integer),
)
Index("ix_file_events_root", file_events.c.root, file_events.c.ts)


# ============================================================================ NEBULA V3 (migration 0004)
tasks.append_column(Column("execution", JSON))  # {"env": "vm"|"host", "root_id": ..., "source": ...}
telegram_users.append_column(Column("notify_level", String(16), nullable=False, server_default="important"))
telegram_pairings.append_column(Column("bot_row_id", String(36)))  # NULL = main NEBULA bot

# ---- Host execution: owner-authorised project directories on the Mac
host_project_roots = Table(
    "host_project_roots", metadata,
    Column("id", String(36), primary_key=True),
    Column("name", String(128), nullable=False),
    Column("path", Text, nullable=False, unique=True),  # canonical absolute path (realpath at authorisation)
    Column("mode", String(16), nullable=False, default="read_write"),  # read_write | read_only
    # Python-side default only (no server_default): the schema and existing rows are unchanged, no migration.
    # Network stays off unless the owner turns it on for the folder (VM-03).
    Column("allow_network", Boolean, nullable=False, default=False),
    Column("allowed_tools", JSON, nullable=False, default=list),  # [] = every detected developer tool
    Column("enabled", Boolean, nullable=False, default=True),
    Column("created_by", String(128), nullable=False, default="owner"),
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float, nullable=False),
)

host_commands = Table(  # audit of every command / file mutation executed natively on the Mac
    "host_commands", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("ts", Float, nullable=False),
    Column("agent_id", String(36)),
    Column("task_id", String(36)),
    Column("root_id", String(36)),
    Column("tool", String(64), nullable=False),
    Column("command", Text),
    Column("cwd", Text),
    Column("status", String(16), nullable=False),  # ok | error | denied | timeout
    Column("exit_code", Integer),
    Column("duration_ms", Integer),
    Column("detail", Text),
)
Index("ix_host_commands_root", host_commands.c.root_id, host_commands.c.ts)

# ---- AI Company Mode 2.0
companies = Table(
    "companies", metadata,
    Column("id", String(36), primary_key=True),
    Column("name", String(96), nullable=False, unique=True),
    Column("description", Text, nullable=False, default=""),
    Column("objective", Text, nullable=False, default=""),
    Column("industry", String(96), nullable=False, default=""),
    Column("default_environment", String(8), nullable=False, default="vm"),  # vm | host
    Column("default_root_id", String(36)),  # host project root used when the default environment is host
    Column("provider_prefs", JSON, nullable=False, default=dict),  # {provider_id, model_id}
    Column("resource_policy", JSON, nullable=False, default=dict),  # {max_parallel}
    Column("budget", JSON, nullable=False, default=dict),  # {max_model_calls_per_run, max_model_calls_total}
    Column("approval_policy", JSON, nullable=False, default=dict),  # {plan_approval, external_actions}
    Column("ceo_agent_id", String(36), ForeignKey("agents.id", ondelete="SET NULL")),
    Column("workspace_dir", String(64)),  # guest /srv/nebula/shared/<workspace_dir>
    Column("status", String(16), nullable=False, default="ACTIVE"),  # ACTIVE | PAUSED | ARCHIVED
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float, nullable=False),
)

company_roles = Table(
    "company_roles", metadata,
    Column("company_id", String(36), ForeignKey("companies.id", ondelete="CASCADE"), primary_key=True),
    Column("key", String(48), primary_key=True),
    Column("title", String(96), nullable=False),
    Column("responsibilities", Text, nullable=False, default=""),
    Column("stage", Integer, nullable=False, default=50),  # ordering in template plans (lower = earlier)
    Column("position", Integer, nullable=False, default=0),
)

company_members = Table(
    "company_members", metadata,
    Column("company_id", String(36), ForeignKey("companies.id", ondelete="CASCADE"), primary_key=True),
    Column("agent_id", String(36), ForeignKey("agents.id", ondelete="CASCADE"), primary_key=True, unique=True),
    Column("role_key", String(48), nullable=False),
    Column("title", String(96), nullable=False, default=""),
    Column("reports_to", String(36)),
    Column("environment", String(8)),  # NULL = inherit | vm | host
    Column("instructions", Text, nullable=False, default=""),
    Column("position", Integer, nullable=False, default=0),
    Column("created_at", Float, nullable=False),
)

company_projects = Table(
    "company_projects", metadata,
    Column("id", String(36), primary_key=True),
    Column("company_id", String(36), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False),
    Column("name", String(128), nullable=False),
    Column("description", Text, nullable=False, default=""),
    Column("objective", Text, nullable=False, default=""),
    Column("status", String(16), nullable=False, default="ACTIVE"),  # PLANNING ACTIVE PAUSED COMPLETED ARCHIVED
    Column("environment", String(8)),  # NULL = company default | vm | host
    Column("host_root_id", String(36), ForeignKey("host_project_roots.id", ondelete="SET NULL")),
    Column("git", JSON, nullable=False, default=dict),  # {remote, branch} (host repos are detected live)
    Column("milestones", JSON, nullable=False, default=list),  # [{id, title, due, done}]
    Column("budget", JSON, nullable=False, default=dict),  # {max_model_calls_per_run}
    Column("vm_dir", String(64)),  # project folder inside the company directory in the VM
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float, nullable=False),
    UniqueConstraint("company_id", "name", name="uq_company_project_name"),
)

project_members = Table(  # agent assignment to a project (+ optional environment override)
    "project_members", metadata,
    Column("project_id", String(36), ForeignKey("company_projects.id", ondelete="CASCADE"), primary_key=True),
    Column("agent_id", String(36), ForeignKey("agents.id", ondelete="CASCADE"), primary_key=True),
    Column("environment", String(8)),
    Column("created_at", Float, nullable=False),
)

company_runs = Table(
    "company_runs", metadata,
    Column("id", String(36), primary_key=True),
    Column("company_id", String(36), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False),
    Column("project_id", String(36), ForeignKey("company_projects.id", ondelete="CASCADE"), nullable=False),
    Column("objective", Text, nullable=False),
    Column("state", String(24), nullable=False),  # PLANNING AWAITING_APPROVAL RUNNING PAUSED COMPLETED FAILED CANCELLED
    Column("planner", String(16), nullable=False, default="template"),  # template | ceo
    Column("plan", JSON),
    Column("source", String(16), nullable=False, default="web"),
    Column("reply_target", JSON),
    Column("max_model_calls", Integer),
    Column("result", JSON),
    Column("error", Text),
    Column("created_by", String(128), nullable=False, default="owner"),
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float, nullable=False),
    Column("finished_at", Float),
)

company_work_items = Table(
    "company_work_items", metadata,
    Column("id", String(36), primary_key=True),
    Column("run_id", String(36), ForeignKey("company_runs.id", ondelete="CASCADE"), nullable=False),
    Column("company_id", String(36), nullable=False),
    Column("project_id", String(36), nullable=False),
    Column("kind", String(16), nullable=False, default="work"),  # plan | work | review | summary
    Column("title", String(200), nullable=False),
    Column("prompt", Text, nullable=False),
    Column("role_key", String(48), nullable=False),
    Column("agent_id", String(36)),
    Column("depends_on", JSON, nullable=False, default=list),
    Column("state", String(16), nullable=False),  # PENDING READY RUNNING WAITING COMPLETED FAILED SKIPPED CANCELLED
    Column("priority", Integer, nullable=False, default=0),
    Column("environment", String(8)),
    Column("env_source", String(32)),
    Column("task_id", String(36)),
    Column("attempts", Integer, nullable=False, default=0),
    Column("max_attempts", Integer, nullable=False, default=2),
    Column("result_summary", Text),
    Column("artifacts", JSON, nullable=False, default=list),
    Column("transfers", JSON, nullable=False, default=list),
    Column("position", Integer, nullable=False, default=0),
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float, nullable=False),
    Column("started_at", Float),
    Column("finished_at", Float),
)
Index("ix_company_items_run", company_work_items.c.run_id, company_work_items.c.state)

company_knowledge = Table(
    "company_knowledge", metadata,
    Column("id", String(36), primary_key=True),
    Column("company_id", String(36), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False),
    Column("project_id", String(36)),
    Column("kind", String(16), nullable=False),  # knowledge decision requirement doc report
    Column("title", String(200), nullable=False),
    Column("content", Text, nullable=False),
    Column("author", String(128), nullable=False),
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float, nullable=False),
)
Index("ix_company_knowledge", company_knowledge.c.company_id, company_knowledge.c.kind)

company_activity = Table(
    "company_activity", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("company_id", String(36), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False),
    Column("project_id", String(36)),
    Column("run_id", String(36)),
    Column("agent_id", String(36)),
    Column("kind", String(24), nullable=False),  # run plan assign handoff transfer result failure review system
    Column("content", Text, nullable=False),
    Column("payload", JSON),
    Column("ts", Float, nullable=False),
)
Index("ix_company_activity", company_activity.c.company_id, company_activity.c.ts)

# ---- Telegram: independent bot per agent, live task cards, callback dedup, Mini App replay protection
telegram_bots = Table(
    "telegram_bots", metadata,
    Column("id", String(36), primary_key=True),
    Column("agent_id", String(36), ForeignKey("agents.id", ondelete="CASCADE"), nullable=False, unique=True),
    Column("bot_id", Integer, nullable=False, unique=True),
    Column("username", String(64)),
    Column("display_name", String(128)),
    Column("keychain_ref", String(128), nullable=False),
    Column("enabled", Boolean, nullable=False, default=True),
    Column("status", String(16), nullable=False, default="ACTIVE"),  # ACTIVE DISABLED ERROR REVOKED
    Column("update_offset", Integer, nullable=False, default=0),
    Column("leader_id", String(64)),
    Column("leader_lease_until", Float),
    Column("last_poll_at", Float),
    Column("last_update_at", Float),
    Column("last_error", Text),
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float, nullable=False),
)

telegram_bot_users = Table(
    "telegram_bot_users", metadata,
    Column("id", String(36), primary_key=True),
    Column("bot_row_id", String(36), ForeignKey("telegram_bots.id", ondelete="CASCADE"), nullable=False),
    Column("telegram_user_id", Integer, nullable=False),
    Column("chat_id", Integer, nullable=False),
    Column("username", String(64)),
    Column("display_name", String(128)),
    Column("status", String(16), nullable=False),  # pending | approved | revoked
    Column("pairing_id", String(36)),
    Column("notify_level", String(16), nullable=False, default="important"),
    Column("approved_at", Float),
    Column("created_at", Float, nullable=False),
    UniqueConstraint("bot_row_id", "telegram_user_id", name="uq_bot_user"),
)

telegram_bot_updates = Table(
    "telegram_bot_updates", metadata,
    Column("bot_row_id", String(36), primary_key=True),
    Column("update_id", Integer, primary_key=True),
    Column("processed", Boolean, nullable=False, default=False),
    Column("received_at", Float, nullable=False),
    Column("error", Text),
)

telegram_task_cards = Table(
    "telegram_task_cards", metadata,
    Column("task_id", String(36), primary_key=True),
    Column("bot_key", String(36), primary_key=True),  # "main" | telegram_bots.id
    Column("chat_id", Integer, primary_key=True),
    Column("thread_id", Integer),
    Column("message_id", Integer, nullable=False),
    Column("state", String(32)),
    Column("last_hash", String(64)),
    Column("last_edit_at", Float),
    Column("created_at", Float, nullable=False),
)

telegram_callbacks = Table(
    "telegram_callbacks", metadata,
    Column("callback_id", String(64), primary_key=True),
    Column("bot_key", String(36), nullable=False),
    Column("data", String(128)),
    Column("processed_at", Float, nullable=False),
)

miniapp_auth = Table(  # used initData hashes (one exchange per launch) -> replay protection
    "miniapp_auth", metadata,
    Column("hash", String(64), primary_key=True),
    Column("telegram_user_id", Integer, nullable=False),
    Column("bot_key", String(36), nullable=False),
    Column("session_id", String(36)),
    Column("used_at", Float, nullable=False),
    Column("expires_at", Float, nullable=False),
)

# ---- Multimodal attachments
attachments = Table(
    "attachments", metadata,
    Column("id", String(36), primary_key=True),
    Column("source", String(16), nullable=False),  # telegram | web | api
    Column("bot_key", String(36)),
    Column("chat_id", Integer),
    Column("telegram_user_id", Integer),
    Column("user_id", String(36)),
    Column("agent_id", String(36), ForeignKey("agents.id", ondelete="CASCADE")),
    Column("task_id", String(36)),
    Column("conversation", String(96)),  # e.g. tg:<bot>:<chat> | web:<agent>
    Column("kind", String(16), nullable=False),  # image pdf docx text csv json zip code audio voice video other
    Column("mime", String(128), nullable=False),
    Column("name", String(200), nullable=False),
    Column("size", Integer, nullable=False),
    Column("sha256", String(64), nullable=False),
    Column("storage", Text, nullable=False),  # relative to data_dir/attachments
    Column("status", String(16), nullable=False),  # RECEIVED PROCESSED FAILED REJECTED
    Column("extracted", JSON, nullable=False, default=dict),
    Column("workspace_path", Text),
    Column("error", Text),
    Column("created_at", Float, nullable=False),
    Column("expires_at", Float),
)
Index("ix_attachments_task", attachments.c.task_id)
Index("ix_attachments_agent", attachments.c.agent_id, attachments.c.created_at)

# ---- V3.2: conversations (several chats per agent) — migration 0006
conversations = Table(
    "conversations", metadata,
    Column("id", String(36), primary_key=True),
    Column("agent_id", String(36), ForeignKey("agents.id", ondelete="CASCADE"), nullable=False),
    Column("owner_id", String(36)),  # users.id of the owner who started it (single-owner install)
    Column("title", String(200), nullable=False),
    Column("is_default", Boolean, nullable=False, server_default="0"),  # where web/Telegram tasks without a chat land
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float, nullable=False),
    Column("last_message_at", Float),
    Column("last_read_at", Float),
    Column("archived_at", Float),
)
Index("ix_conversations_agent", conversations.c.agent_id, conversations.c.archived_at, conversations.c.last_message_at)
Index("ix_conversations_recent", conversations.c.last_message_at)
messages.append_column(Column("conversation_id", String(36)))
messages.append_column(Column("client_id", String(64)))  # client-generated id: retries never duplicate a message
Index("ix_messages_conversation_time", messages.c.conversation_id, messages.c.created_at)
Index("uq_messages_conversation_client", messages.c.conversation_id, messages.c.client_id, unique=True)
tasks.append_column(Column("conversation_id", String(36)))
Index("ix_tasks_conversation", tasks.c.conversation_id)
approvals.append_column(Column("consumed_at", Float))  # single-use approvals (vault credential use)

# ---- V3.2: Password Vault (local, encrypted) — migration 0006. No plaintext secret is ever stored in a column.
vault_metadata = Table(
    "vault_metadata", metadata,
    Column("vault_id", String(36), primary_key=True),
    Column("version", Integer, nullable=False),
    Column("kdf", JSON, nullable=False),  # {"alg": "argon2id", "salt": b64, "time_cost", "memory_kib", "parallelism"}
    Column("wrapped_dek", Text, nullable=False),  # b64(nonce || AES-256-GCM(KEK, DEK, aad))
    Column("auto_lock_minutes", Integer, nullable=False, server_default="15"),
    Column("failed_attempts", Integer, nullable=False, server_default="0"),
    Column("lockout_until", Float),
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float, nullable=False),
    Column("passphrase_changed_at", Float),
)
vault_entries = Table(
    "vault_entries", metadata,
    Column("id", String(36), primary_key=True),
    Column("vault_id", String(36), ForeignKey("vault_metadata.vault_id", ondelete="CASCADE"), nullable=False),
    Column("display_name", String(200), nullable=False),
    Column("app_name", String(200), nullable=False, server_default=""),
    Column("origin", String(300)),  # canonical scheme://host[:port] for website credentials
    Column("credential_type", String(16), nullable=False),  # website | application | api_token
    Column("tags", JSON, nullable=False, server_default="[]"),
    Column("encrypted_payload", Text, nullable=False),  # b64 AES-256-GCM(DEK, {username,password,notes,...}, aad)
    Column("nonce", String(32), nullable=False),  # b64 96-bit nonce, unique per encryption
    Column("record_version", Integer, nullable=False, server_default="1"),
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float, nullable=False),
    Column("deleted_at", Float),
)
Index("ix_vault_entries_live", vault_entries.c.deleted_at, vault_entries.c.display_name)
vault_agent_policies = Table(
    "vault_agent_policies", metadata,
    Column("agent_id", String(36), ForeignKey("agents.id", ondelete="CASCADE"), primary_key=True),
    Column("mode", String(16), nullable=False, server_default="NONE"),  # NONE | SELECTED | MANAGED
    Column("managed_tags", JSON, nullable=False, server_default="[]"),
    Column("mac", String(64)),  # HMAC (vault key) over the policy: rows edited outside NEBULA are ignored
    Column("updated_at", Float, nullable=False),
)
vault_agent_grants = Table(
    "vault_agent_grants", metadata,
    Column("id", String(36), primary_key=True),
    Column("vault_entry_id", String(36), ForeignKey("vault_entries.id", ondelete="CASCADE"), nullable=False),
    Column("agent_id", String(36), ForeignKey("agents.id", ondelete="CASCADE"), nullable=False),
    Column("allowed_actions", JSON, nullable=False),  # ["sign_in"]
    Column("allowed_origins", JSON, nullable=False),  # exact canonical origins
    Column("approval_policy", String(16), nullable=False, server_default="always_ask"),  # always_ask|once_per_task|auto
    Column("enabled", Boolean, nullable=False, server_default="1"),
    Column("expires_at", Float),
    Column("created_by", String(64)),
    Column("mac", String(64)),  # HMAC (vault key) over the grant: forged/edited rows never authorise anything
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float, nullable=False),
    Column("last_used_at", Float),
)
Index("ix_vault_grants_agent", vault_agent_grants.c.agent_id)
Index("ix_vault_grants_entry", vault_agent_grants.c.vault_entry_id)
vault_access_audit = Table(
    "vault_access_audit", metadata,
    Column("id", String(36), primary_key=True),
    Column("ts", Float, nullable=False),
    Column("actor_type", String(16), nullable=False),  # owner | agent | system
    Column("actor_id", String(96)),
    Column("agent_id", String(36)),
    Column("entry_id", String(36)),
    Column("task_id", String(36)),
    Column("operation", String(32), nullable=False),
    Column("destination_origin", String(300)),
    Column("approval_id", String(36)),
    Column("outcome", String(16), nullable=False),  # ok | denied | error
    Column("reason_code", String(64)),
)
Index("ix_vault_audit_ts", vault_access_audit.c.ts)
Index("ix_vault_audit_agent", vault_access_audit.c.agent_id, vault_access_audit.c.ts)

# ============================================================================ V3.2.1 Smart Authentication
# One row per sign-in assistance session (agent + task bound). No secret in any column: passwords, codes, tokens and
# cookies live only in process memory (host) or in the isolated broker (VM).
auth_sessions = Table(
    "auth_sessions", metadata,
    Column("id", String(40), primary_key=True),  # as_<24 hex>, server generated
    Column("agent_id", String(36), ForeignKey("agents.id", ondelete="CASCADE"), nullable=False),
    Column("task_id", String(36), nullable=False),
    Column("conversation_id", String(36)),
    Column("requested_origin", String(300), nullable=False),
    Column("verified_origin", String(300)),
    Column("allowed_origins", JSON, nullable=False, default=list),
    Column("auth_method", String(32)),  # new | saved | once | manual | grant_auto
    Column("current_step", String(32)),
    Column("step_seq", Integer, nullable=False, default=0),
    Column("state", String(32), nullable=False),
    Column("confidence", String(8)),
    Column("flags", JSON, nullable=False, default=list),
    Column("entry_id", String(36)),  # vault entry used or created (metadata reference only)
    Column("save_mode", String(8)),  # once | vault
    Column("retry_count", Integer, nullable=False, default=0),
    Column("otp_attempts", Integer, nullable=False, default=0),
    Column("error_code", String(48)),
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float, nullable=False),
    Column("expires_at", Float, nullable=False),
    Column("completed_at", Float),
    # V3.3: risk level of the current page/destination (GREEN | YELLOW | RED), its reasons + verified/confirmed
    # origins (metadata only), and the fingerprints of the steps seen (loop guard; no values, no page text)
    Column("trust_level", String(8)),
    Column("trust", JSON, nullable=False, server_default="{}"),
    Column("step_history", JSON, nullable=False, server_default="[]"),
)
Index("ix_auth_sessions_agent", auth_sessions.c.agent_id, auth_sessions.c.state)
Index("ix_auth_sessions_task", auth_sessions.c.task_id)
Index("ix_auth_sessions_conv", auth_sessions.c.conversation_id, auth_sessions.c.created_at)
Index("ix_auth_sessions_state", auth_sessions.c.state, auth_sessions.c.created_at)

auth_requests = Table(
    "auth_requests", metadata,
    Column("id", String(40), primary_key=True),  # ar_<24 hex>
    Column("auth_session_id", String(40), ForeignKey("auth_sessions.id", ondelete="CASCADE"), nullable=False),
    Column("seq", Integer, nullable=False),
    Column("request_type", String(32), nullable=False),  # credentials | otp | recovery_code | confirm_destination | ...
    Column("field_schema", JSON, nullable=False, default=dict),  # roles/lengths/flags only — never values
    Column("status", String(16), nullable=False),  # open | submitted | done | expired | cancelled | superseded
    Column("token_hash", String(64)),  # sha256 of the current single-use submission token (token itself: memory only)
    Column("token_expires_at", Float),
    Column("created_at", Float, nullable=False),
    Column("expires_at", Float, nullable=False),
    Column("resolved_at", Float),
    Column("outcome", String(32)),
)
Index("ix_auth_requests_session", auth_requests.c.auth_session_id, auth_requests.c.seq)

auth_events = Table(
    "auth_events", metadata,
    Column("id", String(36), primary_key=True),
    Column("auth_session_id", String(40), ForeignKey("auth_sessions.id", ondelete="CASCADE"), nullable=False),
    Column("event_type", String(40), nullable=False),
    Column("timestamp", Float, nullable=False),
    Column("outcome", String(24)),
    Column("sanitized_metadata", JSON, nullable=False, default=dict),
)
Index("ix_auth_events_session", auth_events.c.auth_session_id, auth_events.c.timestamp)
