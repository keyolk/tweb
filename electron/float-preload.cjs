"use strict";

// The display window's preload. Floating mode's viewer is an ordinary web page that draws
// relayed frames on a canvas — it never touches the browsed page, so this bridge is
// deliberately narrow: frames in, input out, and nothing else crosses.
//
// Separate from preload.cjs because that one is the *browsed page's* preload and carries
// the whole vimium/agent surface. The viewer is chrome, not content.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("twebFloat", {
  // A frame arrives as JPEG bytes; see float-display.cjs for why JPEG and not PNG.
  onFrame: (handler) => ipcRenderer.on("tweb-float-frame", (_event, bytes) => handler(bytes)),
  // The page's logical size, so the viewer can map a canvas click back onto the document.
  onPageSize: (handler) => ipcRenderer.on("tweb-float-page-size", (_event, size) => handler(size)),
  input: (kind, data) => ipcRenderer.send("tweb-float-input", kind, data),
  resized: (size) => ipcRenderer.send("tweb-float-resized", size),
});
