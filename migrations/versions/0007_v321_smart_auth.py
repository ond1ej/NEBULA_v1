"""NEBULA 3.2.1: Smart Authentication sessions (sign-in assistance during agent tasks).

Revision ID: 0007
Revises: 0006

* auth_sessions: one row per sign-in assistance session, bound to agent + task (+ conversation); state machine,
  requested and verified origin, confidence/flags, retry counters, expiry. No secret columns.
* auth_requests: the owner-facing requests of a session (credentials, verification code, destination review, ...)
  with the field schema (roles/lengths only), status and the SHA-256 of the single-use submission token.
* auth_events: redacted lifecycle log.

Passwords, verification codes, submission tokens and session cookies are never stored. Additive; downgrade drops
exactly these tables.
"""
import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "auth_sessions",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("agent_id", sa.String(36), sa.ForeignKey("agents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("task_id", sa.String(36), nullable=False),
        sa.Column("conversation_id", sa.String(36)),
        sa.Column("requested_origin", sa.String(300), nullable=False),
        sa.Column("verified_origin", sa.String(300)),
        sa.Column("allowed_origins", sa.JSON(), nullable=False),
        sa.Column("auth_method", sa.String(32)),
        sa.Column("current_step", sa.String(32)),
        sa.Column("step_seq", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("state", sa.String(32), nullable=False),
        sa.Column("confidence", sa.String(8)),
        sa.Column("flags", sa.JSON(), nullable=False),
        sa.Column("entry_id", sa.String(36)),
        sa.Column("save_mode", sa.String(8)),
        sa.Column("retry_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("otp_attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error_code", sa.String(48)),
        sa.Column("created_at", sa.Float(), nullable=False),
        sa.Column("updated_at", sa.Float(), nullable=False),
        sa.Column("expires_at", sa.Float(), nullable=False),
        sa.Column("completed_at", sa.Float()),
    )
    op.create_index("ix_auth_sessions_agent", "auth_sessions", ["agent_id", "state"])
    op.create_index("ix_auth_sessions_task", "auth_sessions", ["task_id"])
    op.create_index("ix_auth_sessions_conv", "auth_sessions", ["conversation_id", "created_at"])
    op.create_index("ix_auth_sessions_state", "auth_sessions", ["state", "created_at"])
    op.create_table(
        "auth_requests",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("auth_session_id", sa.String(40), sa.ForeignKey("auth_sessions.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("request_type", sa.String(32), nullable=False),
        sa.Column("field_schema", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("token_hash", sa.String(64)),
        sa.Column("token_expires_at", sa.Float()),
        sa.Column("created_at", sa.Float(), nullable=False),
        sa.Column("expires_at", sa.Float(), nullable=False),
        sa.Column("resolved_at", sa.Float()),
        sa.Column("outcome", sa.String(32)),
    )
    op.create_index("ix_auth_requests_session", "auth_requests", ["auth_session_id", "seq"])
    op.create_table(
        "auth_events",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("auth_session_id", sa.String(40), sa.ForeignKey("auth_sessions.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("event_type", sa.String(40), nullable=False),
        sa.Column("timestamp", sa.Float(), nullable=False),
        sa.Column("outcome", sa.String(24)),
        sa.Column("sanitized_metadata", sa.JSON(), nullable=False),
    )
    op.create_index("ix_auth_events_session", "auth_events", ["auth_session_id", "timestamp"])


def downgrade() -> None:
    op.drop_index("ix_auth_events_session", table_name="auth_events")
    op.drop_table("auth_events")
    op.drop_index("ix_auth_requests_session", table_name="auth_requests")
    op.drop_table("auth_requests")
    for ix in ("ix_auth_sessions_state", "ix_auth_sessions_conv", "ix_auth_sessions_task", "ix_auth_sessions_agent"):
        op.drop_index(ix, table_name="auth_sessions")
    op.drop_table("auth_sessions")
