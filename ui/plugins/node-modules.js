// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* Node-compatible modules a community plugin may require(), as NAMED,
   allowlisted objects. Loaded by index.html after loader.js and BEFORE api.js
   (which freezes the host); it registers host.nodeModules, which the loader's require()
   consults before its deny list (ui/plugins/loader.js). Nothing here is a
   general Node loader: a name resolve() does not answer stays denied there.

   ---- the `fs` block (goal td-vault-io) ----
   fs / node:fs / fs/promises / node:fs/promises over the confined vault core
   api.js hands over as host.vfs (its Rust side: vaultfs.rs plugin_op). Paths
   are virtual: "/vault/x" and "x" are the same vault file; anything else
   absolute, any traversal, symlink, device or encoded form is refused by Rust
   with code EPERM ("vault-escape refused"). Listed, callback and promise
   forms: readFile writeFile appendFile stat lstat readdir mkdir rename
   copyFile unlink rm rmdir access exists. Everything else that touches the
   host — file descriptors, streams, watchers, permissions, owners, links,
   realpath, every *Sync — throws ENOSYS: there is no host path to hand out. */
(function () {
  "use strict";
  const host = window.__osPluginHost;
  if (!host) return;
  let fsMods = null;      // built on the first require: host.vfs is set later, by api.js
  function buildFs(V) {

  /* ------------------------------------------------------------ fs */
  const constants = Object.freeze({ F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4 });
  const enoent = p => { const e = new Error("ENOENT: no such file or directory, '" + p + "'"); e.code = "ENOENT"; e.path = String(p); return e; };
  const eexist = p => { const e = new Error("EEXIST: file already exists, '" + p + "'"); e.code = "EEXIST"; e.path = String(p); return e; };
  const encOf = o => (typeof o === "string" ? o : o && typeof o === "object" ? o.encoding || null : null);

  /* Node's Buffer encodings for readFile / writeFile / appendFile with an encoding: the bytes are
     decoded / encoded here (no Buffer in this realm). An unknown name is Node's own TypeError. */
  const ENCS = new Set(["utf8", "utf-8", "latin1", "binary", "ascii", "base64", "base64url", "hex", "utf16le", "utf-16le", "ucs2", "ucs-2"]);
  function encName(enc) {
    const n = String(enc).toLowerCase();
    if (ENCS.has(n)) return n;
    const e = new TypeError("The argument 'encoding' is invalid encoding. Received '" + String(enc) + "'"); e.code = "ERR_INVALID_ARG_VALUE"; throw e;
  }
  const bin = u => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return s; };
  function decodeAs(u, enc) {
    switch (encName(enc)) {
      case "utf8": case "utf-8": return V.utf8(u);
      case "latin1": case "binary": return bin(u);
      case "ascii": return bin(u.map(b => b & 0x7f));
      case "base64": return btoa(bin(u));
      case "base64url": return btoa(bin(u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      case "hex": return Array.from(u, b => (b < 16 ? "0" : "") + b.toString(16)).join("");
      default: return new TextDecoder("utf-16le").decode(u);   // utf16le / ucs2
    }
  }
  function encodeAs(s, enc) {
    s = String(s);
    switch (encName(enc)) {
      case "utf8": case "utf-8": return V.toBytes(s);
      case "latin1": case "binary": case "ascii": return Uint8Array.from(s, c => c.charCodeAt(0) & 0xff);
      case "base64": case "base64url": {
        let t = s.replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/]/g, "");
        if (t.length % 4 === 1) t = t.slice(0, -1);   // Node drops a dangling sextet
        while (t.length % 4) t += "=";
        return Uint8Array.from(atob(t), c => c.charCodeAt(0));
      }
      case "hex": { const m = s.match(/^(?:[0-9a-fA-F]{2})*/)[0]; const u = new Uint8Array(m.length / 2); for (let i = 0; i < u.length; i++) u[i] = parseInt(m.substr(i * 2, 2), 16); return u; }
      default: { const u = new Uint8Array(s.length * 2); for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); u[2 * i] = c & 0xff; u[2 * i + 1] = c >> 8; } return u; }
    }
  }
  const dataOf = (d, o) => { const enc = encOf(o); return typeof d === "string" && enc ? encodeAs(d, enc) : d; };

  class Stats {
    constructor(s) {
      const t = s.type === "folder";
      // synthetic: no inode, device, mode bits, owner or host path exist here
      Object.assign(this, { dev: 0, ino: 0, mode: t ? 0o40755 : 0o100644, nlink: 1, uid: 0, gid: 0, rdev: 0, size: s.size, blksize: 4096, blocks: Math.ceil(s.size / 512),
        atimeMs: s.mtime, mtimeMs: s.mtime, ctimeMs: s.ctime, birthtimeMs: s.ctime,
        atime: new Date(s.mtime), mtime: new Date(s.mtime), ctime: new Date(s.ctime), birthtime: new Date(s.ctime) });
      Object.defineProperty(this, "_dir", { value: t });
    }
    isFile() { return !this._dir; }
    isDirectory() { return this._dir; }
    isSymbolicLink() { return false; }
    isBlockDevice() { return false; }
    isCharacterDevice() { return false; }
    isFIFO() { return false; }
    isSocket() { return false; }
  }
  class Dirent {
    constructor(name, k, parent) { this.name = name; this.parentPath = this.path = parent; Object.defineProperty(this, "_k", { value: k }); }
    isFile() { return this._k === "file"; }
    isDirectory() { return this._k === "folder"; }
    isSymbolicLink() { return false; }
    isBlockDevice() { return false; }
    isCharacterDevice() { return false; }
    isFIFO() { return false; }
    isSocket() { return false; }
  }

  async function rmTree(p) {
    for (const [n, k] of await V.list(p)) {
      const c = String(p).replace(/\/+$/, "") + "/" + n;
      if (k === "folder") { await rmTree(c); await V.rmdir(c); } else await V.unlink(c);
    }
  }
  const P = {
    async readFile(p, o) { const enc = encOf(o); if (enc) encName(enc); const u = await V.read(p); return enc ? decodeAs(u, enc) : u; },
    async writeFile(p, d, o) { await V.write(p, dataOf(d, o)); },
    async appendFile(p, d, o) { await V.append(p, dataOf(d, o)); },
    async stat(p) { return new Stats(await V.stat(p)); },
    async lstat(p) { return new Stats(await V.stat(p)); },        // Rust refuses a symlink: lstat never sees one
    async readdir(p, o) {
      const l = await V.list(p);
      return o && typeof o === "object" && o.withFileTypes ? l.map(([n, k]) => new Dirent(n, k, String(p))) : l.map(([n]) => n);
    },
    async mkdir(p, o) {
      const rec = !!(o && typeof o === "object" && o.recursive);
      if (rec && await V.exists(p)) return undefined;
      await V.mkdir(p, rec);
      return rec ? V.VROOT + "/" + V.vrel(p) : undefined;
    },
    async rename(a, b) { await V.rename(a, b); },
    async copyFile(a, b, mode) { if ((mode | 0) & constants.COPYFILE_EXCL && await V.exists(b)) throw eexist(b); await V.copy(a, b); },
    async unlink(p) { await V.unlink(p); },
    async rmdir(p) { await V.rmdir(p); },
    async rm(p, o) {
      o = o || {};
      let s;
      try { s = await V.stat(p); } catch (e) { if (e.code === "ENOENT" && o.force) return; throw e; }
      if (s.type === "folder") {
        if (!o.recursive) { const e = new Error("ERR_FS_EISDIR: Path is a directory: rm returned EISDIR, '" + p + "'"); e.code = "ERR_FS_EISDIR"; throw e; }
        await rmTree(p); await V.rmdir(p);
      } else await V.unlink(p);
    },
    async access(p) { if (!(await V.exists(p))) throw enoent(p); },
  };

  // every host-touching name a plugin might reach for: a stable ENOSYS throw
  const UNLISTED = ["open", "openSync", "close", "closeSync", "read", "readSync", "write", "writeSync", "fstat", "fstatSync", "fsync", "fdatasync",
    "ftruncate", "futimes", "fchmod", "fchown", "createReadStream", "createWriteStream", "watch", "watchFile", "unwatchFile",
    "chmod", "chmodSync", "lchmod", "chown", "chownSync", "lchown", "realpath", "realpathSync", "symlink", "symlinkSync", "link", "linkSync",
    "readlink", "readlinkSync", "truncate", "utimes", "lutimes", "opendir", "mkdtemp", "cp", "statfs", "readv", "writev",
    "readFileSync", "writeFileSync", "appendFileSync", "existsSync", "statSync", "lstatSync", "readdirSync", "mkdirSync", "renameSync",
    "copyFileSync", "unlinkSync", "rmSync", "rmdirSync", "accessSync", "cpSync", "truncateSync", "utimesSync", "mkdtempSync", "opendirSync"];
  const unlisted = n => { const e = new Error("fs." + n + " is not available in opensidian (vault-confined fs: no descriptors, streams, watchers, permissions or host paths)"); e.code = "ENOSYS"; return e; };
  const deny = n => function () { throw unlisted(n); };
  const denyP = n => function () { return Promise.reject(unlisted(n)); };

  const promises = {};
  for (const k of Object.keys(P)) promises[k] = P[k];
  for (const n of ["open", "opendir", "watch", "chmod", "lchmod", "chown", "lchown", "realpath", "symlink", "link", "readlink", "truncate", "utimes", "lutimes", "mkdtemp", "cp", "statfs"]) promises[n] = denyP(n);
  promises.constants = constants;
  Object.freeze(promises);

  // callback form: fs.op(...args, cb); a missing cb is a TypeError, as in Node
  const cbify = k => function (...a) {
    const cb = a.pop();
    if (typeof cb !== "function") throw new TypeError('The "cb" argument must be of type function');
    P[k](...a).then(v => cb(null, v), e => cb(e));
  };
  const fs = {};
  for (const n of UNLISTED) fs[n] = deny(n);
  for (const k of Object.keys(P)) fs[k] = cbify(k);
  fs.exists = function (p, cb) { V.exists(p).then(v => cb(!!v), () => cb(false)); };   // Node's legacy boolean callback
  Object.assign(fs, { promises, constants, Stats, Dirent, F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 });
  Object.freeze(fs);

  return new Map([["fs", fs], ["node:fs", fs], ["fs/promises", promises], ["node:fs/promises", promises]]);
  }   // buildFs

  /* ---- guarded mode (td-census-fix integration, coordinator ruling on
     recon-bundles.md (b)) ----
     A plugin in guarded mode (manifest isDesktopOnly:false, no granted desktop
     capability; api.js decides, the loader asks) may BIND a denied builtin at
     module scope — real bundles do `var cp=require("child_process")` and only
     use it on their desktop branch — but can never USE it. stub() answers a
     Node/Electron builtin name with a deep, frozen, inert stand-in:
       - calling or constructing it, or anything reached from it, throws the
         loader's deny error for THAT require (the same message a non-guarded
         require throws up front);
       - a property read answers another such stub (cached, so a.b === a.b),
         never a host object; Symbol keys and "then" read undefined (so an
         `await` of it is not a thenable);
       - Object.getPrototypeOf(stub) === null, its .prototype is an empty frozen
         null-prototype object, .constructor is a stub: no route to Function;
       - the target is frozen: no write, define, delete or setPrototypeOf.
     Names that are not Node/Electron builtins get null: the loader keeps
     throwing "unknown module" for those, in every mode. */
  const BUILTINS = new Set(["assert", "assert/strict", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto",
    "dgram", "diagnostics_channel", "dns", "dns/promises", "domain", "electron", "events", "http", "http2", "https", "inspector", "module",
    "net", "original-fs", "os", "path/win32", "perf_hooks", "process", "punycode", "querystring", "readline", "readline/promises", "repl",
    "stream", "stream/promises", "stream/web", "string_decoder", "sys", "timers", "timers/promises", "tls", "trace_events", "tty", "url",
    "util", "util/types", "v8", "vm", "wasi", "worker_threads", "zlib"]);
  const PASS = new Set(["prototype", "name", "length"]);   // the frozen target's own props: invariants require their real values
  function makeStub(err) {
    const kids = new Map();
    const t = function () {};
    t.prototype = Object.freeze(Object.create(null));   // NOT the default one: its .constructor would hand out the raw target
    Object.setPrototypeOf(t, null);
    Object.freeze(t);
    return new Proxy(t, {
      apply() { throw err(); },
      construct() { throw err(); },
      get(o, k) {
        if (typeof k === "symbol" || k === "then") return undefined;
        if (PASS.has(k)) return Reflect.get(o, k);
        let s = kids.get(k);
        if (!s) { s = makeStub(err); kids.set(k, s); }
        return s;
      },
    });
  }
  function stub(name, msg) {
    name = String(name);
    const bare = name.startsWith("node:") ? name.slice(5) : name;
    if (!BUILTINS.has(bare) && !FS_NAMES.has(name)) return null;
    return makeStub(() => new Error(String(msg)));
  }

  const FS_NAMES = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
  host.nodeModules = Object.freeze({
    stub,
    resolve(name) {
      name = String(name);
      if (FS_NAMES.has(name)) {
        if (!fsMods && host.vfs) fsMods = buildFs(host.vfs);
        return fsMods ? fsMods.get(name) : undefined;
      }
      return undefined;
    },
  });
})();
