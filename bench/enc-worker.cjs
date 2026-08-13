const { parentPort } = require("node:worker_threads");
const zlib = require("node:zlib");
// Assemble a PNG by hand: raw RGBA -> filter-0 scanlines -> deflate -> PNG container.
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePNG(bgra, w, h, level) {
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    const src = y * stride, dst = y * (stride + 1);
    raw[dst] = 0;
    for (let x = 0; x < stride; x += 4) {
      raw[dst+1+x]   = bgra[src+x+2];
      raw[dst+1+x+1] = bgra[src+x+1];
      raw[dst+1+x+2] = bgra[src+x];
      raw[dst+1+x+3] = bgra[src+x+3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w,0); ihdr.writeUInt32BE(h,4);
  ihdr[8]=8; ihdr[9]=6; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0;
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level })), chunk("IEND", Buffer.alloc(0))]);
}
parentPort.on("message", (m) => {
  const t = process.hrtime.bigint();
  const png = encodePNG(Buffer.from(m.buf), m.w, m.h, m.level);
  parentPort.postMessage({ id: m.id, bytes: png.length, ms: Number(process.hrtime.bigint()-t)/1e6 });
});
