//! Builds the engine's Node-API addon (`crates/tweb-frame-native`) and leaves it in OUT_DIR for
//! `engine_app.rs` to embed next to the app code.
//!
//! WHY A NESTED CARGO. The addon is a `cdylib` the Electron process `require`s, so what has to be
//! embedded is the built shared library, not a Rust dependency — and a crate cannot depend on
//! another crate's cdylib output on stable Cargo. Building it here keeps `cargo build` the one
//! command that produces a complete `tweb`, the way the embedded app code already is.
//!
//! Always release: the addon's whole job is one pass over a 20MB frame per whole frame, and an
//! unoptimised byte loop is several times the frame budget.
//!
//! A failed addon build is a warning, not an error. The engine treats a missing addon as "no
//! shared-memory medium" and keeps the frame-file medium, which is what it shipped with — so a
//! machine that cannot build it still gets a working tweb, and says why in the build output.

use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let workspace = manifest_dir
        .parent()
        .and_then(Path::parent)
        .expect("crates/tweb-pane sits two levels below the workspace")
        .to_path_buf();
    let addon_dir = workspace.join("crates/tweb-frame-native");
    println!("cargo:rerun-if-changed={}", addon_dir.join("src").display());
    println!(
        "cargo:rerun-if-changed={}",
        addon_dir.join("Cargo.toml").display()
    );
    println!("cargo:rerun-if-env-changed=TWEB_SKIP_NATIVE_ADDON");

    let destination = out_dir.join("tweb-frame.node");
    // Written first, so `include_bytes!` always has a file: empty means "no addon".
    std::fs::write(&destination, []).expect("write placeholder addon");
    if std::env::var_os("TWEB_SKIP_NATIVE_ADDON").is_some() {
        println!(
            "cargo:warning=TWEB_SKIP_NATIVE_ADDON is set: tweb ships without the shm frame addon"
        );
        return;
    }
    match build_addon(&workspace, &out_dir) {
        Ok(built) => {
            std::fs::copy(&built, &destination).expect("copy built addon");
        }
        Err(reason) => {
            println!(
                "cargo:warning=shm frame addon not built ({reason}); frames keep the file medium"
            );
        }
    }
}

fn build_addon(workspace: &Path, out_dir: &Path) -> Result<PathBuf, String> {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());
    let target = std::env::var("TARGET").map_err(|e| e.to_string())?;
    let host = std::env::var("HOST").map_err(|e| e.to_string())?;
    // Its own target directory: the outer build holds the lock on the outer one, and sharing it
    // would deadlock.
    let target_dir = out_dir.join("native-target");
    let mut command = Command::new(cargo);
    command
        .current_dir(workspace)
        .args(["build", "--release", "-p", "tweb-frame-native", "--lib"])
        .arg("--target-dir")
        .arg(&target_dir);
    if target != host {
        command.args(["--target", &target]);
    }
    // Under `cargo clippy` the outer build runs with clippy as the compiler wrapper; the addon is a
    // workspace member that clippy already lints directly, and its build here only needs rustc.
    for variable in [
        "RUSTC_WORKSPACE_WRAPPER",
        "CLIPPY_ARGS",
        "CARGO_TARGET_DIR",
        "CARGO_ENCODED_RUSTFLAGS",
        "CARGO_MAKEFLAGS",
    ] {
        command.env_remove(variable);
    }
    let status = command
        .status()
        .map_err(|e| format!("cannot run cargo: {e}"))?;
    if !status.success() {
        return Err(format!("cargo exited with {status}"));
    }
    let mut built = target_dir;
    if target != host {
        built.push(&target);
    }
    built.push("release");
    let file = if target.contains("apple") {
        "libtweb_frame_native.dylib"
    } else if target.contains("windows") {
        "tweb_frame_native.dll"
    } else {
        "libtweb_frame_native.so"
    };
    built.push(file);
    if built.exists() {
        Ok(built)
    } else {
        Err(format!("{} missing after the build", built.display()))
    }
}
