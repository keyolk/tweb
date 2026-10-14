// Every pass over a snapshot's pixels, off the main thread.
//
// The snapshot completion runs on the main thread, which is also the thread that delivers keys
// and mouse events to the page. Measured on the old Tauri engine: re-encoding a 2880x1800
// snapshot there cost 37-51ms per frame and held every input for that long. So the main thread
// only copies the CGImage's bytes out (~1.5ms) and this thread does the rest: packing, the
// damage diff, and the write to fd 3.
//
// The diff is also what makes polling affordable. WebKit has no paint event, so the host takes
// snapshots at the pane's frame rate; an unchanged one is dropped here and costs the Electron
// side nothing. A changed one carries only its dirty box, so a blinking caret is a few kilobytes
// on the pipe rather than 20MB.

use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::os::fd::FromRawFd;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::OnceLock;

/// Where each channel sits in a captured 32-bit pixel, from the CGImage's alpha position and
/// byte order. WebKit hands back little-endian premultiplied-first (BGRA in memory), which is
/// also what Electron's `nativeImage.createFromBitmap` takes — but the layout is read, not assumed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChannelOrder {
    Rgba,
    Bgra,
    Argb,
    Abgr,
}

pub struct Capture {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub bytes_per_row: usize,
    pub order: ChannelOrder,
}

pub enum Job {
    /// A frame for the pane. `force` sends it even if nothing changed (Electron's
    /// `invalidate()` always yields a paint, and main.cjs relies on that).
    Paint {
        view: u32,
        capture: Capture,
        force: bool,
    },
    /// A one-off capture answering a request (capturePage, copy image): always whole.
    Capture { req: u64, capture: Option<Capture> },
    /// Any other bytes answering a request (a PDF).
    Bytes { req: u64, bytes: Option<Vec<u8>> },
    /// The view is gone or resized: its previous frame no longer means anything.
    Forget { view: u32 },
}

pub const KIND_PAINT: u32 = 1;
pub const KIND_CAPTURE: u32 = 2;
pub const KIND_BYTES: u32 = 3;
const MAGIC: u32 = 0x5246_5754; // "TWFR"
pub const HEADER_LEN: usize = 56;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

static SENDER: OnceLock<Sender<Job>> = OnceLock::new();

/// When each view's picture last actually changed, written by the pixel thread (the only place
/// that knows) and read by the snapshot clock on the main thread (see `app::tick`).
static LAST_CHANGE: std::sync::Mutex<Option<HashMap<u32, std::time::Instant>>> =
    std::sync::Mutex::new(None);

pub fn last_change(view: u32) -> Option<std::time::Instant> {
    LAST_CHANGE.lock().ok()?.as_ref()?.get(&view).copied()
}

fn note_change(view: u32) {
    if let Ok(mut map) = LAST_CHANGE.lock() {
        map.get_or_insert_with(HashMap::new)
            .insert(view, std::time::Instant::now());
    }
}

pub fn submit(job: Job) {
    if let Some(sender) = SENDER.get() {
        let _ = sender.send(job);
    }
}

pub fn start() {
    let (sender, receiver) = mpsc::channel();
    if SENDER.set(sender).is_err() {
        return;
    }
    std::thread::Builder::new()
        .name("tweb-webkit-pixels".into())
        .spawn(move || run(receiver))
        .expect("pixel thread starts");
}

fn run(receiver: Receiver<Job>) {
    // fd 3 is opened by the Electron engine as a pipe. Owned here for the life of the process.
    let mut out = unsafe { File::from_raw_fd(3) };
    let mut previous: HashMap<u32, (u32, u32, Vec<u8>)> = HashMap::new();
    while let Ok(job) = receiver.recv() {
        // Only the newest paint per view is worth sending; older ones queued behind a slow
        // write are already stale.
        let job = match job {
            Job::Paint { view, .. } => newest_paint(&receiver, view, job),
            other => other,
        };
        let result = match job {
            Job::Paint {
                view,
                capture,
                force,
            } => {
                let started = std::time::Instant::now();
                let Some(pixels) = pack_bgra(&capture) else {
                    continue;
                };
                let (width, height) = (capture.width, capture.height);
                let dirty = match previous.get(&view) {
                    Some((w, h, old)) if *w == width && *h == height => {
                        dirty_rect(old, &pixels, width, height)
                    }
                    _ => Some(Rect {
                        x: 0,
                        y: 0,
                        width,
                        height,
                    }),
                };
                if dirty.is_some() {
                    note_change(view);
                }
                let dirty = match (dirty, force) {
                    (Some(rect), _) => rect,
                    (None, true) => Rect {
                        x: 0,
                        y: 0,
                        width: 0,
                        height: 0,
                    },
                    (None, false) => continue,
                };
                let payload = crop(&pixels, width, dirty);
                previous.insert(view, (width, height, pixels));
                let processed = started.elapsed().as_secs_f64() * 1000.0;
                let result = write_record(
                    &mut out,
                    KIND_PAINT,
                    view,
                    0,
                    (width, height),
                    dirty,
                    &payload,
                );
                crate::protocol::profile(format!(
                    "paint view={view} {}x{} bytes={} process={processed:.1}ms write={:.1}ms",
                    dirty.width,
                    dirty.height,
                    payload.len(),
                    started.elapsed().as_secs_f64() * 1000.0 - processed
                ));
                result
            }
            Job::Capture { req, capture } => {
                let packed = capture.as_ref().and_then(pack_bgra);
                let (width, height) = capture
                    .as_ref()
                    .filter(|_| packed.is_some())
                    .map_or((0, 0), |c| (c.width, c.height));
                let whole = Rect {
                    x: 0,
                    y: 0,
                    width,
                    height,
                };
                write_record(
                    &mut out,
                    KIND_CAPTURE,
                    0,
                    req,
                    (width, height),
                    whole,
                    packed.as_deref().unwrap_or_default(),
                )
            }
            Job::Bytes { req, bytes } => {
                let empty = Rect {
                    x: 0,
                    y: 0,
                    width: 0,
                    height: 0,
                };
                write_record(
                    &mut out,
                    KIND_BYTES,
                    0,
                    req,
                    (0, 0),
                    empty,
                    bytes.as_deref().unwrap_or_default(),
                )
            }
            Job::Forget { view } => {
                previous.remove(&view);
                Ok(())
            }
        };
        if result.is_err() {
            // The engine closed the pipe: it is gone.
            std::process::exit(0);
        }
    }
}

fn newest_paint(receiver: &Receiver<Job>, view: u32, first: Job) -> Job {
    let mut newest = first;
    let mut force = matches!(newest, Job::Paint { force: true, .. });
    let mut held = Vec::new();
    while let Ok(next) = receiver.try_recv() {
        match next {
            Job::Paint {
                view: v,
                capture,
                force: f,
            } if v == view => {
                force |= f;
                newest = Job::Paint {
                    view,
                    capture,
                    force,
                };
            }
            other => held.push(other),
        }
    }
    // Anything else that was queued is handled right after, in order. Re-sending to ourselves
    // keeps it on the same queue without a second buffer.
    if let Some(sender) = SENDER.get() {
        for job in held {
            let _ = sender.send(job);
        }
    }
    newest
}

fn write_record(
    out: &mut File,
    kind: u32,
    view: u32,
    req: u64,
    (width, height): (u32, u32),
    rect: Rect,
    payload: &[u8],
) -> std::io::Result<()> {
    let mut header = [0u8; HEADER_LEN];
    let words = [
        MAGIC,
        kind,
        view,
        width,
        height,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        0,
    ];
    for (index, word) in words.iter().enumerate() {
        header[index * 4..index * 4 + 4].copy_from_slice(&word.to_le_bytes());
    }
    header[40..48].copy_from_slice(&req.to_le_bytes());
    header[48..56].copy_from_slice(&(payload.len() as u64).to_le_bytes());
    out.write_all(&header)?;
    out.write_all(payload)
}

/// Tightly packed BGRA, premultiplied — the layout `nativeImage.createFromBitmap` reads on
/// macOS. Row padding is dropped and the channels are moved into place in one pass.
pub fn pack_bgra(capture: &Capture) -> Option<Vec<u8>> {
    let width = capture.width as usize;
    let height = capture.height as usize;
    let row_bytes = width.checked_mul(4)?;
    let needed = capture
        .bytes_per_row
        .checked_mul(height.checked_sub(1)?)?
        .checked_add(row_bytes)?;
    if capture.bytes_per_row < row_bytes || capture.bytes.len() < needed {
        return None;
    }
    let (b, g, r, a) = match capture.order {
        ChannelOrder::Bgra => (0, 1, 2, 3),
        ChannelOrder::Rgba => (2, 1, 0, 3),
        ChannelOrder::Argb => (3, 2, 1, 0),
        ChannelOrder::Abgr => (1, 2, 3, 0),
    };
    let mut out = Vec::with_capacity(row_bytes * height);
    for row in capture.bytes.chunks(capture.bytes_per_row).take(height) {
        if capture.order == ChannelOrder::Bgra {
            out.extend_from_slice(&row[..row_bytes]);
            continue;
        }
        for pixel in row[..row_bytes].as_chunks::<4>().0 {
            out.extend_from_slice(&[pixel[b], pixel[g], pixel[r], pixel[a]]);
        }
    }
    Some(out)
}

/// The box that changed between two frames of the same size, or None if nothing did.
/// Rows are compared whole first, so an unchanged frame costs one pass of memcmp.
pub fn dirty_rect(old: &[u8], new: &[u8], width: u32, height: u32) -> Option<Rect> {
    let stride = width as usize * 4;
    if old.len() != new.len() || stride == 0 {
        return Some(Rect {
            x: 0,
            y: 0,
            width,
            height,
        });
    }
    let rows = (0..height as usize).filter(|row| {
        let span = row * stride..(row + 1) * stride;
        old[span.clone()] != new[span]
    });
    let mut rows = rows.peekable();
    let top = *rows.peek()?;
    let bottom = rows.last().unwrap_or(top);
    let mut left = width as usize;
    let mut right = 0usize;
    for row in top..=bottom {
        let a = &old[row * stride..(row + 1) * stride];
        let b = &new[row * stride..(row + 1) * stride];
        if a == b {
            continue;
        }
        if let Some(first) =
            (0..width as usize).find(|&x| a[x * 4..x * 4 + 4] != b[x * 4..x * 4 + 4])
        {
            left = left.min(first);
        }
        if let Some(last) =
            (0..width as usize).rfind(|&x| a[x * 4..x * 4 + 4] != b[x * 4..x * 4 + 4])
        {
            right = right.max(last);
        }
    }
    Some(Rect {
        x: left as u32,
        y: top as u32,
        width: (right + 1 - left) as u32,
        height: (bottom + 1 - top) as u32,
    })
}

/// The rows of `rect`, each `rect.width` pixels, back to back.
pub fn crop(pixels: &[u8], width: u32, rect: Rect) -> Vec<u8> {
    let stride = width as usize * 4;
    let mut out = Vec::with_capacity(rect.width as usize * rect.height as usize * 4);
    for row in rect.y..rect.y + rect.height {
        let start = row as usize * stride + rect.x as usize * 4;
        out.extend_from_slice(&pixels[start..start + rect.width as usize * 4]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capture(bytes: Vec<u8>, bytes_per_row: usize, order: ChannelOrder) -> Capture {
        Capture {
            bytes,
            width: 2,
            height: 2,
            bytes_per_row,
            order,
        }
    }

    #[test]
    fn packs_rows_without_padding_into_bgra() {
        let bytes = vec![
            1, 2, 3, 255, 11, 12, 13, 255, 0, 0, 0, 0, //
            21, 22, 23, 255, 31, 32, 33, 255, 9, 9, 9, 9,
        ];
        let packed = pack_bgra(&capture(bytes.clone(), 12, ChannelOrder::Bgra)).unwrap();
        assert_eq!(
            packed,
            vec![1, 2, 3, 255, 11, 12, 13, 255, 21, 22, 23, 255, 31, 32, 33, 255]
        );
        let swapped = pack_bgra(&capture(bytes, 12, ChannelOrder::Rgba)).unwrap();
        assert_eq!(&swapped[..4], &[3, 2, 1, 255]);
        let argb = pack_bgra(&capture([255, 3, 2, 1].repeat(4), 8, ChannelOrder::Argb)).unwrap();
        assert_eq!(&argb[..4], &[1, 2, 3, 255]);
    }

    #[test]
    fn refuses_a_capture_shorter_than_its_geometry() {
        assert!(pack_bgra(&capture(vec![0; 15], 8, ChannelOrder::Bgra)).is_none());
        assert!(pack_bgra(&capture(vec![0; 16], 4, ChannelOrder::Bgra)).is_none());
    }

    #[test]
    fn dirty_rect_bounds_exactly_the_changed_pixels() {
        let (w, h) = (8u32, 6u32);
        let old = vec![0u8; (w * h * 4) as usize];
        assert_eq!(dirty_rect(&old, &old, w, h), None);
        let mut new = old.clone();
        for (x, y) in [(2u32, 1u32), (5, 3)] {
            new[((y * w + x) * 4) as usize] = 7;
        }
        assert_eq!(
            dirty_rect(&old, &new, w, h),
            Some(Rect {
                x: 2,
                y: 1,
                width: 4,
                height: 3
            })
        );
        let patch = crop(
            &new,
            w,
            Rect {
                x: 2,
                y: 1,
                width: 4,
                height: 3,
            },
        );
        assert_eq!(patch.len(), 4 * 3 * 4);
        assert_eq!(patch[0], 7);
    }
}
