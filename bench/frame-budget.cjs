// worker 안에서 swap 과 write 가 각각 얼마를 쓰는지, 드랍이 걸리는 그 부하에서 직접 잰다.
// #39 는 "swap 무관, write 가 전부" 로 결론냈지만, 근거는 A/B 의 드랍 수치였다.
// 드랍은 worker 총 시간의 함수이고 두 항목 모두 그 안에 있으므로, A/B 만으로는
// 어느 쪽이 지배하는지 가를 수 없다 -- 33ms 예산 대비 각 항목의 실제 몫을 봐야 한다.
const { rawCommands } = require("../electron/gfx-worker.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const W = 2880, H = 1800;                 // 8.1/8.3/8.4 와 같은 프레임
const BYTES = W * H * 4;
const N = 120;
const bgra = Buffer.allocUnsafe(BYTES);
for (let i = 0; i < BYTES; i += 1) bgra[i] = (i * 31) & 0xff;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tweb-budget-"));
const filePath = path.join(dir, "frame.rgba");
const message = { header: "a=T,i=1", filePath, width: W, height: H };

const q = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

// 실제 출하 경로 전체. 이것이 worker 가 프레임마다 쓰는 시간이다.
const whole = [];
for (let i = 0; i < N; i += 1) {
  const t = process.hrtime.bigint();
  rawCommands(message, bgra);
  whole.push(Number(process.hrtime.bigint() - t) / 1e6);
}

// 같은 부하에서 swap 만. rawCommands 의 나머지가 write 다.
const rgba = Buffer.allocUnsafe(BYTES);
const src32 = new Uint32Array(bgra.buffer, bgra.byteOffset, BYTES >>> 2);
const dst32 = new Uint32Array(rgba.buffer, rgba.byteOffset, BYTES >>> 2);
const { swapU32, swapBytewise } = require("../electron/gfx-worker.cjs");
const swap = [];
for (let i = 0; i < N; i += 1) {
  const t = process.hrtime.bigint();
  swapU32(src32, dst32);
  swap.push(Number(process.hrtime.bigint() - t) / 1e6);
}
const swapB = [];
for (let i = 0; i < N; i += 1) {
  const t = process.hrtime.bigint();
  swapBytewise(bgra, rgba);
  swapB.push(Number(process.hrtime.bigint() - t) / 1e6);
}

const row = (name, xs) =>
  console.log(`${name.padEnd(30)} p50 ${q(xs, 0.5).toFixed(2).padStart(7)}ms  `
    + `p90 ${q(xs, 0.9).toFixed(2).padStart(7)}ms  p99 ${q(xs, 0.99).toFixed(2).padStart(7)}ms`);

console.log(`frame ${W}x${H} = ${(BYTES / 1e6).toFixed(1)}MB, ${N} iterations`);
console.log("30fps budget = 33.3ms per frame\n");
row("whole rawCommands (ships)", whole);
row("  of which: swap u32", swap);
row("  of which: swap bytewise", swapB);
const writeOnly = whole.map((w, i) => w - swap[i]);
row("  of which: write (derived)", writeOnly);

console.log("\nshare of the 33.3ms budget:");
const pct = (v) => `${((v / 33.3) * 100).toFixed(0)}%`;
console.log(`  whole pass p50 ${pct(q(whole, 0.5))}   p99 ${pct(q(whole, 0.99))}`);
console.log(`  swap u32   p50 ${pct(q(swap, 0.5))}   swap bytewise p50 ${pct(q(swapB, 0.5))}`);
console.log(`  write      p50 ${pct(q(writeOnly, 0.5))}   p99 ${pct(q(writeOnly, 0.99))}`);

fs.rmSync(dir, { recursive: true, force: true });
