//! tweb __pane binary entry point.
//!
//! 사용법: tweb-pane [OPTIONS] [URL]
//! tmux가 `tweb split <url>`로 split-window를 만들고 이 binary를 실행.

use clap::{Parser, ValueEnum};

#[derive(Clone, Copy, Debug, ValueEnum)]
enum EngineArg {
    Electron,
    Tauri,
}

#[derive(Debug, Parser)]
#[command(name = "tweb-pane")]
struct Args {
    /// Browser rendering engine.
    #[arg(long, value_enum, default_value_t = EngineArg::Electron)]
    engine: EngineArg,

    /// Maximum active frame rate.
    #[arg(long, default_value_t = 30, value_parser = clap::value_parser!(u16).range(1..=60))]
    frame_rate: u16,

    /// Explicitly enable activity-aware frame-rate adaptation (default).
    #[arg(long, overrides_with = "no_adaptive_frame_rate")]
    adaptive_frame_rate: bool,

    /// Disable activity-aware frame-rate adaptation.
    #[arg(long, overrides_with = "adaptive_frame_rate")]
    no_adaptive_frame_rate: bool,

    url: Option<String>,
}

fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "tweb_pane=warn".into()),
        )
        .init();

    let args = Args::parse();
    let restore_session = args.url.is_none();
    let url = args.url.as_deref().unwrap_or("about:blank");
    let options = tweb_pane::PaneOptions {
        engine: match args.engine {
            EngineArg::Electron => tweb_pane::BrowserEngine::Electron,
            EngineArg::Tauri => tweb_pane::BrowserEngine::Tauri,
        },
        frame_rate: args.frame_rate,
        adaptive_frame_rate: args.adaptive_frame_rate || !args.no_adaptive_frame_rate,
        restore_session,
    };
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    let result = rt.block_on(tweb_pane::run_with_options(url, options));
    // `tokio::io::stdin()`의 blocking read는 task abort만으로 즉시 끝나지 않을 수 있다.
    // Pane cleanup은 run_with_options 안에서 이미 완료되므로 runtime 종료를 제한해
    // browser child 종료 뒤 frontend process가 남지 않게 한다.
    rt.shutdown_timeout(std::time::Duration::from_millis(100));
    result
}
