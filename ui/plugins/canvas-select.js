// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* canvas selection (goal cv-select): selecting, moving and resizing cards on the
   canvas board (ui/plugins/canvas.js), written from the public help pages and the
   JSON Canvas 1.0 spec (clean room).

   Load order (index.html): canvas.js -> canvas-history.js -> canvas-cards.js ->
   canvas-select.js -> main.js. This file runs NO code at load beyond defining
   window.CanvasSelect; canvas.js calls in:
     install(canvas, changed)   once per board, from wire(): canvas.options, overlay
     down/move/up(canvas, ...)  the pointer branches of wire()
     onKey(canvas, e)           Ctrl/Cmd+A
     selected(canvas)           after every select() / deselectAll()

   What a pointer press does:
     on a card's border (7px inside it) or its corner handle -> resize those sides;
       Shift keeps the aspect ratio
     on a card                -> move the selection (a plain press on an unselected card
       selects it alone and brings it to the front: last in nodes[], last painted);
       Shift on an unselected card adds it, Shift-click on a selected one takes it out;
       Alt duplicates the selection and moves the copies; Shift locks the move to one axis;
       a moved group carries every card that lies wholly inside it
     on the empty board       -> a selection rectangle (cards wholly inside it); Shift adds
     middle button, or Space held at the press -> pan
   Moves and resizes snap to the grid (canvas.options.snapToGrid, step 20) and to the
   edges / centres of nearby cards (snapToObjects; wins over the grid); holding Space
   while dragging suspends snapping. canvas.options = {snapToGrid, snapToObjects, readOnly}
   is the contract shared with cv-nav (created only when absent).

   The selection toolbar floats above the selection's bounding box: remove, colour (a
   palette of the six preset colours + clear), zoom to selection, edit (one editable card). */
(function () {
  "use strict";
  const GRID = 20;            // grid step, canvas units
  const EDGE = 7;             // border hit zone, client px (inside the card)
  const SNAP = 8;             // snap distance, client px
  const MINW = 40, MINH = 30; // as canvas.js resize()
  const COLORS = [["1", "Red", "var(--color-red, #e93147)"], ["2", "Orange", "var(--color-orange, #ec7500)"],
                  ["3", "Yellow", "var(--color-yellow, #e0ac00)"], ["4", "Green", "var(--color-green, #08b94e)"],
                  ["5", "Cyan", "var(--color-cyan, #00bfbc)"], ["6", "Purple", "var(--color-purple, #7852ee)"]];
  let space = false, styled = false;

  const S = c => c._cvs;
  const el = (tag, cls, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; if (parent) parent.appendChild(e); return e; };
  const notify = c => { const s = S(c); if (s && s.changed) try { s.changed(); } catch (_) {} };
  const isGroup = n => n && n.data && n.data.type === "group";
  const box = d => ({ x: d.x, y: d.y, w: d.width, h: d.height });
  const inside = (a, g) => a.x >= g.x && a.y >= g.y && a.x + a.w <= g.x + g.w && a.y + a.h <= g.y + g.h;
  const ro = c => !!(c.readonly || (c.options && c.options.readOnly));

  function style() {
    if (styled) return; styled = true;
    const s = document.createElement("style");
    s.dataset.owner = "canvas-select";
    s.textContent = [
      ".canvas-selection { position: absolute; box-sizing: border-box; pointer-events: none; border: 1px dashed var(--interactive-accent, #7f6df2); border-radius: 4px }",
      ".canvas-selection[hidden], .canvas-selection-toolbar[hidden], .canvas-selection-palette[hidden], .canvas-selection-marquee[hidden] { display: none }",
      ".canvas-selection-marquee { position: absolute; box-sizing: border-box; pointer-events: none; z-index: 3; border: 1px solid var(--interactive-accent, #7f6df2); background: color-mix(in srgb, var(--interactive-accent, #7f6df2) 15%, transparent) }",
      ".canvas-selection-toolbar { position: absolute; z-index: 3; display: flex; gap: 2px; padding: 3px; border-radius: 6px; background: var(--background-secondary, #262626); border: 1px solid var(--background-modifier-border, #444); box-shadow: 0 2px 8px rgba(0,0,0,.3) }",
      ".canvas-selection-toolbar > button { min-width: 28px; height: 26px; padding: 0 6px; cursor: pointer }",
      ".canvas-selection-palette { position: absolute; z-index: 3; display: flex; gap: 4px; padding: 4px; border-radius: 6px; background: var(--background-secondary, #262626); border: 1px solid var(--background-modifier-border, #444) }",
      ".canvas-selection-palette > button { width: 22px; height: 22px; padding: 0; border-radius: 50%; cursor: pointer; border: 1px solid var(--background-modifier-border, #555) }",
      ".canvas-node.is-selected .canvas-node-resizer { background: var(--interactive-accent, #7f6df2); border-radius: 2px }",
    ].join("\n");
    document.head.appendChild(s);
    window.addEventListener("keydown", e => { if (e.key === " " || e.code === "Space") space = true; }, true);
    window.addEventListener("keyup", e => { if (e.key === " " || e.code === "Space") space = false; }, true);
    window.addEventListener("blur", () => { space = false; });
  }

  /* ---------------------------------------------- install (from wire(), once per board) */
  function install(c, changed) {
    if (c._cvs) { if (typeof changed === "function") c._cvs.changed = changed; return c._cvs; }
    style();
    c.options = c.options || { snapToGrid: true, snapToObjects: true, readOnly: false };   // shared contract (cv-nav reads it)
    const s = c._cvs = { changed: typeof changed === "function" ? changed : null, raf: 0, palette: false };
    s.boxEl = el("div", "canvas-selection", c.canvasEl); s.boxEl.hidden = true;
    s.marqEl = el("div", "canvas-selection-marquee", c.wrapperEl); s.marqEl.hidden = true;
    s.tbEl = el("div", "canvas-selection-toolbar", c.wrapperEl); s.tbEl.hidden = true;
    s.palEl = el("div", "canvas-selection-palette", c.wrapperEl); s.palEl.hidden = true;
    const stop = e => e.stopPropagation();
    for (const x of [s.tbEl, s.palEl]) { x.addEventListener("pointerdown", stop); x.addEventListener("dblclick", stop); x.addEventListener("wheel", stop); }
    const btn = (parent, name, label, txt, fn) => {
      const b = el("button", "canvas-selection-btn mod-" + name, parent);
      b.type = "button"; b.textContent = txt; b.title = label; b.setAttribute("aria-label", label); b.dataset.action = name;
      b.addEventListener("click", e => { e.stopPropagation(); fn(); });
      return b;
    };
    s.btn = {
      remove: btn(s.tbEl, "remove", "Remove", "\u{1F5D1}", () => { s.palette = false; if (!ro(c)) c.deleteSelection(); refresh(c); notify(c); }),
      color: btn(s.tbEl, "color", "Set color", "◐", () => { s.palette = !s.palette; refresh(c); notify(c); }),
      zoom: btn(s.tbEl, "zoom", "Zoom to selection", "⤢", () => { zoomToSelection(c); }),
      edit: btn(s.tbEl, "edit", "Edit", "✎", () => { const n = only(c); s.palette = false; if (n && n.isEditable() && !ro(c)) n.startEditing(); refresh(c); notify(c); }),
    };
    s.pal = {};
    for (const [k, name, css] of COLORS) { const b = btn(s.palEl, "color-" + k, name, "", () => setColor(c, k)); b.style.background = css; s.pal[k] = b; }
    s.pal.clear = btn(s.palEl, "color-clear", "No color", "✕", () => setColor(c, ""));
    // the overlay follows the view (pan / zoom) and the document (remove, undo rebuild)
    const at = c.applyTransform, rs = c.requestSave;
    c.applyTransform = function () { const r = at.apply(this, arguments); refresh(c); return r; };
    c.requestSave = function () { const r = rs.apply(this, arguments); refresh(c); return r; };
    return s;
  }
  const only = c => c.selection.size === 1 ? [...c.selection][0] : null;

  function setColor(c, k) {
    const s = S(c); s.palette = false;
    if (!ro(c)) for (const n of c.selection) if ((n.data.color || "") !== k) n.setColor(k);
    refresh(c); notify(c);
  }
  function bboxOf(nodes) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) { const d = n.data; x0 = Math.min(x0, d.x); y0 = Math.min(y0, d.y); x1 = Math.max(x1, d.x + d.width); y1 = Math.max(y1, d.y + d.height); }
    return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  function zoomToSelection(c) {
    const b = bboxOf(c.selection), r = c.wrapperEl.getBoundingClientRect();
    if (!b || !r.width || !r.height) return;
    const pad = 60;
    c.zoom = Math.max(0.1, Math.min(2, (r.width - 2 * pad) / Math.max(1, b.w), (r.height - 2 * pad) / Math.max(1, b.h)));
    c.tx = r.width / 2 - (b.x + b.w / 2) * c.zoom; c.ty = r.height / 2 - (b.y + b.h / 2) * c.zoom;
    c.applyTransform(); notify(c);
  }

  /* ---------------------------------------------- the overlay: bounding box + toolbar + palette */
  function refresh(c) {
    const s = S(c); if (!s) return;
    for (const n of [...c.selection]) if (c.nodes.get(n.id) !== n) c.selection.delete(n);   // gone (removed / rebuilt)
    const b = bboxOf(c.selection);
    if (!b) { s.boxEl.hidden = true; s.tbEl.hidden = true; s.palEl.hidden = true; s.palette = false; return; }
    const P = 6;
    Object.assign(s.boxEl.style, { left: (b.x - P) + "px", top: (b.y - P) + "px", width: (b.w + 2 * P) + "px", height: (b.h + 2 * P) + "px" });
    s.boxEl.hidden = false;
    const one = only(c);
    s.btn.edit.hidden = !(one && one.isEditable());
    s.tbEl.hidden = !!ro(c);
    if (s.tbEl.hidden) { s.palEl.hidden = true; return; }
    // client -> wrapper-local: the toolbar sits centred above the box, inside the board
    const z = c.zoom, lx = c.tx + (b.x - P) * z, ly = c.ty + (b.y - P) * z, lw = (b.w + 2 * P) * z;
    const W = c.wrapperEl.clientWidth || 0, tw = s.tbEl.offsetWidth || 140, th = s.tbEl.offsetHeight || 32;
    const left = Math.max(4, Math.min(Math.max(4, W - tw - 4), lx + lw / 2 - tw / 2));
    const top = Math.max(4, ly - th - 8);
    s.tbEl.style.left = left + "px"; s.tbEl.style.top = top + "px";
    s.palEl.hidden = !s.palette;
    if (s.palette) { s.palEl.style.left = left + "px"; s.palEl.style.top = (top - (s.palEl.offsetHeight || 32) - 4 < 4 ? top + th + 4 : top - (s.palEl.offsetHeight || 32) - 4) + "px"; }
  }

  /* ---------------------------------------------- selection */
  function selected(c) { const s = S(c); if (!s) return; s.palette = false; refresh(c); notify(c); }
  // the card goes to the top of the stack: last in nodes[] (the file's paint order) and last painted.
  // Groups keep their own layer under the edges and the cards.
  function toFront(c, n) {
    if (!n || isGroup(n) || ro(c)) return;
    const ids = [...c.nodes.keys()];
    if (ids[ids.length - 1] === n.id && c.nodeEl.lastElementChild === n.containerEl) return;
    c.nodes.delete(n.id); c.nodes.set(n.id, n);
    c.nodeEl.appendChild(n.containerEl);
    c.requestSave();
  }
  function selectAll(c) {
    c.deselectAll();
    for (const n of c.nodes.values()) c.select(n, true);
  }

  /* ---------------------------------------------- pointer */
  function sidesAt(n, e) {
    if (e.target && e.target.classList && e.target.classList.contains("canvas-node-resizer")) return { r: 1, b: 1 };
    if (e.target && e.target.closest && e.target.closest(".canvas-node-label")) return null;
    const r = n.containerEl.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    if (px < 0 || py < 0 || px > r.width || py > r.height) return null;
    const ez = Math.min(EDGE, r.width / 4, r.height / 4);
    const s = { l: px < ez ? 1 : 0, r: px > r.width - ez ? 1 : 0, t: py < ez ? 1 : 0, b: py > r.height - ez ? 1 : 0 };
    return s.l || s.r || s.t || s.b ? s : null;
  }
  function freshId(taken) {
    for (;;) {
      let s = "";
      for (let i = 0; i < 16; i++) s += "0123456789abcdef"[Math.floor(Math.random() * 16)];
      if (!taken.has(s)) { taken.add(s); return s; }
    }
  }
  // Alt-drag: copies of the selection (new ids, the edges between them re-pointed) become the selection
  function duplicateForDrag(c) {
    const src = [...c.selection]; if (!src.length) return;
    const taken = c.ids(), map = new Map(), made = [];
    for (const n of src) {
      const d = JSON.parse(JSON.stringify(n.data));
      d.id = freshId(taken); map.set(n.id, d.id);
      const Cls = Object.getPrototypeOf(n).constructor;
      made.push(c.addNode(new Cls(c, d)));
    }
    for (const e of [...c.edges.values()]) {
      if (!map.has(e.fromNode) || !map.has(e.toNode)) continue;
      const d = JSON.parse(JSON.stringify(e));
      d.id = freshId(taken); d.fromNode = map.get(e.fromNode); d.toNode = map.get(e.toNode);
      c.edges.set(d.id, d);
    }
    c.deselectAll();
    for (const n of made) c.select(n, true);
    c.renderEdges();
  }

  // returns the drag state canvas.js keeps for move/up, or null (nothing to track)
  function down(c, e, n) {
    const s = S(c) || install(c);
    s.palette = false;
    const base = { sel: true, x: e.clientX, y: e.clientY, moved: false, tx: c.tx, ty: c.ty, node: n };
    if (e.button === 1 || (e.button === 0 && space)) { refresh(c); return Object.assign(base, { mode: "pan" }); }
    if (!n) {
      const keep = e.shiftKey ? new Set(c.selection) : null;
      if (!keep) c.deselectAll(); else refresh(c);
      return Object.assign(base, { mode: "marquee", keep, rect: c.wrapperEl.getBoundingClientRect() });
    }
    if (ro(c)) return null;
    const sides = sidesAt(n, e);
    let toggleOff = false, collapse = false;
    if (!c.selection.has(n)) { c.select(n, e.shiftKey); if (!e.shiftKey) toFront(c, n); }
    else if (e.shiftKey && !sides) toggleOff = true;          // decided on release: a shift-DRAG keeps it
    else if (!e.shiftKey && !sides) { toFront(c, n); collapse = c.selection.size > 1; }   // a plain CLICK (no drag) selects it alone
    if (sides) {
      if (!c.selection.has(n)) c.select(n, false);
      return Object.assign(base, { mode: "resize", sides, start: box(n.data), ratio: n.data.width / Math.max(1, n.data.height) });
    }
    return Object.assign(base, { mode: "move", toggleOff, collapse, alt: !!e.altKey, start: null });
  }
  function beginMove(c, d) {
    if (d.alt && !ro(c)) duplicateForDrag(c);
    const moving = new Set(c.selection);
    for (const g of [...moving]) if (isGroup(g)) {           // a group carries every card wholly inside it
      const gb = box(g.data);
      for (const m of c.nodes.values()) if (!moving.has(m) && inside(box(m.data), gb)) moving.add(m);
    }
    d.start = [...moving].map(m => ({ m, x: m.data.x, y: m.data.y }));
    const prim = d.node && moving.has(d.node) ? d.node : [...c.selection][0] || (d.alt ? [...c.selection][0] : null);
    d.prim = prim;
    d.pb = prim ? box(prim.data) : null;
    d.others = [...c.nodes.values()].filter(m => !moving.has(m)).map(m => box(m.data));
  }
  // snap one axis: lo = the moving box's low edge, len its length, lines = the other boxes' edges on that axis
  function snapAxis(c, lo, len, lines) {
    const o = c.options || {};
    if (o.snapToObjects !== false && lines.length) {
      const T = SNAP / (c.zoom || 1);
      let best = null;
      for (const L of lines) for (const off of [0, len / 2, len]) { const dd = L - (lo + off); if (Math.abs(dd) <= T && (!best || Math.abs(dd) < Math.abs(best))) best = dd; }
      if (best !== null) return lo + best;
    }
    if (o.snapToGrid !== false) return Math.round(lo / GRID) * GRID;
    return lo;
  }
  const xLines = bs => bs.flatMap(b => [b.x, b.x + b.w / 2, b.x + b.w]);
  const yLines = bs => bs.flatMap(b => [b.y, b.y + b.h / 2, b.y + b.h]);
  function snapEdge(c, v, lines) {     // one edge (resize): to a nearby card edge, else to the grid
    const o = c.options || {};
    if (o.snapToObjects !== false) {
      const T = SNAP / (c.zoom || 1); let best = null;
      for (const L of lines) { const dd = L - v; if (Math.abs(dd) <= T && (best === null || Math.abs(dd) < Math.abs(best))) best = dd; }
      if (best !== null) return v + best;
    }
    return o.snapToGrid !== false ? Math.round(v / GRID) * GRID : v;
  }

  function move(c, d, e) {
    const dxp = e.clientX - d.x, dyp = e.clientY - d.y;
    if (!d.moved && Math.abs(dxp) + Math.abs(dyp) < 3) return;
    const first = !d.moved; d.moved = true;
    const s = S(c);
    if (d.mode === "pan") { c.tx = d.tx + dxp; c.ty = d.ty + dyp; c.applyTransform(); return; }
    if (d.mode === "marquee") {
      const r = d.rect, x0 = Math.min(d.x, e.clientX), y0 = Math.min(d.y, e.clientY), x1 = Math.max(d.x, e.clientX), y1 = Math.max(d.y, e.clientY);
      Object.assign(s.marqEl.style, { left: (x0 - r.left) + "px", top: (y0 - r.top) + "px", width: (x1 - x0) + "px", height: (y1 - y0) + "px" });
      s.marqEl.hidden = false;
      const a = c.toCanvas(x0, y0), b = c.toCanvas(x1, y1), q = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
      const want = new Set(d.keep || []);
      for (const n of c.nodes.values()) if (inside(box(n.data), q)) want.add(n);
      const same = want.size === c.selection.size && [...want].every(n => c.selection.has(n));
      if (!same) {
        for (const n of c.selection) if (!want.has(n)) n.setSelected(false);
        c.selection.clear();
        for (const n of c.nodes.values()) if (want.has(n)) { c.selection.add(n); n.setSelected(true); }
        selected(c);
      }
      return;
    }
    const z = c.zoom || 1, snapOn = !space;
    if (d.mode === "move") {
      if (first) beginMove(c, d);
      let dx = dxp / z, dy = dyp / z;
      let lockX = false, lockY = false;
      if (e.shiftKey) { if (Math.abs(dxp) >= Math.abs(dyp)) { dy = 0; lockY = true; } else { dx = 0; lockX = true; } }
      if (snapOn && d.pb) {
        const p = d.pb;
        if (!lockX) dx = snapAxis(c, p.x + dx, p.w, xLines(d.others)) - p.x;
        if (!lockY) dy = snapAxis(c, p.y + dy, p.h, yLines(d.others)) - p.y;
      }
      dx = Math.round(dx); dy = Math.round(dy);
      for (const o of d.start) o.m.moveTo({ x: o.x + dx, y: o.y + dy });
    } else if (d.mode === "resize") {
      const n = d.node, st = d.start, sd = d.sides;
      const dx = dxp / z, dy = dyp / z;
      let x0 = st.x, y0 = st.y, x1 = st.x + st.w, y1 = st.y + st.h;
      if (sd.l) x0 += dx; if (sd.r) x1 += dx; if (sd.t) y0 += dy; if (sd.b) y1 += dy;
      if (e.shiftKey) {                                       // keep the aspect ratio
        let w = x1 - x0, h = y1 - y0; const R = d.ratio;
        const horiz = sd.l || sd.r, vert = sd.t || sd.b;
        if (horiz && !vert) h = w / R;
        else if (vert && !horiz) w = h * R;
        else if (Math.abs(w / st.w - 1) >= Math.abs(h / st.h - 1)) h = w / R; else w = h * R;
        if (w < MINW) { w = MINW; h = w / R; } if (h < MINH) { h = MINH; w = h * R; }
        if (sd.l) x0 = x1 - w; else x1 = x0 + w;
        if (sd.t) y0 = y1 - h; else y1 = y0 + h;
      } else {
        if (snapOn) {
          const others = [...c.nodes.values()].filter(m => m !== n && !(isGroup(n) && inside(box(m.data), st))).map(m => box(m.data));
          const xl = others.flatMap(b => [b.x, b.x + b.w]), yl = others.flatMap(b => [b.y, b.y + b.h]);
          if (sd.l) x0 = snapEdge(c, x0, xl); if (sd.r) x1 = snapEdge(c, x1, xl);
          if (sd.t) y0 = snapEdge(c, y0, yl); if (sd.b) y1 = snapEdge(c, y1, yl);
        }
        if (x1 - x0 < MINW) { if (sd.l) x0 = x1 - MINW; else x1 = x0 + MINW; }
        if (y1 - y0 < MINH) { if (sd.t) y0 = y1 - MINH; else y1 = y0 + MINH; }
      }
      const X0 = Math.round(x0), Y0 = Math.round(y0);
      n.data.x = X0; n.data.y = Y0; n.data.width = Math.round(x1) - X0; n.data.height = Math.round(y1) - Y0;
      n.place();
    }
    c.renderEdges();
    refresh(c);
  }
  function up(c, d) {
    const s = S(c);
    if (d.mode === "marquee") { s.marqEl.hidden = true; refresh(c); notify(c); return; }
    if (d.mode === "pan") return;
    if (d.mode === "move" && !d.moved && d.toggleOff && d.node) {   // shift-click on a selected card: out of the selection
      c.selection.delete(d.node); d.node.setSelected(false); selected(c); return;
    }
    if (d.mode === "move" && !d.moved && d.collapse && d.node) { c.deselectAll(); c.select(d.node, false); return; }
    if (d.moved) c.requestSave();
    refresh(c); notify(c);
  }

  /* ---------------------------------------------- keys */
  const inEditor = t => !!(t && t.closest && t.closest("textarea, input, .markdown-source-view, [contenteditable=true]"));
  function onKey(c, e) {
    if (inEditor(e.target)) return false;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === "a") {
      e.preventDefault(); e.stopPropagation(); selectAll(c); return true;
    }
    if (e.key === " " && !e.ctrlKey && !e.metaKey) { e.preventDefault(); return false; }   // Space: pan / no-snap modifier, never a scroll
    return false;
  }

  /* ---------------------------------------------- census (main.js canvasTok) */
  function census(v) {
    const c = v && v.canvas, s = c && S(c); if (!c) return "";
    const esc = x => String(x).replace(/[[\]|@,]/g, "_");
    const vis = x => !!x && !x.hidden && x.getClientRects().length > 0;
    const ctr = x => { const r = x.getBoundingClientRect(); return Math.round(r.x + r.width / 2) + "," + Math.round(r.y + r.height / 2); };
    const rc = x => { const r = x.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round).join(","); };
    let t = " [cvsel:n=" + c.selection.size + "]";
    t += " [cvz:" + [...c.nodeEl.children].map(x => x.dataset && x.dataset.nodeId).filter(Boolean).slice(0, 24).map(esc).join(",") + "]";
    const o = c.options || {};
    t += " [cvopt:grid=" + (o.snapToGrid !== false ? 1 : 0) + "|obj=" + (o.snapToObjects !== false ? 1 : 0) + "|step=" + GRID + "]";
    if (!s) return t;
    if (vis(s.boxEl)) t += " [cvbox:" + rc(s.boxEl) + "]";
    if (vis(s.tbEl)) {
      const bs = Object.keys(s.btn).filter(k => vis(s.btn[k]));
      t += " [cvstb:" + bs.join("|") + "@" + ctr(s.tbEl) + "]";
      t += " [cvstbb:" + bs.map(k => k + "@" + ctr(s.btn[k])).join("|") + "]";
    }
    if (vis(s.palEl)) t += " [cvpal:" + Object.keys(s.pal).filter(k => vis(s.pal[k])).map(k => k + "@" + ctr(s.pal[k])).join("|") + "]";
    return t;
  }

  const api = { install, down, move, up, onKey, selected, selectAll, zoomToSelection, refresh, census, GRID };
  Object.defineProperty(window, "CanvasSelect", { configurable: true, enumerable: false, writable: false, value: Object.freeze(api) });
})();
