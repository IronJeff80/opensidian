// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* canvas touch (goal cv-touch): the board on a touch screen.
   Written from the public help page "Use Canvas on mobile" (clean room).

     one finger, moved >= 8px   pans the board (on a card too: touch never drags a card)
     two fingers                pinch-zoom about their midpoint (through canvas.zoomAt),
                                and the midpoint carries the board along (two-finger pan)
     one finger held 500 ms     (< 8px movement) opens the card menu on a card or the board
                                menu on the empty board: a contextmenu event at the press
                                point, so the menu is cv-menus' own (never a second menu)
     a short tap                selects like a click (cv-select's down/up), so the
                                selection toolbar shows; a tap on the empty board clears it

   Load order (index.html): after canvas-edges.js. This file runs NO code at load beyond
   defining window.CanvasTouch; canvas.js calls onPointer(canvas, e) at the top of its
   pointerdown / pointermove / pointerup (+ pointercancel) handlers. It returns true when
   it consumed the event — ONLY ever for pointerType "touch"; mouse and pen return false
   at once and reach canvas.js's handlers unchanged. Touches on the controls, toolbars,
   menus and editors are not tracked (false), so their buttons keep their own taps. */
(function () {
  "use strict";
  const HOLD = 500;                     // ms: a press held this long without moving is a long press
  const SLOP = 8;                       // px: movement that turns a press into a pan
  const PASS = "textarea, input, .markdown-source-view, [contenteditable=true], .canvas-controls, .canvas-card-menu, " +
               ".canvas-selection-toolbar, .canvas-selection-palette, .canvas-edge-menu, .canvas-edge-pin, .canvas-settings-menu";
  let guard = false, mine = false, menuAt = -1e9;

  const S = c => c._cvt || (c._cvt = { pts: new Map(), one: null, pinch: null, timer: 0 });
  const now = () => (window.performance ? performance.now() : Date.now());
  const nodeOf = (c, t) => { const e = t && t.closest ? t.closest(".canvas-node") : null; return e && c.nodes.get(e.dataset.nodeId) || null; };
  const mid = s => { const p = [...s.pts.values()]; return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2, d: Math.max(1, Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y)) }; };
  const stopTimer = s => { if (s.timer) { clearTimeout(s.timer); s.timer = 0; } };
  const focus = c => { try { c.wrapperEl.focus({ preventScroll: true }); } catch (_) {} };

  // a native contextmenu the platform fires for the same long press would open a second menu: swallow it
  function installGuard() {
    if (guard) return; guard = true;
    window.addEventListener("contextmenu", e => {
      if (mine || now() - menuAt > 1000) return;
      e.preventDefault(); e.stopImmediatePropagation();
    }, true);
  }

  function longPress(c, s) {
    s.timer = 0;
    const o = s.one; if (!o || o.panning || o.done || s.pts.size !== 1) return;
    o.done = true;
    const t = o.target && o.target.isConnected ? o.target : c.wrapperEl;
    // the menu owns the keyboard while open (Escape closes it): the board gives up focus, as it never takes it on a right click
    const a = document.activeElement; if (a && a !== document.body && c.wrapperEl.contains(a) && a.blur) a.blur();
    menuAt = now(); mine = true;
    try {
      t.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, composed: true, view: window,
        button: 2, buttons: 0, clientX: o.x0, clientY: o.y0, screenX: o.x0, screenY: o.y0 }));
    } catch (er) { console.error("[canvas] touch menu:", er); }
    finally { mine = false; }
  }

  function tap(c, o, e) {
    focus(c);                           // like a left click; a long press (a right click) leaves focus alone so the menu owns Escape
    const n = o.node && c.nodes.get(o.node.id) === o.node ? o.node : null;
    const CS = window.CanvasSelect;
    if (CS) { const d = CS.down(c, e, n); if (d) CS.up(c, d, e); return; }
    if (n) c.select(n, false); else c.deselectAll();
  }

  function down(c, s, e) {
    const t = e.target;
    if (t && t.closest && t.closest(PASS)) return false;
    installGuard();
    e.preventDefault();
    s.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (s.pts.size === 1) {
      s.pinch = null;
      s.one = { id: e.pointerId, x0: e.clientX, y0: e.clientY, tx: c.tx, ty: c.ty, t0: now(), target: t, node: nodeOf(c, t), panning: false, done: false };
      stopTimer(s); s.timer = setTimeout(() => longPress(c, s), HOLD);
    } else if (s.pts.size === 2) {
      stopTimer(s); s.one = null;
      const m = mid(s); s.pinch = { d0: m.d, z0: c.zoom, x: m.x, y: m.y };
    }
    try { c.wrapperEl.setPointerCapture(e.pointerId); } catch (_) {}
    return true;
  }

  function move(c, s, e) {
    const p = s.pts.get(e.pointerId); if (!p) return false;
    p.x = e.clientX; p.y = e.clientY;
    e.preventDefault();
    if (s.pinch && s.pts.size >= 2) {
      const m = mid(s), q = s.pinch;
      c.tx += m.x - q.x; c.ty += m.y - q.y; q.x = m.x; q.y = m.y;
      c.zoomAt(m.x, m.y, (q.z0 * m.d / q.d0) / c.zoom);   // zoomAt applies the transform (and clamps the zoom)
      return true;
    }
    const o = s.one; if (!o || o.id !== e.pointerId || o.done) return true;
    const dx = e.clientX - o.x0, dy = e.clientY - o.y0;
    if (!o.panning && Math.hypot(dx, dy) < SLOP) return true;
    if (!o.panning) { o.panning = true; stopTimer(s); focus(c); }
    c.tx = o.tx + dx; c.ty = o.ty + dy; c.applyTransform();
    return true;
  }

  function up(c, s, e) {
    if (!s.pts.has(e.pointerId)) return false;
    s.pts.delete(e.pointerId);
    try { c.wrapperEl.releasePointerCapture(e.pointerId); } catch (_) {}
    const o = s.one;
    if (o && o.id === e.pointerId) {
      stopTimer(s); s.one = null;
      if (e.type === "pointerup" && !o.panning && !o.done && now() - o.t0 < HOLD) tap(c, o, e);
    }
    if (s.pinch && s.pts.size < 2) {
      s.pinch = null;
      // the finger still down carries on panning (never a tap / menu after a pinch)
      const r = [...s.pts.entries()][0];
      if (r) s.one = { id: r[0], x0: r[1].x, y0: r[1].y, tx: c.tx, ty: c.ty, t0: now(), target: null, node: null, panning: true, done: false };
    }
    if (!s.pts.size) { s.one = null; s.pinch = null; stopTimer(s); }
    return true;
  }

  function onPointer(c, e) {
    if (!c || !e || e.pointerType !== "touch") return false;
    const s = S(c);
    if (e.type === "pointerdown") return down(c, s, e);
    if (e.type === "pointermove") return move(c, s, e);
    if (e.type === "pointerup" || e.type === "pointercancel") return up(c, s, e);
    return false;
  }

  const api = { onPointer, HOLD, SLOP };
  Object.defineProperty(window, "CanvasTouch", { configurable: true, enumerable: false, writable: false, value: Object.freeze(api) });
})();
