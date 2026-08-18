//! The supervisor: accept connections, serve the lifecycle protocol, reap on disconnect.
//!
//! The one design commitment worth stating up front: **a frontend's connection is its liveness**.
//! A pane attaches and then holds the connection open for as long as it exists. The kernel closes
//! that fd when the frontend goes away for any reason at all — a clean exit, a panic, `kill -9`,
//! the terminal being closed underneath it — so reaping needs no heartbeat, no pid polling and no
//! timeout to tune. The repo's audio arbitration had to invent a `{pane,pid,at}` claim file
//! precisely because it had no such connection to lean on; this slice has one, so it does not.

use crate::engine_host::{app_dir_looks_like_an_engine, EngineHost, Launcher};
use crate::engine_wire::{self, EngineEvent};
use crate::page_registry::PaneRegistry;
use crate::protocol::{
    decode_request, encode_response, pane_key, Generation, PaneEvent, PaneKey, PaneRef,
    RefusalReason, Request, Response, PROTOCOL_VERSION,
};
use crate::{paths, singleton};
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

/// Everything the supervisor knows: which panes are attached, and the one engine that hosts the
/// pages of those that asked to be hosted.
pub struct Supervisor {
    pub registry: PaneRegistry,
    pub socket_path: PathBuf,
    /// Created on the first hosted attach and shared by every pane after it. `None` until then, so
    /// a daemon nobody has asked to host anything owns no browser runtime.
    engine: parking_lot::Mutex<Option<Arc<EngineHost>>>,
    started_at: Instant,
}

impl Supervisor {
    pub fn new(socket_path: PathBuf) -> Self {
        Self {
            registry: PaneRegistry::new(),
            socket_path,
            engine: parking_lot::Mutex::new(None),
            started_at: Instant::now(),
        }
    }

    pub fn uptime_ms(&self) -> u64 {
        self.started_at.elapsed().as_millis() as u64
    }

    /// The engine host, built from the engine the *frontend* resolved.
    ///
    /// The daemon deliberately does not resolve the engine itself: resolution walks up from the
    /// current directory, so a daemon started from elsewhere answers differently than the pane's
    /// shell does, and silently running a stale embedded copy is the most expensive mistake
    /// available here. Once built, the first caller's engine is the engine — a second pane
    /// pointing somewhere else is refused rather than silently served by the wrong build.
    fn engine_for(&self, executable: &str, app_dir: &str) -> Arc<EngineHost> {
        let mut slot = self.engine.lock();
        if let Some(engine) = slot.as_ref() {
            return engine.clone();
        }
        let app_dir = PathBuf::from(app_dir);
        let engine = if !Path::new(executable).exists() {
            Arc::new(EngineHost::unavailable(format!(
                "engine {executable} does not exist"
            )))
        } else if !app_dir_looks_like_an_engine(&app_dir) {
            Arc::new(EngineHost::unavailable(format!(
                "{} is not an engine app",
                app_dir.display()
            )))
        } else {
            Arc::new(EngineHost::new(Launcher {
                executable: PathBuf::from(executable),
                app_dir,
            }))
        };
        *slot = Some(engine.clone());
        engine
    }

    fn engine_state(&self) -> String {
        match self.engine.lock().as_ref() {
            Some(engine) => engine.state().to_string(),
            None => "idle".to_string(),
        }
    }

    fn hosted_pane_count(&self) -> usize {
        self.engine
            .lock()
            .as_ref()
            .map_or(0, |engine| engine.hosted_pane_count())
    }
}

/// What one connection has registered, so its close knows what to reap.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ConnectionState {
    pub attached: Option<(PaneKey, Generation)>,
    /// Whether this connection's pane is hosted by the daemon's engine, so the close path knows
    /// to drop it there too.
    pub hosted: bool,
}

/// The result of handling one request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dispatched {
    pub response: Response,
    /// Whether the daemon should shut down after this response is written.
    pub stop: bool,
}

/// Whether a client's protocol version can be served.
///
/// Exact equality rather than a range: the version only moves when the wire changes in a way that
/// would otherwise be silent, and "close enough" is how a frontend ends up waiting forever for a
/// frame the daemon encodes differently.
pub fn protocol_refusal(client: u32) -> Option<RefusalReason> {
    (client != PROTOCOL_VERSION).then_some(RefusalReason::ProtocolMismatch)
}

/// Handles one decoded request.
///
/// Pure with respect to time and IO: the clock comes in as an argument and nothing here touches
/// the socket, so every protocol behaviour below is tested without a daemon running. `sink` is
/// where this connection's pushed events go — a channel, not a socket, for the same reason.
pub async fn dispatch(
    supervisor: &Supervisor,
    connection: &mut ConnectionState,
    request: Request,
    now_ms: u64,
    sink: &crate::engine_host::PaneSink,
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
        Request::Host {
            pane,
            pid,
            protocol,
            image_id,
            geometry,
            tty,
            engine_executable,
            engine_app_dir,
            url,
            frame_rate,
            adaptive_frame_rate,
            restore_session,
        } => {
            if let Some(reason) = protocol_refusal(protocol) {
                return refused(
                    reason,
                    format!("daemon speaks protocol {PROTOCOL_VERSION}, client speaks {protocol}"),
                );
            }
            let key = match pane_key(&pane) {
                Ok(key) => key,
                Err(err) => return error(err.to_string()),
            };
            let engine = supervisor.engine_for(&engine_executable, &engine_app_dir);
            // Before registering anything: the engine cannot tell two panes with one id apart, so a
            // second one would make every control line for that id ambiguous. Refused here rather
            // than only in the engine, because a refusal the daemon does not make is a pane the
            // frontend believes is hosted and never sees painted.
            if let Some(other) = engine.conflicting_pane_id(&key) {
                return refused(
                    RefusalReason::PaneIdConflict,
                    format!(
                        "{} is already hosted for tmux server {}",
                        key.pane, other.tmux_server
                    ),
                );
            }
            // Registering *before* the engine is asked, so that an engine that fails to start
            // leaves nothing behind: the refusal path below drops the registration again.
            let outcome = supervisor.registry.attach(key.clone(), pid, now_ms);
            let generation = outcome.registration.generation;
            let opened = engine
                .open(
                    key.clone(),
                    sink.clone(),
                    &engine_wire::OpenRequest {
                        pane: &pane.pane,
                        tmux_server: &pane.tmux_server,
                        generation,
                        image_id,
                        frame_rate,
                        adaptive_frame_rate,
                        restore_session,
                        geometry,
                        tty: tty.as_deref(),
                        url: &url,
                    },
                    now_ms,
                )
                .await;
            match opened {
                Ok(()) => {
                    connection.attached = Some((key, generation));
                    connection.hosted = true;
                    Dispatched {
                        response: Response::Hosted {
                            page: outcome.registration.page_id.to_string(),
                            generation,
                            protocol: PROTOCOL_VERSION,
                        },
                        stop: false,
                    }
                }
                Err(detail) => {
                    // Nothing is left registered for a pane the daemon is not serving: the
                    // frontend is about to spawn its own engine, and a phantom entry in `list`
                    // would be a lie about who owns that pane.
                    supervisor.registry.detach(&key, generation);
                    refused(RefusalReason::EngineUnavailable, detail)
                }
            }
        }
        Request::Control {
            pane,
            generation,
            body,
        } => match pane_key(&pane) {
            Ok(key) => {
                // A control line from a superseded frontend is dropped rather than applied. tmux
                // reuses pane ids, so "resize %3" from a dead predecessor would otherwise resize
                // whatever page took its place.
                if crate::page_registry::generation_is_current(
                    supervisor.registry.get(&key).as_ref(),
                    generation,
                ) {
                    if let Some(engine) = supervisor.engine.lock().as_ref() {
                        engine.control(&key, &body);
                    }
                }
                Dispatched {
                    response: Response::Ok,
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
                if supervisor.registry.detach(&key, generation).is_some() {
                    if let Some(engine) = supervisor.engine.lock().as_ref() {
                        engine.close(&key);
                    }
                    if connection.attached.as_ref() == Some(&(key, generation)) {
                        connection.attached = None;
                        connection.hosted = false;
                    }
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
                protocol: PROTOCOL_VERSION,
                engine: supervisor.engine_state(),
                hosted_pane_count: supervisor.hosted_pane_count(),
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

fn refused(reason: RefusalReason, detail: String) -> Dispatched {
    Dispatched {
        response: Response::HostRefused { reason, detail },
        stop: false,
    }
}

/// Turns an engine event into the response the pane's frontend receives.
///
/// The generation is stamped here, at the daemon, because this is the only side that knows which
/// registration is current. A frame that belongs to a dead predecessor is therefore recognisable
/// as late by the frontend without the frontend having to track the engine's view of anything.
pub fn engine_event_response(
    event: EngineEvent,
    pane: &PaneRef,
    generation: Generation,
) -> Option<Response> {
    let pane_id = pane.pane.clone();
    match event {
        EngineEvent::Frame { payload, .. } => Some(Response::Frame {
            pane: pane_id,
            generation,
            payload: engine_wire::encode_hex(&payload),
        }),
        EngineEvent::AgentSocket { path, .. } => Some(Response::Event {
            pane: pane_id,
            generation,
            event: PaneEvent::AgentSocket { path },
        }),
        EngineEvent::Audio { audible, .. } => Some(Response::Event {
            pane: pane_id,
            generation,
            event: PaneEvent::Audio { audible },
        }),
        // Forwarded rather than acted on: the daemon owns no pty, which is the entire reason this
        // stopped being a signal at the supervisor and became an addressed event.
        EngineEvent::KeyboardRestore { .. } => Some(Response::Event {
            pane: pane_id,
            generation,
            event: PaneEvent::KeyboardRestore,
        }),
        // An empty pane name is how the engine host reports its own death to every pane at once:
        // the process is gone, so it named no pane. That is `engine_lost`, not one pane closing.
        EngineEvent::Closed { pane, reason } if pane.is_empty() => Some(Response::Event {
            pane: pane_id,
            generation,
            event: PaneEvent::EngineLost { reason },
        }),
        EngineEvent::Closed { reason, .. } => Some(Response::Event {
            pane: pane_id,
            generation,
            event: PaneEvent::Closed { reason },
        }),
        EngineEvent::Ready { .. } => None,
    }
}

/// Reaps whatever a closing connection had registered.
pub fn reap_connection(supervisor: &Supervisor, connection: &ConnectionState) {
    let Some((key, generation)) = connection.attached.as_ref() else {
        return;
    };
    match supervisor.registry.detach(key, *generation) {
        Some(entry) => {
            if connection.hosted {
                if let Some(engine) = supervisor.engine.lock().as_ref() {
                    engine.close(key);
                }
            }
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
    // Before any engine can be started: a hosted engine signals the process it believes owns its
    // pane's pty, and that process is this one. See `engine_host::ignore_frontend_signals`.
    crate::engine_host::ignore_frontend_signals();
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
    // Engine events for this connection's pane. Held even by a connection that never hosts, so
    // `dispatch` needs no optionality and a plain `attach` costs one unused channel.
    let (sink, mut events) = tokio::sync::mpsc::unbounded_channel::<EngineEvent>();
    let mut pane_ref: Option<PaneRef> = None;

    loop {
        tokio::select! {
            // Biased towards the request stream: a frontend that has hung up must be noticed
            // promptly, because its close is what reaps its registration.
            biased;
            line = lines.next_line() => {
                let Some(line) = line? else { break };
                if line.trim().is_empty() {
                    continue;
                }
                let dispatched = match decode_request(&line) {
                    Ok(request) => {
                        if let Request::Host { pane, .. } | Request::Attach { pane, .. } = &request {
                            pane_ref = Some(pane.clone());
                        }
                        dispatch(&supervisor, &mut connection, request, now_ms(), &sink).await
                    }
                    // An unrecognised request keeps the connection open. A client built against a
                    // later protocol should degrade, not fail in a way that looks like the daemon
                    // crashed.
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
            event = events.recv() => {
                let Some(event) = event else { continue };
                let (Some(pane), Some((_, generation))) = (pane_ref.as_ref(), connection.attached.as_ref()) else {
                    continue;
                };
                let Some(response) = engine_event_response(event, pane, *generation) else {
                    continue;
                };
                write_half
                    .write_all(encode_response(&response).as_bytes())
                    .await?;
                write_half.flush().await?;
            }
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

    /// A sink no test reads from. Every dispatch takes one; only the hosted tests care.
    fn sink() -> crate::engine_host::PaneSink {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        // Leaked deliberately: dropping the receiver would make every send fail, which is a
        // different scenario from the one under test.
        std::mem::forget(rx);
        tx
    }

    async fn go(
        supervisor: &Supervisor,
        connection: &mut ConnectionState,
        request: Request,
    ) -> Dispatched {
        dispatch(supervisor, connection, request, 1_000, &sink()).await
    }

    async fn attach(
        supervisor: &Supervisor,
        connection: &mut ConnectionState,
        id: &str,
        pid: u32,
    ) -> Generation {
        let dispatched = go(
            supervisor,
            connection,
            Request::Attach {
                pane: pane(id, "srv"),
                pid,
            },
        )
        .await;
        match dispatched.response {
            Response::Attached { generation, .. } => generation,
            other => panic!("expected an attach response, got {other:?}"),
        }
    }

    fn host_request(id: &str, protocol: u32, app_dir: &str) -> Request {
        host_request_on(id, "srv", protocol, app_dir)
    }

    fn host_request_on(id: &str, server: &str, protocol: u32, app_dir: &str) -> Request {
        Request::Host {
            pane: pane(id, server),
            pid: 1,
            protocol,
            image_id: 4242,
            geometry: crate::protocol::PaneGeometry {
                cols: 80,
                rows: 24,
                width: 800,
                height: 480,
                origin: Some((20, 0)),
            },
            tty: Some("/dev/ttys004".into()),
            engine_executable: "/nonexistent/Electron".into(),
            engine_app_dir: app_dir.into(),
            url: "https://example.com".into(),
            frame_rate: 30,
            adaptive_frame_rate: true,
            restore_session: false,
        }
    }

    #[tokio::test]
    async fn attach_registers_the_pane_and_remembers_it_on_the_connection() {
        let supervisor = supervisor();
        let mut connection = ConnectionState::default();
        let generation = attach(&supervisor, &mut connection, "%3", 42).await;
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

    #[tokio::test]
    async fn attach_with_a_bad_pane_id_is_an_error_that_registers_nothing() {
        let supervisor = supervisor();
        let mut connection = ConnectionState::default();
        let dispatched = go(
            &supervisor,
            &mut connection,
            Request::Attach {
                pane: pane("3", "srv"),
                pid: 1,
            },
        )
        .await;
        assert!(matches!(dispatched.response, Response::Error { .. }));
        assert!(supervisor.registry.is_empty());
        assert!(connection.attached.is_none());
    }

    #[tokio::test]
    async fn a_reattach_of_the_same_pane_reports_that_it_superseded() {
        let supervisor = supervisor();
        let mut first = ConnectionState::default();
        attach(&supervisor, &mut first, "%3", 1).await;
        let mut second = ConnectionState::default();
        let dispatched = go(
            &supervisor,
            &mut second,
            Request::Attach {
                pane: pane("%3", "srv"),
                pid: 2,
            },
        )
        .await;
        assert!(matches!(
            dispatched.response,
            Response::Attached {
                superseded: true,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn list_reports_every_attached_pane() {
        let supervisor = supervisor();
        let mut a = ConnectionState::default();
        let mut b = ConnectionState::default();
        attach(&supervisor, &mut a, "%3", 1).await;
        attach(&supervisor, &mut b, "%7", 2).await;
        let dispatched = go(&supervisor, &mut ConnectionState::default(), Request::List).await;
        let Response::Panes { panes } = dispatched.response else {
            panic!("expected panes");
        };
        let ids: Vec<String> = panes.iter().map(|entry| entry.pane.clone()).collect();
        assert_eq!(ids, vec!["%3".to_string(), "%7".to_string()]);
    }

    #[tokio::test]
    async fn status_counts_panes_and_the_generation_counter() {
        let supervisor = supervisor();
        attach(&supervisor, &mut ConnectionState::default(), "%3", 1).await;
        attach(&supervisor, &mut ConnectionState::default(), "%4", 2).await;
        let dispatched = go(
            &supervisor,
            &mut ConnectionState::default(),
            Request::Status,
        )
        .await;
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

    #[tokio::test]
    async fn detach_removes_the_pane_and_clears_the_connection() {
        let supervisor = supervisor();
        let mut connection = ConnectionState::default();
        let generation = attach(&supervisor, &mut connection, "%3", 1).await;
        let dispatched = go(
            &supervisor,
            &mut connection,
            Request::Detach {
                pane: pane("%3", "srv"),
                generation,
            },
        )
        .await;
        assert_eq!(dispatched.response, Response::Ok);
        assert!(supervisor.registry.is_empty());
        assert!(connection.attached.is_none());
    }

    #[tokio::test]
    async fn a_stale_detach_is_answered_ok_and_changes_nothing() {
        let supervisor = supervisor();
        let mut first = ConnectionState::default();
        let stale = attach(&supervisor, &mut first, "%3", 1).await;
        attach(&supervisor, &mut ConnectionState::default(), "%3", 2).await;
        let dispatched = go(
            &supervisor,
            &mut first,
            Request::Detach {
                pane: pane("%3", "srv"),
                generation: stale,
            },
        )
        .await;
        assert_eq!(dispatched.response, Response::Ok);
        assert_eq!(supervisor.registry.len(), 1);
    }

    #[tokio::test]
    async fn a_closing_connection_reaps_its_own_pane() {
        let supervisor = supervisor();
        let mut connection = ConnectionState::default();
        attach(&supervisor, &mut connection, "%3", 1).await;
        reap_connection(&supervisor, &connection);
        assert!(supervisor.registry.is_empty());
    }

    #[tokio::test]
    async fn a_closing_connection_never_reaps_the_pane_that_replaced_it() {
        let supervisor = supervisor();
        let mut dead = ConnectionState::default();
        attach(&supervisor, &mut dead, "%3", 1).await;
        let mut live = ConnectionState::default();
        attach(&supervisor, &mut live, "%3", 2).await;
        // The dead frontend's socket only closes now, after the pane id was reused.
        reap_connection(&supervisor, &dead);
        assert_eq!(supervisor.registry.len(), 1);
        assert_eq!(supervisor.registry.list()[0].pid, 2);
    }

    #[tokio::test]
    async fn a_connection_that_never_attached_reaps_nothing() {
        let supervisor = supervisor();
        attach(&supervisor, &mut ConnectionState::default(), "%3", 1).await;
        reap_connection(&supervisor, &ConnectionState::default());
        assert_eq!(supervisor.registry.len(), 1);
    }

    #[tokio::test]
    async fn only_stop_asks_the_daemon_to_exit() {
        let supervisor = supervisor();
        let mut connection = ConnectionState::default();
        for request in [Request::List, Request::Status] {
            assert!(!go(&supervisor, &mut connection, request).await.stop);
        }
        assert!(go(&supervisor, &mut connection, Request::Stop).await.stop);
    }

    #[tokio::test]
    async fn the_last_detach_does_not_stop_the_daemon() {
        let supervisor = supervisor();
        let mut connection = ConnectionState::default();
        let generation = attach(&supervisor, &mut connection, "%3", 1).await;
        let dispatched = go(
            &supervisor,
            &mut connection,
            Request::Detach {
                pane: pane("%3", "srv"),
                generation,
            },
        )
        .await;
        assert!(supervisor.registry.is_empty());
        assert!(
            !dispatched.stop,
            "an idle daemon stays up; exiting here would race the next pane's attach"
        );
    }

    // The whole shippability argument rests on this: a daemon that cannot host says so, and the
    // frontend answers by spawning its own engine. If this ever returned `Hosted` optimistically,
    // the pane would sit blank waiting for frames nobody is producing.
    #[tokio::test]
    async fn a_daemon_with_no_hostable_engine_refuses_rather_than_pretending() {
        let supervisor = supervisor();
        let mut connection = ConnectionState::default();
        let dispatched = go(
            &supervisor,
            &mut connection,
            host_request("%3", PROTOCOL_VERSION, "/nonexistent/app"),
        )
        .await;
        let Response::HostRefused { reason, detail } = dispatched.response else {
            panic!("expected a refusal");
        };
        assert_eq!(reason, RefusalReason::EngineUnavailable);
        assert!(!detail.is_empty(), "a refusal has to say why");
    }

    // A refused host must leave nothing behind. A phantom entry in `list` would claim the daemon
    // owns a pane that is in fact running its own engine.
    #[tokio::test]
    async fn a_refused_host_registers_nothing() {
        let supervisor = supervisor();
        let mut connection = ConnectionState::default();
        go(
            &supervisor,
            &mut connection,
            host_request("%3", PROTOCOL_VERSION, "/nonexistent/app"),
        )
        .await;
        assert!(supervisor.registry.is_empty());
        assert!(connection.attached.is_none());
        assert!(!connection.hosted);
    }

    #[tokio::test]
    async fn a_client_from_another_build_is_refused_on_the_version_not_the_engine() {
        let supervisor = supervisor();
        let mut connection = ConnectionState::default();
        let dispatched = go(
            &supervisor,
            &mut connection,
            host_request("%3", PROTOCOL_VERSION + 1, "/nonexistent/app"),
        )
        .await;
        let Response::HostRefused { reason, .. } = dispatched.response else {
            panic!("expected a refusal");
        };
        assert_eq!(reason, RefusalReason::ProtocolMismatch);
        assert!(supervisor.registry.is_empty());
        assert_eq!(protocol_refusal(PROTOCOL_VERSION), None);
    }

    #[tokio::test]
    async fn status_reports_the_engine_and_the_protocol() {
        let supervisor = supervisor();
        let dispatched = go(
            &supervisor,
            &mut ConnectionState::default(),
            Request::Status,
        )
        .await;
        let Response::Status {
            protocol,
            engine,
            hosted_pane_count,
            ..
        } = dispatched.response
        else {
            panic!("expected status");
        };
        assert_eq!(protocol, PROTOCOL_VERSION);
        assert_eq!(engine, "idle", "no pane has asked for hosting yet");
        assert_eq!(hosted_pane_count, 0);
    }

    // tmux reuses pane ids. A control line from a frontend that has already been replaced would
    // otherwise resize, or type into, whatever page took its place.
    #[tokio::test]
    async fn a_control_line_from_a_superseded_frontend_is_dropped() {
        let supervisor = supervisor();
        let mut first = ConnectionState::default();
        let stale = attach(&supervisor, &mut first, "%3", 1).await;
        let live = attach(&supervisor, &mut ConnectionState::default(), "%3", 2).await;
        assert_ne!(stale, live);
        // Neither reaches an engine here (there is none), but the response must still be `ok`:
        // the frontend did nothing wrong, and an error would look like a daemon fault in its log.
        for generation in [stale, live] {
            let dispatched = go(
                &supervisor,
                &mut first,
                Request::Control {
                    pane: pane("%3", "srv"),
                    generation,
                    body: "RESIZE 80 24 800 480".into(),
                },
            )
            .await;
            assert_eq!(dispatched.response, Response::Ok);
        }
        assert_eq!(supervisor.registry.len(), 1);
    }

    #[tokio::test]
    async fn a_control_line_for_a_bad_pane_id_is_an_error() {
        let supervisor = supervisor();
        let dispatched = go(
            &supervisor,
            &mut ConnectionState::default(),
            Request::Control {
                pane: pane("3", "srv"),
                generation: Generation(1),
                body: "VIS 1".into(),
            },
        )
        .await;
        assert!(matches!(dispatched.response, Response::Error { .. }));
    }

    #[tokio::test]
    async fn a_frame_reaches_the_frontend_hex_encoded_and_stamped_with_the_generation() {
        let response = engine_event_response(
            EngineEvent::Frame {
                pane: "%3".into(),
                payload: vec![0x1b, 0x5f, 0x47],
            },
            &pane("%3", "srv"),
            Generation(9),
        )
        .expect("a frame is delivered");
        assert_eq!(
            response,
            Response::Frame {
                pane: "%3".into(),
                generation: Generation(9),
                payload: "1b5f47".into(),
            }
        );
    }

    // The engine host reports its own death by naming no pane. Every hosted frontend has to read
    // that as "the shared runtime is gone, spawn your own", not as "my one page closed".
    #[tokio::test]
    async fn an_unnamed_close_is_engine_lost_and_a_named_one_is_just_that_pane() {
        let lost = engine_event_response(
            EngineEvent::Closed {
                pane: String::new(),
                reason: "engine exited: signal 9".into(),
            },
            &pane("%3", "srv"),
            Generation(2),
        )
        .expect("delivered");
        assert!(matches!(
            lost,
            Response::Event {
                event: PaneEvent::EngineLost { .. },
                ..
            }
        ));
        let closed = engine_event_response(
            EngineEvent::Closed {
                pane: "%3".into(),
                reason: "renderer-gone".into(),
            },
            &pane("%3", "srv"),
            Generation(2),
        )
        .expect("delivered");
        assert!(matches!(
            closed,
            Response::Event {
                event: PaneEvent::Closed { .. },
                ..
            }
        ));
    }

    #[tokio::test]
    async fn the_engine_ready_line_is_not_forwarded_to_a_frontend() {
        assert_eq!(
            engine_event_response(
                EngineEvent::Ready { protocol: 1 },
                &pane("%3", "srv"),
                Generation(1)
            ),
            None
        );
    }

    #[tokio::test]
    async fn agent_and_audio_events_reach_the_frontend() {
        let agent = engine_event_response(
            EngineEvent::AgentSocket {
                pane: "%3".into(),
                path: "/tmp/a.sock".into(),
            },
            &pane("%3", "srv"),
            Generation(1),
        );
        assert!(matches!(
            agent,
            Some(Response::Event {
                event: PaneEvent::AgentSocket { .. },
                ..
            })
        ));
        let audio = engine_event_response(
            EngineEvent::Audio {
                pane: "%3".into(),
                audible: true,
            },
            &pane("%3", "srv"),
            Generation(1),
        );
        assert!(matches!(
            audio,
            Some(Response::Event {
                event: PaneEvent::Audio { audible: true },
                ..
            })
        ));
    }
}
