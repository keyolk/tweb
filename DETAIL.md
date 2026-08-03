# TWeb 상세 설계 — P1 damage-aware Kitty path + twebd/Electron 통합

이 문서는 `PREDEV.md`의 critical path 첫 단계(P1)와 twebd/Electron 통합 구조를 구현 수준으로
깊이 설계합니다. Engine = Electron 확정(S0)을 전제로 합니다.

조사 기준일: 2026-07-31.

## 1. Electron offscreen rendering API 확보

### 1.1 paint event 정확한 의미

```js
win.webContents.on('paint', (event, dirty, image) => { ... })
```

- `dirty`(`Rectangle`): repaint된 영역. 단, `image`는 **전체 frame**을 담음.
- `image`(`NativeImage`): 전체 viewport. `.toBitmap()`로 raw pixel(BGRA on macOS) 획득.
- **awrit는 `_dirty`를 무시하고 전체 image를 항상 재전송** — 이게 DESIGN.md 섹션 7.1이 진단한
  병목 중 하나. TWeb은 dirty rect를 적극 활용.
- `event.texture`(`OffscreenSharedTexture`): `useSharedTexture: true`일 때만 존재(experimental).
  `texture.release()`로 명시적 해제 필요. "Only a limited number of textures can exist at the
  same time."

### 1.2 dirty-only subscription

```js
win.webContents.beginFrameSubscription(true, (image, dirty) => { ... })
```

`onlyDirty: true`면 callback의 `image`가 **repaint된 영역만** 담음. 단, paint event와 동시에 쓰면
안 되고 둘 중 하나를 선택.

### 1.3 frame rate 제어

```js
win.webContents.setFrameRate(60)  // 최대 240, 그 이상은 "performance losses only"
```

### 1.4 두 GPU 경로

| mode | `useSharedTexture` | output | CPU copy | 비고 |
|---|---|---|---|---|
| shared memory bitmap | `false`(기본) | `NativeImage` `.toBitmap()` (BGRA) | 있음 | WebGL/3D CSS 지원. awrit가 쓴 경로. |
| shared texture | `true` | `event.texture` (`OffscreenSharedTexture`) | 없음 | experimental, native module 필요, texture 수 제한. |
| software output | `app.disableHardwareAcceleration()` | `NativeImage` (빠른 생성) | 있음 | WebGL 포기. frame 생성 자체는 빠름. |

TWeb 기본 경로: **shared memory bitmap** + dirty rect 활용. GPU fast path(shared texture)는 S1
검증 후 선택적 Tier 3.

## 2. Memory pipeline 설계 (awrit 병목 회피)

### 2.1 awrit의 병목 (조사 확인)

1. `paint`마다 `image.toBitmap()`으로 전체 frame을 CPU memory에 만듦.
2. **`_dirty` 무시, 전체 frame 복사**.
3. Rust bridge가 `paint`마다 `shm_open`, `ftruncate`, `mmap`, `munmap` 반복.
4. BGRA→RGBA 변환을 전체 frame에 수행(awrit `paint.ts`에는 변환 코드가 안 보이나, Kitty가
   RGBA를 요구하므로 어딘가에서 수행).
5. Browser→Node→Rust→shared memory 중복 copy.

### 2.2 TWeb의 개선

```text
Electron main process (Node.js)
│
├── BrowserWindow (offscreen, 단일 main process, pane마다 window가 아니라 page 분리)
│   └── webContents.on('paint', (event, dirty, image) => ...)
│         │
│         ├── dirty rect 추출 (awrit는 무시, TWeb은 적극 활용)
│         ├── image.toBitmap() → BGRA raw pixel (전체 frame)
│         └── Rust native module (awrit-native-rs 처럼)로 전달
│               │
│               ├── persistent POSIX SHM ring (매 paint shm_open 금지)
│               │   ├── page 생성 시 2~3개 mapped buffer preallocate
│               │   ├── resize 때만 buffer 교체
│               │   └── buffer pool 재사용 (이름/image ID 무한 생성 금지)
│               │
│               ├── dirty rect → adaptive tile 매핑
│               │   ├── 256×256 tile grid
│               │   ├── dirty rect와 겹치는 tile만 갱신
│               │   ├── scroll처럼 변경 면적이 크면 full-frame/stripe로 합침
│               │   └── static page는 frame/command 생성 안 함
│               │
│               ├── BGRA→RGBA 변환 (변경 tile만 SIMD)
│               │   └── 전체 frame 변환 금지, dirty tile만
│               │
│               └── Kitty graphics 전송
│                   ├── t=s (shared memory) + a=t (transmit-only) + a=p,U=1 (virtual placement)
│                   ├── stable tile image ID 제자리 갱신 (a=p,i=<id> replace)
│                   └── terminal ACK 전까지 같은 transfer buffer 재사용 금지
│
└── twebd IPC — tmux pane identity ↔ BrowserWindow/page 매핑
```

### 2.3 핵심 최적화 원칙

1. **매 paint shm_open 금지**: page 생성 시 2~3개 persistent mapped buffer preallocate, resize
   때만 교체.
2. **Browser→Node→Rust→SHM 중복 copy 제거**: Rust native module이 `toBitmap()` 결과를 destination
   SHM buffer로 직접 write. Node `Buffer` 왕복 금지.
3. **dirty tile만 변환/전송**: 전체 frame BGRA→RGBA 변환 금지, dirty tile만 SIMD 변환.
4. **static page zero transfer**: damage가 없으면 frame과 terminal command를 만들지 않음.
5. **bounded pool**: SHM name과 image ID를 무한 생성하지 않고 bounded pool에서 재사용.
6. **backpressure**: queue가 밀리면 intermediate generation을 버리고 최신 complete frame만 남김.

## 3. Tile 전략 상세

### 3.1 tile 크기 선택

```text
작은 tile (128×128) → command/image 수와 placement 비용 증가
큰 tile   (512×512) → 불필요한 pixel copy와 texture upload 증가
기본 후보 256×256, workload에 따라 128~512 범위에서 조정
```

tile 크기는 고정 상수가 아니라 측정 결과로 선택. 측정 항목:
- tile당 Kitty command byte 수
- tile당 texture upload 시간
- dirty tile 평균 개수 (scroll vs static vs animation)

### 3.2 damage → tile 매핑

```text
paint event
    ↓
dirty rect (x, y, width, height)
    ↓
겹치는 tile 집합 계산
    ↓
한 display interval의 여러 damage event union
    ↓
변경 면적 판정:
    작음 (≤ 20% viewport) → tile별 Kitty 전송
    큼 (> 20% viewport)   → full-frame 또는 stripe로 합침
    ↓
scroll event 감지 시 → 수백 개의 작은 command 대신 full-frame/stripe
```

### 3.3 Kitty capability별 전략

```text
load + animation frame + composite 지원
    → base image에 damage frame composite (a=f, c=<base>)

independent image placement + replace 지원
    → stable tile image ID 제자리 갱신 (a=p, i=<id>, X=1 replace)

basic transfer/display only
    → coalesced full-frame fallback + 낮은 frame cap
    → UI에 제한 상태 표시 (숨기지 않음)
```

capability는 terminal 이름으로 추측하지 않고 graphics query(`a=q` + `ESC[c`)로 판정.

## 4. twebd + Electron 통합 구조

### 4.1 process topology

```text
Host
├── tmux server
│   └── pane %3
│       └── tweb __pane (Rust binary, tmux가 실행하는 foreground process)
│           ├── terminal capability negotiation (Kitty graphics query)
│           ├── keyboard/mouse decoding (raw terminal mode)
│           ├── SIGWINCH → pixel viewport resize
│           └── frame display (Kitty graphics 수신하여 Ghostty에 표시)
│
├── Electron main process (Node.js, 단일)
│   ├── BrowserWindow #1 (offscreen, page = pane %3)
│   │   └── webContents.on('paint') → Rust native module → SHM → Kitty graphics
│   ├── BrowserWindow #2 (offscreen, page = pane %5)
│   │   └── ...
│   ├── session.loadExtension() — vimium, 1Password 등
│   ├── session.cookies — Profile Bridge에서 받은 cookie 주입
│   └── IPC server — twebd와 통신
│
├── twebd (Rust daemon)
│   ├── authenticated Unix socket (peer credential 확인)
│   ├── PageRegistry — tmux pane ID ↔ BrowserWindow/page 매핑
│   ├── ProfileManager — session별 persistent profile
│   ├── ResourceBroker — resource store, scope, TTL
│   ├── AutomationController — agent action 직렬화
│   └── tmux integration — pane lifecycle, hook
│
└── Google Chrome (사용자의 일반 Chrome, Profile Bridge extension)
    └── TWeb Profile Bridge extension (cookie transfer, engine 무관)
```

### 4.2 BrowserWindow reuse 전략 (memory 완화 핵심)

Orca는 per-worktree BrowserWindow를 만듦. TWeb은:

```text
Electron main process (단일, Node.js runtime 1개)
├── BrowserWindow A (offscreen)
│   └── webContents page = pane %3
├── BrowserWindow B (offscreen)
│   └── webContents page = pane %5
└── ...

memory 절감 원칙:
- main process Node.js runtime은 1개 (process 자체가 1개)
- pane마다 새 Electron process가 아니라 BrowserWindow만 추가
- renderer process는 Chromium이 관리 (page 격리)
- nodeIntegration: false → renderer는 순수 Chromium, Node.js 복제 없음
- offscreen window는 frameless, 표시 안 됨 → GPU surface 최소화
```

단, BrowserWindow마다 renderer process가 생길 수 있음(Chromium process model). `processReuse` 또는
`site isolation` 정책으로 renderer process 재사용을 검토. 이건 S1 측정 항목.

### 4.3 IPC 흐름

```text
tweb CLI (short-lived)
    ↓ "open URL in pane %3"
twebd (Unix socket, peer credential)
    ↓ "create page for pane %3, load URL"
Electron main process (IPC)
    ↓ BrowserWindow 생성, loadURL
    ↓ webContents.on('paint') 시작
Rust native module
    ↓ SHM write + Kitty graphics 전송
tweb __pane (pane %3의 foreground process)
    ↓ Kitty graphics 수신
    ↓ Ghostty에 표시
```

### 4.4 resize 흐름

```text
tmux pane resize
    ↓ SIGWINCH
tweb __pane
    ↓ terminal pixel query (CSI 14t)
    ↓ viewport generation 증가
    ↓ twebd에 resize 요청
twebd
    ↓ Electron main process에 viewport resize 전달
Electron
    ↓ BrowserWindow.setSize() 또는 webContents.setViewRect()
    ↓ Chromium viewport resize → CSS reflow → ResizeObserver
    ↓ 새 generation frame paint
    ↓ 2 display frame 내 새 generation만 표시 (이전 size frame drop)
```

100ms debounce 금지. display frame 단위 coalescing만.

## 5. frame lifetime과 backpressure

### 5.1 surface ring

```text
visible page마다 2~3개 surface 순환 (mailbox)
- GPU fast path: 기본 2-surface, measured stall 시 3개로 확장
- shared memory bitmap: 2-surface (CPU bitmap이므로 GPU surface보다 가벼움)
- Ghostty가 release하기 전에 producer가 surface 덮어쓰지 않음
- queue가 밀리면 아직 present하지 않은 중간 frame 버리고 최신 complete frame만 남김
```

### 5.2 generation 관리

```text
resize마다 generation 증가
- 이전 size/generation frame 표시 금지
- 새 generation frame만 2 display frame 내에 표시
- hidden page: compositor begin-frame 중지, 마지막 surface만 유지
- GPU process crash 시 page 단위로 Kitty backend로 전환
```

### 5.3 hidden page 처리

```text
hidden tmux window
    ↓ tweb __pane이 visibility loss 감지 (tmux hook 또는 client visibility)
    ↓ twebd에 hidden 전달
    ↓ Electron: webContents.beginFrameSubscription 중지 또는 setFrameRate(0)
    ↓ GPU/SHM surface 해제, compressed thumbnail만 선택적 유지
    ↓ visible 복귀 시 전체 redraw reconcile
```

## 6. 입력 처리 (Browser mode)

### 6.1 입력 경로

```text
Ghostty (로컬)
    ↓ keyboard/mouse event (Kitty keyboard protocol, SGR pixel mouse)
tweb __pane (raw terminal mode)
    ↓ tmux mode 판정: TMUX mode 또는 BROWSER mode
    ↓ BROWSER mode: twebd로 입력 전달
twebd
    ↓ Electron main process에 input event 전달
Electron
    ↓ webContents.sendInputEvent() (Chromium input injection)
    ↓ 한글 IME: BrowserWindow가 macOS NSTextInputClient로 native composition
```

### 6.2 Browser mode (DESIGN.md 섹션 9)

```text
TMUX mode: 모든 key → tmux key table (root)
BROWSER mode: reserved toggle → tmux 복귀, 나머지 key → browser pane

mode 진입: switch-client -T tweb-browser
mode 표시: terminal title/OSC, tmux pane-border-format, browser toolbar badge
client_key_table과 실제 browser focus 불일치 시 입력 전달 금지, TMUX mode로 복구
```

### 6.3 한글 IME (로컬 case)

```text
macOS IME → Ghostty NSTextInputClient → ... → tweb __pane → twebd → Electron
    단, Electron BrowserWindow가 macOS window이므로 NSTextInputClient를 직접 받음
    composition 중간 상태가 browser input field에 실시간 표시 (native)
    방향키/delete 시 commit-then-act (Ghostty #11461 fix와 동일)
```

**주의**: Electron BrowserWindow가 offscreen(frameless, 표시 안 됨)이면 macOS IME가 활성화될지
확인 필요. offscreen window는 first responder가 아니어서 IME event를 안 받을 수 있음. 이건 S1/P3
검증 항목 — offscreen window에서 native IME가 동작하는지, 아니면 input injection 경로로
`setMarkedText`/`insertText`를 수동 주입해야 하는지.

## 7. extension loading

### 7.1 Electron extension API

```js
const { session } = require('electron')

// unpacked extension 로드
await session.defaultSession.loadExtension('/path/to/vimium')

// extension은 매 실행마다 reload (persistent 아님)
// Web Store 설치는 지원 안 됨, unpacked만
```

### 7.2 TWeb extension 관리

```text
tweb profile bootstrap chrome
    ↓ 사용자 Chrome profile에서 extension metadata 읽기
    ↓ Web Store ID 보존
    ↓ extension을 TWeb data dir에 unpack하여 저장
    ↓ Electron session.loadExtension()으로 매 실행마다 로드

extension compatibility 분류:
    compatible — 자동 재설치 가능
    needs-adapter — native messaging 등 host 구현 필요
    managed-chrome-only — Device Trust, enterprise policy 의존 (1Password, Okta)
```

### 7.3 Native Messaging host (1Password 등)

```text
Electron extension (1Password)
    ↓ chrome.runtime.connectNative('com.tweb.bridge')
Native Messaging host (Rust binary, twebd가 관리)
    ↓ stdin/stdout JSON, 32-bit length prefix
    ↓ secure enclave / credential store 접근
```

TWeb이 Native Messaging host를 자체 구현해야 하는 extension(1Password 등)은 `needs-adapter`.
단, 1Password는 기존 host binary를 재사용할 수 있는지 확인 필요.

## 8. 측정 항목 (S1/P1 release gate)

```text
frame pacing
├── static page idle 시 frame transfer 0회
├── 1080p continuous scroll 60Hz frame pacing
├── 10분 animation 후 stale image/shm object 0개
├── resize 후 2 display frame 내 새 generation만 표시
└── CPU full-frame copy 0회 (dirty tile만 전송 확인)

memory (Orca 대비)
├── pane 1/2/4개일 때 RSS, private dirty, PSS
├── idle pane frontend는 frame-sized buffer 소유 안 함
├── hidden page GPU/SHM surface byte 0으로 수렴
└── page close/renderer crash 후 resource count와 private bytes baseline 복귀

input
├── 한글 2-Set IME 조합 과정 실시간 표시 (offscreen window에서)
├── 방향키/delete 시 commit-then-act
├── bracketed paste, OSC 52 clipboard
└── mouse: pane border resize vs interior event 분리

extension
├── vimium 설치 후 link hints, scroll 동작
├── React DevTools 설치 후 panel 동작
└── 1Password native messaging 연결
```

## 9. 확장용이한 컴포넌트 및 인터페이스 구조

DESIGN.md가 `BrowserEngineAdapter`, `FrameTransport`, `BrowserRuntime`, `AgentBridge` trait를
제안했으나, 구현 가능한 Rust trait/protocol 수준으로 구체화해야 합니다. 핵심 원칙:
**engine 교체(Electron → custom shell), transport 교체(Kitty → video), agent bridge 확장,
platform 확장이 trait 경계 뒤에서 일어나서 core API를 바꾸지 않는다.**

### 9.1 trait 계층 구조

```text
core (platform/engine 무관)
├── BrowserEngineAdapter    — browser process 추상. Electron, ExternalChrome, CustomShell
├── FrameTransport          — frame 전달 추상. KittyGraphics, NativeSurface, RemoteVideo
├── SurfaceSource           — frame 생산 추상. paint event, CDP screenshot, GPU texture
├── InputSink               — 입력 주입 추상. webContents.sendInputEvent, CDP Input, host IME
├── ExtensionHost           — extension loading 추상. session.loadExtension, --load-extension
├── ProfileStore            — profile 추상. Electron session, Chrome profile, CEF user-data-dir
├── AgentBridge             — agent 전달 추상. ClaudeCode, Codex, Generic, ShellInbox
├── TerminalCapability      — terminal capability 추상. Kitty query 결과
├── PlatformService         — OS 추상. IPC, handle transfer, credential, path
└── ResourceBroker          — resource store 추상. local, remote, scoped
```

### 9.2 Rust trait 정의 (핵심)

```rust
// src/core/engine.rs
/// Browser process 추상. Electron/ExternalChrome/CustomShell이 각각 구현.
/// core API는 page/profile/resource/automation을 다루고, engine 세부를 모름.
#[async_trait]
pub trait BrowserEngineAdapter: Send + Sync {
    /// page 생성. pane identity와 연결.
    async fn create_page(&self, pane: PaneId, url: &str) -> Result<PageId>;
    /// page 종료.
    async fn close_page(&self, page: PageId) -> Result<()>;
    /// navigation.
    async fn navigate(&self, page: PageId, url: &str) -> Result<()>;
    /// frame 생산 source. FrameTransport이 소비.
    async fn frame_source(&self, page: PageId) -> Result<Box<dyn SurfaceSource>>;
    /// 입력 주입 sink.
    async fn input_sink(&self, page: PageId) -> Result<Box<dyn InputSink>>;
    /// extension host.
    fn extension_host(&self) -> &dyn ExtensionHost;
    /// profile store.
    fn profile_store(&self) -> &dyn ProfileStore;
    /// page 상태 snapshot (agent automation용).
    async fn snapshot(&self, page: PageId) -> Result<PageSnapshot>;
    /// agent action 실행 (click/fill/press/scroll).
    async fn execute_action(&self, page: PageId, action: &Action) -> Result<()>;
}

// src/core/frame.rs
/// frame 전달 추상. KittyGraphics/NativeSurface/RemoteVideo가 각각 구현.
#[async_trait]
pub trait FrameTransport: Send + Sync {
    /// terminal capability로 transport 선택.
    fn supports(&self, caps: &TerminalCapability) -> bool;
    /// surface source에서 frame을 받아 terminal에 전달.
    async fn stream(&self, page: PageId, source: Box<dyn SurfaceSource>) -> Result<()>;
    /// page visibility 변화.
    async fn set_visible(&self, page: PageId, visible: bool) -> Result<()>;
    /// page resize.
    async fn resize(&self, page: PageId, size: PixelSize) -> Result<()>;
    /// cleanup.
    async fn close(&self, page: PageId) -> Result<()>;
}

/// frame 생산 추상. engine이 구현.
pub trait SurfaceSource: Send {
    /// 다음 frame 또는 damage event. backpressure는 구현체가 처리.
    fn next_frame(&mut self) -> Result<FrameEvent>;
}

pub enum FrameEvent {
    /// dirty rect와 pixel data (CPU bitmap 경로).
    Dirty { rects: Vec<Rect>, pixels: BitmapRef, generation: u64 },
    /// GPU texture handle (GPU fast path).
    Gpu { handle: SurfaceHandle, fence: SyncPrimitive, generation: u64 },
    /// page가 idle, frame 없음.
    Idle,
    /// page 종료.
    End,
}

// src/core/input.rs
/// 입력 주입 추상. engine이 구현.
#[async_trait]
pub trait InputSink: Send + Sync {
    /// key event 주입.
    async fn send_key(&self, event: KeyEvent) -> Result<()>;
    /// mouse event 주입.
    async fn send_mouse(&self, event: MouseEvent) -> Result<()>;
    /// IME composition 주입 (한글).
    async fn send_composition(&self, event: CompositionEvent) -> Result<()>;
    /// committed text 주입.
    async fn insert_text(&self, text: &str) -> Result<()>;
}

pub enum CompositionEvent {
    MarkedText { text: String, range: Option<Range> },
    InsertText { text: String },
    UnmarkText,
}

// src/core/extension.rs
/// extension loading 추상. engine이 구현.
#[async_trait]
pub trait ExtensionHost: Send + Sync {
    /// unpacked extension 로드.
    async fn load_extension(&self, path: &Path) -> Result<ExtensionId>;
    /// extension 목록.
    async fn list_extensions(&self) -> Result<Vec<ExtensionInfo>>;
    /// extension 제거.
    async fn remove_extension(&self, id: &ExtensionId) -> Result<()>;
    /// native messaging host 연결.
    async fn connect_native(&self, name: &str) -> Result<Box<dyn NativeMessagingChannel>>;
}

// src/core/agent.rs
/// agent 전달 추상. ClaudeCode/Codex/Generic/ShellInbox가 각각 구현.
#[async_trait]
pub trait AgentBridge: Send + Sync {
    /// agent가 받을 수 있는 resource kind/mime 협상.
    fn accepts(&self) -> &AgentCapability;
    /// resource 전달.
    async fn deliver(&self, resource: &ResourceDescriptor, broker: &dyn ResourceBroker) -> Result<DeliveryStatus>;
    /// agent alive 확인.
    async fn is_alive(&self) -> bool;
}

pub struct AgentCapability {
    pub accepted_kinds: Vec<ResourceKind>,
    pub accepted_mime_types: Vec<String>,
    pub max_inline_size: usize,
    pub supports_direct_attachment: bool,
}

// src/core/platform.rs
/// OS 추상. platform별 구현체가 각각 구현.
pub trait PlatformService: Send + Sync {
    fn local_ipc(&self) -> &dyn LocalIpcTransport;
    fn handle_transfer(&self) -> &dyn HandleTransfer;
    fn credential_store(&self) -> &dyn CredentialStore;
    fn browser_discovery(&self) -> &dyn BrowserDiscovery;
    fn paths(&self) -> &dyn PlatformPaths;
    fn process_supervisor(&self) -> &dyn ProcessSupervisor;
}
```

### 9.3 구현체 매트릭스 (확장 지점)

```text
BrowserEngineAdapter
├── ElectronAdapter          (src/electron/ — TypeScript main + Rust native module)
├── ExternalChromeAdapter    (src/external/ — Rust, CDP WebSocket)
└── CustomShellAdapter       (src/shell/ — Rust + C++ Chromium embed, 장기 전환)

FrameTransport
├── KittyGraphicsTransport   (src/native/kitty.rs — SHM + Kitty graphics, 로컬)
├── NativeSurfaceTransport   (src/native/surface.rs — IOSurface/DMA-BUF, Tier 3)
└── RemoteVideoTransport     (src/remote/video.rs — H.264/VP8 encode, remote)

InputSink
├── ElectronInputSink        (webContents.sendInputEvent + native IME)
├── CdpInputSink             (CDP Input.dispatchKeyEvent/insertText)
└── ShellInputSink           (Chromium TextInputClient setMarkedText/insertText)

ExtensionHost
├── ElectronExtensionHost    (session.loadExtension)
├── ChromeExtensionHost      (--load-extension)
└── ShellExtensionHost       (Chromium extension API)

AgentBridge
├── ClaudeCodeBridge         (attachment RPC 또는 local file)
├── CodexBridge              (attachment RPC 또는 local file)
├── GenericTerminalAgentBridge (inbox notification + tweb://resource/<id>)
└── ShellInboxBridge         (shell inbox + reference)

PlatformService
├── MacosPlatform            (IOSurface, Mach/XPC, Keychain, launchd)
├── LinuxPlatform            (DMA-BUF, SCM_RIGHTS, Secret Service, systemd)
└── WindowsPlatform          (DXGI, DuplicateHandle, DPAPI, Job Object)
```

### 9.4 교체가 core API에 미치는 영향

```text
Electron → CustomShell 전환 (장기)
    BrowserEngineAdapter 교체
    core API (create_page/navigate/snapshot/execute_action) 변화 없음
    FrameTransport/InputSink/ExtensionHost 구현체만 교체
    ProfileStore가 profile migration 처리

로컬 → remote 전환
    FrameTransport만 KittyGraphics → RemoteVideo로 교체
    BrowserPageID/profile/automation API 유지
    ResourceBroker가 locality 판정하여 전송 방식 선택

agent 확장 (새 agent 추가)
    AgentBridge 구현체 추가
    AgentCapability 협상으로 resource kind/mime 자동 조정
    core가 agent 종류를 모름

platform 확장 (새 OS 추가)
    PlatformService 구현체 추가
    core가 OS를 모름
```

### 9.5 확장 지점 원칙

1. **core는 engine/transport/agent/platform을 모른다**: core는 trait만 본다. 구현체는
   `BrowserEngineAdapter` 등 trait 뒤에서 교체.
2. **새 구현체 추가가 기존 코드를 안 바꾼다**: 새 `AgentBridge` 구현체를 추가해도 core가 변하지
   않음. capability 협상으로 자동 조정.
3. **trait 경계가 process/IPC 경계와 일치**: Rust↔TypeScript(Electron)는 C ABI 또는 IPC,
   Rust↔C++(custom shell)는 C ABI. trait은 같은 process 내에서만.
4. **SurfaceSource/InputSink가 engine에 종속**: engine이 `Box<dyn SurfaceSource>`를 반환하므로,
   frame 생산과 입력 주입은 engine 구현체가 책임. core는 trait만 소비.
5. **FrameTransport가 capability로 선택**: `TerminalCapability`로 Kitty/Native/Remote를 판정.
   engine과 독립적으로 transport만 교체 가능.

## 10. 구현 파일 구조 (제안)

```text
tweb/
├── src/
│   ├── core/               (Rust, platform/engine 무관 core — trait 정의 + 공통 로직)
│   │   ├── mod.rs
│   │   ├── engine.rs       (BrowserEngineAdapter trait)
│   │   ├── frame.rs        (FrameTransport, SurfaceSource, FrameEvent trait)
│   │   ├── input.rs        (InputSink, CompositionEvent, KeyEvent, MouseEvent)
│   │   ├── extension.rs    (ExtensionHost, NativeMessagingChannel trait)
│   │   ├── profile.rs      (ProfileStore, BrowserProfile trait)
│   │   ├── agent.rs        (AgentBridge, AgentCapability trait)
│   │   ├── platform.rs     (PlatformService, LocalIpc, HandleTransfer, CredentialStore trait)
│   │   ├── resource.rs     (ResourceBroker, ResourceDescriptor trait)
│   │   ├── page.rs         (PageId, PaneId, PageSnapshot — 공통 type)
│   │   └── routing.rs      (BrowserRoutingPolicy — embedded/managed-chrome/remote/ask)
│   │
│   ├── twebd/              (Rust, daemon — core trait을 사용해 orchestration)
│   │   ├── main.rs
│   │   ├── ipc.rs          (Unix socket, peer credential)
│   │   ├── page_registry.rs (pane ID ↔ page 매핑, BrowserEngineAdapter 호출)
│   │   ├── profile_manager.rs (ProfileStore 사용)
│   │   ├── resource_broker.rs (ResourceBroker 구현)
│   │   ├── automation.rs   (BrowserEngineAdapter.snapshot/execute_action 호출)
│   │   ├── agent_bridge.rs (AgentBridge 구현체 관리, capability 협상)
│   │   └── tmux.rs         (tmux integration, hook)
│   │
│   ├── pane/               (Rust, tweb __pane frontend)
│   │   ├── main.rs
│   │   ├── terminal.rs     (TerminalCapability — Kitty graphics query, raw mode)
│   │   ├── input.rs        (keyboard/mouse decode, Browser mode 관리, InputSink 호출)
│   │   ├── resize.rs       (SIGWINCH, pixel query, FrameTransport.resize 호출)
│   │   └── display.rs      (FrameTransport.stream 소비, Ghostty 표시)
│   │
│   ├── engine/             (Rust, BrowserEngineAdapter 구현체들)
│   │   ├── mod.rs          (engine 선택: cfg 또는 runtime 판정)
│   │   ├── electron/       (Electron adapter — TypeScript main과 IPC)
│   │   │   ├── adapter.rs  (BrowserEngineAdapter 구현, IPC로 TypeScript main 호출)
│   │   │   ├── frame_source.rs (SurfaceSource 구현 — paint event 수신)
│   │   │   ├── input_sink.rs   (InputSink 구현 — sendInputEvent + IME)
│   │   │   └── extension.rs    (ExtensionHost 구현 — session.loadExtension)
│   │   ├── external/       (External Chrome adapter — CDP WebSocket, 장기 후보)
│   │   │   ├── adapter.rs
│   │   │   ├── frame_source.rs (SurfaceSource — captureScreenshot)
│   │   │   ├── input_sink.rs   (InputSink — CDP Input)
│   │   │   └── extension.rs    (ExtensionHost — --load-extension)
│   │   └── shell/          (Custom Chromium shell adapter — 장기 전환, 최후 hybrid)
│   │       ├── adapter.rs
│   │       ├── frame_source.rs (SurfaceSource — GPU texture export)
│   │       ├── input_sink.rs   (InputSink — TextInputClient)
│   │       └── extension.rs    (ExtensionHost — Chromium extension API)
│   │
│   ├── transport/          (Rust, FrameTransport 구현체들)
│   │   ├── mod.rs          (transport 선택: TerminalCapability로 판정)
│   │   ├── kitty.rs        (KittyGraphicsTransport — SHM + Kitty graphics, 로컬)
│   │   ├── surface.rs      (NativeSurfaceTransport — IOSurface/DMA-BUF, Tier 3)
│   │   └── remote.rs       (RemoteVideoTransport — H.264/VP8 encode, remote)
│   │
│   ├── native/             (Rust native module, 공유 최적화 — transport/engine이 사용)
│   │   ├── shm.rs          (persistent SHM ring, shm_open 금지)
│   │   ├── tile.rs         (dirty rect → adaptive tile 매핑)
│   │   ├── convert.rs      (BGRA→RGBA SIMD, dirty tile만)
│   │   └── kitty_proto.rs  (Kitty graphics 전송, bounded pool)
│   │
│   ├── platform/           (Rust, PlatformService 구현체들)
│   │   ├── mod.rs          (platform 선택: cfg(target_os))
│   │   ├── macos.rs        (IOSurface, Mach/XPC, Keychain, launchd)
│   │   ├── linux.rs        (DMA-BUF, SCM_RIGHTS, Secret Service, systemd)
│   │   └── windows.rs      (DXGI, DuplicateHandle, DPAPI, Job Object)
│   │
│   ├── agent/              (Rust, AgentBridge 구현체들)
│   │   ├── mod.rs          (agent 등록, capability 협상)
│   │   ├── claude_code.rs  (ClaudeCodeBridge — attachment RPC 또는 local file)
│   │   ├── codex.rs        (CodexBridge)
│   │   ├── generic.rs      (GenericTerminalAgentBridge — inbox + tweb://resource/<id>)
│   │   └── shell_inbox.rs  (ShellInboxBridge)
│   │
│   └── electron/           (TypeScript, Electron main process — engine/electron/와 IPC)
│       ├── main.ts         (BrowserWindow 관리, IPC server, Rust native module 로드)
│       ├── paint.ts        (paint event → Rust native module, dirty rect 전달)
│       ├── extension.ts    (session.loadExtension 관리)
│       ├── input.ts        (webContents.sendInputEvent, IME, CompositionEvent)
│       └── ipc.ts          (twebd ↔ Electron main process IPC)
│
├── extension/              (TypeScript, TWeb Profile Bridge Chrome extension)
│   ├── manifest.json       (nativeMessaging, cookies optional, management)
│   ├── background.ts       (cookie transfer, native messaging host 연결)
│   └── popup.ts            (origin 선택 UI, permission 요청)
│
└── tweb/                   (CLI binary, Rust)
    └── main.rs             (tweb open/split/snapshot/click/profile/doctor)
```

### 10.1 모듈 의존성 방향

```text
core (trait 정의) ← twebd, pane, engine/*, transport/*, platform/*, agent/*
                    (모두 core trait을 구현하거나 소비)

core는 어떤 구현체도 모름 (trait만 정의)
twebd는 core trait을 사용해 orchestration (구현체 선택)
engine/*는 BrowserEngineAdapter + InputSink + ExtensionHost 구현
transport/*는 FrameTransport 구현
platform/*는 PlatformService 구현
agent/*는 AgentBridge 구현
native/*는 transport/engine이 공유하는 최적화 (SHM, tile, convert, kitty_proto)
electron/ (TypeScript)는 engine/electron/와 IPC, Rust native module 로드
```

### 10.2 확장 시 파일 추가/변경

```text
새 engine 추가 (예: CEF 재고려)
    src/engine/cef/ 추가 (adapter, frame_source, input_sink, extension)
    core 변화 없음, twebd의 engine 선택 로직만 추가

새 transport 추가 (예: Sixel)
    src/transport/sixel.rs 추가
    core 변화 없음, transport/mod.rs 선택 로직만 추가

새 agent 추가
    src/agent/<name>.rs 추가
    core 변화 없음, agent/mod.rs 등록만 추가

새 platform 추가
    src/platform/<name>.rs 추가
    core 변화 없음, platform/mod.rs 선택 로직만 추가
```

## 참고 자료

- Electron webContents paint event — https://www.electronjs.org/docs/latest/api/web-contents
- Electron offscreen rendering — https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering
- awrit paint.ts — https://github.com/chase/awrit/blob/electron/src/paint.ts
- Kitty graphics protocol — https://sw.kovidgoyal.net/kitty/graphics-protocol/
- DESIGN.md 섹션 6.5, 7.1-7.7 — 본 저장소
- FEASIBILITY.md 섹션 1, 7 — 본 저장소
- PREDEV.md S1, P1 — 본 저장소
