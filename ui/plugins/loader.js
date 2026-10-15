// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* plugin-loader (recon M1), ledger item 3: the community plugin LOADER and the
   require() shim. Loaded by index.html BEFORE main.js and before any plugin.

   How a plugin's code gets in (the page CSP has no 'unsafe-eval', no blob:):
     1. load(id) appends <script src="opensidian-plugin://localhost/<id>/main.js?n=K">;
        Rust (src-tauri/src/plugins.rs) serves it only when the vault is trusted,
        the id is enabled and the file is confined — wrapped as
          ;(function(){ __osPluginDefine("<id>", function(module,exports,require){ ...main.js... }) })();
     2. __osPluginDefine hands the factory to the load that is PENDING for that
        id; a define nobody asked for (a plugin defining a second id, a stray
        script) is ignored.
     3. the factory runs with a fresh module/exports and makeRequire(id). Any
        throw — a require() we refuse, a top-level bug — fails THAT plugin:
        status "failed" + the error, the app keeps running.

   require(name):
     "obsidian"                 -> the API object (ui/plugins/api.js, via host.api)
     "@codemirror/*", "@lezer/*" -> window.__osModules[name] (ui/vendor/codemirror/cm6.js:
                                   the SAME instances ui/editor.js builds its
                                   EditorView from); a name cm6.js does not ship
                                   -> Error "editor extensions not supported yet"
     "path"                     -> a small pure POSIX shim (no I/O)
     "fs", "fs/promises" (+ node:) -> ui/plugins/node-modules.js (host.nodeModules):
                                   the vault-confined fs facade over Rust plugin_vfs
     "child_process", "electron", anything else -> throws. No shims: a plugin
                                   that needs Node/Electron does not run here (recon §E).

   Privileges: the Tauri invoke handle is captured HERE, at boot, into this
   closure. Only host.grant() (one call, made by api.js before any plugin can
   load) receives it. Before the first plugin script is requested, seal() deletes
   window.__TAURI__ and narrows window.__osPluginHost to {censusTok}; see
   /workspace/goal/plugin-loader/security.md. */
(function () {
  "use strict";
  const T = window.__TAURI__;
  const invoke = T && T.core && T.core.invoke ? T.core.invoke.bind(T.core) : null;
  const listen = T && T.event && T.event.listen ? T.event.listen.bind(T.event) : null;   // item 5: vault-changed for the plugin vault model
  const SCHEME = "opensidian-plugin://localhost/";
  const DENIED = new Set(["fs", "fs/promises", "child_process", "electron", "original-fs", "os", "net", "http", "https", "crypto", "module", "worker_threads", "process", "vm"]);

  const status = new Map();   // id -> {state: "loading"|"loaded"|"failed"|"unloaded", error?}
  const pending = new Map();  // id -> {resolve(factory)}
  let seq = 0, granted = false;

  // ---- path: pure POSIX string functions, the subset plugins use ----
  const norm = p => {
    const abs = p.startsWith("/"), out = [];
    for (const s of p.split("/")) {
      if (!s || s === ".") continue;
      if (s === "..") { if (out.length && out[out.length - 1] !== "..") out.pop(); else if (!abs) out.push(".."); }
      else out.push(s);
    }
    const r = (abs ? "/" : "") + out.join("/");
    return r || (abs ? "/" : ".");
  };
  const path = {
    sep: "/", delimiter: ":",
    normalize: p => norm(String(p)),
    join: (...a) => norm(a.filter(x => x !== "").join("/") || "."),
    resolve: (...a) => { let r = ""; for (const x of a) r = String(x).startsWith("/") ? String(x) : r + "/" + x; return norm(r || "/"); },
    isAbsolute: p => String(p).startsWith("/"),
    dirname: p => { const s = String(p).replace(/\/+$/, ""), i = s.lastIndexOf("/"); return i < 0 ? "." : i === 0 ? "/" : s.slice(0, i); },
    basename: (p, ext) => { let b = String(p).replace(/\/+$/, ""); b = b.slice(b.lastIndexOf("/") + 1); return ext && b.endsWith(ext) && b !== ext ? b.slice(0, -ext.length) : b; },
    extname: p => { const b = path.basename(p), i = b.lastIndexOf("."); return i <= 0 ? "" : b.slice(i); },
    relative: (from, to) => {
      const f = norm("/" + from).split("/").filter(Boolean), t = norm("/" + to).split("/").filter(Boolean);
      let i = 0; while (i < f.length && i < t.length && f[i] === t[i]) i++;
      return [...f.slice(i).map(() => ".."), ...t.slice(i)].join("/");
    },
  };
  path.posix = path;            // BEFORE the freeze: strict mode throws on a frozen object (iter-2 bug: the whole loader died at boot)
  Object.freeze(path);

  function makeRequire(id) {
    return function require(name) {
      name = String(name);
      if (name === "obsidian") {
        if (!host.api) throw new Error(id + ': require("obsidian"): the plugin API is not available');
        return host.api;
      }
      if (name.startsWith("@codemirror/") || name.startsWith("@lezer/")) {
        const m = window.__osModules && Object.prototype.hasOwnProperty.call(window.__osModules, name) ? window.__osModules[name] : undefined;
        if (m) return m;
        throw new Error(id + ': require("' + name + '"): editor extensions not supported yet');
      }
      if (name === "path" || name === "node:path" || name === "path/posix") return path;
      const nm = host.nodeModules && host.nodeModules.resolve(name);   // ui/plugins/node-modules.js: fs, fs/promises (vault-confined)
      if (nm) return nm;
      const bare = name.replace(/^node:/, "");
      if (DENIED.has(bare)) throw new Error(id + ': require("' + name + '") is not available in opensidian (no Node/Electron APIs)');
      throw new Error(id + ': require("' + name + '"): unknown module');
    };
  }

  // the Rust wrapper calls this; only a define for a PENDING load is honoured
  Object.defineProperty(window, "__osPluginDefine", {
    configurable: false, writable: false, enumerable: false,
    value: function (id, factory) {
      const p = pending.get(id);
      if (!p || typeof factory !== "function") return;
      pending.delete(id);
      p.resolve(factory);
    },
  });

  /* item 7, the seal: runs ONCE, right before the first plugin script is
     requested (evaluate). Everything the app needs was captured at load time
     (main.js TAURI/inv, otel.js, this closure, api.js's grant, settings.js's
     host), so from here on:
       - window.__TAURI__ is deleted (withGlobalTauri assigns it plainly; if a
         future Tauri makes it non-configurable we overwrite it, and the census
         says so),
       - window.__osPluginHost becomes a frozen facade with censusTok only: no
         grant, no setRestricted/setEnabled/enable/evaluate/status for plugin code.
     This is defence in depth, not a sandbox: plugins share the page's realm
     (main.js top-level bindings, __TAURI_INTERNALS__). See security.md. */
  let sealed = false;
  function seal() {
    if (sealed) return;
    sealed = true;
    try { delete window.__TAURI__; } catch (_) {}
    if ("__TAURI__" in window) { try { Object.defineProperty(window, "__TAURI__", { value: undefined, writable: false, configurable: false }); } catch (_) {} }
    const facade = Object.freeze({ censusTok: () => (host.censusTok ? host.censusTok() : "") + sealTok() });
    try { Object.defineProperty(window, "__osPluginHost", { value: facade, configurable: false, writable: false, enumerable: false }); } catch (e) { console.error("[plugin] seal host:", e); }
  }
  // [pseal:<__TAURI__ still visible 0|1>,<public host keys>] — after the seal only
  const sealTok = () => " [pseal:" + (window.__TAURI__ ? 1 : 0) + "," + Object.keys(window.__osPluginHost || {}).length + "]";

  function fail(id, err) {
    const msg = (err && err.message) || String(err);
    status.set(id, { state: "failed", error: msg });
    console.error("[plugin] " + id + " failed: " + msg);
    return { ok: false, id, error: msg };
  }

  /* fetch + evaluate one plugin's main.js. Resolves {ok, id, exports, error};
     never rejects — a broken plugin must not take the caller down. */
  function evaluate(id) {
    if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(id)) return Promise.resolve(fail(id, new Error("bad plugin id")));
    if (pending.has(id)) return Promise.resolve(fail(id, new Error("already loading")));
    seal();   // item 7: no plugin script is ever requested while __TAURI__ / the full host are public
    status.set(id, { state: "loading" });
    return new Promise(resolve => {
      const s = document.createElement("script");
      let done = false;
      const fin = r => { if (done) return; done = true; pending.delete(id); s.remove(); resolve(r); };
      pending.set(id, {
        resolve: factory => {
          const module = { exports: {} };
          try {
            factory.call(module.exports, module, module.exports, makeRequire(id));
          } catch (e) { fin(fail(id, e)); return; }
          fin({ ok: true, id, exports: module.exports });
        },
      });
      // a script that 403s/404s fires onerror; one that loads but never defines
      // (syntax error, refused wrapper) fires onload with nothing pending resolved
      // fail() WRITES status, so it must only run when nothing settled first: an
      // eager fin(fail(..)) after a factory that threw overwrote the real error
      // (e.g. require("@codemirror/..")) with "did not define" (plgprobe caught it)
      s.onerror = () => { if (!done) fin(fail(id, new Error("main.js refused or missing (restricted mode, not enabled, or not installed)"))); };
      s.onload = () => setTimeout(() => { if (!done) fin(fail(id, new Error("main.js did not define a plugin (syntax error?)"))); }, 0);
      s.src = SCHEME + encodeURIComponent(id) + "/main.js?n=" + (++seq);
      document.head.appendChild(s);
    });
  }

  const host = {
    api: null,
    status,
    path,
    makeRequire,
    evaluate,
    fail,
    /* ONE call, by ui/plugins/api.js at boot (before any plugin can run): hands
       it the narrow backend calls the API needs. A second call (a plugin
       trying to get the handle) gets nothing. */
    grant(fn) {
      if (granted) return false;
      granted = true;
      fn({
        state: () => invoke("plugins_state"),
        set: a => invoke("plugins_set", a),
        io: (id, op, data) => invoke("plugin_io", data === undefined ? { id, op } : { id, op, data }),
        invoke,   // api.js's own vault calls (read/modify/...) — never handed to a plugin
        listen,   // api.js subscribes to vault-changed (Vault create/modify/delete/rename events)
      });
      return true;
    },
    snapshot: () => [...status].map(([id, s]) => id + "=" + s.state).join(","),
  };
  // configurable until seal() swaps in the public facade (item 7)
  Object.defineProperty(window, "__osPluginHost", { value: host, configurable: true, writable: false, enumerable: false });
})();
