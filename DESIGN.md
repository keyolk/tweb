# TWeb Browser Runtime 설계

## 1. 문제 정의

Ghostty와 tmux를 그대로 사용하면서 tmux pane 안에서 실제 Chromium browser를 사용할 수 있어야 한다.
Browser는 단순 preview image가 아니라 사람이 직접 조작하고 agent가 같은 page를 자동화할 수 있는
persistent runtime이어야 한다.

핵심 사용 경험은 다음과 같다.

```text
Ghostty
└── tmux session: project-a
    ├── window @1: agent workflow
    │   ├── pane %1: shell / agent
    │   ├── pane %2: dev server
    │   └── pane %3: browser page
    └── window @2: another workflow
        ├── pane %4: agent
        └── pane %5: browser page
```

`awrit`이 증명한 terminal graphics 모델과 `cliweb`이 확장한 tmux·agent shared-control 모델을
기반으로 하되, 다음 문제를 처음부터 해결한다.

- tmux/Ghostty를 compatibility hack이 아닌 first-class target으로 지원
- shortcut ownership을 명시적인 Browser mode로 분리
- full-frame CPU copy를 피하는 damage-aware rendering
- browser process/profile을 pane frontend와 분리해 여러 pane이 공유
- Google Chrome profile의 extension·일반 browsing state를 안전하고 쉽게 가져오기
- enterprise-managed Chrome이 필요한 Okta/Device Trust URL은 실제 Chrome으로 handoff
- 향후 remote transport와 native GPU presentation을 추가할 수 있는 구조

## 2. 목표

1. Browser page 하나를 tmux pane 하나로 취급한다.
2. `split-window`, `resize-pane`, `swap-pane`, `join-pane`, `break-pane`, `kill-pane`, zoom이
   browser에도 그대로 적용된다.
3. Browser pane resize가 Chromium viewport와 CSS reflow에 즉시 반영된다.
4. 사람과 agent가 동일한 page/profile을 공유하되 control 권한은 명시적으로 관리한다.
5. tmux shortcut과 browser shortcut은 mode로 완전히 분리한다.
6. 같은 tmux session의 browser page는 기본적으로 cookie와 site data를 공유한다.
7. Chrome profile bootstrap을 제품 핵심 기능으로 제공한다.
8. Cookie 값이나 credential이 CLI, log, tmux option에 노출되지 않는다.
9. Renderer와 profile provider를 분리해 Ghostty, Kitty, remote, native presentation으로 확장한다.
10. Browser에서 생성·관찰한 resource를 같은 tmux window의 agent에 typed attachment로 전달하고,
    다른 pane/window/host에는 명시적 scope와 capability로 전달한다.
11. Browser/Chromium security update를 지속적으로 빠르게 반영할 수 있어야 한다.

## 3. 비목표

- Google Chrome을 User-Agent spoofing으로 흉내 내지 않는다.
- 실행 중인 Chrome profile directory를 Chromium과 동시에 공유하지 않는다.
- Okta session cookie를 자동·상시 복제하지 않는다.
- tmux와 별도의 pane/layout tree를 만들지 않는다.
- 첫 구조를 Electron 또는 특정 terminal 구현에 영구 결합하지 않는다.
- Terminal graphics가 표현할 수 없는 browser chrome 전체를 억지로 재현한다고 약속하지 않는다.
- Agent에게 managed Chrome profile 전체에 대한 무제한 automation 권한을 주지 않는다.

## 4. 핵심 불변식

```text
Browser page identity     = BrowserPageID
Browser page placement    = tmux pane ID
Browser profile 기본 범위 = tmux server + session ID
Agent workflow 기본 범위  = tmux window ID
Resource 기본 범위        = tmux window ID
Layout authority          = tmux
Input authority           = tmux mode 또는 Browser mode 중 하나
```

Browser runtime과 presentation은 독립적이다.

```text
BrowserRuntime
├── EmbeddedChromiumRuntime
├── RemoteChromiumRuntime
└── ManagedChromeExternalRuntime

FrameTransport
├── KittyGraphicsTransport
├── NativeSurfaceTransport
└── RemoteVideoTransport
```

### 4.1 이름과 command contract

```text
제품명                 TWeb
공식 executable        tweb
선택적 짧은 alias      twb
runtime daemon         twebd
Chrome extension       TWeb Profile Bridge
resource URI scheme    tweb://
tmux key table         tweb-browser
```

`TWeb`은 사람이 읽는 제품명이고 `tweb`은 script와 shell에서 사용하는 안정된 명령이다. `twb`는
`tweb`의 symlink/alias일 뿐 별도 command나 config namespace를 만들지 않는다. 문서와 오류 메시지는
항상 `tweb`을 canonical command로 출력한다.

Unscoped npm의 `tweb`은 이미 reserved package이고 `twb`도 다른 package가 사용한다. 배포 package는
`@keyolk/tweb`처럼 organization scope를 사용하고, 설치된 executable만 `tweb`/`twb`로 제공한다.
GitHub에도 기존 `tweb` 이름의 unrelated project가 있으므로 repository identity는 organization을 포함한
`keyolk/tweb`을 canonical URL로 사용한다.

`tweb`은 하나의 multi-call executable이다. Subcommand가 항상 동작보다 먼저 오고 target selector는 뒤에
둔다(`tweb snapshot --pane %3`). 전역 selector와 subcommand별 selector가 섞인 두 문법을 동시에
지원하지 않는다.

```text
tweb open [URL]             현재 terminal/pane에서 browser frontend 실행
tweb split [URL]            현재 tmux window에 browser pane 생성
tweb navigate URL           resolve된 browser page 이동
tweb snapshot --pane %3     browser page 제어
tweb resource ...           resource 조회·전달·materialize
tweb profile ...            profile bootstrap·관리
tweb chrome ...             managed Chrome handoff·bridge 관리
tweb doctor                 terminal/tmux/GPU/extension capability 진단
```

Pane frontend의 내부 invocation은 사용자-facing contract와 분리한다.

```text
tweb __pane --page <opaque-id>
```

`__pane`은 tmux가 실행하는 internal subcommand이며 문서화된 automation API가 아니다. 같은 binary를
사용하므로 별도 `tweb-browser` 설치·version skew가 생기지 않는다.

`TWEB_CONFIG_HOME`, `TWEB_DATA_HOME`, `TWEB_RUNTIME_DIR`로 경로를 override할 수 있다. 기본값은
platform convention을 따른다.

```text
Linux config   $XDG_CONFIG_HOME/tweb
Linux data     $XDG_DATA_HOME/tweb
Linux runtime  $XDG_RUNTIME_DIR/tweb
macOS config   ~/Library/Application Support/TWeb
macOS data     ~/Library/Application Support/TWeb
macOS runtime  $TMPDIR/tweb-$UID (0700)
```

Runtime socket과 GPU handle broker는 runtime directory 밖에 만들지 않는다. Profile, resource object,
cache는 각각 별도 하위 directory와 quota를 가진다.

## 5. 프로세스 구조

```text
Host
├── tmux server
│   └── pane %3
│       └── tweb __pane
│           ├── terminal capability negotiation
│           ├── keyboard/mouse decoding
│           ├── SIGWINCH handling
│           └── frame transport frontend
│
├── twebd
│   ├── Chromium process manager
│   ├── ProfileManager
│   ├── PageRegistry
│   ├── FrameProducer
│   ├── ResourceBroker
│   ├── AutomationController
│   └── authenticated local IPC
│
├── tweb CLI (short-lived)
│   ├── tmux/browser lifecycle
│   ├── agent automation
│   ├── resource exchange
│   └── profile bootstrap
│
└── Google Chrome
    └── optional tweb Profile Bridge extension
```

### 5.1 `twebd`

Host당 하나의 daemon을 기본으로 한다. Pane마다 Electron 전체 runtime을 띄우지 않는다.

책임:

- Chromium browser process와 crash recovery
- session별 persistent profile/context
- page 생성·종료·navigation·history
- extension lifecycle
- frame generation과 backpressure
- semantic accessibility/DOM snapshot
- agent action 직렬화
- human/agent control lease
- profile import/export policy

Daemon socket은 사용자 전용 runtime directory에 두고 peer credential을 확인한다. 요청에는 opaque
ID만 사용하고 cookie/token 값을 반환하는 API는 만들지 않는다.

### 5.2 `tweb __pane` frontend

각 tmux browser pane의 실제 foreground process다.

책임:

- `$TMUX`, `$TMUX_PANE`을 이용해 pane identity 등록
- tmux server/session/window/pane stable ID 수집
- terminal Kitty graphics·keyboard·mouse capability 탐지
- raw terminal mode 관리 및 종료 시 원복
- `SIGWINCH`를 pixel viewport resize로 변환
- browserd page에 attach하고 frame 표시
- keyboard/mouse를 browserd로 전달
- pane visibility/focus lifecycle 전달
- terminal이 graphics를 지원하지 않을 때 text fallback 표시

### 5.3 `tweb` CLI

예시:

```sh
tweb open https://localhost:5173
tweb split -h https://example.com
tweb status --pane %3
tweb snapshot --pane %3
tweb click --pane %3 --ref d1-n13
tweb fill --pane %3 --ref d1-n18 --value hello
tweb profile bootstrap chrome
```

Agent가 pane을 생략하면 자신의 `$TMUX_PANE`에서 같은 tmux window의 primary browser를 찾는다.
여러 후보가 있으면 임의 선택하지 않고 명시적 target을 요구한다.

## 6. Browser runtime

### 6.1 Engine 선택

첫 구현 계열은 Chromium을 사용한다. Electron은 `awrit`/`cliweb`과 extension tooling을 빠르게
재사용할 수 있지만 domain API가 Electron에 종속돼서는 안 된다.

```text
BrowserEngineAdapter
├── ElectronChromiumAdapter
└── ChromiumShellAdapter
```

장기 판단 기준:

- Chrome Extension API compatibility
- offscreen GPU shared texture 지원
- security update cadence
- process sandbox
- IME·clipboard·WebAuthn 지원
- custom browser chrome 구현 비용

Electron을 사용한다면 CPU `NativeImage.toBitmap()` 경로를 기본 renderer로 쓰지 않고
`offscreen.useSharedTexture`를 우선 검증한다. 사용 버전은 알려진 shared-texture 보안 수정이 포함된
release 이상으로 고정한다.

### 6.2 Profile 모델

```text
BrowserProfile
├── id
├── displayName
├── storageRoot
├── source
│   ├── fresh
│   ├── chrome-bootstrap
│   └── imported-bundle
├── extensionSet
├── routingPolicy
└── auditMetadata
```

기본 profile key는 다음을 조합한다.

```text
hash(tmux server identity, tmux session ID)
```

Session rename이나 window reorder로 profile identity가 바뀌지 않아야 한다.

### 6.3 구현 언어

TWeb의 주 구현 언어는 **Rust**로 한다. Memory 효율을 위해 Rust를 선택하지만, 더 큰 효과는
Electron/Node/V8를 daemon과 pane frontend에서 제거하고 buffer ownership을 명시적으로 통제하는 데서
얻는다.

```text
Rust
├── tweb CLI
├── tweb __pane frontend
├── twebd orchestration
├── tmux/terminal protocol
├── CDP/control protocol
├── ProfileManager
├── ResourceBroker
├── AgentBridge
├── frame scheduling/backpressure
└── remote transport

C++
├── CEF/Chromium embedding adapter
├── Chromium GPU surface export
└── extension/browser host integration

Rust platform modules
├── macOS IOSurface/Mach/XPC/Metal synchronization
├── Linux DMA-BUF/Unix descriptor passing
├── Windows DXGI/shared handle/named pipe
└── platform credential store와 Chrome Native Messaging host

Objective-C++/C++ platform shim
└── Rust crate가 직접 표현할 수 없는 좁은 OS/browser ABI만 담당

Zig
└── 선택적 TWeb-enhanced Ghostty fork와 표준 Kitty protocol upstream 기여

TypeScript
└── TWeb Profile Bridge Chrome extension
```

언어 경계는 process 또는 좁은 C ABI로 제한한다. Rust와 Zig가 동일한 domain logic을 나눠 갖거나 동일
object lifetime을 공동 소유하게 만들지 않는다.

#### Rust를 core로 선택하는 이유

- Ownership/RAII가 frame, shared-memory mapping, GPU handle, resource lease의 회수를 강제하기 좋다.
- Daemon의 async IPC, multi-client backpressure, encrypted remote transport 생태계가 성숙하다.
- Terminal parser와 untrusted protocol에 memory-safe default를 제공한다.
- SQLite/object store, serialization, observability, fuzzing 도구가 충분하다.
- macOS/Linux/향후 Windows를 같은 core로 지원하기 쉽다.
- `tweb`, `twebd`를 Node/V8 runtime 없이 작은 native executable로 배포할 수 있다.

Rust라고 자동으로 memory 효율이 좋아지는 것은 아니다. 무제한 `Arc`, clone, channel, `Vec<u8>`, JSON
materialization을 허용하면 Zig/C++보다 더 많은 memory를 쓸 수 있다. 다음 규칙을 적용한다.

- Frame payload를 Rust heap `Vec<u8>`로 복사하지 않고 borrowed/native handle로 전달한다.
- Bounded channel만 사용하고 queue capacity를 protocol contract에 포함한다.
- Resource body는 stream/file descriptor로 전달하고 전체 body를 memory에 올리지 않는다.
- Metadata JSON은 control plane에만 사용하고 frame/input hot path는 binary protocol을 사용한다.
- `Bytes`/slice와 scatter-gather I/O를 사용하고 불필요한 `String` 변환을 금지한다.
- Task마다 독립 buffer를 만들지 않고 profile/page별 bounded pool을 사용한다.
- Release build는 `panic = "abort"`, LTO 여부를 측정해 결정하고 debug allocator를 production에 넣지 않는다.
- Global allocator 교체는 실제 fragmentation profile을 얻은 뒤 결정한다.

#### Zig를 core로 선택하지 않는 이유

Zig의 explicit allocator, 작은 runtime, C interop은 매력적이다. 그러나 TWeb core의 난점은 단순 buffer
변환보다 장수 daemon의 concurrency, cancellation, IPC, remote transport, resource capability와 crash
recovery다. 이 영역에서는 Rust의 type/ownership/concurrency 생태계가 memory safety와 개발 안정성 면에서
유리하다.

Zig는 다음 범위에서 더 적합하다.

- 선택적 TWeb-enhanced Ghostty fork의 renderer와 local-surface protocol
- 표준 Kitty animation/composition 지원의 Ghostty upstream 기여
- ABI가 작은 image/surface conversion helper
- 독립 benchmark/probe

Core를 Rust와 Zig 두 언어로 반반 나누면 allocator ownership, async runtime, build, debugging이 복잡해져
절감한 memory보다 유지보수 비용이 커진다.

### 6.4 Chromium adapter 선택

Memory 효율을 우선하면 Electron을 제품 core로 채택하지 않는다.

```text
우선 검증
    Rust twebd + CEF/custom Chromium adapter

비교 baseline
    Electron offscreen shared texture adapter

호환 fallback
    external Chrome/CDP screenshot adapter
```

CEF/custom Chromium adapter의 목표:

- Node/V8 main process 제거
- Browser process 하나가 session/profile context와 여러 page를 관리
- Page마다 별도 Electron `BrowserWindow` 대신 Chromium page/WebContents만 생성
- GPU surface를 CPU bitmap으로 변환하지 않고 export
- Chromium sandbox와 process isolation 유지
- extension API는 capability registry로 검증

CEF가 필요한 extension API나 GPU handle export를 제공하지 못하면 narrow patch를 유지한 custom Chromium
shell adapter로 교체한다. 이 변경은 `BrowserEngineAdapter` 뒤에서 일어나며 profile/page/resource API를
바꾸지 않는다.

### 6.5 Memory ownership과 budget

Memory budget은 `RSS` 하나로 판단하지 않는다. Chromium shared library와 shared GPU resource 때문에
process별 RSS 합은 실제 physical memory를 과장할 수 있다. 최소한 다음을 분리해 측정한다.

```text
private dirty / PSS
shared code pages
Chromium JS/DOM heap
GPU process memory
IOSurface/DMA-BUF bytes
Kitty SHM ring bytes
terminal texture bytes
ResourceBroker object/cache bytes
```

Frame memory는 다음 공식으로 예측한다.

```text
surface bytes = width × height × 4 × surface count
```

예:

```text
1920×1080 RGBA
  1 surface  ≈ 7.9 MiB
  2 surfaces ≈ 15.8 MiB
  3 surfaces ≈ 23.7 MiB

3840×2160 RGBA
  1 surface  ≈ 31.6 MiB
  2 surfaces ≈ 63.3 MiB
  3 surfaces ≈ 94.9 MiB
```

따라서 무조건 triple buffering하지 않는다.

- GPU fast path는 기본 2-surface mailbox를 사용하고 measured stall이 있을 때만 3개로 확장한다.
- Enhanced Ghostty path에서는 동일 IOSurface를 직접 import해 producer와 consumer pixel memory를 중복 생성하지 않게 한다.
- Vanilla Ghostty/Kitty path에서는 SHM ring과 terminal texture가 중복되므로 visible page별 budget을 더 낮게 둔다.
- Hidden page는 present surface와 SHM tile pool을 해제하고 compressed thumbnail만 선택적으로 남긴다.
- Background page는 Chromium lifecycle state를 frozen/discarded로 전환할 수 있게 한다.
- Resource cache와 browser HTTP cache를 별도 quota로 관리한다.
- Screenshot/PDF/HAR는 memory buffer가 아니라 object store로 stream한다.
- Profile마다 page/renderer process 상한을 두되 active media/WebRTC page는 임의 discard하지 않는다.

초기 budget class:

```text
CoreBudget
    tweb pane frontend private memory
    twebd private memory (Chromium 제외)

VisiblePageBudget
    JS/DOM + renderer private memory
    GPU surfaces
    transport buffers

HiddenPageBudget
    frozen page state
    optional thumbnail

ProfileBudget
    cache/resource/object-store quota
```

구체적 MiB 상한은 기준 hardware에서 CEF/Chromium baseline을 측정한 뒤 확정한다. 다만 다음은 architecture
release gate다.

- `tweb` pane 수에 비례해 browser runtime/Node/V8가 중복되지 않는다.
- Visible page를 추가하지 않은 idle pane frontend는 frame-sized buffer를 소유하지 않는다.
- Hidden page의 GPU/SHM surface byte가 0으로 수렴한다.
- Queue와 resource cache에 hard upper bound가 있다.
- Page close, renderer crash, client detach 후 resource count와 private bytes가 baseline으로 돌아온다.

### 6.6 Platform abstraction

macOS를 첫 구현·성능 기준 플랫폼으로 삼지만, core type과 protocol은 macOS API를 노출하지 않는다.

```text
Platform-neutral Rust core
├── BrowserEngineAdapter
├── SurfaceTransport
├── LocalIpcTransport
├── TerminalCapabilityProvider
├── CredentialStore
├── ProcessSupervisor
├── FileTransferProvider
└── PlatformPaths
```

#### Shared surface

```rust
trait SharedSurface: Send + Sync {
    fn id(&self) -> SurfaceId;
    fn size(&self) -> PixelSize;
    fn format(&self) -> PixelFormat;
    fn color_space(&self) -> ColorSpace;
    fn synchronization(&self) -> SyncPrimitive;
}
```

Platform handle을 wire schema의 공용 integer/pointer로 만들지 않는다.

```text
macOS    IOSurface + Mach port/shared event
Linux    DMA-BUF fd + sync file/explicit fence
Windows  DXGI shared handle + D3D11/D3D12 fence
```

각 handle은 해당 platform adapter 안에서만 해석한다. Remote path에서는 shared surface handle을 보내지 않고
video frame transport로 전환한다.

#### Platform service matrix

| Service | macOS | Linux | Windows |
|---|---|---|---|
| Local IPC | Unix socket/XPC + peer audit | Unix socket + peer credentials | Named pipe + ACL |
| Handle transfer | Mach port/XPC | `SCM_RIGHTS` | `DuplicateHandle`/shared handle |
| GPU surface | IOSurface/Metal | DMA-BUF/Vulkan·EGL | DXGI/D3D11·D3D12 |
| Credential store | Keychain | Secret Service/KWallet | Credential Manager/DPAPI |
| Browser discovery | Chrome app bundle | desktop entry/PATH | registry/App Paths |
| Native messaging | Chrome macOS manifest | Chrome Linux manifest | Chrome registry manifest |
| Runtime supervision | launchd-compatible child | systemd-compatible child | Job Object/service-compatible child |
| Paths | `~/Library/...` | XDG directories | Known Folders/LocalAppData |

#### Terminal/tmux topology

macOS와 Linux에서는 tmux server와 `twebd`가 같은 host에 있는 구성을 기본으로 한다. Windows는 tmux가
native Windows process가 아닐 수 있으므로 실행 위치를 명시적으로 분리한다.

```text
Windows terminal client
├── WSL2 tmux + WSL2 twebd
├── SSH remote tmux + remote twebd
└── Windows-local browser runtime + WSL/remote pane association
```

Core identity에 OS path나 PID만 사용하지 않는다.

```text
HostID + TmuxServerID + SessionID + WindowID + PaneID
```

WSL과 Windows host가 file path를 공유할 수 있다고 가정하지 않는다. ResourceBroker가 Windows path,
WSL path, remote path 사이 materialization과 transfer를 담당한다.

#### 지원 순서와 contract

```text
Primary implementation   macOS + vanilla Ghostty + stock tmux
Second platform          Linux + Ghostty/Kitty + stock tmux
Third platform           Windows client + WSL/SSH tmux
Optional optimized tier  platform별 enhanced terminal adapter
```

Platform별 최적화가 core API에 새 기능 semantics를 만들면 안 된다. 예를 들어 Windows에서 DXGI fast path가
없어도 page/profile/resource/Browser mode는 동일하게 동작하고 frame transport만 fallback해야 한다.

CI는 적어도 다음을 분리한다.

- Platform-neutral Rust unit/property/fuzz tests
- OS별 IPC/handle/path integration tests
- Browser engine adapter conformance tests
- Terminal/tmux 조합별 end-to-end tests
- Cross-host resource transfer tests

## 7. Rendering architecture

TWeb은 vanilla terminal 호환성을 제품 baseline으로 보장하고, enhanced fork는 선택적 performance tier로만
사용한다.

```text
Tier 1 — Vanilla baseline (필수)
    vanilla Ghostty 또는 Kitty
    stock tmux
    표준 Kitty graphics + 필요시 tmux passthrough

Tier 2 — Standards enhanced (선택)
    upstream Ghostty의 Kitty animation/composition 지원
    upstream tmux의 native Kitty image lifecycle 지원

Tier 3 — TWeb enhanced (선택)
    TWeb-enhanced Ghostty fork
    필요시 TWeb-enhanced tmux branch
    local GPU surface fast path
```

Release와 conformance test는 Tier 1에서 통과해야 한다. Tier 3가 설치돼 있지 않거나 negotiation에 실패해도
browser page, profile, agent resource, shortcut 기능이 그대로 동작해야 한다. Tier 차이는 rendering
performance와 일부 visual fidelity뿐이어야 한다.

### 7.1 `awrit` 성능 gap

`awrit`의 병목은 Kitty graphics 자체 하나가 아니라 전체 frame pipeline에 있다.

```text
Chromium GPU compositor
    ↓ GPU → CPU readback
Electron NativeImage
    ↓ toBitmap()
Node Buffer
    ↓ BGRA → RGBA 변환 + copy
POSIX shared memory
    ↓ Kitty graphics transfer
Terminal image cache
    ↓ texture upload/composite
GPU
```

현재 구현에서 확인되는 비용:

1. Paint마다 `NativeImage.toBitmap()`으로 전체 frame을 CPU memory에 만든다.
2. Dirty rectangle을 받지만 renderer가 이를 사용하지 않고 전체 frame을 복사한다.
3. Rust bridge가 paint마다 `shm_open`, `ftruncate`, `mmap`, `munmap`을 반복한다.
4. BGRA→RGBA 변환을 전체 frame에 수행한다.
5. Browser→Node→Rust→shared memory 사이에 중복 memory copy가 있다.
6. Ghostty fallback은 image를 반복 transfer/display해 GPU upload와 placement churn을 만든다.
7. tmux passthrough는 image visibility와 lifetime을 소유하지 않아 repaint, 잔상, cleanup 비용을 만든다.

32-bit 1920×1080 frame은 약 7.9 MiB이고 60fps 전체 복사는 약 475 MiB/s다. Retina
3840×2160은 frame당 약 31.6 MiB, 60fps 약 1.85 GiB/s다. 이는 protocol payload 외에 readback,
색상 변환, shared-memory copy, terminal texture upload가 각각 추가되는 수치다.

따라서 damage tiling만으로는 충분하지 않을 수 있다. Vanilla Ghostty/Kitty용 표준 Kitty 경로를 먼저
최적화하고, 동일한 runtime 위에 선택적인 TWeb-enhanced Ghostty GPU surface fast path를 제공한다.

### 7.2 선택적 TWeb-enhanced Ghostty GPU surface fast path

이 경로는 별도 TWeb-enhanced Ghostty build가 있을 때만 활성화한다. Vanilla Ghostty 지원과 TWeb의
기능 정확성은 이 경로에 의존하지 않는다.

```text
Chromium GPU compositor
    ↓ authenticated local handle transfer
Ghostty renderer
    ↓ direct texture import
Metal / OpenGL texture composition
```

이 경로에서는 pixel을 CPU로 readback하지 않는다. PTY는 pixel payload가 아니라 frame ordering,
placement, visibility, resize generation을 전달한다. 실제 GPU handle은 사용자 전용 local IPC로
전달한다.

개념적인 frame descriptor:

```text
GpuFrameDescriptor
├── pageID
├── frameToken
├── generation
├── size
├── pixelFormat
├── colorSpace
├── damageRects
├── surfaceHandle
└── synchronizationFence
```

macOS 구현:

1. Chromium/Electron offscreen shared texture에서 `IOSurface` backed frame을 받는다.
2. Native bridge가 `IOSurface`를 Mach/XPC로 전달 가능한 handle로 export한다.
3. Ghostty는 handle을 검증하고 `MTLTexture`로 import한다.
4. BGRA/RGBA 차이는 CPU swizzle이 아니라 shader sampling으로 처리한다.
5. Ghostty가 frame을 present하거나 drop한 뒤 release acknowledgement를 보낸다.

Electron의 shared-texture handle은 받은 process에 국한되므로 JavaScript `Buffer`의 pointer 값을 다른
process에 전달해서는 안 된다. Native bridge가 OS의 정식 cross-process resource transfer와 lifetime을
소유해야 한다. 이 API가 안정성·성능 기준을 만족하지 못하면 동일 contract를 직접 제공하는
Chromium shell adapter로 교체한다.

Linux 구현은 DMA-BUF와 explicit synchronization을 사용한다. Import가 불가능한 GPU/driver에서는
표준 Kitty backend로 내린다.

#### Frame lifetime과 backpressure

- Visible page마다 2~3개의 surface를 순환 사용한다.
- Ghostty가 release하기 전에 producer가 surface를 덮어쓰지 않는다.
- Queue가 밀리면 아직 present하지 않은 중간 frame을 버리고 최신 complete frame만 남긴다.
- Damage rect는 rendering clip에 사용하되 surface 내용은 complete frame으로 취급한다.
- Resize마다 generation을 올리고 이전 size/generation frame을 표시하지 않는다.
- Hidden page는 compositor begin-frame을 중지하고 마지막 surface만 유지한다.
- GPU process crash나 handle import 실패 시 page 단위로 Kitty backend로 전환한다.

#### PTY와 side channel의 역할

```text
PTY/tmux
    → pane identity, placement, frame token, focus, visibility, delete

Local GPU channel
    → texture handle, fence, release acknowledgement
```

Vendor extension을 무조건 전송하지 않는다. Browser frontend, tmux, Ghostty가 capability negotiation으로
동일한 local-surface protocol version을 확인한 경우에만 사용한다. 다른 terminal은 알 수 없는 handle을
받지 않고 표준 Kitty frame을 받는다.

### 7.3 기본 local 경로: vanilla Ghostty/Kitty의 damage-aware Kitty graphics

이 경로가 설치와 기능 correctness의 baseline이다. TWeb은 공식 Ghostty release와 stock Kitty에서 별도
fork 없이 실행돼야 한다. Enhanced capability가 없어도 browser resize, input, profile 공유, agent resource
exchange가 모두 동작한다.

```text
Chromium compositor
    ↓ damage metadata
Native frame bridge
    ↓ changed tiles/rectangles
Persistent POSIX shared-memory ring
    ↓ Kitty graphics commands
Ghostty / Kitty
```

GPU fast path를 지원하지 않는 terminal에서도 `awrit`보다 복사량과 syscall을 줄인다.

#### Memory pipeline

- Paint마다 shared memory를 열고 map하지 않는다.
- Page 생성 시 2~3개의 persistent mapped buffer를 preallocate하고 resize 때만 교체한다.
- Browser frame을 JavaScript `Buffer`로 왕복시키지 않고 native bridge에서 destination buffer로 쓴다.
- GPU source인 경우 asynchronous readback을 사용하고 main/UI thread에서 기다리지 않는다.
- 표준 Kitty의 RGBA 요구 때문에 변환이 필요할 때 변경 영역만 SIMD로 변환한다.
- Terminal acknowledgement 전에는 같은 transfer buffer를 재사용하지 않는다.
- Shared-memory name과 image ID를 무한 생성하지 않고 bounded pool에서 재사용한다.

#### Damage와 tile 전략

- Chromium/Electron의 dirty rectangle을 보존한다.
- 화면을 adaptive tile로 나눈다. 기본 후보는 256×256이며 workload에 따라 128~512 범위에서 조정한다.
- Dirty rect와 겹치는 tile만 갱신한다.
- 한 display interval 안의 여러 damage event를 union한다.
- Scroll처럼 변경 면적이 큰 frame은 수백 개의 작은 command 대신 full-frame 또는 큰 stripe로 합친다.
- Static page는 damage가 없으면 frame과 terminal command를 만들지 않는다.
- Text/content update와 animation/video에 서로 다른 frame pacing을 적용한다.
- Output queue가 밀리면 intermediate generation을 버린다.

Tile 크기는 고정된 상수가 아니라 다음 비용의 측정 결과로 선택한다.

```text
작은 tile  → command/image 수와 placement 비용 증가
큰 tile    → 불필요한 pixel copy와 texture upload 증가
```

#### Kitty capability별 전략

```text
load + animation frame + composite
    → base image에 damage frame composite

independent image placement + replace
    → stable tile image ID를 제자리 갱신

basic transfer/display only
    → coalesced full-frame fallback + 낮은 frame cap
```

Capability는 terminal 이름으로 추측하지 않고 graphics query로 판정한다. Basic fallback을 정상 성능
경로로 홍보하지 않으며 UI에 제한 상태를 표시한다.

### 7.4 tmux 지원 tier

#### Stock tmux baseline

Stock tmux에서는 표준 Kitty sequence를 passthrough로 전달한다.

```tmux
set -g mouse on
set -g focus-events on
set -g allow-passthrough all
```

TWeb이 stock tmux에서 직접 책임지는 동작:

- pane 크기와 `SIGWINCH` 기반 viewport
- image ID namespace
- selected window visibility와 repaint reconciliation
- pane 종료 전 deterministic delete
- 비정상 종료 후 stale placement 복구
- Browser mode key table

Stock tmux가 image object를 이해하지 않는 한 visibility hook이나 repaint reconciliation이 필요할 수 있다.
이는 baseline에서 지원해야 하는 compatibility cost이며, 설치 실패나 data loss로 이어져서는 안 된다.

#### 선택적 enhanced tmux branch

최고 성능 tier에서는 tmux가 다음 lifecycle을 native로 관리하는 branch를 염두에 둔다.

- Kitty image와 local GPU frame-token sequence parse/cache
- pane-relative placement
- selected window에서만 image 표시
- pane resize와 zoom 시 placement 갱신
- pane/window 종료 시 image deterministic deletion
- 여러 tmux client별 image capability와 visibility 관리
- pane offset 보정
- frame generation과 release acknowledgement 전달
- 느린 client가 browser producer에 무제한 backpressure를 만들지 않도록 client별 최신 frame 유지

Tmux는 GPU handle 자체를 열 필요가 없다. Resource token의 pane/window lifecycle과 outer client 전달을
관리하고, 실제 handle은 browserd와 Ghostty 사이의 authenticated local channel로 전달한다.

현재 tmux에서 native Kitty image support가 안정화되지 않은 경우 별도 integration branch를 유지하되,
upstream 반영을 목표로 한다. Compatibility mode에서는 다음 설정을 사용할 수 있다.

```tmux
set -g mouse on
set -g focus-events on
set -g allow-passthrough all
```

하지만 visibility hook과 stale-image cleanup을 최종 architecture의 정상 경로로 간주하지 않는다.

### 7.5 Ghostty native integration

Ghostty 쪽 목표:

- Kitty image load/display/delete
- animation frame과 frame composition
- persistent shared-memory transfer
- local `IOSurface`/DMA-BUF frame import extension
- explicit synchronization과 release acknowledgement
- Unicode placeholder/placement semantics
- image memory budget 및 deterministic eviction
- tmux를 거친 좌표·visibility 처리
- extended keyboard protocol
- SGR pixel mouse coordinates

Ghostty renderer는 browser texture를 terminal cell texture atlas에 복사하지 않고 별도 image/surface layer로
composition한다. Clip과 transform만 pane geometry에 맞게 갱신하고, resize 도중 불필요한 texture
재할당을 피한다.

Ghostty에서 빠진 protocol 동작은 terminal 이름별 workaround를 계속 쌓기보다 upstream 구현으로 해결한다.

### 7.6 성능 경로 선택

```text
Ghostty local-surface + tmux local-token 지원
    → zero-readback GPU fast path

표준 Kitty shared memory + damage/composite 지원
    → optimized compatibility path

basic Kitty image only
    → bounded full-frame fallback

remote browser
    → hardware video transport
```

선택은 browser page마다 독립적으로 이루어질 수 있으나 동일 page를 표시하는 client가 여럿이면 각 client가
자신의 transport를 가진다. Producer는 가장 느린 client 때문에 block되지 않는다.

### 7.7 성능 release gate

주 경로는 다음 기준을 충족하기 전까지 `performance-ready`로 표시하지 않는다.

- GPU fast path에서 browser pixel의 CPU full-frame copy 0회
- Static page가 idle일 때 frame transfer 0
- Hidden tmux window에서 frame production 0
- Queue depth가 설정한 surface ring 크기를 초과하지 않음
- Resize 후 2 display frame 안에 새 generation만 표시
- 1080p continuous scroll에서 60Hz display 기준 지속 가능한 frame pacing
- 두 개의 visible browser pane에서 unbounded memory 증가 없음
- 10분 animation/video 후 stale image·surface·shared-memory object 0
- Producer, tmux client, Ghostty 중 하나가 crash해도 surface handle을 회수

Latency와 frame 수치는 기준 hardware를 정한 뒤 수치화한다. 최소 측정 항목은 다음과 같다.

```text
input → Chromium event dispatch
Chromium commit → frame available
frame available → Ghostty present
input → visible response end-to-end
GPU/CPU copy bytes per frame
terminal command bytes per frame
frame drop/coalesce count
surface acquire/release latency
```

표준 Kitty 경로가 workload별 목표를 만족하지 못해도 이를 숨기지 않는다. Ghostty GPU fast path를 주 경로로
유지하고 Kitty path의 capability/성능 등급을 명시한다.

### 7.8 향후 backend

```text
NativeSurfaceTransport
    Chromium shared GPU texture → tweb native compositor

RemoteVideoTransport
    remote Chromium → hardware encode → client decode
```

두 backend가 추가돼도 `BrowserPageID`, profile, automation API, tmux lifecycle은 유지한다.

## 8. Resize와 visibility

```text
pane resize
    ↓ SIGWINCH
terminal pixel query
    ↓
viewport generation 증가
    ↓
Chromium viewport resize
    ↓
CSS resize / ResizeObserver
    ↓
새 generation frame 표시
```

- 100ms debounce를 사용하지 않는다.
- Display frame 단위 coalescing만 사용한다.
- Browser toolbar와 content viewport 크기를 별도로 계산한다.
- Cell 크기, terminal padding, Retina scale을 capability query로 얻는다.
- Pixel 크기를 알 수 없으면 cell 기반 추정치를 사용하되 상태를 표시한다.

Window/session 변경은 tmux hook이 아니라 가능한 경우 client visibility notification으로 처리한다.
Compatibility hook은 idempotent해야 하며 browserd가 재연결 후 전체 상태를 reconcile한다.

## 9. Shortcut와 입력 모델

### 9.1 원칙

Shortcut은 동시에 해석하지 않는다.

```text
TMUX mode
    모든 key → tmux key table

BROWSER mode
    reserved toggle → tmux mode
    나머지 key → browser pane
```

Mode는 tmux client별 상태다. 동일 session에 attach한 다른 client에게 영향을 주지 않는다.
새 attach, session 전환, 오류 복구 시 TMUX mode로 시작한다.

### 9.2 tmux key table

Pane option으로 browser surface를 식별한다.

```text
@tweb_surface=browser
@tweb_page_id=<opaque-id>
```

Browser mode 진입 시 client를 custom key table로 전환한다.

```tmux
switch-client -T tweb-browser
```

`tweb-browser` table의 동작:

- reserved toggle은 `root` table로 복귀
- `Any`는 실제 key를 pane으로 보내고 다시 `tweb-browser` table을 arm
- mouse border event는 tmux가 resize에 사용
- pane interior mouse event는 browser process로 전달

개념 설정:

```tmux
bind-key -n C-g if-shell -F '#{==:#{@tweb_surface},browser}' \
  'switch-client -T tweb-browser' \
  'send-keys C-g'

bind-key -T tweb-browser C-g switch-client -T root
bind-key -T tweb-browser Any send-keys \; switch-client -T tweb-browser
```

정확한 `Any` forwarding, key-up/repeat, extended key, mouse 동작은 지원 tmux version별 conformance
test로 확정한다. 동작하지 않는 version에서는 지원한다고 표시하지 않는다.

기본 toggle은 `C-g`로 제안하되 configurable하다. 다른 pane에서는 원래 `C-g`가 그대로 전달된다.
Literal `C-g`를 browser에 보내는 별도 binding을 제공한다.

### 9.3 Browser mode 표시

Mode는 항상 시각적으로 보여야 한다.

```text
[TMUX]    pane 조작 상태
[BROWSER] Chromium direct input 상태
[AGENT]   agent가 control lease를 가진 상태
```

표시 위치:

- terminal title/OSC
- tmux pane-border-format
- browser toolbar badge

`client_key_table`과 실제 browser focus가 불일치하면 입력을 전달하지 않고 TMUX mode로 복구한다.

### 9.4 IME와 clipboard

반드시 별도 conformance 영역으로 취급한다.

- 한글 조합 중간 상태와 committed text
- Kitty keyboard protocol key-down/repeat/key-up
- bracketed paste
- OSC 52 clipboard
- browser selection copy
- file path drop와 upload

Terminal protocol이 composition lifecycle을 전달하지 못하면 committed text 입력을 지원하고 제약을
명시한다. 이를 숨기기 위해 global key event interception을 추가하지 않는다.

## 10. Chrome profile bootstrap와 동기화

### 10.1 목표

사용자가 기존 Chrome 환경을 빠르게 재구성할 수 있어야 한다.

```text
Chrome profile 선택
    ↓
profile inventory preview
    ↓
사용자가 항목·site를 승인
    ↓
tweb profile bootstrap
```

지원 항목을 보안 수준별로 나눈다.

| 데이터 | 기본 정책 | 방식 |
|---|---|---|
| Extension 목록 | 가져오기 | ID/version/manifest inventory 후 재설치 |
| Bookmarks | 가져오기 | snapshot import |
| History | 선택적 가져오기 | credential 제거 후 import |
| 일반 설정 | allowlist | homepage, locale 등 |
| Cookie | origin별 명시적 승인 | Chrome Bridge를 통한 one-shot transfer |
| Local storage | origin별 명시적 승인 | 지원 가능한 site만 adapter 사용 |
| Extension storage | 기본 제외 | extension별 migration adapter |
| Password/passkey | 제외 | 원래 provider에서 재인증 |
| Okta/IdP session | 제외 | actual managed Chrome handoff |

### 10.2 Profile DB 직접 접근 금지

다음은 사용하지 않는다.

- 실행 중인 Chrome `Cookies` SQLite 직접 읽기
- Chrome Safe Storage key 추출
- profile directory의 live copy
- default Chrome profile을 Chromium `user-data-dir`로 재사용
- cookie 값을 CLI/stdout/log에 출력

대신 최소 권한의 Chrome Profile Bridge extension과 Native Messaging host를 사용한다.

### 10.3 Chrome Profile Bridge

기본 권한:

```text
nativeMessaging
management
bookmarks (선택)
history (선택)
cookies + per-origin host permission (요청 시에만)
```

원칙:

- Cookie 권한은 optional permission이다.
- 사용자가 선택한 origin에 대해서만 runtime permission을 요청한다.
- Transfer는 one-shot이며 background continuous sync가 아니다.
- Native Messaging channel은 request ID, target profile, origin, expiry를 포함한다.
- Cookie 값은 process memory와 암호화된 local IPC만 통과하고 저장 log를 남기지 않는다.
- Import 결과는 개수와 속성만 보여주며 값은 보여주지 않는다.
- Organization denylist와 IdP denylist를 먼저 적용한다.
- `HttpOnly`, `Secure`, partitioned cookie는 정책과 browser support를 보존한다.
- 충돌 시 임의 last-write-wins를 사용하지 않고 preview/replace 정책을 요청한다.

### 10.4 Sensitive domain policy

기본 deny 예:

```text
*.okta.com
조직 Okta tenant
AWS SSO/Teleport 등 organization-managed sensitive routes
password manager 및 identity provider domain
```

이 domain은 cookie sync 대신 실제 managed Google Chrome에서 연다.

```text
embedded browser
    ↓ sensitive route 감지
managed Chrome handoff
    ↓
[Chrome에서 열림] 상태와 focus-return action 표시
```

Organization policy가 명시적으로 승인하지 않는 한 denylist를 사용자 설정으로 해제하지 않는다.

### 10.5 Extension 동기화

Extension은 세 종류로 분류한다.

```text
compatible
    자동 재설치 가능

needs-adapter
    native messaging, toolbar, side panel 등 host 구현 필요

managed-chrome-only
    Device Trust, enterprise policy, Chrome identity에 의존
```

가져오기 과정:

1. Chrome profile의 extension metadata만 읽는다.
2. Web Store ID와 signing identity를 보존해 재설치한다.
3. 지원하는 Chrome Extension API capability를 manifest와 runtime probe로 검사한다.
4. 필요한 권한과 호환성 상태를 사용자에게 보여준다.
5. Extension storage는 자동 복사하지 않고 extension-native sync 또는 adapter를 사용한다.
6. 1Password, Okta Browser Plugin 같은 항목은 검증 전까지 `managed-chrome-only`다.

Extension compatibility 결과는 version별 registry로 관리하고 추측하지 않는다.

## 11. Managed Chrome handoff

실제 Google Chrome이 필요한 URL은 별도 trusted provider로 처리한다.

```text
BrowserRoutingPolicy
├── embedded
├── managed-chrome
├── remote
└── ask
```

Managed Chrome Bridge의 최소 기능:

- URL 열기
- tweb가 연 tab의 ID/title/URL 추적
- tab focus
- tweb로 focus 복귀
- tab 종료 감지

기본 Bridge에는 `debugger`, 광범위한 `scripting`, cookie access를 주지 않는다. Profile bootstrap을
수행할 때만 별도의 명시적 permission flow를 사용한다.

## 12. Agent shared control과 resource exchange

### 12.1 Automation loop

Automation API는 cookie 값을 노출하지 않는다.

```text
snapshot → semantic refs
act      → click/fill/press/scroll/navigate
wait     → load/network/selector/text 조건
verify   → 새 snapshot/status/screenshot
```

- Ref는 document generation에 종속된다.
- Navigation 후 stale ref는 명시적 오류다.
- Page별 command queue로 순서를 보장한다.
- 사람이 browser input을 시작하면 agent lease를 일시 중단할 수 있다.
- 외부 제출, 구매, 메시지 전송, upload, delete는 실행 직전 확인한다.
- Managed Chrome profile은 기본적으로 agent automation 대상이 아니다.

### 12.2 목표

Orca의 Design Mode처럼 browser에서 선택한 element context를 agent에게 하나의 attachment로 전달할 수
있어야 한다. 이를 특정 agent 제품이나 동일 filesystem에 결합하지 않고 tmux scope와 resource handle로
일반화한다.

지원해야 하는 방향:

```text
Browser → Agent
├── URL/title/selection
├── DOM/accessibility snapshot
├── element HTML + computed CSS + cropped screenshot
├── source map 위치
├── screenshot/PDF
├── console/network trace
├── download
└── page-generated file/blob

Agent → Browser
├── navigation/input/action
├── file upload
├── clipboard payload
├── JavaScript/CSS patch (승인된 개발 mode)
└── workspace file preview
```

### 12.3 ResourceBroker

큰 payload를 tmux option, environment variable, terminal escape sequence 또는 agent prompt에 직접 넣지
않는다. `twebd`와 별도 lifecycle을 가진 `ResourceBroker`가 immutable resource와 live handle을
관리한다.

```text
BrowserPage
    ↓ publish
ResourceBroker
    ├── metadata index
    ├── scoped object store
    ├── live resource registry
    ├── materializer
    └── transfer service
           ↓ deliver
       AgentBridge
           ↓
       Agent pane
```

Resource manifest:

```text
ResourceDescriptor
├── id: ResourceID
├── kind
├── mimeType
├── producer
├── sourcePageID
├── documentGeneration
├── sourceOrigin
├── scope
│   ├── tmuxServerID
│   ├── sessionID
│   ├── windowID
│   └── paneID
├── locality
│   ├── hostID
│   └── storageKind
├── size
├── digest
├── sensitivity
├── createdAt
├── expiresAt
└── capabilities
```

Resource 본문은 다음 중 하나다.

```text
inline-small     작은 JSON/text metadata
object           immutable binary/text object
file             host filesystem의 managed file
live             현재 document/network stream 같은 유효기간 있는 handle
bundle           여러 resource의 typed manifest
```

Resource ID는 opaque하며 경로나 cookie 값을 포함하지 않는다. Object store는 사용자 전용 권한을 사용하고
session/window policy에 따라 암호화·TTL·quota를 적용한다.

### 12.4 Resource 종류

```text
BrowserState
    URL, title, favicon, history position, viewport

SemanticSnapshot
    accessibility/DOM 기반 element refs

ElementContextBundle
    element outer HTML
    주변 DOM 일부
    computed CSS
    cropped screenshot
    source map file/line/column
    current URL과 viewport

VisualCapture
    viewport screenshot, full-page screenshot, PDF, short recording

TextContext
    selection, extracted text, Markdown, reader view

DiagnosticTrace
    console entries, page errors, network summary, performance trace

NetworkResource
    request/response metadata, 승인된 body, HAR

BrowserFile
    download, generated Blob, exported file

WorkspaceFile
    upload 후보, browser에서 열 파일, source file

ClipboardPayload
    text, HTML, image, file references
```

Live `SemanticSnapshot`의 ref는 document generation이 바뀌면 만료된다. 반면 screenshot, PDF,
`ElementContextBundle`처럼 materialize한 resource는 immutable하다.

### 12.5 Scope와 기본 routing

Profile cookie 공유 범위와 resource visibility 범위를 분리한다.

```text
Browser profile 기본 범위 = tmux session
Resource 기본 범위        = tmux window
Agent target 기본 범위    = tmux window
```

즉 같은 session의 browser들이 login state를 공유하더라도 window A의 screenshot/download가 window B의
agent에게 자동 노출되지는 않는다.

Pane role:

```text
@tweb_role=agent
@tweb_role=browser-primary
@tweb_role=browser-docs
@tweb_role=server
```

기본 target resolution:

1. Resource를 만든 browser와 같은 tmux window를 선택한다.
2. 해당 window에 등록된 active agent가 하나면 그 pane을 선택한다.
3. Agent가 여러 개면 role/last-focus로 몰래 고르지 않고 selector를 보여준다.
4. Agent가 없으면 resource inbox에 보관하고 badge를 표시한다.
5. 다른 window/session 전달은 `--to-pane`, `--to-window`, `--to-session`으로 명시한다.

예:

```sh
tweb capture element --pane %3 --ref d8-n14 --send-to %1
tweb screenshot --pane %3 --send-to-window @2
tweb resource share r_01K... --to-pane %7
```

`join-pane`이나 `break-pane`으로 browser pane을 옮기면 이후 생성되는 resource의 기본 window scope가
바뀐다. 이미 생성된 resource scope는 암묵적으로 바꾸지 않는다.

### 12.6 Agent registration과 capability negotiation

Agent pane의 process가 다음과 같이 등록한다.

```text
AgentEndpoint
├── agentID
├── tmux pane/window/session
├── provider
├── workingDirectory
├── hostID
├── acceptedKinds
├── acceptedMimeTypes
├── maxInlineSize
├── supportsDirectAttachment
└── inboundEndpoint
```

`AgentBridge` 구현 예:

```text
ClaudeCodeBridge
CodexBridge
GenericTerminalAgentBridge
ShellInboxBridge
```

전달 우선순위:

1. Agent가 attachment RPC를 제공하면 resource manifest/handle을 직접 전달한다.
2. Agent가 local file attachment만 받으면 consumer host에 materialize하고 path와 metadata를 전달한다.
3. Generic terminal agent에는 inbox notification과 짧은 `tweb://resource/<id>` reference를 전달한다.
4. Adapter가 없으면 사용자가 `tweb resource materialize`로 꺼낼 수 있게 한다.

큰 DOM, screenshot, HAR를 `tmux send-keys`로 붙여 넣지 않는다. Generic bridge가 terminal에 입력을
삽입할 때도 shell-safe한 짧은 reference만 사용하며, 사용자가 활성화한 auto-delivery policy가 없는 한
실행 중인 prompt를 임의로 submit하지 않는다.

### 12.7 Browser → Agent attachment flow

Orca Design Mode와 같은 element 전달:

```text
1. Browser mode에서 Inspect/Attach mode 활성화
2. element hover 및 선택
3. browserd가 ElementContextBundle 생성
4. ResourceBroker가 immutable bundle 저장
5. 같은 tmux window의 AgentEndpoint resolve
6. AgentBridge가 attachment 전달
7. browser pane과 agent pane에 delivery 상태 표시
```

Bundle manifest 예:

```json
{
  "kind": "element-context",
  "page": "bpage_01K...",
  "documentGeneration": 18,
  "url": "https://localhost:5173/settings",
  "resources": {
    "screenshot": "r_01K...",
    "html": "r_01K...",
    "computedStyle": "r_01K...",
    "sourceLocation": "r_01K..."
  }
}
```

Source map이 있으면 workspace root에 대한 상대 경로와 commit/worktree identity를 함께 전달한다. Path가
workspace 밖을 가리키거나 browser host와 agent host가 다르면 단순 local path로 가장하지 않는다.

### 12.8 Download flow

Download는 browser daemon의 임의 `~/Downloads`로 바로 떨어뜨리지 않는다.

```text
Browser download
    ↓ quarantine staging
ResourceBroker BrowserFile
    ↓ checksum, MIME, filename, source URL
Window resource inbox
    ↓ user/agent policy
workspace로 atomic materialize
```

정책:

- `Content-Disposition` filename을 신뢰하지 않고 path traversal을 제거한다.
- 기존 파일을 조용히 overwrite하지 않는다.
- 실행 권한을 자동 부여하지 않는다.
- Source URL, final URL, MIME, size, digest를 보존한다.
- Download 완료 전에는 live progress resource로 표시한다.
- Agent에게 전달할 때 파일 자체 대신 먼저 descriptor를 전달할 수 있다.
- Remote browser에서 받은 파일은 필요할 때만 agent host로 전송한다.

예:

```sh
tweb downloads --pane %3
tweb resource materialize r_01K... --to ./fixtures/report.pdf
tweb resource send r_01K... --to-pane %1
```

### 12.9 Upload flow

Upload는 agent host의 경로를 browser host의 경로로 오인하지 않는다.

```text
Agent/workspace file
    ↓ publish WorkspaceFile
ResourceBroker
    ↓ target host transfer/materialize
Browser file chooser
```

예:

```sh
tweb resource publish ./fixtures/avatar.png
tweb upload --pane %3 --ref d4-n21 --resource r_01K...
```

파일 upload는 외부 origin으로 local data를 공개하는 동작이므로 source file, target origin, field를 보여주고
실행 직전 policy를 적용한다. Agent가 임의 absolute path를 지정해 browserd가 읽도록 하지 않는다.

### 12.10 Console과 network resource

기본 수집은 summary 중심이다.

```text
ConsoleEntry
    level, timestamp, source, message, stack

NetworkEntry
    method, URL, resource type, status, timing, size
```

다음은 기본적으로 redaction한다.

- `Authorization`
- `Cookie`, `Set-Cookie`
- proxy credentials
- password field value
- file input local path
- configured secret query/body fields

Response/request body, WebSocket frame, full HAR는 명시적 capture session에서만 수집한다. Resource scope,
TTL, size budget을 설정하고 managed Chrome에는 기본 적용하지 않는다.

### 12.11 Clipboard와 선택 텍스트

Browser selection을 agent에 전달할 때 system clipboard를 중간 transport로 사용하지 않는다.

```text
Browser selection
    ↓ TextContext resource
Agent attachment
```

사용자가 명시적으로 copy를 선택한 경우에만 OSC 52/system clipboard에도 반영한다. Agent → Browser paste도
resource 또는 direct input으로 전달하고 clipboard history 전체를 읽지 않는다.

### 12.12 Locality와 remote transfer

Resource identity와 저장 위치를 분리한다.

| Browser host | Agent host | 전달 방식 |
|---|---|---|
| 동일 host | 동일 host | file descriptor/path 또는 object-store reference |
| remote | 같은 remote | remote-local reference |
| remote | local | 요청 시 encrypted stream 후 local materialize |
| local | remote | 승인 후 encrypted stream 후 remote materialize |

`tweb://resource/<id>`는 어느 host에서도 같은 논리 resource를 가리킨다. Consumer가 bytes를 요구할 때
ResourceBroker가 locality와 capability를 보고 전송한다. Remote connection이 끊기면 descriptor는 유지하되
본문 상태를 `unavailable`로 표시하고 복구 후 resume/hash 검증한다.

### 12.13 Resource inbox와 UI

각 tmux window에는 resource inbox가 있다.

```text
window @1 resources (4)
├── element-context  settings button       → agent %1 delivered
├── screenshot       checkout error         pending
├── download         report.pdf             ready
└── console-trace    3 errors                → agent %1 delivered
```

표시 surface:

- tmux status/pane-border의 count badge
- browser toolbar의 `Send to agent` 및 inbox
- `tweb resource list --window @1`
- OSC notification

Terminal scrollback에 binary나 대형 JSON을 출력하지 않는다.

### 12.14 Resource CLI

```sh
tweb resource list --window @1
tweb resource inspect r_01K...
tweb resource materialize r_01K... --to ./artifacts/
tweb resource send r_01K... --to-pane %1
tweb resource promote r_01K... --to-session
tweb resource revoke r_01K...
tweb resource gc --expired
```

CLI 기본 출력은 사람이 읽는 summary이고 `--json`은 versioned schema를 반환한다. Binary body는 stdout으로
암묵적으로 출력하지 않는다.

### 12.15 Resource security

Resource는 다음 sensitivity 중 하나를 가진다.

```text
public
workspace
internal
sensitive
credential-bearing
```

- DOM snapshot에서 password input과 configured sensitive field value를 제거한다.
- Screenshot은 화면에 보이는 secret을 포함할 수 있으므로 최소 `workspace`로 취급한다.
- Cookie/token은 ResourceBroker의 일반 resource 종류가 아니다.
- Credential-bearing resource는 기본적으로 agent 전달과 cross-host 전송을 거부한다.
- Digest 기반 dedup은 scope와 encryption boundary를 넘지 않는다.
- Resource access는 opaque ID만으로 허용하지 않고 caller의 tmux/agent identity와 capability를 확인한다.
- Resource revoke 후 새 handle 발급을 막고 materialized copy 위치를 audit에 남긴다.
- Audit에는 metadata와 전달 결과만 남기고 본문은 남기지 않는다.

### 12.16 Orca 대비 차이

Orca의 active agent attachment 경험은 유지하되 target과 data boundary를 더 명시적으로 만든다.

| 항목 | Orca에서 확인된 모델 | tweb 설계 |
|---|---|---|
| 기본 scope | worktree/active agent 중심 | tmux window + explicit pane |
| Element context | HTML/CSS/cropped screenshot/source map | typed `ElementContextBundle` |
| Agent 전달 | active agent attachment | capability-negotiated `AgentBridge` |
| 다중 agent | 문서상 상세 불명 | ambiguity 시 selector/explicit target |
| Remote locality | 구현 세부 불명 | resource ID와 host materialization 분리 |
| Download/upload | 문서상 제한적 | first-class `BrowserFile`/`WorkspaceFile` |
| Console/network | CLI 조회 | scoped resource로 전달 가능 |
| Security | 문서상 상세 불명 | redaction/sensitivity/TTL/capability 명시 |

## 13. 상태 복구

```text
pane frontend 종료
    page는 grace period 동안 유지

pane 재attach
    기존 BrowserPageID에 reconnect

tmux client detach
    browser process와 page 유지

tmux pane kill
    page 종료 또는 정책에 따라 history에 보관

browserd crash
    profile + URL/history 복원, DOM/JS heap은 복원 불가

host reboot
    persistent profile + layout metadata 복원
```

BrowserPageID를 tmux pane ID만으로 만들지 않는다. Pane ID 재사용에 대비해 tmux server identity와
opaque generation을 함께 저장한다.

## 14. 성능 목표와 측정

정확한 수치는 hardware별 baseline 측정 후 고정하되 다음을 release gate로 둔다.

- 입력에서 browser event dispatch까지의 latency
- event dispatch에서 visible frame까지의 latency
- 1080p와 Retina viewport scroll frame pacing
- static page idle CPU
- 1/2/4개 visible browser pane의 CPU·memory·GPU
- resize 중 frame drop과 stale generation 표시 여부
- terminal output backpressure 시 memory upper bound
- Ghostty/Kitty/tmux 조합별 image leak와 stale placement

벤치마크 workload:

- static documentation
- GitHub 같은 large DOM
- Vite HMR
- Monaco editor
- canvas/WebGL
- 60fps CSS animation
- video playback
- 한글 입력과 긴 clipboard paste

## 15. Conformance matrix

지원은 terminal 이름이 아니라 capability와 검증 조합으로 선언한다.

| 조합 | Graphics | Keyboard | Mouse | Mode | 상태 |
|---|---|---|---|---|---|
| Ghostty direct | Kitty subset | extended keys | pixel/cell | app mode | 검증 필요 |
| Ghostty + tmux | native image 목표 | tmux table | pane mouse | client mode | 핵심 target |
| Kitty direct | full graphics | kitty keys | pixel | app mode | 핵심 target |
| Kitty + tmux | native image 목표 | tmux table | pane mouse | client mode | 핵심 target |
| SSH remote | inline/video backend | remote input | remote input | client mode | 별도 transport |

## 16. 보안

- Chromium sandbox를 비활성화하지 않는다.
- Browser/renderer/GPU/utility process 권한을 분리한다.
- Browserd socket은 local user peer만 허용한다.
- Profile directory 권한은 사용자 전용으로 제한한다.
- Cookie/Profile Bridge는 별도 threat model과 security review를 통과해야 한다.
- Profile sync audit에는 domain, cookie 개수, source/target, 시각만 기록하고 값은 기록하지 않는다.
- Chrome extension과 native host의 update/signing chain을 검증한다.
- Electron/Chromium security release를 추적하고 긴급 update 경로를 둔다.
- Terminal escape sequence parser에 fuzzing을 적용한다.
- tmux passthrough payload length와 parser boundary를 제한한다.

## 17. 구현 순서가 아닌 검증 순서

단기 MVP 범위를 정하는 것이 아니라 architecture 성립 여부를 먼저 검증한다.

1. **Renderer viability**: Ghostty GPU fast path와 damage-aware Kitty compatibility path가 각각 목표 frame pacing을 만족하는가?
2. **tmux semantics**: image cache/visibility/resize/kill을 deterministic하게 관리할 수 있는가?
3. **Input fidelity**: Browser mode, modifier, 한글 IME, mouse가 손실 없이 동작하는가?
4. **Profile compatibility**: 주요 Chrome extension을 재설치하고 정상 동작시킬 수 있는가?
5. **Profile security**: origin-scoped one-shot cookie transfer가 policy 경계를 지키는가?
6. **Agent control**: human과 agent가 동일 page를 race 없이 공유할 수 있는가?
7. **Remote extension**: 기존 identity와 API를 유지한 채 transport만 교체할 수 있는가?

1~3에서 terminal protocol의 구조적 한계가 확인될 경우 runtime을 폐기하지 않고
`NativeSurfaceTransport`를 추가한다. tmux pane/process/profile/automation 모델은 그대로 유지한다.

## 18. 채택할 선례와 버릴 부분

### `awrit`에서 채택

- 실제 Chromium browser를 terminal graphics로 표시
- pane process가 keyboard/mouse/resize를 소유
- shared-memory Kitty transfer
- browser toolbar와 content surface

### `awrit`에서 교체

- pane마다 무거운 runtime
- full-frame `toBitmap()`
- dirty rectangle 무시
- terminal별 ad-hoc fallback
- Chrome처럼 보이도록 User-Agent만 수정

### `cliweb`에서 채택

- tmux pane discovery와 lifecycle
- persistent profile
- authenticated local control socket
- semantic refs 기반 agent API
- human/agent shared-control loop
- visibility와 graceful cleanup의 문제 정의

### `cliweb`에서 교체

- passthrough와 visibility hook을 최종 정상 경로로 간주하는 구조
- POSIX shared memory 하나에 결합된 transport
- Electron extension compatibility를 일반 Chrome compatibility로 간주하는 접근

### `casty`에서 채택

- Playwright/Puppeteer 없이 필요한 CDP domain만 구현한 작은 control client
- terminal pixel query와 DPR을 반영한 viewport 계산
- 저해상도 screencast를 변화 감지 signal로만 사용하는 방식
- 정적 상태에서 lossless frame으로 refine하는 적응형 품질 개념
- image ID 고정과 동일 frame deduplication
- Chrome process와 CDP page/input lifecycle의 단순한 분리
- SSH/headless 환경에서 동작해야 한다는 요구와 audio/media 문제 정의

### `casty`에서 교체

- `Page.captureScreenshot` 기반 full-frame JPEG/PNG renderer
- 약 20fps로 제한된 capture loop
- base64 encode/decode와 PNG/JPEG encode/decode
- inline 4096-byte chunk 전체 frame 전송
- 임시 PNG file을 매 frame 동기적으로 쓰는 file transport
- tmux passthrough만으로 image lifetime을 처리하는 구조
- process마다 같은 `~/.casty/profile`을 열어 다중 pane ownership이 불명확한 구조
- 시작할 때 cookie/local storage 외 profile data를 삭제하는 cleanup 정책
- `--disable-extensions`, `--disable-sync`, `--password-store=basic`, `--use-mock-keychain`
- Linux에서 기본적으로 `--no-sandbox`를 적용하는 정책
- User-Agent, `window.chrome`, plugin, WebGL 정보를 조작해 Chrome처럼 보이게 하는 stealth script

`casty`의 screenshot transport는 raw RGBA보다 terminal byte 수를 줄이고 SSH compatibility가 좋지만,
interactive primary renderer로는 GPU fast path보다 명확한 상한이 낮다. `RemoteVideoTransport`가 준비되지
않은 환경의 저프레임 fallback 또는 static snapshot backend로만 사용한다.

## 19. 최종 제품 정의

> TWeb Browser Runtime은 Ghostty/Kitty와 tmux 위에서 browser page를 실제 pane process로 실행하고,
> 사람과 agent가 동일한 persistent Chromium profile을 공유하도록 하는 terminal-native browser다.
> Browser에서 생성·관찰한 resource는 tmux window-scoped typed attachment로 agent에게 전달한다.
> Shortcut ownership은 tmux client별 Browser mode로 분리하며, Chrome profile은 명시적이고
> policy-aware한 bootstrap으로 가져온다. Managed Chrome이 필요한 identity 경계는 우회하지 않고
> 실제 Chrome으로 handoff한다.

## 참고

- [awrit](https://github.com/chase/awrit)
- [awrit frame path](https://github.com/chase/awrit/blob/electron/src/paint.ts)
- [awrit input handling](https://github.com/chase/awrit/blob/electron/src/inputHandler.ts)
- [cliweb](https://github.com/atomashevic/cliweb)
- [cliweb tmux/Ghostty setup](https://github.com/atomashevic/cliweb/blob/electron/docs/SETUP.md)
- [casty](https://github.com/sanohiro/casty)
- [casty CDP capture path](https://github.com/sanohiro/casty/blob/main/lib/browser.js)
- [casty Kitty transport](https://github.com/sanohiro/casty/blob/main/lib/kitty.js)
- [Orca Design Mode](https://www.onorca.dev/docs/browser/design-mode)
- [Orca CLI reference](https://www.onorca.dev/docs/cli/reference)
- [Kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/)
- [tmux manual](https://man.openbsd.org/tmux)
- [Ghostty](https://github.com/ghostty-org/ghostty)
- [Electron offscreen rendering](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering/)
- [Electron SharedTexture](https://www.electronjs.org/docs/latest/api/shared-texture)
- [Chrome Extensions API](https://developer.chrome.com/docs/extensions/reference/api)
- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
