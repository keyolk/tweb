# TWeb 타당성 리서치 및 상세 설계 보강

이 문서는 `DESIGN.md` 섹션 17의 7개 검증 대상에 대해 외부 자료 조사와 선례 프로젝트 분석을
바탕으로 기술적 타당성을 평가하고, 부족한 상세 설계를 보강합니다. 결론과 권장사항은 각 섹션
끝에 정리합니다.

조사 기준일: 2026-07-31. 조사 대상 문서는 문서 끝 "참고 자료"에 정리했습니다.

## 평가 요약

| # | 검증 대상 | 타당성 | 위험도 | 핵심 발견 |
|---|---|---|---|---|
| 1 | Renderer viability | 타당 | 중간 | Engine 3종(external Chrome·custom shell·Electron)이 복합 tradeoff. **CEF는 extension 불가로 확정 탈락**(사용자: extension 포기 불가). Electron: extension·fidelity·IME·배포 우위, Orca와 같은 engine. custom shell: 차별화 경로, 유지 비용 큼. external Chrome: 가벼운 runtime, frame pacing·IME 약세. |
| 2 | tmux semantics | 타당 | 낮음~중간 | `switch-client -T` + `Any` table 공식 지원. PR #5274 grid-resident Kitty image가 merge되면 baseline compatibility cost 대부분 제거. late-attach 한계는 TWeb reconcile로 보완. |
| 3 | Input fidelity | 조건부 | 중간 | Ghostty가 macOS IME composition을 native 처리(#11461 등). Tier 1은 committed text만, Tier 3 side channel 확장으로 composition 실시간 표시 가능. |
| 4 | Profile compatibility | 타당 | 낮음 | Native Messaging + cookies API로 구현 가능. extension 재설치는 external Chrome/custom shell/Electron에서 동작(CEF는 불가, 확정 탈락). Profile Bridge extension은 사용자 일반 Chrome에서 실행되어 engine 무관. |
| 5 | Profile security | 타당 | 낮음 | per-origin permission, one-shot transfer, 값 비로그 정책이 extension 권한 모델로 실현 가능. |
| 6 | Agent control | 타당 | 중간 | CDP 멀티클라이언트 Chrome 63+ 지원. cliweb이 이미 human/agent shared control 증명. |
| 7 | Remote extension | 타당 | 중간 | shared memory same-machine 제약 확인. remote는 hardware video transport 필요. |
| 8 | Browser fidelity (WebAPI/미디어/입력) | 타당 | 중간 | CEF OSR은 accelerated compositing 미지원(OSR 한계) → WebGL/hw video decode 영향. external Chrome(new headless)은 "window만 없고 모든 기능"으로 browser fidelity 해결. custom shell 불필요. |

전체 판단: architecture는 성립 가능합니다. 단, 검증 1(renderer), 3(input), 8(browser fidelity)이
구조적 kill switch이며, 이 영역들의 위험도가 전체 일정과 engine 선택을 좌우합니다.
**S0 결정(사용자): Engine = Electron.** 근거: extension·IME·fidelity·frame pacing·배포 모두
우위(Orca 34k stars 검증). 차별화는 "tmux pane-native + 가벼운 Electron"(memory 완화). DESIGN.md
"Electron core 부적합" 번복 — Node/V8 복제 부담은 memory 완화 전략(BrowserWindow reuse, Node
integration off, GPU fast path)으로 추구. CEF는 extension 불가로 확정 탈락. external Chrome은
frame pacing·IME 약세. custom Chromium shell은 Electron memory가 감당 안 될 때 장기 전환 경로.

**Electron memory 완화 전략 (S1 검증 대상)**:
- main process만 Node.js, renderer는 `nodeIntegration: false`로 순수 Chromium renderer (V8 복제 최소화).
- BrowserWindow reuse: pane마다 새 window가 아니라 main process 하나 + page 분리.
- GPU fast path: `offscreen.useSharedTexture: true`(experimental)로 CPU `toBitmap()` 회피.
- damage-aware Kitty: `webContents.on('paint')` dirty rect → Kitty `a=t`+`a=p,U=1`.
- 목표: Orca(standalone Electron) 대비 memory 이점 수치화. 실패 시 custom Chromium shell 장기 전환.

## 1. Renderer viability — GPU fast path와 damage-aware Kitty path

### 1.1 조사 결과

#### Electron SharedTexture (GPU fast path 후보)

- `webPreferences.offscreen.useSharedTexture: true`면 frame이 CPU를 거치지 않고 GPU texture로
  직접 전달됩니다. 공식 문서는 "very fast", "zero CPU-GPU transfers"로 설명합니다.
- `SharedTexture` API는 platform-specific handle을 `VideoFrame`으로 변환하며, "can be transferred
  across Electron processes"라고 명시합니다. `importSharedTexture`/`sendSharedTexture`는 main
  process 전용, `setSharedTextureReceiver`는 renderer 전용입니다.
- **제약**: 전 API가 **experimental**로 표기되며 "could be removed in the future" 경고가 있습니다.
  기준 version은 v43.2.0. receiver는 `sendSharedTexture` 호출 전에 등록해야 하며 1000ms timeout이
  있습니다. IOSurface backing에 대한 명시적 언급은 문서에 없습니다.
- awrit의 frame path(`src/paint.ts`)가 `NativeImage.toBitmap()` CPU 경로를 쓴 것과 대비되는,
  현재 접근 가능한 유일한 GPU fast path 후보입니다.

#### CEF offscreen rendering (비교 baseline)

- CEF OSR은 `OnPaint()`로 "invalid regions and the updated pixel buffer"를 전달합니다. **CPU
  pixel buffer만 제공**하며 GPU texture sharing, `SharedTextureServices`, IOSurface export를
  문서에서 전혀 언급하지 않습니다.
- 결정적으로 "does not currently support accelerated compositing so performance may suffer as
  compared to a windowed browser"라고 명시합니다. OSR에서는 GPU process가 rendering output에
  사용되지 않고 software fallback으로 동작합니다.
- Rust binding은 공식 외부 프로젝트 목록에 없습니다 (.NET, Delphi, Go, Java, Python만).

#### Kitty graphics protocol (compatibility path 기반)

- damage/partial update: `x, y, s, v` key로 source rectangle 지정, 부분 frame을 background
  canvas에 compose.
- animation: `a=f`(frame 전송), `a=a`(animation 제어), `z` key로 gap 제어. `c` key로 base frame
  참조, `X=1`로 replace, default는 alpha blend.
- shared memory: `t=s`로 POSIX `shm_open`/Windows named shared memory. terminal이 읽은 뒤
  unlink/close.
- capability query: `a=q` 후 `ESC[c`로 응답 유무로 지원 판정. terminal은 다른 input 처리 없이
  즉시 응답해야 합니다.
- placement: `a=p,i=<id>`로 cursor 위치에 배치, `U=1`로 Unicode placeholder, parent-child
  relative placement(`P=`, `Q=`), z-index(`z`).

#### Ghostty renderer

- macOS는 Metal + CoreText, Linux는 OpenGL. terminal마다 read/write/render 전용 스레드.
- Kitty graphics protocol 지원을 명시합니다.
- **"Ghostty-only Terminal Control Sequences ❌ not yet implemented"** — proprietary extension이
  현재 없으므로, TWeb-enhanced Ghostty의 local GPU surface fast path는 upstream이 아닌 fork에서
  구현해야 합니다.

### 1.2 타당성 평가

DESIGN.md 섹션 6.4는 "Memory 효율을 우선하면 Electron을 제품 core로 채택하지 않는다"고 이미
결정했습니다. 이 결정은 타당하며, 조사 결과도 이를 지지합니다. rendering 경로와 engine은 다음과
같이 평가됩니다.

#### Engine 후보 (2종, custom shell은 최후 hybrid)

| Engine | frame pacing (검증 1) | browser fidelity (검증 8) | 유지 비용 |
|---|---|---|---|
| CEF OSR (prebuilt) | Tier 1 가능 (CPU bitmap + dirty rect) | **부족** (accelerated compositing 미지원 → WebGL/hw video decode 영향) | 낮음 (prebuilt binary) |
| **external Chrome + CDP (new headless, Chrome 132+)** | full-frame 상한 (screenshot 기반) | **충분** ("window만 없고 모든 기능", GPU compositing, WebGL, hw video decode) | 낮음 (Chrome 배포) |
| ~~custom Chromium shell~~ | GPU fast path 가능 | 충분 | **매우 높음** (fork 유지) |

**핵심 발견(재평가)**: new headless Chrome(Chrome 112+)은 "creates, but doesn't display, any
platform windows. All other functions, existing and future, are available with no limitations."
즉 **보이지 않는 window를 만들고 표준 `//chrome` rendering pipeline을 그대로 씁니다**. CEF OSR이
accelerated compositing을 안 쓰는 건 CEF가 window surface를 만들지 않기 때문이지, Chromium의
구조적 한계가 아닙니다. 따라서:

- **browser fidelity(검증 8)는 external Chrome(new headless)로 해결**됩니다. custom Chromium
  shell이 필요하지 않습니다.
- **custom Chromium shell의 유일한 남은 근거는 GPU texture export(Tier 3 fast path)**뿐이며,
  이것도 Tier 1이 충분하면 불필요합니다.

custom Chromium shell은 **CEF의 비용 이점과 external Chrome의 fidelity 이점을 각각 취하려는
최후 hybrid로만** 의미가 있습니다. 단독 engine으로는 근거가 약합니다. DESIGN.md 섹션 6.4의
"CEF가 GPU handle export를 제공하지 못하면 custom Chromium shell adapter로 교체"는 **Tier 1이
부족하여 GPU fast path가 필요해진 시점의 최후 fallback**으로 해석합니다.

#### Rendering 경로

| 경로 | 타당성 | 근거 |
|---|---|---|
| Tier 1 damage-aware Kitty (vanilla) | 타당, **첫 검증 대상** | Kitty protocol이 damage/composite/animation/shm/capability query를 충분히 제공. CEF(CPU bitmap)와 external Chrome(screenshot) 모두로 구현 가능. |
| CEF 경로 (Tier 1 baseline) | 타당 | OSR이 CPU bitmap + dirty rect 제공. Tier 1에 충분하나 browser fidelity(검증 8) 부족. |
| external Chrome + CDP (new headless) | 타당 | browser fidelity 충분. 단, screenshot 기반이라 frame pacing 상한 낮음. |
| Tier 3 GPU fast path (IOSurface import) | Tier 1 실패 시 fallback 후보 | Electron SharedTexture는 experimental + Node/V8 복제로 부적합. custom Chromium shell이 GPU texture export 대안이나 유지비용 매우 큼. |
| Electron 경로 | core 부적합 | SharedTexture가 experimental이며, 근본적으로 DESIGN.md가 제거하려는 Node/V8 runtime을 pane마다 복제. awrit/cliweb이 Electron을 쓴 건 빠른 prototype 때문이지 GPU fast path 때문이 아님 (awrit 실제 path는 CPU `toBitmap()`). |

#### Engine 선택의 복합 tradeoff

**S0 결정(사용자 입력 반영)**: vimium, 1Password, 개발 도구 extension(React DevTools 등), 개인화
도구에 대한 의존이 높아 **extension 지원은 포기할 수 없습니다.** "따로 설치라도 가능해야" 한다는
최소선(unpacked extension loading)조차 CEF에서는 안 되므로, **DESIGN.md 섹션 10을 유지하면 CEF는
확정 탈락**이고 engine 후보는 3종(external Chrome, custom Chromium shell, Electron)으로 압축됩니다.

| 차원 | CEF OSR | external Chrome (new headless) | custom Chromium shell | Electron | 비고 |
|---|---|---|---|---|---|
| frame pacing (검증 1) | **우위** (dirty rect) | 약세 (full-frame screenshot, `captureScreenshot`/`startScreencast` 모두 full-frame) | **우위** (GPU texture export 가능) | 중간 (`webContents.on('paint')` dirty rect, `SharedTexture` experimental) | **Electron이 external Chrome보다 우위**: in-process paint event로 damage-aware Kitty path에 자연 연결. external Chrome은 CDP full-frame만 → frame pacing 상한 |
| browser fidelity (검증 8) | 약세 (accelerated compositing 미지원) | **우위** (GPU compositing) | **우위** (GPU process) | **우위** (실제 Chromium) | external Chrome/custom shell/Electron 유리 |
| 한글 IME (검증 3) | **잠재 우위** (host IME 직접 주입) | 약세 (CDP Input, native IME 아님) | **잠재 우위** (host IME 직접 주입) | **우위** (embedded BrowserWindow가 macOS `NSTextInputClient`로 native composition) | **Electron이 external Chrome보다 우위**: native IME composition이 browser field에 실시간 표시. external Chrome은 CDP `Input.insertText`(composed text만)로 조합 과정 미표시 |
| extension (검증 4) | **사실상 불가** (#4011, #4187) | **우위** (`--load-extension`) | **우위** (실제 Chromium embed) | **우위** (Orca 증명) | **CEF 확정 탈락** |
| 배포 의존성 | **우위** (prebuilt bundle) | 약세 (시스템 Chrome 의존) | 약세 (Chromium build bundle) | **우위** (Electron 배포) | CEF/Electron 유리 |
| control 안정성 | **우위** (embed API) | 약세 (CDP experimental) | **우위** (embed API) | 중간 (Electron API) | CEF/custom shell 유리 |
| memory baseline | **잠재 우위** | 약세 (Chrome 전체) | **잠재 우위** | 약세 (Node/V8 복제) | CEF/custom shell 유리 |
| 유지 비용 | 낮음 (prebuilt) | 낮음 (Chrome 배포) | **매우 높음** (fork) | 낮음 (Electron 배포) | custom shell만 최대 |
| Orca 차별화 | — | **우위** (더 가벼운 runtime) | **우위** (memory·성능) | 약세 (Orca와 같은 engine) | external Chrome/custom shell 유리 |
| GPU fast path (Tier 3) | 불가 | 불가 | **가능** | 가능 (SharedTexture, experimental) | custom shell만 안정적 |

핵심 통찰:
- **extension 지원은 사용자가 포기할 수 없으므로 CEF는 확정 탈락.** engine 후보는 external Chrome,
  custom Chromium shell, Electron 3종.
- **Electron(Orca 경로)**은 extension·fidelity·IME·배포 모두 우위이나, Orca와 같은 engine이라
  TWeb 차별점이 tmux pane-native + terminal graphics rendering뿇이고 memory 타협.
- **custom Chromium shell**은 Electron을 피하면서 embedded Chromium 이점(extension·fidelity·
  IME·GPU fast path)을 모두 취하는 유일한 경로이나, 유지 비용 매우 큼. TWeb이 Orca 대비
  차별화하려는 경우.
- **external Chrome**은 가장 가벼운 runtime + extension·fidelity 확보이나, frame pacing 상한 +
  한글 IME 약세.

핵심 통찰: **external Chrome이 "성능 말고 다 우위"인 건 아닙니다.** browser fidelity(WebGL/미디어/
extension)에서는 확실히 우위지만, **한글 IME input, 배포 의존성, control 안정성, memory baseline에서는
CEF가 우위**이거나 잠재 우위입니다.

특히 **한글 IME(검증 3)**과 **extension(검증 4)**이 사용자가 강조한 영역입니다. external Chrome은
CDP `Input.insertText`/`dispatchKeyEvent`가 native IME conversion을 안 해 한글 composition 경로가
약세이나 extension은 `--load-extension`으로 지원합니다. Electron과 custom Chromium shell은 host IME
직접 주입으로 한글 composition에 유리하고 extension도 지원합니다.

**S0 결정: extension은 포기할 수 없으므로 CEF는 확정 탈락.** engine 후보는 3종(external Chrome,
custom Chromium shell, Electron)이며, 선택은 검증 1·3·8과 Orca 차별화 여부의 교차점에서 이루어집니다.
가능한 결과:

- **Electron 감수(Orca 경로)**: extension·fidelity·IME·배포 모두 우위. 가장 빠른 시장 진입.
  단, Orca와 같은 engine이라 TWeb 차별점이 tmux pane-native + terminal graphics rendering뿇이고
  memory 타협. DESIGN.md "Electron core 부적합" 재검토 필요.
- **external Chrome으로 release**: browser fidelity + extension 우위, 더 가벼운 runtime. 단,
  frame pacing 상한 + 한글 IME 약세 + 배포 의존성 감수.
- **custom Chromium shell**: Electron을 피하면서 embedded Chromium 이점(extension·fidelity·
  IME·GPU fast path)을 모두 취하는 유일한 경로. Orca 대비 memory·성능 차별화. 단, 유지 비용
  매우 큼(S2).
- **hybrid(external Chrome 기본 + custom shell for GPU fast path)**: 복잡도 큼.

### 1.3 위험도와 권장사항

**위험도: 중간.** GPU fast path의 experimental/fork 위험은 Tier 1이 충분하면 회피 가능합니다.
위험도를 높음에서 중간으로 하향하는 근거는 Kitty graphics protocol이 damage/composite/animation을
protocol 차원에서 충분히 지원한다는 조사 결과입니다. 단, engine 선택(CEF vs external Chrome)의
tradeoff는 별도 위험입니다.

**권장사항**:

- **S1에서 CEF OSR과 external Chrome(new headless)을 3차원(검증 1·3·8)에서 비교하세요.**
  frame pacing, 한글 IME input, browser fidelity를 각 engine에서 측정하고, TWeb 사용 사례에
  맞는 선택 또는 hybrid를 결정합니다. custom Chromium shell은 셋 다 안 될 때의 최후 hybrid로만
  둡니다.
- **한글 IME input(검증 3)을 engine 선택의 주요 차원으로 포함하세요.** CEF embed는 host IME
  composition을 Chromium에 직접 주입하기 더 쉬우나, external Chrome은 CDP Input이 native IME가
  아니라 한글 composition 경로가 약세입니다. 한글 입력이 중요한 TWeb에서 이 차원이 external
  Chrome 선택의 의미 있는 장애가 될 수 있습니다.
- **Tier 1 damage-aware Kitty path를 첫 검증 대상으로 하세요.** CEF OSR의 CPU bitmap + dirty
  rect로 damage-aware Kitty 전송을 구현하고, 목표 frame pacing을 측정합니다. Electron은 이
  단계에서 불필요합니다.
- **browser fidelity(검증 8)는 external Chrome(new headless)으로 측정하세요.** CEF의 accelerated
  compositing 미지원은 OSR 한계이므로, WebGL/hw video decode가 필요하면 external Chrome 경로가
  해결책입니다. custom shell은 browser fidelity를 위해 필요하지 않습니다.
- **Tier 1이 목표를 만족하고 browser fidelity 제약이 감당 가능하면 CEF로 release하세요.** 유지
  비용이 가장 낮습니다(prebuilt binary).
- **GPU fast path가 필요해지만 external Chrome의 frame pacing 상한이 감당 안 되면 그때만 custom
  Chromium shell을 검토하세요.** 이건 최후 hybrid이며, Chromium fork 유지 비용(S2)이 survival
  가능한지 별도 판단이 필요합니다.
- **Ghostty fork 대신 upstream 기여를 최우선으로 시도하세요.** "Ghostty-only Terminal Control
  Sequences ❌" 표시가 fork 부담을 줄일 수 있는 기여 여지입니다. 실패 시에만 fork 비용을
  감수합니다.

### 1.4 상세 설계 보강: frame path 검증 프로토콜

DESIGN.md 섹션 7.7의 release gate를 검증 가능한 단계로 구체화합니다. Tier 1 우선, engine 2종
병렬 측정, GPU fast path는 최후 fallback으로 순서를 바꿨습니다.

```text
Phase A — Tier 1 damage-aware Kitty path 검증 (두 engine 병렬)
    A-CEF:    CEF OSR CPU bitmap + dirty rect → persistent shm ring → Kitty graphics
    A-Chrome: external Chrome(new headless) screenshot → shm ring → Kitty graphics

    공통 측정:
    1. CPU bitmap/screenshot을 persistent shared-memory ring에 write (매 paint shm_open 금지)
    2. dirty rect 또는 변화 감지 → adaptive tile 매핑, 변경 tile만 Kitty graphics 전송
    3. static page idle 시 frame transfer 0회 측정
    4. 1080p continuous scroll 60Hz frame pacing 측정
    5. 10분 animation 후 stale image/shm object 0개 측정
    6. resize 후 2 display frame 내 새 generation만 표시

Phase A 결과:
    CEF가 frame pacing 만족 + browser fidelity 제약 감당 → CEF로 release, 완료
    external Chrome이 frame pacing 감당 + browser fidelity 만족 → external Chrome로 release, 완료
    둘 다 감당 못 함 → Phase B/C로 GPU fast path (최후 hybrid)

Phase B — custom Chromium shell GPU texture export 검증 (최후 fallback)
    1. Chromium embed에서 GPU compositor output을 IOSurface/DMA-BUF로 export
    2. handle을 authenticated local IPC로 전달
    3. CPU full-frame copy 0회 측정
    4. (비교 baseline용으로만) Electron SharedTexture 동일 측정

Phase C — Ghostty로 handle import
    1. Ghostty가 전달받은 IOSurface handle을 MTLTexture로 import
    2. pane geometry에 맞춰 composite
    3. resize 시 generation 교체, stale frame 미표시
    4. 이 단계가 실패하면 Tier 1 + 향후 NativeSurfaceTransport로 귀결
```

Phase A는 Ghostty fork 없이 두 engine을 병렬로 검증합니다. Tier 1 + browser fidelity가 둘 중
하나로 성립하면 전체 architecture가 가장 가벼운 경로로 확정되고, Electron/custom shell 의존
없이 release할 수 있습니다.

## 2. tmux semantics — image cache, visibility, resize, kill

### 2.1 조사 결과

- `switch-client -T <key-table>`: 공식 지원. "sets the client's key table; the next key will be
  looked up using key-table. After that key, the client is returned to its default key table."
- `Any` special key: "A command bound to the `Any` key will execute for all keys which do not have
  a more specific binding." DESIGN.md 섹션 9.2의 Browser mode 구현이 이 조합으로 동작합니다.
- `allow-passthrough`: man page에 명시적 설명은 없으나, cliweb과 casty 모두 `set -g
  allow-passthrough all`/`on`을 요구합니다. cliweb은 tmux 3.3+ 필요, 3.6+ 권장으로 명시합니다.
- mouse: `{mouse}` token으로 event 발생 pane 식별. `send-keys -M`으로 mouse event pass-through.
  pane interior mouse event와 border resize event를 분리하는 건 binding 수준에서 구현해야 합니다.

#### tmux PR #5274: grid-resident Kitty image support (판단 변경의 핵심)

- **PR #5274** (open, 2026-06-25, author meisbokai, branch `ta/kitty-img`): "kitty images: render
  via unicode placeholders (grid-resident)". 이게 사용자가 직관한 "tmux pane-aware Kitty 구현체"의
  정확한 실체입니다.
- **접근**: Kitty APC를 tmux가 가로채 image data를 `a=t`(transmit-only, placement 없음)로 각
  kitty client에 한 번 전송. 그 후 `a=p,U=1`로 virtual placement로 render rectangle 정의.
  `U+10EEEE` placeholder cell을 pane grid에 `cols × rows`로 채우고, image id를 foreground
  colour에, row를 combining diacritic에 인코딩. image가 **ordinary grid cell**이 됩니다.
- **pane-aware 동작**: "clip to their pane, scroll with the text, and coexist — none of which the
  overlay approach could do." grid operation이 image를 자체 처리합니다.
  - clip: pane 경계로 자동 clip.
  - scroll: text와 함께 scroll.
  - resize: aspect 보존하 양축 동일 비율 scale. `GRID_LINE_WRAPPED` reflow가 image line을
    join해 ghost를 남기던 문제를 real newline 종료로 수정.
  - split: "produces no duplicated/ghost images" (자동화 테스트로 검증).
  - kill/scroll-off: `image_store`(sixel과 동일)로 per-screen image list가 lifetime 소유.
    global image cap이 memory bound. 단, cap이 `==`로 하나만 해제하던 bug를 수정.
- **passthrough와의 차이**: overlay(grid 위 floating)가 아니라 grid-resident이므로 scroll/clip/
  clear/reflow가 특수 처리 없이 동작.
- **명시적 limitation**: "image data is transmitted to clients attached at the time the image is
  captured." late-attach client가 기존 image를 못 봄. "per-client transmit tracking on redraw"가
  필요. mgrant0의 `4902-image-support` branch가 kitty+sixel 일반화와 multiple attached
  terminals를 다루려 함.
- **upstream 전망**: nicm이 "will probably happen with it at some point", mgrant0이 "on my radar
  due next few weeks", ThomasAdam이 "happily review the final patch set". Ready 상태.

### 2.2 타당성 평가

DESIGN.md 섹션 7.4의 판단을 **업데이트**합니다. stock tmux가 image object를 이해하지 못한다는
전제가 PR #5274로 바뀌고 있습니다.

| 접근 | image 위치 | pane clip | scroll | resize | kill/ghost | stale placement | TWeb 책임 |
|---|---|---|---|---|---|---|---|
| passthrough overlay (현재 baseline) | grid 위 floating | 안 됨 | 안 됨 | ghost | 잔상·cleanup 비용 | TWeb reconcile | 높음 |
| **grid-resident (#5274)** | **grid cell** | **됨** | **됨** | aspect 보존 | **ghost 없음** | **tmux 자체** | **낮음** |

- **baseline compatibility cost가 대부분 사라집니다.** TWeb이 책임지던 pane visibility, repaint
  reconciliation, deterministic delete, stale placement 복구를 tmux grid operation이 처리합니다.
- **enhanced tmux branch가 선택 tier에서 기본 경로 후보로 승격 가능합니다.** upstream merge
  가능성이nicm/mgrant0 발언으로 높아졌습니다.
- grid-resident는 **Kitty graphics 표준 경로(`a=t` + `a=p,U=1`)**를 쓰므로 Tier 1 damage-aware
  Kitty path와 완전 호환됩니다. TWeb의 damage tile 전송이 tmux grid와 자연스럽게 통합됩니다.
- **한계**: late-attach client가 기존 image를 못 봅니다. 이는 TWeb이 pane 재 attach 시 전체
  image를 redraw하는 reconcile로 보완할 수 있으며, DESIGN.md 섹션 8의 "browserd 재연결 후 전체
  상태 reconcile" 구조가 그대로 적용됩니다.
- Tier 3 GPU fast path의 side channel은 tmux와 무관하게 browserd↔Ghostty local channel로
  전달되므로(DESIGN.md 섹션 7.4 마지막 단락), grid-resident와 충돌하지 않습니다.

`switch-client -T tweb-browser` + `Any send-keys` + reserved toggle 복귀 조합은 tmux 공식
기능으로 확인됐으므로, Browser mode 입력 모델은 구조적으로 성립합니다.

### 2.3 위험도와 권장사항

**위험도: 중간 → 낮음(grid-resident merge 후) / 중간(merge 전).** PR #5274가 merge되면
visibility/reconcile 부담이 tmux로 이전됩니다. merge 전까지는 기존 baseline cost가 유지됩니다.

**권장사항**:

- **PR #5274 merge를 적극적으로 추적하고, 가능하면 기여하세요.** 이 PR이 merge되면 DESIGN.md
  섹션 7.4의 baseline compatibility cost 대부분이 사라집니다. late-attach per-client transmit
  tracking이나 automated test 강화로 기여하면 upstream 관계도 좋아집니다.
- **enhanced tmux branch를 "선택 tier"가 아닌 "기본 경로 후보"로 재위치하세요.** DESIGN.md
  섹션 7.4의 "선택적 enhanced tmux branch"를, PR #5274 기반으로 기본 지원 경로로 승격하는
  설계 수정을 검토합니다. 단, merge 전까지는 stock tmux passthrough fallback을 유지합니다.
- **late-attach limitation을 TWeb reconcile로 보완하세요.** pane 재 attach 시 browserd가 전체
  image를 redraw하는 구조(섹션 8)가 이미 있으므로, grid-resident의 per-client transmit 한계를
  TWeb이 자연 보완합니다.
- **tmux version별 conformance test를 확정하세요.** `switch-client -T` `Any` forwarding,
  key-up/repeat, extended key, mouse 동작이 지원 version에서만 "지원"으로 표시하세요.
- **stale image 복구를 idempotent reconcile로 유지하세요.** grid-resident가 대부분 처리하지만,
  비정상 종료 복구는 여전히 TWeb 책임입니다. integration test를 baseline에 포함합니다.

### 2.4 상세 설계 보강: tmux 경로 매트릭스

```text
stock tmux passthrough (Tier 1 baseline, merge 전)
    TWeb 책임: pane visibility, repaint reconcile, deterministic delete, stale placement 복구
    한계: overlay floating, ghost/잔상 가능

grid-resident tmux (#5274 merge 후, Tier 1 승격 후보)
    tmux 책임: clip, scroll, resize scale, split ghost 방지, kill/scroll-off lifetime
    TWeb 보완: late-attach redraw reconcile (섹션 8 구조 재사용)
    이점: baseline compatibility cost 대부분 제거

enhanced tmux branch (mgant0 4902-image-support 일반화 방향)
    kitty + sixel 통합, multiple attached terminals per-client tracking
    upstream 기여 우선, fork는 최후 수단
```

```text
tmux version 호환성

tmux 3.3   allow-passthrough 도입. 최소 지원 (passthrough baseline).
tmux 3.6   cliweb 권장 version. Any key forwarding 안정성 확인 필요.
tmux HEAD  PR #5274 grid-resident kitty image. merge 전. integration branch 검증.
```

지원 선언은 version 번호가 아니라 "이 조합에서 이 capability가 검증됐다"로 표현합니다
(DESIGN.md 섹션 15 정책과 일치).

## 3. Input fidelity — Browser mode, 한글 IME, mouse

### 3.1 조사 결과

#### Ghostty는 macOS에서 IME composition을 native로 처리합니다

이전 판단을 정정합니다. 한글 IME composition 중간 상태는 "terminal protocol 구조적 한계"가
아닙니다. Ghostty가 macOS `NSTextInputClient`로 IME composition(preedit/marked text)을 native
수신합니다. Korean IME 관련 이슈들이 이를 확인합니다.

- **#11461** (closed/fixed, 2026-04, milestone 1.3.2): "Korean IME preedit cancelled when pressing
  arrow keys". 방향키/delete 누를 때 preedit를 cancel이 아닌 commit으로 처리하도록 수정
  (PR #12447). Apple Terminal.app과 동일 동작 확보.
- **#12547** (merged, 2026-05, milestone 1.4.0): "avoid replaying keys that commit preedit".
- **#13235** (open, 2026-07): "Korean IME: Initial syllable composition fails on first input".
- **#4634** (fixed, 1.1.0): modifier key가 preedit를 보존하도록 수정.

`preedit`, `commit`, `marked text` 용어가 일관되게 쓰이며, Ghostty가 macOS IME integration을
`NSTextInputClient` 수준에서 구현하고 있음을 보여줍니다. 즉 composition 중간 상태를 Ghostty가
이미 알고 있고, 남은 문제는 **이 composition event를 어느 경로로 tweb __pane과 Chromium에
전달하느냐**입니다.

#### 전달 경로가 fidelity를 결정합니다

| 경로 | composition 중간 상태 | 근거 |
|---|---|---|
| PTY + Kitty keyboard protocol | 미지원, committed text만 | PTY는 byte stream, Kitty keyboard protocol이 composition lifecycle을 다루지 않음. 이 경로의 한계는 진짜입니다. |
| Native side channel (enhanced Ghostty) | **지원 가능** | Ghostty가 macOS IME composition을 native로 받음. 이를 authenticated local IPC side channel로 tweb __pane에 전달. DESIGN.md 섹션 7.2의 "PTY와 side channel 역할 분리"를 입력으로 확장. |
| Chromium embed host 직접 주입 | **지원 가능** | Chromium이 `TextInputClient`/`setMarkedText`/`insertText` 계열로 host에서 composition을 주입받음. CEF API 문서가 비어 있어 확증은 못 했으나, `iced-cef`가 input adapter를 roadmap에 둔 것이 같은 방향. |

#### CDP 경로의 한계

- CDP `Input.insertText`: CJK composed text를 focused editable에 직접 전달 가능. 단, CDP가
  native IME conversion을 수행하지 않으므로, composition sequence는 `Input.dispatchKeyEvent`로
  시뮬레이션해야 합니다.
- casty가 `Runtime.enable`을 끄는 것으로 Google login이 동작한다는 발견은, CDP 설정이 인증
  flow에 영향을 줄 수 있음을 보여줍니다.
- CDP 경로는 agent automation용이지 human IME 입력 경로가 아닙니다. 사람의 한글 입력은
  Ghostty native IME → side channel → Chromium host 주입 경로로 가야 fidelity가 보장됩니다.

### 3.2 타당성 평가

**위험도: 중간.** 이전 평가의 높음에서 하향합니다. 이유는 composition 중간 상태를 전달할
수 있는 경로(native side channel)가 확인됐기 때문입니다.

- **Tier 1 (vanilla Ghostty + tmux)**: committed text만 가능. PTY byte stream 한계로 composition
  중간 상태를 browser field에 실시간 표시하지 못합니다. 이는 "한글 입력 안 됨"이 아니라
  "조합 과정이 browser field에 실시간 미표시, 최종 글자는 정상 입력"입니다.
- **Tier 3 (enhanced Ghostty)**: composition 중간 상태 실시간 표시 가능. DESIGN.md 섹션 7.2의
  side channel이 원래 GPU handle/fence용이지만, **입력 composition event를 같은 side channel로
  전달**하면 됩니다. 이는 Tier 3가 rendering performance뿐 아니라 **한글 입력 fidelity에도
  필요**하다는 새 발견입니다.
- Chromium embed 측에서 host가 `setMarkedText`/`insertText`로 composition을 주입하면 browser
  input field에 조합 중 글자가 실시간 표시됩니다.

DESIGN.md 섹션 9.4의 "composition lifecycle을 전달하지 못하면 committed text 입력을 지원하고
제약을 명시" 정책은 **Tier 1 fallback 정책**으로 유효합니다. 단, 이를 전체 제품의 한글 입력
정책으로 단정하면 안 됩니다. Tier 3에서 composition 실시간 표시를 목표로 해야 합니다.

global key event interception으로 이를 우회하지 않는다는 원칙은 타당합니다. native IME 경로를
쓰되 side channel로 전달하는 방식은 Browser mode 입력 소유권 분리(섹션 9.1)를 훼손하지
않습니다 — side channel은 입력 소유권 경로가 아니라 composition event 전달 경로입니다.

### 3.3 권장사항

- **한글 입력을 두 단계로 설계하세요.** Tier 1은 committed text, Tier 3는 composition 중간 상태
  실시간 표시. Tier 1을 "한글 입력 지원"으로, Tier 3를 "한글 입력 fidelity"로 구분합니다.
- **DESIGN.md 섹션 7.2 side channel을 입력 composition event용으로 확장하세요.** 원래 GPU
  handle/fence만 전달하던 side channel에 `setMarkedText`/`insertText`/`unmarkText` event를
  추가합니다. PTY는 여전히 pane identity, placement, frame token, focus, visibility를 담당합니다.
- **Tier 3를 한글 입력 fidelity 관점에서도 검증 대상으로 두세요.** 원래 DESIGN.md는 Tier 3를
  rendering performance 선택 tier로만 다뤘으나, 한국 사용자에게 composition 실시간 표시는
  기본 기능 수준의 중요도입니다. 검증 3(input fidelity)의 통과 기준에 Tier 3 composition
  전달을 포함시킵니다.
- **Chromium embed host가 composition을 주입하는 경로를 검증하세요.** CEF의
  `CefBrowserHost` IME API 또는 custom Chromium shell의 `TextInputClient`로
  `setMarkedText`/`insertText`가 동작하는지 확인합니다. `iced-cef`의 input adapter roadmap이
  같은 방향을 가리킵니다.
- **입력 fidelity를 별도 conformance 영역으로 관리하세요.** 한글 조합·bracketed paste·
  OSC 52 clipboard·browser selection copy·file drop를 각각 독립 테스트합니다. 한글 조합은
  Tier 1(committed)과 Tier 3(composition)를 분리해 측정합니다.
- **`NativeSurfaceTransport`가 PTY 입력 한계를 해결하지 않는 점은 여전히 명시하세요.**
  rendering fallback이지, 입력이 PTY를 거치는 한 IME composition 한계 해결이 아닙니다.
  단, side channel 확장은 `NativeSurfaceTransport`와 별개의 입력 경로 해결책입니다.

### 3.4 상세 설계 보강: 입력 경로와 composition 전달

```text
경로별 한글 입력 fidelity

Tier 1 (vanilla Ghostty + tmux, PTY only)
    macOS IME → Ghostty NSTextInputClient → commit → PTY byte stream
              → tweb __pane → Chromium insertText (committed only)
    한글 입력: 됨 (최종 글자)
    composition 실시간 표시: 안 됨

Tier 3 (enhanced Ghostty, PTY + side channel)
    macOS IME → Ghostty NSTextInputClient
              ├─ commit → PTY byte stream (동일)
              └─ preedit/marked text → side channel → tweb __pane
                                       → Chromium host setMarkedText/insertText
    한글 입력: 됨
    composition 실시간 표시: 됨

Agent automation (CDP)
    CDP Input.insertText (composed text) 또는 dispatchKeyEvent 시뮬레이션
    한글 입력: 됨 (composed text)
    composition 실시간 표시: 해당 없음 (자동화 경로)
```

```text
side channel composition event schema (개념)

CompositionEvent
├── kind: markedText | insertText | unmarkText
├── pageID
├── text
├── selectedRange
└── generation
```

PTY는 pane identity, placement, frame token, focus, visibility를 유지합니다. side channel은
GPU handle/fence와 composition event를 함께 전달하되, 입력 소유권(Browser mode)은 PTY 경로의
tmux key table이 소유합니다.

## 4. Profile compatibility — Chrome extension, bookmark, site state

### 4.1 조사 결과

- Chrome Native Messaging host manifest 위치가 platform별로 명확합니다.
  - macOS system: `/Library/Google/Chrome/NativeMessagingHosts/`
  - macOS user: `~/Library/Application Support/.../NativeMessagingHosts/`
  - Linux: `/etc/opt/chrome/native-messaging-hosts/` 또는 `~/.config/...`
  - Windows: registry 기반 manifest path
- 통신은 stdin/stdout JSON, 32-bit length prefix. host→Chrome 최대 1 MB, Chrome→host 최대 64 MiB.
- `allowed_origins`로 extension ID를 정확히 화이트리스트 (wildcard 불가).
- host는 cookie/tab에 직접 접근하지 못하고, extension이 명시적으로 전달해야 합니다.
- `runtime.connectNative()`는 persistent port, `runtime.sendNativeMessage()`는 one-shot.

### 4.2 타당성 평가

DESIGN.md 섹션 10의 Chrome Profile Bridge 설계는 Native Messaging + cookies API 조합으로
실현 가능하나, **어느 engine에서 실행하느냐에 따라 달라집니다.** 두 가지 extension 역할을
구분해야 합니다.

#### extension 역할 구분

| 역할 | 실행 위치 | CEF | external Chrome |
|---|---|---|---|
| Profile Bridge extension (cookie/bootstrap) | **사용자의 일반 Google Chrome** | 해당 없음 (engine 무관) | 해당 없음 (engine 무관) |
| 사용자 extension 재설치 (1Password, uBlock 등) | **TWeb embedded browser 안** | **사실상 불가** | **가능** (실제 Chrome) |

Profile Bridge extension은 사용자의 일반 Chrome에서 실행되어 cookie를 읽어오는 목적이므로,
TWeb embedded browser engine(CEF/external Chrome)과 무관합니다. 이건 engine 선택에 영향을
받지 않습니다.

**engine 선택에 영향을 주는 건 두 번째 역할**입니다. DESIGN.md 섹션 10.5는 "Chrome profile의
extension metadata를 읽고 Web Store ID로 재설치"를 다룹니다. 즉 사용자가 Chrome에서 쓰던
extension을 TWeb browser 안에서도 쓰게 하려면, **embedded browser가 extension을 지원해야
합니다.**

#### CEF는 embedded browser 안의 extension이 사실상 불가

조사 결과:
- CEF 공식 문서(General Usage)에 extension에 대한 언급이 아예 없습니다.
- **#4011** "Extension tab API is not working for OSR" — **Not planned/skipped** (2025-10).
  CEF에서 extension tab API가 OSR 모드에서 안 되는 걸 공식적으로 안 고치기로 결정. TWeb은
  OSR이 기본이므로 직접 타격.
- **#4187** "feat: add new Extensions API for Alloy and Chrome runtimes" — **abandoned**
  (2026-06). extension API 추가 시도가 폐기.
- Electron(같은 Chromium embed)조차 extension을 "subset" 지원하며 "perfectly compatible is
  non-goal"이라 명시. Web Store extension 불가, unpacked만, `.crx` 불가, 매번 reload,
  `storage.sync`/`storage.managed` 불가. CEF는 이보다 더 제한적.

즉 **CEF embedded browser 안에서 사용자 extension(1Password, uBlock, Okta Browser Plugin 등)을
재설치·실행하는 건 사실상 불가**합니다. DESIGN.md 섹션 10.5의 extension 동기화가 CEF에서
동작하지 않습니다.

#### external Chrome(new headless)은 extension이 동작

external Chrome은 실제 Chrome이므로 모든 extension이 동작합니다. 단, new headless 모드에서의
extension loading 방식(`--load-extension` 또는 `--disable-extensions-except`)과 profile 기반
extension 지속성은 S1에서 별도 검증이 필요합니다.

### 4.3 위험도와 권장사항

**위험도: 중간.** (이전 평가 낮음에서 상향. CEF extension 불가가 engine 선택에 결정적이므로.)

- **DESIGN.md 섹션 10(extension/profile bootstrap)을 제품 핵심으로 유지하는지 먼저 결정하세요.**
  유지하면 CEF는 engine 후보에서 사실상 탈락하고 external Chrome이 유일한 engine입니다.
  섹션 10을 비목표로 내리거나 "extension은 external Chrome handoff에서만"으로 우회하면 CEF가
  다시 후보가 됩니다.
- **Profile Bridge extension은 engine 무관임을 문서에 명시하세요.** 이 extension은 사용자의 일반
  Chrome에서 실행되므로, CEF를 쓰더라도 cookie bootstrap은 동작합니다. 혼동의 소지가 있습니다.
- **Native Messaging host를 Rust로 구현하세요.** core 언어 정책과 일관되고, stdin/stdout JSON
  framing은 Rust로 간단합니다. 단, Chrome이 host를 spawn하므로 host binary path가 manifest에
  고정되어야 합니다.
- **external Chrome new headless의 extension loading 방식을 S1에서 검증하세요.** `--load-extension`,
  `--disable-extensions-except`, profile 기반 extension 지속성이 new headless에서 동작하는지.
- **extension compatibility 결과를 version별 registry로 관리하세요.** 1Password·Okta Browser
  Plugin을 `managed-chrome-only`로 분류하는 근거를 probe 결과로 쌓습니다.

### 4.4 상세 설계 보강: engine별 extension 경로 매트릭스

```text
Profile Bridge extension (cookie/bootstrap)
    실행: 사용자의 일반 Google Chrome
    engine 무관 (모든 engine에 해당 없음)
    경로: Chrome Native Messaging host(Rust) ↔ extension ↔ twebd
    한계: engine 선택에 영향 없음. CEF에서도 cookie import는 이 경로로 동작.

사용자 extension 재설치 (1Password, uBlock, Okta Plugin 등)
    CEF embedded browser 안:
        사실상 불가 (#4011 OSR not planned, #4187 abandoned)
        → 사용자에게 "TWeb에서 extension 안 됨" 명시 필요
    external Chrome(new headless) 안:
        가능 (실제 Chrome, --load-extension)
        단: new headless extension loading 방식 S1 검증 필요
    custom Chromium shell:
        가능 (실제 Chromium embed, extension API 접근)
        단: 유지 비용 매우 큼
    Electron:
        가능 (Orca 증명, Web Store 설치도 지원)
        단: Orca와 같은 engine + memory 타협

DESIGN.md 섹션 10.5 extension 동기화 정책
    CEF: 동작 안 함 → 섹션 10.5 비목표 또는 우회 경로(4.5)로 대체
    external Chrome/custom shell/Electron: 동작 → 섹션 10.5 그대로 실현
```

### 4.5 extension 우회 경로: CEF를 조건부로 후보로 되돌릴 수 있는가?

사용자가 "따로 설치라도 가능해야"라고 한 건 **기존 extension을 그대로 쓰고 싶다**는 뉘앙스이나,
"cookie import + vimium-like 단축키를 TWeb이 자체 제공하면 된다"는 우회도 가능합니다. 이 우회가
사용자 요구를 충족하면 CEF가 다시 후보가 됩니다.

#### cookie import — CEF에서도 가능 (engine 무관)

- Profile Bridge extension은 사용자의 일반 Chrome에서 실행되어 cookie를 읽음(섹션 4.2).
- Native Messaging host(Rust)가 cookie 값을 받아 TWeb embedded browser에 programmatic으로 주입.
- CEF는 `CefCookieManager` + cookie set API(header에 존재)로 주입 가능.
- 즉 **cookie import는 CEF에서도 동작**. 단, Chrome Cookies SQLite 직접 읽기(섹션 10.2 금지)가
  아니라 Profile Bridge extension 경로를 써야 함.

#### vimium 내장 — 부분 가능, 전체는 어려움

vimium 기능을 조사하니 두 그룹으로 나뉩니다:

| 기능 | extension API 필요? | CEF에서 우회 가능? |
|---|---|---|
| scrolling(`j`/`k`), find(`/`), link hints(`f`), visual mode(`v`) | 아니요 (pure DOM) | **가능** — JS injection으로 |
| tab 생성/종료/복원(`t`/`x`/`X`), history(`H`/`L`), window(`W`) | 예 (`chrome.tabs`/`windows`) | **TWeb이 tmux pane 단위로 자체 구현 가능** — 오히려 tmux-native에 자연스러움 |
| bookmark/history(`o`/`O`/`b`/`B`) | 예 (`chrome.bookmarks`/`history`) | **어려움** — TWeb이 별도 bookmark/history store 구현 필요 |
| chrome.storage (설정) | 예 | TWeb 자체 config로 대체 가능 |
| clipboard(`yy`) | 부분 (`navigator.clipboard.writeText`) | HTTPS에서는 JS로 가능 |

즉 **vimium의 핵심 navigation(link hints, scroll, find)은 CEF에서 JS injection으로 내장 가능**하고,
**tab/window 관리는 TWeb이 tmux pane 단위로 자체 구현**하면 오히려 Orca/Chrome과 다른 TWeb만의
자연스러운 경로가 됩니다. bookmark/history 접근만 별도 store가 필요합니다.

#### 다른 extension은 우회가 어렵거나 불가능

vimium은 자체 구현 가능하지만:
- **1Password**: browser extension API + native messaging + secure enclave 접근. TWeb 자체 구현 불가.
  기존 extension 그대로 쓰려면 extension 지원 engine 필요.
- **uBlock**: content script + webRequest API + 방대한 광고 차단 rule 관리. 자체 구현 사실상 불가.
- **React DevTools**: DevTools extension API. CEF의 DevTools extension 지원 불확실.

#### 우회 경로의 타당성 판정

| 사용자 요구 | CEF 우회 가능? |
|---|---|
| "기존 Chrome extension을 그대로 설치해서 쓰고 싶다" (vimium, 1Password, uBlock, React DevTools 등) | **불가** — CEF 탈락 유지 |
| "cookie import + vimium-like 단축키를 TWeb이 자체 제공하면 된다" | **가능** — CEF 후보 복귀. 단, 1Password/uBlock/React DevTools는 포기 또는 external Chrome handoff |
| "vimium 정도만 되면 된다, 다른 extension은 TWeb 내장 또는 handoff" | **가능** — CEF 후보 복귀 |

즉 **우회 경로는 CEF를 조건부로 후보로 되돌릴 수 있으나**, 사용자가 1Password/uBlock/React DevTools 등
기존 extension을 그대로 쓰길 원하면 CEF는 탈락 유지입니다. 이 판정은 S0의 미정 항목입니다.

## 5. Profile security — origin-scoped one-shot cookie transfer

### 5.1 타당성 평가

- per-origin runtime permission 요청, one-shot transfer, 값 비로그 정책이 모두 extension 권한
  모델로 실현 가능합니다.
- `HttpOnly`, `Secure`, partitioned cookie 보존은 `cookies` API가 attribute를 포함해 반환하므로
  전달 시 보존 가능.
- organization/IdP denylist를 extension 측에서 먼저 적용하는 정책은 구현 가능.
- threat model과 별도 security review 통과 요건(섹션 16)이 이미 명시돼 있습니다.

**위험도: 낮음.** 권장사항:

- **cookie transfer audit에 domain, 개수, source/target, 시각만 기록하는 규칙을 테스트로
  검증하세요.** 값이 log에 한 번도 노출되지 않는지를 redaction test로 확정합니다.
- **sensitive domain denylist 해제를 organization policy가 명시 승인하지 않는 한 막는 정책을
  config가 아닌 code로 강제하세요.** 사용자 설정으로 해제 가능하면 정책 우회 위험이 있습니다.

## 6. Agent control — human/agent 동일 page 공유

### 6.1 조사 결과

- CDP는 Chrome 63부터 multi-client를 지원합니다. 여러 client가 같은 page에 attach 가능.
- 단, built-in DevTools frontend를 열면 기존 CDP 연결이 `replaced_with_devtools`로 detach됩니다.
  → 사람이 Chromium의 DevTools를 직접 여는 시나리오만 아니면 공유 가능.
- cliweb이 이미 human/agent shared control을 구현했습니다. Codex와 인간이 같은 Chromium
  instance를 공유하며, 인간은 browser split에서 직접 조작하고 Codex는 `cliwebctl`로 자동화.
  "A human can interact between any two commands; Codex should simply inspect the new state before
  continuing."
- cliweb은 cookie 값, password store, 임의 page JavaScript를 control protocol에 노출하지 않습니다.

### 6.2 타당성 평가

- 사람이 직접 Chromium UI를 조작하는 게 아니라 TWeb의 terminal frontend를 통해 조작하므로,
  DevTools frontend detach 이슈는 TWeb 시나리오에 해당하지 않습니다.
- human input과 agent CDP command가 같은 page에 동시에 도달할 수 있으며, cliweb이 이를 이미
  증명했습니다.
- DESIGN.md 섹션 12.1의 "사람이 browser input을 시작하면 agent lease 일시 중단" 정책은
  cliweb의 "inspect new state before continuing" 패턴과 같은 방향입니다.

**위험도: 중간.** 권장사항:

- **agent command queue와 human input의 interleaving을 lease 모델로 명시하세요.** 사람이
  input을 시작하면 agent lease를 일시 중단하고, 사람 입력이 끝난 뒤 agent가 새 snapshot을
  찍는 계약을 cliweb 패턴에서 차용합니다.
- **외부 제출, 구매, 메시지 전송, upload, delete의 실행 직전 확인(섹션 12.1)을 agent가 우회하지
  못하게 하세요.** 이는 capability 수준에서 강제해야 하고, agent prompt에만 의존하면 안 됩니다.

### 6.3 상세 설계 보강: lease 상태 기계

```text
IDLE        page 존재, active controller 없음
HUMAN       사람이 input 중. agent command는 대기 또는 lease 일시 중단
AGENT       agent가 control lease 보유. 사람 input이 들어오면 HUMAN으로 전환
CONTENDED   사람과 agent가 동시에 input 시도. 마지막 snapshot 기준으로 사용자에게 조율
```

`CONTENDED` 상태에서 임의 last-write-wins를 쓰지 않고, 사용자에게 명시적 조율 UI를 보여주는
정책이 섹션 10.3의 "충돌 시 임의 last-write-wins 사용하지 않음"과 일관합니다.

## 7. Remote extension — transport 교체

### 7.1 조사 결과

- cliweb: "The terminal emulator, tmux server, and cliweb process must run on the same machine
  because rendered frames use POSIX shared memory." → shared memory locality 제약.
- casty: SSH/headless에서 CDP screenshot 기반 동작. 단, full-frame JPEG/PNG, ~20fps, base64
  encode/decode, inline 4096-byte chunk → 성능 상한이 명확히 낮습니다. casty 저자도
  interactive primary renderer가 아닌 저프레임 fallback/static snapshot backend로
  위치시킵니다.
- Kitty graphics protocol `t=s` shared memory는 same-machine 전제입니다. cross-host 전송은
  protocol이 지원하지 않습니다.

### 7.2 타당성 평가

- DESIGN.md 섹션 7.6의 remote 경로 "→ hardware video transport"가 조사와 일치합니다.
  shared memory는 same-host에 국한되므로, remote는 video encode/decode 경로가 필요합니다.
- `tweb://resource/<id>`로 resource identity와 저장 위치를 분리하는 설계(섹션 12.12)는
  cross-host materialization을 지원합니다.
- `RemoteVideoTransport`가 준비되지 않은 환경에서 casty-style CDP screenshot 경로를 저프레임
  fallback으로 두는 정책(섹션 18)이 타당합니다.

#### Electron 선택 후 remote 구분 (process 위치 vs rendering surface)

**S0 결정(Engine = Electron) 후 remote case가 더 명확해집니다.** 핵심은 **browser process
위치(BrowserRuntime)와 frame 전달 방식(FrameTransport)을 분리**하는 DESIGN.md 섹션 7.6 구조:

```text
로컬 case: tmux + Ghostty + tweb + Electron 모두 같은 머신
    Electron webContents paint → SHM/Kitty graphics → 로컬 Ghostty (단순)

remote case: tmux server + Electron은 remote, Ghostty + 사용자는 로컬
    remote Electron webContents paint → video encode → 네트워크 →
    로컬 tweb __pane decode → 로컬 Ghostty Kitty graphics
    입력: 로컬 Ghostty → SSH/tmux → remote tweb __pane → remote Electron
```

- **frame**: remote Electron의 `webContents.on('paint')` → `RemoteVideoTransport`로 video encode →
  로컬에서 decode → Kitty graphics. DESIGN.md 섹션 7.6 `RemoteVideoTransport`와 일치.
- **입력**: 로컬에서 발생하므로 SSH/tmux를 통해 remote로 전달.
- **resource**: `tweb://resource/<id>`는 전역 identity, ResourceBroker가 locality(hostID,
  storageKind)를 보고 전송 방식 결정(섹션 12.12).

#### remote case의 한글 IME 추가 어려움

**로컬 case**는 Electron BrowserWindow가 macOS `NSTextInputClient`로 native composition을 받아
해결됩니다. 그러나 **remote case**에서는:
- Electron BrowserWindow가 remote에 있으므로 **remote macOS IME**를 씀.
- 사용자의 로컬 IME 상태와 remote IME 상태가 다름.
- **Tier 1**: committed text만 remote에 전송(로컬 IME 조합 완료 후) — network latency 영향 적음.
- **Tier 3**: side channel로 로컬 composition event를 remote Electron에 주입 — 단, network
  latency로 composition 실시간 표시가 어려울 수 있음.

즉 **remote case에서는 한글 IME composition 실시간 표시가 로컬 case보다 더 어렵습니다**. 이건
검증 3(input fidelity)이 로컬과 remote를 분리해 측정해야 함을 의미합니다.

**위험도: 중간.** 권장사항:

- **remote transport를 첫 release gate에서 검증하지 말고, 검증 1~3이 통과한 뒤 확장 영역으로
  다루세요.** 섹션 17의 순서가 이미 이 순서입니다. remote는 identity/API를 유지한 채 transport만
  교체하는 구조이므로, local 경로가 성립한 뒤로 미뤄도 architecture가 깨지지 않습니다.
- **로컬 case를 먼저 완전히 해결하고, remote는 별도 phase로 다루세요.** Electron native IME +
  damage-aware Kitty path가 로컬에서 성립한 뒤, `RemoteVideoTransport`를 추가해도
  `BrowserPageID`/profile/automation API는 유지됩니다.
- **remote 한글 IME를 별도 검증으로 두세요.** 로컬은 Electron native IME로 composition 실시간
  표시가 가능하나, remote는 network latency + IME 상태 동기화로 더 어렵습니다. remote에서는
  committed text fallback이 현실적일 수 있습니다.
- **casty-style screenshot fallback의 성능 상한을 문서에 명시하세요.** "interactive primary
  renderer가 아니다"를 사용자에게 숨기지 않는 정책(섹션 7.3)을 remote fallback에도 동일하게
  적용합니다.

## 8. Browser fidelity — WebAPI, 미디어, 입력 처리의 기성 browser 수준 보장

### 8.1 문제 정의

DESIGN.md는 "실제 Chromium browser"를 반복해 강조하지만, 어느 WebAPI/미디어가 기성 browser
수준으로 동작하는지를 별도 검증 영역으로 다루지 않습니다. 사용자가 제기한 대로, terminal 안에서
"browser처럼 보이지만 실제로는 일부가 안 되는" 경험은 제품 신뢰를 직접 훼손합니다. 이 영역을
검증 8번으로 추가하고, engine 선택과 연결합니다.

### 8.2 조사 결과

#### 핵심 발견: "accelerated compositing 미지원"은 OSR 한계, Chromium 한계가 아님

- CEF OSR이 accelerated compositing을 안 쓰는 건 **CEF가 window surface를 만들지 않기 때문**입니다.
- **new headless Chrome(Chrome 112+)**은 "creates, but doesn't display, any platform windows.
  All other functions, existing and future, are available with no limitations." 즉 **보이지 않는
  window를 만들고 표준 `//chrome` rendering pipeline을 그대로 씁니다**. GPU compositing, WebGL,
  hardware video decode가 모두 동작합니다.
- 따라서 **browser fidelity(검증 8)는 external Chrome(new headless)로 해결**되며, custom
  Chromium shell이 필요하지 않습니다.

#### Engine별 WebAPI/미디어 지원 (2종, custom shell은 최후 hybrid)

| 기능 | CEF OSR | external Chrome + CDP (new headless) |
|---|---|---|
| WebGL / 3D CSS | **영향** (accelerated compositing 미지원) | **지원** (window 있음, GPU compositing) |
| Hardware video decode | **영향** | **가능** |
| Canvas 2D | software path | 가능 |
| WebRTC (camera/mic) | 문서에 "지원" 명시 | 가능, 단 device 접근 별도 |
| Audio playback | **device routing 별도 필요** | system audio 직접 |
| Autoplay policy | Chromium 기본 | Chromium 기본 |
| Codec (H.264/AAC/AV1) | Chromium build에 의존 | 동일 |
| WebCodecs | Chromium build에 의존 | 동일 |
| WebAuthn / credential | 가능 | 가능 |

(custom Chromium shell은 external Chrome과 동일한 fidelity를 가지나, 유지 비용이 매우 높아
최후 hybrid로만. 표에서 제외.)

#### Audio pipeline의 구조적 특수성

- Chromium audio는 **pull-based**, sound card가 clock을 drive합니다. audio device가 없으면 system
  clock이 video decode/render를 drive합니다.
- sandbox 때문에 renderer process가 audio device를 직접 열지 못하고 browser process가 대신
  엽니다. embedded Chromium에서 audio output을 안 하려면 browser process가 audio device를
  열거나, **audio output을 가로채 다른 경로로 routing**하는 설계가 필요합니다.
- casty가 headless server에서 PulseAudio 별도 설치를 요구한 것이 이 한계의 실례입니다.
- TWeb은 사용자 machine에서 동작하므로 system audio가 있지만, **여러 browser pane의 audio를
  어떻게 mix/루팅할지**가 설계 포인트입니다. pane마다 mute, volume, audio routing이 필요합니다.
- external Chrome(new headless)은 browser process가 system audio device를 직접 열므로 audio
  routing 부담이 CEF 대비 적습니다. 단, pane별 mute/volume은 여전히 별도 설계.

#### new headless Chrome 전제

- Chrome 132+의 new headless를 씁니다. old headless shell은 별도 binary(`chrome-headless-shell`)로
  분리됐고, Puppeteer `headless:'shell'`이 이를 가리킵니다. TWeb은 new headless만 씁니다.
- external Chrome + CDP 경로는 browser process 하나를 공유하고 page만 분리하므로, DESIGN.md의
  "pane마다 runtime 복제 금지" 원칙을 지킵니다. 단, GPU fast path 부재(full-frame screenshot)는
  검증 1의 frame pacing 상한으로 별도 측정합니다.

#### CEF OSR의 제약 (browser fidelity 차원)

- accelerated compositing 미지원 → WebGL, 3D CSS, hardware video decode가 software fallback으로
  성능 저하 또는 미동작.
- Tier 1 damage-aware Kitty path가 frame pacing을 만족해도, WebGL/비디오가 기성 browser 수준으로
  안 되면 browser fidelity 검증을 통과하지 못합니다.
- 단, TWeb 주 사용 사례(dev server preview, dashboard, form 입력)가 WebGL/hw video decode를
  필수로 요구하지 않으면 CEF의 제약을 감당할 수 있습니다.

### 8.3 타당성 평가

**위험도: 중간.** browser fidelity는 external Chrome(new headless)로 해결되므로, 높음에서
하향합니다. 남은 위험은 CEF와 external Chrome의 정반대 tradeoff(frame pacing vs browser
fidelity)를 어떻게 선택하거나 조합하느냐입니다.

| Engine | frame pacing (검증 1) | browser fidelity (검증 8) | 유지 비용 |
|---|---|---|---|
| CEF OSR | Tier 1 가능 | **부족** (WebGL/hw video decode 영향) | 낮음 |
| **external Chrome + CDP (new headless)** | full-frame 상한 | **충분** | 낮음 |
| custom Chromium shell (최후 hybrid) | GPU fast path 가능 | 충분 | 매우 높음 |

즉 검증 1과 검증 8이 **서로 다른 engine을 가리킵니다.** CEF는 frame pacing이 좋지만 browser
fidelity가 부족하고, external Chrome은 browser fidelity가 좋지만 frame pacing 상한이 낮습니다.
이 tradeoff를 해결하는 게 S1의 본질이며, 가능한 결과는:

- **CEF로 release + browser fidelity 제약 명시 감수**: WebGL/hw video decode가 TWeb 사용 사례에
  필수 아니면.
- **external Chrome로 release + frame pacing 상한 감수**: full-frame screenshot이 60fps에 못
  미쳐도 대부분 page가 정적이거나 저프레임 허용되면.
- **hybrid(CEF Tier 1 + external Chrome per-page routing)**: 일반 page는 CEF, 미디어 heavy
  page는 external Chrome. 두 engine 동시 운영 복잡도.
- **최후 hybrid: custom Chromium shell**: 위 셋 다 안 될 때만. 유지 비용 매우 큼.

### 8.4 권장사항

- **browser fidelity(검증 8)는 external Chrome(new headless)으로 측정하세요.** CEF의 accelerated
  compositing 미지원은 OSR 한계이므로, WebGL/hw video decode가 필요하면 external Chrome 경로가
  해결책입니다. custom Chromium shell은 browser fidelity를 위해 필요하지 않습니다.
- **S1에서 CEF와 external Chrome의 tradeoff를 판정하세요.** 검증 1(frame pacing)과 검증 8(browser
  fidelity)을 각 engine에서 측정하고, TWeb 사용 사례에 맞는 선택 또는 hybrid를 결정합니다.
- **WebGL/canvas/hw video decode/WebRTC/audio를 browser fidelity conformance 항목으로 명시하세요.**
  각 항목을 engine별로 측정하고, 기성 Chrome 대비 결손을 문서에 숨기지 않습니다(섹션 7.3 정책
  확장).
- **audio routing을 pane 단위로 설계하세요.** pane마다 mute/volume/routing을 browser process가
  제어하고, system audio device가 없는 환경(headless server, remote)에서는 audio를 생략하거나
  별도 sink로 routing하는 정책을 둡니다.
- **new headless Chrome(Chrome 132+)을 external Chrome 경로의 전제로 명시하세요.** old headless
  shell은 WebAPI 결손이 있으므로 사용하지 않습니다.
- **입력 처리(섹션 3)와 미디어를 통합 검증하세요.** 한글 IME composition(Tier 3 side channel)과
  audio/video/WebRTC가 같은 pane에서 동시에 동작해야 합니다. 입력 경로가 미디어 pipeline을
  방해하지 않는지 확인합니다.

### 8.5 상세 설계 보강: browser fidelity conformance 항목

```text
WebAPI/미디어 conformance (engine별 측정, 기성 Chrome 대비)

Rendering
├── WebGL 1/2 — hardware accelerated, software fallback 성능
├── Canvas 2D — 정상 동작
├── 3D CSS transform — GPU 가속 여부
└── WebGPU (향후) — 지원 여부

Media
├── H.264/AV1/VP9 video decode — hardware vs software
├── Audio playback — system audio routing, pane별 mute/volume
├── Autoplay policy — Chromium 기본 존중
├── WebRTC — camera/mic 접근, getDisplayMedia
├── Media Session API — media key, metadata
└── WebCodecs — encode/decode 지원

Input (검증 3과 통합)
├── 한글 IME composition (Tier 3 side channel)
├── clipboard (OSC 52 / browser selection)
├── drag-and-drop file
├── WebAuthn / credential
└── gamepad / sensors (선택)

Identity/security
├── Service Worker / PWA
├── Cookie / storage / partitioned cookie
├── Content Security Policy
└── Permissions API (camera/mic/notification)
```

각 항목을 "기성 Chrome과 동일 동작 / 제약 있음 / 미지원"으로 분류하고, 제약·미지원을 사용자에게
명시합니다(섹션 7.3 정책 확장).

## 9. 선례 프로젝트 분석 요약

### awrit (archived 2026-04-25)

- "I no longer have time to maintain my hobby projects and with the rising number of security
  issues" — security update 부담이 유지 중단의 직접 사유입니다.
- 이는 DESIGN.md 목표 11 "Chromium security update를 지속적으로 빠르게 반영"이 단순한
  비기능 요구가 아니라 survival 조건임을 시사합니다.
- awrit의 `NativeImage.toBitmap()` CPU 경로, dirty rectangle 미사용, `shm_open`/`ftruncate`/`mmap`
  반복은 DESIGN.md 섹션 7.1이 이미 진단한 병목과 일치합니다.
- 후속으로 제안된 cmux는 awrit fork가 아니라 libghostty + WebKit 기반 별도 macOS 앱입니다.
  Chromium 기반 terminal browser의 후속이 아니므로, TWeb의 참고 모델에서는 제외합니다.

### cliweb (awrit fork)

- 동일 머신 전제(shared memory), Electron 기반, `cliwebctl` authenticated Unix socket, semantic
  refs(`d1-n13`), human/agent shared control을 이미 구현했습니다.
- DESIGN.md가 채택하는 부분(tmux pane discovery, persistent profile, semantic refs, shared
  control)과 교체하는 부분(passthrough visibility hook을 정상 경로로 간주, same-machine
  결합)이 조사로 확인됐습니다.
- star 1, fork 0 — niche tool이지만 architecture 참고 가치가 있습니다.

### casty

- raw CDP over WebSocket(~1200 JS lines), Playwright/Puppeteer 미사용, low-res screencast +
  hi-res capture 혼합, adaptive JPEG/PNG, `CSI 14t` pixel size, DPR 반영.
- `Runtime.enable`을 끄는 것으로 Google login이 동작한다는 발견은 CDP 설정 민감도를 보여줍니다.
- DESIGN.md가 채택하는 부분(최소 CDP domain, terminal pixel query, 저해상도 변화 감지 signal,
  image ID 고정 dedup)과 교체하는 부분(full-frame JPEG/PNG, ~20fps, base64, inline chunk,
  `--no-sandbox`, stealth script)이 확인됐습니다.

### iced-cef (참고용, early-stage)

- Rust GUI framework `iced`에 CEF OSR을 통합하려는 standalone crate. TWeb의 Rust core + CEF
  방향과 같은 궤적입니다.
- **상태**: architecture scaffolding only (5 commits, 0 stars). CEF adapter 미구현, input adapter
  roadmap, rendering은 zero-copy(DMA-BUF/wgpu) + CPU fallback 구상. Linux Wayland only, macOS
  미지원, IME 미언급.
- 참고 가치: Rust + CEF OSR + zero-copy GPU path 조합을 검증 중인 사례로, TWeb의 구현 방향이
  단독 시도가 아님을 확인합니다. 단, macOS 한글 IME나 tmux 통합은 다루지 않아 TWeb이 직접
  해결해야 합니다.

### Orca (가장 비슷한 목표, **Electron + embedded Chromium**)

- **기술 스택 확인**: `electron.vite.config.ts` 존재, pnpm, TypeScript/React, `Cargo.toml` 없음 →
  **Electron + TypeScript/React**. "real Chromium window" = Electron이 embed한 Chromium.
  33,952 stars, 7,652 commits, cross-platform(macOS/Windows/Linux) + mobile.
- "real Chromium window — address bar, history, devtools — embedded in a pane." per-worktree마다
  embedded Chromium instance. tabs/scroll position이 worktree에 scoped.
- agent는 CLI `orca snapshot/click/fill`로 같은 browser를 공유. "same browser you interact with,
  same tabs" — 별도 headless session이 아님. TWeb 섹션 12와 동일한 shared-control 모델.
- Design Mode: element 클릭 시 HTML/CSS/cropped screenshot/source map을 agent에 attachment.
  TWeb 섹션 12.7 ElementContextBundle과 동일.
- Cookie import: Chrome/Edge에서 one-click. viewport emulation via CDP device emulation.
- **engine 결정**: **Electron**(embedded Chromium). CEF가 아닌 Electron으로 extension·fidelity·
  agent를 모두 확보. 선례 6개 중 CEF를 쓴 곳이 없으며, Orca는 그 중 가장 비슷한 목표를 Electron으로
  달성.
- **TWeb 딜레마**: Orca가 Electron으로 TWeb과 같은 기능을 이미 달성했으므로, TWeb의 존재 이유 중
  하나가 약해집니다. TWeb이 Rust core + custom embed로 더 가벼운 runtime을 만들려면, Orca(Electron)
  대비 **실질적 이점(memory·성능·terminal-native rendering)**을 증명해야 합니다. 그렇지 않으면
  "그냥 Orca 쓰면 되지"가 됩니다. 동시에 Orca가 Electron이라는 건 **embedded Chromium 경로가
  실제로 동작**한다는 강한 증거이며, TWeb이 Electron을 피하면서 embedded Chromium의 이점을 취하려면
  **custom Chromium shell**이 Orca 대안이 됩니다. 이게 custom Chromium shell의 근거가 S1에서 다시
  살아나는 지점입니다.

### cmux (macOS native, WebKit + libghostty)

- native macOS app(Swift/AppKit). libghostty로 terminal rendering을 GPU 가속. browser는
  WebKit(macOS native). agent-browser(Vercel Labs)의 scriptable API를 port.
- Cookie/session import: Chrome, Firefox, Arc, 20+ browsers에서.
- **engine 결정**: Chromium이 아닌 **WebKit**. macOS native IME를 자연스럽게 확보(한글 입력
  문제 우회). 단, Chrome extension 호환이 아니라 Safari extension 수준. cross-platform 아님
  (macOS only).
- 참고 가치: **한글 IME를 native로 확보하려면 platform native engine이 유리**하다는 시사점.
  TWeb이 cross-platform을 목표로 하면 cmux 경로는 직접 참고가 안 되지만, IME 측면에서
  WebKit/native 경로의 장점을 보여줌.

### agent-browser (external Chrome + CDP, cmux가 port한 소스)

- Vercel Labs의 browser automation CLI. **Chrome for Testing + CDP**. "No Playwright or Node.js
  required for the daemon." Rust CLI + Rust daemon, direct CDP.
- extension 지원: `--extension <path>`. plugin system(stdio JSON protocol, credential.read/
  browser.provider/launch.mutate/command.run capability).
- **engine 결정**: external Chrome + CDP. extension·fidelity 확보, 단 frame pacing 상한(screenshot
  기반).
- 참고 가치: external Chrome 경로가 extension·agent automation을 어떻게 달성하는지 실례.
  cmux가 이를 port한 것도 external Chrome 방향의 유효성을 뒷받침.

### engine 결정 비교 종합

| 프로젝트 | engine | extension | 입력/IME | agent 통합 | TWeb 참고 |
|---|---|---|---|---|---|
| Orca | **Electron** (embedded Chromium) | 지원(실제 Chromium) | native (embedded window) | CLI snapshot/click/fill, shared browser | **가장 비슷, Electron으로 달성** |
| cmux | WebKit (macOS native) | Safari extension 수준 | native (macOS) | scriptable API | macOS IME 우위, cross-platform 아님 |
| agent-browser | external Chrome + CDP | `--extension` 지원 | CDP Input | Rust daemon, direct CDP | external Chrome 실례 |
| awrit (archived) | Electron | Electron subset | Electron input | 없음 | 빠른 prototype, GPU fast path 안 씀 |
| cliweb (awrit fork) | Electron | Electron subset | Electron input | cliwebctl | 빠른 prototype |
| casty | external Chrome + CDP | `--disable-extensions` (끔) | CDP Input | raw CDP | SSH/headless, extension 포기 |

**핵심 패턴**:
1. **아무도 CEF를 쓰지 않았다** — CEF의 extension/accelerated compositing 한계가 실제로 알려진
   제약이라는 강한 신호.
2. **Orca(가장 비슷한 목표)가 Electron을 썼다** — embedded Chromium으로 extension·fidelity·agent를
   모두 확보. 34k stars로 시장 검증. 단, DESIGN.md가 "Electron core 부적합"이라 한 것과 충돌.
3. **external Chrome + CDP는 agent-browser/casty가 증명** — extension 지원도 가능.
4. **WebKit은 macOS native IME에 유리**하지만 cross-platform 아님.

### TWeb 존재 이유와 engine 선택의 얽힘

Orca가 Electron으로 TWeb과 같은 기능을 이미 달성한 상태에서, TWeb의 engine 선택은 **존재 이유**와
결합됩니다:

- **TWeb이 Electron을 쓰면**: Orca와 같은 engine, 같은 기능. TWeb의 차별점은 **tmux pane-native**
  (Orca는 tmux 밖의 standalone app)과 **terminal graphics rendering**(Kitty/Ghostty 통합)뿐. engine
  자체로는 Orca 대비 이점 없음.
- **TWeb이 external Chrome + CDP를 쓰면**: Orca보다 가벼운 runtime(Chrome process 공유), 단
  frame pacing 상한 + 한글 IME 약세.
- **TWeb이 custom Chromium shell을 쓰면**: Orka(Electron) 대비 memory·성능 이점 가능, 단 유지
  비용 매우 큼. **이게 TWeb이 Electron을 피하면서 embedded Chromium 이점을 취하는 유일한 경로**.
- **TWeb이 CEF를 쓰면**: extension 불가 → DESIGN.md 섹션 10 포기. 선례이 없음.

즉, **TWeb이 Orca와 차별되려면(단순 "tmux 안의 Orca" 이상이 되려면), engine 선택이 핵심**이며,
custom Chromium shell이 Orca 대비 실질적 이점을 줄 수 있는 유일한 경로입니다. 단, 유지 비용이
매우 크므로 이 이점이 비용을 정당화하는지가 S1/S2의 본질적 질문입니다.

## 10. 전체 권장사항

1. **S1에서 CEF OSR과 external Chrome(new headless)을 4차원(frame pacing·한글 IME·extension·browser
   fidelity)에서 비교하세요.** 특히 CEF는 extension이 사실상 불가(#4011/#4187)하므로, DESIGN.md
   섹션 10을 제품 핵심으로 유지하면 external Chrome이 사실상 유일한 engine입니다. CEF는 섹션 10을
   비목표로 내릴 때만 후보. custom Chromium shell은 셋 다 안 될 때의 최후 hybrid로만 둡니다.
2. **DESIGN.md 섹션 10(extension/profile bootstrap)의 제품 핵심 여부를 먼저 결정하세요.** 이게
   engine 선택의 선행 결정입니다. 유지하면 external Chrome, 비목표/우회하면 CEF도 후보.
3. **Tier 1 damage-aware Kitty path를 첫 검증 대상으로 하세요.** CEF OSR의 CPU bitmap + dirty
   rect, external Chrome의 screenshot 두 경로로 구현 가능하며, Electron은 이 단계에서 불필요합니다.
   DESIGN.md 섹션 6.4의 "Electron을 제품 core로 채택하지 않는다" 결정을 유지합니다.
4. **한글 입력을 두 단계로 설계하세요.** Tier 1은 committed text, Tier 3는 side channel로
   composition 중간 상태 실시간 표시. Ghostty가 macOS IME composition을 native 처리하므로,
   DESIGN.md 섹션 7.2 side channel을 입력 composition event용으로 확장하면 됩니다. 단, external
   Chrome은 CDP Input이 native IME가 아니라 한글 composition 경로가 약세임을 S1에서 검증하세요.
5. **`NativeSurfaceTransport`가 PTY 입력 한계를 해결하지 않는 점은 명시하되, side channel
   확장이 별개의 입력 경로 해결책임을 같이 명시하세요.** rendering fallback과 입력 해결을
   구분합니다.
6. **Chrome Profile Bridge를 Rust Native Messaging host + extension 조합으로 구현하세요.**
   profile DB 직접 접근 금지 정책과 일관됩니다. Profile Bridge extension은 사용자의 일반
   Chrome에서 실행되므로 engine 무관임을 명시하세요.
7. **agent/human lease를 명시적 상태 기계(`IDLE`/`HUMAN`/`AGENT`/`CONTENDED`)로 설계하세요.**
   `CONTENDED`에서 last-write-wins를 쓰지 않는 정책과 일관됩니다.
8. **remote transport를 검증 1~3, 4/5, 8 통과 뒤의 확장 영역으로 다루세요.** 섹션 17 순서를
   유지합니다.
9. **Chromium security update 대응 체계를 제품 survival 조건으로 취급하세요.** awrit의 유지 중단
   사유가 이를 시사합니다. 단, CEF와 external Chrome은 prebuilt/배포 binary로 이 부담이
   작으며, custom Chromium shell을 쓸 때만 부담이 최대가 됩니다.
10. **tmux PR #5274(grid-resident Kitty image) merge를 적극 추적하고 기여하세요.** merge되면
    DESIGN.md 섹션 7.4의 baseline compatibility cost 대부분이 사라지며, enhanced tmux branch가
    선택 tier에서 기본 경로 후보로 승격됩니다. late-attach 한계는 TWeb reconcile(섹션 8)로
    보완합니다.
11. **browser fidelity(검증 8)는 external Chrome(new headless)으로 측정하세요.** CEF의 accelerated
    compositing 미지원은 OSR 한계이므로, WebGL/hw video decode가 필요하면 external Chrome 경로가
    해결책입니다. WebGL/canvas/WebRTC/audio를 conformance 항목으로 측정하고, 제약·미지원을
    사용자에게 숨기지 않습니다.
12. **audio routing을 pane 단위로 설계하세요.** pane마다 mute/volume/routing을 browser process가
    제어하고, system audio device가 없는 환경에서는 생략 또는 별도 sink로 routing합니다.
13. **new headless Chrome(Chrome 132+)을 external Chrome 경로의 전제로 명시하세요.** old headless
    shell은 WebAPI 결손이 있으므로 사용하지 않습니다. new headless의 extension loading 방식
    (`--load-extension`, profile 지속성)을 S1에서 검증하세요.

## 참고 자료

- Electron offscreen rendering — https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering
- Electron SharedTexture — https://www.electronjs.org/docs/latest/api/shared-texture
- Kitty graphics protocol — https://sw.kovidgoyal.net/kitty/graphics-protocol/
- tmux manual — https://man.openbsd.org/tmux
- CEF General Usage (OSR) — https://chromiumembedded.github.io/cef/general_usage
- awrit — https://github.com/chase/awrit (archived 2026-04-25)
- cliweb — https://github.com/atomashevic/cliweb
- casty — https://github.com/sanohiro/casty
- cmux — https://github.com/manaflow-ai/cmux
- Ghostty — https://github.com/ghostty-org/ghostty
- Chrome Native Messaging — https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
- Chrome DevTools Protocol — https://chromedevtools.github.io/devtools-protocol/
- Page.startScreencast — https://chromedevtools.github.io/devtools-protocol/tot/Page/
- iced-cef — https://github.com/bnema/iced-cef
- Ghostty Korean IME issue #11461 — https://github.com/ghostty-org/ghostty/issues/11461
- tmux PR #5274 (grid-resident Kitty image) — https://github.com/tmux/tmux/pull/5274
- tmux issue #4302 (passthrough control mode) — https://github.com/tmux/tmux/issues/4302
- Chrome headless (new headless, Chrome 132+) — https://developer.chrome.com/docs/chromium/headless
- Chromium media pipeline — https://www.chromium.org/developers/design-documents/video/
- CEF issue #4011 (extension tab API OSR not planned) — https://github.com/chromiumembedded/cef/issues/4011
- CEF PR #4187 (Extensions API abandoned) — https://github.com/chromiumembedded/cef/pull/4187
- Electron extensions support — https://www.electronjs.org/docs/latest/api/extensions
- Orca per-worktree browser — https://www.onorca.dev/docs/browser/overview
- Orca Design Mode — https://www.onorca.dev/docs/browser/design-mode
- agent-browser (Vercel Labs) — https://github.com/vercel-labs/agent-browser
