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
         against "/" (the virtual root), never a host path. No path.win32.
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
  path.posix = path;   // before the freeze (strict mode: assigning on a frozen object throws)
  for (const k of Object.keys(path)) if (typeof path[k] === "function") Object.freeze(path[k]);
  Object.freeze(path);

  // name -> leaf. A null-prototype frozen map: "constructor", "__proto__",
  // "toString" are not modules.
  const LEAVES = Object.freeze(Object.assign(Object.create(null), {
    "path": path, "node:path": path, "path/posix": path, "node:path/posix": path,
  }));

  Object.defineProperty(window, "__osNodeModules", {
    configurable: false, writable: false, enumerable: false,
    value: Object.freeze({
      get: name => (typeof name === "string" && Object.prototype.hasOwnProperty.call(LEAVES, name) ? LEAVES[name] : undefined),
      names: Object.freeze(Object.keys(LEAVES)),
    }),
  });
})();
