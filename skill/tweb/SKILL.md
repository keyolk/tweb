---
name: tweb
description: A real Chromium browser in a tmux pane that the user is looking at. Use it to show the user a page beside the conversation (a dev server, a local HTML file you wrote, docs), and to drive the page the user has open — snapshot, click, fill, type, read text, screenshot, eval, console and network — with the `tweb` CLI. Use it when a task needs a browser the user can watch, or when the user says "the page in my browser pane".
---

# tweb

`tweb` runs a real browser inside a tmux pane. You and the user drive the **same** page: there is
no separate headless browser. The user sees every click you make, as you make it. The page runs in
the user's own profile, so it is signed in where the user is signed in.

## Show a page to the user

```sh
tweb split http://localhost:5173      # new browser pane beside yours, in this tmux window
tweb split ./report.html              # a local file works the same; relative paths are fine
tweb panes                            # the pane ids the other commands take (split prints none)
```

`tweb split` needs tmux and returns as soon as the pane is created. The page is still loading at
that point, so run `tweb wait --load` before you read it. `tweb open URL` instead takes over the
current pane, which is your own. Use `split`.

To show something you made, write it to an HTML file and `tweb split` the file.

## Drive the page

```sh
tweb snapshot                         # interactive elements with refs: @a link "Sign in" …
tweb snapshot --text                  # a reading view: also headings, links and text
tweb click a                          # the ref without the @
tweb fill s "agent@example.com"       # sets a value the way the page's framework sees it
tweb type "hello"                     # types into the focused element
tweb press Enter                      # also Tab, Escape, ArrowDown…; --mod shift|control|alt|meta
tweb select d Green                   # pick an <option>
tweb check c / tweb uncheck c
tweb hover h
tweb text a / tweb html a             # read one element
tweb navigate https://example.com     # exits non-zero when the page fails to load
tweb back / tweb forward / tweb reload
tweb wait --selector "#result"        # or --text "Saved", --url /done, --load, --ms 500
tweb eval "document.title"            # JavaScript in the page; prints the result
```

- Refs come from the **latest** `snapshot`. Take a new snapshot after anything that changes the
  page: a navigation, a click that opens a dialog, or new content appearing. A ref from an older
  snapshot can name a different element.
- `snapshot --text` assigns refs too, and they replace the previous ones. After a `--text`
  snapshot, `s` may no longer be the button it was. Take a plain `snapshot` again before you act.
- The refs are the labels the user sees when they press `f` in the pane. When the user says
  "click `sd`", that is the ref `sd`.
- `click` is a trusted native click (`isTrusted` is true), not a synthetic DOM event. `fill` is safe
  to use with React and other frameworks.

## See what happened

```sh
tweb screenshot shot.png              # the frame the pane shows; then read the PNG
tweb full-screenshot page.png         # the whole document, including what is below the fold
tweb errors                           # console errors only
tweb console --limit 50
tweb network --limit 40               # requests with status codes
tweb capture shot.png                 # console, network and a screenshot from one moment
tweb status                           # url, title, loading state, tabs
tweb inspect-element                  # the element the user picked with I (inspect) in the pane
```

The console and network logs are buffers that fill while the pane runs, across navigations. You
can read them after an event, not only before. `tweb console --clear` and `tweb network --clear`
read and then empty the buffer, so the next read shows only what happened after it.

## Tabs, devices, files

```sh
tweb tabs                             # indexes start at 0
tweb tab new http://localhost:3000
tweb tab switch 0
tweb tab close                        # the active tab; or give an index
tweb tab engine chrome                # this tab on another page engine (electron/chrome/webkit);
                                      # the page reloads there, signed out of the old engine's cookies
tweb device "iPhone 12"               # iPad, Pixel 5; `tweb device --reset` to undo
tweb pdf page.pdf
```

## Playbooks: learn a site once

A playbook is what an agent learned about driving one site: a Markdown file per site that the next
session reads instead of working the site out again. tweb only decides where the file lives. You
write it.

```sh
tweb playbook show                    # the playbook for the page in the pane, or where to write one
tweb playbook path                    # the file to read or write (a URL or host also works)
tweb playbook list                    # every site with one
```

- `tweb snapshot` prints `playbook <path>` under the title when the page's site has one. Read that
  file before you act on the page.
- `checkout.coupang.com` uses `coupang.com.md`. A host falls back to its parent domains, and `www.`
  is ignored.
- To learn a flow from the user, ask them to press `gR` in the pane and do it once, then `gR` again.
  You can also run `tweb record start --learn` and `tweb record stop`. The stop pastes the
  timeline path and a request to write the playbook into your pane. Read `timeline.md` and look at
  the keyframes it names.
- After you finish a flow that had no playbook, or one where the playbook was wrong, update it. Do
  this without being asked when the flow took real effort to work out.

What to write:

- The steps in order, each as the thing to look for and what to do with it. Name elements by
  their visible text or role, for example "the 바로구매 button". Do not use snapshot refs, which
  change on every snapshot. Use generated CSS classes only when nothing else identifies the
  element.
- The URLs that skip steps, such as a search URL with its filter parameters.
- How to tell that each step worked, and the traps you met: a dialog, a lazy list, a slow
  redirect.
- The steps that need the user. Mark every step that pays, sends, deletes or submits as
  **ask the user first**, and every password, PIN or one-time code as **the user types it**. A
  playbook is not permission to skip either.

What never goes in a playbook: passwords, PINs, codes, card numbers, tokens, addresses, phone
numbers, order numbers, or any other personal data the timeline shows. Write "the default
address", not the address.

## Which pane

Every command takes `--pane %N`. When you leave it out, tweb chooses the pane as follows:

- If there is one browser pane, tweb uses it.
- If there are several, tweb uses the browser pane in **your** tmux window. Browser panes in other
  windows are never chosen.
- If your window has more than one browser pane, pass `--pane`. Get the ids from `tweb panes`.

Add `--json` to any command for machine-readable output.

## Working beside the user

- The user can see the page and can type into it at any time. Before you act, take a snapshot. Do
  not assume the page is still in the state you left it.
- The page is in the user's signed-in profile. Some actions change the user's data or cannot be
  undone: sending a message, buying, deleting, submitting a form, or changing account settings.
  Ask the user before you do one of these.
- Do not close a pane or tab that you did not open.
- While your page-changing commands run, the pane shows `◐ AGENT <verb>`, so the user knows not to
  type. If the user types or clicks during that time, the pane warns them. `tweb status` reports it
  under `presence`; a `presence.conflictAt` newer than your last command means the user acted
  meanwhile, so take a new snapshot before you continue.
- Some sites need the user's managed Google Chrome, for example Okta device trust. tweb opens those
  sites on its Chrome engine (`--engine chrome`). The same commands work there.

## MCP

`tweb mcp` serves most of these commands as MCP tools over stdio (`tweb_snapshot`, `tweb_click`,
`tweb_fill`, …). Use it when your client prefers tools to shell commands. The tools act on the same
pane in the same way.

## When something is wrong

- `no running tweb browser pane`: no browser pane is open. Open one with `tweb split`.
- A command times out on one page: the page may be busy, or it may be a dialog that needs the
  user. Take a screenshot and look.
- The pane looks wrong (wrong size, frozen, blank): `tweb diag` reports the pane's geometry, frame
  and input state.
