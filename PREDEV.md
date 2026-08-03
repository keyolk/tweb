# TWeb 개발 착수 전 계획

이 문서는 `DESIGN.md`와 `FEASIBILITY.md`를 바탕으로, 실제 개발 착수 전에 수행해야 할
**Spike**(불확실성 제거 조사), **Prototype**(최소 컴포넌트 검증), **Architecture decision**(설계
확정)을 정리합니다. 각 항목은 의존성 순서로 정렬했고, critical path를 명시했습니다.

조사 기준일: 2026-07-31.

## 의존성 그래프와 critical path

```text
S0 — Engine = Electron 확정 (사용자 결정)
    근거: extension·IME·fidelity·frame pacing·배포 모두 우위(Orca 34k stars 검증)
    차별화: tmux pane-native + 가벼운 Electron(memory 완화)
    DESIGN.md "Electron core 부적합" 번복

Spike S1 — Electron memory 완화 + tmux 통합 검증 (critical path)
    │
    ├─→ Prototype P1 — damage-aware Kitty path (Electron webContents paint → Kitty graphics)
    │       └─→ 검증 1 (renderer viability)
    │
    ├─→ Prototype P2 — browser fidelity conformance (WebGL/audio/WebRTC)
    │       └─→ 검증 8 (browser fidelity)
    │
    ├─→ Prototype P3 — 한글 IME native composition (BrowserWindow NSTextInputClient)
    │       └─→ 검증 3 (input fidelity)
    │
    └─→ Prototype P6 — extension loading (session.loadExtension) + cookie transfer
            └─→ 검증 4/5 (profile compatibility/security)

(A1은 S1/P1/P2/P3/P6 결과로 memory 완화 성공 여부 판정. 실패 시 S2→custom shell 장기 전환)

Spike S2 — Chromium build/유지 비용 (장기 전환 conditional, Electron memory 감당 안 될 때만)
    └─→ A1 (custom shell 비용 정당화)

Spike S3 — Ghostty IME event export 가능성 (P3 보완, Electron native IME로 충분하면 불필요)
    └─→ P3 (필요 시)

Spike S4 — tmux PR #5274 merge 전망과 API
    └─→ Prototype P4 — grid-resident image 통합 (또는 passthrough fallback)
            └─→ 검증 2 (tmux semantics)

Spike S5 — agent/human shared control (Electron in-process API + CDP)
    └─→ Prototype P5 — agent/human lease 상태 기계
            └─→ 검증 6 (agent control)

독립: Prototype P7 — twebd core (IPC, PageRegistry, ProfileManager)
독립: Prototype P8 — ResourceBroker + AgentBridge
```

**Critical path**: S0(Electron 확정) → S1(memory 완화 + tmux 통합 검증) → P1 + P2 + P3 + P6 → A1.
S1은 engine 비교가 아니라 Electron을 얼마나 가볍게 만들 수 있는지 증명하는 게 핵심. memory 감당 안
되면 S2→custom Chromium shell 장기 전환. S3는 Electron native IME로 충분하면 불필요.

## Phase 0 — Spike (불확실성 제거 조사, 2~4주 예상)

각 Spike는 코드를 거의 쓰지 않고, 외부 문서·소스·실험으로 "이 경로가 성립하는가?"를
판단합니다. 결과는 go/no-go 결정입니다.

### S0 — 선행 결정 (사용자 입력으로 확정)

**Engine = Electron 확정.** 사용자 결정: "Electron으로 시작, tmux 내 full browser 경험을 최대한
가볍게 구현"이 목표.

근거:
1. **extension 포기 불가** (사용자: vimium, 1Password, 개발 도구 extension, 개인화 도구 의존) →
   CEF 확정 탈락.
2. **Electron이 extension·한글 IME·browser fidelity·frame pacing·배포에서 모두 우위** (Orca 34k
   stars로 검증). external Chrome은 frame pacing 상한 + 한글 IME 약세. custom shell은 유지 비용
   매우 큼.
3. **Orca와 같은 engine이나 차별점은 "tmux pane-native + 가벼운 Electron"**. Orca는 standalone
   app, TWeb은 tmux 안. memory 완화로 Orca 대비 가벼움을 증명하는 게 핵심.

**DESIGN.md "Electron core 부적합" 판단 번복**: 근거는 (a) Orca가 Electron으로 같은 기능을 달성했고
(b) 사용자가 extension·IME를 포기할 수 없고 (c) "가볍게"를 memory 완화 전략으로 추구. Node/V8 복제
부담은 완화 전략(S1/P1)으로 다룸.

**결과**: engine = Electron. S1은 engine 비교가 아니라 **Electron memory 완화 + tmux 통합 검증**으로
좁아짐. custom Chromium shell은 장기 차별화 경로(Phase 2 이후)로 보류.

### S1 — Electron memory 완화 + tmux 통합 검증 (critical path)

**질문**: Electron을 tmux pane 안에서 full browser로 쓰면서 memory를 얼마나 가볍게 만들 수 있는가?
Orca(standalone Electron) 대비 memory 이점을 증명할 수 있는가?

**조사/검증 항목**:
- **BrowserWindow reuse**: pane마다 새 BrowserWindow를 만들지 않고, main process 하나 + page
  분리로 memory 절감. Orca가 per-worktree BrowserWindow를 만드는 것과 비교.
- **main process만 Node.js**: renderer process에서 Node integration 끄기(`nodeIntegration: false`).
  page는 순수 Chromium renderer. V8 복제 최소화.
- **GPU fast path**: `offscreen.useSharedTexture: true`(experimental)로 CPU `toBitmap()` 회피.
  SharedTexture 안정성과 Chromium security update 충돌 위험 평가.
- **damage-aware Kitty path**: `webContents.on('paint')`의 dirty rect를 Kitty graphics `a=t`+
  `a=p,U=1`로 전송. full-frame 복사 0회 목표.
- **tmux pane frontend**: `tweb __pane`이 Electron의 frame을 받아 Kitty graphics로 표시. PTY는
  pane identity/placement/visibility, Electron은 browser content.
- **한글 IME**: BrowserWindow가 macOS `NSTextInputClient`로 native composition. Tier 3 side
  channel 없이도 composition 실시간 표시 가능한지 확인.
- **extension loading**: `session.loadExtension()`으로 vimium, 1Password, React DevTools 설치.
  Web Store 설치 한계와 unpacked loading의 사용자 UX.
- **memory 측정**: pane 1/2/4개일 때 RSS·private dirty·PSS. Orca 대비. DESIGN.md 섹션 6.5 budget
  class 기준.

**산출물**: "Electron memory 완화 모델" — BrowserWindow reuse, Node integration off, GPU fast path,
damage-aware Kitty로 Orca 대비 memory·frame pacing 이점을 수치화. 통과 시 Electron으로 release,
memory가 감당 안 되면 custom Chromium shell 장기 전환 검토.

**의존**: S0(Electron 확정).
**차단**: P1, P2, P3, P6. A1은 결과로 memory 완화 성공 여부 판정.

**의존**: S0(Electron 확정).
**차단**: P1, P2, P3, P6. A1은 결과로 memory 완화 성공 여부 판정.

### S2 — Chromium build/유지 비용 현실화 (장기 차별화 경로, conditional)

**질문**: custom Chromium shell로 장기 전환 시 유지 비용은 얼마인가? (Electron memory 완화가
감당 안 되어 custom shell 전환이 필요해진 경우만 진입)

**조사 결과(일부 확보)**:
- Chromium build: 16GB RAM 권장, 100GB disk, full build ~15-30분(고성능 16-core). GN/Ninja.
  `symbol_level=1`, `is_component_build=true`로 dev build 가속.
- fork 유지: `git rebase-update` + `gclient sync`로 upstream 추적. 장기 fork 가이드는 공식
  문서에 없음 → 사실상 매 Chromium stable(약 4주 주기)마다 rebase 필요.
- CEF는 prebuilt binary로 이 비용을 회피. custom Chromium shell은 이 비용을 직접 감수.

**추가 조사 항목**:
- Chromium stable channel의 security update 빈도와 patch 규모 (월 평균).
- custom shell이 `content/public/browser` API만 쓸 때 patch surface가 얼마나 줄어드는가.
- Rust→C++ FFI 경계(`cxx` crate 또는 수동 C ABI)의 안정성.

**산출물**: "custom Chromium shell 유지 비용 모델" — 인력, 시간, rebase 주기, security update
대응 절차. awrit archive 사유("rising security issues")와 대비.

**의존**: S1에서 custom Chromium shell이 Orca 대비 차별화 경로로 선택된 경우 진입.
**차단**: A1(custom shell 선택 시 비용 정당화 판정).

### S3 — Ghostty IME event export 가능성

**질문**: Ghostty가 macOS `NSTextInputClient`로 받은 IME composition event를 external process로
전달할 수 있는가? (side channel의 입력 경로 성립 여부)

**조사 결과(일부 확보)**:
- Ghostty는 `main_c.zig`가 있어 C library(libghostty)로 embed 가능. `input/` + `os/` 모듈에
  IME 처리. plugin/extension mechanism은 없음.
- Korean IME 이슈(#11461 등)가 preedit/commit/marked text를 다룸 → IME composition을 내부에서
  알고 있음. 단, 이를 외부로 내보내는 API가 있는지는 미확인.

**추가 조사 항목**:
- Ghostty `input/` 모듈에서 composition event가 어디로 routing되는지 소스 확인.
- libghostty C API에 IME event callback이나 hook이 있는지.
- 없다면, Ghostty fork에서 composition event를 local IPC로 내보내는 patch의 규모.
- upstream 기여 가능성(IME event export API 추가).

**산출물**: "Ghostty IME event export 경로" — native callback, fork patch, 또는 불가능. 불가능
시 Tier 3 입력 경로 대안 재검토.

**의존**: S1과 병렬. P3는 S1(engine IME 주입 경로) + S3(Ghostty IME export) 양쪽에 의존.
**차단**: P3.

### S4 — tmux PR #5274 merge 전망과 API

**질문**: tmux grid-resident Kitty image(PR #5274)가 언제, 어떤 API 형태로 merge되는가?

**조사 결과(일부 확보)**:
- PR #5274(open, 2026-06-25, `ta/kitty-img` branch). grid-resident `U+10EEEE` placeholder.
  clip/scroll/resize/split/kill를 tmux가 자체 처리. late-attach 한계(per-client transmit).
- nicm "will probably happen", mgrant0 "on my radar due next few weeks", `4902-image-support`
  branch에서 kitty+sixel 일반화.

**추가 조사 항목**:
- PR review 진행 상황 주기적 확인 (merge 시점 추정).
- `ta/kitty-img` branch를 직접 build해서 TWeb Kitty 전송과 호환성 테스트.
- late-attach per-client transmit tracking을 TWeb이 어떻게 보완할지 API 설계.
- passthrough fallback은 언제까지 유지할지 기준.

**산출물**: "tmux image 경로 전략" — #5274 기반 기본 / passthrough fallback / 둘 다 지원.
merge 시점 추정과 TWeb 지원 version 정책.

**의존**: 없음. S1과 병렬.
**차단**: P4.

### S5 — CDP 멀티클라이언트 + human input interleaving

**질문**: CDP client(agent)와 human 입력이 같은 page에서 race 없이 공존하는가?

**조사 결과(일부 확보)**:
- CDP 멀티클라이언트 Chrome 63+ 지원. 단, DevTools frontend 강제 detach는 사람이 Chromium
  DevTools를 직접 열 때만 해당 → TWeb 시나리오에서는 해당 없음.
- cliweb이 이미 human/agent shared control 증명.

**추가 조사 항목**:
- CDP `Input.dispatchKeyEvent`와 human terminal 입력이 동시에 도달할 때 ordering.
- 사람이 input 시작하면 agent command queue를 어떻게 pause/resume할지.
- lease 상태 기계(`IDLE`/`HUMAN`/`AGENT`/`CONTENDED`)의 전환 trigger를 CDP event로 매핑.

**산출물**: "agent/human interleaving 계약" — lease 전환 조건, CDP command queueing 규칙.

**의존**: 없음.
**차단**: P5.

### S6 — Chrome Profile Bridge extension 권한 흐름 + embedded browser extension 지원

**질문**: per-origin one-shot cookie transfer가 extension 권한 모델로 정확히 동작하는가? 그리고
embedded browser 안에서 사용자 extension(1Password, uBlock 등) 재설치가 engine별로 어떻게
동작하는가?

**조사 결과(일부 확보)**:
- Profile Bridge extension: `cookies` permission + per-origin host permission.
  `runtime.connectNative()` persistent port. Native Messaging host(Rust) stdin/stdout JSON.
  이 extension은 사용자의 일반 Chrome에서 실행되므로 **engine 무관**.
- embedded browser 안 extension: CEF는 사실상 불가(#4011 OSR not planned, #4187 abandoned).
  external Chrome(new headless)은 실제 Chrome이므로 동작하나, `--load-extension`/profile 지속성
  방식을 S1에서 검증 필요.

**추가 조사 항목**:
- `optional_permissions`로 runtime에 origin별 permission을 요청하는 UX 흐름.
- `HttpOnly`/`Secure`/partitioned cookie 보존을 `cookies.set()`이 지원하는지.
- extension에서 cookie 값을 읽어 Native Messaging host로 보낼 때 값이 log에 노출되지
  않는지 안전장치.
- external Chrome new headless에서 `--load-extension`, `--disable-extensions-except`, profile
  기반 extension 지속성이 동작하는지 (S1과 협력).
- CEF가 extension을 정말 전혀 못 하는지 최종 확인 (Web Store 외 unpacked extension loading
  가능성).

**산출물**: "Profile Bridge 권한 흐름 명세" + "embedded browser extension 지원 매트릭스"(engine별).

**의존**: S1(engine extension 지원 차원과 협력).
**차단**: P6.

## Phase 1 — Prototype (최소 컴포넌트 검증, 4~8주 예상)

각 Prototype은 throwaway 또는 최소 기능 코드로, 검증 하나를 통과시키는 것이 목표입니다.
프로덕션 코드 품질이 아닌 "이 경로가 동작하는가"를 증명.

### P1 — Damage-aware Kitty path (critical path, Electron)

**목표**: 검증 1(renderer viability) 통과. Electron `webContents.on('paint')`의 dirty rect를
persistent shared-memory ring에 write하고, adaptive tile 매핑, Kitty graphics 전송.

**단계**:
1. Electron `webContents.on('paint', (event, dirty, image) => ...)`에서 dirty rect + bitmap 획득.
2. Persistent POSIX shared-memory ring preallocate(매 paint shm_open 금지).
3. Dirty rect → 256×256 adaptive tile 매핑, 변경 tile만 Kitty `a=t` + `a=p,U=1` 전송.
4. static page idle 시 frame transfer 0회 측정.
5. 1080p continuous scroll 60Hz frame pacing 측정.
6. 10분 animation 후 stale image/shm object 0개 측정.
7. resize 후 2 display frame 내 새 generation만 표시.
8. (선택) `offscreen.useSharedTexture: true`로 GPU fast path 검증 — CPU copy 0회.

**의존**: S1(Electron memory 완화 검증).
**성공 기준**: DESIGN.md 섹션 7.7 release gate의 주 경로 항목 충족. Orca 대비 memory 이점 수치화.

### P2 — Browser fidelity conformance (critical path, P1과 병렬 가능)

**목표**: 검증 8(browser fidelity) 통과. Electron이 WebGL/canvas/WebRTC/audio를 기성 browser
수준으로 지원하는지 측정. (Electron은 실제 Chromium이므로 대부분 기본 충족 예상.)

**단계**:
1. `webgl.org` conformance suite 실행.
2. H.264/AV1/VP9 video playback과 hardware vs software decode 확인.
3. WebRTC camera/mic 접근(`getUserMedia`) 테스트.
4. Audio playback — pane별 mute/volume routing 설계 검증.
5. Canvas 2D / 3D CSS transform / WebGPU(향후) 지원.
6. 기성 Chrome 대비 결손을 conformance 항목별로 기록.

**의존**: A1. P1과 동일 engine 위에서 수행 가능.
**성공 기준**: FEASIBILITY.md 섹션 8.5 conformance 항목을 "동일 동작 / 제약 / 미지원"으로
분류하고, 제약·미지원을 사용자에게 명시 가능.

### P3 — 한글 IME native composition (Electron, 로컬/remote 분리)

**목표**: 검증 3(input fidelity) 통과. Electron BrowserWindow가 macOS `NSTextInputClient`로 native
composition을 받아 browser input field에 실시간 표시. **로컬과 remote를 분리해 측정.**

**단계 (로컬 case)**:
1. Electron BrowserWindow(`nodeIntegration: false`)가 macOS IME composition을 native로 수신 확인.
2. 한글 2-Set IME로 `안녕` 입력 시 조합 과정(`ㅇ`→`아`→`안`→`안ㄴ`→`안녕`)이 browser input field에
   실시간 표시되는지 확인.
3. 방향키/delete 시 commit-then-act 동작(Ghostty #11461 fix와 동일) 확인.
4. Tier 3 side channel(Ghostty IME export)은 Electron native IME로 충분하면 불필요. 단, `tweb __pane`
   frontend가 IME event를 가로채야 하는 경우 S3 검증.

**단계 (remote case, 별도 phase)**:
1. Electron browser process가 remote에서 실행될 때, 로컬 IME 상태와 remote IME 상태 동기화 문제.
2. Tier 1: committed text만 remote에 전송(로컬 IME 조합 완료 후) — network latency 영향 적음.
3. Tier 3: side channel로 로컬 composition event를 remote Electron에 주입 — network latency로
   composition 실시간 표시가 어려울 수 있음. 측정 필요.
4. remote case는 로컬 case가 성립한 뒤 별도 phase로 다룸(FEASIBILITY.md 섹션 7.2).

**의존**: S1(Electron), S3(Ghostty IME export, 필요 시만).
**성공 기준**: 로컬 case에서 한글 composition 중간 상태가 browser field에 실시간 표시. remote case는
committed text fallback 또는 side channel 주입 latency 측정 결과로 판정.

### P4 — Grid-resident image 통합 (또는 passthrough fallback)

**목표**: 검증 2(tmux semantics) 통과. tmux grid-resident Kitty image(#5274) 또는 passthrough
경로로 browser image가 pane-aware 동작.

**단계**:
1. `ta/kitty-img` branch build(또는 merge 후 stock tmux).
2. TWeb damage-aware Kitty 전송(`a=t` + `a=p,U=1`)이 grid-resident placeholder와 호환되는지.
3. pane split/resize/kill/scroll-off 시 image lifecycle 확인(ghost/stale 없음).
4. late-attach client가 기존 image를 못 볼 때 TWeb reconcile이 redraw로 보완하는지.
5. passthrough fallback도 동일 기능을 제공하는지(merge 전 baseline).

**의존**: S4, P1(P1의 Kitty 전송 코드 재사용).
**성공 기준**: pane-aware clip/scroll/resize/kill이 TWeb 개입 없이 tmux가 처리. late-attach
한계만 TWeb이 보완.

### P5 — Agent/human lease 상태 기계

**목표**: 검증 6(agent control) 통과. `IDLE`/`HUMAN`/`AGENT`/`CONTENDED` 상태 기계와 CDP
command queueing.

**단계**:
1. CDP 멀티클라이언트로 agent attach.
2. Human input 시작 감지 → `AGENT`에서 `HUMAN`으로 lease 전환, agent command queue 일시 중단.
3. Human 입력 종료 → agent가 새 snapshot 찍고 `AGENT`로 복귀.
4. `CONTENDED` 시 사용자에게 명시적 조율 UI(임의 last-write-wins 금지).
5. 외부 제출/구매/메시지 전송/upload/delete 실행 직전 확인을 agent가 우회 못 하게 capability
   강제.

**의존**: S5.
**성공 기준**: human과 agent가 동일 page를 race 없이 공유. `CONTENDED`에서 사용자 조율.

### P6 — Extension loading + per-origin cookie transfer (Electron)

**목표**: 검증 4/5(profile compatibility/security) 통과. Electron `session.loadExtension()`으로
사용자 extension(vimium, 1Password, React DevTools) 설치 + Chrome Profile Bridge extension으로
cookie transfer.

**단계 (extension loading)**:
1. Electron `session.loadExtension()`으로 unpacked extension 설치(vimium, React DevTools).
2. 1Password 등 native messaging extension의 Native Messaging host 연결 확인.
3. Web Store 설치 한계와 unpacked loading의 사용자 UX 평가.
4. extension이 TWeb browser pane 안에서 정상 동작하는지 확인.

**단계 (cookie transfer)**:
1. Chrome Profile Bridge extension(사용자의 일반 Chrome에서 실행) manifest(`nativeMessaging` +
   `cookies` optional permission).
2. Rust Native Messaging host(stdin/stdout JSON, 32-bit length prefix).
3. 사용자가 origin 선택 → runtime permission 요청 → cookie transfer(one-shot) → Electron
   `session.cookies.set()`으로 TWeb profile에 주입.
4. `HttpOnly`/`Secure`/partitioned cookie 보존.
5. Audit에 domain, 개수, source/target, 시각만 기록(값 비로그).
6. Sensitive domain denylist(`*.okta.com` 등)를 code로 강제, 사용자 설정으로 해제 불가.

**의존**: S1(Electron), S6.
**성공 기준**: vimium/1Password/React DevTools가 TWeb pane에서 동작 + origin-scoped one-shot
cookie transfer가 policy 경계를 지키고 값이 log에 노출 안 됨.

### P7 — twebd core (독립, 병렬 수행 가능)

**목표**: daemon 기반 구조 검증. Electron main process 하나가 여러 BrowserWindow/page를 관리하고,
`twebd` Rust daemon이 tmux pane identity와 page 매핑. pane마다 Electron runtime 복제 없음.

**단계**:
1. `twebd` Rust daemon — authenticated Unix socket, peer credential 확인.
2. `PageRegistry`, `ProfileManager` 최소 구현.
3. tmux pane identity(`$TMUX`/`$TMUX_PANE`) 수집 및 page 매핑.
4. Electron main process와 `twebd`의 IPC — pane 생성/종료/navigation 요청.
5. Browser process crash recovery — profile + URL/history 복원.
4. `tweb __pane` frontend가 `twebd`에 attach.
5. Browser process crash recovery — profile + URL/history 복원.

**의존**: 없음. P1과 병렬.
**성공 기준**: pane 수에 비례해 browser runtime/Node/V8가 중복되지 않음.

### P8 — ResourceBroker + AgentBridge (독립, 병렬 수행 가능)

**목표**: 검증 6의 resource exchange 부분. browser에서 생성한 resource를 같은 tmux window의
agent에 typed attachment로 전달.

**단계**:
1. `ResourceBroker` — immutable resource store, scope(window/session), TTL, quota.
2. `ResourceDescriptor` metadata index (opaque ID, 값 미포함).
3. `AgentBridge` — ClaudeCodeBridge / GenericTerminalAgentBridge.
4. `tweb screenshot --pane %3 --send-to %1` 동작 검증.
5. 큰 payload를 tmux option/env/escape에 넣지 않고 object-store reference로 전달.

**의존**: 없음. P5와 협력하지만 독립 구현 가능.
**성공 기준**: browser → agent attachment가 `tweb://resource/<id>` 참조로 동작.

## Phase 2 — Architecture decision (설계 확정, Phase 1 결과로)

### A1 — Engine 확정 (critical path, S0 + S1 + S2 + P1/P2/P3/P6 결과로)

**결정**: external Chrome(new headless) / custom Chromium shell / Electron 중 하나를 제품 engine으로
확정. (CEF는 S0에서 확정 탈락.) `BrowserEngineAdapter` 경계는 유지하되, 기본 adapter를 하나로 고정.

**판단 기준**:
- 검증 1(frame pacing), 3(한글 IME), 8(browser fidelity)의 교차점. extension은 3종 모두 지원.
- **TWeb이 Orca(Electron, 34k stars, 같은 기능) 대비 차별화하는지** — Electron을 쓰면 차별점이
  tmux pane-native + terminal graphics rendering뿇이고 engine 이점 없음. 차별화하면 custom shell
  또는 external Chrome.
- 유지 비용이 survival 가능한 수준(awrit archive 교훈). external Chrome/Electron은 배포 binary로
  비용 낮음. custom shell은 비용 최대.
- memory 목표(pane마다 runtime 복제 없음). external Chrome/custom shell 모두 browser process
  하나를 공유하고 page만 분리하므로 충족. Electron도 BrowserWindow reuse로 일부 충족 가능하나
  근본적으로 Node/V8 복제 부담.

**가능한 결과**:
- **Electron 감수**: Orca 경로. 가장 빠른 시장 진입, 단 Orca 대비 engine 이점 없음 + memory 타협.
  DESIGN.md "Electron core 부적합"을 재검토해야 할 수도.
- **external Chrome(new headless)**: browser fidelity + extension, frame pacing + 한글 IME + 배포
  약세. Orca보다 가벼운 runtime.
- **custom Chromium shell**: Orca 대비 memory·성능 이점 + extension·fidelity·IME·GPU fast path.
  단, 유지 비용 매우 큼(S2). TWeb 차별화 경로. **Electron을 피하면서 embedded Chromium 이점을
  취하는 유일한 경로**.
- **hybrid**: external Chrome 기본 + custom shell for GPU fast path. 복잡도 큼.

### A2 — Tier 전략 확정 (P1+P3+P4 결과로)

**결정**: Tier 1(vanilla)/Tier 3(enhanced)의 지원 범위와 fallback 정책 확정.

**판단 기준**:
- Tier 1이 frame pacing + committed text + browser fidelity(제약 명시)를 감당하는가?
- Tier 3(enhanced Ghostty + tmux #5274)가 composition 실시간 표시 + GPU fast path를 얼마나
  필요로 하는가?
- 한글 입력 중요도(사용자가 강조)를 Tier 3 우선순위에 반영.

### A3 — tmux 지원 정책 확정 (P4 + S4 결과로)

**결정**: PR #5274 merge 전/후 지원 정책.

**판단 기준**:
- merge 전: passthrough fallback을 baseline으로, #5274 branch를 integration test 대상.
- merge 후: grid-resident를 기본 경로로 승격, passthrough는 구 version fallback.
- late-attach per-client tracking을 TWeb이 어떻게 보완할지 API 확정.

### A4 — 입력 모델 확정 (P3 결과로)

**결정**: 한글 입력 두 단계(Tier 1 committed / Tier 3 composition)를 제품 정책으로 확정.

**판단 기준**:
- Tier 3 side channel이 성립하면 composition 실시간 표시를 지원 기능으로.
- Tier 1 committed text를 fallback으로 명시.
- `NativeSurfaceTransport`가 입력 한계를 해결하지 않는 점을 문서에 명시.

## Phase 3 — 착수 준비 (A1~A4 이후)

A1~A4가 확정되면 아래를 갖추고 개발 착수:

1. **CI 기반**: Platform-neutral Rust unit/property/fuzz test, OS별 IPC/handle/path
   integration test, terminal/tmux 조합별 e2e test(DESIGN.md 섹션 6.6).
2. **build 체계**: Rust core + C++/Obj-C++ platform shim + Zig(선택) + TypeScript(extension)
   빌드 파이프라인.
3. **Chromium security update 대응 절차**: engine별 update 주기 추적, rebase/patch 절차,
   긴급 update 경로(DESIGN.md 목표 11, FEASIBILITY.md 권장사항 8).
4. **conformance test harness**: browser fidelity(검증 8) + input fidelity(검증 3) + tmux
   semantics(검증 2) conformance suite.
5. **성능 측정 기반**: FEASIBILITY.md 섹션 1.4 Phase A 측정 항목의 자동화.

## 우선순위 요약

| 우선순위 | 항목 | 이유 |
|---|---|---|
| 0 (선행 결정) | S0: 섹션 10 핵심 여부 + Orca 차별화 여부 | engine 후보 확정의 선행. 섹션 10 유지→CEF 탈락. Orca 차별화→custom shell 승격, 아니면 Electron 감수가 실용적. |
| 1 (critical) | S1 → P1 + P2 + P3 + P6 → A1 | engine 4종(CEF·external Chrome·custom shell·Electron)을 4차원에서 병렬 비교. |
| 1b (conditional) | S2 → A1 | S1에서 custom shell 선택 시 진입. 유지 비용 판정. |
| 2 (high) | S3 → P3 | 한글 입력 중요도(사용자 강조). Tier 3 side channel 성립 여부. S1과 얽힘. |
| 3 (high) | S4 → P4 | tmux #5274가 merge되면 baseline cost 제거. 추적·기여 가치. |
| 4 (medium) | S5 → P5 | agent/human interleaving. cliweb이 증명한 영역이라 위험도 낮음. |
| 5 (medium) | S6 → P6 | profile bridge + embedded extension. S1과 얽힘. |
| 6 (병렬) | P7, P8 | twebd core, ResourceBroker. 독립 구현 가능, 일정 허용 시 병렬. |

## 위험과 대응

| 위험 | 대응 |
|---|---|
| S0에서 섹션 10을 유지하면 CEF extension 불가로 탈락 | external Chrome 또는 custom shell이 후보. CEF의 frame pacing/한글 IME/배포 우위를 포기. 또는 섹션 10을 비목표/우회로 CEF 후보 복귀 결정. |
| S0에서 Orca 차별화를 포기하면 Electron 감수가 실용적 | TWeb의 차별점이 tmux pane-native + terminal graphics rendering뿇이 됨. engine 이점 없음 + memory 타협. DESIGN.md "Electron core 부적합" 재검토 필요. 빠른 시장 진입 vs 장기 차별화 트레이드오프. |
| S1에서 external Chrome의 frame pacing/한글 IME 약세가 감당 안 됨 | custom Chromium shell로 전환(S2 비용 판정). 또는 Electron 감수(Orca 경로). |
| S2에서 custom Chromium shell 유지 비용이 감당 불가 | external Chrome으로 frame pacing 상한 감수, 또는 Electron 감수(Orca 경로, memory 타협). custom shell은 포기. |
| S3에서 Ghostty IME event export가 불가능 | Tier 3 입력 경로 포기, Tier 1 committed text로 한글 입력 한정. composition 실시간 표시 비목표 명시. |
| S4에서 #5274가 장기 merge 안 됨 | passthrough fallback을 유지하되, TWeb이 reconcile 책임을 감수. fork 비용 감수 시 TWeb-enhanced tmux branch. |
| external Chrome new headless의 extension loading이 예상대로 안 됨 | S1/S6에서 `--load-extension`/profile 지속성 검증. 안 되면 custom Chromium shell 또는 Electron으로 extension 확보. |
| Chromium security update가 engine 유지를 압박 | awrit archive 교훈. CEF/external Chrome/Electron은 prebuilt/배포 binary로 부담 작음. custom shell만 부담 최대. security update 대응을 제품 survival 조건으로 인력 배정. |

## 참고 자료

- Chromium build instructions — https://chromium.googlesource.com/chromium/src/+/main/docs/linux/build_instructions.md
- CEF automated builds (prebuilt) — https://cef-builds.spotifycdn.com/index.html
- CEF tutorial — https://chromiumembedded.github.io/cef/tutorial/
- Ghostty source structure — https://github.com/ghostty-org/ghostty/tree/main/src
- tmux PR #5274 — https://github.com/tmux/tmux/pull/5274
- CEF issue #4011 (extension tab API OSR not planned) — https://github.com/chromiumembedded/cef/issues/4011
- CEF PR #4187 (Extensions API abandoned) — https://github.com/chromiumembedded/cef/pull/4187
- Electron extensions support — https://www.electronjs.org/docs/latest/api/extensions
- Orca per-worktree browser — https://www.onorca.dev/docs/browser/overview
- Orca Design Mode — https://www.onorca.dev/docs/browser/design-mode
- agent-browser (Vercel Labs) — https://github.com/vercel-labs/agent-browser
- FEASIBILITY.md — 본 저장소
- DESIGN.md — 본 저장소
