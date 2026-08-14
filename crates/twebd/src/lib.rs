//! twebd — the TWeb pane supervisor.
//!
//! One supervisor per user. It owns the answer to a single question: **which panes exist right
//! now, and which registration is each one currently on?** Every candidate architecture needs
//! that answer identically — whether one Electron hosts N panes or twebd drives Chromium over CDP
//! — so this crate is deliberately built to be correct before that choice is made, and to contain
//! nothing that would have to change once it is.
//!
//! What that means concretely, and why it is a feature rather than an omission:
//!
//! - **No frame data in the protocol.** Where frame bytes flow is being measured separately.
//!   A guess baked in here is how a tree ends up half-migrated.
//! - **No page state** — no url, no title, no visibility, no navigation. Those belong to whichever
//!   process ends up owning the engine.
//! - **No engine, transport or platform handle on the daemon.** The previous `Daemon` struct held
//!   `Box<dyn BrowserEngineAdapter>`, `Box<dyn FrameTransport>` and `Box<dyn PlatformService>`,
//!   which is exactly why `main.rs` could only log a TODO: no implementation of any of them
//!   exists, so the daemon could not be constructed at all. Dropping them is what makes the
//!   supervisor a thing that runs.
//!
//! Nothing under `electron/` or `crates/tweb-pane/` references this crate. The shipping path
//! (`tweb __pane` spawning its own Electron) is untouched and keeps working regardless.
//!
//! The three operational decisions, each argued where it is implemented:
//! - socket location and discovery — [`paths`]
//! - stale-socket detection and takeover — [`singleton`]
//! - what happens when the last pane detaches — [`server`] (nothing: the daemon stays up)

pub mod automation;
pub mod cli;
pub mod client;
pub mod page_registry;
pub mod paths;
pub mod profile_manager;
pub mod protocol;
pub mod resource_broker;
pub mod server;
pub mod singleton;
pub mod tmux;
