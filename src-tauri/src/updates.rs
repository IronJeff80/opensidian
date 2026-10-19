// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* goal/settings-general: Settings > General > "Check for updates".

   One button press = one check, nothing in the background (Automatic updates
   is deactivated). The check:
     1. GET https://api.github.com/repos/jpzk/opensidian/releases (through
        plugin_store::http_get: https only, exact host allowlist, redirects
        re-checked by hand, byte caps, anonymous);
     2. keeps published, non-draft, non-prerelease releases whose tag is a plain
        numeric version (v0.6.2, v0.4), and takes the highest;
     3. downloads THAT release's SHA256SUMS and SHA256SUMS.asc (and nothing
        else: no installer, no binary);
     4. verifies the detached OpenPGP signature over SHA256SUMS against the
        key EMBEDDED in this binary (data/updates/opensidian-release.pub.asc),
        whose v4 fingerprint must equal PINNED_FPR — the full 40 hex digits,
        never just the key id — and requires the signature's issuer
        fingerprint subpacket to be that same fingerprint;
     5. requires every line of the signed SHA256SUMS to name a file of THIS
        version (opensidian-<ver>-…), so an old release's genuinely signed sums
        re-attached to a newer tag are not a signature for that tag.
   A release that fails 3-5 is reported "NOT signed (or signature invalid) —
   ignored" and is never offered.

   The OpenPGP subset is deliberately tiny and strict: ASCII armor, v4
   signature packets of type 0x00 (binary document), EdDSA (algo 22) over
   SHA-256/SHA-512, v4 Ed25519 public key. Anything else is refused, not
   guessed at. The curve arithmetic is ed25519-compact (pinned, no deps);
   SHA-2 is the already-locked sha2. SHA-1 appears ONLY to compute the v4
   fingerprint of the compile-time embedded key (RFC 4880 12.2 mandates it);
   no downloaded byte is ever hashed with it. The armor CRC-24 is not checked:
   the signature is the integrity check, a CRC adds nothing over it. */

use crate::plugin_store::{self, Fetch};
use serde_json::{json, Value};
use sha2::{Digest, Sha256, Sha512};

pub const REPO: &str = "jpzk/opensidian";
const RELEASES_URL: &str = "https://api.github.com/repos/jpzk/opensidian/releases?per_page=30";
/// the release-signing key, ed25519, embedded at build time
pub const PINNED_KEY_ASC: &str = include_str!("../data/updates/opensidian-release.pub.asc");
/// its full v4 fingerprint; the embedded key is refused unless it hashes to this
pub const PINNED_FPR: &str = "A6E69ED6BC4779F3281721484CC1AFDE15B64EA3";
const MAX_RELEASES_JSON: u64 = 2 * 1024 * 1024;
const MAX_SUMS: u64 = 64 * 1024;
const MAX_ASC: u64 = 16 * 1024;

/// "A6E6…4EA3" — how the UI names the signer
pub fn short_fpr() -> String {
    format!("{}…{}", &PINNED_FPR[..4], &PINNED_FPR[PINNED_FPR.len() - 4..])
}

/* ------------------------------------------------------------ armor/base64 */

fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let bytes: Vec<u8> = s.bytes().filter(|c| !c.is_ascii_whitespace()).collect();
    let body = bytes.strip_suffix(b"==").or_else(|| bytes.strip_suffix(b"=")).unwrap_or(&bytes);
    if bytes.len() % 4 != 0 || body.contains(&b'=') {
        return Err("armor: bad base64 length/padding".into());
    }
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    let (mut acc, mut n) = (0u32, 0u32);
    for &c in body {
        acc = (acc << 6) | val(c).ok_or("armor: non-base64 character")?;
        n += 6;
        if n >= 8 {
            n -= 8;
            out.push((acc >> n) as u8);
            acc &= (1 << n) - 1;
        }
    }
    Ok(out)
}

/// the binary inside one "-----BEGIN PGP <kind>-----" block
pub fn dearmor(text: &str, kind: &str) -> Result<Vec<u8>, String> {
    let begin = format!("-----BEGIN PGP {kind}-----");
    let end = format!("-----END PGP {kind}-----");
    let mut lines = text.lines().map(|l| l.trim_end_matches('\r'));
    lines.by_ref().find(|l| l.trim() == begin).ok_or_else(|| format!("armor: no {begin} line"))?;
    // header lines ("Comment: …") up to the first blank line
    for l in lines.by_ref() {
        if l.trim().is_empty() {
            break;
        }
        if !l.contains(": ") {
            return Err("armor: malformed header".into());
        }
    }
    let mut b64 = String::new();
    for l in lines {
        let l = l.trim();
        if l == end {
            return b64_decode(&b64);
        }
        if l.starts_with('=') && l.len() == 5 {
            continue; // CRC-24 line (see the header comment)
        }
        b64.push_str(l);
    }
    Err(format!("armor: no {end} line"))
}

/* --------------------------------------------------------------- packets */

/// (tag, body) for every packet; partial / indeterminate lengths are refused
pub fn packets(mut b: &[u8]) -> Result<Vec<(u8, &[u8])>, String> {
    let mut out = Vec::new();
    while !b.is_empty() {
        let ctb = b[0];
        if ctb & 0x80 == 0 {
            return Err("packet: bad header byte".into());
        }
        let (tag, len, hl) = if ctb & 0x40 != 0 {
            let tag = ctb & 0x3f;
            match *b.get(1).ok_or("packet: truncated")? {
                l @ 0..=191 => (tag, l as usize, 2),
                l @ 192..=223 => {
                    let l2 = *b.get(2).ok_or("packet: truncated")? as usize;
                    (tag, ((l as usize - 192) << 8) + l2 + 192, 3)
                }
                255 => {
                    let l = b.get(2..6).ok_or("packet: truncated")?;
                    (tag, u32::from_be_bytes([l[0], l[1], l[2], l[3]]) as usize, 6)
                }
                _ => return Err("packet: partial body lengths are not accepted".into()),
            }
        } else {
            let tag = (ctb >> 2) & 0x0f;
            match ctb & 3 {
                0 => (tag, *b.get(1).ok_or("packet: truncated")? as usize, 2),
                1 => {
                    let l = b.get(1..3).ok_or("packet: truncated")?;
                    (tag, u16::from_be_bytes([l[0], l[1]]) as usize, 3)
                }
                2 => {
                    let l = b.get(1..5).ok_or("packet: truncated")?;
                    (tag, u32::from_be_bytes([l[0], l[1], l[2], l[3]]) as usize, 5)
                }
                _ => return Err("packet: indeterminate length is not accepted".into()),
            }
        };
        let body = b.get(hl..hl.checked_add(len).ok_or("packet: length overflow")?).ok_or("packet: truncated body")?;
        out.push((tag, body));
        b = &b[hl + len..];
    }
    Ok(out)
}

const ED25519_OID: &[u8] = &[0x2B, 0x06, 0x01, 0x04, 0x01, 0xDA, 0x47, 0x0F, 0x01];

pub struct PinnedKey {
    pub fpr: [u8; 20],
    pub pk: ed25519_compact::PublicKey,
}

/// the embedded key: its primary key packet must be v4 Ed25519 AND hash to PINNED_FPR
pub fn pinned_key() -> Result<PinnedKey, String> {
    let bin = dearmor(PINNED_KEY_ASC, "PUBLIC KEY BLOCK")?;
    let pk = packets(&bin)?;
    let body = match pk.first() {
        Some((6, b)) => *b,
        _ => return Err("pinned key: no primary public-key packet".into()),
    };
    let fpr = v4_fingerprint(body);
    if hex(&fpr) != PINNED_FPR {
        return Err(format!("pinned key: fingerprint {} is not the pinned {PINNED_FPR}", hex(&fpr)));
    }
    // v4 | created(4) | algo 22 | oid len | oid | MPI(263 bits) = 0x40 || key(32)
    if body.len() != 6 + 1 + ED25519_OID.len() + 2 + 33
        || body[0] != 4
        || body[5] != 22
        || body[6] as usize != ED25519_OID.len()
        || &body[7..16] != ED25519_OID
        || body[16..18] != [0x01, 0x07]
        || body[18] != 0x40
    {
        return Err("pinned key: not a v4 Ed25519 key".into());
    }
    let pk = ed25519_compact::PublicKey::from_slice(&body[19..51]).map_err(|e| format!("pinned key: {e:?}"))?;
    Ok(PinnedKey { fpr, pk })
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02X}")).collect()
}

/// RFC 4880 12.2: SHA-1(0x99 || u16 len || key packet body)
fn v4_fingerprint(body: &[u8]) -> [u8; 20] {
    let mut m = vec![0x99, (body.len() >> 8) as u8, body.len() as u8];
    m.extend_from_slice(body);
    sha1(&m)
}

/// FIPS 180-4 SHA-1, used ONLY on the compile-time embedded key (see header)
fn sha1(msg: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let mut m = msg.to_vec();
    m.push(0x80);
    while m.len() % 64 != 56 {
        m.push(0);
    }
    m.extend_from_slice(&((msg.len() as u64) * 8).to_be_bytes());
    for chunk in m.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[4 * i], chunk[4 * i + 1], chunk[4 * i + 2], chunk[4 * i + 3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let t = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(*wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = t;
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d, e]) {
            *x = x.wrapping_add(y);
        }
    }
    let mut out = [0u8; 20];
    for (i, x) in h.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&x.to_be_bytes());
    }
    out
}

/// one v4 signature packet body checked over `data` with `key`
pub fn verify_packet(key: &PinnedKey, data: &[u8], sig: &[u8]) -> Result<(), String> {
    let g = |r: std::ops::Range<usize>| sig.get(r).ok_or_else(|| "signature: truncated".to_string());
    let head = g(0..6)?;
    let (ver, typ, palgo, halgo) = (head[0], head[1], head[2], head[3]);
    if ver != 4 {
        return Err(format!("signature: version {ver}, only v4 is accepted"));
    }
    if typ != 0x00 {
        return Err(format!("signature: type 0x{typ:02x}, only a binary-document signature is accepted"));
    }
    if palgo != 22 {
        return Err(format!("signature: public-key algorithm {palgo}, only EdDSA (22) is accepted"));
    }
    let hlen = u16::from_be_bytes([head[4], head[5]]) as usize;
    let hashed = g(6..6 + hlen)?;
    let ul = g(6 + hlen..8 + hlen)?;
    let ulen = u16::from_be_bytes([ul[0], ul[1]]) as usize;
    let mut p = 8 + hlen + ulen;
    let _left16 = g(p..p + 2)?;
    p += 2;
    // two MPIs, R then S, each at most 256 bits, left-padded to 32 bytes
    let mut rs = [0u8; 64];
    for half in 0..2 {
        let bl = g(p..p + 2)?;
        let bits = u16::from_be_bytes([bl[0], bl[1]]) as usize;
        let n = bits.div_ceil(8);
        if n > 32 {
            return Err("signature: EdDSA value over 256 bits".into());
        }
        let v = g(p + 2..p + 2 + n)?;
        rs[half * 32 + 32 - n..half * 32 + 32].copy_from_slice(v);
        p += 2 + n;
    }
    if p != sig.len() {
        return Err("signature: trailing bytes".into());
    }
    // the hashed subpackets: issuer fingerprint REQUIRED and pinned; unknown critical = refuse
    let mut issuer_ok = false;
    let mut s = hashed;
    while !s.is_empty() {
        let (len, hl) = match s[0] {
            l @ 0..=191 => (l as usize, 1),
            l @ 192..=254 => (((l as usize - 192) << 8) + *s.get(1).ok_or("signature: bad subpacket")? as usize + 192, 2),
            255 => {
                let l = s.get(1..5).ok_or("signature: bad subpacket")?;
                (u32::from_be_bytes([l[0], l[1], l[2], l[3]]) as usize, 5)
            }
        };
        let sp = s.get(hl..hl + len).filter(|x| !x.is_empty()).ok_or("signature: bad subpacket")?;
        let (critical, t, d) = (sp[0] & 0x80 != 0, sp[0] & 0x7f, &sp[1..]);
        match t {
            33 => {
                if d.len() != 21 || d[0] != 4 || d[1..] != key.fpr {
                    return Err(format!("signed by another key ({}), not the pinned {}", hex(d.get(1..).unwrap_or(&[])), short_fpr()));
                }
                issuer_ok = true;
            }
            16 if d.len() == 8 && d != &key.fpr[12..] => return Err("signed by another key id, not the pinned key".into()),
            2 | 16 => {}
            3 => return Err("signature: carries an expiration time, not accepted".into()),
            _ if critical => return Err(format!("signature: unknown critical subpacket {t}")),
            _ => {}
        }
        s = &s[hl + len..];
    }
    if !issuer_ok {
        return Err("signature: no issuer fingerprint, cannot pin the signer".into());
    }
    // RFC 4880 5.2.4: data || hashed part || 0x04 0xFF || be32(len(hashed part))
    let part = &sig[..6 + hlen];
    let mut trailer = part.to_vec();
    trailer.extend_from_slice(&[0x04, 0xFF]);
    trailer.extend_from_slice(&(part.len() as u32).to_be_bytes());
    let digest: Vec<u8> = match halgo {
        8 => Sha256::new().chain_update(data).chain_update(&trailer).finalize().to_vec(),
        10 => Sha512::new().chain_update(data).chain_update(&trailer).finalize().to_vec(),
        h => return Err(format!("signature: hash algorithm {h}, only SHA-256/SHA-512 are accepted")),
    };
    let sig = ed25519_compact::Signature::from_slice(&rs).map_err(|e| format!("signature: {e:?}"))?;
    key.pk.verify(&digest, &sig).map_err(|_| "signature does not verify against the pinned key".to_string())
}

/// a detached armored signature over `data`, by the pinned key
pub fn verify_detached(data: &[u8], asc: &[u8]) -> Result<(), String> {
    let key = pinned_key()?;
    let text = std::str::from_utf8(asc).map_err(|_| "signature: not ASCII armor")?;
    let bin = dearmor(text, "SIGNATURE")?;
    let pk = packets(&bin)?;
    if pk.is_empty() || pk.iter().any(|(t, _)| *t != 2) {
        return Err("signature: the .asc must hold signature packets only".into());
    }
    let mut last = String::new();
    for (_, body) in pk {
        match verify_packet(&key, data, body) {
            Ok(()) => return Ok(()),
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// every line of the signed sums names a file of THIS version
pub fn sums_cover_version(sums: &[u8], ver: &str) -> Result<(), String> {
    let t = std::str::from_utf8(sums).map_err(|_| "SHA256SUMS: not text")?;
    let want = format!("opensidian-{ver}-");
    let mut n = 0;
    for l in t.lines().filter(|l| !l.trim().is_empty()) {
        let (h, name) = l.split_once("  ").ok_or("SHA256SUMS: malformed line")?;
        if h.len() != 64 || !h.bytes().all(|c| c.is_ascii_hexdigit()) || !name.starts_with(&want) || name.contains('/') {
            return Err(format!("SHA256SUMS: line {l:?} is not a {ver} release file"));
        }
        n += 1;
    }
    if n == 0 {
        return Err("SHA256SUMS: empty".into());
    }
    Ok(())
}

/* -------------------------------------------------------------- releases */

pub struct Candidate {
    pub tag: String,
    pub version: String,
    pub sums: Option<String>,
    pub asc: Option<String>,
}

/// "v0.6.2" -> "0.6.2"; only plain numeric dotted versions (1-3 parts) count
pub fn tag_version(tag: &str) -> Option<String> {
    let v = tag.strip_prefix('v').unwrap_or(tag);
    let parts: Vec<&str> = v.split('.').collect();
    (!parts.is_empty() && parts.len() <= 3 && parts.iter().all(|p| !p.is_empty() && p.len() <= 6 && p.bytes().all(|c| c.is_ascii_digit())))
        .then(|| v.to_string())
}

/// the highest published, non-draft, non-prerelease release in the list
pub fn pick_latest(b: &[u8]) -> Result<Option<Candidate>, String> {
    let v: Value = serde_json::from_slice(b).map_err(|e| format!("releases: not JSON ({e})"))?;
    let mut best: Option<Candidate> = None;
    for r in v.as_array().ok_or("releases: not a list")? {
        if r["draft"].as_bool() != Some(false) || r["prerelease"].as_bool() != Some(false) {
            continue;
        }
        if r["published_at"].as_str().map_or(true, str::is_empty) {
            continue;
        }
        let tag = r["tag_name"].as_str().unwrap_or("");
        let Some(version) = tag_version(tag) else { continue };
        if best.as_ref().is_some_and(|b| !plugin_store::version_gt(&version, &b.version)) {
            continue;
        }
        let asset = |n: &str| {
            r["assets"].as_array().into_iter().flatten()
                .find(|a| a["name"].as_str() == Some(n))
                .and_then(|a| a["browser_download_url"].as_str())
                .map(str::to_string)
        };
        best = Some(Candidate { tag: tag.to_string(), version, sums: asset("SHA256SUMS"), asc: asset("SHA256SUMS.asc") });
    }
    Ok(best)
}

/// the signature status of one release; Err(reason) = never offered
fn signed(fetch: Fetch, c: &Candidate) -> Result<(), String> {
    let (Some(su), Some(au)) = (c.sums.as_deref(), c.asc.as_deref()) else {
        return Err("release has no SHA256SUMS / SHA256SUMS.asc".into());
    };
    let sums = fetch(su, MAX_SUMS, "SHA256SUMS")?;
    let asc = fetch(au, MAX_ASC, "SHA256SUMS.asc")?;
    verify_detached(&sums, &asc)?;
    sums_cover_version(&sums, &c.version)
}

pub fn release_page(tag: &str) -> String {
    format!("https://github.com/{REPO}/releases/tag/{tag}")
}

/// the whole check; Err only for "could not ask GitHub at all"
pub fn check(fetch: Fetch, current: &str) -> Result<Value, String> {
    let list = fetch(RELEASES_URL, MAX_RELEASES_JSON, "releases")?;
    let Some(c) = pick_latest(&list)? else {
        return Ok(json!({"status": "current", "current": current, "text": format!("Opensidian is up to date ({current}); no published release found.")}));
    };
    let sig = signed(fetch, &c);
    let newer = plugin_store::version_gt(&c.version, current);
    let signer = short_fpr();
    Ok(match (sig, newer) {
        (Err(e), _) => {
            eprintln!("[updates] {} rejected: {e}", c.tag);
            json!({"status": "unsigned", "current": current, "latest": c.version, "reason": e,
                   "text": format!("Latest release {} is NOT signed (or signature invalid) — ignored.", c.version)})
        }
        (Ok(()), true) => json!({"status": "available", "current": current, "latest": c.version, "signer": signer,
                   "url": release_page(&c.tag),
                   "text": format!("Opensidian {} is available — signed by {signer}", c.version)}),
        (Ok(()), false) => json!({"status": "current", "current": current, "latest": c.version, "signer": signer,
                   "text": format!("Opensidian is up to date ({current}). Latest release {} is signed by {signer}.", c.version)}),
    })
}

#[tauri::command]
pub async fn update_check() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| check(&plugin_store::http_get, env!("CARGO_PKG_VERSION")))
        .await
        .map_err(|e| format!("update check: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUMS: &[u8] = include_bytes!("../data/updates/v0.6.1-SHA256SUMS");
    const ASC: &[u8] = include_bytes!("../data/updates/v0.6.1-SHA256SUMS.asc");
    const WRONG: &[u8] = include_bytes!("../data/updates/v0.6.1-SHA256SUMS.wrongkey.asc");

    #[test]
    fn sha1_vectors_and_the_pinned_fingerprint() {
        assert_eq!(hex(&sha1(b"abc")), "A9993E364706816ABA3E25717850C26C9CD0D89D");
        assert_eq!(hex(&sha1(b"")), "DA39A3EE5E6B4B0D3255BFEF95601890AFD80709");
        assert_eq!(hex(&sha1(&[b'a'; 1000])), "291E9A6C66994949B57BA5E650361E98FC36B1BA");
        let k = pinned_key().expect("embedded key");
        assert_eq!(hex(&k.fpr), PINNED_FPR);
        assert_eq!(short_fpr(), "A6E6…4EA3");
    }

    #[test]
    fn valid_release_signature_verifies() {
        verify_detached(SUMS, ASC).expect("v0.6.1 SHA256SUMS.asc is a good signature by the pinned key");
        sums_cover_version(SUMS, "0.6.1").unwrap();
        assert!(sums_cover_version(SUMS, "9.9.9").is_err(), "old sums replayed under a newer tag");
    }

    #[test]
    fn tampered_sums_rejected() {
        let mut t = SUMS.to_vec();
        t[0] ^= 1;
        assert!(verify_detached(&t, ASC).unwrap_err().contains("does not verify"));
        let mut t = SUMS.to_vec();
        t.extend_from_slice(b"00  evil\n");
        assert!(verify_detached(&t, ASC).is_err());
    }

    #[test]
    fn tampered_signature_rejected() {
        let bin = dearmor(std::str::from_utf8(ASC).unwrap(), "SIGNATURE").unwrap();
        let (_, body) = packets(&bin).unwrap()[0];
        let mut b = body.to_vec();
        let n = b.len();
        b[n - 1] ^= 0x40; // a bit of S
        assert!(verify_packet(&pinned_key().unwrap(), SUMS, &b).is_err());
    }

    #[test]
    fn wrong_key_rejected() {
        assert!(verify_detached(SUMS, WRONG).unwrap_err().contains("another key"));
        // the wrong key's signature with its issuer rewritten to the pinned fingerprint:
        // the issuer check passes, the curve check must still refuse it
        let bin = dearmor(std::str::from_utf8(WRONG).unwrap(), "SIGNATURE").unwrap();
        let (_, body) = packets(&bin).unwrap()[0];
        let mut b = body.to_vec();
        let at = b.windows(3).position(|w| w == [22, 33, 4]).expect("issuer fpr subpacket") + 3;
        b[at..at + 20].copy_from_slice(&pinned_key().unwrap().fpr);
        assert!(verify_packet(&pinned_key().unwrap(), SUMS, &b).unwrap_err().contains("does not verify"));
    }

    #[test]
    fn missing_or_garbage_signature_rejected() {
        assert!(verify_detached(SUMS, b"").is_err());
        assert!(verify_detached(SUMS, b"-----BEGIN PGP SIGNATURE-----\n\n-----END PGP SIGNATURE-----\n").is_err());
        assert!(verify_detached(SUMS, PINNED_KEY_ASC.as_bytes()).is_err(), "a public key is not a signature");
        let c = Candidate { tag: "v0.9.0".into(), version: "0.9.0".into(), sums: Some("https://github.com/x/SHA256SUMS".into()), asc: None };
        let f = |_: &str, _: u64, _: &str| -> Result<Vec<u8>, String> { panic!("nothing is fetched without both files") };
        assert!(signed(&f, &c).is_err());
    }

    fn rel(tag: &str, draft: bool, pre: bool, sums: bool, asc: bool) -> Value {
        let mut assets = vec![json!({"name": format!("opensidian-{}-x86_64.deb", tag.trim_start_matches('v')), "browser_download_url": "https://github.com/x/deb"})];
        if sums {
            assets.push(json!({"name": "SHA256SUMS", "browser_download_url": format!("https://github.com/jpzk/opensidian/releases/download/{tag}/SHA256SUMS")}));
        }
        if asc {
            assets.push(json!({"name": "SHA256SUMS.asc", "browser_download_url": format!("https://github.com/jpzk/opensidian/releases/download/{tag}/SHA256SUMS.asc")}));
        }
        json!({"tag_name": tag, "draft": draft, "prerelease": pre, "published_at": "2026-10-09T00:00:00Z", "assets": assets})
    }

    #[test]
    fn picks_highest_published_stable_numeric_tag() {
        let l = json!([rel("v0.4", false, false, true, true), rel("v0.6.1", false, false, true, true), rel("v0.9.0", true, false, true, true),
                       rel("v0.8.0", false, true, true, true), rel("v1.0.0-rc1", false, false, true, true), rel("v0.6.2", false, false, true, true)]);
        let c = pick_latest(l.to_string().as_bytes()).unwrap().unwrap();
        assert_eq!((c.tag.as_str(), c.version.as_str()), ("v0.6.2", "0.6.2"));
        assert_eq!(tag_version("v0.4").as_deref(), Some("0.4"));
        assert_eq!(tag_version("v1.2.3.4"), None);
        assert_eq!(tag_version("../x"), None);
    }

    /// the whole check against an offline GitHub: v0.6.1's real files as the newest release
    fn gh(list: Value, asc: &'static [u8], sums: &'static [u8]) -> impl Fn(&str, u64, &str) -> Result<Vec<u8>, String> {
        move |u: &str, cap: u64, _: &str| {
            plugin_store::check_url(u)?;
            let b: Vec<u8> = if u == RELEASES_URL {
                list.to_string().into_bytes()
            } else if u.ends_with("/SHA256SUMS") {
                sums.to_vec()
            } else if u.ends_with("/SHA256SUMS.asc") {
                asc.to_vec()
            } else {
                return Err(format!("unexpected fetch {u}"));
            };
            assert!(b.len() as u64 <= cap);
            Ok(b)
        }
    }

    #[test]
    fn check_reports_available_current_and_unsigned() {
        let l = json!([rel("v0.6.1", false, false, true, true), rel("v0.4", false, false, true, true)]);
        let r = check(&gh(l.clone(), ASC, SUMS), "0.6.0").unwrap();
        assert_eq!(r["status"], "available");
        assert_eq!(r["text"], "Opensidian 0.6.1 is available — signed by A6E6…4EA3");
        assert_eq!(r["url"], "https://github.com/jpzk/opensidian/releases/tag/v0.6.1");
        let r = check(&gh(l.clone(), ASC, SUMS), "0.7.0").unwrap();
        assert_eq!(r["status"], "current");
        assert!(r["text"].as_str().unwrap().starts_with("Opensidian is up to date (0.7.0)"));
        for (asc, sums) in [(WRONG, SUMS), (ASC, b"00  opensidian-0.6.1-x\n" as &[u8])] {
            let r = check(&gh(l.clone(), asc, sums), "0.6.0").unwrap();
            assert_eq!(r["status"], "unsigned", "{r}");
            assert_eq!(r["text"], "Latest release 0.6.1 is NOT signed (or signature invalid) — ignored.");
            assert!(r.get("url").is_none(), "an unsigned release is never offered");
        }
        let nosig = json!([rel("v0.6.1", false, false, true, false)]);
        assert_eq!(check(&gh(nosig, ASC, SUMS), "0.6.0").unwrap()["status"], "unsigned");
        let down = |_: &str, _: u64, _: &str| -> Result<Vec<u8>, String> { Err("releases: api.github.com — no route".into()) };
        assert!(check(&down, "0.7.0").unwrap_err().contains("no route"));
    }
}
