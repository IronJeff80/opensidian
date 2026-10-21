// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* ui/plugins/node-leaves.js (td-node-leaves): the pure Node compatibility LEAVES a community plugin may
   require(). Loaded by index.html BEFORE ui/plugins/loader.js, whose require()
   asks window.__osNodeModules.get(name) first and falls through to its deny
   list / "unknown module" when this returns undefined.

   A leaf is pure: string/number in, string/object out, no I/O, no host state.
     "path", "node:path", "path/posix" -> ONE frozen object, a port of Node's
         lib/path.js posix half (normalize/join/resolve/relative/dirname/
         basename/extname/parse/format/isAbsolute/toNamespacedPath, sep ":"
         delimiter, path.posix === path). Non-string arguments throw a
         TypeError with code ERR_INVALID_ARG_TYPE, as in Node.
         There is no working directory: resolve() of relative segments resolves
         against "/" (the virtual root), never a host path. path.win32 /
         "path/win32": the win32 half, same rules (top10-func).
   Deliberately NOT here (see the brief): net, sockets, os, process (cwd,
   chdir, argv, execPath, env, stdio, signals, exit, kill, binding, dlopen),
   crypto, a window/global require. A process or crypto leaf is only added
   when a pinned plugin fixture demonstrates the need. */
(function () {
  "use strict";
  const SL = 47, DOT = 46;

  function argErr(name, v) {
    const e = new TypeError('The "' + name + '" argument must be of type string. Received ' + (v === null ? "null" : typeof v));
    e.code = "ERR_INVALID_ARG_TYPE";
    return e;
  }
  const str = (v, name) => { if (typeof v !== "string") throw argErr(name, v); };

  // Node lib/path.js normalizeString: resolves "." and ".." in a path with no
  // leading slash semantics; allowAboveRoot keeps leading ".." segments
  function normalizeString(p, allowAboveRoot) {
    let res = "", lastSegmentLength = 0, lastSlash = -1, dots = 0, code = 0;
    for (let i = 0; i <= p.length; ++i) {
      if (i < p.length) code = p.charCodeAt(i);
      else if (code === SL) break;
      else code = SL;
      if (code === SL) {
        if (lastSlash === i - 1 || dots === 1) {
          // empty segment or "."
        } else if (dots === 2) {
          if (res.length < 2 || lastSegmentLength !== 2 || res.charCodeAt(res.length - 1) !== DOT || res.charCodeAt(res.length - 2) !== DOT) {
            if (res.length > 2) {
              const k = res.lastIndexOf("/");
              if (k === -1) { res = ""; lastSegmentLength = 0; }
              else { res = res.slice(0, k); lastSegmentLength = res.length - 1 - res.lastIndexOf("/"); }
              lastSlash = i; dots = 0; continue;
            } else if (res.length !== 0) {
              res = ""; lastSegmentLength = 0; lastSlash = i; dots = 0; continue;
            }
          }
          if (allowAboveRoot) { res += res.length > 0 ? "/.." : ".."; lastSegmentLength = 2; }
        } else {
          res += (res.length > 0 ? "/" : "") + p.slice(lastSlash + 1, i);
          lastSegmentLength = i - lastSlash - 1;
        }
        lastSlash = i; dots = 0;
      } else if (code === DOT && dots !== -1) ++dots;
      else dots = -1;
    }
    return res;
  }

  const path = {
    sep: "/",
    delimiter: ":",
    resolve(...args) {
      let r = "", abs = false;
      for (let i = args.length - 1; i >= -1 && !abs; i--) {
        const p = i >= 0 ? args[i] : "/";   // no cwd: the virtual root
        str(p, "paths[" + i + "]");
        if (p.length === 0) continue;
        r = p + "/" + r;
        abs = p.charCodeAt(0) === SL;
      }
      r = normalizeString(r, !abs);
      return abs ? "/" + r : (r.length > 0 ? r : ".");
    },
    normalize(p) {
      str(p, "path");
      if (p.length === 0) return ".";
      const abs = p.charCodeAt(0) === SL, trail = p.charCodeAt(p.length - 1) === SL;
      p = normalizeString(p, !abs);
      if (p.length === 0) return abs ? "/" : trail ? "./" : ".";
      if (trail) p += "/";
      return abs ? "/" + p : p;
    },
    isAbsolute(p) { str(p, "path"); return p.length > 0 && p.charCodeAt(0) === SL; },
    join(...args) {
      if (args.length === 0) return ".";
      let j;
      for (const a of args) { str(a, "path"); if (a.length > 0) j = j === undefined ? a : j + "/" + a; }
      return j === undefined ? "." : path.normalize(j);
    },
    relative(from, to) {
      str(from, "from"); str(to, "to");
      if (from === to) return "";
      from = path.resolve(from); to = path.resolve(to);
      if (from === to) return "";
      const fromStart = 1, fromEnd = from.length, fromLen = fromEnd - fromStart, toStart = 1, toLen = to.length - toStart;
      const length = fromLen < toLen ? fromLen : toLen;
      let lastCommonSep = -1, i = 0;
      for (; i < length; i++) {
        const c = from.charCodeAt(fromStart + i);
        if (c !== to.charCodeAt(toStart + i)) break;
        else if (c === SL) lastCommonSep = i;
      }
      if (i === length) {
        if (toLen > length) {
          if (to.charCodeAt(toStart + i) === SL) return to.slice(toStart + i + 1);
          if (i === 0) return to.slice(toStart + i);
        } else if (fromLen > length) {
          if (from.charCodeAt(fromStart + i) === SL) lastCommonSep = i;
          else if (i === 0) lastCommonSep = 0;
        }
      }
      let out = "";
      for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i)
        if (i === fromEnd || from.charCodeAt(i) === SL) out += out.length === 0 ? ".." : "/..";
      return out + to.slice(toStart + lastCommonSep);
    },
    toNamespacedPath(p) { return p; },
    dirname(p) {
      str(p, "path");
      if (p.length === 0) return ".";
      const root = p.charCodeAt(0) === SL;
      let end = -1, matched = true;
      for (let i = p.length - 1; i >= 1; --i) {
        if (p.charCodeAt(i) === SL) { if (!matched) { end = i; break; } }
        else matched = false;
      }
      if (end === -1) return root ? "/" : ".";
      if (root && end === 1) return "//";
      return p.slice(0, end);
    },
    basename(p, suffix) {
      if (suffix !== undefined) str(suffix, "suffix");
      str(p, "path");
      let start = 0, end = -1, matched = true;
      if (suffix !== undefined && suffix.length > 0 && suffix.length <= p.length) {
        if (suffix === p) return "";
        let extIdx = suffix.length - 1, firstNonSlashEnd = -1;
        for (let i = p.length - 1; i >= 0; --i) {
          const c = p.charCodeAt(i);
          if (c === SL) { if (!matched) { start = i + 1; break; } }
          else {
            if (firstNonSlashEnd === -1) { matched = false; firstNonSlashEnd = i + 1; }
            if (extIdx >= 0) {
              if (c === suffix.charCodeAt(extIdx)) { if (--extIdx === -1) end = i; }
              else { extIdx = -1; end = firstNonSlashEnd; }
            }
          }
        }
        if (start === end) end = firstNonSlashEnd;
        else if (end === -1) end = p.length;
        return p.slice(start, end);
      }
      for (let i = p.length - 1; i >= 0; --i) {
        if (p.charCodeAt(i) === SL) { if (!matched) { start = i + 1; break; } }
        else if (end === -1) { matched = false; end = i + 1; }
      }
      return end === -1 ? "" : p.slice(start, end);
    },
    extname(p) {
      str(p, "path");
      let startDot = -1, startPart = 0, end = -1, matched = true, pre = 0;
      for (let i = p.length - 1; i >= 0; --i) {
        const c = p.charCodeAt(i);
        if (c === SL) { if (!matched) { startPart = i + 1; break; } continue; }
        if (end === -1) { matched = false; end = i + 1; }
        if (c === DOT) { if (startDot === -1) startDot = i; else if (pre !== 1) pre = 1; }
        else if (startDot !== -1) pre = -1;
      }
      if (startDot === -1 || end === -1 || pre === 0 || (pre === 1 && startDot === end - 1 && startDot === startPart + 1)) return "";
      return p.slice(startDot, end);
    },
    format(o) {
      if (o === null || typeof o !== "object") {
        const e = new TypeError('The "pathObject" argument must be of type object. Received ' + (o === null ? "null" : typeof o));
        e.code = "ERR_INVALID_ARG_TYPE"; throw e;
      }
      const dir = o.dir || o.root;
      const ext = o.ext ? (o.ext[0] === "." ? "" : ".") + o.ext : "";
      const base = o.base || (o.name || "") + ext;
      if (!dir) return base;
      return dir === o.root ? dir + base : dir + "/" + base;
    },
    parse(p) {
      str(p, "path");
      const ret = { root: "", dir: "", base: "", ext: "", name: "" };
      if (p.length === 0) return ret;
      const abs = p.charCodeAt(0) === SL;
      let start = 0;
      if (abs) { ret.root = "/"; start = 1; }
      let startDot = -1, startPart = 0, end = -1, matched = true, pre = 0;
      for (let i = p.length - 1; i >= start; --i) {
        const c = p.charCodeAt(i);
        if (c === SL) { if (!matched) { startPart = i + 1; break; } continue; }
        if (end === -1) { matched = false; end = i + 1; }
        if (c === DOT) { if (startDot === -1) startDot = i; else if (pre !== 1) pre = 1; }
        else if (startDot !== -1) pre = -1;
      }
      if (end !== -1) {
        const s = startPart === 0 && abs ? 1 : startPart;
        if (startDot === -1 || pre === 0 || (pre === 1 && startDot === end - 1 && startDot === startPart + 1)) {
          ret.base = ret.name = p.slice(s, end);
        } else {
          ret.name = p.slice(s, startDot); ret.base = p.slice(s, end); ret.ext = p.slice(startDot, end);
        }
      }
      if (startPart > 0) ret.dir = p.slice(0, startPart - 1);
      else if (abs) ret.dir = "/";
      return ret;
    },
  };

  /* path.win32 (goal top10-func; Copilot picks e.win32 vs e.posix by its own platform test and
     builds Windows install paths with it). A port of the win32 half of Node's lib/path.js, same
     rules: "\\" and "/" both separate, a drive ("C:") or UNC root ("\\\\server\\share") is the
     device, case-insensitive compare in relative(). Pure strings, no I/O. There is no working
     directory: resolve() of a path with no root resolves against "\\" (the root of no drive), as
     the posix half resolves against "/". */
  const BS = 92;
  const wsep = c => c === SL || c === BS;
  const wdev = c => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  function wnorm(p, allowAboveRoot) {   // normalizeString with either separator, "\\" out
    let res = "", lastSegmentLength = 0, lastSlash = -1, dots = 0, code = 0;
    for (let i = 0; i <= p.length; ++i) {
      if (i < p.length) code = p.charCodeAt(i);
      else if (wsep(code)) break;
      else code = SL;
      if (wsep(code)) {
        if (lastSlash === i - 1 || dots === 1) {
          // empty segment or "."
        } else if (dots === 2) {
          if (res.length < 2 || lastSegmentLength !== 2 || res.charCodeAt(res.length - 1) !== DOT || res.charCodeAt(res.length - 2) !== DOT) {
            if (res.length > 2) {
              const k = res.lastIndexOf("\\");
              if (k === -1) { res = ""; lastSegmentLength = 0; }
              else { res = res.slice(0, k); lastSegmentLength = res.length - 1 - res.lastIndexOf("\\"); }
              lastSlash = i; dots = 0; continue;
            } else if (res.length !== 0) {
              res = ""; lastSegmentLength = 0; lastSlash = i; dots = 0; continue;
            }
          }
          if (allowAboveRoot) { res += res.length > 0 ? "\\.." : ".."; lastSegmentLength = 2; }
        } else {
          res += (res.length > 0 ? "\\" : "") + p.slice(lastSlash + 1, i);
          lastSegmentLength = i - lastSlash - 1;
        }
        lastSlash = i; dots = 0;
      } else if (code === DOT && dots !== -1) ++dots;
      else dots = -1;
    }
    return res;
  }
  // the root of p: device ("C:" / "\\\\server\\share" / ""), where the root ends, absolute or not
  function wroot(p) {
    const len = p.length;
    let device = "", rootEnd = 0, abs = false;
    if (len === 0) return { device, rootEnd, abs };
    const c = p.charCodeAt(0);
    if (len === 1) { if (wsep(c)) { rootEnd = 1; abs = true; } return { device, rootEnd, abs }; }
    if (wsep(c)) {
      abs = true;
      if (wsep(p.charCodeAt(1))) {
        let j = 2, last = j;
        while (j < len && !wsep(p.charCodeAt(j))) j++;
        if (j < len && j !== last) {
          const first = p.slice(last, j);
          last = j;
          while (j < len && wsep(p.charCodeAt(j))) j++;
          if (j < len && j !== last) {
            last = j;
            while (j < len && !wsep(p.charCodeAt(j))) j++;
            if (j === len || j !== last) { device = "\\\\" + first + "\\" + p.slice(last, j); rootEnd = j; }
          }
        }
      } else rootEnd = 1;
    } else if (wdev(c) && p.charCodeAt(1) === 58) {
      device = p.slice(0, 2); rootEnd = 2;
      if (len > 2 && wsep(p.charCodeAt(2))) { abs = true; rootEnd = 3; }
    }
    return { device, rootEnd, abs };
  }
  const win32 = {
    sep: "\\",
    delimiter: ";",
    resolve(...args) {
      let dev = "", tail = "", abs = false;
      for (let i = args.length - 1; i >= -1; i--) {
        let p;
        if (i >= 0) { p = args[i]; str(p, "paths[" + i + "]"); if (p.length === 0) continue; }
        else p = dev ? dev + "\\" : "\\";
        const r = wroot(p);
        if (r.device.length > 0) {
          if (dev.length > 0) { if (r.device.toLowerCase() !== dev.toLowerCase()) continue; }
          else dev = r.device;
        }
        if (abs) { if (dev.length > 0) break; }
        else {
          tail = p.slice(r.rootEnd) + "\\" + tail;
          abs = r.abs;
          if (abs && dev.length > 0) break;
        }
      }
      tail = wnorm(tail, !abs);
      return abs ? dev + "\\" + tail : (dev + tail) || ".";
    },
    normalize(p) {
      str(p, "path");
      const len = p.length;
      if (len === 0) return ".";
      if (len === 1) return wsep(p.charCodeAt(0)) ? "\\" : p;
      const r = wroot(p);
      let tail = r.rootEnd < len ? wnorm(p.slice(r.rootEnd), !r.abs) : "";
      if (tail.length === 0 && !r.abs) tail = ".";
      if (tail.length > 0 && wsep(p.charCodeAt(len - 1))) tail += "\\";
      if (!r.device) return r.abs ? "\\" + tail : tail;
      return r.abs ? r.device + "\\" + tail : r.device + tail;
    },
    isAbsolute(p) {
      str(p, "path");
      const len = p.length;
      if (len === 0) return false;
      const c = p.charCodeAt(0);
      return wsep(c) || (len > 2 && wdev(c) && p.charCodeAt(1) === 58 && wsep(p.charCodeAt(2)));
    },
    join(...args) {
      if (args.length === 0) return ".";
      let joined, first;
      for (let i = 0; i < args.length; ++i) {
        const a = args[i]; str(a, "path");
        if (a.length > 0) { if (joined === undefined) joined = first = a; else joined += "\\" + a; }
      }
      if (joined === undefined) return ".";
      // a UNC root only when the FIRST part starts with exactly two separators
      let replace = true, slashes = 0;
      if (wsep(first.charCodeAt(0))) {
        ++slashes;
        const fl = first.length;
        if (fl > 1 && wsep(first.charCodeAt(1))) {
          ++slashes;
          if (fl > 2) { if (wsep(first.charCodeAt(2))) ++slashes; else replace = false; }
        }
      }
      if (replace) {
        while (slashes < joined.length && wsep(joined.charCodeAt(slashes))) slashes++;
        if (slashes >= 2) joined = "\\" + joined.slice(slashes);
      }
      return win32.normalize(joined);
    },
    relative(from, to) {
      str(from, "from"); str(to, "to");
      if (from === to) return "";
      const fo = win32.resolve(from), toO = win32.resolve(to);
      if (fo === toO) return "";
      from = fo.toLowerCase(); to = toO.toLowerCase();
      if (from === to) return "";
      let fs = 0; while (fs < from.length && from.charCodeAt(fs) === BS) fs++;
      let fe = from.length; while (fe - 1 > fs && from.charCodeAt(fe - 1) === BS) fe--;
      const fl = fe - fs;
      let ts = 0; while (ts < to.length && to.charCodeAt(ts) === BS) ts++;
      let te = to.length; while (te - 1 > ts && to.charCodeAt(te - 1) === BS) te--;
      const tl = te - ts;
      const length = fl < tl ? fl : tl;
      let lastSep = -1, i = 0;
      for (; i < length; i++) {
        const c = from.charCodeAt(fs + i);
        if (c !== to.charCodeAt(ts + i)) break;
        else if (c === BS) lastSep = i;
      }
      if (i !== length) { if (lastSep === -1) return toO; }
      else {
        if (tl > length) {
          if (to.charCodeAt(ts + i) === BS) return toO.slice(ts + i + 1);
          if (i === 2) return toO.slice(ts + i);
        }
        if (fl > length) {
          if (from.charCodeAt(fs + i) === BS) lastSep = i;
          else if (i === 2) lastSep = 3;
        }
        if (lastSep === -1) lastSep = 0;
      }
      let out = "";
      for (i = fs + lastSep + 1; i <= fe; ++i) if (i === fe || from.charCodeAt(i) === BS) out += out.length === 0 ? ".." : "\\..";
      ts += lastSep;
      if (out.length > 0) return out + toO.slice(ts, te);
      if (toO.charCodeAt(ts) === BS) ++ts;
      return toO.slice(ts, te);
    },
    toNamespacedPath(p) {
      if (typeof p !== "string" || p.length === 0) return p;
      const r = win32.resolve(p);
      if (r.length <= 2) return p;
      if (r.charCodeAt(0) === BS) {
        if (r.charCodeAt(1) === BS) { const c = r.charCodeAt(2); if (c !== 63 && c !== DOT) return "\\\\?\\UNC\\" + r.slice(2); }
      } else if (wdev(r.charCodeAt(0)) && r.charCodeAt(1) === 58 && r.charCodeAt(2) === BS) return "\\\\?\\" + r;
      return p;
    },
    dirname(p) {
      str(p, "path");
      const len = p.length;
      if (len === 0) return ".";
      let rootEnd = -1, offset = 0;
      const c = p.charCodeAt(0);
      if (len === 1) return wsep(c) ? p : ".";
      if (wsep(c)) {
        rootEnd = offset = 1;
        if (wsep(p.charCodeAt(1))) {
          let j = 2, last = j;
          while (j < len && !wsep(p.charCodeAt(j))) j++;
          if (j < len && j !== last) {
            last = j;
            while (j < len && wsep(p.charCodeAt(j))) j++;
            if (j < len && j !== last) {
              last = j;
              while (j < len && !wsep(p.charCodeAt(j))) j++;
              if (j === len) return p;   // a UNC root only
              if (j !== last) rootEnd = offset = j + 1;
            }
          }
        }
      } else if (wdev(c) && p.charCodeAt(1) === 58) {
        rootEnd = len > 2 && wsep(p.charCodeAt(2)) ? 3 : 2;
        offset = rootEnd;
      }
      let end = -1, matched = true;
      for (let i = len - 1; i >= offset; --i) {
        if (wsep(p.charCodeAt(i))) { if (!matched) { end = i; break; } }
        else matched = false;
      }
      if (end === -1) { if (rootEnd === -1) return "."; end = rootEnd; }
      return p.slice(0, end);
    },
    basename(p, suffix) {
      if (suffix !== undefined) str(suffix, "suffix");
      str(p, "path");
      let start = 0, end = -1, matched = true;
      if (p.length >= 2 && wdev(p.charCodeAt(0)) && p.charCodeAt(1) === 58) start = 2;
      if (suffix !== undefined && suffix.length > 0 && suffix.length <= p.length) {
        if (suffix === p) return "";
        let extIdx = suffix.length - 1, firstNonSlashEnd = -1;
        for (let i = p.length - 1; i >= start; --i) {
          const c = p.charCodeAt(i);
          if (wsep(c)) { if (!matched) { start = i + 1; break; } }
          else {
            if (firstNonSlashEnd === -1) { matched = false; firstNonSlashEnd = i + 1; }
            if (extIdx >= 0) {
              if (c === suffix.charCodeAt(extIdx)) { if (--extIdx === -1) end = i; }
              else { extIdx = -1; end = firstNonSlashEnd; }
            }
          }
        }
        if (start === end) end = firstNonSlashEnd;
        else if (end === -1) end = p.length;
        return p.slice(start, end);
      }
      for (let i = p.length - 1; i >= start; --i) {
        if (wsep(p.charCodeAt(i))) { if (!matched) { start = i + 1; break; } }
        else if (end === -1) { matched = false; end = i + 1; }
      }
      return end === -1 ? "" : p.slice(start, end);
    },
    extname(p) {
      str(p, "path");
      let start = 0, startDot = -1, startPart = 0, end = -1, matched = true, pre = 0;
      if (p.length >= 2 && p.charCodeAt(1) === 58 && wdev(p.charCodeAt(0))) start = startPart = 2;
      for (let i = p.length - 1; i >= start; --i) {
        const c = p.charCodeAt(i);
        if (wsep(c)) { if (!matched) { startPart = i + 1; break; } continue; }
        if (end === -1) { matched = false; end = i + 1; }
        if (c === DOT) { if (startDot === -1) startDot = i; else if (pre !== 1) pre = 1; }
        else if (startDot !== -1) pre = -1;
      }
      if (startDot === -1 || end === -1 || pre === 0 || (pre === 1 && startDot === end - 1 && startDot === startPart + 1)) return "";
      return p.slice(startDot, end);
    },
    format(o) {
      if (o === null || typeof o !== "object") {
        const e = new TypeError('The "pathObject" argument must be of type object. Received ' + (o === null ? "null" : typeof o));
        e.code = "ERR_INVALID_ARG_TYPE"; throw e;
      }
      const dir = o.dir || o.root;
      const ext = o.ext ? (o.ext[0] === "." ? "" : ".") + o.ext : "";
      const base = o.base || (o.name || "") + ext;
      if (!dir) return base;
      return dir === o.root ? dir + base : dir + "\\" + base;
    },
    parse(p) {
      str(p, "path");
      const ret = { root: "", dir: "", base: "", ext: "", name: "" };
      const len = p.length;
      if (len === 0) return ret;
      let rootEnd = 0;
      const c0 = p.charCodeAt(0);
      if (len === 1) {
        if (wsep(c0)) { ret.root = ret.dir = p; return ret; }
        ret.base = ret.name = p; return ret;
      }
      if (wsep(c0)) {
        rootEnd = 1;
        if (wsep(p.charCodeAt(1))) {
          let j = 2, last = j;
          while (j < len && !wsep(p.charCodeAt(j))) j++;
          if (j < len && j !== last) {
            last = j;
            while (j < len && wsep(p.charCodeAt(j))) j++;
            if (j < len && j !== last) {
              last = j;
              while (j < len && !wsep(p.charCodeAt(j))) j++;
              if (j === len) rootEnd = j;
              else if (j !== last) rootEnd = j + 1;
            }
          }
        }
      } else if (wdev(c0) && p.charCodeAt(1) === 58) {
        if (len <= 2) { ret.root = ret.dir = p; return ret; }
        rootEnd = 2;
        if (wsep(p.charCodeAt(2))) {
          if (len === 3) { ret.root = ret.dir = p; return ret; }
          rootEnd = 3;
        }
      }
      if (rootEnd > 0) ret.root = p.slice(0, rootEnd);
      let startDot = -1, startPart = rootEnd, end = -1, matched = true, pre = 0;
      for (let i = len - 1; i >= rootEnd; --i) {
        const c = p.charCodeAt(i);
        if (wsep(c)) { if (!matched) { startPart = i + 1; break; } continue; }
        if (end === -1) { matched = false; end = i + 1; }
        if (c === DOT) { if (startDot === -1) startDot = i; else if (pre !== 1) pre = 1; }
        else if (startDot !== -1) pre = -1;
      }
      if (end !== -1) {
        if (startDot === -1 || pre === 0 || (pre === 1 && startDot === end - 1 && startDot === startPart + 1)) ret.base = ret.name = p.slice(startPart, end);
        else { ret.name = p.slice(startPart, startDot); ret.base = p.slice(startPart, end); ret.ext = p.slice(startDot, end); }
      }
      ret.dir = startPart > 0 && startPart !== rootEnd ? p.slice(0, startPart - 1) : ret.root;
      return ret;
    },
  };
  win32.win32 = win32; win32.posix = path; path.win32 = win32;
  path.posix = path;   // before the freeze (strict mode: assigning on a frozen object throws)
  for (const o of [path, win32]) for (const k of Object.keys(o)) if (typeof o[k] === "function") Object.freeze(o[k]);
  Object.freeze(win32);
  Object.freeze(path);

  // name -> leaf. A null-prototype frozen map: "constructor", "__proto__",
  // "toString" are not modules.
  const LEAVES = Object.freeze(Object.assign(Object.create(null), {
    "path": path, "node:path": path, "path/posix": path, "node:path/posix": path, "path/win32": win32, "node:path/win32": win32,
  }));

  Object.defineProperty(window, "__osNodeModules", {
    configurable: false, writable: false, enumerable: false,
    value: Object.freeze({
      get: name => (typeof name === "string" && Object.prototype.hasOwnProperty.call(LEAVES, name) ? LEAVES[name] : undefined),
      names: Object.freeze(Object.keys(LEAVES)),
    }),
  });
})();
