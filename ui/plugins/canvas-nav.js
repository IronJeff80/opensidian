// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* canvas navigation (goal cv-nav): moving around a big board, written from the
   public help pages (help.obsidian.md/plugins/canvas) — clean room.

     Shift + wheel        pans sideways (tx only)
     Space + wheel        zooms about the pointer
     Space + drag         pans, even when the drag starts on a card (the card stays put)
     Shift + 1            zoom to fit every card
     Shift + 2            zoom to the selection (a control does the same)
     Reset zoom           a control: zoom 1 about the board centre
     Jump to group        command "Canvas: Jump to group" -> a chooser of the board's groups
     Help                 a control: a modal listing the pan / zoom / select / move shortcuts
     Grid                 the board's dot grid (plugins.css) scales and moves with the viewport
     Settings             a control: snap to grid, snap to objects, read-only
                          (canvas.options {snapToGrid, snapToObjects, readOnly}, the contract cv-select shares);
                          read-only routes through canvas.readonly, which every edit path already checks.

   Load order (index.html): canvas.js -> ... -> canvas-nav.js -> main.js. This file runs no
   code at load beyond one stylesheet and one frozen global, window.CanvasNav: canvas.js
   calls attach(canvas, X, changed) from the Canvas constructor and onWheel(canvas, e) from
   its wheel listener; main.js canvasTok() appends census(view). */
(function () {
  "use strict";
  const GRID = 20;                        // plugins.css .canvas-wrapper background-size at zoom 1
  const boards = new Set();
  let space = false;                      // Space is held (one keyboard: module-wide)
  let active = null;                      // the board the user last touched (commands act on it)
  let help = null, jump = null;           // the open help modal / group chooser
  let X = null, cmdsDone = false;

  const live = c => !!(c && c.view && c.wrapperEl.isConnected && c.wrapperEl.getClientRects().length);
  const inEditor = t => !!(t && t.closest && t.closest("textarea, input, .markdown-source-view, [contenteditable=true]"));
  const ping = c => { const n = c && c._cvnav && c._cvnav.changed; if (n) try { n(); } catch (_) {} };
  const board = () => (live(active) ? active : [...boards].find(live) || null);

  let css = false;
  function style() {
    if (css) return; css = true;
    const s = document.createElement("style");
    s.dataset.owner = "canvas-nav";
    s.textContent =
      ".canvas-wrapper.is-space-held { cursor: grab }\n" +
      ".canvas-wrapper.is-space-panning { cursor: grabbing }\n" +
      ".canvas-wrapper.is-readonly .canvas-control.mod-add-text { opacity: .4; pointer-events: none }\n" +
      ".canvas-settings-menu { position: absolute; right: 8px; top: 40px; z-index: 3; display: flex; flex-direction: column; min-width: 200px;\n" +
      "  padding: 4px; border: 1px solid var(--background-modifier-border); border-radius: 6px; background: var(--background-secondary) }\n" +
      ".canvas-settings-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 8px; cursor: pointer; border-radius: 4px }\n" +
      ".canvas-settings-item:hover { background: var(--background-modifier-hover) }\n" +
      ".canvas-settings-item .canvas-settings-check { min-width: 1.2em; text-align: center }\n" +
      ".canvas-help-row { display: flex; justify-content: space-between; gap: 24px; padding: 3px 0; border-bottom: 1px solid var(--background-modifier-border) }\n" +
      ".canvas-help-keys { font-family: var(--font-monospace); color: var(--text-muted); white-space: nowrap }\n";
    document.head.appendChild(s);
  }

  /* ------------------------------------------------ viewport */
  function paintGrid(c) {
    const w = c.wrapperEl, s = GRID * c.zoom;
    w.style.backgroundSize = s + "px " + s + "px";
    w.style.backgroundPosition = c.tx + "px " + c.ty + "px";
  }
  // fit the canvas-coordinate box into the wrapper, centred; zoom at most maxZ
  function zoomToBox(c, x0, y0, x1, y1, maxZ) {
    const r = c.wrapperEl.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const pad = 40, w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
    c.zoom = Math.max(0.1, Math.min(maxZ, (r.width - 2 * pad) / w, (r.height - 2 * pad) / h));
    c.tx = r.width / 2 - (x0 + x1) / 2 * c.zoom; c.ty = r.height / 2 - (y0 + y1) / 2 * c.zoom;
    c.applyTransform();
  }
  const boxOf = ns => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of ns) { const d = n.data; x0 = Math.min(x0, d.x); y0 = Math.min(y0, d.y); x1 = Math.max(x1, d.x + d.width); y1 = Math.max(y1, d.y + d.height); }
    return x0 === Infinity ? null : [x0, y0, x1, y1];
  };
  function zoomToSelection(c) {
    const b = boxOf(c.selection.size ? c.selection : c.nodes.values());
    if (!b) return c.zoomToFit();
    zoomToBox(c, b[0], b[1], b[2], b[3], 1);
  }
  function resetZoom(c) {
    const r = c.wrapperEl.getBoundingClientRect(), px = r.width / 2, py = r.height / 2;
    c.tx = px - (px - c.tx) / c.zoom; c.ty = py - (py - c.ty) / c.zoom; c.zoom = 1;
    c.applyTransform();
  }
  function jumpTo(c, g) { const d = g.data; zoomToBox(c, d.x, d.y, d.x + d.width, d.y + d.height, 1); }

  /* ------------------------------------------------ input */
  // canvas.js wire() wheel listener -> here first; true = handled
  function onWheel(c, e) {
    if (e.ctrlKey || e.metaKey) return false;               // canvas.js: ctrl+wheel zooms
    if (space) {
      e.preventDefault();
      c.zoomAt(e.clientX, e.clientY, Math.exp(-(e.deltaY || e.deltaX) * 0.002));
      return true;
    }
    if (e.shiftKey) {                                        // WebKitGTK may already turn it into deltaX
      e.preventDefault();
      c.tx -= Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      c.applyTransform();
      return true;
    }
    return false;
  }
  function onKeyDown(c, e) {
    if (inEditor(e.target)) return;
    if (e.key === " " || e.code === "Space") {
      e.preventDefault();
      if (!space) { space = true; c.wrapperEl.classList.add("is-space-held"); }
      return;
    }
    if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === "Digit1" || e.key === "!") { e.preventDefault(); e.stopPropagation(); c.zoomToFit(); }
    else if (e.code === "Digit2" || e.key === "@" || e.key === "\"") { e.preventDefault(); e.stopPropagation(); zoomToSelection(c); }
  }
  function spaceUp() {
    if (!space) return;
    space = false;
    for (const c of boards) c.wrapperEl.classList.remove("is-space-held");
  }

  /* ------------------------------------------------ settings + read-only */
  function setOption(c, k, v) {
    c.options[k] = !!v;
    if (k === "readOnly") {
      c.wrapperEl.classList.toggle("is-readonly", c.readonly);
      if (c.readonly) { for (const n of c.nodes.values()) if (n.isEditing) try { n.stopEditing(); } catch (_) {} }
    }
    ping(c);
  }
  const SETTINGS = [["g", "snapToGrid", "Snap to grid"], ["o", "snapToObjects", "Snap to objects"], ["ro", "readOnly", "Read-only"]];
  function closeSettings(c) {
    const s = c._cvnav; if (!s || !s.menu) return;
    s.menu.remove(); s.menu = null;
    document.removeEventListener("keydown", s.menuKey, true);
    document.removeEventListener("pointerdown", s.menuAway, true);
    ping(c);
  }
  function openSettings(c) {
    const s = c._cvnav;
    if (s.menu) return closeSettings(c);
    const m = document.createElement("div");
    m.className = "canvas-settings-menu"; m.setAttribute("role", "menu");
    for (const ev of ["pointerdown", "dblclick", "wheel"]) m.addEventListener(ev, e => e.stopPropagation());
    s.items = {};
    for (const [tk, k, label] of SETTINGS) {
      const it = document.createElement("div");
      it.className = "canvas-settings-item"; it.setAttribute("role", "menuitemcheckbox");
      it.setAttribute("aria-checked", c.options[k] ? "true" : "false");
      const t = document.createElement("span"); t.textContent = label; it.appendChild(t);
      const ck = document.createElement("span"); ck.className = "canvas-settings-check"; ck.textContent = c.options[k] ? "✓" : ""; it.appendChild(ck);
      it.addEventListener("click", e => { e.stopPropagation(); setOption(c, k, !c.options[k]); closeSettings(c); });
      m.appendChild(it); s.items[tk] = it;
    }
    s.menuKey = e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeSettings(c); } };
    s.menuAway = e => { if (s.menu && !s.menu.contains(e.target) && !(s.btn.set && s.btn.set.contains(e.target))) closeSettings(c); };
    document.addEventListener("keydown", s.menuKey, true);
    document.addEventListener("pointerdown", s.menuAway, true);
    c.wrapperEl.appendChild(m); s.menu = m;
    ping(c);
  }

  /* ------------------------------------------------ help + jump */
  const HELP = [
    ["Pan the board", "Drag empty space"],
    ["Pan the board", "Space + drag"],
    ["Pan vertically", "Wheel"],
    ["Pan horizontally", "Shift + wheel"],
    ["Zoom", "Space + wheel"],
    ["Zoom", "Ctrl + wheel"],
    ["Zoom to fit", "Shift + 1"],
    ["Zoom to selection", "Shift + 2"],
    ["Select a card", "Click"],
    ["Add to the selection", "Shift + click"],
    ["Move the selection", "Drag a selected card"],
    ["Deselect", "Escape"],
    ["Delete the selection", "Delete / Backspace"],
    ["Edit a card", "Double-click the card"],
    ["Add a text card", "Double-click empty space"],
    ["Undo / redo", "Ctrl + Z / Ctrl + Shift + Z"],
  ];
  function openHelp(c) {
    if (help || !X || !X.Modal) return;
    const m = new X.Modal(c.app);
    m.setTitle("Canvas help");
    m.onOpen = function () {
      for (const [what, keys] of HELP) {
        const r = document.createElement("div"); r.className = "canvas-help-row";
        const a = document.createElement("span"); a.textContent = what; r.appendChild(a);
        const b = document.createElement("span"); b.className = "canvas-help-keys"; b.textContent = keys; r.appendChild(b);
        this.contentEl.appendChild(r);
      }
      help = this; ping(c);
    };
    const esc = e => { if (e.key === "Escape" && help === m) { e.preventDefault(); e.stopPropagation(); m.close(); } };
    m.onClose = function () { document.removeEventListener("keydown", esc, true); if (help === m) help = null; ping(c); };
    document.addEventListener("keydown", esc, true);
    m.open();
  }
  const groupsOf = c => [...c.nodes.values()].filter(n => n.data.type === "group");
  const groupName = g => String(g.data.label || "Untitled group");
  function openJump(c) {
    if (!X || !X.FuzzySuggestModal) return;
    const gs = groupsOf(c);
    const m = new X.FuzzySuggestModal(c.app);
    m.setPlaceholder("Jump to group…");
    m.emptyStateText = "No groups on this canvas.";
    m.getItems = () => gs;
    m.getItemText = g => groupName(g);
    m.onChooseItem = g => { if (live(c) && c.nodes.get(g.id) === g) { jumpTo(c, g); ping(c); } };
    const oo = m.onOpen.bind(m), oc = m.onClose.bind(m);
    m.onOpen = function () { jump = { m, n: gs.length }; oo(); ping(c); };
    m.onClose = function () { oc(); if (jump && jump.m === m) jump = null; ping(c); };
    m.open();
  }
  function registerCommands(app) {
    if (cmdsDone || !app || !app.commands || typeof app.commands.addCommand !== "function") return;
    cmdsDone = true;
    try {
      app.commands.addCommand({ id: "canvas:jump-to-group", name: "Canvas: Jump to group",
        checkCallback: chk => { const c = board(); if (!c || !groupsOf(c).length) return false; if (!chk) openJump(c); return true; } });
      app.commands.addCommand({ id: "canvas:zoom-to-fit", name: "Canvas: Zoom to fit",
        checkCallback: chk => { const c = board(); if (!c) return false; if (!chk) c.zoomToFit(); return true; } });
      app.commands.addCommand({ id: "canvas:zoom-to-selection", name: "Canvas: Zoom to selection",
        checkCallback: chk => { const c = board(); if (!c || !c.selection.size) return false; if (!chk) zoomToSelection(c); return true; } });
      app.commands.addCommand({ id: "canvas:reset-zoom", name: "Canvas: Reset zoom",
        checkCallback: chk => { const c = board(); if (!c) return false; if (!chk) resetZoom(c); return true; } });
      app.commands.addCommand({ id: "canvas:help", name: "Canvas: Show help",
        checkCallback: chk => { const c = board(); if (!c) return false; if (!chk) openHelp(c); return true; } });
    } catch (e) { cmdsDone = false; console.error("[canvas] nav commands:", e); }
  }

  /* ------------------------------------------------ attach (Canvas constructor) */
  function attach(c, x, changed) {
    if (!c || c._cvnav) return;
    if (x) X = x;
    style();
    const s = c._cvnav = { changed: typeof changed === "function" ? changed : null, btn: {}, menu: null, pan: null, raf: 0 };
    boards.add(c);
    // canvas.options: the contract shared with cv-select (conflicts.md O9); whichever lands first creates it
    c.options = c.options || { snapToGrid: true, snapToObjects: true, readOnly: false };
    // read-only = the file error (setError) OR the user's setting; every edit path already checks c.readonly
    let err = !!c.readonly;
    Object.defineProperty(c, "readonly", { configurable: true, enumerable: true,
      get() { return err || !!(this.options && this.options.readOnly); }, set(v) { err = !!v; } });
    // the grid follows every viewport change; the census republishes once per frame
    const orig = c.applyTransform;
    c.applyTransform = function () {
      const r = orig.apply(this, arguments);
      paintGrid(this);
      if (!s.raf) s.raf = requestAnimationFrame(() => { s.raf = 0; ping(this); });
      return r;
    };
    paintGrid(c);
    const w = c.wrapperEl;
    w.addEventListener("keydown", e => onKeyDown(c, e));
    w.addEventListener("keyup", e => { if (e.key === " " || e.code === "Space") { if (!inEditor(e.target)) e.preventDefault(); spaceUp(); } });
    w.addEventListener("blur", spaceUp);
    w.addEventListener("pointerdown", () => { active = c; }, true);
    w.addEventListener("focusin", () => { active = c; });
    // Space + drag: pan from anywhere, a card included; capture phase, so canvas.js's move/select never starts
    w.addEventListener("pointerdown", e => {
      if (!space || e.button !== 0 || inEditor(e.target)) return;
      if (e.target.closest && e.target.closest(".canvas-controls, .canvas-settings-menu")) return;
      e.preventDefault(); e.stopPropagation();
      w.focus({ preventScroll: true });
      s.pan = { x: e.clientX, y: e.clientY, tx: c.tx, ty: c.ty, id: e.pointerId };
      w.classList.add("is-space-panning");
      try { w.setPointerCapture(e.pointerId); } catch (_) {}
    }, true);
    w.addEventListener("pointermove", e => {
      if (!s.pan) return;
      e.stopPropagation();
      c.tx = s.pan.tx + e.clientX - s.pan.x; c.ty = s.pan.ty + e.clientY - s.pan.y; c.applyTransform();
    }, true);
    const end = e => {
      if (!s.pan) return;
      e.stopPropagation();
      try { w.releasePointerCapture(s.pan.id); } catch (_) {}
      s.pan = null; w.classList.remove("is-space-panning");
    };
    w.addEventListener("pointerup", end, true);
    w.addEventListener("pointercancel", end, true);
    // controls: appended after canvas.js's own (+ Text, zoom in/out, fit)
    if (c.controlsEl) {
      const btn = (cls, label, txt, fn) => {
        const b = document.createElement("button");
        b.className = "canvas-control " + cls; b.type = "button"; b.textContent = txt; b.title = label; b.setAttribute("aria-label", label);
        b.addEventListener("pointerdown", e => e.stopPropagation());
        b.addEventListener("dblclick", e => e.stopPropagation());
        b.addEventListener("click", e => { e.stopPropagation(); fn(); });
        c.controlsEl.appendChild(b);
        return b;
      };
      s.btn.sel = btn("mod-zoom-selection", "Zoom to selection", "◎", () => zoomToSelection(c));
      s.btn.reset = btn("mod-zoom-reset", "Reset zoom", "1:1", () => resetZoom(c));
      s.btn.help = btn("mod-help", "Canvas help", "?", () => openHelp(c));
      s.btn.set = btn("mod-settings", "Canvas settings", "⚙", () => openSettings(c));
    }
    registerCommands(c.app);
  }
  window.addEventListener("keyup", e => { if (e.key === " " || e.code === "Space") spaceUp(); }, true);
  window.addEventListener("blur", spaceUp);

  /* ------------------------------------------------ census (main.js canvasTok) */
  const vis = e => !!e && e.getClientRects().length > 0;
  const ctr = e => { const r = e.getBoundingClientRect(); return Math.round(r.x + r.width / 2) + "," + Math.round(r.y + r.height / 2); };
  const b01 = v => (v ? 1 : 0);
  function census(v) {
    const c = v && v.canvas; if (!c || !c._cvnav) return "";
    const s = c._cvnav, w = c.wrapperEl;
    let t = " [cvnz:" + (w.dataset.zoom || "1") + "|" + Math.round(c.tx) + "|" + Math.round(c.ty) + "]";
    const q = sel => c.controlsEl && c.controlsEl.querySelector(sel);
    const pts = [["in", q(".mod-zoom-in")], ["out", q(".mod-zoom-out")], ["fit", q(".mod-zoom-fit")],
                 ["sel", s.btn.sel], ["reset", s.btn.reset], ["help", s.btn.help], ["set", s.btn.set]].filter(p => vis(p[1]));
    if (pts.length) t += " [cvctl:" + pts.map(p => p[0] + "=" + ctr(p[1])).join("|") + "]";
    const sz = parseFloat(getComputedStyle(w).backgroundSize);
    if (isFinite(sz)) t += " [cvgrid:sz=" + Math.round(sz * 100) / 100 + "|z=" + (w.dataset.zoom || "1") + "]";
    const o = c.options || {};
    t += " [cvnopt:g=" + b01(o.snapToGrid) + "|o=" + b01(o.snapToObjects) + "|ro=" + b01(o.readOnly) + "]";
    if (s.menu && s.menu.isConnected) {
      const its = SETTINGS.filter(([k]) => vis(s.items[k]));
      t += " [cvset:n=" + its.length + its.map(([k]) => "|" + k + "=" + ctr(s.items[k])).join("") + "]";
    }
    if (help) t += " [cvhelp:n=" + help.contentEl.querySelectorAll(".canvas-help-row").length + "]";
    if (jump) t += " [cvjump:n=" + jump.n + "]";
    return t;
  }

  const api = { attach, onWheel, census, zoomToSelection, resetZoom, jumpTo };
  Object.defineProperty(window, "CanvasNav", { configurable: true, enumerable: false, writable: false, value: Object.freeze(api) });
})();
