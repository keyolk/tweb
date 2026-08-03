"use strict";

class MouseClickState {
  constructor({ intervalMs = 500, distancePx = 4 } = {}) {
    this.intervalMs = intervalMs;
    this.distancePx = distancePx;
    this.active = null;
    this.last = null;
  }

  press(button, x, y, now = Date.now()) {
    const repeated = this.last !== null &&
      this.last.button === button &&
      now - this.last.at >= 0 &&
      now - this.last.at <= this.intervalMs &&
      Math.abs(x - this.last.x) <= this.distancePx &&
      Math.abs(y - this.last.y) <= this.distancePx;
    const count = repeated ? Math.min(3, this.last.count + 1) : 1;
    this.last = { button, x, y, at: now, count };
    this.active = { button, x, y, count, dragged: false };
    return count;
  }

  move(button, x, y) {
    if (this.active === null || this.active.button !== button) return;
    if (Math.abs(x - this.active.x) <= this.distancePx &&
        Math.abs(y - this.active.y) <= this.distancePx) return;
    this.active.dragged = true;
    this.last = null;
  }

  release(button) {
    if (this.active === null || this.active.button !== button) {
      this.active = null;
      this.last = null;
      return { count: 1, dragged: false };
    }
    const result = {
      count: this.active.count,
      dragged: this.active.dragged,
    };
    if (result.dragged) this.last = null;
    this.active = null;
    return result;
  }

  reset() {
    this.active = null;
    this.last = null;
  }
}

module.exports = { MouseClickState };
