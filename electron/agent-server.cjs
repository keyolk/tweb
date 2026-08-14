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

// At startup the pathname is either free or a dead engine's leftover, and rebinding is what
// makes automation work again after a crash — so it is removed unconditionally here. What
// must not happen is the *reverse* order: see `clearOwnedSocket` for the exit path.
function clearStaleSocket(target) {
  try {
    fs.unlinkSync(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function socketIdentity(target) {
  try {
    const stat = fs.lstatSync(target);
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function sameSocketIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

// A pane id can be reused before its old engine notices that its frontend is gone. The new
// engine unlinks the stale pathname and binds its own socket there, while the old server still
// owns the now-unlinked inode. When that old engine exits later, it must not unlink the new
// engine's socket. Device+inode is the socket instance's identity; the pathname is not.
function clearOwnedSocket(target, ownedIdentity) {
  try {
    if (!sameSocketIdentity(socketIdentity(target), ownedIdentity)) return;
    fs.unlinkSync(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

// The name actually handed to bind(2). The socket is bound here and renamed into place, so
// this — not the final name — is what has to fit in sun_path.
function stagingPath(target, pid = process.pid) {
  return `${target}.${pid}.bind`;
}

// `dispatch(method, params)` returns a promise resolving to the JSON result.
function startAgentServer({ dispatch, log = () => {} }) {
  const target = socketPath();
  const staging = stagingPath(target);
  // sun_path is 104 bytes on macOS and 108 on Linux; a silently unbound socket
  // would just look like "agent automation is broken" much later. The staging name is the
  // longer of the two and the one bind sees, so it is what the budget is measured against.
  if (Buffer.byteLength(staging) > 100) {
    console.error(`tweb: agent socket path too long (${staging.length} chars): ${staging}`);
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
  // What we bound, not what the pathname points at later — see `clearOwnedSocket`.
  let ownedIdentity = null;
  // Bind to a private name and rename it into place, rather than binding the shared name
  // directly. libuv unlinks *the path it bound* when the handle closes, and that path is a
  // shared name a successor pane may already own — measured: a second server that rebound
  // `agent-%42.sock` lost its socket the instant the first server closed, so the live pane
  // went unreachable with no error anywhere. After the rename, close() can only ever unlink
  // the staging name, which is nobody's.
  clearStaleSocket(staging);
  server.listen(staging, () => {
    try {
      fs.chmodSync(staging, 0o600);
    } catch (_) {}
    try {
      // Atomic: a client either sees the old socket or ours, never a missing path.
      fs.renameSync(staging, target);
    } catch (error) {
      console.error(`tweb: agent socket rename failed: ${error.message}`);
    }
    try {
      ownedIdentity = socketIdentity(target);
    } catch (error) {
      console.error(`tweb: agent socket identity unreadable: ${error.message}`);
    }
    log(`agent socket ${target}`);
  });

  return {
    path: target,
    close() {
      try {
        server.close();
      } catch (_) {}
      // Only the socket instance we bound. A successor pane that reused this pane id has
      // its own inode under the same name, and unlinking that would take automation away
      // from a live pane.
      clearOwnedSocket(target, ownedIdentity);
    },
  };
}

module.exports = {
  startAgentServer,
  socketPath,
  socketName,
  stagingPath,
  runtimeDir,
  sameSocketIdentity,
  clearOwnedSocket,
};
