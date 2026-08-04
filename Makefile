SHELL := /bin/sh

CARGO ?= cargo
BUN ?= bun
URL ?= about:blank
PREFIX ?= $(HOME)/.local
# The Electron runtime reads main.cjs/preload.cjs and its own node_modules at run
# time, so `tweb` needs the whole app directory beside it. It looks for the app at
# `<prefix>/libexec/tweb/electron` — keep the two in step.
LIBEXEC := $(PREFIX)/libexec/tweb

.DEFAULT_GOAL := help

.PHONY: help deps build release test check fmt fmt-check clippy electron-test electron-check run run-tauri install uninstall clean

help: ## 사용 가능한 target 표시
	@grep -E '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*## "} {printf "  %-16s %s\n", $$1, $$2}'

deps: ## Electron dependency 설치
	cd electron && $(BUN) install --frozen-lockfile

build: ## Rust workspace debug build
	$(CARGO) build --workspace

release: ## Rust workspace release build
	$(CARGO) build --workspace --release

test: ## Rust workspace와 Electron unit test 실행
	$(CARGO) test --workspace
	$(MAKE) electron-test

check: fmt-check clippy electron-check ## Formatting, lint, test 전체 검증
	$(CARGO) test --workspace

fmt: ## Rust source formatting
	$(CARGO) fmt --all

fmt-check: ## Rust formatting 검사
	$(CARGO) fmt --all -- --check

clippy: ## Rust workspace lint
	$(CARGO) clippy --workspace --all-targets -- -D warnings

electron-test: ## Electron unit test 실행
	cd electron && $(BUN) test

electron-check: electron-test ## Electron JavaScript 문법 검사
	node --check electron/main.cjs
	node --check electron/preload.cjs
	node --check electron/gfx-worker.cjs
	node --check electron/mouse-click-state.cjs

run: build ## Electron engine으로 TWeb 실행 (URL=...)
	./target/debug/tweb open --engine electron "$(URL)"

run-tauri: build ## Tauri engine으로 TWeb 실행 (URL=...)
	./target/debug/tweb open --engine tauri "$(URL)"

install: release deps ## tweb과 Electron app을 PREFIX에 설치 (기본 ~/.local)
	install -d "$(DESTDIR)$(PREFIX)/bin" "$(DESTDIR)$(LIBEXEC)"
	install -m 0755 target/release/tweb "$(DESTDIR)$(PREFIX)/bin/tweb"
	@test ! -f target/release/tweb-tauri \
		|| install -m 0755 target/release/tweb-tauri "$(DESTDIR)$(PREFIX)/bin/tweb-tauri"
	rm -rf "$(DESTDIR)$(LIBEXEC)/electron"
	cp -R electron "$(DESTDIR)$(LIBEXEC)/electron"
	@echo "installed $(DESTDIR)$(PREFIX)/bin/tweb (engine in $(DESTDIR)$(LIBEXEC)/electron)"

uninstall: ## install이 놓은 파일 제거
	rm -f "$(DESTDIR)$(PREFIX)/bin/tweb" "$(DESTDIR)$(PREFIX)/bin/tweb-tauri"
	rm -rf "$(DESTDIR)$(LIBEXEC)"

clean: ## Rust build output 제거
	$(CARGO) clean
