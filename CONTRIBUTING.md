# Contributing to NEBULA

Thank you for considering a contribution. Bug reports, documentation fixes, tests and code are all welcome. By
participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- **Security problems** go through private reporting, not issues or pull requests. See [SECURITY.md](SECURITY.md).
- **Bugs:** open an issue with the bug template. Include `.venv/bin/nebula doctor` output and, if useful, the redacted
  bundle from `.venv/bin/nebula diagnostics` (read it before you attach it).
- **Larger changes or new features:** open an issue first, so we can agree on the approach before you invest time.
  Check [docs/roadmap.md](docs/roadmap.md) and [docs/limitations.md](docs/limitations.md).

## Development setup

You need an Apple-silicon Mac with macOS 13 or later, Xcode Command Line Tools, `uv`, Node.js 20.19+ on Node 20, or
22.12+ (the dashboard's Vite 7 build requires `^20.19.0 || >=22.12.0`, so Node 21 is refused) and `pnpm`.

```bash
git clone https://github.com/<you>/NEBULA_v1.git && cd NEBULA_v1
make setup          # .venv with Python 3.13 and the locked dependencies, dashboard dependencies
make helper         # build and ad-hoc sign the VM helper
```

`scripts/dev-setup.sh` does the same and also builds the dashboard. You do not need a VM to work on most of the code:
the automated tests use a fake guest. The iPhone, iPad and Mac apps are developed in their own repository,
[NEBULA-iOS](https://github.com/ond1ej/NEBULA-iOS); this repository only holds the server side of pairing (see
[docs/apple-apps.md](docs/apple-apps.md)).

Run the host service in the foreground against a throwaway instance, never against the install you use:

```bash
.venv/bin/nebula --instance dev install --port 3200 --autostart no   # a full separate instance with its own VM
.venv/bin/nebula --instance dev serve
```

or, without a VM, the isolated test server: `.venv/bin/python scripts/test_instance.py --out /tmp/nebula-test`.

Dashboard development: `cd apps/dashboard && pnpm dev` and set `NEBULA_DEV_ORIGIN=http://127.0.0.1:5173` (and
`NEBULA_API_TARGET` for the dev proxy) for the host service.

## Checks

Every pull request must pass:

```bash
make lint           # ruff + bash -n of every shell script
make test-py        # pytest (unit, integration, security)
make test-web       # Vitest
make typecheck      # TypeScript
make test-swift     # VM helper tests
```

CI runs the same checks, plus secret scanning, dependency scanning and a license check. Changes to the iPhone, iPad or
Mac apps belong in [NEBULA-iOS](https://github.com/ond1ej/NEBULA-iOS), which has its own contributing guide and tests.

The secret scan is `gitleaks` with [`.gitleaks.toml`](.gitleaks.toml); run `gitleaks dir . --redact` and
`gitleaks git . --redact` before you push if you have it installed. If a test fixture has to look like a secret, use an
obviously fake value and, only if the scanner still flags it, add a narrow allowlist entry for that file and that
exact value, with a comment that says why. Never allowlist a whole directory or rule.

Changes to the VM helper, guest provisioning, the guest service or Live Desktop should also be run through the hardware
harness (`scripts/e2e.sh`) on an Apple-silicon Mac against a separate test instance; summarise the result in the pull
request. See [docs/testing.md](docs/testing.md). We do not expect contributors to have hardware for every change;
say what you could and could not test.

## Pull requests

- Keep a pull request focused on one change. Separate refactoring from behaviour changes.
- Add or update tests. A bug fix needs a test that fails without the fix.
- Update the documentation when behaviour changes, and add an entry under "Unreleased" in [CHANGELOG.md](CHANGELOG.md).
- Never commit secrets, tokens, `.env` files, databases, VM images, logs, or screenshots that contain personal data.
  Use obviously fake values in tests.
- New external integrations must use the vendor's official, documented authentication. No cookie scraping, no private
  web endpoints, no terms-of-service workarounds. Record the decision in [docs/decisions.md](docs/decisions.md).
- New dependencies must have a license compatible with MIT (MIT, BSD, Apache-2.0, ISC, MPL-2.0 for unmodified
  libraries, PSF and similar). Copyleft licenses such as GPL or AGPL are not accepted for code we ship. CI checks this.
- Keep the security defaults: loopback binds, features that expose anything off by default, approvals on and
  owner-only, network off for host folders, local-network destinations blocked in the VM.
- Describe security controls honestly in docs and UI text: say what is a boundary (the VM, Seatbelt, the vault broker,
  owner-only approvals, authentication) and what is advisory (the approval policy, heuristics).

## Commit sign-off

Please sign off your commits (`git commit -s`) to certify the
[Developer Certificate of Origin](https://developercertificate.org/): that you wrote the change or have the right to
submit it under the project's license.

## License

NEBULA is licensed under the [MIT License](LICENSE). By contributing, you agree that your contributions are licensed
under the same license (inbound equals outbound).
