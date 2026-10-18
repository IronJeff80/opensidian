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
     "path", "node:path",        -> window.__osNodeModules (ui/plugins/node-leaves.js): pure
     "path/posix" (+ node:)        leaves, one frozen POSIX path object, no I/O
     "fs", "fs/promises" (+ node:) -> ui/plugins/node-modules.js (host.nodeModules):
                                   the vault-confined fs facade over Rust plugin_vfs
     events, util, os, crypto,   -> ui/plugins/node-desktop.js (host.desktopNode): the
     buffer, process, url, ...     trusted-vault Node surface, one view per plugin
     any other Node/Electron     -> an inert stub that throws on use (node-modules.js)
     builtin (child_process, ...)
     anything else               -> throws "unknown module"

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
  const NODE = window.__osNodeModules;   // captured at boot (index.html loads node-leaves.js first)

  const status = new Map();   // id -> {state: "loading"|"loaded"|"failed"|"unloaded", error?}
  const pending = new Map();  // id -> {resolve(factory)}
  let seq = 0, granted = false;

  /* cp-unrestricted (operator ruling 2026-10-18, stock parity): guarded mode is
     retired. Plugin code only runs in a trusted vault (the flip), and there every
     plugin gets the desktop view stock gives it: the desktop "obsidian" (Platform
     desktop, adapter instanceof FileSystemAdapter) and the Node surface of
     ui/plugins/node-desktop.js. A builtin that has no member there yet binds the
     inert stub (throws on use), so a bundle that only binds it at module scope
     still loads. api-core still passes its old guarded flag; it is ignored. */
  function makeRequire(id) {
    const dv = host.desktopNode ? host.desktopNode.view(id) : null;
    const require = function require(name) {
      name = String(name);
      if (name === "obsidian") {
        const a = host.api;
        if (!a) throw new Error(id + ': require("obsidian"): the plugin API is not available');
        return a;
      }
      if (name.startsWith("@codemirror/") || name.startsWith("@lezer/")) {
        const m = window.__osModules && Object.prototype.hasOwnProperty.call(window.__osModules, name) ? window.__osModules[name] : undefined;
        if (m) return m;
        throw new Error(id + ': require("' + name + '"): editor extensions not supported yet');
      }
      const leaf = NODE && NODE.get(name);   // ui/plugins/node-leaves.js: pure leaves (path)
      if (leaf) return leaf;
      const nm = host.nodeModules && host.nodeModules.resolve(name);   // ui/plugins/node-modules.js: fs, fs/promises (vault-confined)
      if (nm) return dv ? dv.own(nm) : nm;
      const deny = id + ': require("' + name + '"): this member is not available in opensidian yet';
      const d = dv && dv.resolve(name, deny);   // ui/plugins/node-desktop.js: the trusted-vault Node surface
      if (d) return d;
      const s = host.nodeModules && host.nodeModules.stub(name, deny);
      if (s) return s;
      throw new Error(id + ': require("' + name + '"): unknown module');
    };
    if (dv) dv.bindRequire(require);
    return require;
  }
  // the CommonJS free variables plugins.rs wrap_cjs binds after module,exports,require
  function freeVars(id) {
    const dv = host.desktopNode ? host.desktopNode.view(id) : null;
    if (!dv) return [undefined, window, undefined, Error, "", "", undefined];
    return [dv.process, dv.global, dv.Buffer, dv.Error, dv.filename, dv.dirname, dv.SharedArrayBuffer];
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
    if (evalWanted && evalRefused(err)) cspReloadNow();   // trusted vault on a no-eval page (cspCheck)
    return { ok: false, id, error: msg };
  }

  /* fetch + evaluate one plugin's main.js. Resolves {ok, id, exports, error};
     never rejects — a broken plugin must not take the caller down. */
  function evaluate(id) {   // api-core passes a retired guarded flag (makeRequire)
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
            factory.call(module.exports, module, module.exports, makeRequire(id), ...freeVars(id));
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

  /* cp-unrestricted: the page CSP is fixed when the page loads — Rust page_csp
     gives a trusted vault's page 'unsafe-eval' + blob: workers, every other page
     the restricted CSP — and plugins_state says which one this page got
     (pageEval). When the trust flag and the page disagree:
       - flag OFF, page has eval (restricted mode was just turned on): reload
         now, so the negative control is the real header, not a leftover one;
       - flag ON, page has no eval (restricted mode was just turned off, or the
         vault was bound after the page loaded): plugins load without a reload
         (most never eval); the FIRST time anything on the page is refused eval
         or a blob: script/worker by the CSP (a securitypolicyviolation, or a
         plugin that fails with an EvalError), the page reloads into the
         trusted CSP and the plugin loads again there.
     Every reload waits the save debounce so a pending note write lands first.
     Two reloads in a row that still disagree stop with a console warning
     instead of looping. */
  let cspReload = false, evalWanted = false;
  function cspReloadNow() {
    const KEY = "osCspReload";
    let n = 0;
    try { n = +sessionStorage.getItem(KEY) || 0; } catch (_) { /* no storage: the in-page flag stops a second one */ }
    if (cspReload) return;
    if (n >= 2) { console.warn("[plugins] page CSP still disagrees with the vault trust flag after 2 reloads"); return; }
    cspReload = true;
    try { sessionStorage.setItem(KEY, String(n + 1)); } catch (_) {}
    console.warn("[plugins] reloading the page into the CSP of the vault's trust state");
    Promise.resolve(invoke ? invoke("save_debounce_ms") : 0).catch(() => 0)
      .then(ms => setTimeout(() => location.reload(), (+ms || 0) + 300));
  }
  const evalRefused = e => e instanceof EvalError
    || /unsafe-eval|Content Security Policy|Refused to evaluate/i.test(String(e && e.message));
  window.addEventListener("securitypolicyviolation", e => {
    if (!evalWanted) return;
    const d = String(e.effectiveDirective || e.violatedDirective || ""), u = String(e.blockedURI || "");
    if ((/^(script-src|worker-src)/.test(d) && (u === "eval" || u.startsWith("blob"))) || /^worker-src/.test(d)) cspReloadNow();
  });
  function cspCheck(s) {
    if (!s || typeof s.pageEval !== "boolean") return s;
    const trusted = !!s.trusted;
    evalWanted = trusted && !s.pageEval;
    if (trusted === s.pageEval) { try { sessionStorage.removeItem("osCspReload"); } catch (_) {} return s; }
    if (!trusted) cspReloadNow();
    return s;
  }

  const host = {
    api: null,
    status,
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
        state: () => invoke("plugins_state").then(cspCheck),
        set: a => invoke("plugins_set", a).then(cspCheck),
        io: (id, op, data) => invoke("plugin_io", data === undefined ? { id, op } : { id, op, data }),
        invoke,   // api.js's own vault calls (read/modify/...) — never handed to a plugin
        listen,   // api.js subscribes to vault-changed (Vault create/modify/delete/rename events)
      });
      return true;
    },
    snapshot: () => [...status].map(([id, s]) => id + "=" + s.state).join(","),
    /* cp-unrestricted: node-desktop.js captures this at boot (before the seal) for
       the desktop builtins it backs with Rust (child_process, ...). Only desk_*
       commands pass; Rust gates each spawn on the vault's trust flip. */
    desk: (cmd, args) => (invoke && /^desk_[a-z_]+$/.test(String(cmd)) ? invoke(String(cmd), args) : Promise.reject(new Error("desktop call refused"))),
  };
  // configurable until seal() swaps in the public facade (item 7)
  Object.defineProperty(window, "__osPluginHost", { value: host, configurable: true, writable: false, enumerable: false });
})();
