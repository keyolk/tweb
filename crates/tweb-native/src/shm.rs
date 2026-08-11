//! Persistent POSIX shared-memory ring.
//!
//! DESIGN.md section 7.3. Never shm_open/ftruncate/mmap per paint.
//! Preallocate 2–3 mapped buffers when the page is created, and swap them only on resize.
//! SHM names are reused from a bounded pool.
//!
//! macOS: `shm_open` (name `/tweb-<id>`).
//! Linux: `memfd_create` or `shm_open`.

use parking_lot::Mutex;
use std::collections::HashMap;
use tweb_core::geometry::PixelSize;
use tweb_core::page::PageId;

/// SHM buffer.
pub struct ShmBuffer {
    /// The SHM name (macOS: `/tweb-<id>`; told to the terminal on transfer).
    pub name: String,
    /// mmap'd pointer.
    pub ptr: *mut u8,
    /// The buffer size, in bytes.
    pub size: usize,
    /// How many bytes are currently written.
    pub len: usize,
}

unsafe impl Send for ShmBuffer {}
unsafe impl Sync for ShmBuffer {}

impl ShmBuffer {
    /// Creates or reuses an SHM segment.
    pub fn create(name: &str, size: usize) -> std::io::Result<Self> {
        // TODO: real shm_open + ftruncate + mmap.
        // A placeholder for now — a heap allocation, enough to verify the behaviour.
        // The real SHM implementation will return an mmap'd pointer.
        let data = vec![0u8; size];
        let ptr = data.as_ptr() as *mut u8;
        std::mem::forget(data); // Lifetime managed like SHM would be (placeholder).
        Ok(Self {
            name: name.to_string(),
            ptr,
            size,
            len: 0,
        })
    }

    /// Writes pixel data into the buffer.
    pub fn write(&mut self, data: &[u8]) {
        let len = data.len().min(self.size);
        unsafe {
            std::ptr::copy_nonoverlapping(data.as_ptr(), self.ptr, len);
        }
        self.len = len;
    }

    /// Releases the buffer.
    pub fn destroy(self) {
        // TODO: munmap + shm_unlink.
        // placeholder: it is a heap allocation, so the Vec is simply left to drop.
        // (The current implementation is heap-based; the real SHM one will call munmap.)
        let _ = self.ptr;
    }
}

/// SHM ring. Cycles through 2–3 buffers per page.
pub struct ShmRing {
    pub page_id: PageId,
    pub buffers: Vec<ShmBuffer>,
    /// The index of the current write buffer.
    current: usize,
    /// The buffer size.
    buffer_size: usize,
}

impl ShmRing {
    /// Creates the ring, preallocating buffer_count buffers.
    pub fn new(page_id: PageId, viewport: PixelSize, buffer_count: usize) -> std::io::Result<Self> {
        let buffer_size = viewport.rgba_bytes();
        let mut buffers = Vec::with_capacity(buffer_count);
        for i in 0..buffer_count {
            let name = format!("/tweb-{}-{}", page_id.0.as_simple(), i);
            buffers.push(ShmBuffer::create(&name, buffer_size)?);
        }
        Ok(Self {
            page_id,
            buffers,
            current: 0,
            buffer_size,
        })
    }

    /// Takes the next write buffer (round-robin).
    pub fn next_buffer(&mut self) -> Option<&mut ShmBuffer> {
        if self.buffers.is_empty() {
            return None;
        }
        let idx = self.current;
        self.current = (self.current + 1) % self.buffers.len();
        Some(&mut self.buffers[idx])
    }

    /// Swaps the buffers on a viewport resize.
    pub fn resize(&mut self, viewport: PixelSize) -> std::io::Result<()> {
        let new_size = viewport.rgba_bytes();
        if new_size == self.buffer_size {
            return Ok(());
        }
        // Release the existing buffers, create new ones.
        let old_buffers = std::mem::take(&mut self.buffers);
        for buf in old_buffers {
            buf.destroy();
        }
        let count = self.buffers.len().max(2);
        for i in 0..count {
            let name = format!("/tweb-{}-{}", self.page_id.0.as_simple(), i);
            self.buffers.push(ShmBuffer::create(&name, new_size)?);
        }
        self.buffer_size = new_size;
        self.current = 0;
        Ok(())
    }

    /// The current buffer size.
    pub fn buffer_size(&self) -> usize {
        self.buffer_size
    }
}

impl Drop for ShmRing {
    fn drop(&mut self) {
        let buffers = std::mem::take(&mut self.buffers);
        for buf in buffers {
            buf.destroy();
        }
    }
}

/// Manages one SHM ring per page.
pub struct ShmPool {
    rings: Mutex<HashMap<PageId, ShmRing>>,
}

impl ShmPool {
    pub fn new() -> Self {
        Self {
            rings: Mutex::new(HashMap::new()),
        }
    }

    /// Fetches or creates a page's ring.
    pub fn get_or_create(&self, page_id: PageId, viewport: PixelSize) -> std::io::Result<()> {
        let mut rings = self.rings.lock();
        if let std::collections::hash_map::Entry::Vacant(entry) = rings.entry(page_id) {
            let ring = ShmRing::new(page_id, viewport, 2)?;
            entry.insert(ring);
        }
        Ok(())
    }

    /// Writes pixel data into a page's ring.
    pub fn write(&self, page_id: PageId, data: &[u8]) -> std::io::Result<()> {
        let mut rings = self.rings.lock();
        if let Some(ring) = rings.get_mut(&page_id) {
            if let Some(buf) = ring.next_buffer() {
                buf.write(data);
            }
        }
        Ok(())
    }

    /// page resize.
    pub fn resize(&self, page_id: PageId, viewport: PixelSize) -> std::io::Result<()> {
        let mut rings = self.rings.lock();
        if let Some(ring) = rings.get_mut(&page_id) {
            ring.resize(viewport)?;
        }
        Ok(())
    }

    /// Removes a page.
    pub fn remove(&self, page_id: &PageId) {
        let mut rings = self.rings.lock();
        rings.remove(page_id);
    }
}

impl Default for ShmPool {
    fn default() -> Self {
        Self::new()
    }
}
