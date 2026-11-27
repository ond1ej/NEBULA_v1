"""agent fallback model (per-agent consented provider fallback)

Revision ID: 0002
Revises: 0001
"""
import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("agents") as b:
        b.add_column(sa.Column("fallback_model_id", sa.String(length=128), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("agents") as b:
        b.drop_column("fallback_model_id")
