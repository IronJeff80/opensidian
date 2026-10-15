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
    async readFile(p, o) { const u = await V.read(p), enc = encOf(o); return enc ? (/^utf-?8$/i.test(enc) ? V.utf8(u) : Promise.reject(new Error("readFile: encoding " + enc + " is not supported"))) : u; },
    async writeFile(p, d) { await V.write(p, d); },
    async appendFile(p, d) { await V.append(p, d); },
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

  const FS_NAMES = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
  host.nodeModules = Object.freeze({
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
