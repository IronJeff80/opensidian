// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* the "obsidian" module, part META (api-parity stage 0: split out of api.js,
   behaviour-neutral): TAbstractFile / TFile / TFolder, the vault model fed by
   the Rust watcher, the confined VFS core (host.vfs) + DataAdapter /
   FileSystemAdapter, Vault, the metadata cache, the `app` object + App, and
   the guarded view's FileSystemAdapter. Segment contract: see api-core.js. */
(function () {
  "use strict";
  const parts = window.__osApiParts || (window.__osApiParts = Object.create(null));
  const reg = (id, fn) => { if (!(id in parts)) parts[id] = fn; };
  reg("vault:model", function (K) {
    const { host, be } = K;
    const { Events, P, getLinkpath, loadMoment, normalizePath, parseYaml, touch } = K;
    class TAbstractFile { constructor() { this.vault = null; this.path = ""; this.name = ""; this.parent = null; } }
    class TFile extends TAbstractFile { constructor() { super(); this.basename = ""; this.extension = ""; this.stat = { ctime: 0, mtime: 0, size: 0 }; } }
    class TFolder extends TAbstractFile { constructor() { super(); this.children = []; } isRoot() { return this.path === "/" || this.path === ""; } }
    /* ------------------------------------- vault model (item 5)
       TFile/TFolder objects keyed by Obsidian path ("dir/Note.md", "dir",
       "img.png"); identity survives rename. The app names notes WITHOUT ".md"
       (index.rs notes_of), so every backend call strips it. Built only when a
       plugin is about to load (trusted + enabled): restricted mode never lists,
       reads or parses anything for plugins. Mutations made through the API go to
       the app's own commands (create_note / write_note / delete_note -> .trash /
       move_note / create_dir) and are then fed to main.js onVaultChanged, the
       same path an external edit takes, so open tabs and the tree stay right. */
    const files = new Map();                      // path -> TFile | TFolder (root not included)
    const vroot = new TFolder(); vroot.path = "/"; vroot.name = "";
    let modelP = null, unlisten = null;   // vaultName, modelOn: K.st (api.js)
    const noteOf = p => (p.endsWith(".md") ? p.slice(0, -3) : null);
    const inv = (c, a) => be.invoke(c, a);
    function attach(f, path) {
      const i = path.lastIndexOf("/"), dir = i < 0 ? "" : path.slice(0, i);
      f.vault = vault; f.path = path; f.name = path.slice(i + 1);
      if (f instanceof TFile) { const d = f.name.lastIndexOf("."); f.basename = d > 0 ? f.name.slice(0, d) : f.name; f.extension = d > 0 ? f.name.slice(d + 1).toLowerCase() : ""; }
      const par = dir ? ensureFolder(dir) : vroot;
      f.parent = par; if (!par.children.includes(f)) par.children.push(f);
      files.set(path, f);
    }
    function detachF(f) {
      if (f.parent) { const i = f.parent.children.indexOf(f); if (i >= 0) f.parent.children.splice(i, 1); }
      if (files.get(f.path) === f) files.delete(f.path);
    }
    function ensureFolder(path) {
      const g = files.get(path); if (g instanceof TFolder) return g;
      const f = new TFolder(); attach(f, path); return f;
    }
    function ensureFile(path) {   // -> [file, created]
      const g = files.get(path); if (g instanceof TFile) return [g, false];
      const f = new TFile(); const now = Date.now(); f.stat = { ctime: now, mtime: now, size: 0 }; attach(f, path); return [f, true];
    }
    function removeTree(f) {
      if (f instanceof TFolder) for (const c of f.children.slice()) removeTree(c);
      detachF(f); caches.delete(f.path);
    }
    function movePath(f, np) {
      const op = f.path; detachF(f); caches.delete(op); attach(f, np);
      if (f instanceof TFolder) for (const c of f.children.slice()) movePath(c, np + c.path.slice(op.length));
    }
    async function buildModel() {
      const [notes, folders, imgs] = await Promise.all([inv("list_notes"), inv("list_folders"), inv("list_images").catch(() => [])]);
      const keep = new Set();
      for (const d of folders || []) { ensureFolder(d); keep.add(d); }
      for (const n of notes || []) { ensureFile(n + ".md"); keep.add(n + ".md"); }
      for (const p of imgs || []) { ensureFile(p); keep.add(p); }
      for (const [p, f] of [...files]) if (!keep.has(p) && files.get(p) === f) removeTree(f);
    }
    async function syncFolders() {
      let ds; try { ds = await inv("list_folders"); } catch (_) { return; }
      const want = new Set(ds || []);
      for (const d of want) if (!files.has(d)) { const f = ensureFolder(d); vault.trigger("create", f); }
      for (const [p, f] of [...files]) if (f instanceof TFolder && !want.has(p) && !f.children.length && files.get(p) === f) { removeTree(f); vault.trigger("delete", f); }
    }
    /* one watcher batch (notes only, names without .md) -> Vault events, in
       Obsidian's order: rename, create, modify, delete; then the cache. */
    function applyChange(c) {
      if (!K.st.modelOn || !c) return;
      for (const [o, n] of c.renamed || []) {
        const f = files.get(o + ".md");
        if (f) { movePath(f, n + ".md"); vault.trigger("rename", f, o + ".md"); indexFile(f); }
        else { const [g, made] = ensureFile(n + ".md"); if (made) vault.trigger("create", g); indexFile(g); }
      }
      for (const n of c.added || []) { const [f, made] = ensureFile(n + ".md"); if (made) vault.trigger("create", f); indexFile(f); }
      for (const n of c.modified || []) { const f = files.get(n + ".md"); if (f instanceof TFile) { f.stat.mtime = Date.now(); vault.trigger("modify", f); indexFile(f); } }
      for (const n of c.removed || []) { const f = files.get(n + ".md"); if (f) { removeTree(f); metadataCache.trigger("deleted", f, null); vault.trigger("delete", f); } }
      syncFolders();
    }
    // an API mutation: tell main.js first (tabs, tree, bookmarks), then the plugins
    async function changed(c) {
      const full = Object.assign({ added: [], removed: [], modified: [], renamed: [] }, c);
      if (typeof onVaultChanged === "function") { try { await onVaultChanged(full); } catch (e) { console.error("[plugin] onVaultChanged:", e); } }
      applyChange(full);
    }
    function mdOnly(f, what) {
      const n = f instanceof TFile ? noteOf(f.path) : null;
      if (n == null) throw new Error(what + ": only markdown notes are supported in opensidian M1 (" + (f && f.path) + ")");
      return n;
    }
    /* the runtime a plugin needs before its main.js is evaluated: moment (vendored,
       pinned — ui/vendor/moment.min.js), the vault model, the vault-changed
       subscription and the metadata sweep. Idempotent; first enable() pays it. */
    function ensureModel() {
      if (modelP) return modelP;
      modelP = (async () => {
        await loadMoment();
        // Obsidian exposes the App as the global `app`, and bundled helper libs read
        // it bare (periodic-notes' obsidian-daily-notes-interface: "Can't find
        // variable: app"). Same object a plugin gets as this.app; set only here,
        // i.e. never in restricted mode.
        if (!("app" in window)) Object.defineProperty(window, "app", { value: K.app, configurable: true, enumerable: false, writable: false });
        await buildModel();
        K.st.modelOn = true;
        if (!unlisten && be.listen) unlisten = await be.listen("vault-changed", e => applyChange(e.payload));
        sweep();
      })().catch(e => { modelP = null; throw e; });
      return modelP;
    }

    /* td-vault-io: DataAdapter / FileSystemAdapter over the confined Rust
       backend (src-tauri/src/vaultfs.rs plugin_op, command plugin_vfs). The
       plugin sees ONE virtual root, VROOT = "/vault": basePath is that string,
       never the host path, and "/vault/x" and "x" name the same file. This file
       only maps the virtual root away; every other path is passed to Rust
       VERBATIM (no normalizePath: it would turn "\\host\share" or "/etc" into a
       legal-looking vault path), and Rust is the guard — plugins share the page
       realm, so the JS layer cannot be. ui/plugins/node-modules.js builds the
       `fs` / `fs/promises` facade on the same core (host.vfs, handed over before
       the seal). */
    const VROOT = "/vault";
    function vrel(p) {
      let s = String(p == null ? "" : p);
      if (s === VROOT || s === VROOT + "/") return "";
      if (s.startsWith(VROOT + "/")) s = s.slice(VROOT.length + 1);
      while (s.startsWith("./")) s = s.slice(2);
      return s === "." ? "" : s;
    }
    function vfsError(msg, path) {
      const s = String(msg && msg.message || msg), m = s.match(/^([A-Z]+): /);
      const e = new Error(s);
      e.code = m ? m[1] : "EIO"; e.path = String(path);
      if (/^EPERM: vault-escape refused/.test(s)) e.vaultEscape = true;
      return e;
    }
    const te = new TextEncoder(), td = new TextDecoder("utf-8");
    function toBytes(d) {
      if (d instanceof Uint8Array) return d;
      if (d instanceof ArrayBuffer) return new Uint8Array(d);
      if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
      return te.encode(String(d == null ? "" : d));
    }
    function b64e(u8) {
      let s = "";
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      return btoa(s);
    }
    function b64d(s) { const b = atob(String(s)), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
    async function vio(op, path, a) {
      if (!be) throw vfsError("EPERM: plugin file access is not available", path);
      const args = Object.assign({ op, path: vrel(path) }, a || {});
      if (args.to != null) args.to = vrel(args.to);
      try { return await be.invoke("plugin_vfs", args); } catch (e) { throw vfsError(e, path); }
    }
    const core = Object.freeze({
      VROOT, vrel, vfsError,
      stat: p => vio("stat", p),
      exists: p => vio("exists", p),
      list: p => vio("list", p),
      read: async p => b64d(await vio("read", p)),
      write: (p, d) => vio("write", p, { data: b64e(toBytes(d)) }),
      append: (p, d) => vio("append", p, { data: b64e(toBytes(d)) }),
      mkdir: (p, recursive) => vio("mkdir", p, { recursive: !!recursive }),
      unlink: p => vio("unlink", p),
      rmdir: p => vio("rmdir", p),
      rename: (a, b) => vio("rename", a, { to: String(b) }),
      copy: (a, b) => vio("copy", a, { to: String(b) }),
      utf8: u8 => td.decode(u8), toBytes,
    });
    host.vfs = core;                 // for node-modules.js only; the seal hides host from plugins

    const joinRel = (dir, n) => (dir ? dir + "/" : "") + n;
    class DataAdapter {
      getName() { return K.st.vaultName; }
      async exists(p) { return core.exists(p); }
      async stat(p) {
        try { return await core.stat(p); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
      }
      async list(p) {
        const d = vrel(p).replace(/\/+$/, ""), out = { files: [], folders: [] };
        for (const [n, k] of await core.list(p)) (k === "folder" ? out.folders : out.files).push(joinRel(d, n));
        return out;
      }
      async read(p) { return td.decode(await core.read(p)); }
      async readBinary(p) { const u = await core.read(p); return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength); }
      async write(p, data) { await core.write(p, String(data)); }
      async writeBinary(p, data) { await core.write(p, toBytes(data)); }
      async append(p, data) { await core.append(p, String(data)); }
      async appendBinary(p, data) { await core.append(p, toBytes(data)); }
      async process(p, fn) { const out = fn(await this.read(p)); await this.write(p, out); return out; }
      getResourcePath() { return ""; }
      async mkdir(p) { await core.mkdir(p, true); }
      async trashSystem() { return false; }       // no system trash: callers fall back to trashLocal
      async trashLocal(p) {
        await core.mkdir(".trash", true);
        const base = vrel(p).split("/").pop();
        let to = ".trash/" + base;
        for (let i = 1; await core.exists(to); i++) to = ".trash/" + base + "." + i;
        await core.rename(p, to);
      }
      async rmdir(p, recursive) {
        if (recursive) {
          for (const [n, k] of await core.list(p)) {
            const c = joinRel(vrel(p).replace(/\/+$/, ""), n);
            if (k === "folder") await this.rmdir(c, true); else await core.unlink(c);
          }
        }
        await core.rmdir(p);
      }
      async remove(p) { await core.unlink(p); }
      async rename(a, b) { await core.rename(a, b); }
      async copy(a, b) { await core.copy(a, b); }
    }
    class FileSystemAdapter extends DataAdapter {
      get basePath() { return VROOT; }
      getBasePath() { return VROOT; }
      getFullPath(p) { const r = vrel(p); return r ? VROOT + "/" + r : VROOT; }
      getFilePath(p) { return "file://" + this.getFullPath(p); }
      static async readLocalFile(p) { const u = await core.read(p); return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength); }
      static async mkdir(p) { await core.mkdir(p, true); }
    }
    const adapter = new FileSystemAdapter();

    /* Vault: the typings' class; app.vault is its one instance. recurseChildren
       is the static walk calendar's daily-notes index uses (depth-first, root first). */
    class Vault extends Events {
      static recurseChildren(root, cb) {
        const st = root ? [root] : [];
        while (st.length) { const f = st.pop(); cb(f); if (f instanceof TFolder) for (let i = f.children.length - 1; i >= 0; i--) st.push(f.children[i]); }
      }
    }
    const vault = new Vault();
    Object.assign(vault, {
      configDir: ".obsidian",
      getName() { return K.st.vaultName; },
      getRoot() { return vroot; },
      getAbstractFileByPath(p) { const n = normalizePath(p); return n === "/" ? vroot : files.get(n) || null; },
      getFileByPath(p) { const f = vault.getAbstractFileByPath(p); return f instanceof TFile ? f : null; },
      getFolderByPath(p) { const f = vault.getAbstractFileByPath(p); return f instanceof TFolder ? f : null; },
      getFiles() { return [...files.values()].filter(f => f instanceof TFile); },
      getMarkdownFiles() { return [...files.values()].filter(f => f instanceof TFile && f.extension === "md"); },
      getAllLoadedFiles() { return [vroot, ...files.values()]; },
      getAllFolders(includeRoot) { const a = [...files.values()].filter(f => f instanceof TFolder); return includeRoot ? [vroot, ...a] : a; },
      async read(f) { return inv("read_note", { name: mdOnly(f, "read") }); },
      async cachedRead(f) { return vault.read(f); },
      async modify(f, data) {
        const name = mdOnly(f, "modify");
        await inv("write_note", { name, content: String(data) });
        await changed({ modified: [name] });
      },
      async append(f, data) { const s = await vault.read(f); return vault.modify(f, s + String(data)); },
      async process(f, fn) { const s = await vault.read(f); const out = fn(s); await vault.modify(f, out); return out; },
      async create(path, data) {
        const p = normalizePath(path), name = noteOf(p);
        if (name == null) throw new Error("create: only markdown notes can be created in opensidian M1 (" + p + ")");
        if (files.has(p)) throw new Error("File already exists.");
        await inv("create_note", { name, content: String(data == null ? "" : data) });
        await changed({ added: [name] });
        return files.get(p) || ensureFile(p)[0];
      },
      async createFolder(path) {
        const p = normalizePath(path);
        if (files.has(p)) throw new Error("Folder already exists.");
        await inv("create_dir", { name: p });
        const f = ensureFolder(p); vault.trigger("create", f);
        if (typeof refreshTree === "function") try { await refreshTree(); } catch (_) {}
        return f;
      },
      async delete(f) { const name = mdOnly(f, "delete"); await inv("delete_note", { name }); await changed({ removed: [name] }); },
      async trash(f) { return vault.delete(f); },    // delete_note already moves to <vault>/.trash
      async rename(f, newPath) {
        const old = mdOnly(f, "rename"), np = normalizePath(newPath), nn = noteOf(np);
        if (nn == null) throw new Error("rename: target must be a .md path (" + np + ")");
        await inv("move_note", { old, new: nn });
        await changed({ renamed: [[old, nn]] });
      },
      async copy(f, newPath) { const s = await vault.read(f); return vault.create(newPath, s); },
      getResourcePath() { return ""; },
      getConfig(k) { return ({ useMarkdownLinks: false, newLinkFormat: "shortest", attachmentFolderPath: "/", newFileLocation: "root", newFileFolderPath: "", alwaysUpdateLinks: false, showUnsupportedFiles: false })[k] ?? null; },
      adapter,
    });

    /* ------------------------------------- metadata cache (item 5)
       getFileCache is SYNCHRONOUS in Obsidian, so the cache is filled ahead:
       a sweep over every note when the model is built (yielding between
       batches, then 'resolved'), and one re-parse per watcher/API change
       ('changed'). A miss returns null and queues that file. Parsed in JS from
       the note text: frontmatter (YAML subset), headings, [[links]], ![[embeds]],
       [md](links), #tags — all with Obsidian-shaped positions. */
    const caches = new Map();           // path -> CachedMetadata
    let sweepDone = false;
    function parseMeta(src) {
      const lines = String(src).split("\n"), out = {};
      const pos = (line, col, offset) => ({ line, col, offset });
      let off = 0, i = 0;
      const lineEnd = n => n.replace(/\r$/, "");
      if (lines.length > 1 && lineEnd(lines[0]) === "---") {
        let j = 1, o = lines[0].length + 1;
        for (; j < lines.length; j++) { if (/^(---|\.\.\.)\s*$/.test(lineEnd(lines[j]))) break; o += lines[j].length + 1; }
        if (j < lines.length) {
          out.frontmatter = parseYaml(lines.slice(1, j).join("\n"));
          out.frontmatterPosition = { start: pos(0, 0, 0), end: pos(j, 3, o + 3) };
          out.sections = [{ type: "yaml", position: out.frontmatterPosition }];
          off = o + lines[j].length + 1; i = j + 1;
        }
      }
      let fence = null;
      const push = (k, v) => { (out[k] || (out[k] = [])).push(v); };
      for (; i < lines.length; off += lines[i].length + 1, i++) {
        const raw = lineEnd(lines[i]);
        const fm = raw.match(/^\s*(`{3,}|~{3,})/);
        if (fm) { if (!fence) fence = fm[1][0]; else if (fm[1][0] === fence) fence = null; continue; }
        if (fence) continue;
        const P = (a, b) => ({ start: pos(i, a, off + a), end: pos(i, b, off + b) });
        const h = raw.match(/^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/);
        if (h) push("headings", { heading: h[2], level: h[1].length, position: P(0, raw.length) });
        const s = raw.replace(/`[^`]*`/g, m => " ".repeat(m.length));
        let m; const wl = /(!?)\[\[([^\]\n]+?)\]\]/g;
        while ((m = wl.exec(s))) {
          const inner = m[2], bar = inner.indexOf("|"), link = (bar < 0 ? inner : inner.slice(0, bar)).trim();
          push(m[1] ? "embeds" : "links", { link, original: m[0], displayText: bar < 0 ? link : inner.slice(bar + 1), position: P(m.index, m.index + m[0].length) });
        }
        const ml = /(!?)\[([^\]\n]*)\]\(([^)\s]+)\)/g;
        while ((m = ml.exec(s))) {
          if (/^[a-z][a-z0-9+.-]*:/i.test(m[3])) continue;   // external URL: not a vault link
          let link; try { link = decodeURI(m[3]); } catch (_) { link = m[3]; }
          push(m[1] ? "embeds" : "links", { link, original: m[0], displayText: m[2], position: P(m.index, m.index + m[0].length) });
        }
        if (!h) {
          const tg = /(^|\s)#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;
          while ((m = tg.exec(s))) { const a = m.index + m[1].length; push("tags", { tag: "#" + m[2], position: P(a, a + 1 + m[2].length) }); }
        }
      }
      return out;
    }
    /* link resolution: exact path, path+".md", then the shortest note whose path
       ends with it (case-insensitive) — the app resolves [[x]] by full path OR
       basename (index.rs resolve), and a shortest-path tie-break matches
       Obsidian's "shortest" link format for unique names. */
    function resolveLink(lp, src) {
      let p = getLinkpath(String(lp).split("|")[0]).trim();
      if (!p) return src ? vault.getFileByPath(src) : null;
      p = normalizePath(p);
      for (const c of [p, p + ".md"]) { const f = files.get(c); if (f instanceof TFile) return f; }
      const lc = p.toLowerCase(), lmd = lc + ".md"; let best = null;
      for (const f of files.values()) {
        if (!(f instanceof TFile)) continue;
        const fp = f.path.toLowerCase();
        if (fp === lc || fp === lmd || fp.endsWith("/" + lc) || fp.endsWith("/" + lmd)) if (!best || f.path.length < best.path.length) best = f;
      }
      return best;
    }
    const idxQ = new Set(); let idxT = 0;
    function indexFile(f) {
      if (!(f instanceof TFile) || f.extension !== "md") return;
      idxQ.add(f); if (!idxT) idxT = setTimeout(drainIdx, 0);
    }
    async function drainIdx() {
      const batch = [...idxQ]; idxQ.clear();
      for (const f of batch) {
        if (files.get(f.path) !== f) continue;
        let txt; try { txt = await inv("read_note", { name: noteOf(f.path) }); } catch (_) { continue; }
        const c = parseMeta(txt); caches.set(f.path, c); f.stat.size = txt.length;
        metadataCache.trigger("changed", f, txt, c);
      }
      idxT = 0;
      if (idxQ.size) idxT = setTimeout(drainIdx, 0);
      else if (sweepDone) metadataCache.trigger("resolved");
    }
    async function sweep() {
      const all = vault.getMarkdownFiles();
      for (let k = 0; k < all.length; k += 16) {
        await Promise.all(all.slice(k, k + 16).map(async f => {
          if (caches.has(f.path)) return;
          try { const t = await inv("read_note", { name: noteOf(f.path) }); caches.set(f.path, parseMeta(t)); f.stat.size = t.length; } catch (_) {}
        }));
        await new Promise(r => setTimeout(r, 0));
      }
      sweepDone = true; metadataCache.resolved = true;
      metadataCache.trigger("resolved");
      touch();
    }
    function linkMap(resolved) {
      const o = {};
      for (const [p, c] of caches) {
        const m = {};
        for (const l of (c.links || []).concat(c.embeds || [])) {
          const f = resolveLink(l.link, p), k = f ? f.path : getLinkpath(l.link);
          if (!!f === resolved) m[k] = (m[k] || 0) + 1;
        }
        o[p] = m;
      }
      return o;
    }
    const metadataCache = new Events();
    Object.assign(metadataCache, {
      resolved: false,
      getFileCache(f) { if (!f) return null; const c = caches.get(f.path); if (!c) indexFile(f); return c || null; },
      getCache(p) { const f = vault.getFileByPath(p); return f ? metadataCache.getFileCache(f) : null; },
      getFirstLinkpathDest(lp, src) { return resolveLink(lp, src); },
      getLinkpathDest(lp, src) { const f = resolveLink(lp, src); return f ? [f] : []; },
      fileToLinktext(f, src, omitMd = true) {
        const same = vault.getMarkdownFiles().filter(x => x.basename === f.basename).length;
        const p = same > 1 || f.extension !== "md" ? f.path : f.name;
        return omitMd && f.extension === "md" ? p.replace(/\.md$/, "") : p;
      },
      get resolvedLinks() { return linkMap(true); },
      get unresolvedLinks() { return linkMap(false); },
      getBacklinksForFile(f) { const d = new Map(); for (const [p, c] of caches) { const ls = (c.links || []).filter(l => resolveLink(l.link, p) === f); if (ls.length) d.set(p, ls); } return { data: d, keys: () => [...d.keys()], get: k => d.get(k) }; },
    });

    Object.assign(K, { DataAdapter, FileSystemAdapter, TAbstractFile, TFile, TFolder, Vault, adapter, changed, ensureModel, files, inv, metadataCache, noteOf, resolveLink, sweep, td, vault });
  });
  reg("vault:app", function (K) {
    const { host, be } = K;
    const { Scope, commands, keymap, metadataCache, plugins, setting, statusBox, vault, workspace } = K;
    const app = {
      appId: "",
      vault, workspace, metadataCache, keymap, commands, plugins, setting,
      scope: new Scope(),
      internalPlugins: { getPluginById() { return null; }, getEnabledPluginById() { return null; }, plugins: {} },
      statusBar: { get containerEl() { return statusBox(); } },
      dom: { get appContainerEl() { return document.body; } },
      lastEvent: null,
      isMobile: false,
      // no fold persistence: calendar's note creation saves the template's folds (none) here
      foldManager: { load() { return null; }, save() {} },
      loadLocalStorage(k) { try { const v = localStorage.getItem(app.appId + "-" + k); return v == null ? null : JSON.parse(v); } catch (_) { return null; } },
      saveLocalStorage(k, v) { try { if (v == null) localStorage.removeItem(app.appId + "-" + k); else localStorage.setItem(app.appId + "-" + k, JSON.stringify(v)); } catch (_) {} },
    };
    class App {}   // typings expose App as a class; plugins only ever receive `app`
    Object.setPrototypeOf(app, App.prototype);

    Object.assign(K, { App, app });
  });
  reg("vault:guarded", function (K) {
    const { host, be } = K;
    const { DataAdapter, FileSystemAdapter, Platform, PlatformGuarded, app } = K;
    /* the guarded "obsidian" (loader.js makeRequire(id, true)): the same API, but
       Platform is PlatformGuarded and FileSystemAdapter is a separate class nothing
       is an instance of, so `app.vault.adapter instanceof FileSystemAdapter` is
       false in this view (DataAdapter only: no basePath for a shell cwd). The
       moment getter is copied as a getter, not a snapshot. */
    class GuardedFileSystemAdapter extends DataAdapter {}
    Object.defineProperty(GuardedFileSystemAdapter, "name", { value: "FileSystemAdapter" });
    Object.assign(K, { GuardedFileSystemAdapter });
  });
})();
