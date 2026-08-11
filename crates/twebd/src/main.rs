//! twebd binary entry point.

use anyhow::Result;

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "twebd=info,tweb=info".into()),
        )
        .init();

    // TODO: choose the engine/transport/platform implementations.
    // A placeholder for now — the real implementations land with the S1 outcome.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    rt.block_on(async {
        // A placeholder daemon. Injecting the real implementations is TODO.
        // let daemon = Daemon { engine, transport, platform, routing, pages, profiles, resources };
        // daemon.run().await
        tracing::info!("twebd placeholder — engine/transport/platform TODO");
        tokio::signal::ctrl_c().await?;
        Ok(())
    })
}
