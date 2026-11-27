#!/usr/bin/env python3
"""Render build/e2e/E2E-REPORT.md from build/e2e/report.json (+ build/e2e/extra.json, build/e2e/suites.json)."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
rep = json.loads((ROOT / "build/e2e/report.json").read_text())
extra = json.loads((ROOT / "build/e2e/extra.json").read_text()) if (ROOT / "build/e2e/extra.json").exists() else []
suites = json.loads((ROOT / "build/e2e/suites.json").read_text()) if (ROOT / "build/e2e/suites.json").exists() else []
results = {r["id"]: r for r in rep["results"]}
for r in extra:
    results[r["id"]] = r
order = [f"E2E-{i:02d}" for i in range(1, 16)]
TITLES = {"E2E-01": "Install from clean state", "E2E-02": "Create Developer", "E2E-03": "Create Researcher",
          "E2E-04": "Different URLs on concurrent desktops", "E2E-05": "AI task with real provider",
          "E2E-06": "Live Connect", "E2E-07": "Disconnect, task continues", "E2E-08": "Take Control",
          "E2E-09": "Smart Pause / Resume", "E2E-10": "Telegram pairing", "E2E-11": "Telegram multi-agent",
          "E2E-12": "Telegram screenshot", "E2E-13": "Restart host services", "E2E-14": "Low RAM / 3rd agent",
          "E2E-15": "Uninstall"}
m = rep["meta"]
out = ["# NEBULA V1 — E2E report", "",
       f"* Host: {m['host']}, {m['ram_gb']} GB RAM",
       f"* VM profile: {m['vm_profile']}",
       f"* Local model: Ollama `{m['model']}`",
       f"* Matrix run: {m['started']} → {m.get('finished', '?')} (harness: `scripts/e2e.py`; raw: `build/e2e/report.json`)",
       "", "Statuses: PASS (really ran and met the spec condition) · FAIL · BLOCKED_BY_CREDENTIALS · "
       "NOT_VERIFIED_ON_HARDWARE", "", "| ID | Test | Status | Key evidence |", "|---|---|---|---|"]
for eid in order:
    r = results.get(eid)
    if not r:
        out.append(f"| {eid} | {TITLES[eid]} | NOT RUN | — |")
        continue
    ev = r["evidence"]
    note = r.get("note") or ""
    if not note and isinstance(ev, dict):
        keys = [k for k in ev if k not in ("trace",)][:4]
        note = "; ".join(f"{k}: {json.dumps(ev[k], default=str)[:90]}" for k in keys)
    out.append(f"| {eid} | {TITLES[eid]} | **{r['status']}** | {note.replace('|', '/')} |")
ISSUES = [
    ("Install", "ssh `UserKnownHostsFile` split the data path at the space in 'Application Support' -> pinned host key "
                "never matched", "quoted option value; first clean install now passes in one run"),
    ("Agent loop", "task_complete written as text after a failed verification left the task in EXECUTING forever",
     "runner continues the loop; watchdog re-queues running tasks without a runner; regression test"),
    ("Verification", "an agent saying 'I could not proceed' ended as COMPLETED (answer_only)",
     "task_complete requires success=true/false; tool errors require verified artifacts"),
    ("LaunchAgent", "service blocked reading the checkout on ~/Desktop (macOS TCC) when started by launchd",
     "runtime deployed to ~/Library/Application Support/NEBULA/app (decisions D27)"),
    ("Resources", "6 GB VM + local 7B model (16k ctx) drove the host into 5 GB swap; guest frozen",
     "VM 4 GB on this Mac, 8k ctx, RAM preflight for Ollama, host/guest memory admission, auto-sleep LRU (D24/D26)"),
    ("Guest memory", "3 Chromium desktops in 4 GB without swap", "swapfile, earlyoom, cgroup limits per agent (D26)"),
    ("VM helper", "SIGPIPE on Live Disconnect killed nebula-vm and the whole VM",
     "SIGPIPE ignored + SO_NOSIGPIPE; Swift regression test; VM auto-recovery (D29)"),
    ("Guest kernel", "kernel panics 'corrupted stack end detected inside scheduler' with the virtio memory balloon",
     "balloon removed (D30); console log kept across boots"),
    ("Guest disk", "ext4 checksum corruption after forced stops; guest froze with uncached disk mode",
     "disk cached+fsync, fsck on every boot, post-provision reboot, root_fs_writable health flag (D26/D31); "
     "final matrix ran on a freshly installed VM"),
    ("Logging", "live viewer token visible in the uvicorn access log; dict log args broke the redaction filter",
     "token redaction filter fixed and verified in host.log"),
]
out += ["", "## Defects found by hardware testing (all fixed before the final run)", "",
        "| Area | Defect | Fix |", "|---|---|---|"]
out += [f"| {a} | {d} | {f} |" for a, d, f in ISSUES]
out += ["", "## Automated suites", "", "| Suite | Command | Exit code | Result |", "|---|---|---|---|"]
for s in suites:
    out.append(f"| {s['suite']} | `{s['command']}` | {s['exit_code']} | {s['result']} |")
out += ["", "## Details", ""]
for eid in order:
    r = results.get(eid)
    if not r:
        continue
    out += [f"### {eid} — {TITLES[eid]}: {r['status']}", ""]
    if r.get("note"):
        out += [r["note"], ""]
    ev = r["evidence"]
    if isinstance(ev, dict):
        ev = {k: v for k, v in ev.items() if k != "trace"}
    out += ["```json", json.dumps(ev, indent=2, default=str)[:6000], "```", ""]
(ROOT / "build/e2e/E2E-REPORT.md").write_text("\n".join(out))
print("wrote build/e2e/E2E-REPORT.md")
sys.exit(0)
