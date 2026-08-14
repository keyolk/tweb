//! Embeds the Electron app code in the binary and unpacks it into the cache when needed.
//!
//! All the app requires is `electron`, node's built-in modules, and its own files embedded here,
//! so it runs without node_modules. That makes the 198KB of app code self-sufficient on its own
//! inside the binary, leaving the 295MB Electron runtime to live elsewhere.
//!
//! The directory name is a hash of the contents. The binary and the preload can never drift apart
//! (the same build always maps to the same directory), and re-running the same build never unpacks
//! it again.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

const FILES: &[(&str, &str)] = &[
    (
        "package.json",
        include_str!("../../../electron/package.json"),
    ),
    ("main.cjs", include_str!("../../../electron/main.cjs")),
    (
        "context-menu.cjs",
        include_str!("../../../electron/context-menu.cjs"),
    ),
    ("preload.cjs", include_str!("../../../electron/preload.cjs")),
    (
        "gfx-worker.cjs",
        include_str!("../../../electron/gfx-worker.cjs"),
    ),
    (
        "mouse-click-state.cjs",
        include_str!("../../../electron/mouse-click-state.cjs"),
    ),
    (
        "paste-state.cjs",
        include_str!("../../../electron/paste-state.cjs"),
    ),
    (
        "tmux-visibility.cjs",
        include_str!("../../../electron/tmux-visibility.cjs"),
    ),
    (
        "window-session.cjs",
        include_str!("../../../electron/window-session.cjs"),
    ),
    (
        "url-normalization.cjs",
        include_str!("../../../electron/url-normalization.cjs"),
    ),
    (
        "patch-geometry.cjs",
        include_str!("../../../electron/patch-geometry.cjs"),
    ),
    (
        "frame-rate-policy.cjs",
        include_str!("../../../electron/frame-rate-policy.cjs"),
    ),
    (
        "agent-server.cjs",
        include_str!("../../../electron/agent-server.cjs"),
    ),
    (
        "history-view.cjs",
        include_str!("../../../electron/history-view.cjs"),
    ),
    (
        "audio-owner.cjs",
        include_str!("../../../electron/audio-owner.cjs"),
    ),
    (
        "orphan-watch.cjs",
        include_str!("../../../electron/orphan-watch.cjs"),
    ),
    (
        "surface-policy.cjs",
        include_str!("../../../electron/surface-policy.cjs"),
    ),
];

/// A content hash of the embedded app code. FNV-1a, to avoid pulling in another dependency.
/// What is needed is not collision resistance but only "different contents, different directory".
fn content_tag() -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for (name, body) in FILES {
        for byte in name.as_bytes().iter().chain(body.as_bytes()) {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100_0000_01b3);
        }
    }
    format!("{hash:016x}")
}

pub fn cache_root() -> PathBuf {
    if let Ok(dir) = std::env::var("TWEB_CACHE_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(dir) = std::env::var("XDG_CACHE_HOME") {
        return PathBuf::from(dir).join("tweb");
    }
    std::env::var("HOME")
        .map(|home| PathBuf::from(home).join(".cache/tweb"))
        .unwrap_or_else(|_| std::env::temp_dir().join("tweb"))
}

fn write_app(directory: &Path) -> Result<()> {
    std::fs::create_dir_all(directory)
        .with_context(|| format!("cannot create {}", directory.display()))?;
    for (name, body) in FILES {
        let path = directory.join(name);
        std::fs::write(&path, body).with_context(|| format!("cannot write {}", path.display()))?;
    }
    Ok(())
}

/// The directory the embedded app code was unpacked into. If it already exists, it is used as is.
pub fn extracted_app_dir() -> Result<PathBuf> {
    let target = cache_root().join(format!("app-{}", content_tag()));
    // If main.cjs is there, treat it as complete. The swap below happens via rename, so a
    // half-written directory never appears under this name.
    if target.join("main.cjs").exists() {
        return Ok(target);
    }
    // In case another process unpacks concurrently, write into a per-pid staging directory and rename.
    let staging = cache_root().join(format!(".app-{}-{}", content_tag(), std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    write_app(&staging)?;
    if std::fs::rename(&staging, &target).is_err() {
        // Having lost the race, use the winner's result — the content hash matches, so it is identical.
        let _ = std::fs::remove_dir_all(&staging);
        if !target.join("main.cjs").exists() {
            anyhow::bail!("cannot place the engine app at {}", target.display());
        }
    }
    Ok(target)
}

/// The Electron version `package.json` asks for. App code and runtime are pinned in one place.
fn electron_version() -> Result<String> {
    let manifest = FILES
        .iter()
        .find(|(name, _)| *name == "package.json")
        .map(|(_, body)| *body)
        .context("bundle has no package.json")?;
    let parsed: serde_json::Value =
        serde_json::from_str(manifest).context("package.json is not JSON")?;
    let spec = parsed["dependencies"]["electron"]
        .as_str()
        .context("package.json does not depend on electron")?;
    // "^43.2.0" → "43.2.0". The range is not interpreted; the base version as written is used.
    Ok(spec.trim_start_matches(['^', '~', '=', 'v']).to_string())
}

/// The platform-arch used in Electron's release filenames.
fn platform_tag() -> Result<String> {
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        "linux" => "linux",
        other => anyhow::bail!("no Electron build for {other}"),
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => anyhow::bail!("no Electron build for {other}"),
    };
    Ok(format!("{platform}-{arch}"))
}

/// The directory a one-shot install puts the runtime in.
pub fn runtime_dir() -> PathBuf {
    let version = electron_version().unwrap_or_else(|_| "unknown".to_string());
    cache_root().join(format!("electron-{version}"))
}

fn run(program: &str, args: &[&str]) -> Result<()> {
    let status = std::process::Command::new(program)
        .args(args)
        .status()
        .with_context(|| format!("cannot run {program}"))?;
    if !status.success() {
        anyhow::bail!("{program} failed with {status}");
    }
    Ok(())
}

fn capture(program: &str, args: &[&str]) -> Result<String> {
    let out = std::process::Command::new(program)
        .args(args)
        .output()
        .with_context(|| format!("cannot run {program}"))?;
    if !out.status.success() {
        anyhow::bail!("{program} failed with {}", out.status);
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Verifies the downloaded zip matches what Electron published. This is a binary we are about to
/// execute, so the size alone is not enough to go on.
fn verify_checksum(zip: &Path, sums: &str, name: &str) -> Result<()> {
    let expected = sums
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let sum = fields.next()?;
            let file = fields.next()?.trim_start_matches('*');
            (file == name).then_some(sum)
        })
        .next()
        .with_context(|| format!("{name} is not listed in SHASUMS256.txt"))?;
    let tool = if std::env::consts::OS == "macos" {
        ("shasum", vec!["-a", "256"])
    } else {
        ("sha256sum", vec![])
    };
    let mut args = tool.1;
    let path = zip.to_string_lossy().to_string();
    args.push(&path);
    let actual = capture(tool.0, &args)?;
    let actual = actual.split_whitespace().next().unwrap_or_default();
    if actual != expected {
        anyhow::bail!("checksum mismatch for {name}: got {actual}, expected {expected}");
    }
    Ok(())
}

/// Downloads the Electron runtime once and unpacks it into the cache.
///
/// At 295MB the runtime is not embedded in the binary (the 198KB of app code is). Instead it is
/// fetched once when it is genuinely missing, and used from the cache thereafter. `curl`/`unzip`
/// ship by default on both platforms, so this adds no crate dependency.
pub fn install_runtime() -> Result<PathBuf> {
    if std::env::var("TWEB_NO_AUTO_INSTALL").is_ok() {
        anyhow::bail!("TWEB_NO_AUTO_INSTALL is set, so the automatic install is skipped");
    }
    let version = electron_version()?;
    let target = runtime_dir();
    let name = format!("electron-v{version}-{}.zip", platform_tag()?);
    let base = format!("https://github.com/electron/electron/releases/download/v{version}");

    let staging = cache_root().join(format!(".electron-{version}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)
        .with_context(|| format!("cannot create {}", staging.display()))?;
    let zip = staging.join(&name);

    eprintln!(
        "tweb: downloading Electron runtime {version} (once only, {})",
        target.display()
    );
    run(
        "curl",
        &[
            "-fL",
            "--retry",
            "2",
            "-o",
            &zip.to_string_lossy(),
            &format!("{base}/{name}"),
        ],
    )?;
    let sums = capture(
        "curl",
        &["-fL", "--retry", "2", &format!("{base}/SHASUMS256.txt")],
    )?;
    verify_checksum(&zip, &sums, &name)?;
    let unpacked = staging.join("dist");
    run(
        "unzip",
        &[
            "-q",
            "-o",
            &zip.to_string_lossy(),
            "-d",
            &unpacked.to_string_lossy(),
        ],
    )?;
    let _ = std::fs::remove_file(&zip);

    let _ = std::fs::remove_dir_all(&target);
    std::fs::create_dir_all(target.parent().unwrap_or(&target)).ok();
    std::fs::rename(&staging, &target)
        .with_context(|| format!("cannot place the runtime at {}", target.display()))?;

    super::electron_binary_in(&target).with_context(|| {
        format!(
            "the runtime unpacked into {} has no Electron",
            target.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::{content_tag, extracted_app_dir, FILES};

    #[test]
    fn the_app_carries_every_file_it_requires() {
        let names: Vec<&str> = FILES.iter().map(|(name, _)| *name).collect();
        let main = FILES
            .iter()
            .find(|(name, _)| *name == "main.cjs")
            .expect("main.cjs")
            .1;
        // A require the bundle does not carry makes the pane fail at startup, and
        // only at run time — the compiler cannot see it.
        for line in main.lines() {
            if let Some(rest) = line.split_once("require(\"./") {
                let required = rest.1.split('"').next().unwrap_or_default();
                assert!(
                    names.contains(&required),
                    "main.cjs requires {required}, which the bundle does not carry"
                );
            }
        }
    }

    /// The runtime download is named after this, so a range prefix left in place
    /// would ask GitHub for a release that does not exist.
    #[test]
    fn the_electron_version_drops_its_range_prefix() {
        let version = super::electron_version().expect("version");
        assert!(
            version.starts_with(|c: char| c.is_ascii_digit()),
            "version {version} still carries a range prefix"
        );
        assert!(
            version.split('.').count() >= 2,
            "version {version} is not a release"
        );
    }

    #[test]
    fn the_platform_tag_matches_electron_release_names() {
        let tag = super::platform_tag().expect("tag");
        let (platform, arch) = tag.split_once('-').expect("platform-arch");
        assert!(
            ["darwin", "linux"].contains(&platform),
            "unexpected platform {platform}"
        );
        assert!(["arm64", "x64"].contains(&arch), "unexpected arch {arch}");
    }

    /// The zip becomes an executable, so a mismatch has to stop the install.
    #[test]
    fn a_checksum_mismatch_is_refused() {
        let file = std::env::temp_dir().join(format!("tweb-sum-{}.zip", std::process::id()));
        std::fs::write(&file, b"not really a zip").expect("write");
        let name = file.file_name().unwrap().to_string_lossy().to_string();

        let wrong = format!("{}  {name}\n", "0".repeat(64));
        assert!(super::verify_checksum(&file, &wrong, &name).is_err());

        let missing = format!("{}  something-else.zip\n", "0".repeat(64));
        assert!(super::verify_checksum(&file, &missing, &name).is_err());

        // The real sum, taken the same way the installer takes it.
        let tool = if std::env::consts::OS == "macos" {
            "shasum"
        } else {
            "sha256sum"
        };
        let mut args: Vec<String> = if tool == "shasum" {
            vec!["-a".into(), "256".into()]
        } else {
            vec![]
        };
        args.push(file.to_string_lossy().to_string());
        let out = std::process::Command::new(tool)
            .args(&args)
            .output()
            .expect("sum");
        let sum = String::from_utf8_lossy(&out.stdout)
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_string();
        let right = format!("{sum}  {name}\n");
        assert!(super::verify_checksum(&file, &right, &name).is_ok());
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn extracting_twice_reuses_the_same_directory() {
        let cache = std::env::temp_dir().join(format!("tweb-app-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&cache);
        std::env::set_var("TWEB_CACHE_DIR", &cache);

        let first = extracted_app_dir().expect("extract");
        let stamp = std::fs::metadata(first.join("main.cjs"))
            .and_then(|meta| meta.modified())
            .expect("mtime");
        let second = extracted_app_dir().expect("extract again");

        assert_eq!(first, second);
        assert!(first.ends_with(format!("app-{}", content_tag())));
        assert_eq!(
            stamp,
            std::fs::metadata(second.join("main.cjs"))
                .and_then(|meta| meta.modified())
                .expect("mtime")
        );
        std::env::remove_var("TWEB_CACHE_DIR");
        let _ = std::fs::remove_dir_all(&cache);
    }
}
