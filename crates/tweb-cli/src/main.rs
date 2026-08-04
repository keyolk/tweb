//! tweb CLI binary entry point.

fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "tweb=info".into()),
        )
        .init();

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    let result = rt.block_on(tweb_cli::run());
    // The pane frontend now runs in this process, and `tokio::io::stdin()`'s
    // blocking read does not always end on task abort. Pane cleanup already
    // happened, so cap shutdown rather than linger after the browser exits.
    rt.shutdown_timeout(std::time::Duration::from_millis(100));
    result
}
