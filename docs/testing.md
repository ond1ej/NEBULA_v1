# Testing

NEBULA has three layers of tests: automated suites that run anywhere (and in CI), an isolated test server for the
native apps, and a hardware end-to-end harness that needs a real VM on an Apple-silicon Mac.

All automated suites are self-contained: they use temporary data directories and an in-memory secret store, a fake
guest and a fake Telegram Bot API. They never touch an installed NEBULA, your Keychain or your VM.

What was run for the 1.0.0 release, with PASS, FAIL and BLOCKED for each test: [test-results.md](test-results.md).

## Automated suites

Set up once with `scripts/dev-setup.sh` (or `make setup`), then:

```bash
make lint        # ruff on apps, packages, guest and tests; bash syntax check of the shell scripts
make test-py     # pytest: tests/unit, tests/integration, tests/security
make test-web    # dashboard and Mini App (Vitest + Testing Library, jsdom)
make typecheck   # dashboard TypeScript
make test-swift  # Swift VM helper unit tests
make test        # test-py + test-swift + test-web
```

| Suite | Location | Covers |
|---|---|---|
| Unit | `tests/unit` | Policy and approval classification, QCOW2 conversion, provider adapters with mocked HTTP, RPC framing, guest helpers, vault cryptography, crypto test vectors shared with the Apple apps, QR codes, trust levels |
| Integration | `tests/integration` | The FastAPI app end to end with a fake guest: agents, tasks, approvals, live sessions, teams, schedules, workflows, companies, conversations, Telegram against a fake Bot API, Smart sign-in flows, migrations, device pairing |
| Security | `tests/security` | Request guards, CSRF and Origin, session handling, path traversal and symlinks, LAN listener rules, gateway forwarding and policy coverage, vault canaries, Smart sign-in review fixes |
| Dashboard | `apps/dashboard/src/**/*.test.ts(x)` | Pages, components, Live Desktop, Mini App screens, API client |
| VM helper | `apps/host-vm-helper/Tests` | Socket bridging, including the SIGPIPE regression |

Run a single Python test or module:

```bash
.venv/bin/python -m pytest tests/security/test_security.py -q
.venv/bin/python -m pytest -k live -q
```

The iPhone, iPad and Mac apps and their tests (Swift package tests and UI tests) live in the
[NEBULA-iOS](https://github.com/ond1ej/NEBULA-iOS) repository. This repository tests the server side of pairing in
`tests/integration/test_v40_apple_devices.py` and the shared crypto test vectors in
`tests/unit/test_v40_crypto_vectors.py`.

## Continuous integration

Every push and pull request runs `.github/workflows/ci.yml`: Python lint and tests on macOS, the dashboard type check,
tests and build, and Swift build and tests of the VM helper. Separate workflows scan for secrets
(gitleaks), vulnerable dependencies (OSV-Scanner) and licenses, and CodeQL analyses Python and TypeScript once the
repository is public. CI never needs secrets and never touches real devices.

The hardware harness below cannot run on hosted CI runners, because they cannot run Virtualization.framework guests
with the required entitlement.

## Isolated test server for the native apps

`scripts/test_instance.py` starts a temporary NEBULA that needs no VM and touches nothing else:

- a temporary data directory (deleted at exit) and an in-memory secret store;
- the real host API on `127.0.0.1:3197` and the real gateway code on `127.0.0.1:3196`;
- a scripted model that streams a Markdown answer word by word, so no AI provider or quota is used;
- a fake agent desktop (an in-process RFB server) behind the real live broker, which records every input event;
- a synthetic vault with test entries, and a test agent.

```bash
.venv/bin/python scripts/test_instance.py --out /tmp/nebula-test [--auto-approve]
# then trigger actions by creating files in the out directory:
touch /tmp/nebula-test/cmd-task     # a streamed task
touch /tmp/nebula-test/cmd-signin   # a Smart sign-in request
touch /tmp/nebula-test/cmd-pair     # a fresh pairing offer
touch /tmp/nebula-test/cmd-stop     # stop the server
```

It writes `state.json` (ports, pairing link, ids, the test vault passphrase) into the output directory, which is
created with mode `0700`. The UI tests in the [NEBULA-iOS](https://github.com/ond1ej/NEBULA-iOS) repository drive the
apps against this server; debug builds of the apps accept plain HTTP for loopback addresses only.

## Hardware end-to-end harness

`scripts/e2e.sh` runs a matrix of end-to-end tests against an installed NEBULA with a real VM: installation state, the
guest, agent creation, desktops, Live Desktop streaming and control, tasks with a local model, repair and more. Each
test reports `PASS`, `FAIL`, `BLOCKED` (with what it needs, such as a real API key or a second device) or
`NOT_VERIFIED_ON_HARDWARE`.

Run it **against a separate test instance**, never against the install you use:

```bash
.venv/bin/nebula --instance e2e install --port 3200 --vm-ram-mb 4096
NEBULA_INSTANCE=e2e NEBULA_PORT=3200 scripts/e2e.sh
.venv/bin/python scripts/e2e_report.py     # renders build/e2e/E2E-REPORT.md from build/e2e/report.json
```

Results and screenshots go to `build/e2e/` (git-ignored). The harness creates a test administrator and writes its
generated password to `<data>/run/initial-admin-password` (`0600`) on the test instance only. Remove the test
instance afterwards with `.venv/bin/nebula --instance e2e uninstall --remove-data --confirm DELETE-ALL-NEBULA-DATA`,
which deletes only that instance's data and Keychain items.

Other optional hardware scripts in `scripts/` (LAN listeners, vault broker, Smart sign-in on synthetic sites in the
VM, performance benchmarks) follow the same rules: they read the target from `NEBULA_DATA_DIR` or `NEBULA_INSTANCE`
and `NEBULA_PORT`, and use synthetic data only.

## Writing tests

- Every bug fix comes with a test that fails without the fix.
- Use the fixtures in `tests/conftest.py`: they force the memory secret backend and a temporary data directory.
- Never use real accounts, real API keys or personal data in tests or fixtures. Use obviously fake values (for
  example `123456789:TEST-ONLY-...` for a bot token) so secret scanners stay quiet.
- Security-relevant behaviour belongs in `tests/security`.
