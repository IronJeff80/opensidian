// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* canvas core plugin (goal canvas-core): .canvas files in the JSON Canvas 1.0
   format, written from the open spec (https://jsoncanvas.org/spec/1.0/, MIT)
   and from the public API surface plugins call (clean room).

   Load order (index.html): ... api.js -> settings.js -> canvas.js -> main.js.
   This file runs NO code at load beyond defining one factory,
   window.__osCanvasFactory(deps), which main.js calls ONCE and then deletes.

   The document model keeps the PARSED objects: an edit changes only the known
   field it is about (x, y, width, height, text, ...), so every field this
   app does not know — on the root, a node or an edge — round-trips untouched
   and in its original key order. A file is only ever written after an edit;
   an opened-and-closed file is never rewritten, so it stays byte-identical. */
(function () {
  "use strict";
  const NODE_TYPES = ["text", "file", "link", "group"];
  const SIDES = ["top", "right", "bottom", "left"];
  const ENDS = ["none", "arrow"];
  const BG_STYLES = ["cover", "ratio", "repeat"];
  const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const isNum = v => typeof v === "number" && Number.isFinite(v);
  const optStr = (o, k) => !(k in o) || typeof o[k] === "string";
  const optIn = (o, k, set) => !(k in o) || set.includes(o[k]);

  class CanvasFormatError extends Error {
    constructor(msg) { super(msg); this.name = "CanvasFormatError"; }
  }

  /* text -> the document {nodes:[], edges:[], ...unknown}, or throws
     CanvasFormatError naming the first violation. An empty (or all-space) file
     is an empty canvas — a new canvas is created that way. */
  function parseCanvas(text) {
    if (typeof text !== "string") throw new CanvasFormatError("canvas text is not a string");
    if (!text.trim()) return { nodes: [], edges: [] };
    let doc;
    try { doc = JSON.parse(text); } catch (e) { throw new CanvasFormatError("not valid JSON: " + (e && e.message)); }
    validateCanvas(doc);
    if (!("nodes" in doc)) doc.nodes = [];
    if (!("edges" in doc)) doc.edges = [];
    return doc;
  }

  function validateCanvas(doc) {
    const bad = m => { throw new CanvasFormatError(m); };
    if (!isObj(doc)) bad("top level is not an object");
    if ("nodes" in doc && !Array.isArray(doc.nodes)) bad("nodes is not an array");
    if ("edges" in doc && !Array.isArray(doc.edges)) bad("edges is not an array");
    const ids = new Set();
    (doc.nodes || []).forEach((n, i) => {
      const at = "nodes[" + i + "]";
      if (!isObj(n)) bad(at + " is not an object");
      if (typeof n.id !== "string" || !n.id) bad(at + ".id is not a non-empty string");
      if (ids.has(n.id)) bad(at + ".id \"" + n.id + "\" is a duplicate");
      ids.add(n.id);
      if (!NODE_TYPES.includes(n.type)) bad(at + ".type " + JSON.stringify(n.type) + " is not text/file/link/group");
      for (const k of ["x", "y", "width", "height"]) if (!isNum(n[k])) bad(at + "." + k + " is not a number");
      if (!optStr(n, "color")) bad(at + ".color is not a string");
      if (n.type === "text" && typeof n.text !== "string") bad(at + ".text is not a string");
      if (n.type === "file" && (typeof n.file !== "string" || !optStr(n, "subpath"))) bad(at + ".file/subpath is not a string");
      if (n.type === "link" && typeof n.url !== "string") bad(at + ".url is not a string");
      if (n.type === "group" && (!optStr(n, "label") || !optStr(n, "background") || !optIn(n, "backgroundStyle", BG_STYLES)))
        bad(at + " has a bad label/background/backgroundStyle");
    });
    const eids = new Set();
    (doc.edges || []).forEach((e, i) => {
      const at = "edges[" + i + "]";
      if (!isObj(e)) bad(at + " is not an object");
      if (typeof e.id !== "string" || !e.id) bad(at + ".id is not a non-empty string");
      if (eids.has(e.id)) bad(at + ".id \"" + e.id + "\" is a duplicate");
      eids.add(e.id);
      if (!ids.has(e.fromNode)) bad(at + ".fromNode " + JSON.stringify(e.fromNode) + " is not a node");
      if (!ids.has(e.toNode)) bad(at + ".toNode " + JSON.stringify(e.toNode) + " is not a node");
      if (!optIn(e, "fromSide", SIDES) || !optIn(e, "toSide", SIDES)) bad(at + " has a bad fromSide/toSide");
      if (!optIn(e, "fromEnd", ENDS) || !optIn(e, "toEnd", ENDS)) bad(at + " has a bad fromEnd/toEnd");
      if (!optStr(e, "color") || !optStr(e, "label")) bad(at + " has a bad color/label");
    });
    return true;
  }

  // the document -> JSON Canvas text (tab-indented). Validates first: never write a canvas we could not read back.
  function serializeCanvas(doc) {
    validateCanvas(doc);
    return JSON.stringify(doc, null, "\t");
  }

  // a fresh id: 16 lowercase hex digits, not in `taken` (a Set or array of ids)
  function newId(taken) {
    const has = taken instanceof Set ? x => taken.has(x) : x => (taken || []).includes(x);
    for (;;) {
      const b = new Uint8Array(8); crypto.getRandomValues(b);
      const id = Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
      if (!has(id)) return id;
    }
  }

  // spec node color: a preset "1".."6" or a hex "#rgb"/"#rrggbb"; anything else renders uncolored
  const PRESET = { 1: "red", 2: "orange", 3: "yellow", 4: "green", 5: "cyan", 6: "purple" };
  function colorOf(c) {
    if (typeof c !== "string") return null;
    if (PRESET[c]) return "var(--color-" + PRESET[c] + ", " + ({ 1: "#e93147", 2: "#ec7500", 3: "#e0ac00", 4: "#08b94e", 5: "#00bfbc", 6: "#7852ee" })[c] + ")";
    return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c) ? c : null;
  }

  const model = Object.freeze({ NODE_TYPES, SIDES, ENDS, CanvasFormatError, parseCanvas, validateCanvas, serializeCanvas, newId, colorOf });

  /* ------------------------------------------------------------ geometry
     Canvas coordinates are the file's: a node's x/y is its top-left corner,
     width/height its size. An edge without fromSide/toSide attaches to the
     side of its node that faces the other node. */
  const NORMAL = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };
  function sideFacing(a, b) {
    const dx = (b.x + b.width / 2) - (a.x + a.width / 2), dy = (b.y + b.height / 2) - (a.y + a.height / 2);
    return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "right" : "left") : (dy >= 0 ? "bottom" : "top");
  }
  function anchorOf(n, side) {
    if (side === "top") return [n.x + n.width / 2, n.y];
    if (side === "bottom") return [n.x + n.width / 2, n.y + n.height];
    if (side === "left") return [n.x, n.y + n.height / 2];
    return [n.x + n.width, n.y + n.height / 2];
  }
  const SVGNS = "http://www.w3.org/2000/svg";
  function el(tag, cls, parent) { const e = document.createElement(tag); if (cls) e.className = cls; if (parent) parent.appendChild(e); return e; }
  function sv(tag, attrs, parent) { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }
  function debounced(fn, ms) {
    let t = null;
    const f = () => { clearTimeout(t); t = setTimeout(() => { t = null; fn(); }, ms); };
    f.cancel = () => { clearTimeout(t); t = null; };
    f.pending = () => t !== null;
    return f;
  }
  const errText = e => String((e && e.message) || e);
  const baseName = p => { const n = String(p).split("/").pop(); const d = n.lastIndexOf("."); return d > 0 ? n.slice(0, d) : n; };

  /* ------------------------------------------------------------ the factory
     deps (main.js, once): X (the "obsidian" module), app, io(op, path, data) ->
     the canvas_io command, readNote(path) -> a note's text (restricted mode has
     no vault model), notify(msg), pref {get() -> bool|null, set(bool)},
     config (app.internalPlugins.config: the id -> enabled map).
     changed() (optional): the board, the file or the error changed — the host republishes its census. */
  function canvasFactory(deps) {
    const { X, app, io } = deps;
    const changed = () => { if (typeof deps.changed === "function") try { deps.changed(); } catch (_) {} };
    const vaultFile = p => {
      try { const f = app.vault.getAbstractFileByPath(p); return f instanceof X.TFile ? f : null; } catch (_) { return null; }
    };
    // the vault model is loaded (a trusted vault with plugins running): a path missing from it is missing
    const modelOn = () => { try { return app.vault.getAllLoadedFiles().length > 1; } catch (_) { return false; } };
    const pathOf = f => (typeof f === "string" ? f : f && typeof f.path === "string" ? f.path : "");

    /* ---------------------------------------------------------- nodes
       A node wraps ITS object in the document (data): moving / resizing /
       editing writes the known field in place, so every other field stays. */
    class CanvasNode extends X.Component {
      constructor(canvas, data) {
        super();
        this.canvas = canvas; this.app = app; this.data = data; this.id = data.id;
        this.isEditing = false;
        this.containerEl = el("div", "canvas-node canvas-node-" + data.type);
        this.containerEl.dataset.nodeId = data.id;
        this.labelEl = el("div", "canvas-node-label", this.containerEl);
        this.contentEl = el("div", "canvas-node-container", this.containerEl);
        this.blockerEl = el("div", "canvas-node-content-blocker", this.containerEl);
        this.resizerEl = el("div", "canvas-node-resizer", this.containerEl);
      }
      get x() { return this.data.x; }
      get y() { return this.data.y; }
      get width() { return this.data.width; }
      get height() { return this.data.height; }
      get color() { return this.data.color || ""; }
      getData() { return this.data; }
      getBBox() { const d = this.data; return { minX: d.x, minY: d.y, maxX: d.x + d.width, maxY: d.y + d.height }; }
      moveTo(pos) { this.data.x = Math.round(pos.x); this.data.y = Math.round(pos.y); this.place(); }
      resize(size) { this.data.width = Math.max(40, Math.round(size.width)); this.data.height = Math.max(30, Math.round(size.height)); this.place(); }
      setColor(c) { if (c) this.data.color = String(c); else delete this.data.color; this.place(); this.canvas.requestSave(); }
      place() {
        const s = this.containerEl.style, d = this.data;
        s.left = d.x + "px"; s.top = d.y + "px"; s.width = d.width + "px"; s.height = d.height + "px";
        const c = colorOf(d.color);
        if (c) s.setProperty("--canvas-color", c); else s.removeProperty("--canvas-color");
        this.containerEl.classList.toggle("is-themed", !!c);
      }
      render() { this.place(); this.renderContent(); return this; }
      renderContent() {}
      isEditable() { return false; }
      startEditing() {}
      stopEditing() {}
      setSelected(on) { this.containerEl.classList.toggle("is-selected", !!on); }
      // the node leaves the board for good: its children (an embed) unload, its DOM goes
      detach() { if (this._gone) return; this._gone = true; try { this.unload(); } catch (e) { console.error(e); } this.containerEl.remove(); }
    }

    class TextNode extends CanvasNode {
      get text() { return this.data.text; }
      setText(t) { if (this.data.text !== t) { this.data.text = String(t); this.renderContent(); this.canvas.requestSave(); } }
      renderContent() {
        if (this.isEditing) return;
        this.contentEl.textContent = "";
        const t = el("div", "canvas-text", this.contentEl);
        t.textContent = this.data.text;        // plain text first; canvas-cards.js swaps in the sanitized Markdown render
        const cc = window.__osCanvasCards;
        if (cc) cc.text(this, { app, X, deps });
      }
      isEditable() { return true; }
      startEditing() {
        if (this.isEditing) return;
        const cf = window.__osCanvasFiles;    // goal cv-files CV-025: the note editor (CM6) first, this textarea is the fallback
        if (cf && cf.startEditing(this, { app, X, deps })) return;
        this.isEditing = true;
        this.containerEl.classList.add("is-editing");
        this.contentEl.textContent = "";
        const ta = el("textarea", "canvas-node-textarea", this.contentEl);
        ta.value = this.data.text; ta.spellcheck = false;
        ta.addEventListener("blur", () => this.stopEditing());
        ta.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); ta.blur(); } e.stopPropagation(); });
        this.textareaEl = ta;
        setTimeout(() => { try { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } catch (_) {} }, 0);
      }
      stopEditing() {
        if (!this.isEditing) return;
        const cf = window.__osCanvasFiles;
        if (cf && cf.stopEditing(this, { app, X, deps })) return;
        const v = this.textareaEl ? this.textareaEl.value : this.data.text;
        this.isEditing = false; this.textareaEl = null;
        this.containerEl.classList.remove("is-editing");
        const changed = v !== this.data.text;
        this.data.text = v;
        this.renderContent();
        if (changed) this.canvas.requestSave();
      }
    }

    /* a file node: a markdown note renders through app.embedRegistry's md embed
       (child); editing swaps it for an embedded editor whose child.editor is the
       Editor API, writes go back to the note through vault.modify. */
    class FileNode extends CanvasNode {
      constructor(canvas, data) { super(canvas, data); this.child = null; this.file = null; }
      get filePath() { return this.data.file; }
      get subpath() { return this.data.subpath || ""; }
      setFilePath(path, subpath) {
        path = pathOf(path);
        if (this.data.file !== path) this.data.file = path;
        const sp = subpath ? String(subpath) : "";
        if (sp) { if (this.data.subpath !== sp) this.data.subpath = sp; } else if ("subpath" in this.data) delete this.data.subpath;
        this.file = vaultFile(path);
        if (this.canvas.nodes.get(this.id) === this) this.canvas.requestSave();
      }
      dropChild() {
        if (!this.child) return;
        const c = this.child; this.child = null;
        try { this.removeChild(c); } catch (e) { console.error(e); }
      }
      renderContent() {
        if (this.isEditing) this.stopEditing();
        this.dropChild();
        const p = this.data.file;
        this.file = vaultFile(p);
        this.labelEl.textContent = baseName(p) + (this.subpath || "");
        this.contentEl.textContent = "";
        const f = this.file;
        const cf = window.__osCanvasFiles;   // goal cv-files: PDF + canvas file cards (canvas-files.js); false = not ours
        if (cf && cf.file(this, { app, X, deps, file: f, missing: !f && modelOn() })) return;
        const cc = window.__osCanvasCards;   // media / other files (canvas-cards.js); false = a note, a canvas or missing: painted below
        if (cc && cc.file(this, { app, X, deps, file: f, missing: !f && modelOn() })) return;
        const reg = app.embedRegistry, mdc = reg && reg.embedByExtension && Object.prototype.hasOwnProperty.call(reg.embedByExtension, "md") ? reg.embedByExtension.md : null;
        if (f && f.extension === "md" && typeof mdc === "function") {
          const host = el("div", "canvas-file-embed", this.contentEl);
          let child = null;
          try { child = mdc({ app, containerEl: host, linktext: p, sourcePath: this.canvas.path || "", depth: 1, showInline: true }, f, this.subpath); }
          catch (e) { console.error("[canvas] file node embed:", e); }
          if (child) {
            const node = this;
            Object.defineProperty(child, "editor", { configurable: true, get() { return node.editorApi(); } });
            child.showPreview = () => node.stopEditing();
            this.child = child;
            this.addChild(child);
            if (typeof child.loadFile === "function") child.loadFile().then(() => changed(), e => console.error("[canvas] file node load:", e));   // the census reads the painted note
          }
          return;
        }
        const ph = el("div", "canvas-node-placeholder", this.contentEl);
        if (!f && !modelOn() && /\.md$/i.test(p) && typeof deps.readNote === "function") {   // no vault model (restricted mode): the note's text, read-only
          ph.classList.add("canvas-file-text");
          deps.readNote(p).then(t => { if (this.data.file === p && !this.child) ph.textContent = t || p + " — empty or not found"; }, () => { ph.textContent = p + " — not found"; });
        } else ph.textContent = f ? p : p + " — not found";
      }
      editorApi() {
        const em = this.child && this.child.editMode;
        const ed = em && em.editor;
        if (ed && !Object.prototype.hasOwnProperty.call(ed, "containerEl")) Object.defineProperty(ed, "containerEl", { value: em.editorEl || em.containerEl });
        return ed || null;
      }
      isEditable() { return !!(this.child && typeof this.child.showEditor === "function" && this.file && this.file.extension === "md"); }
      startEditing() {
        if (!this.isEditable() || this.isEditing) return;
        const c = this.child;
        this.isEditing = true;
        this.containerEl.classList.add("is-editing");
        this.blockerEl.hidden = true;
        const body = c.containerEl && c.containerEl.querySelector(".markdown-embed-content");
        if (body) body.hidden = true;
        const em = c.showEditor();
        this._orig = c.text != null ? c.text : (c.data || "");
        this._save = debounced(() => this.writeBack(), 600);
        em.onUpdate = (u, changed) => { if (changed && this._save) this._save(); };
      }
      async writeBack() {
        const c = this.child, em = c && c.editMode, f = this.file;
        if (!em || !f) return;
        const t = em.get();
        if (t === this._orig) return;
        const cur = await app.vault.read(f);
        const i = this._orig === "" ? -1 : cur.indexOf(this._orig);
        const next = this.subpath && i >= 0 ? cur.slice(0, i) + t + cur.slice(i + this._orig.length) : (this.subpath ? cur : t);
        if (next !== cur) await app.vault.modify(f, next);
        this._orig = t;
      }
      stopEditing() {
        if (!this.isEditing) return;
        this.isEditing = false;
        this.containerEl.classList.remove("is-editing");
        this.blockerEl.hidden = false;
        const c = this.child, sv0 = this._save; this._save = null;
        const done = () => {
          if (!c || this.child !== c) return;
          if (c.editMode) { try { c.removeChild(c.editMode); } catch (_) {} c.editMode = null; }
          if (typeof c.loadFile === "function") c.loadFile().catch(e => console.error("[canvas] file node reload:", e));
        };
        if (sv0) sv0.cancel();
        this.writeBack().catch(e => { console.error("[canvas] file node save:", e); if (deps.notify) deps.notify("Canvas: the note was not saved — " + errText(e)); }).then(done);
      }
    }

    class LinkNode extends CanvasNode {
      renderContent() {
        this.labelEl.textContent = "";
        this.contentEl.textContent = "";
        const a = el("div", "canvas-link", this.contentEl);
        a.textContent = this.data.url;          // shown, never loaded: a canvas does not fetch the web
        a.title = this.data.url;
        const cc = window.__osCanvasCards;    // Ctrl/Cmd-click -> open_external (canvas-cards.js)
        if (cc) cc.link(this, { app, X, deps });
      }
    }

    class GroupNode extends CanvasNode {
      renderContent() {
        this.labelEl.textContent = this.data.label || "";
        this.contentEl.textContent = "";
        const cc = window.__osCanvasCards;    // background image + in-place rename (canvas-cards.js)
        if (cc) cc.group(this, { app, X, deps });
      }
    }
    const NODE_CLASS = { text: TextNode, file: FileNode, link: LinkNode, group: GroupNode };

    /* ---------------------------------------------------------- the board
       wrapperEl (viewport, pointer + wheel + keys) > canvasEl (translated and
       scaled) > the group layer, the edge layer (svg), the node layer — in paint order. */
    class Canvas {
      constructor(view) {
        this.view = view; this.app = app;
        this.nodes = new Map(); this.edges = new Map(); this.selection = new Set();
        this.tx = 0; this.ty = 0; this.zoom = 1;
        this.data = { nodes: [], edges: [] };
        this.readonly = false;
        this.wrapperEl = el("div", "canvas-wrapper");
        this.wrapperEl.tabIndex = 0;
        this.canvasEl = el("div", "canvas", this.wrapperEl);
        // groups sit under the edges (a group's fill must never hide an edge that crosses it), the other nodes over them
        this.groupEl = el("div", "canvas-nodes canvas-groups", this.canvasEl);
        this.edgeEl = sv("svg", { class: "canvas-edges", width: "1", height: "1" }, this.canvasEl);
        this.nodeEl = el("div", "canvas-nodes", this.canvasEl);
        this.controlsEl = el("div", "canvas-controls", this.wrapperEl);
        const btn = (cls, label, txt, fn) => {
          const b = el("button", "canvas-control " + cls, this.controlsEl);
          b.type = "button"; b.textContent = txt; b.title = label; b.setAttribute("aria-label", label);
          b.addEventListener("pointerdown", e => e.stopPropagation());
          b.addEventListener("click", e => { e.stopPropagation(); fn(); });
          return b;
        };
        btn("mod-add-text", "Add text node", "+ Text", () => this.addTextAtCenter());
        btn("mod-zoom-in", "Zoom in", "+", () => this.zoomBy(1.25));
        btn("mod-zoom-out", "Zoom out", "−", () => this.zoomBy(0.8));
        btn("mod-zoom-fit", "Zoom to fit", "Fit", () => this.zoomToFit());
        this._saveSoon = debounced(() => { if (this.view && this.view.save) this.view.save().catch(e => console.error("[canvas] save:", e)); }, 400);
        this.requestSave = () => { if (this.readonly) return; if (this.view) this.view.dirty = true; this._saveSoon(); changed(); };
        this.wire();
        this.applyTransform();
        if (window.CanvasNav) window.CanvasNav.attach(this, X, changed);   // goal cv-nav: pan/zoom keys, controls, grid, settings (canvas-nav.js)
        // a view opens hidden (0x0): fit the board the first time it has a size
        this.fitted = false;
        if (typeof ResizeObserver === "function") {
          this._ro = new ResizeObserver(() => { const r = this.wrapperEl.getBoundingClientRect(); if (!this.fitted && r.width && r.height && this.nodes.size) { this.fitted = true; this.zoomToFit(); } });
          this._ro.observe(this.wrapperEl);
        }
      }
      get path() { return this.view && this.view.path; }

      /* ------------------------------------------------ document */
      clear() {
        for (const n of this.nodes.values()) n.detach();
        this.nodes.clear(); this.edges.clear(); this.selection.clear();
        this.edgeEl.textContent = "";
      }
      importData(doc) {
        this.clear();
        this.data = doc;
        for (const d of doc.nodes) this.addNode(new NODE_CLASS[d.type](this, d));
        for (const e of doc.edges) this.edges.set(e.id, e);
        this.renderEdges();
        if (window.CanvasHistory) window.CanvasHistory.record(this, "import", changed);   // goal cv-history: a newly opened document starts a clean history
      }
      // the document as it is now: the parsed root (unknown fields kept), its nodes in board order,
      // the edges whose two ends are still on the board
      getData() {
        const d = this.data;
        d.nodes = [...this.nodes.values()].map(n => n.data);
        d.edges = [...this.edges.values()].filter(e => this.nodes.has(e.fromNode) && this.nodes.has(e.toNode));
        return d;
      }
      ids() { return new Set([...this.nodes.keys(), ...this.edges.keys()]); }
      addNode(node) {
        this.nodes.set(node.id, node);
        if (node.data.type === "group") this.groupEl.appendChild(node.containerEl); else this.nodeEl.appendChild(node.containerEl);
        node.load();
        node.render();
        if (window.CanvasHistory) window.CanvasHistory.record(this, "add", changed);
        return node;
      }
      createTextNode(o) {
        o = o || {};
        const pos = o.pos || { x: 0, y: 0 }, size = o.size || {};
        const d = { id: newId(this.ids()), type: "text", text: String(o.text == null ? "" : o.text),
                    x: Math.round(pos.x), y: Math.round(pos.y), width: Math.round(size.width || 250), height: Math.round(size.height || 60) };
        const n = this.addNode(new TextNode(this, d));
        if (o.save !== false) this.requestSave();
        if (o.focus) n.startEditing();
        this.renderEdges();
        return n;
      }
      createFileNode(o) {
        o = o || {};
        const pos = o.pos || { x: 0, y: 0 }, size = o.size || {};
        const p = pathOf(o.file);
        if (!p) throw new TypeError("createFileNode: no file");
        const d = { id: newId(this.ids()), type: "file", file: p };
        if (o.subpath) d.subpath = String(o.subpath);
        Object.assign(d, { x: Math.round(pos.x), y: Math.round(pos.y), width: Math.round(size.width || 400), height: Math.round(size.height || 400) });
        const n = this.addNode(new FileNode(this, d));
        if (o.save !== false) this.requestSave();
        if (o.focus) n.startEditing();
        return n;
      }
      removeNode(node) {
        if (!node || this.nodes.get(node.id) !== node) return;
        if (node.isEditing) try { node.stopEditing(); } catch (_) {}
        this.nodes.delete(node.id);
        this.selection.delete(node);
        for (const [id, e] of [...this.edges]) if (e.fromNode === node.id || e.toNode === node.id) this.edges.delete(id);
        node.detach();
        this.renderEdges();
        this.requestSave();
        if (window.CanvasHistory) window.CanvasHistory.record(this, "remove", changed);
      }
      deleteSelection() { for (const n of [...this.selection]) this.removeNode(n); }
      select(node, add) {
        if (!add) for (const n of this.selection) if (n !== node) n.setSelected(false);
        if (!add) this.selection.clear();
        if (node) { this.selection.add(node); node.setSelected(true); }
        if (window.CanvasSelect) window.CanvasSelect.selected(this);   // goal cv-select: toolbar + bounding box follow the selection
      }
      deselectAll() { this.select(null, false); }

      /* ------------------------------------------------ edges */
      // ids (optional): re-path only the edges touching these cards; absent = every edge (canvas-perf.js may still
      // narrow a drag move to the moved cards, and falls back to everything when the layer is not the last full render)
      renderEdges(ids) {
        const g = this.edgeEl;
        const CE = window.CanvasEdges;   // goal cv-edges: handles, hit strokes, edge selection and editing (canvas-edges.js)
        const PF = window.CanvasPerf;    // goal cv-perf: partial re-render during a drag (canvas-perf.js)
        const part = PF ? PF.partial(this, ids) : null;
        if (!part) { g.textContent = ""; if (CE) CE.attach(this, { changed, colorOf, newId }); }
        // the layer spans the board's content (WebKit clips an outer <svg> to its box even with overflow: visible),
        // its viewBox in canvas coordinates so the paths keep the file's numbers
        let x0 = 0, y0 = 0, x1 = 1, y1 = 1, any = false;
        for (const n of this.nodes.values()) {
          const d = n.data; if (!any) { x0 = d.x; y0 = d.y; x1 = d.x + d.width; y1 = d.y + d.height; any = true; }
          x0 = Math.min(x0, d.x); y0 = Math.min(y0, d.y); x1 = Math.max(x1, d.x + d.width); y1 = Math.max(y1, d.y + d.height);
        }
        const P = 400; x0 -= P; y0 -= P; x1 += P; y1 += P;
        g.setAttribute("viewBox", [x0, y0, x1 - x0, y1 - y0].join(" "));
        g.setAttribute("width", String(x1 - x0)); g.setAttribute("height", String(y1 - y0));
        g.style.left = x0 + "px"; g.style.top = y0 + "px";
        for (const e of part || this.edges.values()) {
          const a = this.nodes.get(e.fromNode), b = this.nodes.get(e.toNode);
          if (!a || !b) continue;
          const fs = e.fromSide || sideFacing(a.data, b.data), ts = e.toSide || sideFacing(b.data, a.data);
          const p1 = anchorOf(a.data, fs), p2 = anchorOf(b.data, ts);
          const k = Math.max(40, Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) * 0.4);
          const c1 = [p1[0] + NORMAL[fs][0] * k, p1[1] + NORMAL[fs][1] * k], c2 = [p2[0] + NORMAL[ts][0] * k, p2[1] + NORMAL[ts][1] * k];
          const col = colorOf(e.color) || "var(--text-muted, #888)";
          const grp = sv("g", { class: "canvas-edge", "data-edge-id": e.id }, g);
          sv("path", { class: "canvas-edge-line", d: "M" + p1 + " C" + c1 + " " + c2 + " " + p2, style: "fill: none; stroke: " + col + "; stroke-width: 2px" }, grp);  // colours in style: var() is not valid in an SVG presentation attribute
          const head = (tip, from) => {
            const dx = tip[0] - from[0], dy = tip[1] - from[1], l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l;
            const bx = tip[0] - ux * 12, by = tip[1] - uy * 12;
            sv("polygon", { class: "canvas-edge-arrow", style: "fill: " + col, points: tip + " " + [bx - uy * 6, by + ux * 6] + " " + [bx + uy * 6, by - ux * 6] }, grp);
          };
          if ((e.toEnd || "arrow") === "arrow") head(p2, c2);
          if ((e.fromEnd || "none") === "arrow") head(p1, c1);
          if (e.label) {
            const mx = (p1[0] + 3 * c1[0] + 3 * c2[0] + p2[0]) / 8, my = (p1[1] + 3 * c1[1] + 3 * c2[1] + p2[1]) / 8;
            const t = sv("text", { class: "canvas-edge-label", x: String(mx), y: String(my), "text-anchor": "middle" }, grp);
            t.textContent = e.label;
          }
          if (CE) CE.paint(this, e, grp, { p1, p2, c1, c2, fs, ts });
          if (PF) PF.painted(this, e, grp, part, p1, p2, c1, c2);
        }
        if (PF) PF.rendered(this, part);
        if (CE) CE.done(this);
      }

      /* ------------------------------------------------ viewport */
      applyTransform() {
        this.canvasEl.style.transform = "translate(" + this.tx + "px," + this.ty + "px) scale(" + this.zoom + ")";
        this.wrapperEl.dataset.zoom = String(Math.round(this.zoom * 1000) / 1000);
        if (window.CanvasPerf) window.CanvasPerf.cull(this);   // goal cv-perf: off-screen cards on a big board are not painted (canvas-perf.js)
      }
      toCanvas(cx, cy) {
        const r = this.wrapperEl.getBoundingClientRect();
        return { x: (cx - r.left - this.tx) / this.zoom, y: (cy - r.top - this.ty) / this.zoom };
      }
      // canvas point -> client (screen) point: what a test drives the pointer to
      toClient(x, y) {
        const r = this.wrapperEl.getBoundingClientRect();
        return { x: r.left + this.tx + x * this.zoom, y: r.top + this.ty + y * this.zoom };
      }
      zoomAt(cx, cy, f) {
        const r = this.wrapperEl.getBoundingClientRect(), px = cx - r.left, py = cy - r.top;
        const z = Math.min(4, Math.max(0.1, this.zoom * f));
        this.tx = px - (px - this.tx) * (z / this.zoom); this.ty = py - (py - this.ty) * (z / this.zoom);
        this.zoom = z; this.applyTransform();
      }
      zoomBy(f) { const r = this.wrapperEl.getBoundingClientRect(); this.zoomAt(r.left + r.width / 2, r.top + r.height / 2, f); }
      zoomToFit() {
        const r = this.wrapperEl.getBoundingClientRect();
        if (!this.nodes.size || !r.width || !r.height) { this.tx = r.width / 2 || 0; this.ty = r.height / 2 || 0; this.zoom = 1; return this.applyTransform(); }
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const n of this.nodes.values()) { const d = n.data; x0 = Math.min(x0, d.x); y0 = Math.min(y0, d.y); x1 = Math.max(x1, d.x + d.width); y1 = Math.max(y1, d.y + d.height); }
        const pad = 40, w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
        this.zoom = Math.max(0.1, Math.min(1, (r.width - 2 * pad) / w, (r.height - 2 * pad) / h));
        this.tx = (r.width - w * this.zoom) / 2 - x0 * this.zoom; this.ty = (r.height - h * this.zoom) / 2 - y0 * this.zoom;
        this.applyTransform();
      }
      addTextAtCenter() {
        if (this.readonly) return null;
        const r = this.wrapperEl.getBoundingClientRect(), c = this.toCanvas(r.left + r.width / 2, r.top + r.height / 2);
        return this.createTextNode({ pos: { x: c.x - 125, y: c.y - 30 }, focus: true });
      }

      /* ------------------------------------------------ input */
      wire() {
        const w = this.wrapperEl;
        let drag = null;
        const S = window.CanvasSelect;   // goal cv-select: selecting, moving and resizing live in canvas-select.js
        if (S) S.install(this, changed);
        const nodeOf = t => { const c = t && t.closest ? t.closest(".canvas-node") : null; return c && this.nodes.get(c.dataset.nodeId) || null; };
        const inEditor = t => !!(t && t.closest && t.closest("textarea, .markdown-source-view, [contenteditable=true]"));
        w.addEventListener("pointerdown", e => {
          if (window.CanvasTouch && window.CanvasTouch.onPointer(this, e)) return;   // goal cv-touch: touch pointers (canvas-touch.js)
          if (e.button !== 0 && e.button !== 1) return;
          if (inEditor(e.target)) return;
          const n = nodeOf(e.target);
          w.focus({ preventScroll: true });
          if (this.readonly && n) return;
          if (S) { drag = S.down(this, e, n); if (drag) { try { w.setPointerCapture(e.pointerId); } catch (_) {} } e.preventDefault(); return; }
          const mode = n && e.target.classList.contains("canvas-node-resizer") ? "resize" : n && e.button === 0 ? "move" : "pan";
          if (n) { if (!this.selection.has(n)) this.select(n, e.shiftKey); } else this.deselectAll();
          drag = { mode, x: e.clientX, y: e.clientY, moved: false, tx: this.tx, ty: this.ty, node: n,
                   start: [...this.selection].map(s => ({ s, x: s.data.x, y: s.data.y, w: s.data.width, h: s.data.height })) };
          try { w.setPointerCapture(e.pointerId); } catch (_) {}
          e.preventDefault();
        });
        w.addEventListener("pointermove", e => {
          if (window.CanvasTouch && window.CanvasTouch.onPointer(this, e)) return;   // goal cv-touch: touch pointers (canvas-touch.js)
          if (!drag) return;
          const PF = window.CanvasPerf;   // goal cv-perf: the edge render inside this move re-paths only the moved cards' edges
          if (drag.sel) { if (PF) PF.drag(this, drag); try { S.move(this, drag, e); } finally { if (PF) PF.drag(this, null); } return; }
          const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
          if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
          drag.moved = true;
          if (drag.mode === "pan") { this.tx = drag.tx + dx; this.ty = drag.ty + dy; this.applyTransform(); return; }
          const cx = dx / this.zoom, cy = dy / this.zoom;
          if (drag.mode === "move") for (const o of drag.start) o.s.moveTo({ x: o.x + cx, y: o.y + cy });
          else { const o = drag.start.find(o => o.s === drag.node); if (o) o.s.resize({ width: o.w + cx, height: o.h + cy }); }
          if (PF) PF.drag(this, drag);
          try { this.renderEdges(drag.mode === "move" ? drag.start.map(o => o.s.id) : [drag.node.id]); } finally { if (PF) PF.drag(this, null); }
        });
        const end = e => {
          if (window.CanvasTouch && window.CanvasTouch.onPointer(this, e)) return;   // goal cv-touch: touch pointers (canvas-touch.js)
          if (!drag) return;
          const d = drag; drag = null;
          try { w.releasePointerCapture(e.pointerId); } catch (_) {}
          if (d.sel) { S.up(this, d, e); return; }
          if (d.moved && d.mode !== "pan") this.requestSave();
        };
        w.addEventListener("pointerup", end);
        w.addEventListener("pointercancel", end);
        w.addEventListener("dblclick", e => {
          if (inEditor(e.target) || this.readonly) return;
          const n = nodeOf(e.target);
          if (n) { if (n.isEditable()) n.startEditing(); return; }
          if (e.target.closest && e.target.closest(".canvas-controls")) return;
          const c = this.toCanvas(e.clientX, e.clientY);
          this.createTextNode({ pos: { x: c.x - 125, y: c.y - 30 }, focus: true });
        });
        w.addEventListener("wheel", e => {
          if (inEditor(e.target) && !(e.ctrlKey || e.metaKey)) return;
          if (window.CanvasNav && window.CanvasNav.onWheel(this, e)) return;   // goal cv-nav: shift+wheel pans sideways, space+wheel zooms
          e.preventDefault();
          if (e.ctrlKey || e.metaKey) this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.002));
          else { this.tx -= e.deltaX; this.ty -= e.deltaY; this.applyTransform(); }
        }, { passive: false });
        w.addEventListener("keydown", e => {
          if (inEditor(e.target)) return;
          if (S && S.onKey(this, e)) return;
          if ((e.key === "Delete" || e.key === "Backspace") && this.selection.size && !this.readonly) { e.preventDefault(); e.stopPropagation(); this.deleteSelection(); }
          else if (e.key === "Escape" && this.selection.size) { e.stopPropagation(); this.deselectAll(); }
        });
        // goal cv-menus: the card / board context menus, the card toolbar and explorer drops live in canvas-menus.js
        if (window.CanvasMenus) window.CanvasMenus.install(this, { X, app, deps, changed, NODE_CLASS });
      }
      destroy() { if (this._ro) this._ro.disconnect(); this._saveSoon.cancel(); this.clear(); this.view = null; }
    }

    /* ---------------------------------------------------------- the view
       The "canvas" view: state {file: path}. It reads and writes through the
       vault model when the file is in it (trusted vault: vault "modify" fires),
       else through canvas_io (restricted mode has no model). It writes ONLY
       after an edit, and only when the text changed; a file that does not
       parse is shown as an error and never written. */
    class CanvasView extends X.ItemView {
      constructor(leaf) {
        super(leaf);
        this.navigation = true; this.icon = "lucide-layout-dashboard";
        this.path = null; this.kept = {}; this.file = null; this.lastText = null; this.broken = null; this.dirty = false;
        this.contentEl.classList.add("canvas-view");
        this.canvas = new Canvas(this);
        this.contentEl.appendChild(this.canvas.wrapperEl);
        this.errorEl = null;
      }
      getViewType() { return "canvas"; }
      getDisplayText() { return this.path ? baseName(this.path) : "Canvas"; }
      // the state as given, file first: keys this view does not use (a stock leaf's viewState) go back unchanged
      getState() { return this.path ? Object.assign({ file: this.path }, this.kept) : {}; }
      async setState(state) {
        const p = state ? pathOf(state.file) : "";
        if (p && state && typeof state === "object") { const k = {}; for (const key of Object.keys(state)) if (key !== "file") k[key] = state[key]; this.kept = JSON.parse(JSON.stringify(k)); }
        if (!p || p === this.path) return;
        await this.flush();
        await this.loadPath(p);
      }
      async loadPath(p) {
        this.path = p; this.file = vaultFile(p) || { path: p, name: p.split("/").pop(), basename: baseName(p), extension: "canvas" };
        this.lastText = null; this.dirty = false;
        this.canvas.clear(); this.setError(null);
        let text;
        try { text = await io("read", p); } catch (e) { if (this.path === p) this.setError("This canvas could not be read: " + errText(e)); return; }
        if (this.path !== p) return;
        let doc;
        try { doc = parseCanvas(text); } catch (e) { this.setError("This canvas could not be opened: " + errText(e) + ". The file was left unchanged.");
          const cf = window.__osCanvasFiles;   // goal cv-files CV-020: an "Open read-only" button when only dangling edges refused it
          if (cf) try { cf.refused(this, text, { app, X, deps, model, changed }); } catch (er) { console.error("[canvas] read-only offer:", er); }
          return;
        }
        this.lastText = text;
        this.canvas.importData(doc);
        this.canvas.fitted = false;
        requestAnimationFrame(() => { const c = this.canvas; if (this.path === p && c && c.wrapperEl.getBoundingClientRect().width) { c.fitted = true; c.zoomToFit(); } changed(); });
        try { if (this.leaf && this.leaf.updateHeader) this.leaf.updateHeader(); } catch (_) {}
        changed();
      }
      setError(msg) {
        this.broken = msg;
        this.canvas.readonly = !!msg;
        if (this.errorEl) { this.errorEl.remove(); this.errorEl = null; }
        this.canvas.wrapperEl.hidden = !!msg;
        if (!msg) return;
        const box = el("div", "canvas-error", this.contentEl);
        el("div", "canvas-error-title", box).textContent = "Canvas error";
        el("div", "canvas-error-message", box).textContent = msg;
        this.errorEl = box;
        changed();
      }
      async save() {
        const p = this.path;
        if (!p || this.broken || this.lastText == null || !this.dirty) return;
        this.dirty = false;
        let text;
        try { text = serializeCanvas(this.canvas.getData()); }
        catch (e) { console.error("[canvas] not saved:", e); if (deps.notify) deps.notify("Canvas not saved — " + errText(e)); return; }
        if (text === this.lastText) return;
        const f = vaultFile(p);
        try { if (f) await app.vault.modify(f, text); else await io("write", p, text); }
        catch (e) { this.dirty = true; if (deps.notify) deps.notify("Canvas not saved — " + errText(e)); throw e; }
        this.lastText = text;
        this.saves = (this.saves || 0) + 1;    // a write that reached the file (census: [cv:...|saves=])
        changed();
      }
      async flush() { this.canvas._saveSoon.cancel(); for (const n of this.canvas.nodes.values()) if (n.isEditing) try { n.stopEditing(); } catch (_) {} await this.save(); }
      async onClose() { try { await this.flush(); } catch (e) { console.error(e); } this.canvas.destroy(); }
    }

    /* ---------------------------------------------------------- the core plugin
       app.internalPlugins.plugins.canvas. enabled (persisted, on by default)
       decides whether the "canvas" view type and the .canvas extension are
       registered; load() readies the plugin (_loaded) and registers them when it
       is enabled. views.canvas(leaf) builds a view — with or without a
       registration — so a plugin can host canvas nodes on a detached leaf. */
    const reg = () => app.viewRegistry;
    let registered = false;
    function register() {
      if (registered) return;
      const r = reg();
      if (!Object.prototype.hasOwnProperty.call(r.viewByType, "canvas")) r.registerView("canvas", plugin.views.canvas);
      if (!r.isExtensionRegistered("canvas")) r.registerExtensions(["canvas"], "canvas");
      registered = true;
    }
    function unregister() {
      if (!registered) return;
      registered = false;
      const r = reg();
      if (r.getTypeByExtension("canvas") === "canvas") r.unregisterExtensions(["canvas"]);
      if (r.viewByType.canvas === plugin.views.canvas) r.unregisterView("canvas");
    }
    const pref = deps.pref || { get: () => null, set() {} };
    const plugin = {
      id: "canvas",
      enabled: pref.get() !== false,
      _loaded: false,
      instance: { id: "canvas", name: "Canvas", description: "Lay out notes, text and links on a board (JSON Canvas files).", defaultOn: true },
      // the core view factory is tagged so the plugin-view census ([pview:]) counts community views only
      views: { canvas: Object.defineProperty(leaf => new CanvasView(leaf), Symbol.for("opensidian.coreView"), { value: true }) },
      async load() { this._loaded = true; if (this.enabled) register(); },
      async unload() { unregister(); this._loaded = false; },
      async enable() { this.enabled = true; pref.set(true); sync(); await this.load(); },
      async disable() { this.enabled = false; pref.set(false); sync(); unregister(); },
      async toggle(on) { return on ? this.enable() : this.disable(); },
    };
    const sync = () => { if (deps.config) deps.config.canvas = plugin.enabled; };
    sync();
    return { model, plugin, CanvasView, Canvas, isRegistered: () => registered };
  }

  Object.defineProperty(window, "__osCanvasFactory", {
    configurable: true, enumerable: false, writable: false,
    value: canvasFactory,
  });
})();
