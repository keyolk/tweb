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

## 설치

```sh
make install              # ~/.local/bin/tweb
make install PREFIX=/usr/local
make uninstall
```

설치되는 것은 binary뿐입니다. Electron app 코드(`main.cjs`/`preload.cjs` 등 198KB)는
binary에 들어 있고 처음 실행할 때 `~/.cache/tweb/app-<hash>`에 풉니다. directory 이름이
내용 hash라서 binary와 preload가 어긋날 수 없습니다.

Electron **runtime**은 295MB라 binary에 넣지 않습니다. 없으면 첫 실행 때 한 번 받아
(`~/.cache/tweb/electron-<version>`, `SHASUMS256.txt`로 검증) 이후에는 cache에서 씁니다.
workspace 안에서 돌 때는 `electron/node_modules`를, 시스템에 `electron`이 있으면 그것을
먼저 씁니다. 자동 설치를 막으려면 `TWEB_NO_AUTO_INSTALL=1`을, 직접 지정하려면
`TWEB_ELECTRON=<binary>`를 씁니다. cache 위치는 `TWEB_CACHE_DIR`로 바꿉니다.

## 명령

공식 executable은 `tweb`입니다. `twb`는 선택적 alias입니다.

```sh
# 현재 pane에서 열기. 인자 없이 실행하면 open과 같으며 이전 상태를 복원
tweb

# URL을 지정하거나 open 옵션을 사용할 때는 명시적 subcommand 사용
tweb open https://localhost:5173

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
tweb panes
tweb snapshot --pane %3
tweb click a --pane %3
tweb screenshot shot.png --pane %3

# Browser resource 관리
tweb resource list --window @1
tweb resource send r_01K... --to-pane %1

# Chrome profile bootstrap
tweb profile bootstrap chrome

# 지원 환경 진단
tweb doctor
```

## Agent 제어 (CLI · MCP)

터미널에서 FE 작업을 끝내려면 agent도 같은 browser를 몰 수 있어야 합니다. 실행 중인 browser pane은
runtime directory에 unix socket(`agent-%3.sock`)을 열고, `tweb` CLI와 `tweb mcp`가 그 socket에
line-delimited JSON-RPC로 붙습니다. headless 세션을 따로 띄우지 않으므로 **agent가 조작하는 화면이
사용자가 보고 있는 그 화면**입니다.

ref는 `f` hint가 그리는 label과 같은 값입니다. agent가 `@a`를 클릭하면 사용자는 화면에서 `a` badge가
붙어 있던 그 요소가 눌리는 것을 보고, 사람이 화면을 보며 "a 눌러줘"라고 말할 수 있습니다. 별도 좌표계나
번역이 없습니다.

```bash
tweb panes                       # 제어 가능한 browser pane 목록
tweb snapshot                    # 상호작용 요소 + ref (--text로 읽기용 snapshot)
tweb click a                     # 신뢰된 native click (isTrusted=true)
tweb fill s "agent@example.com"  # framework-safe value 설정
tweb select d Green
tweb press Enter --mod shift
tweb wait --selector "#result" --timeout 5000
tweb errors                      # console error만
tweb eval "location.pathname"
tweb tab new https://localhost:5173
tweb diag                        # pane geometry·zoom·frame·input 상태
tweb engine-log --limit 40       # engine debug 줄 (resize·frame 회계)
```

기본 출력은 사람이 읽는 요약이고 `--json`으로 원본을 받습니다. `--pane`은 생략할 수 있습니다 — pane이
하나면 그것을, 여러 개면 **같은 tmux window의 pane**을 씁니다. 다른 window의 browser까지 후보에 넣지
않으므로, window마다 browser를 띄워 두고도 매번 pane id를 조회할 필요가 없습니다.

문제가 page가 아니라 pane 쪽일 때는 `diag`를 봅니다. pane cell/pixel 크기, window content size,
zoom, 마지막 frame 크기와 기대 크기, frame rate, input mode를 한 번에 돌려주므로 "resize를 따라가지
못한다"처럼 화면에서만 보이는 증상을 수치로 확인할 수 있습니다 — frame 크기가 기대 크기와 다르면 그
frame들은 버려지고 있습니다. `engine-log`는 그 판단의 근거가 되는 engine 줄(`resize generation=…`,
`frame dropped got=… want=…`)을 돌려줍니다. 원래 pane의 stderr로만 나가던 것이라, 예전에는 관찰하려면
별도 harness로 pane을 다시 띄워야 했습니다.

`diag`의 `page`는 shortcut runtime 자신의 상태입니다 — 현재 mode와 detail, 열려 있는 picker의 종류·후보
수·입력 중인 label, visual/caret 상태, 잡혀 있는 scroll surface(어느 frame인지 포함), 그리고 `f`/`s`/`v`가
지금 찾아낼 대상 수입니다. preload는 isolated world에서 돌아 `eval`로 볼 수 없으므로 이 경로가 유일한
창구입니다. 예를 들어 `targets.frames`가 1인데 `visual`이 0이면, frame은 인식했지만 그 안에서 고를 것이
없다는 뜻입니다.

`snapshot`은 role·accessible name·value·CSS selector·화면 좌표를 함께 돌려주므로 agent가 확인한
요소를 그대로 test code의 selector로 옮길 수 있습니다. `console`/`errors`는 page가 시작될 때부터
누적된 buffer를 읽으므로, 문제가 발생한 뒤에 물어봐도 늦지 않습니다.

MCP client에는 stdio server로 등록합니다.

```json
{ "mcpServers": { "tweb": { "command": "tweb", "args": ["mcp"] } } }
```

현재 agent socket은 Electron engine에서 제공합니다. Tauri engine은 사용자 조작 경로만 지원합니다.

## Browser engine과 frame policy

`open`과 `split`은 `--engine electron|tauri`를 받습니다. 기본값은 기존 기능을 모두 제공하는 `electron`입니다.

- **Electron**: Chromium offscreen paint 기반입니다. Vimium-style mode, tab/omnibox, visual/inspect, smart copy, detached DevTools 등 현재 TWeb browser 기능을 모두 제공합니다.
- **Tauri (macOS experimental)**: 시스템 `WKWebView`의 native snapshot을 Kitty PNG frame으로 보내므로 별도 Electron/Chromium startup 비용이 없습니다. resize, UTF-8/CSI-u/navigation key, SGR mouse, adaptive frame 전송과 terminal lifecycle을 지원합니다. Electron과 동일한 preload를 공유하므로 Vimium-style modal shortcut, hint/visual/inspect, tab 목록·omnibox·multi-tab, 페이지 검색, zoom, smart copy/paste, browser shortcut ↔ web passthrough 전환도 제공합니다. DevTools는 Safari Web Inspector로 열리며, Chromium 전용 `inspectElement` 좌표 지정은 지원 범위가 제한됩니다.

Electron과 Tauri 모두 열린 tab URL, active tab, tab별 zoom을 tmux window 단위로 저장합니다. `tweb open`처럼 URL을 생략하면 마지막 상태를 복원하고, URL을 명시하면 저장 상태를 무시해 해당 URL 하나로 새로 시작하며 그 상태로 갱신합니다. Electron은 `about:blank`와 내부 loading/안내 page를 저장하지 않으므로 유효한 직전 session을 덮어쓰지 않습니다. 복원할 URL이 없으면 검은 화면 대신 주소 입력 안내를 표시합니다. persistence key는 tmux server 시작 시각과 `window_id`를 사용하므로 session 이름 변경이나 window index 변경의 영향을 받지 않지만, tmux server를 재시작하면 새 key가 만들어집니다.

`--frame-rate N`은 사용자 입력·resize 직후 활동 구간의 최대 frame rate이며 범위는 1–60입니다. 기본 adaptive mode는 terminal 입력·resize 후 700ms 동안 최대값을 사용하고, 이후 1fps로 낮춥니다. 동영상·animation의 지속적인 paint만으로 활동 구간이 연장되지는 않으므로 장시간 재생이 terminal output을 포화시키지 않습니다. PNG frame은 local file transport로 전달해 tmux/Ghostty stream에는 작은 Kitty graphics command만 보내며, writer가 밀리면 중간 frame을 버리고 최신 frame 하나만 유지합니다. `--no-adaptive-frame-rate`를 주면 지정값을 고정하고, `--adaptive-frame-rate`로 기본 정책을 명시할 수 있습니다.

동일한 80×24 tmux pane과 로컬 fixture의 debug build에서 첫 Kitty frame 중앙값(3회)은 Electron 6.084초, Tauri 1.834초였습니다. 이 수치는 현재 개발 환경의 비교값이며 release build·실제 사이트·WebKit cache 상태에 따라 달라집니다.

## Browser 입력 mode

다음 modal shortcut과 mode indicator는 Electron과 Tauri engine이 같은 preload runtime을 공유해 동일하게 동작합니다. engine별 차이는 DevTools 뿐이며, Electron은 detached Chromium DevTools를, Tauri는 Safari Web Inspector를 엽니다.

`Ctrl-;`로 다음 두 mode를 전환합니다.

- **Shortcuts ON**: 입력 요소에 focus가 없을 때 Vimium-style normal mode와 TWeb browser shortcut이 동작합니다. 입력 중에는 normal-mode 키를 가로채지 않으며 `Esc`로 focus를 해제할 수 있습니다. 이때 `Esc`는 engine이 만든 실제 key event로 페이지에 먼저 전달되므로 검색창 자동완성 같은 panel이 함께 닫히고, 페이지가 처리한 뒤에 focus가 해제됩니다. Shortcuts mode의 다른 키는 페이지에 synthetic event로 전달되며, `isTrusted`를 확인하는 사이트는 이를 무시할 수 있습니다.
- **Web passthrough ON**: TWeb shortcut을 모두 끄고, 현재 TWeb pane을 보고 있는 tmux client만 client-local `tweb-pass` table로 전환합니다. tmux prefix/root binding을 우회하고 키·modifier·mouse를 page에 전달합니다. 다른 tmux client와 일반 pane의 key table은 바뀌지 않습니다.

Web passthrough 상태에서도 `Ctrl-;`만 escape hatch로 사용해 Shortcuts mode로 돌아옵니다. `Ctrl-C`도 웹에 전달되므로 TWeb을 종료하려면 먼저 `Ctrl-;`로 Shortcuts mode에 돌아온 뒤 `Ctrl-C`를 누릅니다. TWeb pane을 떠나거나 프로세스가 종료되면 해당 client의 이전 tmux key table을 복원합니다.

`Ctrl-;`는 tmux key table까지 바꾸므로 web app에 오래 머무를 때 적합합니다. 페이지 자체 단축키(피드의 `j`/`k`, player의 `m`)를 잠깐 쓰려면 normal mode에서 `i`로 **insert mode**에 들어갑니다. `Esc`를 제외한 모든 키가 engine이 만든 실제 key event로 페이지에 전달되므로 `isTrusted`를 확인하는 사이트의 단축키도 동작하고, 한글 키도 command 문자로 변환하지 않습니다. `Esc`로 즉시 normal mode로 돌아오며 tmux 설정은 건드리지 않습니다.

focus가 cross-origin iframe(광고·embed)에 들어가면 그 frame의 preload는 shortcut을 처리하지 않습니다. TWeb은 shortcut을 처리할 수 있는 frame을 추적해 그런 경우 main frame으로 키를 보내므로, iframe을 클릭한 뒤에도 `?`나 `f`가 계속 동작합니다.

macOS 또는 Ghostty 자체가 PTY보다 먼저 소비하는 application shortcut은 웹에 전달할 수 없습니다. 예를 들어 기본 `Cmd-T`, `Cmd-W`, `Cmd-+`는 Ghostty 동작이 우선합니다. 반면 terminal에 도달하는 일반 키, Ctrl/Alt/Shift 조합, navigation key와 mouse event는 passthrough 대상입니다.

### Mode indicator

화면 우하단에 현재 mode를 한 글자로 표시합니다: `N` normal, `E` editable/insert, `H` hint, `/` search, `V` visual, `I` inspect, `T` tab 목록, `O` omnibox, `?` shortcut 도움말, `P` web passthrough. 대상 수나 선택 종류처럼 필요한 정보만 옆에 짧게 붙습니다.

IME 조합(한글 등)은 terminal emulator가 자기 layer에 그립니다. Kitty placement를 text 위(`z >= 0`)에
두면 그 layer가 page image에 가려져 조합 중 음절이 보이지 않으므로, image는 text **아래**(`z=-1`)에
둡니다 — pane을 채우는 tmux의 기본 배경 cell은 통과되므로 page는 그대로 보입니다. 입력 요소에 focus가
있으면 terminal cursor를 web caret 위치로 옮기고, 없으면 숨깁니다. 어떤 terminal이 그 cell을 불투명하게
그린다면 `TWEB_IMAGE_Z=0`으로 예전 layering으로 돌아갈 수 있습니다.

첫 tab은 실제 page가 commit되기 전까지 placeholder를 띄웁니다. Chromium은 page가 commit될 때까지
아무것도 paint하지 않는데 실제 site는 그게 수 초 걸립니다 — google.com에서 5.5초를 쟀습니다. placeholder는
0.5초 안에 commit되고, 그 뒤로는 paint holding이 실제 page가 준비될 때까지 그 화면을 유지합니다. 두 번째
이후 tab은 이전 page가 화면에 남아 있으므로 해당되지 않습니다.

pane frontend는 alternate screen에서 돕니다. `tweb open`은 사용자가 쓰던 pane 안에서 시작하므로 그
pane에 남아 있던 shell prompt와 출력이 image 아래로 비쳐 보이기 때문이고, 종료하면 원래 화면이 그대로
돌아옵니다.

image가 text 아래로 내려간 대가로, 예전에는 image에 가려 보이지 않던 Chromium 자신의 stderr 출력이 page
위에 드러납니다. 그래서 engine stderr는 `~/.cache/tweb/logs/engine-<pane>.log`로 보냅니다. 진단 줄은
언제나 engine 안의 ring buffer에도 쌓이므로 `tweb engine-log`로 읽으면 되고, `TWEB_DEBUG=1`을 주면
stderr를 그대로 물려받아 terminal로도 흘립니다.

한글 2벌식 layout에서도 physical key와 자모 `langmap`을 사용하므로 normal/hint/visual/inspect 명령은 영문 layout과 동일하게 동작합니다. 입력 요소가 focus된 `E` mode에서는 한글을 변환하지 않고 그대로 입력합니다.

IME 조합은 browser가 아니라 terminal emulator가 처리하고, 조합 중인 글자는 **terminal cursor 위치**에 그려집니다. Terminal과 page는 서로 다른 font와 좌표계를 쓰고 preedit text도 PTY로 전달되지 않으므로, 둘을 같은 glyph처럼 정확히 겹쳐 그릴 수는 없습니다. 대신 TWeb은 web caret 바로 다음 cell부터 기본 3-cell짜리 조합 영역을 예약하고 terminal cursor를 그 첫 cell에 둡니다. 이 영역은 입력 요소에서 가장 가까운 불투명 배경색을 찾아 반투명하게 사용하며 boundary나 shadow를 그리지 않으므로, page text를 가리는 별도 box보다 입력창의 자연스러운 여백처럼 보입니다. 폭은 `TWEB_IME_SLOT_CELLS`로 바꿀 수 있습니다.

cursor는 block이 아니라 bar(`DECSCUSR 6`)로 요청합니다. block은 자기 cell을 덮어 page의 입력 cursor와 그 옆 글자를 가립니다. 조합 영역은 cell 경계에 맞추고, 행은 caret과 가장 가까운 cell을 사용합니다. 오른쪽 공간이 부족하면 같은 줄의 앞 글자를 덮지 않고 인접 terminal 행으로 피합니다. cell 크기는 pane geometry와 browser zoom에서 계산하므로 zoom, pane resize, tab 전환 뒤에도 영역과 cursor 위치를 다시 맞춥니다.

terminal cursor와 조합 preview를 그리는 것은 emulator이므로 글꼴 크기와 색은 page가 아니라 terminal 설정을 따릅니다. page font와 완전히 같아지지는 않지만, 조합 preview가 기존 page glyph 위에 직접 겹치지는 않습니다. 입력 focus가 사라지면 조합 영역과 terminal cursor도 함께 제거됩니다.

### Shortcuts mode 키

| 키 | 동작 |
| --- | --- |
| `?` | 지원 shortcut 도움말 열기 (`?` 또는 `Esc`로 닫기) |
| `f` / `F` | 화면의 클릭 가능 요소에 hint 표시 / 링크를 새 탭에서 열기 |
| `/`, `n`, `N` | 페이지 검색 (`Enter`로 확정) / 다음 / 이전 결과 |
| `v` / `V` | visual picker로 대상 선택 / 페이지 전체 text를 Visual selection으로 열기 (visual 안에서 `c`는 caret mode, caret에서 `v`는 그 지점부터 선택) |
| `b` | 열린 browser tab 목록 (`j`/`k`, `1`–`9`, `Enter`, `x` 닫기, `Esc`) |
| `I` | inspect picker: 요소 정보·selector 확인 |
| `s` | 스크롤할 내부 영역 선택 — 내부 영역이 잡혀 있으면 mode indicator에 `⇅`가 붙고, `Esc` 또는 `s`의 첫 후보(page)로 복귀합니다 |
| `h` / `l` | 왼쪽 / 오른쪽으로 스크롤 |
| `j` / `k` | 아래 / 위로 스크롤 |
| `d` / `u` | 반 페이지 아래 / 위로 스크롤 |
| `gg` / `G` | 페이지 맨 위 / 맨 아래 |
| `gi` | 첫 번째 입력 요소에 focus |
| `H` / `L` | history 뒤로 / 앞으로 |
| `J` / `K` | 이전 / 다음 browser tab |
| `t`, `O` | 새 탭 fuzzy omnibox 열기 (열린 탭·전체 방문 기록) |
| `o` | 현재 탭 fuzzy omnibox 열기 (현재 URL이 채워진 상태로 시작) |
| `x` / `X` | 현재 tab 닫기 / 최근 닫은 tab 복원 |
| `y` | 현재 page URL 복사 |
| `r` | 새로고침 |
| `zi` / `zo` / `zz` | 확대 / 축소 / 기본 배율 복원 |
| `i` | insert mode: 페이지 자체 단축키 사용 (`Esc`로 복귀) |
| `Esc` | hint/search/visual/inspect/omnibox 취소 · 입력 focus 해제 · 전체화면 해제 |
| `Esc` (normal) | 사이트 자동완성·popup을 outside click으로 닫기 |

Visual의 text 대상을 선택하거나 normal mode에서 `V`로 페이지 전체 text를 선택한 뒤 `h`/`l`은 문자, `b`/`w`/`e`는 단어, `k`/`j`는 줄, `0`/`$`는 줄 경계, `{`/`}`는 문단 단위로 active edge를 조정하고 `o`는 조정할 selection endpoint를 바꿉니다. 조정한 범위에서 `y`/`Y`는 선택 text를 복사합니다. image/link/editable 대상에서는 기존처럼 `y`는 smart copy(image bitmap, link URL, text/value), `Y`는 표시 text, `u`는 link URL, `o`/`O`는 현재/새 tab에서 link 열기, `p`는 editable 대상에 clipboard 붙여넣기, `d`는 DevTools inspect를 실행합니다.

선택의 **시작점**을 옮기려면 `c`로 caret mode로 내려갑니다. selection이 caret 하나로 접히고 위의 motion이 selection을 만들지 않고 caret만 옮기므로, 원하는 지점에서 `v`를 누르면 거기서부터 다시 선택이 시작됩니다 — 문단 중간의 한 단어만 잡을 때 쓰는 흐름입니다. motion은 hint로 고른 블록에 갇히지 않으므로 `}`나 `j`로 다음 text 블록까지 이어서 선택할 수 있고, 선택이 화면을 벗어나면 따라 scroll합니다. caret mode에서 `y`는 caret이 놓인 블록 전체를 복사합니다.

Inspect에서 대상을 선택한 뒤 `y`는 CSS selector, `h`는 outer HTML, `t`는 text를 복사하고 `d`는 DevTools를 엽니다. Electron은 detached Chromium DevTools에서 해당 요소를 바로 선택하고, Tauri는 Safari Web Inspector를 연 뒤 가능한 경우에만 요소 선택을 시도합니다.

omnibox의 방문 기록은 profile 단위 파일에 append되므로 pane과 재시작을 가로질러 공유됩니다. `o`는 현재 URL을 미리 채우므로 그 URL로 필터링된 상태로 열리고, 빈 목록에서 시작하려면 `t`/`O`를 사용합니다.

`f` hint는 일반 link/button뿐 아니라 ARIA role, `jsaction`, `contenteditable`, pointer cursor와 delegated click 영역, open shadow DOM의 상호작용 요소도 탐색합니다. 선택한 대상에는 짧은 outline/ripple feedback을 남깁니다. cross-origin iframe과 광고 frame은 focus 고착을 피하기 위해 바깥 frame 자체를 hint 대상으로 만들지 않습니다.

video의 control bar는 hover에 가려 있으므로, hint 수집 전에 가장 큰 video 위로 pointer를 옮겨 **사이트가 직접 그리는 control**을 띄운 뒤 그 실제 버튼에 hint를 붙입니다. YouTube처럼 자체 control을 쓰는 사이트에서 hint가 가리키는 위치와 모양이 평소 보던 control과 같습니다. 별도 proxy는 script로 접근할 수 없는 브라우저 기본 control(`<video controls>`)에만 사용합니다.

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
