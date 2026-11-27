## What and why

<!-- What does this change, and what problem does it solve? Link the issue: "Fixes #123". -->

## How it was tested

<!-- Commands you ran and their result. Say what you could not test (for example: no hardware run, no real API key). -->

- [ ] `make lint`
- [ ] `make test-py`
- [ ] `make test-web` and `make typecheck` (dashboard changes)
- [ ] `make test-swift` (VM helper changes)
- [ ] Hardware harness `scripts/e2e.sh` on a separate test instance (VM helper, guest, provisioning or Live Desktop changes)

## Checklist

- [ ] Tests added or updated; a bug fix has a test that fails without it.
- [ ] Documentation and `CHANGELOG.md` ("Unreleased") updated where behaviour changes.
- [ ] No secrets, tokens, `.env` files, databases, VM images, logs or personal data in the diff or in screenshots.
- [ ] Security defaults kept: loopback binds, anything that exposes data or the API is off by default, approvals on
      and owner-only, network off for host folders, local-network destinations blocked in the VM.
- [ ] New dependencies have an MIT-compatible license.
- [ ] Commits are signed off (`git commit -s`).

## Security impact

<!-- Does this add a listener, a route, a permission, a new place secrets are handled, or more access for agents? -->
