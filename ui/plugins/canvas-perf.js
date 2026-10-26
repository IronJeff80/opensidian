// SPDX-License-Identifier: GPL-3.0-or-later
/* goal cv-perf (0.8.1 Canvas, wave 4): a big board stays inside a frame budget.
   Two things, both paint-only (the document is never touched):
   - culling: on a board of at least BIG cards, a card whose rect is farther than one
     screen from the viewport gets .cvp-culled (display: none), and so does an edge whose
     curve (the hull of its two anchors and two control points, plus its arrow/label slack)
     is. canvas.js applyTransform() makes ONE call into cull(); a pan therefore re-culls in
     the same frame. Selected and edited cards are never culled. Nothing is culled before
     the board's first fit (an opening board is shown whole). Geometry changes that do not go
     through applyTransform (a move, an undo, an arrange) re-cull on the next frame via rendered().
   - partial edges: canvas.js renderEdges(ids) asks partial(canvas, ids) which edges to
     re-path; during a drag (canvas.js brackets the pointermove with drag(canvas, d)) the ids
     are the moved cards'. Only when the edge layer still holds exactly the edges of the last
     full render; anything else (a duplicate-drag added edges, an edge was removed) falls back
     to the full render. painted() swaps each re-pathed <g> in place, so paint order is kept.
   - census pings are not coalesced here: the host (ui/main.js updateTitle) builds its census at
     most once per frame app-wide, and trails a heavy one while a pan or drag streams pings.
   The stylesheet goes in once at load: inserting it under an open 500-card board would restyle
   the whole document in the middle of the open.
   census (ui/main.js canvasTok): [cvperf:vis=<painted cards>|total=<cards>|eupd=<edges the last
   drag move re-pathed>|emin=|emax=|moves=<drag moves of the last drag>|evis=<painted edges>] */
(() => {
  "use strict";
  const BIG = 200;        // below this many cards every card is painted (nothing to win, nothing to risk)
  const MARGIN = 1;       // screens of slack around the viewport that stay painted
  const EPAD = 40;        // canvas px around an edge's hull: arrow head, stroke, hit stroke
  const LPAD = 200;       // ... and around a labelled one
  const style = () => {
    if (document.getElementById("canvas-perf-style")) return;
    const s = document.createElement("style");
    s.id = "canvas-perf-style";
    s.textContent = ".canvas-node.cvp-culled, .canvas-edges .cvp-culled { display: none !important }\n" +
      // goal cvf-zoom CVR-C-078: zoomed out, a group's label keeps its screen size (16 px at any zoom below 100 %)
      ".canvas-wrapper .canvas-node-group > .canvas-node-label { font-size: calc(16px / min(var(--cvn-z, 1), 1)); padding-bottom: calc(2px / min(var(--cvn-z, 1), 1)) }";
    (document.head || document.documentElement).appendChild(s);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", style, { once: true }); else style();
  const S = c => c._cvp || (c._cvp = { culled: new Set(), vis: 0, total: 0, w: 0, h: 0, ro: null, raf: 0,
                                         gmap: new Map(), ebox: new Map(), eoff: new Set(), evis: 0,
                                         nE: -1, nN: -1, drag: null, dobj: null,
                                         eupd: 0, emin: 0, emax: 0, moves: 0 });

  /* ------------------------------------------------ culling */
  function size(c, s) {
    if (!s.ro && typeof ResizeObserver === "function") {
      s.ro = new ResizeObserver(en => { const r = en[en.length - 1].contentRect; s.w = r.width; s.h = r.height; cull(c); });
      s.ro.observe(c.wrapperEl);
    }
    if (!s.w || !s.h) { s.w = c.wrapperEl.clientWidth; s.h = c.wrapperEl.clientHeight; }
  }
  function uncullAll(s) {
    for (const n of s.culled) n.containerEl.classList.remove("cvp-culled");
    s.culled.clear();
    for (const id of s.eoff) { const g = s.gmap.get(id); if (g) g.classList.remove("cvp-culled"); }
    s.eoff.clear(); s.evis = s.gmap.size;
  }
  /* goal cvf-zoom CVR-C-076: level of detail. At or below the zoom threshold (Settings > Canvas, percent of 25 %;
     100 = 25 %) the wrapper gets .cvp-lod and plugins.css draws text and note cards as their bare box (a media card
     keeps its picture): nothing to read at that size, and nothing to lay out on a big board. */
  function lodOf(c) {
    const g = window.__osCanvasCfg, th = g ? Number(g.get("zoomThreshold")) : 100;
    return isFinite(th) && th > 0 && (c.zoom || 1) <= 0.25 * th / 100 + 1e-9;
  }
  function lod(c) {
    const w = c.wrapperEl; if (!w) return;
    // not on boards of BIG cards or more: the bare box would undo cvf-board's .cvn-hide-content there and paint
    // every card of a fitted big board at open (cvperf CV-168, round 4 bisect VB/VC); nothing to read at that size anyway.
    const on = c.nodes.size < BIG && lodOf(c);
    if (on !== w.classList.contains("cvp-lod")) w.classList.toggle("cvp-lod", on);
  }
  function cull(c) {
    lod(c);
    const s = S(c), N = c.nodes.size;
    s.total = N;
    if (N < BIG || c.fitted === false) { if (s.culled.size || s.eoff.size) uncullAll(s); s.vis = N; s.evis = s.gmap.size; return; }
    size(c, s);
    const z = c.zoom || 1, W = s.w, H = s.h;
    if (!W || !H) { if (s.culled.size || s.eoff.size) uncullAll(s); s.vis = N; s.evis = s.gmap.size; return; }   // a hidden board: cull nothing until it has a size
    const x0 = (-c.tx - MARGIN * W) / z, x1 = (W - c.tx + MARGIN * W) / z;
    const y0 = (-c.ty - MARGIN * H) / z, y1 = (H - c.ty + MARGIN * H) / z;
    for (const s2 of s.culled) if (!c.nodes.has(s2.id) || c.nodes.get(s2.id) !== s2) s.culled.delete(s2);
    for (const n of c.nodes.values()) {
      const d = n.data;
      const off = !(d.x < x1 && d.x + d.width > x0 && d.y < y1 && d.y + d.height > y0) && !n.isEditing && !c.selection.has(n);
      if (off === s.culled.has(n)) continue;
      n.containerEl.classList.toggle("cvp-culled", off);
      if (off) s.culled.add(n); else s.culled.delete(n);
    }
    s.vis = N - s.culled.size;
    for (const [id, g] of s.gmap) {
      const b = s.ebox.get(id);
      const off = !!b && !(b[0] < x1 && b[2] > x0 && b[1] < y1 && b[3] > y0);
      if (off === s.eoff.has(id)) continue;
      g.classList.toggle("cvp-culled", off);
      if (off) s.eoff.add(id); else s.eoff.delete(id);
    }
    s.evis = s.gmap.size - s.eoff.size;
  }
  function later(c) {
    const s = S(c);
    if (s.raf) return;
    s.raf = requestAnimationFrame(() => { s.raf = 0; if (c.wrapperEl && c.wrapperEl.isConnected) cull(c); });
  }


  /* ------------------------------------------------ partial edges */
  // canvas.js pointermove: drag(canvas, d) before the move, drag(canvas, null) after it
  function drag(c, d) {
    const s = S(c);
    s.drag = d || null;
    if (d && d !== s.dobj) { s.dobj = d; s.moves = 0; s.emin = 0; s.emax = 0; s.eupd = 0; const ids = dragIds(c, s); s.did = ids && ids.length ? ids[0] : null; }
  }
  const idOf = o => (o.m || o.s || o).id;
  function dragIds(c, s) {
    const d = s.drag;
    if (!d) return null;
    if (d.mode === "move") return Array.isArray(d.start) && d.start.length ? d.start.map(idOf) : [...c.selection].map(n => n.id);
    if (d.mode === "resize" && d.node) return [d.node.id];
    return null;
  }
  // the edges renderEdges must re-path, or null = a full render
  function partial(c, ids) {
    const s = S(c);
    const want = ids || dragIds(c, s);
    if (!want || s.nE !== c.edges.size || s.nN !== c.nodes.size) { s.gmap = new Map(); s.ebox = new Map(); s.eoff.clear(); return null; }
    const set = new Set(want), out = [];
    for (const e of c.edges.values()) {
      if (!set.has(e.fromNode) && !set.has(e.toNode)) continue;
      if (!c.nodes.has(e.fromNode) || !c.nodes.has(e.toNode)) continue;
      const g = s.gmap.get(e.id);
      if (!g || !g.isConnected) { s.gmap = new Map(); s.ebox = new Map(); s.eoff.clear(); return null; }
      out.push(e);
    }
    return out;
  }
  // p1 p2 c1 c2: the curve's anchors and control points ([x, y], canvas coordinates)
  function painted(c, e, grp, part, p1, p2, c1, c2) {
    const s = S(c);
    if (part) { const old = s.gmap.get(e.id); if (old && old !== grp) old.replaceWith(grp); s.eoff.delete(e.id); }
    s.gmap.set(e.id, grp);
    if (p1 && p2 && c1 && c2) {
      const k = e.label ? LPAD : EPAD;
      s.ebox.set(e.id, [Math.min(p1[0], p2[0], c1[0], c2[0]) - k, Math.min(p1[1], p2[1], c1[1], c2[1]) - k,
                        Math.max(p1[0], p2[0], c1[0], c2[0]) + k, Math.max(p1[1], p2[1], c1[1], c2[1]) + k]);
    } else s.ebox.delete(e.id);
  }
  function rendered(c, part) {
    const s = S(c);
    if (!part) {
      s.nE = c.edges.size; s.nN = c.nodes.size;
      for (const id of s.ebox.keys()) if (!s.gmap.has(id)) s.ebox.delete(id);
      cull(c);   // a full render made every edge visible again: re-cull now, not a frame later
    }
    if (s.drag) {
      const n = part ? part.length : s.gmap.size;
      s.moves++; s.eupd = n;
      s.emin = s.moves === 1 ? n : Math.min(s.emin, n); s.emax = Math.max(s.emax, n);
    }
    later(c);
  }

  function census(v) {
    const c = v && v.canvas; if (!c) return "";
    const s = S(c);
    if (s.nN < 0 && !s.total) cull(c);
    else later(c);
    let t = " [cvperf:vis=" + s.vis + "|total=" + c.nodes.size + "|eupd=" + s.eupd + "|emin=" + s.emin + "|emax=" + s.emax + "|moves=" + s.moves + "|evis=" + s.evis + "]";
    // goal cvf-zoom: [cvlod:<id>|lod=0|1(|lab=x,y,w,h for a group)] per painted card (at most 16), [cvpdrag:<id>@x,y,w,h]
    // [cvlod:] only below BIG: its rect reads force a synchronous layout on every census, which on a
    // big board lands inside the open/pan window (cvperf CV-168)
    const R = e => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round).join(","); };
    const L = c.wrapperEl && c.wrapperEl.classList.contains("cvp-lod") ? 1 : 0;
    let k = c.nodes.size >= BIG ? 16 : 0;
    for (const n of c.nodes.values()) {
      if (k >= 16) break;
      const el = n.containerEl; if (!el || !el.isConnected || !el.getClientRects().length) continue;
      k++;
      t += " [cvlod:" + String(n.id).replace(/[[\]|@]/g, "_") + "|lod=" + (n.data && n.data.type === "group" || el.classList.contains("cc-media") ? 0 : L);
      if (n.data && n.data.type === "group" && n.labelEl && n.labelEl.getClientRects().length) t += "|lab=" + R(n.labelEl);
      t += "]";
    }
    const dn = s.did && c.nodes.get(s.did);
    if (dn && dn.containerEl && dn.containerEl.getClientRects().length) t += " [cvpdrag:" + String(dn.id).replace(/[[\]|@]/g, "_") + "@" + R(dn.containerEl) + "]";
    return t;
  }

  /* ------------------------------------------------ gesture signal (goal title-fresh)
     The host census (ui/main.js updateTitle) may trail a heavy rebuild ONLY while a pan or a
     drag streams over a big board; everywhere else it must publish within a frame. live() is
     that signal: a drag move (drag(c, d)) on a big board, or the second applyTransform within
     GAP ms on one (a pan / wheel stream — a one-off fit or zoom is not a stream). It goes
     false GAP ms after the last such event; the host then publishes its trailing census. */
  const GAP = 150;
  let gLast = -1e9, gPrev = -1e9;
  function cullX(c) {                    // canvas.js applyTransform’s entry: cull + stream detection
    if (c && c.nodes && c.nodes.size >= BIG) { const now = performance.now(); if (now - gPrev < GAP) gLast = now; gPrev = now; }
    return cull(c);
  }
  function dragX(c, d) {
    if (d && c && c.nodes && c.nodes.size >= BIG) gLast = performance.now();
    return drag(c, d);
  }
  const live = () => performance.now() - gLast < GAP;

  window.CanvasPerf = { cull: cullX, drag: dragX, partial, painted, rendered, census, live, BIG };
})();
