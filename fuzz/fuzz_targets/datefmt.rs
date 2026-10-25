// SPDX-License-Identifier: GPL-3.0-or-later
// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
/* datefmt — moment.js format-string port (Templates: insert date/time).
   Attacker reach: the format string comes from .obsidian/templates.json in the
   vault (untrusted, synced/shared vaults) and the Tm arrives over IPC from the
   webview (insert_datetime, main.rs), where any plugin script can call it with
   arbitrary numbers. So BOTH are fuzzed: Tm fields take full-range values (no
   clamping to a sane calendar), the rest of the input is the format string.
   Oracle: no panic, and the output stays bounded (a format token expands to a
   few dozen bytes at most, so > 64 bytes of output per input byte means an
   amplification bug). */
#![no_main]
use arbitrary::{Arbitrary, Unstructured};
use libfuzzer_sys::fuzz_target;
use opensidian_lib::datefmt::{self, Tm};

fn tm(u: &mut Unstructured) -> arbitrary::Result<Tm> {
    Ok(Tm {
        y: i64::arbitrary(u)?,
        mo: u32::arbitrary(u)?,
        d: u32::arbitrary(u)?,
        h: u32::arbitrary(u)?,
        mi: u32::arbitrary(u)?,
        s: u32::arbitrary(u)?,
        ms: u32::arbitrary(u)?,
        off: i32::arbitrary(u)?,
        epoch_ms: i64::arbitrary(u)?,
    })
}

fuzz_target!(|data: &[u8]| {
    let mut u = Unstructured::new(data);
    let Ok(t) = tm(&mut u) else { return };
    let Ok(fmt) = <&str>::arbitrary_take_rest(u) else { return };
    let out = datefmt::render(Some(fmt), datefmt::DEFAULT_DATE, &t);
    assert!(out.len() <= 64 * fmt.len() + 64, "output {} B for {} B format", out.len(), fmt.len());
});
