"use strict";

// Line-delimited JSON-RPC over a unix socket so `tweb` CLI and the MCP server
// can drive the very browser the user is watching in their pane. The socket
// lives in the runtime directory next to the pane it belongs to; discovery is
// "scan the directory", so no registry has to stay in sync with process death.

const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function runtimeDir() {
  if (process.env.TWEB_RUNTIME_DIR) return process.env.TWEB_RUNTIME_DIR;
  if (process.platform !== "darwin" && process.env.XDG_RUNTIME_DIR) {
    return path.join(process.env.XDG_RUNTIME_DIR, "tweb");
  }
  return path.join(os.tmpdir(), `tweb-${process.getuid?.() ?? 0}`);
}

// tmux pane ids ("%3") are what a user names a pane by, so they make the
// friendliest socket name. Fall back to the pid for a bare terminal.
function socketName() {
  const pane = process.env.TMUX_PANE;
  return pane ? `agent-${pane.replace(/[^%\w.-]/g, "")}.sock` : `agent-pid-${process.pid}.sock`;
}

function socketPath() {
  return process.env.TWEB_AGENT_SOCKET || path.join(runtimeDir(), socketName());
}

function clearStaleSocket(target) {
  try {
    fs.unlinkSync(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

// `dispatch(method, params)` returns a promise resolving to the JSON result.
function startAgentServer({ dispatch, log = () => {} }) {
  const target = socketPath();
  // sun_path is 104 bytes on macOS and 108 on Linux; a silently unbound socket
  // would just look like "agent automation is broken" much later.
  if (Buffer.byteLength(target) > 100) {
    console.error(`tweb: agent socket path too long (${target.length} chars): ${target}`);
    return { path: target, close() {} };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  clearStaleSocket(target);

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        void handleLine(line);
      }
    });
    socket.on("error", () => socket.destroy());

    async function handleLine(line) {
      let request;
      try {
        request = JSON.parse(line);
      } catch (error) {
        return reply({ id: null, error: `malformed request: ${error.message}` });
      }
      try {
        reply({ id: request.id ?? null, result: await dispatch(request.method, request.params || {}) });
      } catch (error) {
        reply({ id: request.id ?? null, error: String(error?.message || error) });
      }
    }

    function reply(payload) {
      if (socket.destroyed) return;
      socket.write(`${JSON.stringify(payload)}\n`);
    }
  });

  // A dead automation socket is worth reporting even without TWEB_DEBUG.
  server.on("error", (error) => console.error(`tweb: agent socket error: ${error.message}`));
  server.listen(target, () => {
    try {
      fs.chmodSync(target, 0o600);
    } catch (_) {}
    log(`agent socket ${target}`);
  });

  return {
    path: target,
    close() {
      try {
        server.close();
      } catch (_) {}
      clearStaleSocket(target);
    },
  };
}

module.exports = { startAgentServer, socketPath, runtimeDir };
