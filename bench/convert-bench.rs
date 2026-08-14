// The ceiling on moving the BGRA->RGBA swap into Rust: what the same 20.7MB frame costs with
// the scalar loop tweb-native ships today, and with the u32 form that autovectorizes. Nothing
// here calls tweb-native — the crate is a prune candidate, and a bench that depends on it
// could not outlive the decision it exists to inform. convert.rs:46's loop is reproduced
// verbatim instead, so the number describes that code.
//
// Build: rustc -O -o /tmp/tweb-convert-bench bench/convert-bench.rs
// Frame size matches DETAIL.md 8.1/8.3: a 1440x900 pane at deviceScaleFactor 2.

use std::time::Instant;

const WIDTH: usize = 2880;
const HEIGHT: usize = 1800;
const BYTES: usize = WIDTH * HEIGHT * 4;
const ITERATIONS: usize = 30;
const WARMUP: usize = 5;

// Verbatim from crates/tweb-native/src/convert.rs convert_full_to_rgba's Bgra arm.
fn swap_scalar(src: &[u8], dst: &mut [u8]) {
    for (i, chunk) in src.chunks_exact(4).enumerate() {
        let off = i * 4;
        dst[off] = chunk[2];
        dst[off + 1] = chunk[1];
        dst[off + 2] = chunk[0];
        dst[off + 3] = chunk[3];
    }
}

// One 32-bit rotate per pixel. LLVM autovectorizes this to NEON on aarch64, so it stands in
// for "what hand-written SIMD would reach" without the unsafe intrinsics: a channel swap is
// pure data movement, so the bound is memory bandwidth rather than instruction selection.
fn swap_u32(src: &[u8], dst: &mut [u8]) {
    for (s, d) in src.chunks_exact(4).zip(dst.chunks_exact_mut(4)) {
        let p = u32::from_ne_bytes([s[0], s[1], s[2], s[3]]);
        let swapped = (p & 0xff00_ff00) | ((p & 0x00ff_0000) >> 16) | ((p & 0x0000_00ff) << 16);
        d.copy_from_slice(&swapped.to_ne_bytes());
    }
}

// The floor: no swap at all, just moving 20.7MB. Anything the swap costs above this is what a
// perfect implementation could still remove.
fn copy_only(src: &[u8], dst: &mut [u8]) {
    dst.copy_from_slice(src);
}

fn bench(name: &str, src: &[u8], dst: &mut [u8], f: fn(&[u8], &mut [u8])) {
    let mut samples = Vec::with_capacity(ITERATIONS);
    for i in 0..(WARMUP + ITERATIONS) {
        let start = Instant::now();
        f(src, dst);
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        if i >= WARMUP {
            samples.push(elapsed);
        }
        std::hint::black_box(&dst[0]);
    }
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!(
        "{:<34} n={} min={:.3}ms p50={:.3}ms p90={:.3}ms max={:.3}ms",
        name,
        samples.len(),
        samples[0],
        samples[samples.len() / 2],
        samples[samples.len() * 9 / 10],
        samples[samples.len() - 1]
    );
}

fn main() {
    let mut src = vec![0u8; BYTES];
    for (i, b) in src.iter_mut().enumerate() {
        *b = (i % 251) as u8;
    }
    let mut dst = vec![0u8; BYTES];

    // Correctness before speed: the fast form has to agree with the shipping one.
    swap_scalar(&src, &mut dst);
    let expected = dst.clone();
    dst.fill(0);
    swap_u32(&src, &mut dst);
    assert_eq!(expected, dst, "swap_u32 disagrees with tweb-native's scalar loop");

    println!("frame {WIDTH}x{HEIGHT} = {BYTES} bytes ({:.1}MB)", BYTES as f64 / 1e6);
    bench("copy only (memcpy floor)", &src, &mut dst, copy_only);
    bench("scalar (tweb-native convert.rs)", &src, &mut dst, swap_scalar);
    bench("u32 (autovectorized)", &src, &mut dst, swap_u32);
}
