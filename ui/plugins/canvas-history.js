// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* canvas history (goal cv-history): undo/redo, copy/paste and duplicate for the
   canvas board (ui/plugins/canvas.js), written from the public help pages
   (clean room).

   Load order (index.html): canvas.js -> canvas-history.js -> main.js. This file
   runs NO code at load beyond defining window.CanvasHistory.

   THE CHANGE PATH. canvas.js calls CanvasHistory.record(canvas, kind) from its
   three mutators (importData, addNode, removeNode). The first call installs
   history on that board: requestSave() is wrapped, keys and the two control
   buttons are added. A step is a SNAPSHOT of the document (getData(), as JSON):
   every edit that ends in requestSave() — a drag, a resize, a text edit, an add,
   a delete, an edge or colour change from any other file — commits one step,
   and everything one event does (a multi-card delete) collapses into ONE step
   because the commit runs on a microtask. importData resets the history (a newly
   opened file starts clean) unless it is history itself rebuilding the board.
   Undo/redo rebuild the board from the snapshot and save, so the file on disk
   follows; unknown fields ride along inside the snapshot untouched.

   Copy keeps the selected cards and the edges whose two ends are both selected;
   paste and duplicate give every card and edge a new id and re-point the copied
   edges at the copies. */
(function () {
  "use strict";
  /* gh-icons #20: monochrome inline svg icons (drawn for this app, currentColor) in place of
     text pictographs / emoji; class "gi" sizes them (style.css / plugins.css) */
  const I = d => '<svg class="gi" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + d + "</svg>";
  const GI = {
    undo: I('<path d="M5.5 4l-3 3 3 3"/><path d="M2.5 7H9a3.5 3.5 0 0 1 0 7H7"/>'),
    redo: I('<path d="M10.5 4l3 3-3 3"/><path d="M13.5 7H7a3.5 3.5 0 0 0 0 7h2"/>'),
  };
  const LIMIT = 100;                       // steps kept per board
  const OFFSET = 30;                       // duplicate / paste-without-pointer offset, canvas px
  let clip = null;                         // {nodes, edges}: the last copy (app-wide, so it pastes into another canvas too)
  let active = null;                       // the board the user last touched (the command acts on it)

  // the document as getData() would give it, WITHOUT getData's in-place write to c.data (during importData
  // that write would replace the doc.edges array the import is about to read): same keys, same order
  const snap = c => JSON.stringify(Object.assign({}, c.data, {
    nodes: [...c.nodes.values()].map(n => n.data),
    edges: [...c.edges.values()].filter(e => c.nodes.has(e.fromNode) && c.nodes.has(e.toNode)),
  }));
  const H = c => c._cvh;

  function install(c, notify) {
    if (c._cvh) { if (typeof notify === "function") c._cvh.notify = notify; return c._cvh; }
    const h = c._cvh = { undo: [], redo: [], last: snap(c), busy: false, queued: false, pointer: null, btn: {}, notify: typeof notify === "function" ? notify : null };
    const orig = c.requestSave;
    c.requestSave = function () { const r = orig.apply(this, arguments); schedule(c); return r; };
    const w = c.wrapperEl;
    const mark = () => { active = c; };
    w.addEventListener("pointerdown", mark, true);
    w.addEventListener("pointerup", () => { if (h.notify) requestAnimationFrame(() => { try { h.notify(); } catch (_) {} }); });   // a click changed the selection ([cvhsel:])
    w.addEventListener("focusin", mark);
    w.addEventListener("pointermove", e => { h.pointer = { x: e.clientX, y: e.clientY }; });
    w.addEventListener("pointerleave", () => { h.pointer = null; });
    w.addEventListener("keydown", e => onKey(c, e));
    if (c.controlsEl) {
      const btn = (cls, label, txt, fn) => {
        const b = document.createElement("button");
        b.className = "canvas-control " + cls; b.type = "button"; b.innerHTML = txt; b.title = label; b.setAttribute("aria-label", label);
        b.addEventListener("pointerdown", e => e.stopPropagation());
        b.addEventListener("click", e => { e.stopPropagation(); fn(); });
        c.controlsEl.insertBefore(b, c.controlsEl.firstChild ? c.controlsEl.firstChild.nextSibling : null);
        return b;
      };
      // after "+ Text", before the zoom buttons: redo inserted first, then undo in front of it
      h.btn.redo = btn("mod-redo", "Redo", GI.redo, () => redo(c));
      h.btn.undo = btn("mod-undo", "Undo", GI.undo, () => undo(c));
      paint(c);
    }
    registerCommands(c.app);
    return h;
  }
  function paint(c) {
    const h = H(c); if (!h || !h.btn.undo) return;
    h.btn.undo.disabled = !h.undo.length || c.readonly;
    h.btn.redo.disabled = !h.redo.length || c.readonly;
    if (h.notify) try { h.notify(); } catch (_) {}   // the host republishes its census
  }
  function schedule(c) {
    const h = H(c); if (!h || h.queued) return;
    h.queued = true;
    queueMicrotask(() => { h.queued = false; commit(c); });
  }
  function commit(c) {
    const h = H(c); if (!h || h.busy || c.readonly) return;
    const s = snap(c);
    if (s === h.last) return;
    h.undo.push(h.last); if (h.undo.length > LIMIT) h.undo.shift();
    h.redo.length = 0;
    h.last = s;
    paint(c);
  }

  /* the board becomes snapshot s (undo / redo / paste): rebuilt, then saved */
  function rebuild(c, doc) {
    const h = H(c);
    h.busy = true;
    try { c.importData(doc); } finally { h.busy = false; }
  }
  function restore(c, s) {
    const h = H(c);
    const keep = [...c.selection].map(n => n.id);         // the selection outlives the rebuild (CVR-A-114)
    rebuild(c, JSON.parse(s));
    c.deselectAll();
    for (const id of keep) { const n = c.nodes.get(id); if (n) c.select(n, true); }
    h.last = snap(c);
    h.busy = true;
    try { c.requestSave(); } finally { h.busy = false; }
    paint(c);
  }
  function undo(c) {
    const h = H(c); if (!h || c.readonly) return false;
    commit(c);                                             // a pending edit is a step of its own
    if (!h.undo.length) return false;
    h.redo.push(h.last);
    restore(c, h.undo.pop());
    return true;
  }
  function redo(c) {
    const h = H(c); if (!h || c.readonly || !h.redo.length) return false;
    h.undo.push(h.last);
    restore(c, h.redo.pop());
    return true;
  }

  /* ---------------------------------------------- copy / paste / duplicate */
  function copy(c) {
    if (!c.selection.size) return false;
    const ids = new Set([...c.selection].map(n => n.id));
    clip = {
      nodes: [...c.selection].map(n => JSON.parse(JSON.stringify(n.data))),
      edges: [...c.edges.values()].filter(e => ids.has(e.fromNode) && ids.has(e.toNode)).map(e => JSON.parse(JSON.stringify(e))),
    };
    return true;
  }
  function freshId(taken) {
    for (;;) {
      let s = "";
      for (let i = 0; i < 16; i++) s += "0123456789abcdef"[Math.floor(Math.random() * 16)];
      if (!taken.has(s)) { taken.add(s); return s; }
    }
  }
  // put copies of {nodes, edges} on the board, their bounding box's top-left at (x, y) when given, else offset
  function place(c, src, at) {
    if (c.readonly || !src || !src.nodes.length) return false;
    commit(c);
    const doc = JSON.parse(snap(c));
    const taken = new Set([...doc.nodes.map(n => n.id), ...doc.edges.map(e => e.id)]);
    let dx = OFFSET, dy = OFFSET;
    if (at) {
      const x0 = Math.min(...src.nodes.map(n => n.x)), y0 = Math.min(...src.nodes.map(n => n.y));
      dx = Math.round(at.x - x0); dy = Math.round(at.y - y0);
    }
    const map = new Map();
    for (const n of src.nodes) {
      const d = JSON.parse(JSON.stringify(n));
      d.id = freshId(taken); map.set(n.id, d.id);
      d.x = Math.round(n.x + dx); d.y = Math.round(n.y + dy);
      doc.nodes.push(d);
    }
    for (const e of src.edges) {
      if (!map.has(e.fromNode) || !map.has(e.toNode)) continue;
      const d = JSON.parse(JSON.stringify(e));
      d.id = freshId(taken); d.fromNode = map.get(e.fromNode); d.toNode = map.get(e.toNode);
      doc.edges.push(d);
    }
    rebuild(c, doc);
    c.deselectAll();
    for (const id of map.values()) { const n = c.nodes.get(id); if (n) c.select(n, true); }
    c.requestSave();                                       // commits the step (the wrapped requestSave)
    return true;
  }
  function paste(c) {
    if (!clip) return false;
    const h = H(c), p = h && h.pointer;
    let at = null;
    if (p) { const r = c.wrapperEl.getBoundingClientRect(); if (p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom) at = c.toCanvas(p.x, p.y); }
    return place(c, clip, at);
  }
  function duplicate(c) {
    if (!c || !c.selection.size || c.readonly) return false;
    const ids = new Set([...c.selection].map(n => n.id));
    return place(c, {
      nodes: [...c.selection].map(n => n.data),
      edges: [...c.edges.values()].filter(e => ids.has(e.fromNode) && ids.has(e.toNode)),
    }, null);
  }

  /* ---------------------------------------------- keys + commands */
  const inEditor = t => !!(t && t.closest && t.closest("textarea, input, .markdown-source-view, [contenteditable=true]"));
  function onKey(c, e) {
    if (inEditor(e.target) || !(e.ctrlKey || e.metaKey) || e.altKey) return false;
    const k = String(e.key).toLowerCase();
    let done;
    if (k === "z" && !e.shiftKey) done = (undo(c), true);
    else if ((k === "z" && e.shiftKey) || (k === "y" && !e.shiftKey)) done = (redo(c), true);
    else if (k === "c" && !e.shiftKey && c.selection.size) { done = copy(c); if (done && window.CanvasDrop) window.CanvasDrop.mirror(c); }   // goal cvf-drop: the copy also goes to the OS clipboard
    else if (k === "v" && !e.shiftKey && window.CanvasDrop && window.CanvasDrop.pasteKey(c)) { e.stopPropagation(); return true; }   // goal cvf-drop: the OS clipboard wins; no preventDefault, the paste must still land in canvas-drop.js's catcher
    else if (k === "v" && !e.shiftKey && clip) done = (paste(c), true);
    if (!done) return false;
    e.preventDefault(); e.stopPropagation();
    return true;
  }
  const live = c => !!(c && c.view && c.wrapperEl.isConnected && c.wrapperEl.getClientRects().length);
  let cmdsDone = false;
  function registerCommands(app) {
    if (cmdsDone || !app || !app.commands || typeof app.commands.addCommand !== "function") return;
    cmdsDone = true;
    try {
      app.commands.addCommand({ id: "canvas:duplicate-selection", name: "Canvas: Duplicate selection",
        checkCallback: chk => { const c = active; if (!live(c) || !c.selection.size || c.readonly) return false; if (!chk) duplicate(c); return true; } });
      app.commands.addCommand({ id: "canvas:undo", name: "Canvas: Undo",
        checkCallback: chk => { const c = active, h = live(c) && H(c); if (!h || !h.undo.length || c.readonly) return false; if (!chk) undo(c); return true; } });
      app.commands.addCommand({ id: "canvas:redo", name: "Canvas: Redo",
        checkCallback: chk => { const c = active, h = live(c) && H(c); if (!h || !h.redo.length || c.readonly) return false; if (!chk) redo(c); return true; } });
    } catch (e) { cmdsDone = false; console.error("[canvas] history commands:", e); }
  }

  /* canvas.js -> here, once per mutator call: kind "import" | "add" | "remove", notify = the host's census republish */
  function record(c, kind, notify) {
    if (!c) return;
    const h = install(c, notify);
    if (kind === "import") {
      if (h.busy) return;                                  // history rebuilding the board
      h.undo.length = 0; h.redo.length = 0; h.queued = false; h.last = snap(c);
      paint(c);
      return;
    }
    if (!h.busy) schedule(c);
  }

  const api = {
    record, undo, redo, copy, paste, duplicate, onKey,
    // census (main.js canvasTok): {u, r} depths, or null when the board has no history yet
    state(c) { const h = c && H(c); return h ? { u: h.undo.length, r: h.redo.length, undoEl: h.btn.undo || null, redoEl: h.btn.redo || null } : null; },
  };
  Object.defineProperty(window, "CanvasHistory", { configurable: true, enumerable: false, writable: false, value: Object.freeze(api) });
})();
