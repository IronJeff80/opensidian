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
      // goal cvf-board: the controls are one icon-only column at the right edge (CVR-A-073)
      ".canvas-wrapper .canvas-controls.cvn-stack { flex-direction: column; align-items: center; top: 8px; right: 8px; gap: 2px; padding: 3px;\n" +
      "  border: 1px solid var(--background-modifier-border); border-radius: 6px; background: var(--background-primary) }\n" +
      ".canvas-controls.cvn-stack .canvas-control { width: 28px; height: 28px; padding: 0; display: flex; align-items: center; justify-content: center;\n" +
      "  border: 0; border-radius: 4px; background: transparent; color: var(--text-muted) }\n" +
      ".canvas-controls.cvn-stack .canvas-control:hover { background: var(--background-modifier-hover); color: var(--text-normal) }\n" +
      ".canvas-controls.cvn-stack .canvas-control svg { width: 16px; height: 16px; pointer-events: none }\n" +
      ".canvas-controls.cvn-stack .canvas-control.mod-add-text, .canvas-controls.cvn-stack .canvas-control.mod-zoom-selection { display: none }\n" +
      // a disabled button swallows pointer events in WebKit: let them reach the column (hover tooltips hit-test by geometry)
      ".canvas-controls.cvn-stack .canvas-control:disabled { pointer-events: none; opacity: .45 }\n" +
      ".canvas-controls.cvn-stack .cvn-sep { width: 20px; height: 1px; margin: 2px 0; background: var(--background-modifier-border) }\n" +
      ".canvas-control-tip { position: fixed; z-index: 60; pointer-events: none; white-space: nowrap; padding: 4px 8px; border-radius: 4px;\n" +
      "  font-size: 13px; line-height: 1.3; color: var(--text-normal); background: var(--background-secondary); border: 1px solid var(--background-modifier-border);\n" +
      "  box-shadow: 0 2px 8px rgba(0, 0, 0, .25) }\n" +
      // read-only: a drag across cards never paints a text selection (CVR-C-099)
      ".canvas-wrapper.is-readonly, .canvas-wrapper.is-readonly * { -webkit-user-select: none; user-select: none }\n" +
      ".canvas-settings-menu { position: absolute; right: 52px; top: 8px; z-index: 3; display: flex; flex-direction: column; min-width: 200px;\n" +
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
  /* goal cvf-board CVR-A-079: snap to grid / snap to objects are app settings of the VAULT, like stock:
     a toggle writes <vault>/.obsidian/canvas.json at once (settings.js __osCanvasCfg) and every open board
     follows; a board opens with them. Read-only stays per board. */
  const CFGK = ["snapToGrid", "snapToObjects"];
  const cfg = () => window.__osCanvasCfg || null;
  function cfgSnap(c) {
    const g = cfg(); if (!g || !c.options) return;
    for (const k of CFGK) c.options[k] = !!g.get(k);
  }
  let cfgHooked = false;
  function hookCfg() {
    if (cfgHooked) return; const g = cfg(); if (!g) return; cfgHooked = true;
    g.on(keys => { if (!keys.some(k => CFGK.includes(k))) return; for (const c of boards) { cfgSnap(c); ping(c); } });
  }
  function setOption(c, k, v) {
    c.options[k] = !!v;
    if (CFGK.includes(k) && cfg()) cfg().set({ [k]: !!v });
    if (k === "readOnly") {
      syncRO(c);
      if (c.readonly) { for (const n of c.nodes.values()) if (n.isEditing) try { n.stopEditing(); } catch (_) {} }
    }
    ping(c);
  }
  // read-only shows on the settings control: a padlock instead of the gear (CVR-A-078)
  function syncRO(c) {
    const s = c._cvnav; if (!s) return;
    c.wrapperEl.classList.toggle("is-readonly", !!c.readonly);
    const b = s.btn.set, want = c.readonly ? "lock" : "gear";
    if (b && b.dataset.icon !== want) { b.dataset.icon = want; b.innerHTML = ICON[want]; }
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
  // goal cvf-board (CVR-A-082): the board shortcuts, written from the public help page
  const HELP = [
    ["Pan the board", "Space+drag or drag empty space"],
    ["Pan sideways", "Shift+wheel"],
    ["Zoom", "Ctrl+wheel or Space+wheel"],
    ["Zoom to fit", "Shift+1"],
    ["Zoom to selection", "Shift+2"],
    ["Select all", "Ctrl+A"],
    ["Add to the selection", "Shift+click"],
    ["Create a card with specific size", "Ctrl+drag"],
    ["Clone card", "Ctrl+drag"],
    ["Constrain movement to axis", "Shift+drag"],
    ["Disable snapping", "Alt"],
    ["Edit a card", "Double-click"],
    ["Remove card", "Backspace or Delete"],
    ["Undo", "Ctrl+Z"],
    ["Redo", "Ctrl+Y or Ctrl+Shift+Z"],
  ];
  // the control icons (24x24 strokes, drawn here)
  const SVG = d => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + "</svg>";
  const ICON = {
    gear: SVG('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>'),
    lock: SVG('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
    in: SVG('<path d="M12 5v14M5 12h14"/>'),
    out: SVG('<path d="M5 12h14"/>'),
    reset: SVG('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>'),
    fit: SVG('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>'),
    undo: SVG('<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
    redo: SVG('<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>'),
    help: SVG('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 4.9.8c0 1.7-2.4 2.2-2.4 3.7M12 17h.01"/>'),
  };
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
    hookCfg(); cfgSnap(c);
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
      stack(c);
    }
    // read-only also follows the file error (canvas.readonly setter): keep the padlock in step
    const d = Object.getOwnPropertyDescriptor(c, "readonly");
    Object.defineProperty(c, "readonly", { configurable: true, enumerable: true,
      get: d.get, set(v) { d.set.call(this, v); syncRO(this); } });
    // read-only: a drag across cards selects no text (CVR-C-099)
    w.addEventListener("selectstart", e => { if (c.readonly && !inEditor(e.target)) e.preventDefault(); }, true);
    syncRO(c);
    registerCommands(c.app);
  }

  /* ------------------------------------------------ the controls column + tooltips (goal cvf-board)
     top to bottom: settings | zoom in, reset zoom, zoom to fit, zoom out | undo, redo | help.
     undo / redo are canvas-history.js's buttons (it may add them after attach): a MutationObserver
     keeps the order. The tooltip is our own element LEFT of the hovered button; the column
     hit-tests by geometry, so sliding from button to button (a disabled one included) re-targets it. */
  const ORDER = [["set", ".mod-settings"], "|", ["in", ".mod-zoom-in"], ["reset", ".mod-zoom-reset"], ["fit", ".mod-zoom-fit"],
                 ["out", ".mod-zoom-out"], "|", ["undo", ".mod-undo"], ["redo", ".mod-redo"], "|", ["help", ".mod-help"]];
  const TIP = { set: "Canvas settings", in: "Zoom in", reset: "Reset zoom", fit: "Zoom to fit (Shift + 1)", out: "Zoom out",
                undo: "Undo", redo: "Redo", help: "Canvas help" };
  let tip = null;                          // {el, b: the button, c}
  function hideTip() { if (!tip) return; const c = tip.c; tip.el.remove(); tip = null; ping(c); }
  function showTip(c, b) {
    if (tip && tip.b === b) return;
    hideTip();
    const t = document.createElement("div");
    t.className = "canvas-control-tip"; t.textContent = b.dataset.tip;
    document.body.appendChild(t);
    const r = b.getBoundingClientRect(), tr = t.getBoundingClientRect();
    t.style.left = Math.round(r.left - 8 - tr.width) + "px";
    t.style.top = Math.round(r.top + r.height / 2 - tr.height / 2) + "px";
    tip = { el: t, b, c }; ping(c);
  }
  function stack(c) {
    const s = c._cvnav, el = c.controlsEl;
    el.classList.add("cvn-stack");
    const seps = [];
    const arrange = () => {
      const want = [];
      let k = 0;
      for (const it of ORDER) {
        if (it === "|") { want.push(seps[k] || (seps[k] = Object.assign(document.createElement("div"), { className: "cvn-sep" }))); k++; continue; }
        const b = el.querySelector(it[1]); if (!b) continue;
        if (b.dataset.cvn !== it[0]) {
          b.dataset.cvn = it[0]; b.dataset.tip = TIP[it[0]];
          b.removeAttribute("title"); b.setAttribute("aria-label", TIP[it[0]]);
          if (it[0] !== "set") b.innerHTML = ICON[it[0]];
        }
        want.push(b);
      }
      for (const x of el.children) if (!want.includes(x)) want.push(x);   // + Text / zoom to selection (hidden) and anything else
      const cur = [...el.children];
      if (cur.length === want.length && cur.every((x, i) => x === want[i])) return;
      mo.disconnect();
      for (const x of want) el.appendChild(x);
      mo.observe(el, { childList: true });
    };
    const mo = new MutationObserver(arrange);
    arrange();
    mo.observe(el, { childList: true });
    s.arrange = arrange;
    const hit = e => {
      for (const b of el.querySelectorAll(".canvas-control[data-cvn]")) {
        if (!vis(b)) continue;
        const r = b.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top - 1 && e.clientY < r.bottom + 1) return b;
      }
      return null;
    };
    el.addEventListener("pointermove", e => { const b = hit(e); if (b) showTip(c, b); else hideTip(); });
    el.addEventListener("pointerenter", e => { const b = hit(e); if (b) showTip(c, b); });
    el.addEventListener("pointerleave", hideTip);
    el.addEventListener("pointerdown", hideTip, true);
    el.addEventListener("wheel", hideTip, { passive: true });
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
    // every painted control in DOM (column) order: the stack names, + Text / zoom to selection as add / sel if shown
    const NM = [["mod-add-text", "add"], ["mod-zoom-selection", "sel"]];
    const pts = c.controlsEl ? [...c.controlsEl.querySelectorAll(".canvas-control")].filter(vis)
      .map(b => [b.dataset.cvn || (NM.find(n => b.classList.contains(n[0])) || [0, ""])[1], b]).filter(p => p[0]) : [];
    if (pts.length) {
      t += " [cvctl:" + pts.map(p => p[0] + "=" + ctr(p[1])).join("|") + "]";
      t += " [cvbtn:" + pts.map(p => { const r = p[1].getBoundingClientRect(); return p[0] + "=" + [r.x, r.y, r.width, r.height].map(Math.round).join(","); }).join("|") + "]";
    }
    if (tip && !(tip.b.isConnected && vis(tip.b))) { tip.el.remove(); tip = null; }   // its board went away (no ping: we are the census)
    if (tip && tip.c === c) { const r = tip.el.getBoundingClientRect(); t += " [cvtip:" + tip.el.textContent + "@" + [r.x, r.y, r.width, r.height].map(Math.round).join(",") + "]"; }
    if (s.btn.set) t += " [cvseticon:" + (s.btn.set.dataset.icon || "gear") + "]";
    { const sl = document.getSelection(); t += " [cvdocsel:" + (sl ? String(sl).length : 0) + "]"; }
    const sz = parseFloat(getComputedStyle(w).backgroundSize);
    if (isFinite(sz)) t += " [cvgrid:sz=" + Math.round(sz * 100) / 100 + "|z=" + (w.dataset.zoom || "1") + "]";
    const o = c.options || {};
    t += " [cvnopt:g=" + b01(o.snapToGrid) + "|o=" + b01(o.snapToObjects) + "|ro=" + b01(o.readOnly) + "]";
    if (s.menu && s.menu.isConnected) {
      const its = SETTINGS.filter(([k]) => vis(s.items[k]));
      t += " [cvset:n=" + its.length + its.map(([k]) => "|" + k + "=" + ctr(s.items[k])).join("") + "]";
    }
    if (help) {
      const rows = [...help.contentEl.querySelectorAll(".canvas-help-row")];
      t += " [cvhelp:n=" + rows.length + "]";
      t += " [cvhelpk:" + rows.map(r => r.children[0].textContent + "=" + r.children[1].textContent).join("|") + "]";
    }
    if (jump) t += " [cvjump:n=" + jump.n + "]";
    return t;
  }

  const api = { attach, onWheel, census, zoomToSelection, resetZoom, jumpTo };
  Object.defineProperty(window, "CanvasNav", { configurable: true, enumerable: false, writable: false, value: Object.freeze(api) });
})();
