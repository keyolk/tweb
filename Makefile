SHELL := /bin/sh

CARGO ?= cargo
BUN ?= bun
URL ?= about:blank

.DEFAULT_GOAL := help

.PHONY: help deps build release test check fmt fmt-check clippy electron-test electron-check run run-tauri clean

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

clean: ## Rust build output 제거
	$(CARGO) clean
