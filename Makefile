SHELL := /bin/sh

CARGO ?= cargo
BUN ?= bun
URL ?= about:blank
PREFIX ?= $(HOME)/.local

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
	node --check electron/context-menu.cjs
	node --check electron/preload.cjs
	node --check electron/gfx-worker.cjs
	node --check electron/mouse-click-state.cjs
	node --check electron/tmux-visibility.cjs
	node --check electron/window-session.cjs
	node --check electron/url-normalization.cjs

run: build ## Electron engine으로 TWeb 실행 (URL=...)
	./target/debug/tweb open --engine electron "$(URL)"

run-tauri: build ## Tauri engine으로 TWeb 실행 (URL=...)
	./target/debug/tweb open --engine tauri "$(URL)"

# app 코드는 binary에 들어 있고 (198KB) Electron runtime은 첫 실행 때 한 번 받는다
# (295MB — binary에 넣을 크기가 아니다). 그래서 설치할 것은 binary뿐이다.
install: release ## tweb을 PREFIX에 설치 (기본 ~/.local)
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

uninstall: ## install이 놓은 파일 제거 (cache는 그대로 둔다)
	rm -f "$(DESTDIR)$(PREFIX)/bin/tweb" "$(DESTDIR)$(PREFIX)/bin/tweb-tauri"

clean: ## Rust build output 제거
	$(CARGO) clean
