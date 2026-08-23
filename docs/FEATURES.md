# Features

TWeb's headline features — the things that make it more than a browser in a terminal.

## Floating mode

Press `w` to detach the page from the tmux pane and show it as an OS desktop window.
The page keeps running in the same webContents — history, scroll position, form
state, cookies, everything carries over. Press `w` again to pin it back.

```
tmux pane (normal)          tmux pane (floating)
┌───────────────┐           ┌───────────────┐
│ $ vim         │           │ $ vim         │   ┌──────────────┐
│               │           │               │   │  OS window   │
│               │           │               │   │  (page)      │
└───────────────┘           └───────────────┘   └──────────────┘
```

### What floats and what stays

| Stays with the tmux pane | Floats to the OS window |
|---|---|
| Shell, agent, editor | The browsed page |
| tmux session, window, pane | Input (mouse, keyboard, scroll) |
| Frame rate and visibility | Audio |

The terminal does not float. Floating is a *view* mode, not a *session* mode: the
tmux window is still the workspace, and the floating page is a guest surface on
the desktop, sized and positioned independently.

### Fullscreen

The command palette's **Fullscreen** action opens the float viewer in OS fullscreen
on a different monitor than the terminal — so the terminal stays visible and
operable while the page fills the other screen. On a single-monitor setup, the
same monitor is used.

Fullscreen preserves terminal focus: the viewer window opens with `showInactive`
so the terminal keeps receiving keystrokes. Closing the float (`w`) restores tmux
selection to the original pane without withdrawing the terminal.

### Why relay frames instead of showing the tab

Chromium composites a webContents either into an offscreen `paint` stream or onto
a native surface, never both. Showing the offscreen window directly produces "No
content under offscreen mode". So the frames the pane is already painting are
encoded once more as JPEG and drawn on a canvas in an ordinary visible window,
and that window's input is forwarded back with `sendInputEvent`. The tab itself
never becomes visible, which is what keeps the frames coming at all.

## Command palette

Press `c` to open a fuzzy-search menu of actions at the bottom-right of the pane.

The palette is for actions that do not have a dedicated key — the ones a new user
would not discover otherwise. Each entry is a label and a one-shot action: type
letters to filter, and a unique match runs immediately. `j`/`k` + `Enter` is the
fallback when the filter leaves more than one entry.

### Current entries

| Label | Action |
|---|---|
| Open in Chrome | Hands the current tab's URL to Chrome |
| Fullscreen | Opens the float viewer in OS fullscreen on another monitor |

Actions that already have keys (`w` for float, `f` for hint picker, `b` for tab
list, etc.) are deliberately excluded — the palette is not a shortcut cheatsheet.

## Agent control

An agent drives the very page the user is looking at, over a per-pane unix socket,
with no separate headless session. The agent sees what the user sees, clicks where
the user would click, and the user watches it happen in real time.

```sh
tweb panes                          # list browser panes
tweb snapshot --pane %3             # get the page's accessibility tree
tweb click a --pane %3              # click the first element matching "a"
tweb screenshot shot.png --pane %3  # capture the current frame
tweb eval "document.title" --pane %3
tweb console --pane %3              # recent console output
tweb network --pane %3              # recent network requests
```

The agent socket is per-pane, so multiple agents can drive multiple panes without
cross-talk. Every method that touches the page (`snapshot`, `click`, `screenshot`,
`eval`, `console`) goes through the same socket; methods that are pure bookkeeping
(`panes`, `tabs`, `status`) do not.
