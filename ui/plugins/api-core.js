// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* the "obsidian" module, part CORE (api-parity stage 0: split out of api.js,
   behaviour-neutral). Events, Component, touch(), Platform / PlatformGuarded,
   requireApiVersion, Keymap, Notice, Scope + the keydown scope stack, the
   plugin registry and the shared bridge, loadMoment, app.keymap /
   app.commands / app.plugins, commands -> CMDS, Plugin, and the manager
   (enable / disable / refresh / boot / censusTok).

   Every part file registers named segments on window.__osApiParts; api.js
   (the assembler) runs them ONCE, in one fixed order that is the order the
   code ran in when it was a single file, then deletes the registry. A
   segment reads what earlier segments exported from the shared context K
   (never handed to a plugin) and exports its own names into K; a name from
   a LATER segment is read as K.name at call time. Mutable state several
   parts share lives in K.st (trusted, manifests, enabledIds, layoutReady,
   vaultName, modelOn). New obsidian exports go into K.exportClasses /
   K.exportValues; api.js appends them after the fixed list. */
(function () {
  "use strict";
  const parts = window.__osApiParts || (window.__osApiParts = Object.create(null));
  const reg = (id, fn) => { if (!(id in parts)) parts[id] = fn; };
  reg("core:events", function (K) {
    const { host, be } = K;
    /* ------------------------------------------------------------ Events */
    class Events {
      constructor() { Object.defineProperty(this, "_ev", { value: new Map(), writable: true }); }
      on(name, callback, ctx) {
        const ref = { e: this, name, fn: callback, ctx };
        if (!this._ev.has(name)) this._ev.set(name, []);
        this._ev.get(name).push(ref);
        return ref;
      }
      off(name, callback) {
        const a = this._ev.get(name); if (!a) return;
        const i = a.findIndex(r => r.fn === callback); if (i >= 0) a.splice(i, 1);
      }
      offref(ref) {
        const a = ref && this._ev.get(ref.name); if (!a) return;
        const i = a.indexOf(ref); if (i >= 0) a.splice(i, 1);
      }
      trigger(name, ...data) {
        const a = this._ev.get(name); if (!a) return;
        for (const r of a.slice()) this.tryTrigger(r, data);
      }
      tryTrigger(ref, args) {
        try { ref.fn.apply(ref.ctx, args); } catch (e) { console.error("[plugin] event handler " + ref.name + ":", e); }
      }
    }

    /* --------------------------------------------------------- Component */
    class Component {
      constructor() {
        Object.defineProperty(this, "_loaded", { value: false, writable: true });
        Object.defineProperty(this, "_disp", { value: [], writable: true });      // cleanup callbacks
        Object.defineProperty(this, "_children", { value: [], writable: true });
      }
      load() {
        if (this._loaded) return;
        this._loaded = true;
        const r = this.onload();
        for (const c of this._children.slice()) c.load();
        return r;
      }
      onload() {}
      unload() {
        if (!this._loaded) return;
        this._loaded = false;
        for (const c of this._children.splice(0).reverse()) { try { c.unload(); } catch (e) { console.error(e); } }
        for (const f of this._disp.splice(0).reverse()) { try { f(); } catch (e) { console.error("[plugin] cleanup:", e); } }
        try { this.onunload(); } catch (e) { console.error("[plugin] onunload:", e); }
      }
      onunload() {}
      addChild(c) { this._children.push(c); if (this._loaded) c.load(); return c; }
      removeChild(c) { const i = this._children.indexOf(c); if (i >= 0) { this._children.splice(i, 1); c.unload(); } return c; }
      register(cb) { this._disp.push(cb); }
      registerEvent(ref) { this.register(() => ref && ref.e && ref.e.offref(ref)); }
      registerDomEvent(el, type, cb, opts) { el.addEventListener(type, cb, opts); this.register(() => el.removeEventListener(type, cb, opts)); }
      registerScopeEvent(handler) { this.register(() => handler && handler.scope && handler.scope.unregister(handler)); }
      registerInterval(id) { this.register(() => clearInterval(id)); return id; }
    }

    /* ------------------------------------------------------ the manager */
    let touchT = 0;
    function touch() { if (touchT) return; touchT = requestAnimationFrame(() => { touchT = 0; if (typeof updateTitle === "function") try { updateTitle(); } catch (_) {} }); }
    Object.assign(K, { Component, Events, touch });
  });
  reg("core:platform", function (K) {
    const { host, be } = K;
    const Platform = Object.freeze({
      isDesktop: true, isMobile: false, isDesktopApp: true, isMobileApp: false, isIosApp: false,
      isAndroidApp: false, isPhone: false, isTablet: false, isMacOS: /Mac/.test(navigator.platform),
      isWin: /Win/.test(navigator.platform), isLinux: /Linux/.test(navigator.platform), isSafari: false,
      resourcePathPrefix: "",
    });
    /* guarded view (td-census-fix integration, ruling on recon-bundles.md (a)):
       what a manifest isDesktopOnly:false plugin with no granted desktop capability
       sees. Mobile, so real bundles take their non-Node branch (Templater skips
       its system-command exec, obsidian-git picks isomorphic-git over the adapter
       instead of spawning git). Desktop-only plugins keep the desktop view. */
    const PlatformGuarded = Object.freeze(Object.assign({}, Platform, { isDesktop: false, isMobile: true, isDesktopApp: false, isMobileApp: true }));
    const API_VERSION = "1.4.4";
    const vcmp = (a, b) => { const x = String(a).split("."), y = String(b).split("."); for (let i = 0; i < 3; i++) { const d = (+x[i] || 0) - (+y[i] || 0); if (d) return d; } return 0; };
    const requireApiVersion = v => vcmp(API_VERSION, v) >= 0;
    const Keymap = { isModEvent: e => !!(e && (e.ctrlKey || e.metaKey)), isModifier: (e, m) => !!e && ({ Mod: e.ctrlKey || e.metaKey, Ctrl: e.ctrlKey, Meta: e.metaKey, Shift: e.shiftKey, Alt: e.altKey })[m] };
    Object.assign(K, { API_VERSION, Keymap, Platform, PlatformGuarded, requireApiVersion });
  });
  reg("core:notice", function (K) {
    const { host, be } = K;
    const { installDom, touch } = K;
    /* ------------------------------------------------------------ Notice */
    let noticeBox = null;
    const notices = [];   // live Notice objects, newest last — [pnotice:] census
    class Notice {
      constructor(message, duration) {
        installDom();
        if (!noticeBox || !noticeBox.isConnected) { noticeBox = document.createElement("div"); noticeBox.className = "notice-container"; document.body.appendChild(noticeBox); }
        this.noticeEl = document.createElement("div");
        this.noticeEl.className = "notice";
        this.containerEl = this.noticeEl;
        this.messageEl = this.noticeEl;
        this.setMessage(message);
        this.noticeEl.addEventListener("click", () => this.hide());
        noticeBox.appendChild(this.noticeEl);
        notices.push(this);
        const ms = duration === undefined ? 5000 : duration;
        if (ms > 0) this._t = setTimeout(() => this.hide(), ms);
        touch();
      }
      setMessage(m) { if (m instanceof Node) { this.noticeEl.textContent = ""; this.noticeEl.appendChild(m); } else this.noticeEl.textContent = m == null ? "" : String(m); touch(); return this; }
      hide() { clearTimeout(this._t); this.noticeEl.remove(); const i = notices.indexOf(this); if (i >= 0) notices.splice(i, 1); touch(); }
    }

    /* ------------------------------------------------------------- Scope */
    class Scope {
      constructor(parent) { this.parent = parent; this.keys = []; }
      register(modifiers, key, func) {
        const h = { scope: this, modifiers: (modifiers || []).map(m => m.toLowerCase()), key: key == null ? null : String(key).toLowerCase(), func };
        this.keys.push(h); return h;
      }
      unregister(h) { const i = this.keys.indexOf(h); if (i >= 0) this.keys.splice(i, 1); }
      handle(e) {
        const mods = new Set([e.ctrlKey && "mod", e.ctrlKey && "ctrl", e.metaKey && "meta", e.altKey && "alt", e.shiftKey && "shift"].filter(Boolean));
        for (const h of this.keys) {
          if (h.key != null && h.key !== e.key.toLowerCase()) continue;
          if (h.modifiers.length && !h.modifiers.every(m => mods.has(m))) continue;
          if (!h.modifiers.length && h.key != null && (e.ctrlKey || e.altKey || e.metaKey)) continue;
          const r = h.func(e, { modifiers: [...mods].join(","), key: e.key, vkey: e.code });
          if (r === false) { e.preventDefault(); return false; }
        }
        return this.parent ? this.parent.handle(e) : true;
      }
    }
    const scopes = [];
    window.addEventListener("keydown", e => {   // a pushed scope (open plugin Modal / keymap.pushScope) sees keys first
      const s = scopes[scopes.length - 1];
      if (!s) return;
      if (s.handle(e) === false) e.stopImmediatePropagation();
    }, true);

    Object.assign(K, { Notice, Scope, notices, scopes });
  });
  reg("core:registry", function (K) {
    const { host, be } = K;
    /* --------------------------------------------- app + plugin registry */
    const registry = new Map();      // id -> {plugin, manifest, cmds:Set, ribbon:Set, status:Set, tabs:Set, styleEl}
    // manifests (id -> installed manifest), enabledIds (.obsidian/community-plugins.json order), trusted, layoutReady: K.st (api.js)



    const bridge = { editor: null };
    const statusBox = () => {
      let b = document.getElementById("os-plugin-statusbar");
      if (!b) { b = document.createElement("div"); b.id = "os-plugin-statusbar"; b.className = "status-bar os-plugin-statusbar"; document.body.appendChild(b); }
      return b;
    };

    Object.assign(K, { bridge, registry, statusBox });
  });
  reg("core:moment", function (K) {
    const { host, be } = K;
    function loadMoment() {
      if (window.moment) return Promise.resolve();
      return new Promise(res => {
        const s = document.createElement("script");
        s.src = "vendor/moment.min.js"; s.onload = s.onerror = () => res();
        document.head.appendChild(s);
      });
    }
    Object.assign(K, { loadMoment });
  });
  reg("core:keymap", function (K) {
    const { host, be } = K;
    const { scopes } = K;
    const keymap = {
      pushScope(s) { if (s) scopes.push(s); },
      popScope(s) { const i = scopes.lastIndexOf(s); if (i >= 0) scopes.splice(i, 1); },
    };
    Object.assign(K, { keymap });
  });
  reg("core:commands", function (K) {
    const { host, be } = K;
    const { registry } = K;
    const cmdObj = c => c.obs || { id: c.id, name: c.name, callback: c.run };
    const commands = {
      get commands() { const o = {}; if (typeof CMDS !== "undefined") for (const c of CMDS) o[c.id] = cmdObj(c); return o; },
      get editorCommands() { return {}; },
      listCommands() { return typeof CMDS === "undefined" ? [] : CMDS.map(cmdObj); },
      findCommand(id) { const c = typeof CMDS !== "undefined" && CMDS.find(x => x.id === id); return c ? cmdObj(c) : undefined; },
      executeCommandById(id) {
        const c = typeof CMDS !== "undefined" && CMDS.find(x => x.id === id);
        if (!c) return false;
        try { if (c.when && !c.when()) return false; c.run(); return true; } catch (e) { console.error("[plugin] command " + id + ":", e); return false; }
      },
      executeCommand(cmd) { return cmd && commands.executeCommandById(cmd.id); },
      removeCommand(id) { K.removeCmd(id); },
      addCommand(cmd) { return K.addCmd(null, cmd); },
    };
    const plugins = {
      get manifests() { return Object.assign({}, K.st.manifests); },
      get plugins() { const o = {}; for (const [id, r] of registry) o[id] = r.plugin; return o; },
      get enabledPlugins() { return new Set(registry.keys()); },
      getPlugin(id) { const r = registry.get(id); return r ? r.plugin : null; },
      isEnabled() { return K.st.trusted; },
      enablePlugin: id => K.enable(id), disablePlugin: id => K.disable(id),
      enablePluginAndSave: id => K.setEnabled(id, true), disablePluginAndSave: id => K.setEnabled(id, false),
    };
    Object.assign(K, { commands, plugins });
  });
  reg("core:plugin", function (K) {
    const { host, be } = K;
    const { Component, EA, MDP, bridge, commands, installDom, mdpChanged, registry, setIcon, setting, statusBox, touch, views } = K;
    /* ---------------------------------------------------- commands -> CMDS */
    function hkChord(h) { try { return typeof fileToChord === "function" ? fileToChord(h) : null; } catch (_) { return null; } }
    function addCmd(owner, cmd) {
      if (typeof CMDS === "undefined" || !cmd || !cmd.id) return cmd;
      const pid = owner ? owner.manifest.id : "";
      const full = owner && !String(cmd.id).startsWith(pid + ":") ? pid + ":" + cmd.id : String(cmd.id);
      const name = owner && !String(cmd.name).startsWith(owner.manifest.name + ": ") ? owner.manifest.name + ": " + cmd.name : String(cmd.name);
      cmd.id = full; cmd.name = name;
      const safe = (f, ...a) => { try { return f(...a); } catch (e) { console.error("[plugin] command " + full + ":", e); return false; } };
      const ed = () => (bridge.editor ? bridge.editor() : null);   // item 5: {editor, view} of the active note, or null
      let when, run;
      if (cmd.editorCheckCallback) { when = () => { const x = ed(); return !!x && !!safe(cmd.editorCheckCallback, true, x.editor, x.view); }; run = () => { const x = ed(); if (x) safe(cmd.editorCheckCallback, false, x.editor, x.view); }; }
      else if (cmd.editorCallback) { when = () => !!ed(); run = () => { const x = ed(); if (x) safe(cmd.editorCallback, x.editor, x.view); }; }
      else if (cmd.checkCallback) { when = () => !!safe(cmd.checkCallback, true); run = () => safe(cmd.checkCallback, false); }
      else { when = undefined; run = () => cmd.callback && safe(cmd.callback); }
      removeCmd(full);
      const defs = (cmd.hotkeys || []).map(hkChord).filter(Boolean);
      CMDS.push({ id: full, name, def: defs, run, when, obs: cmd, plugin: pid });
      CMDS.sort((a, b) => a.name.localeCompare(b.name));
      if (owner) registry.get(pid) && registry.get(pid).cmds.add(full);
      if (typeof hkRebuild === "function") hkRebuild();
      touch();
      return cmd;
    }
    function removeCmd(id) {
      if (typeof CMDS === "undefined") return;
      const i = CMDS.findIndex(c => c.id === id && c.obs);    // never a built-in command
      if (i < 0) return;
      const c = CMDS[i]; CMDS.splice(i, 1);
      const r = c.plugin && registry.get(c.plugin); if (r) r.cmds.delete(id);
      if (typeof hkRebuild === "function") hkRebuild();
      touch();
    }

    /* ------------------------------------------------------------ Plugin */
    class Plugin extends Component {
      constructor(app_, manifest) { super(); this.app = app_; this.manifest = manifest; }
      _rec() { return registry.get(this.manifest.id); }
      addCommand(cmd) { const r = addCmd(this, cmd); this.register(() => removeCmd(r.id)); return r; }
      removeCommand(id) { removeCmd(String(id).includes(":") ? id : this.manifest.id + ":" + id); }
      addRibbonIcon(icon, title, cb) {
        installDom();
        const b = document.createElement("button");
        b.className = "side-dock-ribbon-action clickable-icon os-plugin-ribbon";
        b.dataset.plugin = this.manifest.id;
        b.title = title; b.setAttribute("aria-label", title);
        setIcon(b, icon);
        b.addEventListener("click", e => { try { cb(e); } catch (er) { console.error("[plugin] ribbon:", er); } });
        const rb = document.getElementById("ribbon");
        (rb || document.body).appendChild(b);
        const r = this._rec(); if (r) r.ribbon.add(b);
        this.register(() => { b.remove(); const r2 = this._rec(); if (r2) r2.ribbon.delete(b); touch(); });
        touch();
        return b;
      }
      addStatusBarItem() {
        installDom();
        const el = statusBox().createDiv({ cls: "status-bar-item plugin-" + this.manifest.id.replace(/[^A-Za-z0-9_-]/g, "") });
        el.dataset.plugin = this.manifest.id;
        const r = this._rec(); if (r) r.status.add(el);
        document.body.classList.add("os-has-plugin-status");
        this.register(() => { el.remove(); const r2 = this._rec(); if (r2) r2.status.delete(el); if (!statusBox().children.length) document.body.classList.remove("os-has-plugin-status"); touch(); });
        touch();
        return el;
      }
      addSettingTab(tab) {
        tab.id = tab.id || this.manifest.id; tab.name = tab.name || this.manifest.name;
        setting.addSettingTab(tab);
        const r = this._rec(); if (r) r.tabs.add(tab);
        this.register(() => { if (setting.activeTab === tab) setting.closeActiveTab(); setting.removeSettingTab(tab); const r2 = this._rec(); if (r2) r2.tabs.delete(tab); touch(); });
        touch();
      }
      async loadData() { return be ? be.io(this.manifest.id, "load") : null; }
      async saveData(data) { if (!be) throw new Error("plugin backend unavailable"); await be.io(this.manifest.id, "save", data === undefined ? null : JSON.parse(JSON.stringify(data))); }
      onExternalSettingsChange() {}
      registerView(type, factory) {   // plugin-views: hosted in the app's tabs / right sidebar (ui/plugins/views.js); unload detaches them
        try { PVHOST = views.PV; } catch (_) {}   // main.js loadActive asks it to mount a plugin-view tab
        views.registerView(this.manifest.id, type, factory);
        this.register(() => views.unregisterView(type));
      }
      registerHoverLinkSource() {}
      registerExtensions() {}
      registerMarkdownPostProcessor(p, sortOrder) {   // item 7: reading view + MarkdownRenderer.render; unload unregisters
        if (typeof p !== "function") return p;
        if (sortOrder !== undefined) p.sortOrder = sortOrder;
        MDP.post.push(p); mdpChanged();
        this.register(() => { const i = MDP.post.indexOf(p); if (i >= 0) { MDP.post.splice(i, 1); mdpChanged(); } });
        return p;
      }
      registerMarkdownCodeBlockProcessor(lang, p, sortOrder) {   // item 7: ```lang fences -> div.block-language-lang
        lang = String(lang);
        if (typeof p !== "function") return p;
        if (MDP.code.has(lang)) { console.warn("[plugin] " + this.manifest.id + ": code block processor for \"" + lang + "\" already registered"); return p; }
        if (sortOrder !== undefined) p.sortOrder = sortOrder;
        MDP.code.set(lang, p); mdpChanged();
        this.register(() => { if (MDP.code.get(lang) === p) { MDP.code.delete(lang); mdpChanged(); } });
        return p;
      }
      registerEditorExtension(ext) {   // editor-api: every open + future note view, removed on unload
        if (!EA) { console.warn("[plugin] " + this.manifest.id + ": registerEditorExtension — editor extensions not supported"); return; }
        this.register(EA.addExt(this.manifest.id, ext));
      }
      registerEditorSuggest(s) { if (EA) this.register(EA.addSuggest(s)); }
      registerObsidianProtocolHandler() {}
      registerCliHandler() {}
    }

    Object.assign(K, { Plugin, addCmd, removeCmd });
  });
  reg("core:manager", function (K) {
    const { host, be } = K;
    const { EA, Plugin, app, ensureModel, focusTick, installDom, mdpCensus, notices, openModals, plugins, registry, removeCmd, setting, touch, vault, views, workspace } = K;
    // guarded = manifest isDesktopOnly:false (missing counts as desktop) and no granted desktop capability (none exist yet: td-desktop-caps)
    const isGuarded = m => !!m && m.isDesktopOnly === false;


    async function enable(id) {
      if (registry.has(id)) return { ok: true, id };
      if (!K.st.trusted) return host.fail(id, new Error("restricted mode is on"));
      const manifest = K.st.manifests[id];
      if (!manifest) return host.fail(id, new Error("not installed (no manifest.json)"));
      installDom();
      try { await ensureModel(); } catch (e) { touch(); return host.fail(id, new Error("vault model: " + (e && e.message || e))); }
      const r = await host.evaluate(id, isGuarded(manifest));
      if (!r.ok) { touch(); return r; }
      const ex = r.exports, Cls = ex && (ex.default || ex);
      if (typeof Cls !== "function" || !(Cls.prototype instanceof Plugin)) { touch(); return host.fail(id, new Error("main.js does not export a Plugin subclass")); }
      const rec = { cmds: new Set(), ribbon: new Set(), status: new Set(), tabs: new Set(), styleEl: null, plugin: null };
      registry.set(id, rec);
      try {
        const m = Object.assign({ dir: ".obsidian/plugins/" + id }, manifest);
        rec.plugin = new Cls(app, m);
        const css = await be.io(id, "styles").catch(() => null);
        if (typeof css === "string" && css) { rec.styleEl = document.createElement("style"); rec.styleEl.dataset.plugin = id; rec.styleEl.textContent = css; document.head.appendChild(rec.styleEl); }
        await rec.plugin.load();
      } catch (e) {
        teardown(id);
        touch();
        return host.fail(id, e);
      }
      host.status.set(id, { state: "loaded" });
      if (EA) EA.activate();   // editor-api: from the first loaded plugin on, note views carry editorInfoField + the editor-* hooks
      if (typeof hkLoad === "function") hkLoad().catch(() => {});   // the user's chords for this plugin's ids (hkLoad drops unknown ids)
      touch();
      return { ok: true, id };
    }
    function teardown(id) {
      const rec = registry.get(id); if (!rec) return;
      try { if (rec.plugin) rec.plugin.unload(); } catch (e) { console.error("[plugin] unload " + id + ":", e); }
      // belt and braces: anything still attributed to the plugin goes too
      for (const c of [...rec.cmds]) removeCmd(c);
      for (const b of rec.ribbon) b.remove();
      for (const s of rec.status) s.remove();
      for (const t of rec.tabs) setting.removeSettingTab(t);
      if (rec.styleEl) rec.styleEl.remove();
      for (const m of openModals.slice()) m.close();      // a modal is not attributable to its plugin; close them all
      registry.delete(id);
    }
    function disable(id) {
      if (!registry.has(id)) return { ok: true, id };
      teardown(id);
      host.status.set(id, { state: "unloaded" });
      touch();
      return { ok: true, id };
    }
    async function refresh() {
      const s = await be.state();
      K.st.trusted = !!s.trusted;
      K.st.enabledIds = (s.enabled || []).slice();
      K.st.manifests = {};
      for (const p of s.installed || []) if (p && p.id && p.manifest) K.st.manifests[p.id] = p.manifest;
      return s;
    }
    async function setEnabled(id, on) {
      await be.set({ id, on: !!on });
      await refresh();
      if (!K.st.trusted) { touch(); return { ok: true, id }; }   // restricted: the choice is saved, nothing runs
      return on ? enable(id) : disable(id);
    }
    async function setRestricted(restricted) {
      await be.set({ trusted: !restricted });
      await refresh();
      if (restricted) for (const id of [...registry.keys()]) disable(id);
      else for (const id of K.st.enabledIds) await enable(id);
      touch();
    }
    /* boot: called by main.js once the vault is entered. Restricted mode (the
       default) = one plugins_state call and nothing else: no prototype touched,
       no plugin script requested. */
    async function boot(vaultPathArg) {
      try {
        K.st.vaultName = String(vaultPathArg || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
        app.appId = String(vaultPathArg || "").split("").reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7).toString(16);
        await refresh();
        K.st.layoutReady = true; workspace.layoutReady = true;
        if (K.st.trusted) for (const id of K.st.enabledIds) await enable(id);
        workspace.trigger("layout-ready");
      } catch (e) { console.error("[plugin] boot:", e); }
      touch();
    }
    /* [plg:] census: restricted flag, per plugin state, and what is registered
       right now — cmds / ribbon / status / tabs counts summed over loaded
       plugins, so an unload phase can assert they drop to 0. */
    function censusTok() {
      if (K.st.modelOn) focusTick();   // file-open / active-leaf-change detection (workspace section)
      if (!be || (!K.st.trusted && !host.status.size)) return K.st.trusted ? "" : " [plg:R]";
      let c = 0, rb = 0, st = 0, tb = 0;
      for (const r of registry.values()) { c += r.cmds.size; rb += r.ribbon.size; st += r.status.size; tb += r.tabs.size; }
      // a failed plugin carries its error (first 80 chars, census-safe) so a red phase says WHY
      const ids = [...host.status].map(([id, s]) => id + "=" + s.state + (s.state === "failed" && s.error ? "(" + String(s.error).replace(/[[\]|,=()\s]+/g, "_").slice(0, 80) + ")" : "")).join(",");
      const nt = notices.length ? " [pnotice:" + notices.map(n => n.noticeEl.textContent.replace(/[[\]|]/g, "").slice(0, 60)).join("|") + "]" : "";
      const md = openModals.length ? " [pmodal:" + openModals.length + "]" : "";
      if (EA) EA.tick();   // editor-api: editorLivePreviewField follows the focused tab's mode
      return " [plg:" + (K.st.trusted ? "T" : "R") + "|" + ids + "] [preg:c" + c + ",r" + rb + ",s" + st + ",t" + tb + "]" + nt + md + views.censusTok() + mdpCensus() + (EA ? EA.tok() : "");
    }

    Object.assign(K, { boot, censusTok, disable, enable, refresh, setEnabled, setRestricted });
  });
})();
