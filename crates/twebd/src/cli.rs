//! `twebd serve|attach|list|status|stop` argument parsing.
//!
//! Parsed by hand rather than with clap. The supervisor's dependency set is what every candidate
//! architecture has to carry, adding a crate to it rewrites the workspace lockfile that a
//! concurrent run is also editing, and the parse is one pure function with tests either way.

use crate::protocol::PaneRef;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Invocation {
    Help,
    /// Run the supervisor.
    Serve {
        runtime_dir: Option<PathBuf>,
    },
    /// Attach a pane and hold the connection until killed. The connection is the pane's liveness.
    Attach {
        runtime_dir: Option<PathBuf>,
        pane: PaneRef,
        pid: u32,
    },
    List {
        runtime_dir: Option<PathBuf>,
    },
    Status {
        runtime_dir: Option<PathBuf>,
    },
    Stop {
        runtime_dir: Option<PathBuf>,
    },
}

/// The environment an invocation is parsed against, so pane defaults are testable.
#[derive(Debug, Clone, Default)]
pub struct ParseEnv {
    /// `$TMUX_PANE`, used when `--pane` is omitted.
    pub tmux_pane: Option<String>,
    /// `$TMUX`, used when `--tmux-server` is omitted.
    pub tmux: Option<String>,
    pub pid: u32,
}

pub const USAGE: &str = "\
twebd — TWeb pane supervisor.

  twebd serve  [--runtime-dir DIR]     run the supervisor (singleton per user)
  twebd attach [--pane %N] [--tmux-server ID] [--pid N] [--runtime-dir DIR]
                                       register a pane and hold the connection open
  twebd list   [--runtime-dir DIR]     list attached panes
  twebd status [--runtime-dir DIR]     daemon diagnostics
  twebd stop   [--runtime-dir DIR]     shut the supervisor down

A pane is identified by its tmux pane id and the tmux server that issued it; ids are
reused, so both are required. Attach defaults them from $TMUX_PANE and $TMUX.";

/// Parses the argument list (without argv[0]).
pub fn parse(args: &[String], env: &ParseEnv) -> Result<Invocation, String> {
    let Some(command) = args.first() else {
        return Ok(Invocation::Help);
    };
    let rest = &args[1..];
    match command.as_str() {
        "help" | "--help" | "-h" => Ok(Invocation::Help),
        "serve" => Ok(Invocation::Serve {
            runtime_dir: runtime_dir_flag(rest)?,
        }),
        "list" => Ok(Invocation::List {
            runtime_dir: runtime_dir_flag(rest)?,
        }),
        "status" => Ok(Invocation::Status {
            runtime_dir: runtime_dir_flag(rest)?,
        }),
        "stop" => Ok(Invocation::Stop {
            runtime_dir: runtime_dir_flag(rest)?,
        }),
        "attach" => parse_attach(rest, env),
        other => Err(format!("unknown command {other:?}")),
    }
}

fn parse_attach(args: &[String], env: &ParseEnv) -> Result<Invocation, String> {
    let mut runtime_dir = None;
    let mut pane = None;
    let mut tmux_server = None;
    let mut pid = None;
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        let value = || {
            args.get(index + 1)
                .cloned()
                .ok_or_else(|| format!("{flag} needs a value"))
        };
        match flag {
            "--runtime-dir" => runtime_dir = Some(PathBuf::from(value()?)),
            "--pane" => pane = Some(value()?),
            "--tmux-server" => tmux_server = Some(value()?),
            "--pid" => {
                pid = Some(
                    value()?
                        .parse::<u32>()
                        .map_err(|_| "--pid needs a number".to_string())?,
                )
            }
            other => return Err(format!("unknown flag {other:?}")),
        }
        index += 2;
    }

    let pane = pane
        .or_else(|| env.tmux_pane.clone())
        .ok_or_else(|| "--pane is required outside tmux ($TMUX_PANE is unset)".to_string())?;
    let tmux_server = tmux_server
        .or_else(|| crate::tmux::server_identity_from(env.tmux.as_deref()))
        .ok_or_else(|| "--tmux-server is required outside tmux ($TMUX is unset)".to_string())?;

    Ok(Invocation::Attach {
        runtime_dir,
        pane: PaneRef { pane, tmux_server },
        pid: pid.unwrap_or(env.pid),
    })
}

fn runtime_dir_flag(args: &[String]) -> Result<Option<PathBuf>, String> {
    match args {
        [] => Ok(None),
        [flag, value] if flag == "--runtime-dir" => Ok(Some(PathBuf::from(value))),
        [flag] if flag == "--runtime-dir" => Err("--runtime-dir needs a value".to_string()),
        [other, ..] => Err(format!("unknown flag {other:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn env() -> ParseEnv {
        ParseEnv {
            tmux_pane: Some("%3".to_string()),
            tmux: Some("/tmp/tmux-501/default,12345,0".to_string()),
            pid: 999,
        }
    }

    #[test]
    fn no_arguments_prints_help() {
        assert_eq!(parse(&[], &env()), Ok(Invocation::Help));
        assert_eq!(parse(&args(&["--help"]), &env()), Ok(Invocation::Help));
    }

    #[test]
    fn an_unknown_command_is_an_error_not_a_default() {
        assert!(parse(&args(&["frobnicate"]), &env()).is_err());
    }

    #[test]
    fn serve_takes_an_optional_runtime_dir() {
        assert_eq!(
            parse(&args(&["serve"]), &env()),
            Ok(Invocation::Serve { runtime_dir: None })
        );
        assert_eq!(
            parse(&args(&["serve", "--runtime-dir", "/run/x"]), &env()),
            Ok(Invocation::Serve {
                runtime_dir: Some(PathBuf::from("/run/x"))
            })
        );
        assert!(parse(&args(&["serve", "--runtime-dir"]), &env()).is_err());
        assert!(parse(&args(&["serve", "--nope"]), &env()).is_err());
    }

    #[test]
    fn attach_defaults_the_pane_from_the_tmux_environment() {
        let parsed = parse(&args(&["attach"]), &env()).expect("parsed");
        assert_eq!(
            parsed,
            Invocation::Attach {
                runtime_dir: None,
                pane: PaneRef {
                    pane: "%3".into(),
                    tmux_server: "/tmp/tmux-501/default,12345".into(),
                },
                pid: 999,
            }
        );
    }

    #[test]
    fn attach_flags_override_the_environment() {
        let parsed = parse(
            &args(&[
                "attach",
                "--pane",
                "%9",
                "--tmux-server",
                "other",
                "--pid",
                "7",
                "--runtime-dir",
                "/run/x",
            ]),
            &env(),
        )
        .expect("parsed");
        assert_eq!(
            parsed,
            Invocation::Attach {
                runtime_dir: Some(PathBuf::from("/run/x")),
                pane: PaneRef {
                    pane: "%9".into(),
                    tmux_server: "other".into(),
                },
                pid: 7,
            }
        );
    }

    #[test]
    fn attach_outside_tmux_demands_explicit_identity() {
        let bare = ParseEnv::default();
        let err = parse(&args(&["attach"]), &bare).expect_err("no identity");
        assert!(err.contains("--pane"));
        let err = parse(&args(&["attach", "--pane", "%3"]), &bare).expect_err("no server");
        assert!(err.contains("--tmux-server"));
    }

    #[test]
    fn attach_rejects_a_non_numeric_pid_and_dangling_flags() {
        assert!(parse(&args(&["attach", "--pid", "x"]), &env()).is_err());
        assert!(parse(&args(&["attach", "--pane"]), &env()).is_err());
        assert!(parse(&args(&["attach", "--frame-rate", "30"]), &env()).is_err());
    }

    #[test]
    fn every_command_accepts_a_runtime_dir() {
        for command in ["list", "status", "stop"] {
            let parsed = parse(&args(&[command, "--runtime-dir", "/run/x"]), &env());
            assert!(parsed.is_ok(), "{command} should accept --runtime-dir");
        }
    }
}
