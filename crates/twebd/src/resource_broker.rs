//! ResourceBroker 구현.
//!
//! DESIGN.md 섹션 12.3-12.15. immutable resource store, scope, TTL, quota.
//! opaque ID만 사용, caller identity와 capability 확인.

use tweb_core::resource::{ResourceDescriptor, ResourceError, ResourceId, ResourceResult};

/// ResourceBroker 구현체. TODO: 실제 store.
#[derive(Default)]
pub struct ResourceBrokerImpl;

impl ResourceBrokerImpl {
    pub fn new() -> Self {
        Self
    }
}

impl tweb_core::resource::ResourceBroker for ResourceBrokerImpl {
    fn inspect(&self, _id: &ResourceId) -> ResourceResult<ResourceDescriptor> {
        Err(ResourceError::NotFound(_id.0.clone()))
    }

    fn materialize(&self, _id: &ResourceId, _to: &std::path::Path) -> ResourceResult<()> {
        Err(ResourceError::NotFound(_id.0.clone()))
    }

    fn transfer(&self, _id: &ResourceId, _to_host: &str) -> ResourceResult<()> {
        Err(ResourceError::NotFound(_id.0.clone()))
    }

    fn revoke(&self, _id: &ResourceId) -> ResourceResult<()> {
        Err(ResourceError::NotFound(_id.0.clone()))
    }

    fn gc_expired(&self) -> ResourceResult<usize> {
        Ok(0)
    }
}
