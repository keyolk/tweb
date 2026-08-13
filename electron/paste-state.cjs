"use strict";

// Bracketed paste(ESC[200~ … ESC[201~) reassembly.
//
// Cmd-V never arrives as a key: Ghostty emits no PTY encoding for Cmd combos, so
// `paste_from_clipboard` writing the clipboard into the PTY is the whole event.
// With DECSET 2004 on (see tweb-pane terminal_setup) the terminal wraps that
// write in brackets, and the body between them is the text to paste.
//
// The body is arbitrary bytes — it can contain ESC, and it arrives split across
// however many read() chunks the PTY hands over — so it cannot be matched by the
// prefix regexes that parse key sequences. This holds the state instead.

const START = Buffer.from("\x1b[200~", "latin1");
const END = Buffer.from("\x1b[201~", "latin1");
// A lost closing bracket would otherwise swallow every later keystroke.
const DEFAULT_LIMIT = 1 << 20;

class PasteState {
  constructor({ limit = DEFAULT_LIMIT } = {}) {
    this.limit = limit;
    this.body = null;
  }

  get active() {
    return this.body !== null;
  }

  /** True when `buffer` starts a paste; the caller drops the opening bracket. */
  begins(buffer) {
    return buffer.length >= START.length && buffer.subarray(0, START.length).equals(START);
  }

  start() {
    this.body = Buffer.alloc(0);
  }

  /**
   * Feed a chunk while a paste is open. Returns `{ text, rest }` once the
   * closing bracket lands — `text` is the paste body and `rest` is the input
   * after it — or null while the body is still incomplete or was dropped for
   * exceeding the limit.
   */
  push(chunk) {
    // The closing bracket can straddle a chunk boundary, so rescan from far
    // enough back in the accumulated body to catch a split marker.
    const from = Math.max(0, this.body.length - END.length + 1);
    this.body = Buffer.concat([this.body, chunk]);
    const end = this.body.indexOf(END, from);
    if (end < 0) {
      if (this.body.length > this.limit) {
        this.body = null;
        return { text: null, rest: Buffer.alloc(0), dropped: true };
      }
      return null;
    }
    const text = this.body.subarray(0, end).toString("utf8");
    const rest = Buffer.from(this.body.subarray(end + END.length));
    this.body = null;
    return { text, rest, dropped: false };
  }
}

module.exports = { PasteState, PASTE_START: START, PASTE_END: END };
