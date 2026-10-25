// SPDX-License-Identifier: GPL-3.0-or-later
// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
/* canvas — Canvas core plugin I/O (canvasfs): the .canvas path check
   (canvas_rel) and the JSON Canvas parse of `links`, which reads EVERY
   .canvas file in the vault and extracts file-card targets.
   Attacker reach: .canvas files are vault content (untrusted); canvas paths
   come over IPC from the view. Input = path \0 canvas bytes.
   Oracles: canvas_rel(Ok) => relative, Normal components only, no hidden
   component, leaf ends in .canvas; `links` never panics on any file body and
   only answers for the one canvas in the fixture vault. */
#![no_main]
use libfuzzer_sys::fuzz_target;
use opensidian_lib::canvasfs;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

fn root() -> &'static PathBuf {
    static R: OnceLock<PathBuf> = OnceLock::new();
    R.get_or_init(|| {
        let base = if Path::new("/dev/shm").is_dir() { PathBuf::from("/dev/shm") } else { std::env::temp_dir() };
        let r = base.join(format!("opensidian-fuzz-canvas-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&r);
        std::fs::create_dir_all(&r).unwrap();
        r.canonicalize().unwrap()
    })
}

fuzz_target!(|data: &[u8]| {
    let (path, body) = match data.iter().position(|&b| b == 0) {
        Some(i) => (&data[..i], &data[i + 1..]),
        None => (&b""[..], data),
    };
    if let Ok(p) = std::str::from_utf8(path) {
        if let Ok(rel) = canvasfs::canvas_rel("read", p) {
            assert!(rel.components().all(|c| matches!(c, Component::Normal(_))), "canvas_rel({p:?}) = {rel:?}");
            assert!(rel.iter().all(|c| c.as_encoded_bytes().first() != Some(&b'.')), "hidden component in {rel:?}");
            assert!(rel.to_str().is_some_and(|s| s.ends_with(canvasfs::EXT)), "leaf of {rel:?} is not .canvas");
        }
    }
    let r = root();
    std::fs::write(r.join("fz.canvas"), body).unwrap();
    let v = canvasfs::op(r, "links", "", None).expect("links never errors on a readable vault");
    let m = v.as_object().expect("links returns an object");
    assert!(m.keys().all(|k| k == "fz.canvas"), "links invented a canvas: {:?}", m.keys().collect::<Vec<_>>());
});
