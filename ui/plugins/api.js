// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* plugin-loader (recon M1), ledger item 4: the "obsidian" module a community
   plugin require()s, and the plugin manager that drives its lifecycle.
   Written from the public obsidian-api typings (obsidian.d.ts) and plugin
   source only (clean room).

   Load order (index.html): loader.js -> api.js -> main.js. This file
     - takes the backend handle ONCE via __osPluginHost.grant() (plugins_state /
       plugins_set / plugin_io), then freezes the host object;
     - builds the API object (Events, Component, Plugin, Notice, Modal, Setting,
       PluginSettingTab, Menu, SuggestModal, ...) and the `app` skeleton;
     - talks to main.js only through names main.js defines at top level (CMDS,
       hkRebuild, placeMenu, closeMenu, updateTitle, fileToChord) and only at
       call time, never at load — same rule as census.js;
     - installs Obsidian's DOM helpers (createEl, empty, setText, ...) LAZILY,
       when the first plugin is evaluated: restricted mode (the default) changes
       no prototype and runs no plugin code.

   Item 5 adds the vault model (TFile/TFolder + Vault events from the Rust
   watcher), a synchronous MetadataCache filled ahead by a sweep, Workspace
   leaves over the app's tab groups, and the vendored moment (ui/vendor).

   Unload contract: everything a plugin registered — commands, ribbon icons,
   status bar items, setting tabs, DOM listeners, intervals, event refs,
   children, styles.css, open modals/notices it owns — is removed by
   Plugin.unload(). The 9NN phases assert it through the [plg:] census. */
(function () {
  "use strict";
  const host = window.__osPluginHost;
  if (!host) return;
  let be = null;                      // {state, set, io, invoke} — never handed to a plugin
  host.grant(h => { be = h; });

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

  /* ------------------------------------------------------------- icons
     A tiny built-in set (drawn here, lucide-style 24x24 strokes) + addIcon().
     An unknown name draws a neutral square so a button never renders empty. */
  const P = (d) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + d + "</svg>";
  const ICONS = {
    "dice": P('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1"/><circle cx="15.5" cy="15.5" r="1"/><circle cx="12" cy="12" r="1"/>'),
    "calendar": P('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'),
    "calendar-days": P('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>'),
    "calendar-range": P('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M7 14h4M13 18h4"/>'),
    "plus": P('<path d="M12 5v14M5 12h14"/>'),
    "plus-circle": P('<circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/>'),
    "x": P('<path d="M18 6L6 18M6 6l12 12"/>'),
    "cross": P('<path d="M18 6L6 18M6 6l12 12"/>'),
    "check": P('<path d="M20 6L9 17l-5-5"/>'),
    "trash": P('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'),
    "trash-2": P('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>'),
    "pencil": P('<path d="M17 3l4 4L7 21H3v-4z"/>'),
    "settings": P('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>'),
    "gear": P('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>'),
    "search": P('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'),
    "chevron-down": P('<path d="M6 9l6 6 6-6"/>'),
    "chevron-up": P('<path d="M18 15l-6-6-6 6"/>'),
    "chevron-right": P('<path d="M9 18l6-6-6-6"/>'),
    "chevron-left": P('<path d="M15 18l-6-6 6-6"/>'),
    "arrow-up": P('<path d="M12 19V5M5 12l7-7 7 7"/>'),
    "arrow-down": P('<path d="M12 5v14M19 12l-7 7-7-7"/>'),
    "file": P('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>'),
    "file-text": P('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h6"/>'),
    "folder": P('<path d="M3 7V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
    "star": P('<path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/>'),
    "info": P('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>'),
    "command": P('<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>'),
    "terminal": P('<path d="M4 17l6-6-6-6M12 19h8"/>'),
    "more-vertical": P('<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>'),
    "more-horizontal": P('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
    "grip-vertical": P('<circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/>'),
    "eye": P('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
    "eye-off": P('<path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A9 9 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a9 9 0 0 0 5.4-1.6"/>'),
    "zap": P('<path d="M13 2L3 14h9l-1 8 10-12h-9z"/>'),
    "link": P('<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>'),
    "refresh-cw": P('<path d="M21 2v6h-6M3 22v-6h6M3.5 9a9 9 0 0 1 15-3.4L21 8M3 16l2.5 2.4A9 9 0 0 0 20.5 15"/>'),
    "copy": P('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    "external-link": P('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>'),
    "image": P('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>'),
    "palette": P('<circle cx="12" cy="12" r="10"/><circle cx="8" cy="10" r="1"/><circle cx="12" cy="7" r="1"/><circle cx="16" cy="10" r="1"/>'),
  };
  const custom = new Map();           // addIcon: name -> svg inner content (viewBox 0 0 100 100)
  const DEFAULT_ICON = P('<rect x="4" y="4" width="16" height="16" rx="3"/>');
  function iconSvg(name) {
    name = String(name || "").replace(/^lucide-/, "");
    if (custom.has(name)) return '<svg viewBox="0 0 100 100" width="100%" height="100%" fill="currentColor">' + custom.get(name) + "</svg>";
    return ICONS[name] || DEFAULT_ICON;
  }
  function setIcon(el, name) {
    if (!el) return;
    el.innerHTML = iconSvg(name);
    const s = el.firstElementChild; if (s) { s.classList.add("svg-icon"); s.dataset.icon = String(name || ""); }
  }
  function getIcon(name) { const d = document.createElement("div"); setIcon(d, name); return d.firstElementChild; }
  const addIcon = (name, svg) => { custom.set(String(name), String(svg)); };
  const removeIcon = name => { custom.delete(String(name)); };
  const getIconIds = () => [...Object.keys(ICONS), ...custom.keys()];

  /* -------------------------------------------- DOM helpers (lazy install) */
  function applyInfo(el, o) {
    if (o == null) return el;
    if (typeof o === "string") { el.className = o; return el; }
    if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
    if (o.text != null) { if (o.text instanceof Node) el.appendChild(o.text); else el.textContent = String(o.text); }
    if (o.attr) for (const [k, v] of Object.entries(o.attr)) { if (v == null || v === false) el.removeAttribute(k); else el.setAttribute(k, v === true ? "" : String(v)); }
    if (o.title != null) el.title = o.title;
    if (o.value != null && "value" in el) el.value = o.value;
    if (o.type != null) el.setAttribute("type", o.type);
    if (o.placeholder != null) el.setAttribute("placeholder", o.placeholder);
    if (o.href != null) el.setAttribute("href", o.href);
    if (o.parent) { if (o.prepend) o.parent.prepend(el); else o.parent.appendChild(el); }
    return el;
  }
  function mk(tag, o, cb, ns) {
    const el = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
    applyInfo(el, o);
    if (typeof cb === "function") cb(el);
    return el;
  }
  const SVGNS = "http://www.w3.org/2000/svg";
  let domInstalled = false;
  function def(proto, name, value) {
    if (Object.prototype.hasOwnProperty.call(proto, name)) return;
    Object.defineProperty(proto, name, { value, configurable: true, writable: true, enumerable: false });
  }
  function defGet(proto, name, get) {
    if (Object.prototype.hasOwnProperty.call(proto, name)) return;
    Object.defineProperty(proto, name, { get, configurable: true, enumerable: false });
  }
  function installDom() {
    if (domInstalled) return;
    domInstalled = true;
    const appendTo = function (tag, o, cb, ns) {
      const el = mk(tag, o, cb, ns);
      if (o && typeof o === "object" && o.prepend) this.prepend(el); else this.appendChild(el);
      return el;
    };
    for (const proto of [Node.prototype]) {
      def(proto, "createEl", function (tag, o, cb) { return appendTo.call(this, tag, o, cb); });
      def(proto, "createDiv", function (o, cb) { return appendTo.call(this, "div", o, cb); });
      def(proto, "createSpan", function (o, cb) { return appendTo.call(this, "span", o, cb); });
      def(proto, "createSvg", function (tag, o, cb) { return appendTo.call(this, tag, o, cb, SVGNS); });
      def(proto, "detach", function () { if (this.parentNode) this.parentNode.removeChild(this); });
      def(proto, "empty", function () { while (this.lastChild) this.removeChild(this.lastChild); });
      def(proto, "insertAfter", function (node, child) { this.insertBefore(node, child ? child.nextSibling : this.firstChild); return node; });
      def(proto, "indexOf", function (other) { return Array.prototype.indexOf.call(this.childNodes, other); });
      def(proto, "setChildrenInPlace", function (children) { this.empty(); for (const c of children) this.appendChild(c); });
      def(proto, "appendText", function (v) { this.appendChild(document.createTextNode(v)); });
      def(proto, "instanceOf", function (type) { return this instanceof type; });
      defGet(proto, "doc", function () { return this.ownerDocument || document; });
      defGet(proto, "win", function () { return (this.ownerDocument || document).defaultView || window; });
      defGet(proto, "constructorWin", function () { return window; });
    }
    const E = Element.prototype;
    def(E, "getText", function () { return this.textContent; });
    def(E, "setText", function (v) { if (v instanceof Node) { this.empty(); this.appendChild(v); } else this.textContent = v == null ? "" : String(v); });
    def(E, "addClass", function (...c) { this.classList.add(...c.flat().filter(Boolean)); });
    def(E, "addClasses", function (c) { this.classList.add(...c.filter(Boolean)); });
    def(E, "removeClass", function (...c) { this.classList.remove(...c.flat().filter(Boolean)); });
    def(E, "removeClasses", function (c) { this.classList.remove(...c.filter(Boolean)); });
    def(E, "toggleClass", function (c, v) { for (const x of [].concat(c)) this.classList.toggle(x, !!v); });
    def(E, "hasClass", function (c) { return this.classList.contains(c); });
    def(E, "setAttr", function (k, v) { if (v == null || v === false) this.removeAttribute(k); else this.setAttribute(k, v === true ? "" : String(v)); });
    def(E, "setAttrs", function (o) { for (const [k, v] of Object.entries(o)) this.setAttr(k, v); });
    def(E, "getAttr", function (k) { return this.getAttribute(k); });
    def(E, "matchParent", function (sel, last) { for (let e = this; e && e !== last; e = e.parentElement) if (e.matches(sel)) return e; return null; });
    def(E, "getCssPropertyValue", function (p, pseudo) { return getComputedStyle(this, pseudo).getPropertyValue(p); });
    def(E, "isActiveElement", function () { return document.activeElement === this; });
    def(E, "find", function (s) { return this.querySelector(s); });
    def(E, "findAll", function (s) { return [...this.querySelectorAll(s)]; });
    def(E, "findAllSelf", function (s) { return [...(this.matches(s) ? [this] : []), ...this.querySelectorAll(s)]; });
    const H = HTMLElement.prototype;
    def(H, "show", function () { this.style.display = ""; });
    def(H, "hide", function () { this.style.display = "none"; });
    def(H, "toggle", function (s) { this.style.display = s ? "" : "none"; });
    def(H, "toggleVisibility", function (v) { this.style.visibility = v ? "" : "hidden"; });
    def(H, "isShown", function () { return !!this.offsetParent || this.getClientRects().length > 0; });
    def(H, "setCssStyles", function (o) { Object.assign(this.style, o); });
    def(H, "setCssProps", function (o) { for (const [k, v] of Object.entries(o)) this.style.setProperty(k, v); });
    defGet(H, "innerWidth", function () { return this.clientWidth; });
    defGet(H, "innerHeight", function () { return this.clientHeight; });
    def(H, "onClickEvent", function (l, opts) { this.addEventListener("click", l, opts); this.addEventListener("auxclick", l, opts); });
    def(H, "onNodeInserted", function (l, once) {
      const fn = e => { if (e.animationName !== "node-inserted") return; l(); if (once) this.removeEventListener("animationstart", fn); };
      this.addEventListener("animationstart", fn); return () => this.removeEventListener("animationstart", fn);
    });
    def(H, "onWindowMigrated", function () { return () => {}; });
    def(H, "trigger", function (t) { this.dispatchEvent(new Event(t)); });
    const DEL = new WeakMap();
    def(H, "on", function (type, sel, l, opts) {
      const fn = e => { const t = e.target && e.target.closest && e.target.closest(sel); if (t && this.contains(t)) l.call(this, e, t); };
      let m = DEL.get(this); if (!m) DEL.set(this, m = []);
      m.push({ type, sel, l, fn }); this.addEventListener(type, fn, opts);
    });
    def(H, "off", function (type, sel, l, opts) {
      const m = DEL.get(this) || [], i = m.findIndex(x => x.type === type && x.sel === sel && x.l === l);
      if (i >= 0) { this.removeEventListener(type, m[i].fn, opts); m.splice(i, 1); }
    });
    for (const proto of [Document.prototype, DocumentFragment.prototype]) {
      def(proto, "find", function (s) { return this.querySelector(s); });
      def(proto, "findAll", function (s) { return [...this.querySelectorAll(s)]; });
    }
    const A = Array.prototype;
    def(A, "first", function () { return this[0]; });
    def(A, "last", function () { return this[this.length - 1]; });
    def(A, "contains", function (x) { return this.indexOf(x) >= 0; });
    def(A, "remove", function (x) { const i = this.indexOf(x); if (i >= 0) this.splice(i, 1); });
    def(A, "unique", function () { return [...new Set(this)]; });
    def(A, "shuffle", function () { for (let i = this.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [this[i], this[j]] = [this[j], this[i]]; } return this; });
    def(Array, "combine", function (arrs) { return [].concat(...arrs); });
    def(String.prototype, "contains", function (s) { return this.indexOf(s) >= 0; });
    def(Math, "clamp", function (v, lo, hi) { return Math.min(hi, Math.max(lo, v)); });
    def(Math, "square", function (v) { return v * v; });
    def(Number, "isNumber", function (v) { return typeof v === "number"; });
    def(Object, "isEmpty", function (o) { for (const _ in o) return false; return true; });
    def(Object, "each", function (o, cb, ctx) { for (const k in o) if (cb.call(ctx, o[k], k) === false) return false; return true; });
    const g = window;
    def(g, "createEl", (tag, o, cb) => mk(tag, o, cb));
    def(g, "createDiv", (o, cb) => mk("div", o, cb));
    def(g, "createSpan", (o, cb) => mk("span", o, cb));
    def(g, "createSvg", (tag, o, cb) => mk(tag, o, cb, SVGNS));
    def(g, "createFragment", cb => { const f = document.createDocumentFragment(); if (cb) cb(f); return f; });
    def(g, "fish", s => document.querySelector(s));
    def(g, "fishAll", s => [...document.querySelectorAll(s)]);
    def(g, "sleep", ms => new Promise(r => setTimeout(r, ms)));
    def(g, "nextFrame", () => new Promise(r => requestAnimationFrame(() => r())));
    def(g, "isBoolean", v => typeof v === "boolean");
    defGet(g, "activeWindow", () => window);
    defGet(g, "activeDocument", () => document);
    // fishing for append helpers on fragments too
    for (const n of ["createEl", "createDiv", "createSpan"]) def(DocumentFragment.prototype, n, Node.prototype[n]);
  }

  /* ----------------------------------------------------------- utility */
  const normalizePath = p => {
    let s = String(p == null ? "" : p).replace(/\\/g, "/").replace(/[  ]/g, " ").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
    s = s.normalize("NFC");
    return s === "" ? "/" : s;
  };
  const debounce = (cb, ms = 0, resetTimer = false) => {
    let t = null, last = null;
    const f = function (...a) {
      last = a;
      if (t && !resetTimer) return f;
      clearTimeout(t);
      t = setTimeout(() => { t = null; cb.apply(this, last); }, ms);
      return f;
    };
    f.cancel = () => { clearTimeout(t); t = null; return f; };
    f.run = () => { if (t) { clearTimeout(t); t = null; return cb.apply(null, last); } };
    return f;
  };
  const Platform = Object.freeze({
    isDesktop: true, isMobile: false, isDesktopApp: true, isMobileApp: false, isIosApp: false,
    isAndroidApp: false, isPhone: false, isTablet: false, isMacOS: /Mac/.test(navigator.platform),
    isWin: /Win/.test(navigator.platform), isLinux: /Linux/.test(navigator.platform), isSafari: false,
    resourcePathPrefix: "",
  });
  const API_VERSION = "1.4.4";
  const vcmp = (a, b) => { const x = String(a).split("."), y = String(b).split("."); for (let i = 0; i < 3; i++) { const d = (+x[i] || 0) - (+y[i] || 0); if (d) return d; } return 0; };
  const requireApiVersion = v => vcmp(API_VERSION, v) >= 0;
  // fuzzy subsequence match: score favours early + contiguous hits (same idea as the app's palette)
  function prepareFuzzySearch(q) {
    const ql = String(q).toLowerCase().replace(/\s+/g, "");
    return text => {
      if (!ql) return { score: 0, matches: [] };
      const t = String(text).toLowerCase(); let i = 0, score = 0, prev = -2; const m = [];
      for (let j = 0; j < t.length && i < ql.length; j++) if (t[j] === ql[i]) { score -= (j - prev - 1) * 0.1 + j * 0.001; if (j === prev + 1 && m.length) m[m.length - 1][1] = j + 1; else m.push([j, j + 1]); prev = j; i++; }
      return i === ql.length ? { score, matches: m } : null;
    };
  }
  function prepareSimpleSearch(q) {
    const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    return text => { const t = String(text).toLowerCase(), m = []; for (const w of words) { const i = t.indexOf(w); if (i < 0) return null; m.push([i, i + w.length]); } return { score: 0, matches: m }; };
  }
  function renderMatches(el, text, matches, offset = 0) {
    let at = 0;
    for (const [a0, b0] of matches || []) { const a = a0 - offset, b = b0 - offset; if (b <= 0 || a >= text.length) continue; if (a > at) el.appendText(text.slice(at, a)); el.createSpan({ cls: "suggestion-highlight", text: text.slice(Math.max(a, 0), b) }); at = b; }
    if (at < text.length) el.appendText(text.slice(at));
  }
  const parseFrontMatterEntry = (fm, key) => {
    if (!fm) return null;
    if (key instanceof RegExp) { for (const k of Object.keys(fm)) if (key.test(k)) return fm[k]; return null; }
    return Object.prototype.hasOwnProperty.call(fm, key) ? fm[key] : null;
  };
  const parseFrontMatterAliases = fm => { const v = parseFrontMatterEntry(fm, /^alias(es)?$/i); return v == null ? null : [].concat(v).map(String); };
  const parseFrontMatterTags = fm => { const v = parseFrontMatterEntry(fm, /^tags?$/i); return v == null ? null : [].concat(v).flatMap(x => String(x).split(/[,\s]+/)).filter(Boolean).map(t => t.startsWith("#") ? t : "#" + t); };
  const requestUrl = () => Promise.reject(new Error("requestUrl is not supported in opensidian yet (M1)"));
  const htmlToMarkdown = h => String(h).replace(/<[^>]+>/g, "");

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

  /* ------------------------------------------------------------- Modal */
  const openModals = [];
  class Modal {
    constructor(app) {
      installDom();
      this.app = app;
      this.scope = new Scope();
      this.shouldRestoreSelection = true;
      this.containerEl = mk("div", { cls: "modal-container os-plugin-modal" });
      this.bgEl = this.containerEl.createDiv({ cls: "modal-bg" });
      this.modalEl = this.containerEl.createDiv({ cls: "modal" });
      this.closeButtonEl = this.modalEl.createDiv({ cls: "modal-close-button", attr: { "aria-label": "Close" } });
      this.titleEl = this.modalEl.createDiv({ cls: "modal-title" });
      this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
      this.closeButtonEl.addEventListener("click", () => this.close());
      this.bgEl.addEventListener("click", () => this.close());
      this.scope.register([], "Escape", () => { this.close(); return false; });
      this._open = false;
    }
    open() {
      if (this._open) return;
      this._open = true;
      this._prevFocus = document.activeElement;
      document.body.appendChild(this.containerEl);
      openModals.push(this); scopes.push(this.scope);
      try { this.onOpen(); } catch (e) { console.error("[plugin] Modal.onOpen:", e); }
      touch();
    }
    close() {
      if (!this._open) return;
      this._open = false;
      this.containerEl.remove();
      const i = openModals.indexOf(this); if (i >= 0) openModals.splice(i, 1);
      const j = scopes.lastIndexOf(this.scope); if (j >= 0) scopes.splice(j, 1);
      try { this.onClose(); } catch (e) { console.error("[plugin] Modal.onClose:", e); }
      if (this.shouldRestoreSelection && this._prevFocus && this._prevFocus.focus) try { this._prevFocus.focus(); } catch (_) {}
      touch();
    }
    onOpen() {}
    onClose() {}
    setTitle(t) { this.titleEl.textContent = t; return this; }
    setContent(c) { this.contentEl.textContent = ""; if (c instanceof Node) this.contentEl.appendChild(c); else this.contentEl.textContent = String(c); return this; }
  }

  /* ---------------------------------------------- SuggestModal / Fuzzy */
  class SuggestModal extends Modal {
    constructor(app) {
      super(app);
      this.limit = 100;
      this.emptyStateText = "No results found.";
      this.modalEl.addClass("prompt");
      this.titleEl.remove(); this.contentEl.remove();
      this.inputEl = this.modalEl.createEl("input", { cls: "prompt-input", attr: { type: "text", spellcheck: "false" } });
      this.resultContainerEl = this.modalEl.createDiv({ cls: "prompt-results" });
      this.instructionsEl = this.modalEl.createDiv({ cls: "prompt-instructions" });
      this._items = []; this._sel = 0;
      this.inputEl.addEventListener("input", () => this._update());
      this.scope.register([], "ArrowDown", () => { this._move(1); return false; });
      this.scope.register([], "ArrowUp", () => { this._move(-1); return false; });
      this.scope.register([], "Enter", e => { this._choose(e); return false; });
    }
    setPlaceholder(p) { this.inputEl.setAttribute("placeholder", p); }
    setInstructions(list) { this.instructionsEl.empty(); for (const i of list || []) { const d = this.instructionsEl.createDiv({ cls: "prompt-instruction" }); d.createSpan({ cls: "prompt-instruction-command", text: i.command }); d.createSpan({ text: i.purpose }); } }
    onOpen() { this._update(); this.inputEl.focus(); }
    async _update() {
      let r; try { r = await this.getSuggestions(this.inputEl.value); } catch (e) { console.error(e); r = []; }
      this._items = (r || []).slice(0, this.limit); this._sel = 0;
      this.resultContainerEl.empty();
      if (!this._items.length) { this.resultContainerEl.createDiv({ cls: "suggestion-empty", text: this.emptyStateText }); touch(); return; }
      this._items.forEach((v, i) => {
        const el = this.resultContainerEl.createDiv({ cls: "suggestion-item" + (i === 0 ? " is-selected" : "") });
        try { this.renderSuggestion(v, el); } catch (e) { console.error(e); }
        el.addEventListener("mousemove", () => this._setSel(i));
        el.addEventListener("click", e => { this._sel = i; this._choose(e); });
      });
      touch();
    }
    _setSel(i) { const k = this.resultContainerEl.children; if (k[this._sel]) k[this._sel].classList.remove("is-selected"); this._sel = i; if (k[i]) { k[i].classList.add("is-selected"); k[i].scrollIntoView({ block: "nearest" }); } }
    _move(d) { if (this._items.length) this._setSel((this._sel + d + this._items.length) % this._items.length); }
    _choose(e) { const v = this._items[this._sel]; if (v !== undefined) this.selectSuggestion(v, e); }
    selectSuggestion(v, e) { this.close(); this.onChooseSuggestion(v, e); }
    getSuggestions() { return []; }
    renderSuggestion(v, el) { el.setText(String(v)); }
    onChooseSuggestion() {}
  }
  class FuzzySuggestModal extends SuggestModal {
    getSuggestions(q) {
      const f = prepareFuzzySearch(q), out = [];
      for (const item of this.getItems()) { const m = f(this.getItemText(item)); if (m) out.push({ item, match: m }); }
      if (q) out.sort((a, b) => b.match.score - a.match.score);
      return out;
    }
    renderSuggestion(fm, el) { renderMatches(el, this.getItemText(fm.item), fm.match.matches); }
    onChooseSuggestion(fm, e) { this.onChooseItem(fm.item, e); }
    getItems() { return []; }
    getItemText(i) { return String(i); }
    onChooseItem() {}
  }

  /* ------------------------------------------------- Setting + controls */
  class BaseComponent {
    constructor() { this.disabled = false; }
    then(cb) { cb(this); return this; }
    setDisabled(d) { this.disabled = !!d; return this; }
  }
  class ValueComponent extends BaseComponent {
    registerOptionListener(listeners, key) { listeners[key] = v => { if (v !== undefined) this.setValue(v); return this.getValue(); }; return this; }
  }
  class AbstractTextComponent extends ValueComponent {
    constructor(inputEl) { super(); this.inputEl = inputEl; this._cb = null; inputEl.addEventListener("input", () => this.onChanged()); }
    setDisabled(d) { super.setDisabled(d); this.inputEl.disabled = !!d; return this; }
    getValue() { return this.inputEl.value; }
    setValue(v) { this.inputEl.value = v == null ? "" : v; return this; }
    setPlaceholder(p) { this.inputEl.placeholder = p; return this; }
    onChanged() { if (this._cb) this._cb(this.getValue()); }
    onChange(cb) { this._cb = cb; return this; }
  }
  class TextComponent extends AbstractTextComponent {
    constructor(containerEl) { installDom(); super(containerEl.createEl("input", { attr: { type: "text", spellcheck: "false" } })); }
  }
  class SearchComponent extends AbstractTextComponent {
    constructor(containerEl) {
      installDom();
      const box = containerEl.createDiv({ cls: "search-input-container" });
      super(box.createEl("input", { attr: { type: "search", spellcheck: "false" } }));
      this.containerEl = box;
      this.clearButtonEl = box.createDiv({ cls: "search-input-clear-button" });
      this.clearButtonEl.addEventListener("click", () => { this.setValue(""); this.onChanged(); });
    }
    setClass(c) { this.containerEl.addClass(c); return this; }
  }
  class TextAreaComponent extends AbstractTextComponent {
    constructor(containerEl) { installDom(); super(containerEl.createEl("textarea", { attr: { spellcheck: "false" } })); }
  }
  class MomentFormatComponent extends TextComponent {
    setDefaultFormat(f) { this.defaultFormat = f; if (!this.inputEl.placeholder) this.setPlaceholder(f); return this; }
    setSampleEl(el) { this.sampleEl = el; return this; }
    updateSample() {}
  }
  class ToggleComponent extends ValueComponent {
    constructor(containerEl) {
      super(); installDom();
      this.toggleEl = containerEl.createDiv({ cls: "checkbox-container" });
      this.toggleEl.createEl("input", { attr: { type: "checkbox", tabindex: "0" } });
      this._v = false; this._cb = null;
      this.toggleEl.addEventListener("click", e => { e.preventDefault(); this.onClick(); });
    }
    setDisabled(d) { super.setDisabled(d); this.toggleEl.toggleClass("is-disabled", !!d); return this; }
    getValue() { return this._v; }
    setValue(v) { this._v = !!v; this.toggleEl.toggleClass("is-enabled", this._v); const i = this.toggleEl.querySelector("input"); if (i) i.checked = this._v; return this; }
    setTooltip(t) { this.toggleEl.setAttribute("aria-label", t); this.toggleEl.title = t; return this; }
    onClick() { if (this.disabled) return; this.setValue(!this._v); if (this._cb) this._cb(this._v); }
    onChange(cb) { this._cb = cb; return this; }
  }
  class DropdownComponent extends ValueComponent {
    constructor(containerEl) { super(); installDom(); this.selectEl = containerEl.createEl("select", { cls: "dropdown" }); this._cb = null; this.selectEl.addEventListener("change", () => { if (this._cb) this._cb(this.getValue()); }); }
    setDisabled(d) { super.setDisabled(d); this.selectEl.disabled = !!d; return this; }
    addOption(v, label) { this.selectEl.createEl("option", { value: v, text: label }); return this; }
    addOptions(o) { for (const [v, l] of Object.entries(o)) this.addOption(v, l); return this; }
    getValue() { return this.selectEl.value; }
    setValue(v) { this.selectEl.value = v; return this; }
    onChange(cb) { this._cb = cb; return this; }
  }
  class SliderComponent extends ValueComponent {
    constructor(containerEl) { super(); installDom(); this.sliderEl = containerEl.createEl("input", { cls: "slider", attr: { type: "range" } }); this._cb = null; this.sliderEl.addEventListener("input", () => { if (this._cb) this._cb(this.getValue()); }); }
    setDisabled(d) { super.setDisabled(d); this.sliderEl.disabled = !!d; return this; }
    setLimits(min, max, step) { if (min != null) this.sliderEl.min = min; if (max != null) this.sliderEl.max = max; this.sliderEl.step = step === "any" || step == null ? "any" : step; return this; }
    getValue() { return +this.sliderEl.value; }
    setValue(v) { this.sliderEl.value = v; return this; }
    getValuePretty() { return String(this.getValue()); }
    setDynamicTooltip() { return this; }
    showTooltip() {}
    setInstant() { return this; }
    onChange(cb) { this._cb = cb; return this; }
  }
  class ColorComponent extends ValueComponent {
    constructor(containerEl) { super(); installDom(); this.colorPickerEl = containerEl.createEl("input", { attr: { type: "color" } }); this._cb = null; this.colorPickerEl.addEventListener("input", () => { if (this._cb) this._cb(this.getValue()); }); }
    setDisabled(d) { super.setDisabled(d); this.colorPickerEl.disabled = !!d; return this; }
    getValue() { return this.colorPickerEl.value; }
    setValue(v) { this.colorPickerEl.value = v; return this; }
    getValueRgb() { const h = this.getValue().replace("#", ""); return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }; }
    setValueRgb(c) { const x = n => (n | 0).toString(16).padStart(2, "0"); return this.setValue("#" + x(c.r) + x(c.g) + x(c.b)); }
    getValueHsl() { return { h: 0, s: 0, l: 0 }; }
    setValueHsl() { return this; }
    onChange(cb) { this._cb = cb; return this; }
  }
  class ButtonComponent extends BaseComponent {
    constructor(containerEl) { super(); installDom(); this.buttonEl = containerEl.createEl("button"); this._cb = null; this.buttonEl.addEventListener("click", e => { if (!this.disabled && this._cb) this._cb(e); }); }
    setDisabled(d) { super.setDisabled(d); this.buttonEl.disabled = !!d; return this; }
    setCta() { this.buttonEl.addClass("mod-cta"); return this; }
    removeCta() { this.buttonEl.removeClass("mod-cta"); return this; }
    setWarning() { this.buttonEl.addClass("mod-warning"); return this; }
    setTooltip(t) { this.buttonEl.setAttribute("aria-label", t); this.buttonEl.title = t; return this; }
    setButtonText(t) { this.buttonEl.textContent = t; return this; }
    setIcon(i) { setIcon(this.buttonEl, i); return this; }
    setClass(c) { this.buttonEl.addClass(c); return this; }
    onClick(cb) { this._cb = cb; return this; }
  }
  class ExtraButtonComponent extends BaseComponent {
    constructor(containerEl) { super(); installDom(); this.extraSettingsEl = containerEl.createDiv({ cls: "clickable-icon extra-setting-button" }); this._cb = null; this.extraSettingsEl.addEventListener("click", () => { if (!this.disabled && this._cb) this._cb(); }); }
    setDisabled(d) { super.setDisabled(d); this.extraSettingsEl.toggleClass("is-disabled", !!d); return this; }
    setTooltip(t) { this.extraSettingsEl.setAttribute("aria-label", t); this.extraSettingsEl.title = t; return this; }
    setIcon(i) { setIcon(this.extraSettingsEl, i); return this; }
    onClick(cb) { this._cb = cb; return this; }
  }
  class Setting {
    constructor(containerEl) {
      installDom();
      this.settingEl = containerEl.createDiv({ cls: "setting-item" });
      this.infoEl = this.settingEl.createDiv({ cls: "setting-item-info" });
      this.nameEl = this.infoEl.createDiv({ cls: "setting-item-name" });
      this.descEl = this.infoEl.createDiv({ cls: "setting-item-description" });
      this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
      this.components = [];
    }
    setName(n) { this.nameEl.setText(n); return this; }
    setDesc(d) { this.descEl.setText(d); return this; }
    setClass(c) { this.settingEl.addClass(c); return this; }
    setTooltip(t) { this.nameEl.title = t; return this; }
    setHeading() { this.settingEl.addClass("setting-item-heading"); return this; }
    setDisabled(d) { this.settingEl.toggleClass("is-disabled", !!d); for (const c of this.components) c.setDisabled && c.setDisabled(d); return this; }
    _add(C, cb) { const c = new C(this.controlEl); this.components.push(c); if (cb) cb(c); return this; }
    addButton(cb) { return this._add(ButtonComponent, cb); }
    addExtraButton(cb) { return this._add(ExtraButtonComponent, cb); }
    addToggle(cb) { return this._add(ToggleComponent, cb); }
    addText(cb) { return this._add(TextComponent, cb); }
    addSearch(cb) { return this._add(SearchComponent, cb); }
    addTextArea(cb) { return this._add(TextAreaComponent, cb); }
    addMomentFormat(cb) { return this._add(MomentFormatComponent, cb); }
    addDropdown(cb) { return this._add(DropdownComponent, cb); }
    addColorPicker(cb) { return this._add(ColorComponent, cb); }
    addSlider(cb) { return this._add(SliderComponent, cb); }
    then(cb) { cb(this); return this; }
    clear() { this.controlEl.empty(); this.components = []; return this; }
  }
  class SettingTab {
    constructor() { installDom(); this.containerEl = mk("div", { cls: "vertical-tab-content" }); }
    display() {}
    hide() { this.containerEl.empty(); }
  }
  class PluginSettingTab extends SettingTab {
    constructor(app, plugin) { super(); this.app = app; this.plugin = plugin; }
  }

  /* -------------------------------------------------------------- Menu
     Shown through main.js's own context-menu machine (placeMenu/closeMenu),
     so a plugin menu looks like ours and publishes the same [menu:] census. */
  class MenuItem {
    constructor(menu) {
      this.menu = menu;
      this.dom = document.createElement("div");
      this.dom.className = "menu-item";
      this.iconEl = document.createElement("span"); this.iconEl.className = "menu-item-icon";
      this.titleEl = document.createElement("span"); this.titleEl.className = "menu-item-title";
      this.dom.append(this.iconEl, this.titleEl);
      this.callback = null; this.section = "";
      this.dom.onmousedown = e => e.stopPropagation();
      this.dom.onclick = e => { if (this.disabled) return; menu.hide(); if (this.callback) try { this.callback(e); } catch (er) { console.error("[plugin] menu item:", er); } };
    }
    setTitle(t) { if (t instanceof Node) { this.titleEl.textContent = ""; this.titleEl.appendChild(t); } else this.titleEl.textContent = t; return this; }
    setIcon(i) { if (i) setIcon(this.iconEl, i); else this.iconEl.textContent = ""; return this; }
    setChecked(c) { this.dom.classList.toggle("mod-checked", !!c); return this; }
    setDisabled(d) { this.disabled = !!d; this.dom.classList.toggle("dis", !!d); return this; }
    setIsLabel(l) { this.dom.classList.toggle("is-label", !!l); return this; }
    setWarning(w) { this.dom.classList.toggle("mod-warning", !!w); return this; }
    setSection(s) { this.section = s; return this; }
    onClick(cb) { this.callback = cb; return this; }
    setSubmenu() { return new Menu(); }
  }
  class Menu extends Component {
    constructor() { super(); this.items = []; this._hide = []; this.dom = null; }
    setNoIcon() { return this; }
    setUseNativeMenu() { return this; }
    addItem(cb) { const it = new MenuItem(this); this.items.push(it); cb(it); return this; }
    addSeparator() { this.items.push(null); return this; }
    showAtMouseEvent(e) { return this.showAtPosition({ x: e.clientX, y: e.clientY }); }
    showAtPosition(p) {
      installDom();
      if (typeof closeMenu === "function") closeMenu();
      const m = document.createElement("div");
      m.className = "ctxmenu menu os-plugin-menu";
      for (const it of this.items) {
        if (it === null) { const s = document.createElement("div"); s.className = "sep"; m.appendChild(s); }
        else m.appendChild(it.dom);
      }
      this.dom = m;
      if (typeof placeMenu === "function") placeMenu(m, p.x, p.y);
      else { m.style.left = p.x + "px"; m.style.top = p.y + "px"; document.body.appendChild(m); }
      this.load();
      // main.js closes menus from its document mousedown / Escape; notice that
      const watch = () => { if (this.dom && !this.dom.isConnected) this._closed(); };
      this._mo = new MutationObserver(watch); this._mo.observe(document.body, { childList: true });
      return this;
    }
    _closed() { if (this._mo) this._mo.disconnect(); this._mo = null; const d = this.dom; this.dom = null; if (!d) return; this.unload(); for (const f of this._hide.splice(0)) try { f(); } catch (e) { console.error(e); } }
    hide() { if (this.dom && typeof closeMenu === "function" && typeof menuEl !== "undefined" && menuEl === this.dom) closeMenu(); else if (this.dom) this.dom.remove(); this._closed(); }
    close() { this.hide(); }
    onHide(cb) { this._hide.push(cb); }
    static forEvent(e) { const m = new Menu(); m._evt = e; return m; }
  }

  /* --------------------------------------------- views (ui/plugins/views.js)
     View / ItemView / FileView / WorkspaceLeaf live in views.js (goal
     plugin-views). Its factory is taken ONCE here and removed from window, so
     plugin code cannot reach it; its deps are read at call time. */
  const viewsFactory = window.__osPluginViews;
  try { delete window.__osPluginViews; } catch (_) {}
  if (typeof viewsFactory !== "function") { console.error("[plugin] views.js did not load"); return; }
  const { View, ItemView, FileView, EditableFileView, TextFileView, WorkspaceLeaf, host: views } = viewsFactory({
    Component, Events, installDom, mk, setIcon, app: () => app, touch: () => touch(),
    vault: () => vault, TFile: () => TFile,
    leafView: l => leafView(l), groupFile: g => groupFile(g), openFileIn: (l, f, o) => openFileIn(l, f, o),
  });
  class MarkdownView extends TextFileView { getViewType() { return "markdown"; } }
  class MarkdownRenderChild extends Component { constructor(el) { super(); this.containerEl = el; } }
  class TAbstractFile { constructor() { this.vault = null; this.path = ""; this.name = ""; this.parent = null; } }
  class TFile extends TAbstractFile { constructor() { super(); this.basename = ""; this.extension = ""; this.stat = { ctime: 0, mtime: 0, size: 0 }; } }
  class TFolder extends TAbstractFile { constructor() { super(); this.children = []; } isRoot() { return this.path === "/" || this.path === ""; } }

  /* --------------------------------------------- app + plugin registry */
  const registry = new Map();      // id -> {plugin, manifest, cmds:Set, ribbon:Set, status:Set, tabs:Set, styleEl}
  let manifests = {};              // id -> manifest (installed)
  let enabledIds = [];             // .obsidian/community-plugins.json order
  let trusted = false;
  let layoutReady = false;
  const bridge = { editor: null };
  const statusBox = () => {
    let b = document.getElementById("os-plugin-statusbar");
    if (!b) { b = document.createElement("div"); b.id = "os-plugin-statusbar"; b.className = "status-bar os-plugin-statusbar"; document.body.appendChild(b); }
    return b;
  };

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
  let vaultName = "", modelOn = false, modelP = null, unlisten = null;
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
    if (!modelOn || !c) return;
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
      if (!("app" in window)) Object.defineProperty(window, "app", { value: app, configurable: true, enumerable: false, writable: false });
      await buildModel();
      modelOn = true;
      if (!unlisten && be.listen) unlisten = await be.listen("vault-changed", e => applyChange(e.payload));
      sweep();
    })().catch(e => { modelP = null; throw e; });
    return modelP;
  }
  function loadMoment() {
    if (window.moment) return Promise.resolve();
    return new Promise(res => {
      const s = document.createElement("script");
      s.src = "vendor/moment.min.js"; s.onload = s.onerror = () => res();
      document.head.appendChild(s);
    });
  }

  const vault = new Events();
  Object.assign(vault, {
    configDir: ".obsidian",
    getName() { return vaultName; },
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
    adapter: {
      getName() { return vaultName; },
      async exists(p) { return !!vault.getAbstractFileByPath(p); },
      async read(p) { const f = vault.getFileByPath(p); if (!f) throw new Error("ENOENT: " + p); return vault.read(f); },
      async write(p, s) { const f = vault.getFileByPath(p); return f ? vault.modify(f, s) : vault.create(p, s); },
    },
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
  function parseScalar(v) {
    v = v.trim();
    if (!v) return null;
    if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) return v.slice(1, -1);
    if (v[0] === "[" && v.endsWith("]")) return v.slice(1, -1).split(",").map(x => parseScalar(x)).filter(x => x !== null);
    if (/^(true|false)$/i.test(v)) return /^true$/i.test(v);
    if (/^(null|~)$/i.test(v)) return null;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return v;
  }
  function parseYaml(src) {   // the frontmatter subset: key: scalar | [a, b] | block list
    const o = {}; let key = null;
    for (const raw of String(src).split("\n")) {
      const l = raw.replace(/\r$/, "");
      if (!l.trim() || /^\s*#/.test(l)) continue;
      let m;
      if (key && (m = l.match(/^\s*-\s*(.*)$/))) { if (!Array.isArray(o[key])) o[key] = []; const v = parseScalar(m[1]); if (v !== null) o[key].push(v); continue; }
      if ((m = l.match(/^([^\s:#][^:]*?)\s*:(?:\s+(.*))?$/))) { key = m[1].trim(); o[key] = parseScalar(m[2] || ""); continue; }
    }
    return o;
  }
  const stringifyYaml = o => Object.keys(o || {}).map(k => k + ": " + (Array.isArray(o[k]) ? "[" + o[k].join(", ") + "]" : o[k] == null ? "" : String(o[k]))).join("\n") + "\n";
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
  function getAllTags(c) {
    if (!c) return null;
    const t = (c.tags || []).map(x => x.tag);
    const ft = c.frontmatter ? parseFrontMatterTags(c.frontmatter) : null;
    return (ft || []).concat(t);
  }
  const parseLinktext = lt => { const s = String(lt), i = s.indexOf("#"); return i < 0 ? { path: s, subpath: "" } : { path: s.slice(0, i), subpath: s.slice(i) }; };
  const getLinkpath = lt => parseLinktext(lt).path;
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

  /* ------------------------------------------- workspace (item 5)
     Leaves are the app's tab groups (main.js `groups()` / `state.focused`),
     read at call time. file-open / active-leaf-change are detected by
     focusTick(), which the [plg:] census runs on every updateTitle — the one
     place main.js already reports "something on screen changed" — so this
     needs no new hook in main.js. */
  const leafOf = new WeakMap();
  const groupLeaf = g => { if (!g) return null; let l = leafOf.get(g); if (!l) { l = new WorkspaceLeaf(app); l._g = g; leafOf.set(g, l); } return l; };
  const leafFor = g => (g ? views.leafOfGroup(g, groupLeaf) : null);   // plugin-views: a plugin-view tab is its own leaf
  const allGroups = () => { try { return typeof groups === "function" ? groups() : []; } catch (_) { return []; } };
  const focusedGroup = () => { try { return typeof state !== "undefined" && state ? state.focused : null; } catch (_) { return null; } };
  function groupFile(g) {
    const t = g && g.active >= 0 ? g.tabs[g.active] : null;
    if (!t || t.kind || !modelOn) return null;
    const f = files.get(t.name + ".md");
    return f instanceof TFile ? f : null;
  }
  function leafView(l) {
    const f = groupFile(l._g);
    if (!l._v) {
      const mv = new MarkdownView(l); Object.defineProperty(mv, "file", { configurable: true, get: () => groupFile(l._g) });
      const ev = new View(l); ev.getViewType = () => "empty";
      l._v = { mv, ev };
    }
    return f ? l._v.mv : l._v.ev;
  }
  async function openFileIn(leaf, file, openState) {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    const name = noteOf(file.path), g = leaf && leaf._g;
    if (g && g !== focusedGroup() && typeof focusGroup === "function") try { focusGroup(g); } catch (_) {}
    if (leaf && leaf._split && g && typeof splitWith === "function" && typeof mkTab === "function") { const d0 = leaf._split; leaf._split = null; await splitWith(g, d0, mkTab(name)); }
    else if (leaf && leaf._nt && typeof openNewTab === "function") { leaf._nt = false; await openNewTab(name, g || undefined); }
    else if (typeof openInTab === "function") await openInTab(name);
    const sub = openState && openState.eState && openState.eState.subpath;
    if (sub && typeof navAnchor === "function") try { await navAnchor(focusedGroup(), sub.replace(/^#/, "")); } catch (_) {}
    touch();
  }
  let lastLeaf = null, lastFile;
  function focusTick() {
    views.sweep();                       // plugin-views: a plugin-view tab the app closed -> its view closes
    if (!modelOn || !layoutReady) return;
    const l = leafFor(focusedGroup()), f = l ? groupFile(l._g) : null;
    if (l !== lastLeaf) { lastLeaf = l; queueMicrotask(() => workspace.trigger("active-leaf-change", l)); }
    if (f !== lastFile) { lastFile = f; queueMicrotask(() => { workspace.trigger("file-open", f); if (l) workspace.trigger("layout-change"); }); }
  }
  const workspace = new Events();
  Object.assign(workspace, {
    layoutReady: false,
    containerEl: document.body,
    onLayoutReady(cb) { if (layoutReady) queueMicrotask(() => { try { cb(); } catch (e) { console.error(e); } }); else workspace.on("layout-ready", cb); },
    iterateAllLeaves(cb) { views.iterateLeaves(cb, groupLeaf, true); },
    iterateRootLeaves(cb) { views.iterateLeaves(cb, groupLeaf, false); },
    getLeavesOfType(t) { const pv = views.leavesOfType(t); if (pv.length || views.types.has(t)) return pv; return allGroups().map(groupLeaf).filter(l => l && l.view.getViewType() === t); },
    detachLeavesOfType(t) { for (const l of views.leavesOfType(t)) l.detach(); },
    getRightLeaf() { return views.getSideLeaf("right"); },
    getLeftLeaf() { return views.getSideLeaf("left"); },
    async ensureSideLeaf(type, side, o) {
      o = o || {}; let l = views.leavesOfType(type)[0];
      if (!l) { l = views.getSideLeaf(side === "left" ? "left" : "right"); await l.setViewState({ type, state: o.state || {}, active: !!o.active }); }
      if (o.reveal !== false) await views.reveal(l);
      return l;
    },
    getActiveViewOfType(C) { const l = workspace.activeLeaf, v = l && l.view; return v && C && v instanceof C ? v : null; },
    getActiveFile() { return groupFile(focusedGroup()); },
    getMostRecentLeaf() { return workspace.activeLeaf; },
    getUnpinnedLeaf() { return workspace.activeLeaf; },
    getLeaf(newLeaf, dir) { if (!newLeaf) return workspace.activeLeaf; return views.getLeaf(newLeaf, dir) || workspace.activeLeaf; },
    splitActiveLeaf(dir) { return workspace.getLeaf("split", dir); },
    createLeafBySplit(leaf, dir) { return workspace.getLeaf("split", dir); },
    createLeafInParent() { return workspace.getLeaf("tab"); },
    setActiveLeaf(l) { if (l && (l._t || l._side)) { views.reveal(l); return; } if (l && l._g && typeof focusGroup === "function") try { focusGroup(l._g); } catch (_) {} },
    revealLeaf(l) { if (l && (l._t || l._side)) return views.reveal(l); workspace.setActiveLeaf(l); return Promise.resolve(); },
    async openLinkText(lt, src, newLeaf, openState) {
      const { path, subpath } = parseLinktext(lt);
      let f = path ? resolveLink(path, src) : vault.getFileByPath(src || "");
      if (!f) f = await vault.create(normalizePath(path.endsWith(".md") ? path : path + ".md"), "");
      const os = Object.assign({}, openState || {}); if (subpath) os.eState = Object.assign({}, os.eState, { subpath });
      return workspace.getLeaf(newLeaf).openFile(f, os);
    },
    getLastOpenFiles() { return []; },
    requestSaveLayout: debounce(() => {}, 0),
    leftRibbon: {
      collapsed: false,
      get ribbonItemsEl() { return document.getElementById("ribbon"); },
      // read-only view of plugin ribbon icons (cmdr's "Left Ribbon" tab maps it); a copy, so remove() on it can't detach app buttons
      get items() { return [...document.querySelectorAll("#ribbon .os-plugin-ribbon")].map(b => ({ id: (b.dataset.plugin || "") + ":" + b.title, title: b.title, icon: (b.firstElementChild && b.firstElementChild.dataset.icon) || "", buttonEl: b })); },
    },
    rightRibbon: { collapsed: false },
  });
  /* plugin-views item 5: workspace "file-menu" / "editor-menu". main.js builds its
     own .ctxmenu (noteMenu: the explorer row) and asks PMENU before placing it; a
     plugin's handler gets a Menu whose rows land in THAT menu after a rule, so they
     share its styling, its close-on-mousedown and its [menu:] census. Nothing is
     added — not even the rule — when no handler adds a row. "editor-menu" opens a
     menu of plugin rows only, and only once bridge.editor yields an Editor. */
  function menuHook(name, m, args) {
    const a = workspace._ev.get(name);
    if (!a || !a.length) return 0;
    const menu = new Menu(); menu.dom = m;
    workspace.trigger(name, menu, ...args);
    const it = menu.items.slice();
    while (it.length && it[0] === null) it.shift();
    while (it.length && it[it.length - 1] === null) it.pop();
    const n = it.filter(Boolean).length;
    if (!n) return 0;
    if (m.childElementCount) { const s = document.createElement("div"); s.className = "sep"; m.appendChild(s); }
    for (const x of it) {
      if (x === null) { const s = document.createElement("div"); s.className = "sep"; m.appendChild(s); }
      else m.appendChild(x.dom);
    }
    return n;
  }
  const PM = {
    fileMenu(m, name, source) {
      const f = files.get(name + ".md");
      return f instanceof TFile ? menuHook("file-menu", m, [f, source || "file-explorer-context-menu", null]) : 0;
    },
    editorMenu(e) {
      const x = bridge.editor ? bridge.editor() : null;
      if (!x || !x.editor) return false;
      const m = document.createElement("div");
      m.className = "ctxmenu menu os-plugin-menu";
      if (!menuHook("editor-menu", m, [x.editor, x.view])) return false;
      if (typeof closeMenu === "function") closeMenu();
      if (typeof placeMenu === "function") placeMenu(m, e.clientX, e.clientY);
      return true;
    },
  };
  const menuOn = workspace.on;
  workspace.on = function (name, cb, ctx) {   // main.js's PMENU is set lazily: api.js loads before main.js declares it
    if (name === "file-menu" || name === "editor-menu") try { PMENU = PM; } catch (_) {}
    return menuOn.call(this, name, cb, ctx);
  };
  Object.defineProperty(workspace, "activeLeaf", { configurable: true, enumerable: true, get() {
    const g = focusedGroup() || allGroups()[0];
    return g ? leafFor(g) : null;
  } });
  const keymap = {
    pushScope(s) { if (s) scopes.push(s); },
    popScope(s) { const i = scopes.lastIndexOf(s); if (i >= 0) scopes.splice(i, 1); },
  };
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
    removeCommand(id) { removeCmd(id); },
    addCommand(cmd) { return addCmd(null, cmd); },
  };
  const plugins = {
    get manifests() { return Object.assign({}, manifests); },
    get plugins() { const o = {}; for (const [id, r] of registry) o[id] = r.plugin; return o; },
    get enabledPlugins() { return new Set(registry.keys()); },
    getPlugin(id) { const r = registry.get(id); return r ? r.plugin : null; },
    isEnabled() { return trusted; },
    enablePlugin: id => enable(id), disablePlugin: id => disable(id),
    enablePluginAndSave: id => setEnabled(id, true), disablePluginAndSave: id => setEnabled(id, false),
  };
  const tabsChanged = () => { const s = window.__osPluginSettings; if (s) try { s.tabsChanged(); } catch (e) { console.error(e); } };
  const setting = {   // Settings modal hook — ui/plugins/settings.js renders the tabs (item 6)
    activeTab: null, pluginTabs: [],
    open() { if (typeof openSettings === "function" && typeof settingsOpen !== "undefined" && !settingsOpen) openSettings(); },
    close() { if (typeof closeSettings === "function") closeSettings(); },
    openTabById(id) { if (typeof openPluginSettingTab === "function") return openPluginSettingTab(id); setting.open(); },
    closeActiveTab() { if (setting.activeTab) { try { setting.activeTab.hide(); } catch (_) {} setting.activeTab = null; } },
    addSettingTab(t) { setting.pluginTabs.push(t); tabsChanged(); },
    removeSettingTab(t) { const i = setting.pluginTabs.indexOf(t); if (i >= 0) { setting.pluginTabs.splice(i, 1); tabsChanged(); } },
  };
  const app = {
    appId: "",
    vault, workspace, metadataCache, keymap, commands, plugins, setting,
    scope: new Scope(),
    internalPlugins: { getPluginById() { return null; }, getEnabledPluginById() { return null; }, plugins: {} },
    statusBar: { get containerEl() { return statusBox(); } },
    dom: { get appContainerEl() { return document.body; } },
    lastEvent: null,
    isMobile: false,
    loadLocalStorage(k) { try { const v = localStorage.getItem(app.appId + "-" + k); return v == null ? null : JSON.parse(v); } catch (_) { return null; } },
    saveLocalStorage(k, v) { try { if (v == null) localStorage.removeItem(app.appId + "-" + k); else localStorage.setItem(app.appId + "-" + k, JSON.stringify(v)); } catch (_) {} },
  };
  class App {}   // typings expose App as a class; plugins only ever receive `app`
  Object.setPrototypeOf(app, App.prototype);

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
    registerMarkdownPostProcessor(p) { return p; }
    registerMarkdownCodeBlockProcessor(lang, p) { return p; }
    registerEditorExtension() { console.warn("[plugin] " + this.manifest.id + ": registerEditorExtension — editor extensions not supported yet"); }
    registerEditorSuggest() {}
    registerObsidianProtocolHandler() {}
    registerCliHandler() {}
  }

  /* ---------------------------------------------------- the API object
     ES5-callable classes: a TypeScript-to-ES5 bundle (the pinned sample-plugin
     1.0.0 is one) subclasses with  `_super.apply(this, arguments) || this`, and an
     ES6 class throws when called without `new`. Every exported class is a plain
     function F sharing the class's prototype: `new`/`super()` (new.target set) and
     the ES5 call (new.target unset: construct for this.constructor and RETURN it,
     which the ES5 pattern adopts as `_this`) both run the real constructor, and
     `instanceof` is unchanged (F.prototype === Cls.prototype). */
  function es5(Cls) {
    const F = function (...args) {
      const nt = new.target || (this && this.constructor) || F;
      return Reflect.construct(Cls, args, nt === F ? Cls : nt);
    };
    Object.defineProperty(F, "name", { value: Cls.name });
    F.prototype = Cls.prototype;
    Object.setPrototypeOf(F, Cls);           // statics (Menu.forEvent) inherit
    return F;
  }
  const X = {
    Events, Component, Plugin, App, Notice, Modal, SuggestModal, FuzzySuggestModal, Scope,
    Setting, SettingTab, PluginSettingTab, BaseComponent, ValueComponent, AbstractTextComponent,
    TextComponent, SearchComponent, TextAreaComponent, MomentFormatComponent, ToggleComponent,
    DropdownComponent, SliderComponent, ColorComponent, ButtonComponent, ExtraButtonComponent,
    Menu, MenuItem, View, ItemView, FileView, EditableFileView, TextFileView, MarkdownView,
    WorkspaceLeaf, MarkdownRenderChild, TAbstractFile, TFile, TFolder,
  };
  for (const k of Object.keys(X)) X[k] = es5(X[k]);
  Object.assign(X, {
    Platform, apiVersion: API_VERSION, requireApiVersion, setIcon, getIcon, addIcon, removeIcon, getIconIds,
    normalizePath, debounce, prepareFuzzySearch, prepareSimpleSearch, renderMatches,
    parseFrontMatterEntry, parseFrontMatterAliases, parseFrontMatterTags, requestUrl, request: requestUrl,
    htmlToMarkdown, sanitizeHTMLToDom: h => { const t = document.createElement("template"); t.innerHTML = String(h); for (const s of t.content.querySelectorAll("script,iframe,object,embed")) s.remove(); return t.content; },
    Keymap: { isModEvent: e => !!(e && (e.ctrlKey || e.metaKey)), isModifier: (e, m) => !!e && ({ Mod: e.ctrlKey || e.metaKey, Ctrl: e.ctrlKey, Meta: e.metaKey, Shift: e.shiftKey, Alt: e.altKey })[m] },
    parseYaml, stringifyYaml, getAllTags, parseLinktext, getLinkpath,
  });
  // moment: the vendored build, loaded by ensureModel() before any plugin is evaluated.
  // A getter, so esbuild's __toESM live bindings and `obsidian.moment` both see it.
  Object.defineProperty(X, "moment", { enumerable: true, get: () => window.moment });
  const api = Object.freeze(X);

  /* ------------------------------------------------------ the manager */
  let touchT = 0;
  function touch() { if (touchT) return; touchT = requestAnimationFrame(() => { touchT = 0; if (typeof updateTitle === "function") try { updateTitle(); } catch (_) {} }); }

  async function enable(id) {
    if (registry.has(id)) return { ok: true, id };
    if (!trusted) return host.fail(id, new Error("restricted mode is on"));
    const manifest = manifests[id];
    if (!manifest) return host.fail(id, new Error("not installed (no manifest.json)"));
    installDom();
    try { await ensureModel(); } catch (e) { touch(); return host.fail(id, new Error("vault model: " + (e && e.message || e))); }
    const r = await host.evaluate(id);
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
    trusted = !!s.trusted;
    enabledIds = (s.enabled || []).slice();
    manifests = {};
    for (const p of s.installed || []) if (p && p.id && p.manifest) manifests[p.id] = p.manifest;
    return s;
  }
  async function setEnabled(id, on) {
    await be.set({ id, on: !!on });
    await refresh();
    if (!trusted) { touch(); return { ok: true, id }; }   // restricted: the choice is saved, nothing runs
    return on ? enable(id) : disable(id);
  }
  async function setRestricted(restricted) {
    await be.set({ trusted: !restricted });
    await refresh();
    if (restricted) for (const id of [...registry.keys()]) disable(id);
    else for (const id of enabledIds) await enable(id);
    touch();
  }
  /* boot: called by main.js once the vault is entered. Restricted mode (the
     default) = one plugins_state call and nothing else: no prototype touched,
     no plugin script requested. */
  async function boot(vaultPathArg) {
    try {
      vaultName = String(vaultPathArg || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
      app.appId = String(vaultPathArg || "").split("").reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7).toString(16);
      await refresh();
      layoutReady = true; workspace.layoutReady = true;
      if (trusted) for (const id of enabledIds) await enable(id);
      workspace.trigger("layout-ready");
    } catch (e) { console.error("[plugin] boot:", e); }
    touch();
  }
  /* [plg:] census: restricted flag, per plugin state, and what is registered
     right now — cmds / ribbon / status / tabs counts summed over loaded
     plugins, so an unload phase can assert they drop to 0. */
  function censusTok() {
    if (modelOn) focusTick();   // file-open / active-leaf-change detection (workspace section)
    if (!be || (!trusted && !host.status.size)) return trusted ? "" : " [plg:R]";
    let c = 0, rb = 0, st = 0, tb = 0;
    for (const r of registry.values()) { c += r.cmds.size; rb += r.ribbon.size; st += r.status.size; tb += r.tabs.size; }
    // a failed plugin carries its error (first 80 chars, census-safe) so a red phase says WHY
    const ids = [...host.status].map(([id, s]) => id + "=" + s.state + (s.state === "failed" && s.error ? "(" + String(s.error).replace(/[[\]|,=()\s]+/g, "_").slice(0, 80) + ")" : "")).join(",");
    const nt = notices.length ? " [pnotice:" + notices.map(n => n.noticeEl.textContent.replace(/[[\]|]/g, "").slice(0, 60)).join("|") + "]" : "";
    const md = openModals.length ? " [pmodal:" + openModals.length + "]" : "";
    return " [plg:" + (trusted ? "T" : "R") + "|" + ids + "] [preg:c" + c + ",r" + rb + ",s" + st + ",t" + tb + "]" + nt + md + views.censusTok();
  }

  host.api = api;
  Object.assign(host, {
    app, boot, enable, disable, setEnabled, setRestricted, refresh, censusTok,
    tabs: () => setting.pluginTabs.slice(),
    state: () => ({ trusted, enabled: enabledIds.slice(), installed: Object.assign({}, manifests), loaded: [...registry.keys()] }),
    bridge,         // NOT frozen (freeze is shallow): item 5 sets bridge.editor = () => {editor, view} | null
  });
  Object.freeze(host);
})();
