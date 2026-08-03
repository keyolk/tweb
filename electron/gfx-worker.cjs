const { mkdirSync, renameSync, unlinkSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { parentPort } = require("node:worker_threads");

const ESC = "\x1b";
const CHUNK = 3072;
const frameFiles = new Set();

function wrapTmuxPassthrough(sequence, origin) {
  const anchored = origin
    ? `${ESC}7${ESC}[${origin.top + 1};${origin.left + 1}H${sequence}${ESC}8`
    : sequence;
  const payload = anchored.split(ESC).join(ESC + ESC);
  return `${ESC}Ptmux;${payload}${ESC}\\`;
}

function writeOutput(data) {
  return new Promise((resolve, reject) => {
    process.stdout.write(data, (error) => error ? reject(error) : resolve());
  });
}

async function writeGfx(header, payload, tmux, origin) {
  let sequence = `${ESC}_G${header}`;
  if (payload) sequence += `;${payload}`;
  sequence += `${ESC}\\`;
  await writeOutput(tmux ? wrapTmuxPassthrough(sequence, origin) : sequence);
}

async function writeDirect(message, png) {
  const payload = png.toString("base64");
  let first = true;
  for (let offset = 0; offset < payload.length; offset += CHUNK) {
    const chunk = payload.slice(offset, offset + CHUNK);
    const more = offset + CHUNK < payload.length;
    const header = first
      ? `${message.header},t=d,q=2${more ? ",m=1" : ""}`
      : `${more ? "m=1," : ""}q=2`;
    first = false;
    await writeGfx(header, chunk, message.tmux, message.origin);
  }
}

async function writeFileFrame(message, png) {
  const stagingPath = `${message.filePath}.tmp`;
  mkdirSync(path.dirname(message.filePath), { recursive: true });
  writeFileSync(stagingPath, png);
  renameSync(stagingPath, message.filePath);
  frameFiles.add(message.filePath);
  const payload = Buffer.from(message.filePath).toString("base64");
  await writeGfx(`${message.header},t=f,q=2`, payload, message.tmux, message.origin);
}

async function writeFrame(message) {
  const png = Buffer.from(message.buffer, message.byteOffset, message.byteLength);
  if (message.transport === "file") {
    try {
      await writeFileFrame(message, png);
      return;
    } catch {
      // Direct transfer is slower but keeps rendering if the frame file cannot be written.
    }
  }
  await writeDirect(message, png);
}

function cleanup() {
  for (const filePath of frameFiles) {
    try { unlinkSync(filePath); } catch {}
    try { unlinkSync(`${filePath}.tmp`); } catch {}
  }
}

process.on("exit", cleanup);
parentPort.on("message", async (message) => {
  try {
    if (message.type === "frame") await writeFrame(message);
    parentPort.postMessage({ type: "ready" });
  } catch (error) {
    parentPort.postMessage({ type: "error", message: error.message });
  }
});
