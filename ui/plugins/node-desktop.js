// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* cp-unrestricted (operator ruling 2026-10-18, stock parity): the Node surface
   EVERY plugin of a trusted vault gets. Plugin code only ever runs in a trusted
   vault (Rust serves no main.js otherwise, api-core enable() refuses), so the
   flip in Settings is the one grant: no per-plugin consent, no owner list.

   Loaded by index.html after node-modules.js and BEFORE api.js (which freezes
   the host); it registers host.desktopNode.view(id). loader.js makeRequire asks
   view.resolve(name) after the pure leaves (path) and the fs facade, and fills
   the factory's free variables (process, global, Buffer, Error, __filename,
   __dirname, SharedArrayBuffer; plugins.rs wrap_cjs) from the same view.

   The pure leaves below are ported from goal/td-desktop-caps ui/plugins/desktop.js
   (our own code): events, string_decoder, readline, util, url, http data,
   constants, Buffer, crypto (sha1/sha256/HMAC + CSPRNG), os, async_hooks,
   module.createRequire, tty, the process shim, a per-plugin global and Error
   with V8 stack-trace hooks. No per-owner branches: one view shape for every
   plugin. Function is the page's own: a trusted page has 'unsafe-eval'.
   A builtin with no member here yet (child_process, electron, net, http
   servers, ...) binds the inert stub of node-modules.js, which throws on use;
   ledger item 4 backs those with Rust commands gated on vault trust only. */
(function () {
  "use strict";
  const host = window.__osPluginHost;
  if (!host) return;
  const bare = n => (String(n).startsWith("node:") ? String(n).slice(5) : String(n));
  const later = f => Promise.resolve().then(f);
  const errOf = e => (e instanceof Error ? e : new Error(String(e && e.message || e)));
  const den = e => { const x = errOf(e); if (!x.code) x.code = "EACCES"; return x; };

  /* ------------------------------------------------ a pure EventEmitter */
  /* Listener maps live in a WeakMap keyed by the emitter and are created on
     first use, like Node's lazy _events: bundled express mixes the prototype
     into a plain function (app) and Node-style subclasses call
     EventEmitter.call(this), so the constructor may never run on the object. */
  const evs = new WeakMap();
  const evOf = o => { let m = evs.get(o); if (!m) { m = new Map(); evs.set(o, m); } return m; };
  class EmitterBase {
    on(n, f) { if (typeof f !== "function") return this; const e = evOf(this), l = e.get(n) || []; l.push({ f, once: false }); e.set(n, l); return this; }
    addListener(n, f) { return this.on(n, f); }
    prependListener(n, f) { if (typeof f !== "function") return this; const e = evOf(this), l = e.get(n) || []; l.unshift({ f, once: false }); e.set(n, l); return this; }
    once(n, f) { if (typeof f !== "function") return this; const e = evOf(this), l = e.get(n) || []; l.push({ f, once: true }); e.set(n, l); return this; }
    prependOnceListener(n, f) { if (typeof f !== "function") return this; const e = evOf(this), l = e.get(n) || []; l.unshift({ f, once: true }); e.set(n, l); return this; }
    off(n, f) { const l = evOf(this).get(n); if (l) { const i = l.findIndex(x => x.f === f); if (i >= 0) l.splice(i, 1); } return this; }
    removeListener(n, f) { return this.off(n, f); }
    removeAllListeners(n) { const e = evOf(this); if (n === undefined) e.clear(); else e.delete(n); return this; }
    listenerCount(n) { return (evOf(this).get(n) || []).length; }
    listeners(n) { return (evOf(this).get(n) || []).map(x => x.f); }
    rawListeners(n) { return this.listeners(n); }
    eventNames() { return [...evOf(this).keys()]; }
    setMaxListeners() { return this; }
    getMaxListeners() { return Infinity; }
    emit(n, ...a) {
      const l = evOf(this).get(n);
      if (!l || !l.length) { if (n === "error") throw errOf(a[0]); return false; }
      for (const x of [...l]) { if (x.once) this.off(n, x.f); try { x.f.apply(this, a); } catch (e) { console.error("[desktop] listener " + String(n) + ":", e); } }
      return true;
    }
  }
  /* callable like Node's: EventEmitter.call(this) initialises nothing (the map
     is lazy); a bare EventEmitter() call returns a new emitter */
  function Emitter() { if (this == null || (typeof this !== "object" && typeof this !== "function")) return new Emitter(); }
  Emitter.prototype = EmitterBase.prototype;
  Object.defineProperty(EmitterBase.prototype, "constructor", { value: Emitter, writable: true, configurable: true });
  Emitter.EventEmitter = Emitter;
  Emitter.defaultMaxListeners = 10;
  Emitter.once = (em, n) => new Promise((res, rej) => { em.once(n, (...a) => res(a)); if (n !== "error") em.once("error", rej); });
  /* Node's module-level helpers. realclaudian reads events.setMaxListeners at
     module scope (it wraps it once, guarded by a marker on the function) and
     the SDK calls it as setMaxListeners(n, signal); listeners are unbounded
     here, so it only accepts its arguments. */
  Emitter.setMaxListeners = function setMaxListeners() {};
  Emitter.getMaxListeners = () => Infinity;
  Emitter.listenerCount = (em, n) => (em && typeof em.listenerCount === "function" ? em.listenerCount(n) : 0);
  const eventsMod = Object.freeze(Emitter);

  /* string_decoder / readline: what the Claude SDK transport wraps the child's
     pipes in. Chunks here are already strings (the broker returns UTF-8 text). */
  class StringDecoder { constructor(enc) { this.encoding = enc || "utf8"; } write(c) { return c == null ? "" : String(c); } end(c) { return c == null ? "" : String(c); } }
  const stringDecoderMod = Object.freeze({ StringDecoder });

  class Lines extends Emitter {
    constructor(input) {
      super();
      this.closed = false; this.terminal = false; this.input = input;
      let buf = "";
      const q = [], waits = [];
      const push = line => { this.emit("line", line); if (waits.length) waits.shift()({ value: line, done: false }); else q.push(line); };
      const fin = () => { if (this.closed) return; if (buf) { const b = buf; buf = ""; push(b); } this.close(); };
      this._q = q; this._waits = waits;
      if (input && typeof input.on === "function") {
        input.on("data", c => { buf += String(c); let i; while ((i = buf.indexOf("\n")) >= 0) { let l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.endsWith("\r")) l = l.slice(0, -1); push(l); } });
        input.on("end", fin); input.on("close", fin);
      }
    }
    close() { if (this.closed) return; this.closed = true; while (this._waits.length) this._waits.shift()({ value: undefined, done: true }); this.emit("close"); }
    pause() { return this; }
    resume() { return this; }
    setPrompt() {}
    prompt() {}
    write() {}
    [Symbol.asyncIterator]() {
      return {
        next: () => (this._q.length ? Promise.resolve({ value: this._q.shift(), done: false }) : this.closed ? Promise.resolve({ value: undefined, done: true }) : new Promise(r => this._waits.push(r))),
        return: () => { this.close(); return Promise.resolve({ value: undefined, done: true }); },
        [Symbol.asyncIterator]() { return this; },
      };
    }
  }
  const readlineMod = Object.freeze({ createInterface: o => new Lines(o && typeof o === "object" && "input" in o ? o.input : o), Interface: Lines });

  /* util: the members the pinned zotero bundle's bundled libraries (execa, get-stream,
     readable-stream, fstream/unzip) touch, some at module scope (promisify(stream.pipeline),
     debuglog("stream"), debuglog("execa").enabled). Pure leaf: string formatting and
     function wrapping only, no I/O; promisify wraps without calling, so promisify(<stub>)
     still denies on use. Any other member is the inert deny stub (mod()). */
  const inspectCustom = Symbol.for("nodejs.util.inspect.custom");
  function inspect(v) {
    if (typeof v === "string") return "'" + v + "'";
    if (typeof v === "function") return "[Function: " + (v.name || "(anonymous)") + "]";
    if (v === null || typeof v !== "object") return String(v);
    if (v instanceof Error) return v.stack || String(v);
    try { return JSON.stringify(v); } catch (_) { return Object.prototype.toString.call(v); }
  }
  inspect.custom = inspectCustom;
  function format(f, ...a) {
    if (typeof f !== "string") return [f, ...a].map(x => (typeof x === "string" ? x : inspect(x))).join(" ");
    let i = 0;
    let s = f.replace(/%[sdifjoO%]/g, m => {
      if (m === "%%") return "%";
      if (i >= a.length) return m;
      const x = a[i++];
      if (m === "%s") return typeof x === "string" ? x : inspect(x);
      if (m === "%d" || m === "%i") return String(m === "%i" ? parseInt(x, 10) : Number(x));
      if (m === "%f") return String(parseFloat(x));
      if (m === "%j") { try { return JSON.stringify(x); } catch (_) { return "[Circular]"; } }
      return inspect(x);
    });
    for (; i < a.length; i++) s += " " + (typeof a[i] === "string" ? a[i] : inspect(a[i]));
    return s;
  }
  function promisify(fn) {
    if (typeof fn !== "function") throw new TypeError('The "original" argument must be of type function');
    return function (...a) { return new Promise((res, rej) => { fn.call(this, ...a, (e, ...r) => (e ? rej(e) : res(r.length > 1 ? r : r[0]))); }); };
  }
  function debuglog() { const f = () => {}; f.enabled = false; return f; }
  function inherits(ctor, sup) {
    if (typeof ctor !== "function" || typeof sup !== "function") throw new TypeError("inherits: ctor and superCtor must be functions");
    Object.defineProperty(ctor, "super_", { value: sup, writable: true, configurable: true });
    Object.setPrototypeOf(ctor.prototype, sup.prototype);
  }
  const utilOwn = { promisify, debuglog, debug: debuglog, format, inspect, inherits };
  // advanced slides: its bundled express/readable-stream/http-errors call util.inherits, debuglog and
  // format at module scope; callbackify wraps a promise-returning function (pure, never calls it early)
  function callbackify(fn) {
    if (typeof fn !== "function") throw new TypeError('The "original" argument must be of type function');
    return function (...a) { const cb = a.pop(); Promise.resolve().then(() => fn.apply(this, a)).then(v => cb(null, v), e => cb(e || new Error("callbackify: falsy rejection"))); };
  }
  const slidesUtilOwn = { promisify, callbackify, debuglog, debug: debuglog, format, inspect, inherits };

  /* url (slides only): its bundled express (parseurl, serve-static, send) parses the
     request URL of the in-process handler with the legacy url.parse/Url/format/resolve.
     Pure string work over WHATWG URL: no fileURLToPath/pathToFileURL (no host paths),
     no DNS, no I/O. A path-only string is split by hand (no dot-segment rewrite), as
     the legacy parser does, so send's own traversal check still sees the raw path. */
  function LegacyUrl() {
    this.protocol = null; this.slashes = null; this.auth = null; this.host = null; this.port = null; this.hostname = null;
    this.hash = null; this.search = null; this.query = null; this.pathname = null; this.path = null; this.href = null;
  }
  const qsObj = s => { const o = {}; for (const [k, v] of new URLSearchParams(s)) { if (Object.prototype.hasOwnProperty.call(o, k)) o[k] = [].concat(o[k], v); else o[k] = v; } return o; };
  function urlParse(s, parseQuery) {
    s = String(s).trim();
    const u = new LegacyUrl();
    let rest = s;
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(s)) {
      let w = null;
      try { w = new URL(s); } catch (_) { w = null; }
      if (w) {
        u.protocol = w.protocol; u.slashes = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(s) ? true : null;
        u.auth = w.username ? decodeURIComponent(w.username) + (w.password ? ":" + decodeURIComponent(w.password) : "") : null;
        u.host = w.host || null; u.hostname = w.hostname || null; u.port = w.port || null;
        rest = w.pathname + w.search + w.hash;
      }
    }
    const h = rest.indexOf("#"); if (h >= 0) { u.hash = rest.slice(h); rest = rest.slice(0, h); }
    const q = rest.indexOf("?");
    if (q >= 0) { u.search = rest.slice(q); u.query = rest.slice(q + 1); rest = rest.slice(0, q); }
    else if (parseQuery) { u.search = ""; u.query = {}; }
    if (parseQuery && typeof u.query === "string") u.query = qsObj(u.query);
    u.pathname = rest || (u.slashes ? "/" : null);
    u.path = (u.pathname || "") + (u.search || "") || null;
    u.href = urlFormat(u);
    return u;
  }
  function urlFormat(o) {
    if (typeof o === "string") o = urlParse(o);
    if (o instanceof URL) return o.href;
    if (!o || typeof o !== "object") return "";
    const proto = o.protocol ? (String(o.protocol).endsWith(":") ? String(o.protocol) : o.protocol + ":") : "";
    let host = "";
    if (o.host) host = String(o.host);
    else if (o.hostname) host = String(o.hostname) + (o.port ? ":" + o.port : "");
    const auth = o.auth ? encodeURIComponent(String(o.auth)).replace(/%3A/i, ":") + "@" : "";
    const slashes = o.slashes || /^(https?|ftp|file|wss?):$/.test(proto) ? "//" : "";
    let search = o.search != null ? String(o.search) : "";
    if (!search && o.query && typeof o.query === "object") { const p = new URLSearchParams(); for (const k of Object.keys(o.query)) for (const v of [].concat(o.query[k])) p.append(k, String(v)); const t = p.toString(); search = t ? "?" + t : ""; }
    if (search && search[0] !== "?") search = "?" + search;
    const hash = o.hash ? (String(o.hash)[0] === "#" ? String(o.hash) : "#" + o.hash) : "";
    return proto + (host || proto === "file:" ? slashes + auth + host : "") + (o.pathname != null ? String(o.pathname) : "") + search + hash;
  }
  function urlResolve(from, to) {
    const B = "http://opensidian.invalid";
    let r;
    try { r = new URL(String(to), new URL(String(from), B + "/")); } catch (_) { return String(to); }
    return r.origin === B ? r.pathname + r.search + r.hash : r.href;
  }
  const urlMod = Object.freeze({ Url: LegacyUrl, parse: urlParse, format: urlFormat, resolve: urlResolve, URL, URLSearchParams });

  /* http data members (Node 18 values, data only). Bundled express builds app[method] for
     every entry of http.METHODS at module scope, then app.del = depd.function(app.delete):
     with a 3-entry list app.delete was undefined and the slides load failed with "argument fn
     must be a function". No function, no reach: the request path is still the facade server. */
  const HTTP_METHODS = Object.freeze(["ACL", "BIND", "CHECKOUT", "CONNECT", "COPY", "DELETE", "GET", "HEAD", "LINK", "LOCK", "M-SEARCH", "MERGE",
    "MKACTIVITY", "MKCALENDAR", "MKCOL", "MOVE", "NOTIFY", "OPTIONS", "PATCH", "POST", "PROPFIND", "PROPPATCH", "PURGE", "PUT", "REBIND",
    "REPORT", "SEARCH", "SOURCE", "SUBSCRIBE", "TRACE", "UNBIND", "UNLINK", "UNLOCK", "UNSUBSCRIBE"]);
  const HTTP_STATUS = Object.freeze({ 100: "Continue", 101: "Switching Protocols", 102: "Processing", 103: "Early Hints", 200: "OK", 201: "Created",
    202: "Accepted", 203: "Non-Authoritative Information", 204: "No Content", 205: "Reset Content", 206: "Partial Content", 207: "Multi-Status",
    208: "Already Reported", 226: "IM Used", 300: "Multiple Choices", 301: "Moved Permanently", 302: "Found", 303: "See Other", 304: "Not Modified",
    305: "Use Proxy", 307: "Temporary Redirect", 308: "Permanent Redirect", 400: "Bad Request", 401: "Unauthorized", 402: "Payment Required",
    403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 406: "Not Acceptable", 407: "Proxy Authentication Required", 408: "Request Timeout",
    409: "Conflict", 410: "Gone", 411: "Length Required", 412: "Precondition Failed", 413: "Payload Too Large", 414: "URI Too Long",
    415: "Unsupported Media Type", 416: "Range Not Satisfiable", 417: "Expectation Failed", 418: "I'm a Teapot", 421: "Misdirected Request",
    422: "Unprocessable Entity", 423: "Locked", 424: "Failed Dependency", 425: "Too Early", 426: "Upgrade Required", 428: "Precondition Required",
    429: "Too Many Requests", 431: "Request Header Fields Too Large", 451: "Unavailable For Legal Reasons", 500: "Internal Server Error",
    501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout", 505: "HTTP Version Not Supported",
    506: "Variant Also Negotiates", 507: "Insufficient Storage", 508: "Loop Detected", 509: "Bandwidth Limit Exceeded", 510: "Not Extended",
    511: "Network Authentication Required" });

  /* `Error` for an owner (factory parameter, plugins.rs wrap_cjs_ctx). Bundled depd (express,
     body-parser) calls Error.captureStackTrace with a V8 prepareStackTrace and reads CallSite
     objects (getFileName, getLineNumber, ...) at module scope; WebKit ignores
     prepareStackTrace and leaves a string, so local-rest failed with "callSite.getFileName is
     not a function". This is the realm's Error behind a proxy: construct, call, instanceof,
     extends and prototype are the real ones; captureStackTrace / prepareStackTrace /
     stackTraceLimit are per owner (a plugin setting them never touches the page's Error) and
     CallSites are parsed from the engine's own stack string. Pure: no I/O, no new reach. */
  function ownError() {
    const E = Error;
    let prep, limit = 10;
    const extra = new Map();   // other writes land here, per owner
    const site = (fn, file, line, col) => Object.freeze({
      getFileName: () => file, getScriptNameOrSourceURL: () => file, getLineNumber: () => line, getColumnNumber: () => col,
      getFunctionName: () => fn || null, getMethodName: () => null, getTypeName: () => null, getThis: () => undefined,
      getFunction: () => undefined, getEvalOrigin: () => undefined, isEval: () => false, isNative: () => file === "[native code]",
      isToplevel: () => !fn, isConstructor: () => false, isAsync: () => false, isPromiseAll: () => false, getPromiseIndex: () => null,
      toString: () => { const at = file + (line != null ? ":" + line + (col != null ? ":" + col : "") : ""); return fn ? fn + " (" + at + ")" : at; },
    });
    const frames = raw => String(raw || "").split("\n").filter(Boolean).map(l => {
      const at = l.lastIndexOf("@"), fn = at < 0 ? "" : l.slice(0, at), loc = at < 0 ? l : l.slice(at + 1);
      const m = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(loc);
      return site(fn, m[1] || null, m[2] != null ? +m[2] : null, m[3] != null ? +m[3] : null);
    });
    function captureStackTrace(obj) {
      if (obj === null || (typeof obj !== "object" && typeof obj !== "function")) throw new TypeError("Error.captureStackTrace: the target must be an object");
      const n = Math.max(0, Math.floor(Number(limit)) || 0);
      const cs = frames(new E().stack).slice(1, 1 + n);   // [0] is this function
      let v;
      if (typeof prep === "function") v = prep(obj, cs);
      else { let h; try { h = E.prototype.toString.call(obj); } catch (_) { h = "Error"; } v = h + cs.map(c => "\n    at " + c.toString()).join(""); }
      Object.defineProperty(obj, "stack", { value: v, writable: true, configurable: true, enumerable: false });
    }
    return new Proxy(E, {
      get(o, k, r) {
        if (k === "captureStackTrace") return captureStackTrace;
        if (k === "prepareStackTrace") return prep;
        if (k === "stackTraceLimit") return limit;
        if (extra.has(k)) return extra.get(k);
        return Reflect.get(o, k, o);
      },
      set(o, k, v) {
        if (k === "prepareStackTrace") { prep = v; return true; }
        if (k === "stackTraceLimit") { limit = v; return true; }
        if (k === "prototype" || k === "length") return false;
        extra.set(k, v); return true;   // never the page's Error
      },
      defineProperty() { return false; },
      deleteProperty(o, k) { if (k === "prepareStackTrace") { prep = undefined; return true; } return false; },
    });
  }

  /* constants: graceful-fs (zotero, slides) reads require("constants") at module scope
     (hasOwnProperty("O_SYMLINK"), O_WRONLY) and zotero's bundled tar reads the S_IF* mode
     bits. Pure data, Linux values, exactly the members those bundles touch. O_SYMLINK is
     absent (as on Linux), so graceful-fs never installs its lchmod/lutimes polyfills.
     A plain frozen object: graceful-fs calls the inherited hasOwnProperty. */
  const constantsMod = Object.freeze({
    O_WRONLY: 1,
    S_IFMT: 0o170000, S_IFIFO: 0o010000, S_IFCHR: 0o020000, S_IFDIR: 0o040000,
    S_IFBLK: 0o060000, S_IFLNK: 0o120000,
  });

  /* Buffer: the free variable (and require("buffer").Buffer) the owners' bundles read —
     zotero: safe-buffer/execa/get-stream/tar (Buffer.from, isBuffer, concat, byteLength,
     alloc, isEncoding at module scope), and the other three via their bundled streams.
     plugins.rs wrap_cjs_ctx binds it as the owners' 6th factory parameter. Pure: a Uint8Array
     subclass plus encode/decode of utf8, latin1/binary, ascii, hex, base64(url), ucs2. No I/O,
     no host state, no pooling (allocUnsafe is zero-filled), one frozen class for all owners. */
  const ENC = new Set(["utf8", "utf-8", "latin1", "binary", "ascii", "hex", "base64", "base64url", "ucs2", "ucs-2", "utf16le", "utf-16le"]);
  const encName = e => { const n = e == null ? "utf8" : String(e).toLowerCase(); if (!ENC.has(n)) throw new TypeError("Unknown encoding: " + e); return n; };
  const latin1Bytes = s => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; };
  const latin1Str = (b, mask) => { let s = ""; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, mask ? Array.from(b.subarray(i, i + 8192), x => x & mask) : b.subarray(i, i + 8192)); return s; };
  function encode(s, e) {
    s = String(s);
    switch (encName(e)) {
      case "latin1": case "binary": case "ascii": return latin1Bytes(s);
      case "hex": { const n = s.length >> 1, b = new Uint8Array(n); let i = 0; for (; i < n; i++) { const v = parseInt(s.substr(i * 2, 2), 16); if (Number.isNaN(v)) break; b[i] = v; } return b.subarray(0, i); }
      case "base64": case "base64url": { const t = s.replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/]/g, ""); try { return latin1Bytes(atob(t + "===".slice((t.length + 3) % 4))); } catch (_) { return new Uint8Array(0); } }
      case "ucs2": case "ucs-2": case "utf16le": case "utf-16le": { const b = new Uint8Array(s.length * 2); for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); b[i * 2] = c & 255; b[i * 2 + 1] = c >> 8; } return b; }
      default: return new TextEncoder().encode(s);
    }
  }
  function decode(b, e) {
    switch (encName(e)) {
      case "latin1": case "binary": return latin1Str(b, 0);
      case "ascii": return latin1Str(b, 127);
      case "hex": { let s = ""; for (const x of b) s += (x < 16 ? "0" : "") + x.toString(16); return s; }
      case "base64": return btoa(latin1Str(b, 0));
      case "base64url": return btoa(latin1Str(b, 0)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      case "ucs2": case "ucs-2": case "utf16le": case "utf-16le": { let s = ""; for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b[i] | (b[i + 1] << 8)); return s; }
      default: return new TextDecoder().decode(b);
    }
  }
  const BufferClass = class Buffer extends Uint8Array {
    // legacy new Buffer(string, enc) / new Buffer(array) as well as (n) and (arrayBuffer, off, len)
    constructor(a, b, c) {
      if (typeof a === "string") super(encode(a, b));
      else if (Array.isArray(a)) super(a);
      else if (a instanceof ArrayBuffer) super(a, b || 0, c === undefined ? a.byteLength - (b || 0) : c);
      else if (ArrayBuffer.isView(a)) super(a);
      else super(a === undefined ? 0 : a);
    }
    static from(v, b, c) {
      if (typeof v === "string") return new Buffer(encode(v, b));
      if (v instanceof ArrayBuffer) return new Buffer(v, b, c);
      if (ArrayBuffer.isView(v)) { const u = new Uint8Array(v.buffer, v.byteOffset, v.byteLength), b = new Buffer(u.length); b.set(u); return b; }
      if (Array.isArray(v)) return new Buffer(v);
      if (v && typeof v === "object" && v.type === "Buffer" && Array.isArray(v.data)) return new Buffer(v.data);
      throw new TypeError("The first argument must be of type string, Buffer, ArrayBuffer or Array");
    }
    static alloc(n, fill, enc) { const b = new Buffer(n); if (fill !== undefined && fill !== 0) b.fill(fill, 0, b.length, enc); return b; }
    static allocUnsafe(n) { return new Buffer(n); }
    static allocUnsafeSlow(n) { return new Buffer(n); }
    static isBuffer(x) { return x instanceof Buffer; }
    static isEncoding(e) { return typeof e === "string" && ENC.has(e.toLowerCase()); }
    static byteLength(v, e) { return typeof v === "string" ? encode(v, e).length : v.byteLength; }
    static concat(list, total) {
      if (total === undefined) total = list.reduce((n, x) => n + x.length, 0);
      const out = new Buffer(total);
      let o = 0;
      for (const x of list) { if (o >= total) break; const s = x.length > total - o ? x.subarray(0, total - o) : x; out.set(s, o); o += s.length; }
      return out;
    }
    static compare(a, b) { return a.compare(b); }
    toString(e, s, t) { return decode(this.subarray(s || 0, t === undefined ? this.length : t), e); }
    toJSON() { return { type: "Buffer", data: Array.from(this) }; }
    slice(s, t) { return this.subarray(s, t); }
    equals(o) { return this.compare(o) === 0; }
    compare(o) { const n = Math.min(this.length, o.length); for (let i = 0; i < n; i++) if (this[i] !== o[i]) return this[i] < o[i] ? -1 : 1; return this.length === o.length ? 0 : this.length < o.length ? -1 : 1; }
    copy(t, ts, ss, se) { const s = this.subarray(ss || 0, se === undefined ? this.length : se).subarray(0, t.length - (ts || 0)); t.set(s, ts || 0); return s.length; }
    write(str, off, len, enc) {
      if (typeof off === "string") { enc = off; off = 0; len = undefined; } else if (typeof len === "string") { enc = len; len = undefined; }
      off = off || 0; const b = encode(str, enc).subarray(0, Math.min(len === undefined ? Infinity : len, this.length - off)); this.set(b, off); return b.length;
    }
    fill(v, s, t, enc) {
      if (typeof s === "string") { enc = s; s = 0; t = this.length; }
      if (typeof v === "string") { const b = encode(v, enc); if (!b.length) return super.fill(0, s, t); for (let i = s || 0, j = 0, end = t === undefined ? this.length : t; i < end; i++, j = (j + 1) % b.length) this[i] = b[j]; return this; }
      return super.fill(v, s, t);
    }
  };
  /* Node's Buffer is callable without new (the deprecated Buffer(x) form, and
     Buffer.call(this, ...) from util.inherits subclasses); a class constructor throws there,
     which failed the advanced-slides load ("Cannot call a class constructor Buffer without
     new", gate xXzyJg41). The owners' Buffer is a plain function over the class: called or
     constructed it returns a class instance, shares its prototype (instanceof holds) and its
     statics. The class keeps its own constructor, so subarray/map species stay Buffers. */
  function Buffer(a, b, c) { return new BufferClass(a, b, c); }
  Buffer.prototype = BufferClass.prototype;
  for (const k of Object.getOwnPropertyNames(BufferClass)) {
    if (k !== "length" && k !== "name" && k !== "prototype") Object.defineProperty(Buffer, k, Object.getOwnPropertyDescriptor(BufferClass, k));
  }
  Object.setPrototypeOf(Buffer, Uint8Array);
  Object.freeze(BufferClass.prototype); Object.freeze(BufferClass); Object.freeze(Buffer);

  const bufferMod = Object.freeze({ Buffer, kMaxLength: 2 ** 31 - 1, constants: Object.freeze({ MAX_LENGTH: 2 ** 31 - 1 }) });

  /* crypto, the pure part only (realclaudian + local REST): local REST's bundled forge seeds
     its PRNG from crypto.randomBytes and MCP code calls randomUUID at load; its express
     computes ETags with createHash("sha1") per response; realclaudian hashes and mints ids.
     All of it is computation on bytes the plugin already holds plus the page's CSPRNG
     (crypto.getRandomValues): no I/O, no key store, no host state. sha1/sha256 (+ HMAC) are
     implemented here; every other digest throws ERR_OSSL_EVP_UNSUPPORTED. Signing, keys,
     certificates, ciphers and pbkdf2 are NOT here: they stay the deny stub, or for local
     REST read undefined so forge takes its own pure-JS path (it feature-tests them). */
  const rot = (x, n) => (x << n) | (x >>> (32 - n));
  function mdPad(m) {
    const n = m.length, t = ((n + 8) >> 6) + 1, b = new Uint8Array(t * 64);
    b.set(m); b[n] = 0x80;
    const dv = new DataView(b.buffer), bits = n * 8;
    dv.setUint32(b.length - 8, Math.floor(bits / 2 ** 32)); dv.setUint32(b.length - 4, bits >>> 0);
    return dv;
  }
  function sha1(m) {
    const dv = mdPad(m), w = new Int32Array(80);
    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    for (let o = 0; o < dv.byteLength; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getInt32(o + i * 4);
      for (let i = 16; i < 80; i++) w[i] = rot(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let i = 0; i < 80; i++) {
        const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
        const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
        const t = (rot(a, 5) + f + e + k + w[i]) | 0;
        e = d; d = c; c = rot(b, 30); b = a; a = t;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
    }
    const out = new DataView(new ArrayBuffer(20));
    [h0, h1, h2, h3, h4].forEach((h, i) => out.setInt32(i * 4, h));
    return new Uint8Array(out.buffer);
  }
  const K256 = new Int32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb,
    0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f,
    0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  function sha256(m) {
    const dv = mdPad(m), w = new Int32Array(64);
    const h = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const ror = (x, n) => (x >>> n) | (x << (32 - n));
    for (let o = 0; o < dv.byteLength; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getInt32(o + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = ror(w[i - 15], 7) ^ ror(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = ror(w[i - 2], 17) ^ ror(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = (hh + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
        const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    const out = new DataView(new ArrayBuffer(32));
    h.forEach((x, i) => out.setInt32(i * 4, x));
    return new Uint8Array(out.buffer);
  }
  const DIGESTS = { sha1, sha256 };
  // known-answer self-test (FIPS 180-2 example vectors, one and two blocks): a wrong digest must never reach
  // a plugin, so on any mismatch every hash and HMAC throws instead (fail closed)
  const KAT = (() => {
    try {
      const h = (f, s) => decode(f(new TextEncoder().encode(s)), "hex"), q = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
      return h(sha1, "abc") === "a9993e364706816aba3e25717850c26c9cd0d89d" && h(sha1, q) === "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
        && h(sha256, "abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        && h(sha256, q) === "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1";
    } catch (_) { return false; }
  })();
  function digestFn(alg) {
    if (!KAT) { const e = new Error("crypto: the sha1/sha256 self-test failed; hashing is disabled"); e.code = "ERR_OSSL_EVP_UNSUPPORTED"; throw e; }
    const f = DIGESTS[String(alg).toLowerCase().replace(/-/g, "")];
    if (!f) { const e = new Error("Digest method not supported: " + alg + " (opensidian: sha1/sha256 only)"); e.code = "ERR_OSSL_EVP_UNSUPPORTED"; throw e; }
    return f;
  }
  function hashBytes(d, enc) {
    if (typeof d === "string") return encode(d, enc);
    if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    if (d instanceof ArrayBuffer) return new Uint8Array(d);
    throw new TypeError('The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView');
  }
  const joinBytes = parts => { let n = 0; for (const p of parts) n += p.length; const b = new Uint8Array(n); let o = 0; for (const p of parts) { b.set(p, o); o += p.length; } return b; };
  function hashObject(compute) {
    const parts = [];
    let done = false;
    const h = {
      update(d, enc) { if (done) throw Object.assign(new Error("Digest already called"), { code: "ERR_CRYPTO_HASH_FINALIZED" }); parts.push(hashBytes(d, enc).slice()); return h; },
      digest(enc) {
        if (done) throw Object.assign(new Error("Digest already called"), { code: "ERR_CRYPTO_HASH_FINALIZED" });
        done = true;
        const out = Buffer.from(compute(joinBytes(parts)));
        return enc === undefined || enc === "buffer" ? out : out.toString(enc);
      },
      copy() { const c = hashObject(compute); for (const p of parts) c.update(p); return c; },
    };
    return h;
  }
  const createHash = alg => { const f = digestFn(alg); return hashObject(f); };
  function createHmac(alg, key) {
    const f = digestFn(alg);
    let k = key && typeof key === "object" && !ArrayBuffer.isView(key) && typeof key.export === "function" ? key.export() : hashBytes(key);
    if (k.length > 64) k = f(k);
    const ki = new Uint8Array(64), ko = new Uint8Array(64);
    for (let i = 0; i < 64; i++) { const v = i < k.length ? k[i] : 0; ki[i] = v ^ 0x36; ko[i] = v ^ 0x5c; }
    return hashObject(m => f(joinBytes([ko, f(joinBytes([ki, m]))])));
  }
  const rng = a => { for (let i = 0; i < a.byteLength; i += 65536) crypto.getRandomValues(new Uint8Array(a.buffer, a.byteOffset + i, Math.min(65536, a.byteLength - i))); return a; };
  function randomBytes(n, cb) {
    if (!Number.isInteger(n) || n < 0 || n > 2 ** 31 - 1) throw new RangeError('The "size" argument must be an integer in [0, 2147483647]');
    const b = rng(Buffer.alloc(n));
    if (typeof cb === "function") { queueMicrotask(() => cb(null, b)); return undefined; }
    return b;
  }
  function randomUUID() {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const b = rng(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    const x = decode(b, "hex"); return x.slice(0, 8) + "-" + x.slice(8, 12) + "-" + x.slice(12, 16) + "-" + x.slice(16, 20) + "-" + x.slice(20);
  }
  function timingSafeEqual(a, b) {
    a = hashBytes(a); b = hashBytes(b);
    if (a.length !== b.length) throw Object.assign(new RangeError("Input buffers must have the same byte length"), { code: "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH" });
    let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0;
  }
  const cryptoOwn = Object.freeze({ createHash, createHmac, randomBytes, randomUUID, timingSafeEqual,
    getRandomValues: a => crypto.getRandomValues(a), getHashes: () => ["sha1", "sha256"] });
  /* realclaudian, the rest of its module-scope surface in one pass (gate QPmEkmwP:
     require("os") stub called; the static dump of every os/module/async_hooks read in
     its bundle is homedir/tmpdir/release/userInfo/networkInterfaces, createRequire,
     AsyncLocalStorage). All three are constants or pure computation:
       - os: fixed values that describe no real host (no username, no NIC, no kernel);
         networkInterfaces() is empty because the page has no interface to report.
         The paths it builds from homedir() land outside /vault, where the confined fs
         answers them as missing; the claude process itself only starts through the broker.
       - module.createRequire(): the owner's OWN require (the loader binds it), so its
         bundled CJS deps get exactly the facades and stubs a top-level require gets; no
         new reach. resolve() has no module paths and throws MODULE_NOT_FOUND.
       - async_hooks.AsyncLocalStorage: the store is visible inside run()'s synchronous
         extent only (no async-context propagation in the page); getStore() is undefined
         elsewhere, which callers already handle (?? default). */
  const OS_HOME = "/home/opensidian";
  const osOwn = Object.freeze({
    homedir: () => OS_HOME, tmpdir: () => "/tmp", hostname: () => "localhost",
    platform: () => "linux", type: () => "Linux", arch: () => "x64", machine: () => "x86_64",
    release: () => "0.0.0", version: () => "", endianness: () => "LE", EOL: "\n", devNull: "/dev/null",
    userInfo: () => ({ uid: -1, gid: -1, username: "opensidian", homedir: OS_HOME, shell: null }),
    networkInterfaces: () => ({}), cpus: () => [], availableParallelism: () => 1,
    totalmem: () => 0, freemem: () => 0, uptime: () => 0, loadavg: () => [0, 0, 0],
  });
  class AsyncLocalStorage {
    #on = false; #has = false; #store = undefined;
    getStore() { return this.#on && this.#has ? this.#store : undefined; }
    run(store, fn, ...args) {
      const ph = this.#has, ps = this.#store, po = this.#on;
      this.#on = true; this.#has = true; this.#store = store;
      try { return fn(...args); } finally { this.#on = po; this.#has = ph; this.#store = ps; }
    }
    exit(fn, ...args) {
      const ph = this.#has, ps = this.#store;
      this.#has = false; this.#store = undefined;
      try { return fn(...args); } finally { this.#has = ph; this.#store = ps; }
    }
    enterWith(store) { this.#on = true; this.#has = true; this.#store = store; }
    disable() { this.#on = false; this.#has = false; this.#store = undefined; }
    static bind(fn) { return fn; }
    static snapshot() { return (fn, ...args) => fn(...args); }
  }
  const asyncHooksOwn = Object.freeze({ AsyncLocalStorage });

  /* the free variable `process` an owner's bundle reads (Electron-renderer code: module-scope
     process.umask(), semver checks on process.version, process.platform, process.env.NODE_DEBUG).
     plugins.rs wrap_cjs_ctx binds it as the owners' 4th factory parameter and loader.js fills
     it from view.process. I/O-free: constants and no-ops only. No exit/kill/stdout/stdin/
     binding/getuid/chdir, no electron version, an empty env. chdir is absent, not a throwing
     member: graceful-fs (zotero, slides) wraps a present chdir and setPrototypeOf(wrapper, chdir)s it;
     on this frozen shim the wrap assignment is dropped, so that became setPrototypeOf(chdir, chdir)
     ("Cyclic __proto__ value") and failed the load. execa / which check chdir !== undefined first. */
  function stdioShim(fd) {
    const s = Object.create(null);
    const noop = () => s;
    return Object.freeze(Object.assign(s, { fd, isTTY: false, columns: 80, rows: 24, writable: true,
      write: (c, e, cb) => { const f = typeof e === "function" ? e : cb; if (typeof f === "function") queueMicrotask(() => f()); return true; },
      end: noop, on: noop, once: noop, off: noop, addListener: noop, removeListener: noop, emit: () => false }));
  }
  function processShim() {
    const self = Object.create(null);
    const noop = () => self;
    return Object.freeze(Object.assign(self, {
      platform: "linux", arch: "x64", browser: false, pid: 0,
      env: Object.freeze(Object.create(null)),
      version: "v18.0.0",
      versions: Object.freeze(Object.assign(Object.create(null), { node: "18.0.0" })),
      execArgv: Object.freeze([]), argv: Object.freeze([]), execPath: "",
      cwd: () => "/",
      umask: () => 0o022,
      nextTick: (fn, ...a) => { queueMicrotask(() => fn(...a)); },
      emitWarning: () => {},   // deprecation warnings: dropped (no stderr)
      // stdout/stderr: no terminal (isTTY false, as in a GUI renderer); writes are dropped, like
      // emitWarning: the page has no stdio. realclaudian's SDK reads process.stdout.isTTY on send.
      stdout: stdioShim(1), stderr: stdioShim(2),
      on: noop, once: noop, off: noop, addListener: noop, removeListener: noop, removeAllListeners: noop, emit: () => false,
    }));
  }

  /* `global`: Node's name for the global object. Bundled libraries read it (lodash root
     check global.Object === Object, readable-stream, global.process) and graceful-fs WRITES a
     queue symbol onto it. Plugins already share the page realm, so reads fall through to
     window (no new reach); writes and defines land on the owner's own object and never touch
     window. global.process is the owner's shim. */
  function ownGlobal(proc) {
    const own = Object.create(null);
    own.process = proc;
    own.Buffer = Buffer;
    // window methods (setTimeout, fetch, ...) are bound so a call through global keeps
    // this === window; constructors (Object, Uint8Array, ...) pass through unbound so
    // identity checks like global.Object === Object hold
    const bound = new Map();
    const pass = k => {
      const v = window[k];
      if (typeof v !== "function" || typeof k !== "string" || !/^[a-z]/.test(k)) return v;
      let b = bound.get(k);
      if (!b || b.f !== v) { b = { f: v, b: v.bind(window) }; bound.set(k, b); }
      return b.b;
    };
    const g = new Proxy(own, {
      get(o, k) { if (k === "global" || k === "globalThis" || k === "self" || k === "window") return k === "window" ? window : g; return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : pass(k); },
      has(o, k) { return Object.prototype.hasOwnProperty.call(o, k) || k in window; },
    });
    return g;
  }
  /* SharedArrayBuffer: WebKit gives a page that is not cross-origin isolated none, and
     realclaudian's bundled SDK allocates new Int32Array(new SharedArrayBuffer(4)) at chunk
     scope (a sleep cell for Atomics.wait on EBUSY retries) -> ReferenceError on send. The
     owners' binding is a plain ArrayBuffer subclass: nothing is shared with any other agent,
     so it is no shared-memory timer; Atomics.wait on it throws TypeError, as the main
     thread's Atomics.wait does anyway. */
  const OwnSAB = class SharedArrayBuffer extends ArrayBuffer {};
  Object.freeze(OwnSAB.prototype); Object.freeze(OwnSAB);

  /* ------------------------------------------------------ the view */
  // a frozen module object whose named members are real; any other member is the inert
  // deny stub (node-modules.js stub(), same message as the loader's). Members are OWN keys:
  // bundled __toESM(require("x")) copies own keys only.
  function mod(name, deny, own) {
    const s = host.nodeModules && host.nodeModules.stub(name, deny);
    const t = Object.create(null);
    for (const k of Object.keys(own)) Object.defineProperty(t, k, { value: own[k], enumerable: true, writable: false, configurable: false });
    Object.freeze(t);
    return new Proxy(t, {
      get(o, k) { if (Object.prototype.hasOwnProperty.call(o, k)) return o[k]; if (typeof k === "symbol" || k === "then") return undefined; return s ? s[k] : undefined; },
      has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); },
    });
  }
  const utilAll = Object.freeze(Object.assign({ TextDecoder, TextEncoder,
    types: Object.freeze({ isPromise: v => v instanceof Promise, isDate: v => v instanceof Date, isRegExp: v => v instanceof RegExp, isUint8Array: v => v instanceof Uint8Array }),
    isDeepStrictEqual: (a, b) => { try { return JSON.stringify(a) === JSON.stringify(b); } catch (_) { return a === b; } } }, slidesUtilOwn));
  // forge (and others) feature-test keygen / pbkdf2 with typeof === "function": undefined
  // sends them down their own pure-JS path instead of calling a deny stub
  const cryptoAll = Object.freeze(Object.assign({ generateKeyPair: undefined, generateKeyPairSync: undefined, pbkdf2: undefined, pbkdf2Sync: undefined }, cryptoOwn));
  const qsMod = Object.freeze({
    parse: s => qsObj(String(s == null ? "" : s)),
    stringify: o => { const p = new URLSearchParams(); for (const k of Object.keys(o || {})) for (const v of [].concat(o[k])) p.append(k, String(v)); return p.toString(); },
    escape: s => encodeURIComponent(String(s)), unescape: s => decodeURIComponent(String(s)),
  });
  const timersMod = Object.freeze({ setTimeout: (...a) => window.setTimeout(...a), clearTimeout: t => window.clearTimeout(t),
    setInterval: (...a) => window.setInterval(...a), clearInterval: t => window.clearInterval(t),
    setImmediate: (f, ...a) => window.setTimeout(f, 0, ...a), clearImmediate: t => window.clearTimeout(t) });

  const PLUGIN_DIR = id => "/vault/.obsidian/plugins/" + id;
  const views = new Map();   // id -> view (one per plugin id for the page's life)
  function view(id) {
    id = String(id);
    if (views.has(id)) return views.get(id);
    const made = new Map();   // one module object per builtin name (require twice -> same object)
    let boundReq = null;      // the loader's require for this plugin, for module.createRequire
    const ownRequire = function require(n) {
      if (!boundReq) { const e = new Error("Cannot find module '" + String(n) + "'"); e.code = "MODULE_NOT_FOUND"; throw e; }
      return boundReq(n);
    };
    ownRequire.resolve = n => { const e = new Error("Cannot find module '" + String(n) + "' (no module paths in opensidian)"); e.code = "MODULE_NOT_FOUND"; throw e; };
    ownRequire.cache = Object.create(null);
    const proc = processShim();
    const mods = new Map([
      ["buffer", () => bufferMod],
      ["process", () => proc],
      ["events", () => eventsMod],
      ["string_decoder", () => stringDecoderMod],
      ["readline", () => readlineMod],
      ["url", () => urlMod],
      ["constants", () => constantsMod],
      ["querystring", () => qsMod],
      ["timers", () => timersMod],
      ["os", () => osOwn],
      ["async_hooks", () => asyncHooksOwn],
      ["module", () => Object.freeze({ createRequire: () => ownRequire, builtinModules: Object.freeze([]) })],
      ["util", (deny, n) => mod(n, deny, utilAll)],
      ["crypto", (deny, n) => mod(n, deny, cryptoAll)],
      ["tty", (deny, n) => mod(n, deny, { isatty: () => false })],
      ["http", (deny, n) => mod(n, deny, { METHODS: HTTP_METHODS, STATUS_CODES: HTTP_STATUS })],
      ["https", (deny, n) => mod(n, deny, { METHODS: HTTP_METHODS, STATUS_CODES: HTTP_STATUS })],
    ]);
    /* the vault fs facade (node-modules.js) is one frozen object shared by every plugin;
       graceful-fs defines a queue symbol on require("fs") and reassigns close/closeSync at
       load. A plugin gets its own extensible copy of the same functions, so its writes land
       on its copy, never on another plugin's fs. */
    const owned = new Map();
    const own = m => {
      if (!m || typeof m !== "object") return m;
      let c = owned.get(m);
      if (!c) {
        const d = Object.getOwnPropertyDescriptors(m);
        for (const k of Reflect.ownKeys(d)) { d[k].configurable = true; if ("value" in d[k]) d[k].writable = true; }
        c = Object.defineProperties(Object.create(Object.getPrototypeOf(m)), d);
        owned.set(m, c);
      }
      return c;
    };
    const v = Object.freeze({
      own,
      // a builtin this view answers; deny is the loader's message for the stub members
      resolve(name, deny) { const b = bare(name), f = mods.get(b); if (!f) return undefined; if (!made.has(b)) made.set(b, f(String(deny), b)); return made.get(b); },
      bindRequire(r) { if (typeof r === "function" && !boundReq) boundReq = r; },
      process: proc,
      global: ownGlobal(proc),
      Buffer,
      Error: ownError(),
      SharedArrayBuffer: OwnSAB,
      filename: PLUGIN_DIR(id) + "/main.js",
      dirname: PLUGIN_DIR(id),
    });
    views.set(id, v);
    return v;
  }
  host.desktopNode = Object.freeze({ view });
})();
