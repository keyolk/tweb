//! The supervisor: accept connections, serve the lifecycle protocol, reap on disconnect.
//!
//! The one design commitment worth stating up front: **a frontend's connection is its liveness**.
//! A pane attaches and then holds the connection open for as long as it exists. The kernel closes
//! that fd when the frontend goes away for any reason at all — a clean exit, a panic, `kill -9`,
//! the terminal being closed underneath it — so reaping needs no heartbeat, no pid polling and no
//! timeout to tune. The repo's audio arbitration had to invent a `{pane,pid,at}` claim file
//! precisely because it had no such connection to lean on; this slice has one, so it does not.

use crate::page_registry::PaneRegistry;
use crate::protocol::{
    decode_request, encode_response, pane_key, Generation, PaneKey, Request, Response,
};
use crate::{paths, singleton};
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

/// Everything the supervisor knows. Lifecycle only — deliberately nothing about pages, frames or
/// engines, because which process owns those is exactly what is still being measured.
pub struct Supervisor {
    pub registry: PaneRegistry,
    pub socket_path: PathBuf,
    started_at: Instant,
}

impl Supervisor {
    pub fn new(socket_path: PathBuf) -> Self {
        Self {
            registry: PaneRegistry::new(),
            socket_path,
            started_at: Instant::now(),
        }
    }

    pub fn uptime_ms(&self) -> u64 {
        self.started_at.elapsed().as_millis() as u64
    }
}

/// What one connection has registered, so its close knows what to reap.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ConnectionState {
    pub attached: Option<(PaneKey, Generation)>,
}

/// The result of handling one request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dispatched {
    pub response: Response,
    /// Whether the daemon should shut down after this response is written.
    pub stop: bool,
}

/// Handles one decoded request.
///
/// Pure with respect to time and IO: the clock comes in as an argument and nothing here touches
/// the socket, so every protocol behaviour below is tested without a daemon running.
pub fn dispatch(
    supervisor: &Supervisor,
    connection: &mut ConnectionState,
    request: Request,
    now_ms: u64,
) -> Dispatched {
    match request {
        Request::Attach { pane, pid } => match pane_key(&pane) {
            Ok(key) => {
                let outcome = supervisor.registry.attach(key.clone(), pid, now_ms);
                connection.attached = Some((key, outcome.registration.generation));
                Dispatched {
                    response: Response::Attached {
                        page: outcome.registration.page_id.to_string(),
                        generation: outcome.registration.generation,
                        superseded: outcome.superseded.is_some(),
                    },
                    stop: false,
                }
            }
            Err(err) => error(err.to_string()),
        },
        Request::Detach { pane, generation } => match pane_key(&pane) {
            Ok(key) => {
                // A stale detach is answered `ok`, not `error`: the caller did nothing wrong, its
                // registration was simply already superseded, and turning that into an error
                // would make every reused pane id look like a failure in the frontend's logs.
                if supervisor.registry.detach(&key, generation).is_some()
                    && connection.attached.as_ref() == Some(&(key, generation))
                {
                    connection.attached = None;
                }
                Dispatched {
                    response: Response::Ok,
                    stop: false,
                }
            }
            Err(err) => error(err.to_string()),
        },
        Request::List => Dispatched {
            response: Response::Panes {
                panes: supervisor
                    .registry
                    .list()
                    .iter()
                    .map(|entry| entry.report())
                    .collect(),
            },
            stop: false,
        },
        Request::Status => Dispatched {
            response: Response::Status {
                pid: std::process::id(),
                socket: supervisor.socket_path.display().to_string(),
                uptime_ms: supervisor.uptime_ms(),
                pane_count: supervisor.registry.len(),
                generation_counter: supervisor.registry.generation_counter(),
            },
            stop: false,
        },
        Request::Stop => Dispatched {
            response: Response::Ok,
            stop: true,
        },
    }
}

fn error(message: String) -> Dispatched {
    Dispatched {
        response: Response::Error { message },
        stop: false,
    }
}

/// Reaps whatever a closing connection had registered.
pub fn reap_connection(supervisor: &Supervisor, connection: &ConnectionState) {
    let Some((key, generation)) = connection.attached.as_ref() else {
        return;
    };
    match supervisor.registry.detach(key, *generation) {
        Some(entry) => {
            tracing::info!(pane = %key, generation = %generation, page = %entry.page_id, "reaped pane whose frontend disconnected")
        }
        None => {
            tracing::debug!(pane = %key, generation = %generation, "disconnect was already superseded")
        }
    }
}

/// Milliseconds since the epoch. A wall clock rather than a monotonic one because the value is
/// reported to diagnostics, where it has to line up with log timestamps.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// A bound listener plus the lock that makes it the only one.
///
/// The listener is the std type rather than tokio's because [`bind`] runs before the runtime is
/// built — the singleton loser must exit without paying for a thread pool, and a bind failure has
/// to be reported as itself. `tokio::net::UnixListener::bind` registers with the reactor and
/// panics outside a runtime, so the conversion happens in [`serve`], where a runtime exists.
pub struct BoundDaemon {
    pub listener: std::os::unix::net::UnixListener,
    pub supervisor: Arc<Supervisor>,
    // Held for the process lifetime; dropping it releases the singleton lock.
    _lock: singleton::DaemonLock,
}

/// Acquires the singleton and binds the socket, or reports that a daemon is already running.
///
/// The order matters: lock first, *then* touch the socket. Unlinking a socket without the lock is
/// how two daemons end up each believing the other's socket was stale.
pub fn bind(runtime_dir: &Path) -> Result<Option<BoundDaemon>> {
    singleton::ensure_runtime_dir(runtime_dir)
        .with_context(|| format!("cannot create runtime dir {}", runtime_dir.display()))?;
    let socket_path = paths::socket_path_in(runtime_dir);
    if paths::socket_path_too_long(&socket_path) {
        anyhow::bail!(
            "socket path {} is {} bytes, over the {}-byte unix socket limit",
            socket_path.display(),
            socket_path.as_os_str().len(),
            paths::SUN_PATH_MAX
        );
    }
    let lock_path = paths::lock_path_in(runtime_dir);
    let lock = singleton::try_acquire(&lock_path)
        .with_context(|| format!("cannot open lock {}", lock_path.display()))?;
    let Some(lock) = lock else {
        return Ok(None);
    };

    match singleton::decide(true, socket_path.exists()) {
        singleton::Acquisition::TakeOverStale => {
            tracing::info!(socket = %socket_path.display(), "taking over a socket left by a dead daemon");
            singleton::clear_stale_socket(&socket_path)?;
        }
        singleton::Acquisition::Bind => {}
        singleton::Acquisition::Yield => unreachable!("the lock is held"),
    }

    let listener = std::os::unix::net::UnixListener::bind(&socket_path)
        .with_context(|| format!("cannot bind {}", socket_path.display()))?;
    Ok(Some(BoundDaemon {
        listener,
        supervisor: Arc::new(Supervisor::new(socket_path)),
        _lock: lock,
    }))
}

/// Serves until `stop`, SIGINT or SIGTERM.
pub async fn serve(daemon: BoundDaemon) -> Result<()> {
    let BoundDaemon {
        listener,
        supervisor,
        _lock,
    } = daemon;
    listener
        .set_nonblocking(true)
        .context("cannot make the listener nonblocking")?;
    let listener = UnixListener::from_std(listener).context("cannot register the listener")?;
    let (shutdown_tx, _) = tokio::sync::broadcast::channel::<()>(1);
    let our_uid = paths::current_uid();

    tracing::info!(socket = %supervisor.socket_path.display(), pid = std::process::id(), "twebd listening");

    let mut signals = shutdown_signals()?;
    let mut shutdown_rx = shutdown_tx.subscribe();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _)) => {
                        let supervisor = supervisor.clone();
                        let shutdown_tx = shutdown_tx.clone();
                        tokio::spawn(async move {
                            if let Err(err) = handle_connection(supervisor, stream, our_uid, shutdown_tx).await {
                                tracing::warn!(%err, "connection ended with an error");
                            }
                        });
                    }
                    // A failed accept is per-connection, not fatal: dropping the listener here
                    // would take every live pane's registration with it.
                    Err(err) => tracing::warn!(%err, "accept failed"),
                }
            }
            _ = shutdown_rx.recv() => {
                tracing::info!("stop requested");
                break;
            }
            _ = signals.recv() => {
                tracing::info!("signal received");
                break;
            }
        }
    }

    // Unlink before releasing the lock so the next daemon finds a clean directory. A failure here
    // is survivable — the next daemon's takeover path handles a leftover socket.
    if let Err(err) = singleton::clear_stale_socket(&supervisor.socket_path) {
        tracing::warn!(%err, "could not remove the socket on shutdown");
    }
    tracing::info!("twebd stopped");
    Ok(())
}

/// SIGINT and SIGTERM as one stream. SIGTERM matters because that is what a supervisor or a
/// `pkill` sends, and ignoring it leaves the socket behind for the next daemon to clean up.
fn shutdown_signals() -> Result<tokio::sync::mpsc::Receiver<()>> {
    use tokio::signal::unix::{signal, SignalKind};
    let (tx, rx) = tokio::sync::mpsc::channel(1);
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut terminate = signal(SignalKind::terminate())?;
    tokio::spawn(async move {
        tokio::select! {
            _ = interrupt.recv() => {}
            _ = terminate.recv() => {}
        }
        let _ = tx.send(()).await;
    });
    Ok(rx)
}

async fn handle_connection(
    supervisor: Arc<Supervisor>,
    stream: UnixStream,
    our_uid: u32,
    shutdown_tx: tokio::sync::broadcast::Sender<()>,
) -> Result<()> {
    let peer_uid = stream
        .peer_cred()
        .map(|cred| cred.uid())
        .unwrap_or(u32::MAX);
    if !paths::peer_allowed(peer_uid, our_uid) {
        tracing::warn!(peer_uid, "refusing a connection from another user");
        return Ok(());
    }

    let (read_half, mut write_half) = stream.into_split();
    let mut lines = BufReader::new(read_half).lines();
    let mut connection = ConnectionState::default();

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let dispatched = match decode_request(&line) {
            Ok(request) => dispatch(&supervisor, &mut connection, request, now_ms()),
            // An unrecognised request keeps the connection open. A client built against a later
            // protocol should degrade, not fail in a way that looks like the daemon crashed.
            Err(err) => Dispatched {
                response: Response::Error {
                    message: err.to_string(),
                },
                stop: false,
            },
        };
        write_half
            .write_all(encode_response(&dispatched.response).as_bytes())
            .await?;
        write_half.flush().await?;
        if dispatched.stop {
            // Flushed above, so the client sees its `ok` before the daemon goes away.
            let _ = shutdown_tx.send(());
            break;
        }
    }

    reap_connection(&supervisor, &connection);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::PaneRef;

    fn supervisor() -> Supervisor {
        Supervisor::new(PathBuf::from("/tmp/twebd-test/twebd.sock"))
    }

    fn pane(pane: &str, server: &str) -> PaneRef {
        PaneRef {
            pane: pane.to_string(),
            tmux_server: server.to_string(),
        }
    }

    fn attach(
        supervisor: &Supervisor,
        connection: &mut ConnectionState,
        id: &str,
        pid: u32,
    ) -> Generation {
        let dispatched = dispatch(
            supervisor,
            connection,
            Request::Attach {
                pane: pane(id, "srv"),
                pid,
            },
            1_000,
        );
        match dispatched.response {
            Response::Attached { generation, .. } => generation,
            other => panic!("expected an attach response, got {other:?}"),
        }
    }

    #[test]
    fn attach_registers_the_pane_and_remembers_it_on_the_connection() {
        let supervisor = supervisor();
        let mut connection = ConnectionState::default();
        let generation = attach(&supervisor, &mut connection, "%3", 42);
        assert_eq!(supervisor.registry.len(), 1);
        assert_eq!(
            connection.attached,
            Some((
                PaneKey {
                    pane: tweb_core::page::PaneId(3),
                    tmux_server: "srv".into()
                },
                generation
            ))
        );
    }

    #[test]
    fn attach_with_a_bad_pane_id_is_an_error_that_registers_nothing() {
        let supervisor = supervisor();
        let mut connection = ConnectionState::default();
        let dispatched = dispatch(
            &supervisor,
            &mut connection,
            Request::Attach {
                pane: pane("3", "srv"),
                pid: 1,
            },
            0,
        );
        assert!(matches!(dispatched.response, Response::Error { .. }));
        assert!(supervisor.registry.is_empty());
        assert!(connection.attached.is_none());
    }

    #[test]
    fn a_reattach_of_the_same_pane_reports_that_it_superseded() {
        let supervisor = supervisor();
        let mut first = ConnectionState::default();
        attach(&supervisor, &mut first, "%3", 1);
        let mut second = ConnectionState::default();
        let dispatched = dispatch(
            &supervisor,
            &mut second,
            Request::Attach {
                pane: pane("%3", "srv"),
                pid: 2,
            },
            0,
        );
        assert!(matches!(
            dispatched.response,
            Response::Attached {
                superseded: true,
                ..
            }
        ));
    }

    #[test]
    fn list_reports_every_attached_pane() {
        let supervisor = supervisor();
        let mut a = ConnectionState::default();
        let mut b = ConnectionState::default();
        attach(&supervisor, &mut a, "%3", 1);
        attach(&supervisor, &mut b, "%7", 2);
        let dispatched = dispatch(
            &supervisor,
            &mut ConnectionState::default(),
            Request::List,
            0,
        );
        let Response::Panes { panes } = dispatched.response else {
            panic!("expected panes");
        };
        let ids: Vec<String> = panes.iter().map(|entry| entry.pane.clone()).collect();
        assert_eq!(ids, vec!["%3".to_string(), "%7".to_string()]);
    }

    #[test]
    fn status_counts_panes_and_the_generation_counter() {
        let supervisor = supervisor();
        attach(&supervisor, &mut ConnectionState::default(), "%3", 1);
        attach(&supervisor, &mut ConnectionState::default(), "%4", 2);
        let dispatched = dispatch(
            &supervisor,
            &mut ConnectionState::default(),
            Request::Status,
            0,
        );
        let Response::Status {
            pane_count,
            generation_counter,
            socket,
            ..
        } = dispatched.response
        else {
            panic!("expected status");
        };
        assert_eq!(pane_count, 2);
        assert_eq!(generation_counter, Generation(2));
        assert!(socket.ends_with("twebd.sock"));
    }

    #[test]
    fn detach_removes_the_pane_and_clears_the_connection() {
        let supervisor = supervisor();
        let mut connection = ConnectionState::default();
        let generation = attach(&supervisor, &mut connection, "%3", 1);
        let dispatched = dispatch(
            &supervisor,
            &mut connection,
            Request::Detach {
                pane: pane("%3", "srv"),
                generation,
            },
            0,
        );
        assert_eq!(dispatched.response, Response::Ok);
        assert!(supervisor.registry.is_empty());
        assert!(connection.attached.is_none());
    }

    #[test]
    fn a_stale_detach_is_answered_ok_and_changes_nothing() {
        let supervisor = supervisor();
        let mut first = ConnectionState::default();
        let stale = attach(&supervisor, &mut first, "%3", 1);
        attach(&supervisor, &mut ConnectionState::default(), "%3", 2);
        let dispatched = dispatch(
            &supervisor,
            &mut first,
            Request::Detach {
                pane: pane("%3", "srv"),
                generation: stale,
            },
            0,
        );
        assert_eq!(dispatched.response, Response::Ok);
        assert_eq!(supervisor.registry.len(), 1);
    }

    #[test]
    fn a_closing_connection_reaps_its_own_pane() {
        let supervisor = supervisor();
        let mut connection = ConnectionState::default();
        attach(&supervisor, &mut connection, "%3", 1);
        reap_connection(&supervisor, &connection);
        assert!(supervisor.registry.is_empty());
    }

    #[test]
    fn a_closing_connection_never_reaps_the_pane_that_replaced_it() {
        let supervisor = supervisor();
        let mut dead = ConnectionState::default();
        attach(&supervisor, &mut dead, "%3", 1);
        let mut live = ConnectionState::default();
        attach(&supervisor, &mut live, "%3", 2);
        // The dead frontend's socket only closes now, after the pane id was reused.
        reap_connection(&supervisor, &dead);
        assert_eq!(supervisor.registry.len(), 1);
        assert_eq!(supervisor.registry.list()[0].pid, 2);
    }

    #[test]
    fn a_connection_that_never_attached_reaps_nothing() {
        let supervisor = supervisor();
        attach(&supervisor, &mut ConnectionState::default(), "%3", 1);
        reap_connection(&supervisor, &ConnectionState::default());
        assert_eq!(supervisor.registry.len(), 1);
    }

    #[test]
    fn only_stop_asks_the_daemon_to_exit() {
        let supervisor = supervisor();
        let mut connection = ConnectionState::default();
        for request in [Request::List, Request::Status] {
            assert!(!dispatch(&supervisor, &mut connection, request, 0).stop);
        }
        assert!(dispatch(&supervisor, &mut connection, Request::Stop, 0).stop);
    }

    #[test]
    fn the_last_detach_does_not_stop_the_daemon() {
        let supervisor = supervisor();
        let mut connection = ConnectionState::default();
        let generation = attach(&supervisor, &mut connection, "%3", 1);
        let dispatched = dispatch(
            &supervisor,
            &mut connection,
            Request::Detach {
                pane: pane("%3", "srv"),
                generation,
            },
            0,
        );
        assert!(supervisor.registry.is_empty());
        assert!(
            !dispatched.stop,
            "an idle daemon stays up; exiting here would race the next pane's attach"
        );
    }
}
