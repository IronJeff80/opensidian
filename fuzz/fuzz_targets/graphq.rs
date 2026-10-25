// SPDX-License-Identifier: GPL-3.0-or-later
// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
/* graphq — the search/graph-filter query language (terms, phrases, /regex/,
   field ops, [prop:value], line:/section:, OR / - / parentheses).
   Attacker reach: graph.json filters and group queries live in the vault's
   .obsidian/ (untrusted), and search queries can arrive from note links.
   Input = query \0 doc content (doc tags derived from the content).
   Oracles: parse + match never panic; an empty / whitespace query is All. */
#![no_main]
use libfuzzer_sys::fuzz_target;
use opensidian_lib::{graphq, index};

fuzz_target!(|data: &[u8]| {
    let Ok(s) = std::str::from_utf8(data) else { return };
    let (query, content) = s.split_once('\0').unwrap_or((s, "# Title\n[[link]] #tag\n---\nkey: v\n---\nbody line\n"));
    let q = graphq::parse(query);
    if query.trim().is_empty() {
        assert!(graphq::is_all(&q), "blank query {query:?} is not All");
    }
    let tags = index::tags_in(content);
    for path in ["fz", "sub/Note Name", "img/pic.png"] {
        let _ = graphq::matches(&q, &graphq::Doc { path, content, tags: &tags });
    }
});
