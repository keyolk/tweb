//! `tweb config` and the settings the CLI itself resolves.
//!
//! The file is `config.toml` in tweb's config directory (the one `tweb doctor --fix` writes to).
//! The list of settings is `electron/settings-schema.json`, shared with the engine so the two
//! cannot disagree on a name, a type or a default. Precedence is environment > file > default:
//! every setting that had a `TWEB_*` variable keeps it, and it keeps winning.
//!
//! Writes go through `toml_edit`, so a hand-written file keeps its comments and order when
//! `tweb config set` changes one value in it.

use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use toml_edit::{DocumentMut, Item, Table, Value};

const SCHEMA: &str = include_str!("../../../electron/settings-schema.json");

#[derive(Debug, Clone, Deserialize)]
pub struct Setting {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: Kind,
    pub default: serde_json::Value,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub env: Option<String>,
    pub applies: String,
    pub description: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Bool,
    Int,
    Float,
    Path,
}

#[derive(Deserialize)]
struct SchemaFile {
    settings: Vec<Setting>,
}

pub fn schema() -> Vec<Setting> {
    serde_json::from_str::<SchemaFile>(SCHEMA)
        .expect("electron/settings-schema.json is valid")
        .settings
}

fn find(key: &str) -> Result<Setting> {
    schema()
        .into_iter()
        .find(|s| s.key == key)
        .with_context(|| {
            let names: Vec<String> = schema().into_iter().map(|s| s.key).collect();
            format!("unknown setting `{key}` (known: {})", names.join(", "))
        })
}

pub fn path() -> PathBuf {
    crate::doctor::managed_config_dir().join("config.toml")
}

fn read_document() -> Result<DocumentMut> {
    let path = path();
    match std::fs::read_to_string(&path) {
        Ok(text) => text
            .parse::<DocumentMut>()
            .with_context(|| format!("{} is not valid TOML", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(DocumentMut::new()),
        Err(error) => Err(error).with_context(|| format!("reading {}", path.display())),
    }
}

fn file_value<'a>(doc: &'a DocumentMut, key: &str) -> Option<&'a Item> {
    let mut item = doc.as_item();
    for part in key.split('.') {
        item = item.get(part)?;
    }
    Some(item)
}

/// A resolved setting: the value and which layer it came from.
#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub value: serde_json::Value,
    pub source: &'static str,
}

fn clamp(setting: &Setting, number: f64) -> f64 {
    number
        .max(setting.min.unwrap_or(f64::NEG_INFINITY))
        .min(setting.max.unwrap_or(f64::INFINITY))
}

/// Mirrors `coerce` in electron/settings.cjs: environment values are strings, file values are typed.
fn from_env(setting: &Setting, raw: &str) -> Option<serde_json::Value> {
    match setting.kind {
        // The variables were always "anything but 0 is on".
        Kind::Bool => Some((raw != "0" && raw != "false").into()),
        Kind::Int => raw
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite())
            .map(|n| (clamp(setting, n.round()) as i64).into()),
        Kind::Float => raw
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite())
            .map(|n| clamp(setting, n).into()),
        Kind::Path => Some(expand_home(raw).into()),
    }
}

fn from_file(setting: &Setting, item: &Item) -> Option<serde_json::Value> {
    let value = item.as_value()?;
    match setting.kind {
        Kind::Bool => value.as_bool().map(Into::into),
        Kind::Int | Kind::Float => {
            let number = value
                .as_integer()
                .map(|n| n as f64)
                .or_else(|| value.as_float())?;
            Some(if setting.kind == Kind::Int {
                (clamp(setting, number.round()) as i64).into()
            } else {
                clamp(setting, number).into()
            })
        }
        Kind::Path => value.as_str().map(|s| expand_home(s).into()),
    }
}

fn expand_home(value: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    if value == "~" {
        home
    } else if let Some(rest) = value.strip_prefix("~/") {
        format!("{home}/{rest}")
    } else {
        value.to_string()
    }
}

fn resolve_with(
    setting: &Setting,
    doc: &DocumentMut,
    env: &dyn Fn(&str) -> Option<String>,
) -> Resolved {
    if let Some(name) = &setting.env {
        if let Some(raw) = env(name).filter(|raw| !raw.is_empty()) {
            if let Some(value) = from_env(setting, &raw) {
                return Resolved {
                    value,
                    source: "env",
                };
            }
        }
    }
    if let Some(value) = file_value(doc, &setting.key).and_then(|item| from_file(setting, item)) {
        return Resolved {
            value,
            source: "file",
        };
    }
    Resolved {
        value: setting.default.clone(),
        source: "default",
    }
}

fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// The value a setting resolves to right now. A broken file falls back to defaults rather than
/// failing: a bad preferences file must not stop `tweb open`.
pub fn resolve(key: &str) -> Result<Resolved> {
    let setting = find(key)?;
    let doc = read_document().unwrap_or_default();
    Ok(resolve_with(&setting, &doc, &process_env))
}

pub fn frame_rate_max() -> u16 {
    resolve("frame_rate.max")
        .ok()
        .and_then(|r| r.value.as_i64())
        .map(|n| n.clamp(1, 60) as u16)
        .unwrap_or(30)
}

pub fn frame_rate_adaptive() -> bool {
    resolve("frame_rate.adaptive")
        .ok()
        .and_then(|r| r.value.as_bool())
        .unwrap_or(true)
}

/// Parses what the user typed for `set`, strictly: unlike a value read back from the file, an
/// out-of-range write is refused rather than clamped, so the file never holds a number that
/// silently means something else.
fn parse_input(setting: &Setting, raw: &str) -> Result<Value> {
    let out_of_range =
        |n: f64| setting.min.is_some_and(|min| n < min) || setting.max.is_some_and(|max| n > max);
    let range = || {
        format!(
            "{}..={}",
            setting.min.map_or("".into(), |n| n.to_string()),
            setting.max.map_or("".into(), |n| n.to_string())
        )
    };
    Ok(match setting.kind {
        Kind::Bool => match raw {
            "true" | "on" | "yes" | "1" => true.into(),
            "false" | "off" | "no" | "0" => false.into(),
            _ => bail!("`{}` takes true or false, not `{raw}`", setting.key),
        },
        Kind::Int => {
            let n: i64 = raw
                .parse()
                .with_context(|| format!("`{}` takes a whole number", setting.key))?;
            if out_of_range(n as f64) {
                bail!("`{}` must be in {}", setting.key, range());
            }
            n.into()
        }
        Kind::Float => {
            let n: f64 = raw
                .parse()
                .with_context(|| format!("`{}` takes a number", setting.key))?;
            if !n.is_finite() || out_of_range(n) {
                bail!("`{}` must be in {}", setting.key, range());
            }
            n.into()
        }
        Kind::Path => raw.into(),
    })
}

fn write_document(doc: &DocumentMut) -> Result<()> {
    let path = path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    // Written beside and renamed over, so a running engine never reads half a file.
    let partial = path.with_extension("toml.partial");
    std::fs::write(&partial, doc.to_string())
        .with_context(|| format!("writing {}", partial.display()))?;
    std::fs::rename(&partial, &path).with_context(|| format!("replacing {}", path.display()))?;
    Ok(())
}

fn set_in(doc: &mut DocumentMut, key: &str, value: Value) {
    let parts: Vec<&str> = key.split('.').collect();
    let (last, tables) = parts.split_last().expect("a key has at least one part");
    let mut table: &mut Table = doc.as_table_mut();
    for part in tables {
        let entry = table
            .entry(part)
            .or_insert_with(|| Item::Table(Table::new()));
        if !entry.is_table_like() {
            *entry = Item::Table(Table::new());
        }
        table = entry.as_table_mut().expect("just made a table");
    }
    // Replace the value in place when the key exists: `insert` swaps the key too, and a comment
    // on the line above belongs to the key, so it went with it. The value's own decor carries a
    // trailing `# comment`, which is kept the same way.
    match table.get_mut(last).and_then(Item::as_value_mut) {
        Some(existing) => {
            let decor = existing.decor().clone();
            *existing = value;
            *existing.decor_mut() = decor;
        }
        None => {
            table.insert(last, Item::Value(value));
        }
    }
}

fn remove_in(doc: &mut DocumentMut, key: &str) -> bool {
    let parts: Vec<&str> = key.split('.').collect();
    let (last, tables) = parts.split_last().expect("a key has at least one part");
    let mut table = doc.as_table_mut() as &mut dyn toml_edit::TableLike;
    for part in tables {
        match table
            .get_mut(part)
            .and_then(|item| item.as_table_like_mut())
        {
            Some(next) => table = next,
            None => return false,
        }
    }
    table.remove(last).is_some()
}

fn when(applies: &str) -> &'static str {
    match applies {
        "live" => "applies to running panes within a second",
        "new-tab" => "applies to the next new tab",
        "engine" => "applies after `tweb daemon restart`",
        _ => "applies to the next `tweb open`",
    }
}

fn display(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) if s.is_empty() => "\"\"".into(),
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn env_note(setting: &Setting) -> Option<String> {
    let name = setting.env.as_ref()?;
    std::env::var(name)
        .ok()
        .filter(|v| !v.is_empty())
        .map(|v| format!("{name}={v} is set in this shell and overrides the file"))
}

pub fn list(json: bool) -> Result<()> {
    let doc = read_document()?;
    let rows: Vec<(Setting, Resolved)> = schema()
        .into_iter()
        .map(|s| {
            let r = resolve_with(&s, &doc, &process_env);
            (s, r)
        })
        .collect();
    if json {
        let out: Vec<serde_json::Value> = rows
            .iter()
            .map(|(s, r)| {
                serde_json::json!({
                    "key": s.key, "value": r.value, "source": r.source, "type": s.kind_name(),
                    "default": s.default, "env": s.env, "applies": s.applies,
                    "description": s.description,
                })
            })
            .collect();
        println!("{}", serde_json::to_string_pretty(&out)?);
        return Ok(());
    }
    println!("# {}", path().display());
    let width = rows.iter().map(|(s, _)| s.key.len()).max().unwrap_or(0);
    for (setting, resolved) in &rows {
        let marker = match resolved.source {
            "default" => "  ",
            "file" => "* ",
            _ => "$ ",
        };
        println!(
            "{marker}{:width$}  {:<10} {}",
            setting.key,
            display(&resolved.value),
            setting.description
        );
    }
    println!("\n* set in config.toml   $ set by an environment variable   (blank = default)");
    Ok(())
}

impl Setting {
    fn kind_name(&self) -> &'static str {
        match self.kind {
            Kind::Bool => "bool",
            Kind::Int => "int",
            Kind::Float => "float",
            Kind::Path => "path",
        }
    }
}

pub fn get(key: &str) -> Result<()> {
    let resolved = resolve(key)?;
    println!("{}", display(&resolved.value));
    Ok(())
}

pub fn set(key: &str, raw: &str) -> Result<()> {
    let setting = find(key)?;
    let value = parse_input(&setting, raw)?;
    // Echo what was written, not what was typed: `yes` is stored as `true`.
    let written = value.to_string().trim().to_string();
    let mut doc = read_document()?;
    set_in(&mut doc, key, value);
    write_document(&doc)?;
    println!("{key} = {written}  ({})", when(&setting.applies));
    if let Some(note) = env_note(&setting) {
        eprintln!("note: {note}");
    }
    Ok(())
}

pub fn unset(key: &str) -> Result<()> {
    let setting = find(key)?;
    let mut doc = read_document()?;
    if remove_in(&mut doc, key) {
        write_document(&doc)?;
        println!(
            "{key} back to its default ({})  ({})",
            display(&setting.default),
            when(&setting.applies)
        );
    } else {
        println!("{key} was not set in {}", path().display());
    }
    Ok(())
}

/// A file with every setting present but commented out, so `edit` on a fresh install shows what
/// can be changed instead of an empty buffer.
fn template() -> String {
    let mut out = String::from(
        "# tweb settings. Uncomment a line to change it; `tweb config list` shows what is in effect.\n\
         # A TWEB_* environment variable, where one is named, overrides the line here.\n",
    );
    for setting in schema() {
        out.push_str(&format!(
            "\n# {} ({}; {})\n",
            setting.description,
            setting.kind_name(),
            when(&setting.applies)
        ));
        if let Some(env) = &setting.env {
            out.push_str(&format!("# env: {env}\n"));
        }
        let default = match &setting.default {
            serde_json::Value::String(s) => format!("{s:?}"),
            other => other.to_string(),
        };
        out.push_str(&format!("# {} = {default}\n", setting.key));
    }
    out
}

pub fn edit() -> Result<()> {
    let path = path();
    if !path.exists() {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&path, template())?;
    }
    let editor = std::env::var("VISUAL")
        .or_else(|_| std::env::var("EDITOR"))
        .unwrap_or_else(|_| "vi".into());
    // Through the shell, so an EDITOR with arguments (`code -w`) works.
    let status = std::process::Command::new("sh")
        .arg("-c")
        .arg(format!("{editor} \"$1\""))
        .arg("sh")
        .arg(&path)
        .status()
        .with_context(|| format!("running {editor}"))?;
    if !status.success() {
        bail!("{editor} exited with {status}");
    }
    // Read back what was saved, so a typo is reported now rather than ignored by the engine.
    let doc = read_document()?;
    for setting in schema() {
        if let Some(item) = file_value(&doc, &setting.key) {
            if from_file(&setting, item).is_none() {
                eprintln!(
                    "warning: {} expects {}, the file has {}",
                    setting.key,
                    setting.kind_name(),
                    item.to_string().trim()
                );
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(text: &str) -> DocumentMut {
        text.parse().unwrap()
    }

    fn no_env(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn the_schema_parses_and_every_default_has_its_type() {
        for setting in schema() {
            let ok = match setting.kind {
                Kind::Bool => setting.default.is_boolean(),
                Kind::Int => setting.default.is_i64(),
                Kind::Float => setting.default.is_number(),
                Kind::Path => setting.default.is_string(),
            };
            assert!(ok, "{} default does not match its type", setting.key);
        }
    }

    #[test]
    fn environment_beats_file_beats_default() {
        let setting = find("frame_rate.max").unwrap();
        let file = doc("[frame_rate]\nmax = 45\n");
        assert_eq!(resolve_with(&setting, &file, &no_env).value, 45);
        assert_eq!(resolve_with(&setting, &file, &no_env).source, "file");
        let env = |name: &str| (name == "TWEB_FRAME_RATE").then(|| "20".to_string());
        assert_eq!(resolve_with(&setting, &file, &env).value, 20);
        assert_eq!(resolve_with(&setting, &doc(""), &no_env).source, "default");
    }

    #[test]
    fn a_dotted_key_and_a_table_mean_the_same_setting() {
        let setting = find("scroll.invert").unwrap();
        assert_eq!(
            resolve_with(&setting, &doc("scroll.invert = true\n"), &no_env).value,
            true
        );
        assert_eq!(
            resolve_with(&setting, &doc("[scroll]\ninvert = true\n"), &no_env).value,
            true
        );
    }

    #[test]
    fn a_wrong_type_in_the_file_falls_back_to_the_default() {
        let setting = find("scroll.invert").unwrap();
        let resolved = resolve_with(&setting, &doc("[scroll]\ninvert = \"yes\"\n"), &no_env);
        assert_eq!(resolved.source, "default");
    }

    #[test]
    fn a_hand_edited_number_out_of_range_is_clamped_but_a_write_is_refused() {
        let setting = find("zoom.default").unwrap();
        assert_eq!(
            resolve_with(&setting, &doc("[zoom]\ndefault = 9\n"), &no_env).value,
            2.0
        );
        assert!(parse_input(&setting, "9").is_err());
        assert!(parse_input(&setting, "1.25").is_ok());
    }

    #[test]
    fn set_keeps_comments_and_unset_removes_only_the_key() {
        let mut d = doc("# mine\n[scroll]\n# keep\ninvert = false # trailing\n");
        set_in(&mut d, "scroll.distance", 150.into());
        set_in(&mut d, "scroll.invert", true.into());
        let text = d.to_string();
        assert!(text.contains("# mine") && text.contains("# keep"), "{text}");
        assert!(
            text.contains("invert = true # trailing") && text.contains("distance = 150"),
            "{text}"
        );
        assert!(remove_in(&mut d, "scroll.distance"));
        assert!(!d.to_string().contains("distance"));
        assert!(!remove_in(&mut d, "zoom.default"));
    }

    #[test]
    fn the_template_lists_every_setting_commented_out() {
        let text = template();
        for setting in schema() {
            assert!(
                text.contains(&format!("# {} = ", setting.key)),
                "{}",
                setting.key
            );
        }
        // Commented out entirely, so it changes nothing until a line is uncommented.
        let parsed = doc(&text);
        assert!(parsed.as_table().is_empty());
    }
}
