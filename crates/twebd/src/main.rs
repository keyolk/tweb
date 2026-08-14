//! twebd binary entry point.

use anyhow::Result;
use std::path::PathBuf;
use twebd::cli::{parse, Invocation, ParseEnv, USAGE};
use twebd::client::{render, Client};
use twebd::protocol::Request;
use twebd::{paths, server};

fn main() -> Result<()> {
    // The supervisor never owns a pane's stdout — that is the Kitty graphics channel and belongs
    // to the frontend — but stderr is the repo-wide convention for logs and there is no reason to
    // be the one process that differs.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "twebd=info".into()),
        )
        .init();

    let args: Vec<String> = std::env::args().skip(1).collect();
    let env = ParseEnv {
        tmux_pane: std::env::var("TMUX_PANE").ok(),
        tmux: std::env::var("TMUX").ok(),
        pid: std::process::id(),
    };
    let invocation = match parse(&args, &env) {
        Ok(invocation) => invocation,
        Err(message) => {
            eprintln!("twebd: {message}\n\n{USAGE}");
            std::process::exit(2);
        }
    };

    match invocation {
        Invocation::Help => {
            println!("{USAGE}");
            Ok(())
        }
        Invocation::Serve { runtime_dir } => serve(resolve(runtime_dir)),
        Invocation::Attach {
            runtime_dir,
            pane,
            pid,
        } => attach(resolve(runtime_dir), pane, pid),
        Invocation::List { runtime_dir } => one_shot(resolve(runtime_dir), Request::List),
        Invocation::Status { runtime_dir } => one_shot(resolve(runtime_dir), Request::Status),
        Invocation::Stop { runtime_dir } => one_shot(resolve(runtime_dir), Request::Stop),
    }
}

fn resolve(runtime_dir: Option<PathBuf>) -> PathBuf {
    runtime_dir.unwrap_or_else(paths::runtime_dir)
}

fn serve(runtime_dir: PathBuf) -> Result<()> {
    // Binding happens before the runtime is built so the singleton loser exits without having
    // paid for a thread pool, and so a bind failure is reported as itself rather than as a task
    // that ended early.
    let Some(daemon) = server::bind(&runtime_dir)? else {
        eprintln!(
            "twebd is already running for this user ({} is held)",
            paths::lock_path_in(&runtime_dir).display()
        );
        return Ok(());
    };
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(server::serve(daemon))
}

fn attach(runtime_dir: PathBuf, pane: twebd::protocol::PaneRef, pid: u32) -> Result<()> {
    let socket = paths::socket_path_in(&runtime_dir);
    let mut client = Client::connect(&socket)?;
    let response = client.call(&Request::Attach { pane, pid })?;
    println!("{}", render(&response));
    // Holding this connection open IS the pane's liveness declaration. When this process dies for
    // any reason the kernel closes the fd, and that close is what reaps the registration.
    client.block_until_closed()
}

fn one_shot(runtime_dir: PathBuf, request: Request) -> Result<()> {
    let socket = paths::socket_path_in(&runtime_dir);
    let mut client = Client::connect(&socket)?;
    println!("{}", render(&client.call(&request)?));
    Ok(())
}
