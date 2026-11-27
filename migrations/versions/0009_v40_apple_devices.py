"""NEBULA 4.0: native Apple apps (paired devices) and unified owner authentication (device-wrapped vault key).

Revision ID: 0009
Revises: 0008

* app_devices: the owner's paired iPhone / Mac apps — public keys only (identity + confirmation), status, push token.
* owner_vault_keys: the vault data key wrapped for one owner device with a key derived from a secret only that device
  holds (never stored here). Lets one Face ID / Touch ID / Telegram biometric confirmation both verify the owner and
  unlock the vault, without weakening the vault at rest.

Additive only; downgrade drops exactly these two tables.
"""
import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "app_devices",
        sa.Column("id", sa.String(24), primary_key=True),
        sa.Column("name", sa.String(60), nullable=False),
        sa.Column("platform", sa.String(16), nullable=False),
        sa.Column("model", sa.String(60)),
        sa.Column("app_version", sa.String(24)),
        sa.Column("identity_key", sa.Text(), nullable=False),
        sa.Column("confirm_key", sa.Text(), nullable=False),
        sa.Column("key_protection", sa.String(24), nullable=False),
        sa.Column("status", sa.String(12), nullable=False),
        sa.Column("pairing_digest", sa.String(64), nullable=False),
        sa.Column("created_at", sa.Float(), nullable=False),
        sa.Column("approved_at", sa.Float()),
        sa.Column("approved_by", sa.String(64)),
        sa.Column("last_seen_at", sa.Float()),
        sa.Column("revoked_at", sa.Float()),
        sa.Column("push_token", sa.String(200)),
        sa.Column("push_env", sa.String(12)),
        sa.Column("push_updated_at", sa.Float()),
    )
    op.create_table(
        "owner_vault_keys",
        sa.Column("id", sa.String(24), primary_key=True),
        sa.Column("device_kind", sa.String(12), nullable=False),
        sa.Column("device_id", sa.String(24), nullable=False),
        sa.Column("vault_id", sa.String(36), nullable=False),
        sa.Column("salt", sa.String(32), nullable=False),
        sa.Column("wrapped_dek", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Float(), nullable=False),
        sa.Column("last_used_at", sa.Float()),
        sa.UniqueConstraint("device_kind", "device_id", name="uq_owner_vault_keys_device"),
    )


def downgrade() -> None:
    op.drop_table("owner_vault_keys")
    op.drop_table("app_devices")
