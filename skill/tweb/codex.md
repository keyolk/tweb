
## Codex

Run `tweb` with escalated permissions, outside the sandbox. Every command reaches the browser
through a unix socket in tweb's runtime directory, and `tweb split` asks tmux which pane you are
in. The sandbox can block both. When it does, a command fails as if no pane were open, even while
the user can see one.
