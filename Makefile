# NEBULA build/test entry points. Every target is a real command; see README.
# One-command install: ./install.sh (checks this Mac, offers missing tools, builds, installs). Dry run: make check.
PY := .venv/bin/python
UV ?= uv
NEBULA := $(PY) -m nebula_setup.cli

.PHONY: setup helper dashboard guest-bundle guest-lock test test-py test-swift test-web lint typecheck e2e check \
	install serve status health restart update diagnostics doctor release clean

setup:            ## create venv + install the locked deps (python, node)
	$(UV) venv --python 3.13 .venv  # uv-managed CPython 3.13: survives Homebrew upgrades
	$(UV) sync --frozen
	cd apps/dashboard && pnpm install --frozen-lockfile

helper:           ## build + ad-hoc sign the native VM helper (Virtualization entitlement)
	cd apps/host-vm-helper && swift build -c release
	codesign --force --sign - --entitlements apps/host-vm-helper/nebula-vm.entitlements apps/host-vm-helper/.build/release/nebula-vm

dashboard:        ## production build of the web dashboard
	cd apps/dashboard && pnpm build

guest-bundle:
	scripts/build-guest-bundle.sh build/nebula-guest-bundle.tar.gz

guest-lock:       ## re-lock the guest VM's Python packages with hashes (needs network)
	scripts/lock-guest-requirements.sh

test: test-py test-swift test-web

test-py:
	$(PY) -m pytest -q

test-swift:
	cd apps/host-vm-helper && swift test

test-web:
	cd apps/dashboard && pnpm test

# every shell script; `bash -n a b c` would only check `a`, so lint checks them one by one
SHELL_SCRIPTS := install.sh update.sh uninstall.sh guest/scripts/provision.sh guest/desktop/bin/nebula-desktop-session \
	$(wildcard scripts/*.sh)

lint:             ## ruff + bash -n of every shell script (the same checks as CI)
	.venv/bin/ruff check apps packages guest tests .github/scripts
	@for f in $(SHELL_SCRIPTS); do bash -n "$$f" || exit 1; done; echo "bash -n: $(words $(SHELL_SCRIPTS)) scripts OK"

typecheck:
	cd apps/dashboard && pnpm typecheck

check:            ## report whether this Mac is ready (changes nothing)
	./install.sh --check

install: helper dashboard   ## install on this Mac (verified Ubuntu image, VM); asks about autostart
	$(NEBULA) install --open

serve:
	$(NEBULA) serve

status:
	$(NEBULA) status

health:
	$(NEBULA) health

restart:
	$(NEBULA) restart

update:           ## newest release tag: DB backup, build, deploy, migrate, health check, rollback on failure
	./update.sh

diagnostics:      ## redacted support bundle (no secrets, no database)
	$(NEBULA) diagnostics

doctor:
	$(NEBULA) doctor

e2e:              ## hardware E2E against the installed VM (see scripts/e2e.py; output in build/e2e)
	scripts/e2e.sh

release:
	scripts/build-release.sh

clean:
	rm -rf build apps/dashboard/dist apps/host-vm-helper/.build
