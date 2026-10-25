// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* canvas arrange (goal cv-arrange): tidy a selection of cards on the canvas board
   (ui/plugins/canvas.js) with one command — align, distribute, arrange in a
   row / column / grid, justify. Written from the public help page and the JSON
   Canvas 1.0 spec (clean room).

   Load order (index.html): canvas.js -> canvas-history.js -> canvas-cards.js ->
   canvas-select.js -> canvas-arrange.js -> main.js. canvas.js does not call in:
   this file registers its commands itself (app.commands.addCommand) once the
   page has loaded (main.js's command registry exists only then), and acts on the
   canvas the user is looking at: the active leaf when it is a canvas, else the
   visible canvas view. Every command works on canvas.selection (cv-select).

   THE CHANGE PATH. A command moves / resizes the selected cards through the
   node's own moveTo() / resize() (they round to whole canvas units and keep
   every other field of the node) and then calls canvas.requestSave() ONCE, so
   the file on disk follows and cv-history records the whole tidy as one undo
   step. A read-only board (canvas.readonly / options.readOnly) is left alone.

   What each command does with the selection's bounding box B:
     Align left / centre / right       x  = B.left / centre on B's centre / right edge on B.right
     Align top / middle / bottom       y  = B.top  / centre on B's middle / bottom edge on B.bottom
     Distribute horizontally / vert.   the first and the last card (by x / by y) stay; the others
                                       move so that every gap between neighbours is the same
     Arrange in a row / column         side by side from B's top-left in their current order
                                       (by x / by y), GAP canvas units apart
     Arrange in a grid                 ceil(sqrt(n)) columns in reading order (rows by y, then x);
                                       a column is as wide as its widest card, a row as tall as its
                                       tallest, GAP apart, from B's top-left
     Justify horizontally / vertically every card takes B's width (x = B.left) / B's height (y = B.top) */
(function () {
  "use strict";
  const GAP = 20;   // arrange spacing, canvas units (the grid step of cv-select)

  const ro = c => !!(c.readonly || (c.options && c.options.readOnly));
  const vis = e => !!e && e.isConnected && e.getClientRects().length > 0;

  function bbox(ns) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of ns) { const d = n.data; x0 = Math.min(x0, d.x); y0 = Math.min(y0, d.y); x1 = Math.max(x1, d.x + d.width); y1 = Math.max(y1, d.y + d.height); }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, r: x1, b: y1 };
  }
  const mv = (n, x, y) => n.moveTo({ x, y });
  const byX = (a, b) => a.data.x - b.data.x || a.data.y - b.data.y;
  const byY = (a, b) => a.data.y - b.data.y || a.data.x - b.data.x;

  /* each op: (nodes, B) -> void; min = the fewest cards it means anything for */
  const OPS = {
    "align-left":   { name: "Align left",   min: 2, fn: (ns, B) => { for (const n of ns) mv(n, B.x, n.data.y); } },
    "align-centre": { name: "Align centre", min: 2, fn: (ns, B) => { const cx = B.x + B.w / 2; for (const n of ns) mv(n, cx - n.data.width / 2, n.data.y); } },
    "align-right":  { name: "Align right",  min: 2, fn: (ns, B) => { for (const n of ns) mv(n, B.r - n.data.width, n.data.y); } },
    "align-top":    { name: "Align top",    min: 2, fn: (ns, B) => { for (const n of ns) mv(n, n.data.x, B.y); } },
    "align-middle": { name: "Align middle", min: 2, fn: (ns, B) => { const cy = B.y + B.h / 2; for (const n of ns) mv(n, n.data.x, cy - n.data.height / 2); } },
    "align-bottom": { name: "Align bottom", min: 2, fn: (ns, B) => { for (const n of ns) mv(n, n.data.x, B.b - n.data.height); } },
    "distribute-horizontal": { name: "Distribute horizontally", min: 3, fn: (ns, B) => distribute(ns, B, "x") },
    "distribute-vertical":   { name: "Distribute vertically",   min: 3, fn: (ns, B) => distribute(ns, B, "y") },
    "arrange-row":    { name: "Arrange in a row",    min: 2, fn: (ns, B) => { let x = B.x; for (const n of ns.slice().sort(byX)) { mv(n, x, B.y); x += n.data.width + GAP; } } },
    "arrange-column": { name: "Arrange in a column", min: 2, fn: (ns, B) => { let y = B.y; for (const n of ns.slice().sort(byY)) { mv(n, B.x, y); y += n.data.height + GAP; } } },
    "arrange-grid":   { name: "Arrange in a grid",   min: 2, fn: grid },
    "justify-horizontal": { name: "Justify horizontally", min: 2, fn: (ns, B) => { for (const n of ns) { n.resize({ width: B.w, height: n.data.height }); mv(n, B.x, n.data.y); } } },
    "justify-vertical":   { name: "Justify vertically",   min: 2, fn: (ns, B) => { for (const n of ns) { n.resize({ width: n.data.width, height: B.h }); mv(n, n.data.x, B.y); } } },
  };

  // the outer two stay; the span between them minus the cards' own sizes is shared out as equal gaps.
  // Positions run on the exact (unrounded) value, so every rounded gap is within 1 unit of the others.
  function distribute(ns, B, ax) {
    const P = ax === "x" ? "x" : "y", S = ax === "x" ? "width" : "height";
    const s = ns.slice().sort(ax === "x" ? byX : byY);
    const first = s[0].data[P], last = s[s.length - 1];
    const span = last.data[P] + last.data[S] - first;
    let used = 0; for (const n of s) used += n.data[S];
    const gap = (span - used) / (s.length - 1);
    let at = first;
    for (const n of s) {
      if (ax === "x") mv(n, at, n.data.y); else mv(n, n.data.x, at);
      at += n.data[S] + gap;
    }
  }
  function grid(ns, B) {
    const s = ns.slice().sort(byY), cols = Math.ceil(Math.sqrt(s.length)), rows = Math.ceil(s.length / cols);
    // reading order: cut the y-sorted cards into rows of `cols`, each row then left to right
    const R = [];
    for (let r = 0; r < rows; r++) R.push(s.slice(r * cols, (r + 1) * cols).sort(byX));
    const cw = new Array(cols).fill(0), rh = new Array(rows).fill(0);
    R.forEach((row, r) => row.forEach((n, k) => { cw[k] = Math.max(cw[k], n.data.width); rh[r] = Math.max(rh[r], n.data.height); }));
    let y = B.y;
    R.forEach((row, r) => {
      let x = B.x;
      row.forEach((n, k) => { mv(n, x, y); x += cw[k] + GAP; });
      y += rh[r] + GAP;
    });
  }

  /* ---------------------------------------------- which board */
  function boardOf(app) {
    let ws = null; try { ws = app.workspace; } catch (_) {}
    if (!ws) return null;
    try {
      const l = ws.activeLeaf, v = l && l.view;
      if (v && v.canvas && v.getViewType && v.getViewType() === "canvas" && vis(v.containerEl)) return v.canvas;
    } catch (_) {}
    try {
      const v = ws.getLeavesOfType("canvas").map(l => l.view).find(x => x && x.canvas && vis(x.containerEl));
      return v ? v.canvas : null;
    } catch (_) { return null; }
  }
  function run(c, key) {
    const op = OPS[key];
    const ns = [...c.selection].filter(n => n && n.data && c.nodes.get(n.id) === n);
    if (ns.length < op.min || ro(c)) return false;
    const before = JSON.stringify(ns.map(n => [n.data.x, n.data.y, n.data.width, n.data.height]));
    op.fn(ns, bbox(ns));
    if (JSON.stringify(ns.map(n => [n.data.x, n.data.y, n.data.width, n.data.height])) === before) return true;   // already tidy: no write
    if (typeof c.renderEdges === "function") c.renderEdges();
    c.requestSave();
    return true;
  }

  /* ---------------------------------------------- commands */
  let app = null, done = false;
  function register() {
    if (done) return;
    const host = window.__osPluginHost;
    app = app || (host && host.app) || null;
    const cm = app && app.commands;
    if (!cm || typeof cm.addCommand !== "function") return;
    try {
      for (const key of Object.keys(OPS)) {
        const op = OPS[key];
        cm.addCommand({ id: "canvas:" + key, name: "Canvas: " + op.name, checkCallback: chk => {
          const c = boardOf(app);
          if (!c || ro(c) || c.selection.size < op.min) return false;
          if (!chk) run(c, key);
          return true;
        } });
      }
      // main.js's registry (CMDS) exists only once main.js has run; before that addCommand is a no-op
      done = typeof cm.findCommand !== "function" || !!cm.findCommand("canvas:align-left");
    } catch (e) { console.error("[canvas] arrange commands:", e); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", register, { once: true });
  else setTimeout(register, 0);
  // a late registry (or a failed first try): retry when the user first reaches a board
  document.addEventListener("pointerdown", e => { if (!done && e.target && e.target.closest && e.target.closest(".canvas-wrapper")) register(); }, true);

  const api = { run: (c, key) => !!(c && OPS[key] && run(c, key)), ops: () => Object.keys(OPS) };
  Object.defineProperty(window, "CanvasArrange", { configurable: true, enumerable: false, writable: false, value: Object.freeze(api) });
})();
