# Resource manager

Scope: `apps/host-api/nebula_host/resources.py`, the host signals in `vm.py`, and the scheduler in
`packages/agent-runtime/nebula_runtime/orchestrator.py` (`_schedule_once`, `_resources_ok`, `_host_resources_ok`,
`_sleep_lru`, `_apply_resource_mode`, `_work`), inference slots and auto-sleep.

The resource manager decides when queued work may start, so that agents run as soon as the Mac has room without
pushing it into heavy swap. It was designed and measured on a 16 GB Apple-silicon Mac mini, the tightest supported
configuration.

## The problem it solves

macOS reports memory pressure as `normal`, `warning` or `critical`. An earlier policy held all new VM work under
`warning`. On a 16 GB Mac with other applications open, macOS can report `warning` for long stretches while swap is
flat and the kernel still reports plenty of free memory (in one day of samples, about a third of all samples were
`warning`). Starting a cloud-model task inside an already-running VM adds little host memory, because the VM's RAM is a
fixed allocation. The result was idle workers and tasks waiting for minutes for no good reason.

## Findings that shaped the design

| # | Finding | Resolution |
|---|---|---|
| R1 | Any `warning` blocked all new VM work regardless of provider, swap trend or free memory | Adaptive admission (below) |
| R2 | VM memory was measured as the RSS of the Virtualization process (a few hundred MB), while its real footprint is around 3 GB | Use the process's physical footprint (`vm_footprint_mb`) |
| R3 | Host metrics spawned five subprocesses per call (about 25 ms), on every scheduler pass for every queued task | In-process `sysctl`, `host_statistics64` and libproc (about 0.05 ms) |
| R4 | The set of tasks waiting for resources kept ids of cancelled or paused tasks | Pruned on every pass |
| R5 | Recovery relied on the 2-second poll only | A pressure transition wakes the scheduler and publishes `resource.pressure.changed` |
| R6 | Mac-native tasks kept full concurrency under pressure, although they use host RAM directly | One host task under `warning` or `critical` |
| R7 | CPU usage came from decaying `ps` averages | Kernel CPU ticks between samples |
| R8 | Possible stale reservations | None found: workers are dropped when done, inference slots are context managers, leases expire; covered by tests |
| R9 | Guest checks (700 MB free per task, 1200 MB to wake a desktop, LRU sleep), profile caps and auto-sleep | Kept unchanged |

## Admission policy (`ResourceManager.admission`)

Signals are read in-process at every scheduling decision: the kernel pressure level, the kernel free level
(`kern.memorystatus_level`) and swap used; swap growth is tracked over a 2-minute window.

| Host pressure | Decision |
|---|---|
| `normal` | Admit, subject to profile limits and the guest memory checks |
| `critical` | Hold everything (VM and Mac tasks) |
| `warning` | Admit **only** if the provider is not local (a local model would add several GB), swap grew at most 256 MB in 2 minutes, and the kernel free level is at least 25 %. Concurrency is capped to 1 VM worker and 1 Mac task. Otherwise hold, with a precise reason ("swap grew 700 MB in 2 min", "12 % free", "local model ...") |

The thresholds are settings (`resources.warning_min_free_pct`, `resources.warning_max_swap_growth_mb`). Each queued task
publishes `task.stage {stage: waiting_for_resources, detail: <reason>}` once, and the scheduler re-evaluates every
2 seconds or immediately on a pressure transition. The memory safety mechanisms stay: `critical` holds everything,
local models hold under pressure, the Ollama adapter's own memory check applies, the guest headroom checks and LRU
sleep apply, and concurrency drops to one under any pressure.

History columns `host_free_pct`, `swap_growth_mb` and `vm_footprint_mb` let you check the thresholds against your own
data on the Resources page.

A pressure drill for testing: `POST /api/v1/resources/simulate {"pressure": "warning" | "critical" | null,
"minutes": <= 30}` (owner only, audited, expires by itself). It can only make scheduling more conservative: `normal`
cannot be simulated and a real `critical` always wins.

## Tests

`tests/integration/test_perf_resources.py` covers:

- normal → warning → normal: a task starts at `normal`, waits under `warning` with a low free level (with the reason
  and the waiting flag), and resumes automatically when pressure returns to `normal`;
- `warning` with a cloud provider and flat swap runs; `warning` with a local model is held; `critical` is held;
- cancelling a waiting task clears its reservation;
- unit tests of the admission rules, the swap-growth window, tunable thresholds, scheduler wake-up on recovery, and host
  concurrency across transitions;
- real kernel reads on the Mac: `memory_status` under 2 ms, no subprocess in `host_resources`, VM footprint at least
  RSS, CPU from kernel ticks;
- the pressure drill: rejects `normal`, defers work during a drill, resumes when it ends, never hides a real
  `critical`.

## Measured behaviour

With the drill set to `critical`, a new task stayed `QUEUED` with the reason "Mac memory pressure is critical" and
started within 10 ms of the drill ending. Under a real `warning` with a high kernel free level and flat swap, cloud
tasks started within about 15 ms, where they had previously waited for minutes. A local-model task under real
`warning` was held, as designed.

## Remaining limitations

- The VM cannot return memory to macOS (there is no balloon device, see [../decisions.md](../decisions.md) D30); its
  footprint grows towards its configured size and stays there.
- The 25 % and 256 MB thresholds are conservative first values; review them with your own history.
- Under real `critical` pressure nothing starts until macOS recovers, by design.
