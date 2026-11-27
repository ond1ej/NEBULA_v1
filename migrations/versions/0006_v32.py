"""NEBULA 3.2: conversations (several chats per agent) + local encrypted Password Vault.

Revision ID: 0006
Revises: 0005

Conversations
* conversations: one row per chat (agent, owner, title, default flag, last activity, read marker, archive).
* messages.conversation_id / client_id, tasks.conversation_id: links; (conversation_id, client_id) is unique so a
  client retry or a reconnect can never create a duplicate message.
* Data step: every agent that already has messages or tasks gets one default conversation that receives all of its
  existing messages and tasks (nothing is moved or deleted; old per-agent endpoints keep working). Existing messages
  are marked read.

Password Vault (no plaintext secret in any column)
* vault_metadata: KDF parameters + salt, DEK wrapped with the Argon2id-derived KEK (AES-256-GCM), auto-lock and
  unlock rate-limit state.
* vault_entries: minimal list metadata + AES-256-GCM ciphertext (username, password, notes, ...) with a per-record
  nonce; the metadata is bound to the ciphertext as AAD.
* vault_agent_policies / vault_agent_grants: deny-by-default per-agent access (HMAC-authenticated rows).
* vault_access_audit: redacted access log.
* approvals.consumed_at: single-use approvals for credential use.

Additive; downgrade removes exactly these objects (messages/tasks keep their rows).
"""
import time
import uuid

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "conversations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("agent_id", sa.String(36), sa.ForeignKey("agents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("owner_id", sa.String(36)),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.Float(), nullable=False),
        sa.Column("updated_at", sa.Float(), nullable=False),
        sa.Column("last_message_at", sa.Float()),
        sa.Column("last_read_at", sa.Float()),
        sa.Column("archived_at", sa.Float()),
    )
    op.create_index("ix_conversations_agent", "conversations", ["agent_id", "archived_at", "last_message_at"])
    op.create_index("ix_conversations_recent", "conversations", ["last_message_at"])
    with op.batch_alter_table("messages") as b:
        b.add_column(sa.Column("conversation_id", sa.String(36)))
        b.add_column(sa.Column("client_id", sa.String(64)))
    op.create_index("ix_messages_conversation_time", "messages", ["conversation_id", "created_at"])
    op.create_index("uq_messages_conversation_client", "messages", ["conversation_id", "client_id"], unique=True)
    with op.batch_alter_table("tasks") as b:
        b.add_column(sa.Column("conversation_id", sa.String(36)))
    op.create_index("ix_tasks_conversation", "tasks", ["conversation_id"])
    with op.batch_alter_table("approvals") as b:
        b.add_column(sa.Column("consumed_at", sa.Float()))

    op.create_table(
        "vault_metadata",
        sa.Column("vault_id", sa.String(36), primary_key=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("kdf", sa.JSON(), nullable=False),
        sa.Column("wrapped_dek", sa.Text(), nullable=False),
        sa.Column("auto_lock_minutes", sa.Integer(), nullable=False, server_default="15"),
        sa.Column("failed_attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("lockout_until", sa.Float()),
        sa.Column("created_at", sa.Float(), nullable=False),
        sa.Column("updated_at", sa.Float(), nullable=False),
        sa.Column("passphrase_changed_at", sa.Float()),
    )
    op.create_table(
        "vault_entries",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("vault_id", sa.String(36), sa.ForeignKey("vault_metadata.vault_id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("display_name", sa.String(200), nullable=False),
        sa.Column("app_name", sa.String(200), nullable=False, server_default=""),
        sa.Column("origin", sa.String(300)),
        sa.Column("credential_type", sa.String(16), nullable=False),
        sa.Column("tags", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("encrypted_payload", sa.Text(), nullable=False),
        sa.Column("nonce", sa.String(32), nullable=False),
        sa.Column("record_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.Float(), nullable=False),
        sa.Column("updated_at", sa.Float(), nullable=False),
        sa.Column("deleted_at", sa.Float()),
    )
    op.create_index("ix_vault_entries_live", "vault_entries", ["deleted_at", "display_name"])
    op.create_table(
        "vault_agent_policies",
        sa.Column("agent_id", sa.String(36), sa.ForeignKey("agents.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("mode", sa.String(16), nullable=False, server_default="NONE"),
        sa.Column("managed_tags", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("mac", sa.String(64)),
        sa.Column("updated_at", sa.Float(), nullable=False),
    )
    op.create_table(
        "vault_agent_grants",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("vault_entry_id", sa.String(36), sa.ForeignKey("vault_entries.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("agent_id", sa.String(36), sa.ForeignKey("agents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("allowed_actions", sa.JSON(), nullable=False),
        sa.Column("allowed_origins", sa.JSON(), nullable=False),
        sa.Column("approval_policy", sa.String(16), nullable=False, server_default="always_ask"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("expires_at", sa.Float()),
        sa.Column("created_by", sa.String(64)),
        sa.Column("mac", sa.String(64)),
        sa.Column("created_at", sa.Float(), nullable=False),
        sa.Column("updated_at", sa.Float(), nullable=False),
        sa.Column("last_used_at", sa.Float()),
    )
    op.create_index("ix_vault_grants_agent", "vault_agent_grants", ["agent_id"])
    op.create_index("ix_vault_grants_entry", "vault_agent_grants", ["vault_entry_id"])
    op.create_table(
        "vault_access_audit",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("ts", sa.Float(), nullable=False),
        sa.Column("actor_type", sa.String(16), nullable=False),
        sa.Column("actor_id", sa.String(96)),
        sa.Column("agent_id", sa.String(36)),
        sa.Column("entry_id", sa.String(36)),
        sa.Column("task_id", sa.String(36)),
        sa.Column("operation", sa.String(32), nullable=False),
        sa.Column("destination_origin", sa.String(300)),
        sa.Column("approval_id", sa.String(36)),
        sa.Column("outcome", sa.String(16), nullable=False),
        sa.Column("reason_code", sa.String(64)),
    )
    op.create_index("ix_vault_audit_ts", "vault_access_audit", ["ts"])
    op.create_index("ix_vault_audit_agent", "vault_access_audit", ["agent_id", "ts"])

    # ---- data: one default conversation per agent that already has history
    bind = op.get_bind()
    now = time.time()
    owner = bind.execute(sa.text("SELECT id FROM users ORDER BY created_at LIMIT 1")).scalar()
    rows = bind.execute(sa.text(
        "SELECT a.id, a.name, (SELECT MAX(created_at) FROM messages m WHERE m.agent_id = a.id) AS last_msg, "
        "(SELECT MIN(created_at) FROM messages m WHERE m.agent_id = a.id) AS first_msg, "
        "(SELECT MIN(created_at) FROM tasks t WHERE t.agent_id = a.id) AS first_task "
        "FROM agents a WHERE EXISTS (SELECT 1 FROM messages m WHERE m.agent_id = a.id) "
        "OR EXISTS (SELECT 1 FROM tasks t WHERE t.agent_id = a.id)")).all()
    for r in rows:
        cid = str(uuid.uuid4())
        created = min(x for x in (r.first_msg, r.first_task, now) if x is not None)
        bind.execute(sa.text(
            "INSERT INTO conversations (id, agent_id, owner_id, title, is_default, created_at, updated_at, "
            "last_message_at, last_read_at) VALUES (:id, :agent, :owner, :title, 1, :created, :now, :last, :read)"),
            {"id": cid, "agent": r.id, "owner": owner, "title": (r.name or "Chat")[:200], "created": created,
             "now": now, "last": r.last_msg, "read": max(now, r.last_msg or 0)})
        bind.execute(sa.text("UPDATE messages SET conversation_id = :cid WHERE agent_id = :agent"),
                     {"cid": cid, "agent": r.id})
        bind.execute(sa.text("UPDATE tasks SET conversation_id = :cid WHERE agent_id = :agent"),
                     {"cid": cid, "agent": r.id})


def downgrade() -> None:
    for name in ("ix_vault_audit_agent", "ix_vault_audit_ts"):
        op.drop_index(name, table_name="vault_access_audit")
    op.drop_table("vault_access_audit")
    for name in ("ix_vault_grants_entry", "ix_vault_grants_agent"):
        op.drop_index(name, table_name="vault_agent_grants")
    op.drop_table("vault_agent_grants")
    op.drop_table("vault_agent_policies")
    op.drop_index("ix_vault_entries_live", table_name="vault_entries")
    op.drop_table("vault_entries")
    op.drop_table("vault_metadata")
    with op.batch_alter_table("approvals") as b:
        b.drop_column("consumed_at")
    op.drop_index("ix_tasks_conversation", table_name="tasks")
    with op.batch_alter_table("tasks") as b:
        b.drop_column("conversation_id")
    op.drop_index("uq_messages_conversation_client", table_name="messages")
    op.drop_index("ix_messages_conversation_time", table_name="messages")
    with op.batch_alter_table("messages") as b:
        b.drop_column("client_id")
        b.drop_column("conversation_id")
    op.drop_index("ix_conversations_recent", table_name="conversations")
    op.drop_index("ix_conversations_agent", table_name="conversations")
    op.drop_table("conversations")
