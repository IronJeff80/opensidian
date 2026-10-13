// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* plugin-loader (recon M1): the opensidian-plugin:// scheme.

   A community plugin's main.js is ONE CommonJS bundle. The page CSP has no
   'unsafe-eval' and no blob:, so the bundle cannot be eval'd from a string;
   instead Rust serves it on its own scheme, wrapped in a CJS function that
   hands the host's module/exports/require to it, and ONLY this scheme is
   added to script-src.

   URL shape:  opensidian-plugin://localhost/<id>/main.js[?n=<reload>]
   (the id rides in the PATH, not the host: a host is case-normalised by some
   URL parsers, a path segment is not.)

   What the scheme serves, and nothing else (every other answer is 403):
     1. the path is exactly "/<id>/main.js" — no other file, no other depth,
        no percent-escapes, so there is no path to "parse" into an escape;
     2. <id> is a plain name ([A-Za-z0-9._-], no leading dot, <= 128 bytes);
     3. plugins are TRUSTED for this vault (restricted mode OFF — that flag
        lives in ~/.opensidian.json, outside the vault, so a vault cannot ship
        itself pre-trusted) AND <id> is listed in the vault's
        .obsidian/community-plugins.json (Obsidian's enabled list);
     4. <vault>/.obsidian/plugins/<id> canonicalises to exactly
        canon(<vault>)/.obsidian/plugins/<id> — a symlinked plugin dir, or a
        symlinked .obsidian / plugins dir pointing out of the vault, refuses;
     5. main.js is a regular file, not a symlink, <= MAX_MAIN_JS bytes.
   A missing main.js in an otherwise allowed plugin is 404. */

use std::fs;
use std::path::{Path, PathBuf};

pub const SCHEME: &str = "opensidian-plugin";
/// the biggest real bundles (excalidraw) are ~8 MB; anything past this is not a plugin
pub const MAX_MAIN_JS: u64 = 32 * 1024 * 1024;
/// the JS host function the wrapper calls (ui/plugins/loader.js defines it)
pub const DEFINE_FN: &str = "__osPluginDefine";

#[derive(Debug, PartialEq, Eq)]
pub enum Served {
    Js(Vec<u8>),
    Refused(&'static str),
    Missing,
}

/// rule 2: a plugin id is a plain directory name
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.starts_with('.')
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}

/// rule 1: "/<id>/main.js" -> Some(id); anything else -> None
pub fn parse_path(path: &str) -> Option<&str> {
    let rest = path.strip_prefix('/')?;
    let (id, file) = rest.split_once('/')?;
    (file == "main.js" && valid_id(id)).then_some(id)
}

/// the vault's enabled list: .obsidian/community-plugins.json, a JSON array of ids
/// (Obsidian's format). Unreadable / malformed = nothing enabled.
pub fn enabled_ids(root: &Path) -> Vec<String> {
    let p = root.join(".obsidian").join("community-plugins.json");
    let Ok(m) = fs::symlink_metadata(&p) else { return Vec::new() };
    if !m.is_file() || m.len() > 1024 * 1024 {
        return Vec::new();
    }
    fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<serde_json::Value>>(&s).ok())
        .map(|v| v.iter().filter_map(|x| x.as_str()).filter(|s| valid_id(s)).map(str::to_string).collect())
        .unwrap_or_default()
}

/// rule 4: the plugin dir, canonical and confined; None = refuse
pub fn plugin_dir_in(root: &Path, id: &str) -> Option<PathBuf> {
    if !valid_id(id) {
        return None;
    }
    let croot = root.canonicalize().ok()?;
    let want = croot.join(".obsidian").join("plugins").join(id);
    let got = root.join(".obsidian").join("plugins").join(id).canonicalize().ok()?;
    (got == want && got.starts_with(&croot) && got.is_dir()).then_some(got)
}

/// rule 5: a file inside a confined plugin dir. Ok(None) = absent, Err = refuse
pub fn plugin_file_in(root: &Path, id: &str, file: &str, cap: u64) -> Result<Option<PathBuf>, &'static str> {
    let dir = plugin_dir_in(root, id).ok_or("plugin dir not confined")?;
    if file.is_empty() || file.contains('/') || file.starts_with('.') {
        return Err("bad file name");
    }
    let p = dir.join(file);
    match fs::symlink_metadata(&p) {
        Err(_) => Ok(None),
        Ok(m) if m.is_symlink() => Err("symlinked file"),
        Ok(m) if !m.is_file() => Err("not a file"),
        Ok(m) if m.len() > cap => Err("too big"),
        Ok(_) => Ok(Some(p)),
    }
}

/// the CJS wrapper: module/exports/require come from the host's define fn.
/// The plugin source starts the function body, so its own "use strict" stays a
/// directive. The trailing newline before "})" survives a final // comment.
pub fn wrap_cjs(id: &str, src: &str) -> String {
    let src = src.strip_prefix('\u{feff}').unwrap_or(src);
    format!(
        ";(function(){{var d=window.{DEFINE_FN};if(typeof d!==\"function\")return;d({id:?},function(module,exports,require){{{src}\n}});}})();\n//# sourceURL={SCHEME}://localhost/{id}/main.js\n"
    )
}

/// the whole decision for one request (rules 1-5), unit-testable without tauri
pub fn serve(root: Option<&Path>, path: &str, trusted: bool) -> Served {
    let Some(id) = parse_path(path) else { return Served::Refused("bad path") };
    let Some(root) = root else { return Served::Refused("no vault") };
    if !trusted {
        return Served::Refused("restricted mode");
    }
    if !enabled_ids(root).iter().any(|e| e == id) {
        return Served::Refused("not enabled");
    }
    match plugin_file_in(root, id, "main.js", MAX_MAIN_JS) {
        Err(why) => Served::Refused(why),
        Ok(None) => Served::Missing,
        Ok(Some(p)) => match fs::read(&p) {
            Ok(b) => Served::Js(wrap_cjs(id, &String::from_utf8_lossy(&b)).into_bytes()),
            Err(_) => Served::Missing,
        },
    }
}

/// trust is keyed by the CANONICAL vault path in ~/.opensidian.json
/// ("plugins_trusted": { "<canon path>": true }); absent = restricted.
pub fn trust_key(root: &Path) -> String {
    fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf()).display().to_string()
}

pub fn is_trusted(cfg: &serde_json::Value, root: &Path) -> bool {
    cfg["plugins_trusted"][trust_key(root).as_str()].as_bool() == Some(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("opensidian-plug-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join(".obsidian/plugins/good")).unwrap();
        fs::write(root.join(".obsidian/plugins/good/main.js"), "\"use strict\";module.exports=1;//end").unwrap();
        fs::write(root.join(".obsidian/community-plugins.json"), r#"["good","gone","sneaky","linkdir"]"#).unwrap();
        fs::write(root.join("secret.md"), "SECRET").unwrap();
        root
    }

    fn js(s: Served) -> String {
        match s {
            Served::Js(b) => String::from_utf8(b).unwrap(),
            o => panic!("expected js, got {o:?}"),
        }
    }

    #[test]
    fn serves_enabled_main_js_wrapped() {
        let r = vault("ok");
        let out = js(serve(Some(&r), "/good/main.js", true));
        assert!(out.starts_with(";(function(){var d=window.__osPluginDefine;"), "{out}");
        assert!(out.contains("d(\"good\",function(module,exports,require){\"use strict\";module.exports=1;//end\n});"), "{out}");
        assert!(out.ends_with("//# sourceURL=opensidian-plugin://localhost/good/main.js\n"), "{out}");
    }

    #[test]
    fn restricted_mode_serves_nothing() {
        let r = vault("restr");
        assert_eq!(serve(Some(&r), "/good/main.js", false), Served::Refused("restricted mode"));
    }

    #[test]
    fn not_enabled_is_refused_and_missing_is_404() {
        let r = vault("en");
        fs::create_dir_all(r.join(".obsidian/plugins/off")).unwrap();
        fs::write(r.join(".obsidian/plugins/off/main.js"), "x").unwrap();
        assert_eq!(serve(Some(&r), "/off/main.js", true), Served::Refused("not enabled"));
        fs::create_dir_all(r.join(".obsidian/plugins/gone")).unwrap();
        assert_eq!(serve(Some(&r), "/gone/main.js", true), Served::Missing);
        assert_eq!(serve(None, "/good/main.js", true), Served::Refused("no vault"));
    }

    #[test]
    fn path_escapes_are_refused() {
        let r = vault("esc");
        for p in [
            "/../secret.md", "/good/../../../secret.md", "/good/../main.js", "/../good/main.js",
            "/good/manifest.json", "/good/data.json", "/good/sub/main.js", "/good//main.js",
            "/%2e%2e/main.js", "/good%2fmain.js", "/.obsidian/main.js", "/./main.js", "/../../etc/passwd",
            "//etc/passwd", "/etc/passwd", "good/main.js", "", "/", "/good/", "/good/main.js/",
            "/good/main.js%00", "/go od/main.js", "/good\\..\\x/main.js",
        ] {
            match serve(Some(&r), p, true) {
                Served::Refused(_) => {}
                o => panic!("{p:?} must be refused, got {o:?}"),
            }
        }
        assert_eq!(parse_path("/good/main.js"), Some("good"));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_out_are_refused() {
        use std::os::unix::fs::symlink;
        let r = vault("sym");
        let outside = r.with_extension("outside");
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("main.js"), "OUTSIDE").unwrap();
        // a plugin dir that is a symlink out of the vault
        symlink(&outside, r.join(".obsidian/plugins/linkdir")).unwrap();
        assert!(matches!(serve(Some(&r), "/linkdir/main.js", true), Served::Refused(_)));
        // a main.js that is a symlink (to a vault file, even)
        fs::create_dir_all(r.join(".obsidian/plugins/sneaky")).unwrap();
        symlink(r.join("secret.md"), r.join(".obsidian/plugins/sneaky/main.js")).unwrap();
        assert!(matches!(serve(Some(&r), "/sneaky/main.js", true), Served::Refused(_)));
        // a whole .obsidian/plugins that points out of the vault
        let r2 = vault("sym2");
        fs::remove_dir_all(r2.join(".obsidian/plugins")).unwrap();
        fs::create_dir_all(outside.join("good")).unwrap();
        fs::write(outside.join("good/main.js"), "OUTSIDE").unwrap();
        symlink(&outside, r2.join(".obsidian/plugins")).unwrap();
        assert!(matches!(serve(Some(&r2), "/good/main.js", true), Served::Refused(_)));
    }

    #[test]
    fn oversize_and_non_file_main_js_refused() {
        let r = vault("big");
        fs::create_dir_all(r.join(".obsidian/plugins/sneaky/main.js")).unwrap(); // a dir named main.js
        assert!(matches!(serve(Some(&r), "/sneaky/main.js", true), Served::Refused(_)));
        assert!(matches!(plugin_file_in(&r, "good", "main.js", 3), Err("too big")));
    }

    #[test]
    fn ids_and_enabled_list() {
        for ok in ["sample-plugin", "periodic-notes", "cmdr", "obsidian_x.y", "A1"] {
            assert!(valid_id(ok), "{ok}");
        }
        for bad in ["", ".", "..", ".hidden", "a/b", "a\\b", "a b", "a%2e", "é", &"x".repeat(129)] {
            assert!(!valid_id(bad), "{bad}");
        }
        let r = vault("list");
        fs::write(r.join(".obsidian/community-plugins.json"), r#"["good", "../x", 3, "ok-2"]"#).unwrap();
        assert_eq!(enabled_ids(&r), vec!["good".to_string(), "ok-2".to_string()]);
        fs::write(r.join(".obsidian/community-plugins.json"), "not json").unwrap();
        assert!(enabled_ids(&r).is_empty());
    }

    #[test]
    fn trust_lives_outside_the_vault_and_defaults_off() {
        let r = vault("trust");
        assert!(!is_trusted(&serde_json::json!({}), &r));
        let cfg = serde_json::json!({"plugins_trusted": {trust_key(&r): true}});
        assert!(is_trusted(&cfg, &r));
        assert!(!is_trusted(&serde_json::json!({"plugins_trusted": {trust_key(&r): "yes"}}), &r));
    }
}
