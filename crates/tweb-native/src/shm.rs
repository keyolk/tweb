//! Persistent POSIX shared-memory ring.
//!
//! DESIGN.md 섹션 7.3. 매 paint shm_open/ftruncate/mmap 금지.
//! page 생성 시 2~3개 mapped buffer preallocate, resize 때만 교체.
//! bounded pool로 SHM name 재사용.
//!
//! macOS: `shm_open` (name `/tweb-<id>`).
//! Linux: `memfd_create` 또는 `shm_open`.

use parking_lot::Mutex;
use std::collections::HashMap;
use tweb_core::geometry::PixelSize;
use tweb_core::page::PageId;

/// SHM buffer.
pub struct ShmBuffer {
    /// SHM name (macOS: `/tweb-<id>`, 전송 시 terminal에 알려줌).
    pub name: String,
    /// mmap'd pointer.
    pub ptr: *mut u8,
    /// buffer 크기 (byte).
    pub size: usize,
    /// 현재 write된 byte.
    pub len: usize,
}

unsafe impl Send for ShmBuffer {}
unsafe impl Sync for ShmBuffer {}

impl ShmBuffer {
    /// SHM 생성 또는 재사용.
    pub fn create(name: &str, size: usize) -> std::io::Result<Self> {
        // TODO: 실제 shm_open + ftruncate + mmap.
        // 현재는 placeholder — heap allocation으로 동작 검증.
        // 실제 SHM 구현 시 mmap'd pointer를 반환.
        let data = vec![0u8; size];
        let ptr = data.as_ptr() as *mut u8;
        std::mem::forget(data); // SHM처럼 수명 관리 (placeholder).
        Ok(Self {
            name: name.to_string(),
            ptr,
            size,
            len: 0,
        })
    }

    /// buffer에 pixel data write.
    pub fn write(&mut self, data: &[u8]) {
        let len = data.len().min(self.size);
        unsafe {
            std::ptr::copy_nonoverlapping(data.as_ptr(), self.ptr, len);
        }
        self.len = len;
    }

    /// buffer 해제.
    pub fn destroy(self) {
        // TODO: munmap + shm_unlink.
        // placeholder: heap allocation이므로 Vec이 drop되게 둠.
        // (현재 구현은 heap 기반 placeholder, 실제 SHM 구현 시 munmap 호출)
        let _ = self.ptr;
    }
}

/// SHM ring. page마다 2~3개 buffer 순환.
pub struct ShmRing {
    pub page_id: PageId,
    pub buffers: Vec<ShmBuffer>,
    /// 현재 write buffer index.
    current: usize,
    /// buffer 크기.
    buffer_size: usize,
}

impl ShmRing {
    /// ring 생성. buffer_count개의 buffer를 preallocate.
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

    /// 다음 write buffer 획득 (round-robin).
    pub fn next_buffer(&mut self) -> Option<&mut ShmBuffer> {
        if self.buffers.is_empty() {
            return None;
        }
        let idx = self.current;
        self.current = (self.current + 1) % self.buffers.len();
        Some(&mut self.buffers[idx])
    }

    /// viewport resize 시 buffer 교체.
    pub fn resize(&mut self, viewport: PixelSize) -> std::io::Result<()> {
        let new_size = viewport.rgba_bytes();
        if new_size == self.buffer_size {
            return Ok(());
        }
        // 기존 buffer 해제, 새 buffer 생성.
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

    /// 현재 buffer 크기.
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

/// page별 SHM ring 관리.
pub struct ShmPool {
    rings: Mutex<HashMap<PageId, ShmRing>>,
}

impl ShmPool {
    pub fn new() -> Self {
        Self {
            rings: Mutex::new(HashMap::new()),
        }
    }

    /// page의 ring 가져오기 또는 생성.
    pub fn get_or_create(&self, page_id: PageId, viewport: PixelSize) -> std::io::Result<()> {
        let mut rings = self.rings.lock();
        if let std::collections::hash_map::Entry::Vacant(entry) = rings.entry(page_id) {
            let ring = ShmRing::new(page_id, viewport, 2)?;
            entry.insert(ring);
        }
        Ok(())
    }

    /// page의 ring에 pixel data write.
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

    /// page 제거.
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
