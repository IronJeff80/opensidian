// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* the "obsidian" module, part FNS / DOM (api-parity stage 0: split out of
   api.js, behaviour-neutral): Obsidian's global DOM helpers (createEl,
   createDiv, empty, setText, addClass, ...) installed LAZILY by installDom(),
   when the first plugin is evaluated, plus mk() / applyInfo().
   Segment contract: see api-core.js. */
(function () {
  "use strict";
  const parts = window.__osApiParts || (window.__osApiParts = Object.create(null));
  const reg = (id, fn) => { if (!(id in parts)) parts[id] = fn; };
  reg("dom:helpers", function (K) {
    const { host, be } = K;
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
      /* delegated listeners: on(type, selector, listener, options) calls
         listener.call(this, event, matchedElement) for events whose target is
         inside an element matching selector (within this); the registrations
         live on this._EVENTS[type] so off() can find the wrapper again. */
      const capt = o => !!(o === true || (o && typeof o === "object" && o.capture));
      const delegOn = function (type, sel, listener, opts) {
        const self = this;
        const fn = function (ev) {
          let t = ev.target; if (t && t.nodeType !== 1) t = t.parentElement;
          const m = t && t.closest ? t.closest(sel) : null;
          if (m && (m === self || self.contains(m))) listener.call(self, ev, m);
        };
        const E = Object.prototype.hasOwnProperty.call(this, "_EVENTS") && this._EVENTS ? this._EVENTS : (this._EVENTS = {});
        (E[type] || (E[type] = [])).push({ selector: sel, listener, options: opts, callback: fn });
        this.addEventListener(type, fn, opts);
      };
      const delegOff = function (type, sel, listener, opts) {
        const E = Object.prototype.hasOwnProperty.call(this, "_EVENTS") ? this._EVENTS : null, l = E && E[type];
        if (!l) return;
        for (let i = l.length - 1; i >= 0; i--) {
          const r = l[i];
          if (r.selector === sel && r.listener === listener && capt(r.options) === capt(opts)) {
            this.removeEventListener(type, r.callback, opts); l.splice(i, 1);
          }
        }
        if (!l.length) delete E[type];
      };
      for (const proto of [H, Document.prototype]) {
        def(proto, "_EVENTS", undefined);     // declared on the type, set per object by the first on()
        def(proto, "on", delegOn);
        def(proto, "off", delegOff);
      }
      def(SVGElement.prototype, "setCssStyles", H.setCssStyles);
      def(SVGElement.prototype, "setCssProps", H.setCssProps);
      def(String.prototype, "format", function (...args) {
        return String(this).replace(/\{(\d+)\}/g, (m, n) => (args[n] === undefined ? m : String(args[n])));
      });
      def(String, "isString", v => typeof v === "string" || v instanceof String);
      const U = UIEvent.prototype;
      defGet(U, "targetNode", function () { const t = this.target; return t && typeof t.nodeType === "number" ? t : null; });
      defGet(U, "doc", function () { const t = this.targetNode; return (t && (t.nodeType === 9 ? t : t.ownerDocument)) || document; });
      defGet(U, "win", function () { return this.doc.defaultView || window; });
      def(U, "instanceOf", function (type) { return this instanceof type; });
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
      /* XMLHttpRequest helpers. ajax({method, url, success, error, data,
         headers, withCredentials, req}); a plain-object body is sent as JSON.
         The app's CSP (connect-src) still decides what may be reached: a
         refused request ends in error(), never in a silent success. */
      def(g, "ajax", function (o) {
        o = o || {};
        const req = o.req || new XMLHttpRequest();
        req.open(o.method || "GET", o.url, true);
        let body = o.data;
        if (body != null && typeof body === "object" && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)
            && !(body instanceof Blob) && !(body instanceof FormData) && !(body instanceof URLSearchParams)) {
          body = JSON.stringify(body); req.setRequestHeader("Content-Type", "application/json; charset=utf-8");
        }
        if (o.headers) for (const k of Object.keys(o.headers)) req.setRequestHeader(k, o.headers[k]);
        if (o.withCredentials) req.withCredentials = true;
        req.onload = () => {
          if (req.status >= 200 && req.status < 300) { if (o.success) o.success(req.response, req); }
          else if (o.error) o.error(new Error("HTTP " + req.status), req);
        };
        req.onerror = () => { if (o.error) o.error(new Error("network error"), req); };
        req.send(body == null ? null : body);
      });
      def(g, "ajaxPromise", o => new Promise((res, rej) => g.ajax(Object.assign({}, o, {
        success: (r, req) => { if (o && o.success) o.success(r, req); res(r); },
        error: (e, req) => { if (o && o.error) o.error(e, req); rej(e); },
      }))));
      def(g, "ready", fn => {   // runs fn now when the document is already parsed, else at DOMContentLoaded
        if (document.readyState !== "loading") fn();
        else document.addEventListener("DOMContentLoaded", () => fn(), { once: true });
      });
      // fishing for append helpers on fragments too
      for (const n of ["createEl", "createDiv", "createSpan"]) def(DocumentFragment.prototype, n, Node.prototype[n]);
    }

    Object.assign(K, { installDom, mk });
  });
})();
