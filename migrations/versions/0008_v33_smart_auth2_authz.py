"""NEBULA 3.3: Smart Auth 2.0 state/trust columns, step-up assurance, biometric devices.

Revision ID: 0008
Revises: 0007

* auth_sessions: trust_level (GREEN/YELLOW/RED), trust (reasons + verified/confirmed origins, metadata only) and
  step_history (step fingerprints for the loop guard — no values, no page text). Existing rows (all finished) get
  the empty defaults; their old state names are mapped when read.
* sessions: stepup_at / stepup_method — when the owner last re-verified themselves on that session.
* miniapp_devices: phones enrolled for Face ID / fingerprint confirmations (SHA-256 of the device token only).

Additive only; downgrade removes exactly these columns/table.
"""
import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("auth_sessions") as b:
        b.add_column(sa.Column("trust_level", sa.String(8)))
        b.add_column(sa.Column("trust", sa.JSON(), nullable=False, server_default="{}"))
        b.add_column(sa.Column("step_history", sa.JSON(), nullable=False, server_default="[]"))
    with op.batch_alter_table("sessions") as b:
        b.add_column(sa.Column("stepup_at", sa.Float()))
        b.add_column(sa.Column("stepup_method", sa.String(16)))
    op.create_table(
        "miniapp_devices",
        sa.Column("id", sa.String(24), primary_key=True),
        sa.Column("telegram_user_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(60), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("created_at", sa.Float(), nullable=False),
        sa.Column("last_used_at", sa.Float()),
        sa.Column("revoked_at", sa.Float()),
    )


def downgrade() -> None:
    op.drop_table("miniapp_devices")
    with op.batch_alter_table("sessions") as b:
        b.drop_column("stepup_method")
        b.drop_column("stepup_at")
    with op.batch_alter_table("auth_sessions") as b:
        b.drop_column("step_history")
        b.drop_column("trust")
        b.drop_column("trust_level")
