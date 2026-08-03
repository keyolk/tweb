# TWeb

TWeb은 Ghostty/Kitty와 tmux 위에서 Chromium(Electron) 또는 macOS WebKit(Tauri) page를 pane process로 실행하는 terminal-native browser runtime입니다.

```text
Ghostty / Kitty
└── tmux
    ├── agent pane
    ├── server pane
    └── TWeb browser pane
```

## 핵심 원칙

- **tmux-native**: session, window, pane, resize, focus, lifecycle의 authority는 tmux입니다.
- **Terminal graphics-native**: Ghostty GPU surface fast path와 표준 Kitty graphics fallback을 제공합니다.
- **Browser mode**: tmux shortcut과 browser shortcut의 입력 소유권을 client별 mode로 분리합니다.
- **Shared browser profile**: 같은 tmux session의 browser page는 persistent Chromium profile을 공유합니다.
- **Agent resource exchange**: screenshot, DOM/CSS context, download, console/network trace를 같은 tmux window의 agent에게 typed attachment로 전달합니다.
- **Chrome profile bootstrap**: extension, bookmark, 일반 site state를 policy-aware하게 가져옵니다.
- **Managed Chrome boundary**: Okta Device Trust와 enterprise-managed Chrome이 필요한 URL은 실제 Google Chrome으로 handoff합니다.

## 명령

공식 executable은 `tweb`입니다. `twb`는 선택적 alias입니다.

```sh
# 현재 pane에서 열기
tweb open https://localhost:5173

# URL을 생략하면 현재 tmux window의 tab·active tab·zoom 복원
tweb open

# tmux browser pane 만들기 (기본: Electron, adaptive 4–30fps)
tweb split https://localhost:5173

# macOS Tauri/WebKit engine으로 열기
tweb split --engine tauri https://localhost:5173

# active 최대 frame rate 조절
# adaptive는 활동 중 지정값, 정적 상태에서 최대 4fps로 낮춤
tweb open --frame-rate 24 --adaptive-frame-rate https://localhost:5173

# 지정 frame rate를 고정해서 사용
tweb open --frame-rate 15 --no-adaptive-frame-rate https://localhost:5173

# 특정 pane의 browser를 agent/CLI로 제어
tweb snapshot --pane %3
tweb click --pane %3 --ref d1-n13
tweb screenshot --pane %3 --send-to %1

# Browser resource 관리
tweb resource list --window @1
tweb resource send r_01K... --to-pane %1

# Chrome profile bootstrap
tweb profile bootstrap chrome

# 지원 환경 진단
tweb doctor
```

## Browser engine과 frame policy

`open`과 `split`은 `--engine electron|tauri`를 받습니다. 기본값은 기존 기능을 모두 제공하는 `electron`입니다.

- **Electron**: Chromium offscreen paint 기반입니다. Vimium-style mode, tab/omnibox, visual/inspect, smart copy, detached DevTools 등 현재 TWeb browser 기능을 모두 제공합니다.
- **Tauri (macOS experimental)**: 시스템 `WKWebView`의 native snapshot을 Kitty PNG frame으로 보내므로 별도 Electron/Chromium startup 비용이 없습니다. resize, UTF-8/CSI-u/navigation key, SGR mouse, adaptive frame 전송과 terminal lifecycle을 지원합니다. Electron과 동일한 preload를 공유하므로 Vimium-style modal shortcut, hint/visual/inspect, tab 목록·omnibox·multi-tab, 페이지 검색, zoom, smart copy/paste, browser shortcut ↔ web passthrough 전환도 제공합니다. DevTools는 Safari Web Inspector로 열리며, Chromium 전용 `inspectElement` 좌표 지정은 지원 범위가 제한됩니다.

Electron과 Tauri 모두 열린 tab URL, active tab, tab별 zoom을 tmux window 단위로 저장합니다. `tweb open`처럼 URL을 생략하면 마지막 상태를 복원하고, URL을 명시하면 저장 상태를 무시해 해당 URL 하나로 새로 시작하며 그 상태로 갱신합니다. persistence key는 tmux server 시작 시각과 `window_id`를 사용하므로 session 이름 변경이나 window index 변경의 영향을 받지 않습니다.

`--frame-rate N`은 사용자 입력·resize 직후 활동 구간의 최대 frame rate이며 범위는 1–60입니다. 기본 adaptive mode는 terminal 입력·resize 후 700ms 동안 최대값을 사용하고, 이후 1fps로 낮춥니다. 동영상·animation의 지속적인 paint만으로 활동 구간이 연장되지는 않으므로 장시간 재생이 terminal output을 포화시키지 않습니다. PNG frame은 local file transport로 전달해 tmux/Ghostty stream에는 작은 Kitty graphics command만 보내며, writer가 밀리면 중간 frame을 버리고 최신 frame 하나만 유지합니다. `--no-adaptive-frame-rate`를 주면 지정값을 고정하고, `--adaptive-frame-rate`로 기본 정책을 명시할 수 있습니다.

동일한 80×24 tmux pane과 로컬 fixture의 debug build에서 첫 Kitty frame 중앙값(3회)은 Electron 6.084초, Tauri 1.834초였습니다. 이 수치는 현재 개발 환경의 비교값이며 release build·실제 사이트·WebKit cache 상태에 따라 달라집니다.

## Browser 입력 mode

다음 modal shortcut과 mode indicator는 Electron과 Tauri engine이 같은 preload runtime을 공유해 동일하게 동작합니다. engine별 차이는 DevTools 뿐이며, Electron은 detached Chromium DevTools를, Tauri는 Safari Web Inspector를 엽니다.

`Ctrl-;`로 다음 두 mode를 전환합니다.

- **Shortcuts ON**: 입력 요소에 focus가 없을 때 Vimium-style normal mode와 TWeb browser shortcut이 동작합니다. 입력 중에는 normal-mode 키를 가로채지 않으며 `Esc`로 focus를 해제할 수 있습니다.
- **Web passthrough ON**: TWeb shortcut을 모두 끄고, 현재 TWeb pane을 보고 있는 tmux client만 client-local `tweb-pass` table로 전환합니다. tmux prefix/root binding을 우회하고 키·modifier·mouse를 page에 전달합니다. 다른 tmux client와 일반 pane의 key table은 바뀌지 않습니다.

Web passthrough 상태에서도 `Ctrl-;`만 escape hatch로 사용해 Shortcuts mode로 돌아옵니다. `Ctrl-C`도 웹에 전달되므로 TWeb을 종료하려면 먼저 `Ctrl-;`로 Shortcuts mode에 돌아온 뒤 `Ctrl-C`를 누릅니다. TWeb pane을 떠나거나 프로세스가 종료되면 해당 client의 이전 tmux key table을 복원합니다.

macOS 또는 Ghostty 자체가 PTY보다 먼저 소비하는 application shortcut은 웹에 전달할 수 없습니다. 예를 들어 기본 `Cmd-T`, `Cmd-W`, `Cmd-+`는 Ghostty 동작이 우선합니다. 반면 terminal에 도달하는 일반 키, Ctrl/Alt/Shift 조합, navigation key와 mouse event는 passthrough 대상입니다.

### Mode indicator

화면 우하단에 현재 mode를 한 글자로 표시합니다: `N` normal, `E` editable/insert, `H` hint, `/` search, `V` visual, `I` inspect, `T` tab 목록, `O` omnibox, `P` web passthrough. 대상 수나 선택 종류처럼 필요한 정보만 옆에 짧게 붙습니다.

한글 2벌식 layout에서도 physical key와 자모 `langmap`을 사용하므로 normal/hint/visual/inspect 명령은 영문 layout과 동일하게 동작합니다. 입력 요소가 focus된 `E` mode에서는 한글을 변환하지 않고 그대로 입력합니다.

### Shortcuts mode 키

| 키 | 동작 |
| --- | --- |
| `f` / `F` | 화면의 클릭 가능 요소에 hint 표시 / 링크를 새 탭에서 열기 |
| `/`, `n`, `N` | 페이지 검색 (`Enter`로 확정) / 다음 / 이전 결과 |
| `v` / `V` | visual picker로 대상 선택 / 페이지 전체 text를 Visual selection으로 열기 |
| `b` | 열린 browser tab 목록 (`j`/`k`, `1`–`9`, `Enter`, `Esc`) |
| `I` | inspect picker: 요소 정보·selector 확인 |
| `h` / `l` | 왼쪽 / 오른쪽으로 스크롤 |
| `j` / `k` | 아래 / 위로 스크롤 |
| `d` / `u` | 반 페이지 아래 / 위로 스크롤 |
| `gg` / `G` | 페이지 맨 위 / 맨 아래 |
| `gi` | 첫 번째 입력 요소에 focus |
| `H` / `L` | history 뒤로 / 앞으로 |
| `J` / `K` | 이전 / 다음 browser tab |
| `t`, `O` | 새 탭 omnibox 열기 |
| `o` | 현재 탭 omnibox 열기 |
| `x` / `X` | 현재 tab 닫기 / 최근 닫은 tab 복원 |
| `r` | 새로고침 |
| `zi` / `zo` / `zz` | 확대 / 축소 / 기본 배율 복원 |
| `Esc` | hint/search/visual/inspect/omnibox를 한 번에 취소 |

Visual의 text 대상을 선택하거나 normal mode에서 `V`로 페이지 전체 text를 선택한 뒤 `h`/`l`은 문자, `b`/`w`/`e`는 단어, `k`/`j`는 줄, `0`/`$`는 줄 경계 단위로 active edge를 조정하고 `o`는 조정할 selection endpoint를 바꿉니다. 조정한 범위에서 `y`/`Y`는 선택 text를 복사합니다. image/link/editable 대상에서는 기존처럼 `y`는 smart copy(image bitmap, link URL, text/value), `Y`는 표시 text, `u`는 link URL, `o`/`O`는 현재/새 tab에서 link 열기, `p`는 editable 대상에 clipboard 붙여넣기, `d`는 DevTools inspect를 실행합니다.

Inspect에서 대상을 선택한 뒤 `y`는 CSS selector, `h`는 outer HTML, `t`는 text를 복사하고 `d`는 DevTools를 엽니다. Electron은 detached Chromium DevTools에서 해당 요소를 바로 선택하고, Tauri는 Safari Web Inspector를 연 뒤 가능한 경우에만 요소 선택을 시도합니다.

`f` hint는 일반 link/button뿐 아니라 ARIA role, `jsaction`, `contenteditable`, open shadow DOM의 상호작용 요소도 탐색합니다.

입력이 완전히 멈춘 경우 `Ctrl-Shift-;`로 현재 tmux client만 안전하게 detach한 뒤 `tmux attach`하면 됩니다. tmux server와 다른 client는 유지됩니다. TWeb은 tmux 내부에서 tmux가 추적하는 `modifyOtherKeys`를 사용하며 실행 중 `pane_key_mode=Ext 2`, 종료 후 `VT10x`로 복원됩니다. Ghostty에만 Kitty keyboard mode가 남고 tmux는 `VT10x`인 protocol 불일치가 기존 입력 고착의 원인이었습니다.

## 구성요소

```text
tweb                 CLI와 tmux pane frontend
twebd                Chromium/profile/page/resource daemon
TWeb Profile Bridge  Chrome profile bootstrap 및 managed Chrome handoff extension
```

배포 package는 unscoped name 충돌을 피하기 위해 `@keyolk/tweb`을 사용합니다.

## 구현 언어

```text
Rust              tweb, twebd, protocol, profile/resource/agent core
C++               CEF/Chromium embedding과 GPU surface export adapter
Objective-C++     macOS IOSurface/Mach/Metal bridge의 최소 경계
Zig               Ghostty upstream renderer/protocol 변경
TypeScript        TWeb Profile Bridge Chrome extension
```

Rust를 core로 선택하지만 memory 절감의 핵심은 언어 자체보다 pane마다 Electron/Node/V8 runtime을
복제하지 않고, Chromium process 하나가 여러 page를 관리하며 GPU/frame/resource buffer를 bounded
ownership으로 유지하는 것입니다.

## 상태

현재 architecture/design 단계입니다. 상세 설계는 [DESIGN.md](DESIGN.md)를 참고하세요.

주요 검증 대상:

1. Ghostty GPU surface fast path
2. Damage-aware Kitty graphics fallback
3. tmux native image lifecycle
4. Browser mode와 한글 IME/input fidelity
5. Chrome extension/profile bootstrap compatibility
6. tmux window-scoped agent resource exchange
7. Remote Chromium/video transport 확장성

## 참고 프로젝트

- [awrit](https://github.com/chase/awrit)
- [cliweb](https://github.com/atomashevic/cliweb)
- [casty](https://github.com/sanohiro/casty)
- [Orca](https://www.onorca.dev/docs)
- [Ghostty](https://github.com/ghostty-org/ghostty)
- [tmux](https://github.com/tmux/tmux)
