SHELL := /bin/sh

CARGO ?= cargo
BUN ?= bun
URL ?= about:blank
PREFIX ?= $(HOME)/.local

.DEFAULT_GOAL := help

.PHONY: help deps build release test check fmt fmt-check clippy electron-test electron-check run run-tauri install uninstall clean

help: ## Show the available targets
	@grep -E '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*## "} {printf "  %-16s %s\n", $$1, $$2}'

deps: ## Install the Electron dependencies
	cd electron && $(BUN) install --frozen-lockfile

build: ## Rust workspace debug build
	$(CARGO) build --workspace

release: ## Rust workspace release build
	$(CARGO) build --workspace --release

test: ## Run the Rust workspace and Electron unit tests
	$(CARGO) test --workspace
	$(MAKE) electron-test

check: fmt-check clippy electron-check ## Full verification: formatting, lint, tests
	$(CARGO) test --workspace

fmt: ## Rust source formatting
	$(CARGO) fmt --all

fmt-check: ## Check the Rust formatting
	$(CARGO) fmt --all -- --check

clippy: ## Rust workspace lint
	$(CARGO) clippy --workspace --all-targets -- -D warnings

electron-test: ## Run the Electron unit tests
	cd electron && $(BUN) test

electron-check: electron-test ## Check the Electron JavaScript syntax
	node --check electron/main.cjs
	node --check electron/context-menu.cjs
	node --check electron/preload.cjs
	node --check electron/gfx-worker.cjs
	node --check electron/mouse-click-state.cjs
	node --check electron/tmux-visibility.cjs
	node --check electron/window-session.cjs
	node --check electron/agent-server.cjs
	node --check electron/paste-state.cjs
	node --check electron/url-normalization.cjs
	node --check electron/patch-geometry.cjs
	node --check electron/frame-rate-policy.cjs
	node --check electron/history-view.cjs
	node --check electron/audio-owner.cjs
	node --check electron/orphan-watch.cjs
	node --check electron/surface-policy.cjs
	node --check electron/agent-key.cjs
	node --check electron/renderer-recovery.cjs
	node --check electron/history-lock.cjs
	node --check electron/frame-writer.cjs
	node --check electron/pane-identity.cjs
	node --check electron/pane-registry.cjs
	node --check electron/pane-control.cjs
	node --check electron/hosted-runtime.cjs
	node --check electron/frame-context.cjs
	node --check electron/pane-windows.cjs

run: build ## Run TWeb on the Electron engine (URL=...)
	./target/debug/tweb open --engine electron "$(URL)"

run-tauri: build ## Run TWeb on the Tauri engine (URL=...)
	./target/debug/tweb open --engine tauri "$(URL)"

# The app code lives in the binary (198KB) and the Electron runtime is fetched once on first run
# (295MB — not a size to put in a binary). So the only thing to install is the binary.
install: release ## Install tweb into PREFIX (default ~/.local)
	install -d "$(DESTDIR)$(PREFIX)/bin"
	install -m 0755 target/release/tweb "$(DESTDIR)$(PREFIX)/bin/tweb"
	@test ! -f target/release/tweb-tauri \
		|| install -m 0755 target/release/tweb-tauri "$(DESTDIR)$(PREFIX)/bin/tweb-tauri"
	@# 기존 binary 위에 덮어쓰면 macOS 서명이 깨지고 kernel이 exec 시 SIGKILL한다.
	@# 조용한 no-op처럼 보여서 원인을 찾기 어렵다.
	@test "$$(uname)" != Darwin || codesign -f -s - "$(DESTDIR)$(PREFIX)/bin/tweb"
	@test "$$(uname)" != Darwin || test ! -f "$(DESTDIR)$(PREFIX)/bin/tweb-tauri" \
		|| codesign -f -s - "$(DESTDIR)$(PREFIX)/bin/tweb-tauri"
	@echo "installed $(DESTDIR)$(PREFIX)/bin/tweb"

uninstall: ## Remove what install placed (the cache is left alone)
	rm -f "$(DESTDIR)$(PREFIX)/bin/tweb" "$(DESTDIR)$(PREFIX)/bin/tweb-tauri"

clean: ## Remove the Rust build output
	$(CARGO) clean
