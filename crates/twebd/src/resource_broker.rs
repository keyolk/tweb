//! The ResourceBroker implementation.
//!
//! DESIGN.md sections 12.3–12.15. Immutable resource store, scope, TTL, quota.
//! Opaque IDs only, with the caller's identity and capability checked.

use tweb_core::resource::{ResourceDescriptor, ResourceError, ResourceId, ResourceResult};

/// The ResourceBroker implementation. TODO: a real store.
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
