//! tweb CLI binary entry point.

fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        // The pane frontend owns stdout — it is the Kitty graphics channel — and
        // it now runs in this process, so logs must never go there.
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "tweb=info,tweb_pane=warn".into()),
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

#[cfg(test)]
mod tests {
    /// A single log line on stdout corrupts the Kitty graphics stream and the
    /// pane renders nothing at all, so the writer choice is not cosmetic.
    #[test]
    fn logs_stay_off_the_graphics_channel() {
        let source = include_str!("main.rs");
        assert!(source.contains(".with_writer(std::io::stderr)"));
        assert!(source.contains("tweb_pane=warn"));
    }
}
