// SPDX-License-Identifier: GPL-3.0-or-later
// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
/* vault_path — plugin fs path confinement (vaultfs::plugin_rel + plugin_op).
   Attacker reach: every community plugin hands arbitrary path strings to
   plugin_vfs over IPC; the vault itself may be untrusted (shared/synced).
   Fixture, built once per process under a private dir:
     <sandbox>/vault/            the vault root (a note, a subdir, and a
                                 symlink `escape` -> ../outside)
     <sandbox>/outside/SECRET    a sentinel the vault must never reveal
   Oracles (not just no-panic):
     1. lexical: plugin_rel(s) = Ok(p) => p has only Normal components, and
        root.join(p) STILL starts_with(root) after lexical normalization;
     2. fs: read-only plugin ops (stat/exists/read/list) on the same string
        never return the sentinel bytes or list the sentinel name.
   Read-only ops only: no disk churn per exec, and the fixture stays fixed. */
#![no_main]
use libfuzzer_sys::fuzz_target;
use opensidian_lib::vaultfs::{b64_encode, plugin_op, plugin_rel};
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

const SECRET: &[u8] = b"OPENSIDIAN-FUZZ-SENTINEL-outside-the-vault";
const SECRET_NAME: &str = "SECRET_OUTSIDE_SENTINEL";

fn fixture() -> &'static (PathBuf, String) {
    static F: OnceLock<(PathBuf, String)> = OnceLock::new();
    F.get_or_init(|| {
        let base = if Path::new("/dev/shm").is_dir() { PathBuf::from("/dev/shm") } else { std::env::temp_dir() };
        let sb = base.join(format!("opensidian-fuzz-vault-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sb);
        let (root, out) = (sb.join("vault"), sb.join("outside"));
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(out.join(SECRET_NAME), SECRET).unwrap();
        std::fs::write(root.join("note.md"), b"# hi\n").unwrap();
        std::fs::write(root.join("sub/a.md"), b"[[note]]\n").unwrap();
        std::os::unix::fs::symlink("../outside", root.join("escape")).unwrap();
        std::os::unix::fs::symlink(out.join(SECRET_NAME), root.join("sub/leak")).unwrap();
        let root = root.canonicalize().unwrap();
        (root, b64_encode(SECRET))
    })
}

/// lexical normalization ("a/../b" -> "b"); None if it climbs above the start
fn normalize(p: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
            Component::CurDir => {}
            c => out.push(c),
        }
    }
    Some(out)
}

fuzz_target!(|data: &[u8]| {
    let Some((&sel, rest)) = data.split_first() else { return };
    let Ok(s) = std::str::from_utf8(rest) else { return };
    let (root, secret_b64) = fixture();

    // oracle 1: lexical confinement
    if let Ok(rel) = plugin_rel(s) {
        assert!(rel.is_relative(), "plugin_rel({s:?}) = {rel:?} is not relative");
        assert!(rel.components().all(|c| matches!(c, Component::Normal(_))), "plugin_rel({s:?}) = {rel:?} has a non-Normal component");
        let joined = normalize(&root.join(&rel)).expect("normalize");
        // INSIDE-ROOT ASSERTION: the resolved path never leaves the vault root
        assert!(joined.starts_with(root), "plugin_rel({s:?}) resolves to {joined:?}, outside {root:?}");
    }

    // oracle 2: the fd walk never reveals what lies outside
    let op = ["stat", "exists", "read", "list"][(sel & 3) as usize];
    if let Ok(v) = plugin_op(root, op, s, None, None, false) {
        let txt = v.to_string();
        assert!(!txt.contains(secret_b64.as_str()), "{op} {s:?} returned the outside sentinel");
        assert!(!txt.contains(SECRET_NAME), "{op} {s:?} listed the outside directory");
    }
});
