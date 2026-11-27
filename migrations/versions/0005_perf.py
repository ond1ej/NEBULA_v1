"""NEBULA V3 performance pass: indexes for hot queries + memory-admission history.

Revision ID: 0005
Revises: 0004

* task_checkpoints(task_id, version): every checkpoint save/load (2-3 per agent step) scanned the whole table, whose
  rows hold the full conversation JSON — cost grew with every task ever run.
* tasks(state, priority, created_at): the scheduler polls QUEUED/RUNNING tasks every 2 s.
* audit_events(ts): the audit log is read newest-first.
* events(type, sequence): the notification center filters the event log by type, newest first; retention deletes
  by type and age.
* resource_samples.host_free_pct / swap_growth_mb: the kernel free level and swap growth that drive the adaptive
  admission under memory pressure "warning", recorded so the thresholds can be checked against real history.
* resource_samples.vm_footprint_mb: the VM's real memory footprint (ps RSS misses the guest RAM).
* tasks.max_model_calls: optional hard cap on model requests for one task (independent of the tool-step budget).
Additive only; downgrade removes exactly these objects.
"""
import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

INDEXES = [
    ("ix_task_checkpoints_task", "task_checkpoints", "task_id, version"),
    ("ix_tasks_state_priority", "tasks", "state, priority, created_at"),
    ("ix_audit_events_ts", "audit_events", "ts"),
    ("ix_events_type_seq", "events", "type, sequence"),
]


def upgrade() -> None:
    for name, table, cols in INDEXES:
        op.execute(f"CREATE INDEX IF NOT EXISTS {name} ON {table} ({cols})")
    with op.batch_alter_table("resource_samples") as b:
        b.add_column(sa.Column("host_free_pct", sa.Float(), nullable=True))
        b.add_column(sa.Column("swap_growth_mb", sa.Float(), nullable=True))
        b.add_column(sa.Column("vm_footprint_mb", sa.Float(), nullable=True))
    with op.batch_alter_table("tasks") as b:
        b.add_column(sa.Column("max_model_calls", sa.Integer(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("tasks") as b:
        b.drop_column("max_model_calls")
    with op.batch_alter_table("resource_samples") as b:
        b.drop_column("vm_footprint_mb")
        b.drop_column("swap_growth_mb")
        b.drop_column("host_free_pct")
    for name, _table, _cols in INDEXES:
        op.execute(f"DROP INDEX IF EXISTS {name}")
