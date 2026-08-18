// write p99 를 33.3ms(30fps 예산) 아래로 내리는 것이 목표다. SHM 은 그것을 native 코드로
// 달성하는 한 방법일 뿐이고, 파일 매체 안에서 같은 목표에 닿는 길이 있는지 먼저 본다.
//
// 8.5 는 "rename 을 유지하는 변형은 전부 같다" 로 닫았지만, 그건 20.7MB 를 통째로 쓰는
// 전제 위에서였다. 예산을 넘기는 것이 write 의 절대량이라면, 줄일 것은 호출 방식이 아니라
// 바이트 수다. 여기서 그 축을 잰다.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const W = 2880, H = 1800, BYTES = W * H * 4;
const N = 60;
const BUDGET = 33.3;

// 실제 페이지에 가까운 픽셀을 만든다. 난수는 압축률을 0 으로 만들어 압축 경로를 부당하게
// 불리하게 만들고, 단색은 반대로 부당하게 유리하게 만든다.
const bgra = Buffer.allocUnsafe(BYTES);
for (let y = 0; y < H; y += 1) {
  const band = (y >> 6) & 7;
  for (let x = 0; x < W; x += 1) {
    const o = (y * W + x) * 4;
    const text = ((x >> 2) ^ (y >> 3)) & 1 && (x % 97) < 40;
    bgra[o] = text ? 32 : 240 - band * 8;
    bgra[o + 1] = text ? 32 : 244 - band * 6;
    bgra[o + 2] = text ? 32 : 248 - band * 4;
    bgra[o + 3] = 255;
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tweb-shrink-"));
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

function bench(label, bytesOut, fn) {
  const ts = [];
  for (let i = 0; i < N; i += 1) {
    const t = process.hrtime.bigint();
    fn(i);
    ts.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  const p50 = q(ts, 0.5), p99 = q(ts, 0.99);
  const verdict = p99 <= BUDGET ? "under budget" : `${((p99 / BUDGET) * 100).toFixed(0)}% of budget`;
  console.log(`${label.padEnd(34)} ${(bytesOut / 1e6).toFixed(1).padStart(5)}MB  `
    + `p50 ${p50.toFixed(2).padStart(7)}ms  p99 ${p99.toFixed(2).padStart(7)}ms  ${verdict}`);
}

const write = (name, buf) => {
  const p = path.join(dir, name);
  fs.writeFileSync(`${p}.tmp`, buf);
  fs.renameSync(`${p}.tmp`, p);
};

console.log(`frame ${W}x${H} = ${(BYTES / 1e6).toFixed(1)}MB, budget ${BUDGET}ms at 30fps\n`);

// 1. 현행.
const rgba = Buffer.allocUnsafe(BYTES);
for (let i = 0; i < BYTES; i += 4) {
  rgba[i] = bgra[i + 2]; rgba[i + 1] = bgra[i + 1]; rgba[i + 2] = bgra[i]; rgba[i + 3] = 255;
}
bench("raw RGBA + rename (ships)", BYTES, () => write("a.rgba", rgba));

// 2. 알파를 뺀다. 오프스크린 프레임은 전부 불투명이므로 채널 하나가 통째로 낭비다.
//    Kitty 는 f=24 (RGB) 를 f=32 와 같은 매체로 받는다.
const rgb = Buffer.allocUnsafe(W * H * 3);
for (let i = 0, j = 0; i < BYTES; i += 4, j += 3) {
  rgb[j] = bgra[i + 2]; rgb[j + 1] = bgra[i + 1]; rgb[j + 2] = bgra[i];
}
bench("RGB, no alpha (f=24)", rgb.length, () => write("b.rgb", rgb));

// 3. zlib. Kitty 는 o=z (deflate) 를 프로토콜 차원에서 받는다 -- 터미널이 풀어준다.
//    CPU 를 디스크와 맞바꾸는 것이라, 압축 시간까지 포함해서 재야 의미가 있다.
const z1 = zlib.deflateSync(rgba, { level: 1 });
bench("raw RGBA, deflate level 1", z1.length, () => {
  write("c.z", zlib.deflateSync(rgba, { level: 1 }));
});
bench("RGB, deflate level 1", zlib.deflateSync(rgb, { level: 1 }).length, () => {
  write("d.z", zlib.deflateSync(rgb, { level: 1 }));
});

fs.rmSync(dir, { recursive: true, force: true });
