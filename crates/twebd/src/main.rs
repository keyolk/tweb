//! twebd binary entry point.

use anyhow::Result;

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "twebd=info,tweb=info".into()),
        )
        .init();

    // TODO: engine/transport/platform 구현체 선택.
    // 현재는 placeholder — 실제 구현체는 S1 결과로 채움.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    rt.block_on(async {
        // placeholder daemon. 실제 구현체 주입은 TODO.
        // let daemon = Daemon { engine, transport, platform, routing, pages, profiles, resources };
        // daemon.run().await
        tracing::info!("twebd placeholder — engine/transport/platform TODO");
        tokio::signal::ctrl_c().await?;
        Ok(())
    })
}
