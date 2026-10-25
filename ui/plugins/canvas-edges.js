// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* canvas edges (goal cv-edges): connections drawn and edited with the mouse on
   the canvas board (ui/plugins/canvas.js), written from the public help pages
   and the JSON Canvas 1.0 spec (clean room).

   Load order (index.html): canvas.js -> ... -> canvas-edges.js -> main.js. This
   file runs NO code at load beyond defining window.CanvasEdges.

   canvas.js's renderEdges() calls three hooks: attach(canvas, ctx) before it
   paints (the first call installs this file on that board), paint(canvas, edge,
   g, geo) per painted edge (adds the wide invisible hit stroke and keeps the
   curve's geometry), done(canvas) after (repaints the overlay). Everything else
   is driven from listeners this file puts on the board's wrapper in the CAPTURE
   phase, so a press on an edge, a handle or the edge toolbar never reaches the
   board's own pan/select/dblclick listeners.

   - hovering a card (or the band just outside it) paints a connection handle on
     the middle of each side; dragging one onto a card makes an edge with both
     sides set, onto empty board makes a text card at the drop point and connects it
   - an edge is hit within HIT px of its curve; a press selects it, Delete or
     Backspace removes it, a double press edits its label
   - a hovered or selected edge paints a handle on each end: dragging an end onto
     a card reconnects it (same edge, same id), onto empty board removes the edge
   - the selected edge has a toolbar: delete, colour (palette), direction
     (none / one way / both ways), label, remove label
   - right-click an edge: Follow connection pans to the card at the far end
   Every change edits the edge object in place (unknown fields stay) and goes
   through canvas.requestSave(), so history (cv-history) and the file follow. */
(function () {
  "use strict";
  const HIT = 16;          // screen px: width of an edge's invisible hit stroke
  const HANDLE = 14;       // screen px: connection / end handle diameter
  const NEAR = 20;         // screen px: a card's handles stay painted this far outside it
  const OUT = 5;           // screen px: a connection handle sits this far outside its side, so the border band inside stays resize
  const SNAP = 24;         // screen px: a drop this close to a side attaches to that side
  const SIDES = ["top", "right", "bottom", "left"];
  const NORMAL = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };
  const SVGNS = "http://www.w3.org/2000/svg";

  const el = (tag, cls, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; if (parent) parent.appendChild(e); return e; };
  const sv = (tag, attrs, parent) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };
  const bez = (g, t) => {
    const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    return [a * g.p1[0] + b * g.c1[0] + c * g.c2[0] + d * g.p2[0], a * g.p1[1] + b * g.c1[1] + c * g.c2[1] + d * g.p2[1]];
  };
  const anchor = (n, side) => {
    if (side === "top") return [n.x + n.width / 2, n.y];
    if (side === "bottom") return [n.x + n.width / 2, n.y + n.height];
    if (side === "left") return [n.x, n.y + n.height / 2];
    return [n.x + n.width, n.y + n.height / 2];
  };
  const facing = (a, b) => {
    const dx = (b.x + b.width / 2) - (a.x + a.width / 2), dy = (b.y + b.height / 2) - (a.y + a.height / 2);
    return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "right" : "left") : (dy >= 0 ? "bottom" : "top");
  };

  let styled = false;
  function style() {
    if (styled) return; styled = true;
    const s = document.createElement("style");
    s.id = "canvas-edges-style";
    s.textContent = [
      ".canvas-edge-hit { cursor: pointer }",
      ".canvas-edge.is-hovered > .canvas-edge-line { stroke-width: 3px !important }",
      ".canvas-edge.is-selected > .canvas-edge-line { stroke-width: 4px !important }",
      ".canvas-edge.is-dragging { opacity: 0.25 }",
      ".canvas-edge-label { cursor: pointer }",
      ".canvas-edge-overlay { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; z-index: 2 }",
      ".canvas-edge-handle, .canvas-edge-end { position: absolute; box-sizing: border-box; border-radius: 50%; pointer-events: auto; cursor: crosshair;" +
        " background: var(--background-primary, #1e1e1e); border: 2px solid var(--interactive-accent, #7f6df2) }",
      ".canvas-edge-handle { z-index: 1; pointer-events: none }",   // hit-tested in onDown (handleAt), so a press inside the card stays a resize
      ".canvas-edge-end { z-index: 2; background: var(--interactive-accent, #7f6df2); cursor: move }",
      ".canvas-edge-preview { position: absolute; overflow: visible; pointer-events: none }",
      ".canvas-edge-preview path { fill: none; stroke: var(--interactive-accent, #7f6df2); stroke-width: 2px; stroke-dasharray: 6 4 }",
      ".canvas-edge-pin { position: absolute; width: 0; height: 0; transform-origin: 0 0; pointer-events: none; z-index: 3 }",
      ".canvas-edge-toolbar, .canvas-edge-popup { position: absolute; left: 0; transform: translateX(-50%); display: flex; gap: 3px; padding: 3px; white-space: nowrap;" +
        " background: var(--background-secondary, #262626); border: 1px solid var(--background-modifier-border, #444); border-radius: 6px; pointer-events: auto }",
      ".canvas-edge-toolbar { bottom: 16px }",
      ".canvas-edge-popup { bottom: 54px }",
      ".canvas-edge-toolbar > button, .canvas-edge-popup > button { padding: 2px 7px; font-size: 12px; cursor: pointer }",
      ".canvas-edge-popup > button.canvas-edge-swatch { width: 22px; height: 22px; padding: 0; border-radius: 50%; border: 2px solid var(--background-modifier-border, #555) }",
      ".canvas-edge-label-input { position: absolute; left: 0; top: 0; width: 180px; transform: translate(-50%, -50%); pointer-events: auto; font-size: 14px; text-align: center }",
      ".canvas-edge-menu { position: absolute; z-index: 20; min-width: 170px; padding: 4px; background: var(--background-secondary, #262626);" +
        " border: 1px solid var(--background-modifier-border, #444); border-radius: 6px; box-shadow: 0 4px 14px rgba(0,0,0,.35) }",
      ".canvas-edge-menu-item { padding: 4px 10px; border-radius: 4px; cursor: pointer; color: var(--text-normal, #ddd) }",
      ".canvas-edge-menu-item:hover { background: var(--background-modifier-hover, rgba(255,255,255,.08)) }",
    ].join("\n");
    document.head.appendChild(s);
  }

  /* ------------------------------------------------------------ hooks */
  function attach(c, ctx) {
    const S = c._cve || install(c);
    S.ctx = ctx || S.ctx || {};
    S.geo.clear();
    return S;
  }
  function paint(c, e, g, geo) {
    const S = c._cve; if (!S) return;
    S.geo.set(e.id, geo);
    const line = g.querySelector(".canvas-edge-line");
    const hit = sv("path", { class: "canvas-edge-hit", d: line ? line.getAttribute("d") : "",
                             style: "fill: none; stroke: transparent; stroke-width: " + (HIT / (c.zoom || 1)) + "px; pointer-events: stroke" });
    g.insertBefore(hit, g.firstChild);
    const lab = g.querySelector(".canvas-edge-label");
    if (lab) lab.style.pointerEvents = "auto";
  }
  function done(c) { const S = c._cve; if (S) refresh(c); }

  /* ------------------------------------------------------------ state */
  function install(c) {
    style();
    const S = c._cve = { ctx: {}, geo: new Map(), hover: null, sel: null, hnode: null, drag: null, press: null,
                         pop: null, menu: null, label: null, zoom: c.zoom };
    S.overlay = el("div", "canvas-edge-overlay", c.canvasEl);
    S.handlesEl = el("div", "canvas-edge-handles", S.overlay);
    S.endsEl = el("div", "canvas-edge-ends", S.overlay);
    S.previewEl = sv("svg", { class: "canvas-edge-preview", width: "1", height: "1" }, S.overlay);
    S.previewEl.style.display = "none";
    S.previewPath = sv("path", { d: "" }, S.previewEl);
    S.pin = el("div", "canvas-edge-pin", S.overlay);           // the toolbar / label editor anchor: unscaled px at a canvas point
    const w = c.wrapperEl;
    w.addEventListener("pointerdown", ev => onDown(c, ev), true);
    w.addEventListener("pointermove", ev => onHover(c, ev), true);
    w.addEventListener("pointerleave", () => { if (!S.drag && (S.hover || S.hnode)) { S.hover = null; S.hnode = null; refresh(c); ping(c); } });
    w.addEventListener("dblclick", ev => onDbl(c, ev), true);
    w.addEventListener("contextmenu", ev => onMenu(c, ev), true);
    w.addEventListener("keydown", ev => onKey(c, ev), true);
    w.addEventListener("wheel", () => { if (S.menu) closeMenu(c); }, { capture: true, passive: true });
    return S;
  }
  const ping = c => { const f = c._cve && c._cve.ctx && c._cve.ctx.changed; if (typeof f === "function") try { f(); } catch (_) {} };
  const mine = t => !!(t && t.closest && t.closest(".canvas-edge-overlay, .canvas-edge-menu"));
  const edgeOf = (c, t) => { const g = t && t.closest ? t.closest("g.canvas-edge") : null; const id = g && g.getAttribute("data-edge-id"); return id && c.edges.has(id) ? id : null; };
  const nodeData = (c, id) => { const n = c.nodes.get(id); return n ? n.data : null; };
  const save = c => { c.renderEdges(); c.requestSave(); ping(c); };

  // the topmost card under a canvas point (a card over a group wins, the smaller group wins), optionally within m canvas px
  function nodeAt(c, p, m, skip) {
    m = m || 0; let best = null, bestA = Infinity, bestG = true;
    for (const n of c.nodes.values()) {
      const d = n.data; if (skip && d.id === skip) continue;
      if (p[0] < d.x - m || p[0] > d.x + d.width + m || p[1] < d.y - m || p[1] > d.y + d.height + m) continue;
      const g = d.type === "group", a = d.width * d.height;
      if (!best || (bestG && !g) || (bestG === g && a < bestA)) { best = n; bestA = a; bestG = g; }
    }
    return best;
  }
  function sideNear(c, d, p, other) {
    let s = null, best = Infinity;
    for (const k of SIDES) { const a = anchor(d, k), dist = Math.hypot(a[0] - p[0], a[1] - p[1]); if (dist < best) { best = dist; s = k; } }
    const edgeDist = Math.min(Math.abs(p[0] - d.x), Math.abs(p[0] - d.x - d.width), Math.abs(p[1] - d.y), Math.abs(p[1] - d.y - d.height));
    if (edgeDist <= SNAP / (c.zoom || 1) && best <= Math.max(d.width, d.height) / 2 + SNAP / (c.zoom || 1)) return s;
    return other ? facing(d, other) : s;
  }
  // a connection handle's centre: the side's midpoint pushed OUT screen px outward
  const handlePos = (c, d, side) => { const a = anchor(d, side), o = OUT / (c.zoom || 1); return [a[0] + NORMAL[side][0] * o, a[1] + NORMAL[side][1] * o]; };
  // the painted handle under a press, or null. Handles take no pointer events (CSS) and a press
  // INSIDE the card is never a handle press: the card's border band is canvas-select's resize zone
  // (resize from any edge), the part of the handle outside the card is the connect grab.
  function handleAt(c, ev) {
    const S = c._cve, d = !c.readonly && S.hnode && nodeData(c, S.hnode);
    if (!d || !S.handlesEl.firstChild) return null;
    const p = pt(c, ev), z = c.zoom || 1;
    if (p[0] >= d.x && p[0] <= d.x + d.width && p[1] >= d.y && p[1] <= d.y + d.height) return null;
    for (const s of SIDES) { const h = handlePos(c, d, s); if (Math.hypot(h[0] - p[0], h[1] - p[1]) * z <= HANDLE / 2 + 1) return { node: d.id, side: s }; }
    return null;
  }
  const pt = (c, ev) => { const q = c.toCanvas(ev.clientX, ev.clientY); return [q.x, q.y]; };

  /* ------------------------------------------------------------ painting */
  function refresh(c) {
    const S = c._cve, z = c.zoom || 1;
    if (S.sel && !c.edges.has(S.sel)) { S.sel = null; S.pop = null; }
    if (S.hover && !c.edges.has(S.hover)) S.hover = null;
    if (S.hnode && !c.nodes.has(S.hnode)) S.hnode = null;
    if (S.zoom !== z) {   // the hit stroke and the handles keep their screen size across a zoom
      S.zoom = z;
      for (const h of c.edgeEl.querySelectorAll(".canvas-edge-hit")) h.style.strokeWidth = (HIT / z) + "px";
    }
    for (const g of c.edgeEl.querySelectorAll("g.canvas-edge")) {
      const id = g.getAttribute("data-edge-id");
      g.classList.toggle("is-hovered", id === S.hover);
      g.classList.toggle("is-selected", id === S.sel);
      g.classList.toggle("is-dragging", !!(S.drag && S.drag.kind === "end" && S.drag.id === id && S.drag.moved));
    }
    const hs = HANDLE / z;
    const dot = (cls, parent, p, data) => {
      const d = el("div", cls, parent);
      d.style.left = (p[0] - hs / 2) + "px"; d.style.top = (p[1] - hs / 2) + "px"; d.style.width = hs + "px"; d.style.height = hs + "px";
      for (const k in data) d.dataset[k] = data[k];
      return d;
    };
    S.handlesEl.textContent = "";
    const hn = S.hnode && nodeData(c, S.hnode);
    if (hn && !c.readonly && !(S.drag && S.drag.kind)) for (const s of SIDES) dot("canvas-edge-handle", S.handlesEl, handlePos(c, hn, s), { node: hn.id, side: s });
    S.endsEl.textContent = "";
    if (!c.readonly && !(S.drag && S.drag.moved)) for (const id of new Set([S.hover, S.sel])) {
      const g = id && S.geo.get(id); if (!g) continue;
      dot("canvas-edge-end", S.endsEl, g.p1, { edge: id, end: "from" });
      dot("canvas-edge-end", S.endsEl, g.p2, { edge: id, end: "to" });
    }
    paintPin(c);
  }
  function paintPin(c) {
    const S = c._cve, z = c.zoom || 1;
    S.pin.textContent = "";
    const id = S.label ? S.label.id : S.sel, g = id && S.geo.get(id), e = id && c.edges.get(id);
    if (!g || !e || (S.drag && S.drag.moved)) { S.pin.style.display = "none"; if (S.label && !g) S.label = null; return; }
    const m = bez(g, 0.5);
    S.pin.style.display = ""; S.pin.style.left = m[0] + "px"; S.pin.style.top = m[1] + "px"; S.pin.style.transform = "scale(" + (1 / z) + ")";
    if (S.label) { S.pin.appendChild(S.label.input); return; }
    if (c.readonly) return;
    const bar = el("div", "canvas-edge-toolbar", S.pin);
    const b = (act, txt, label, fn, parent) => {
      const x = el("button", "", parent || bar); x.type = "button"; x.dataset.act = act; x.textContent = txt; x.title = label; x.setAttribute("aria-label", label);
      x.addEventListener("click", ev => { ev.stopPropagation(); ev.preventDefault(); fn(); });
      return x;
    };
    b("del", "Delete", "Delete connection", () => removeEdge(c, id));
    b("color", "Colour", "Connection colour", () => { S.pop = S.pop === "color" ? null : "color"; paintPin(c); ping(c); });
    b("dir", "Direction", "Line direction", () => { S.pop = S.pop === "dir" ? null : "dir"; paintPin(c); ping(c); });
    b("label", "Label", "Edit label", () => openLabel(c, id));
    if (e.label) b("unlabel", "Remove label", "Remove label", () => { delete e.label; S.pop = null; save(c); });
    if (S.pop === "color") {
      const p = el("div", "canvas-edge-popup", S.pin); p.dataset.pop = "color";
      const none = b("none", "∅", "No colour", () => setColor(c, id, null), p); none.classList.add("canvas-edge-swatch");
      const colorOf = S.ctx.colorOf || (() => null);
      for (const k of ["1", "2", "3", "4", "5", "6"]) {
        const s = b(k, "", "Colour " + k, () => setColor(c, id, k), p); s.classList.add("canvas-edge-swatch");
        s.style.background = colorOf(k) || ""; if (e.color === k) s.style.borderColor = "var(--text-normal, #ddd)";
      }
    } else if (S.pop === "dir") {
      const p = el("div", "canvas-edge-popup", S.pin); p.dataset.pop = "dir";
      b("none", "— None", "Nondirectional", () => setDir(c, id, "none"), p);
      b("uni", "→ One way", "Unidirectional", () => setDir(c, id, "uni"), p);
      b("bi", "↔ Both ways", "Bidirectional", () => setDir(c, id, "bi"), p);
    }
  }
  function preview(c, a, b, fs) {
    const S = c._cve, P = 20;
    const k = Math.max(30, Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.4), n = NORMAL[fs] || [0, 0];
    const c1 = [a[0] + n[0] * k, a[1] + n[1] * k];
    const x0 = Math.min(a[0], b[0], c1[0]) - P, y0 = Math.min(a[1], b[1], c1[1]) - P, x1 = Math.max(a[0], b[0], c1[0]) + P, y1 = Math.max(a[1], b[1], c1[1]) + P;
    const s = S.previewEl;
    s.style.display = ""; s.style.left = x0 + "px"; s.style.top = y0 + "px";
    s.setAttribute("width", String(x1 - x0)); s.setAttribute("height", String(y1 - y0)); s.setAttribute("viewBox", [x0, y0, x1 - x0, y1 - y0].join(" "));
    S.previewPath.setAttribute("d", "M" + a + " Q" + c1 + " " + b);
  }

  /* ------------------------------------------------------------ edits */
  function removeEdge(c, id) {
    const S = c._cve;
    if (c.readonly || !c.edges.has(id)) return;
    c.edges.delete(id);
    if (S.sel === id) { S.sel = null; S.pop = null; }
    if (S.hover === id) S.hover = null;
    save(c);
  }
  function setColor(c, id, k) {
    const e = c.edges.get(id); if (!e || c.readonly) return;
    if (k) e.color = k; else delete e.color;
    c._cve.pop = null; save(c);
  }
  function setDir(c, id, d) {
    const e = c.edges.get(id); if (!e || c.readonly) return;
    e.fromEnd = d === "bi" ? "arrow" : "none";
    e.toEnd = d === "none" ? "none" : "arrow";
    c._cve.pop = null; save(c);
  }
  function select(c, id) {
    const S = c._cve;
    if (S.sel === id) return;
    S.sel = id; S.pop = null;
    if (id && c.selection.size) c.deselectAll();
    refresh(c); ping(c);
  }
  function openLabel(c, id) {
    const S = c._cve, e = c.edges.get(id);
    if (!e || c.readonly) return;
    if (S.label) commitLabel(c);
    const inp = el("input", "canvas-edge-label-input");
    inp.type = "text"; inp.value = e.label || ""; inp.spellcheck = false; inp.setAttribute("aria-label", "Connection label");
    S.label = { id, input: inp, done: false };
    inp.addEventListener("keydown", ev => {
      ev.stopPropagation();
      if (ev.key === "Enter" || ev.key === "Escape") { ev.preventDefault(); commitLabel(c); try { c.wrapperEl.focus({ preventScroll: true }); } catch (_) {} }
    });
    inp.addEventListener("blur", () => commitLabel(c));
    for (const t of ["pointerdown", "dblclick", "contextmenu", "wheel"]) inp.addEventListener(t, ev => ev.stopPropagation());
    S.pop = null;
    paintPin(c); ping(c);
    setTimeout(() => { try { inp.focus(); inp.select(); } catch (_) {} }, 0);
  }
  function commitLabel(c) {
    const S = c._cve, L = S.label;
    if (!L || L.done) return;
    L.done = true; S.label = null;
    const e = c.edges.get(L.id), v = L.input.value.trim();
    L.input.remove();
    if (!e) { paintPin(c); ping(c); return; }
    const was = e.label || "";
    if (v) e.label = v; else delete e.label;
    if (v !== was) save(c); else { paintPin(c); ping(c); }
  }
  function follow(c, id, p) {
    const S = c._cve, g = S.geo.get(id), e = c.edges.get(id);
    if (!g || !e) return;
    const far = Math.hypot(g.p2[0] - p[0], g.p2[1] - p[1]) >= Math.hypot(g.p1[0] - p[0], g.p1[1] - p[1]) ? e.toNode : e.fromNode;
    const d = nodeData(c, far); if (!d) return;
    const r = c.wrapperEl.getBoundingClientRect(), z = c.zoom || 1;
    c.tx = r.width / 2 - (d.x + d.width / 2) * z; c.ty = r.height / 2 - (d.y + d.height / 2) * z;
    c.applyTransform();
    refresh(c); ping(c);
  }

  /* ------------------------------------------------------------ input */
  function onHover(c, ev) {
    const S = c._cve;
    if (S.drag || ev.buttons) return;
    const t = ev.target;
    let hover = S.hover, hnode = S.hnode;
    if (t && t.classList && t.classList.contains("canvas-edge-end")) hover = t.dataset.edge;
    else if (t && t.classList && t.classList.contains("canvas-edge-handle")) hnode = t.dataset.node;
    else {
      hover = edgeOf(c, t);
      if (t && t.closest && t.closest(".canvas-edge-pin, .canvas-controls, .canvas-edge-menu")) hnode = null;
      else {
        const nEl = t && t.closest ? t.closest(".canvas-node") : null;
        const over = nEl && c.nodes.get(nEl.dataset.nodeId);
        const n = over && over.data.type !== "group" ? over : nodeAt(c, pt(c, ev), NEAR / (c.zoom || 1));
        hnode = n && !n.isEditing ? n.id : null;
      }
    }
    if (S.zoom !== c.zoom) refresh(c);
    if (hover === S.hover && hnode === S.hnode) return;
    S.hover = hover; S.hnode = hnode;
    refresh(c); ping(c);
  }
  function onDown(c, ev) {
    const S = c._cve, t = ev.target;
    if (S.menu && !(t.closest && t.closest(".canvas-edge-menu"))) closeMenu(c);
    if (t.closest && t.closest(".canvas-edge-menu, .canvas-edge-pin")) { ev.stopPropagation(); return; }
    if (S.label) commitLabel(c);
    const isE = t.classList && t.classList.contains("canvas-edge-end"), hh = isE ? null : handleAt(c, ev), isH = !!hh;
    const id = isE ? t.dataset.edge : edgeOf(c, t);
    if (!isH && !id) { if (S.sel) { S.sel = null; S.pop = null; refresh(c); ping(c); } return; }
    ev.stopPropagation();
    if (ev.button !== 0) return;
    ev.preventDefault();
    try { c.wrapperEl.focus({ preventScroll: true }); } catch (_) {}
    if (c.readonly) { if (id) select(c, id); return; }
    if (isH) return startDrag(c, ev, { kind: "new", node: hh.node, side: hh.side });
    if (isE) { select(c, id); return startDrag(c, ev, { kind: "end", id, end: t.dataset.end }); }
    // a press on the edge: select; a second press on it within 450ms opens the label editor
    const now = Date.now(), pr = S.press;
    S.press = { id, t: now, x: ev.clientX, y: ev.clientY }; S.edgePress = now;
    select(c, id);
    if (pr && pr.id === id && now - pr.t < 450 && Math.hypot(pr.x - ev.clientX, pr.y - ev.clientY) < 8) { S.press = null; openLabel(c, id); }
  }
  function startDrag(c, ev, d) {
    const S = c._cve;
    d.x = ev.clientX; d.y = ev.clientY; d.moved = false;
    S.drag = d;
    const move = e => {
      if (!d.moved && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < 4) return;
      if (!d.moved) { d.moved = true; refresh(c); }
      const p = pt(c, e);
      if (d.kind === "new") { const n = nodeData(c, d.node); if (n) preview(c, anchor(n, d.side), p, d.side); }
      else {
        const g = S.geo.get(d.id); if (!g) return;
        preview(c, d.end === "to" ? g.p1 : g.p2, p, d.end === "to" ? g.fs : g.ts);
      }
      e.preventDefault();
    };
    const up = e => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      S.drag = null; S.previewEl.style.display = "none";
      if (e.type === "pointerup" && d.moved) drop(c, d, pt(c, e));
      refresh(c); ping(c);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
  }
  function drop(c, d, p) {
    const S = c._cve, newId = S.ctx.newId;
    if (d.kind === "new") {
      const from = nodeData(c, d.node); if (!from) return;
      const tgt = nodeAt(c, p, 0, d.node);
      let to, toSide;
      if (tgt) { to = tgt.data; toSide = sideNear(c, to, p, from); }
      else {   // empty board: a text card whose facing side sits on the drop point
        const a = anchor(from, d.side), dx = p[0] - a[0], dy = p[1] - a[1], W = 250, H = 60;
        let x, y;
        if (Math.abs(dy) >= Math.abs(dx)) { toSide = dy >= 0 ? "top" : "bottom"; x = p[0] - W / 2; y = dy >= 0 ? p[1] : p[1] - H; }
        else { toSide = dx >= 0 ? "left" : "right"; y = p[1] - H / 2; x = dx >= 0 ? p[0] : p[0] - W; }
        const n = c.createTextNode({ pos: { x, y }, size: { width: W, height: H }, save: false });
        to = n.data;
      }
      const ids = new Set([...c.nodes.keys(), ...c.edges.keys()]);
      const id = typeof newId === "function" ? newId(ids) : "e" + Date.now().toString(16);
      c.edges.set(id, { id, fromNode: from.id, fromSide: d.side, toNode: to.id, toSide });
      S.sel = null;
      save(c);
      return;
    }
    const e = c.edges.get(d.id); if (!e) return;
    const fixed = nodeData(c, d.end === "to" ? e.fromNode : e.toNode);
    const tgt = nodeAt(c, p, 0);
    if (!tgt) { removeEdge(c, d.id); return; }   // dropped off every card: the connection is gone
    const k = d.end === "to" ? "to" : "from";
    e[k + "Node"] = tgt.data.id;
    e[k + "Side"] = sideNear(c, tgt.data, p, fixed && fixed.id !== tgt.data.id ? fixed : null);
    save(c);
  }
  function onDbl(c, ev) {
    const S = c._cve, t = ev.target;
    if (mine(t)) { ev.stopPropagation(); return; }
    const id = edgeOf(c, t);
    // the second press of a double press on an edge already opened the editor, which now covers the edge: the dblclick may
    // land on a common ancestor, and must not reach the board (a dblclick on empty board makes a card)
    if (!id) { if (S.label || Date.now() - (S.edgePress || 0) < 700) { ev.stopPropagation(); ev.preventDefault(); } return; }
    ev.stopPropagation(); ev.preventDefault();
    if (!S.label && !c.readonly) openLabel(c, id);
  }
  function onMenu(c, ev) {
    const S = c._cve, t = ev.target;
    if (mine(t)) { ev.preventDefault(); ev.stopPropagation(); return; }
    const id = edgeOf(c, t); if (!id) return;
    ev.preventDefault(); ev.stopPropagation();
    closeMenu(c);
    const p = pt(c, ev), w = c.wrapperEl, r = w.getBoundingClientRect();
    const m = el("div", "canvas-edge-menu", w);
    m.style.left = (ev.clientX - r.left) + "px"; m.style.top = (ev.clientY - r.top) + "px";
    const item = (act, txt, fn) => {
      const i = el("div", "canvas-edge-menu-item", m); i.dataset.act = act; i.textContent = txt;
      i.addEventListener("click", e => { e.stopPropagation(); closeMenu(c); fn(); });
    };
    item("follow", "Follow connection", () => follow(c, id, p));
    if (!c.readonly) {
      item("label", "Edit label", () => { select(c, id); openLabel(c, id); });
      item("del", "Delete connection", () => removeEdge(c, id));
    }
    for (const ty of ["pointerdown", "dblclick", "wheel"]) m.addEventListener(ty, e => e.stopPropagation());
    S.menu = m;
    select(c, id);
    ping(c);
  }
  function closeMenu(c) { const S = c._cve; if (S.menu) { S.menu.remove(); S.menu = null; ping(c); } }
  function onKey(c, ev) {
    const S = c._cve, t = ev.target;
    if (S.label && t === S.label.input) return;
    if (t && t.closest && t.closest("textarea, input, .markdown-source-view, [contenteditable=true]")) return;
    if (ev.key === "Escape" && (S.menu || S.pop || S.sel)) {
      if (S.menu) closeMenu(c); else if (S.pop) { S.pop = null; paintPin(c); ping(c); } else { S.sel = null; refresh(c); ping(c); }
      ev.stopPropagation(); return;
    }
    if ((ev.key === "Delete" || ev.key === "Backspace") && S.sel && !c.readonly && !(ev.ctrlKey || ev.metaKey || ev.altKey)) {
      ev.preventDefault(); ev.stopPropagation();
      removeEdge(c, S.sel);
    }
  }

  /* ------------------------------------------------------------ census
     main.js canvasTok -> census(view): this goal's tokens, client px, read off
     the geometry this file keeps and the DOM it paints. */
  function census(v) {
    const c = v && v.canvas, S = c && c._cve;
    if (!S) return "";
    const esc = x => String(x == null ? "" : x).replace(/[[\]|@,]/g, "_");
    const vis = e => !!e && e.getClientRects().length > 0;
    const ctr = e => { const r = e.getBoundingClientRect(); return Math.round(r.x + r.width / 2) + "," + Math.round(r.y + r.height / 2); };
    const cl = p => { const q = c.toClient(p[0], p[1]); return Math.round(q.x) + "," + Math.round(q.y); };
    let t = "";
    const es = [];
    for (const [id, g] of S.geo) { if (es.length >= 16) break; if (c.edges.has(id)) es.push(esc(id) + "@" + [cl(bez(g, 0.5)), cl(g.p1), cl(g.p2), cl(bez(g, 0.15)), cl(bez(g, 0.85))].join(",")); }
    if (es.length) t += " [cve:" + es.join("|") + "]";
    const hs = [...S.handlesEl.querySelectorAll(".canvas-edge-handle")].filter(vis);
    if (hs.length) t += " [cvhandle:" + hs.map(h => esc(h.dataset.node) + ":" + h.dataset.side + "@" + ctr(h)).join("|") + "]";
    if (S.hover) {
      const g = c.edgeEl.querySelector('g.canvas-edge[data-edge-id="' + CSS.escape(S.hover) + '"]');
      const n = [...S.endsEl.querySelectorAll(".canvas-edge-end")].filter(h => h.dataset.edge === S.hover && vis(h)).length;
      t += " [cvehov:" + esc(S.hover) + "|cls=" + (g && g.classList.contains("is-hovered") ? 1 : 0) + "|h=" + n + "]";
    }
    if (S.sel) t += " [cvesel:" + esc(S.sel) + "]";
    const list = (tok, sel) => { const b = [...S.pin.querySelectorAll(sel)].filter(vis); if (b.length) t += " [" + tok + ":" + b.map(x => x.dataset.act + "@" + ctr(x)).join("|") + "]"; };
    list("cvetb", ".canvas-edge-toolbar > button");
    list("cvepal", '.canvas-edge-popup[data-pop="color"] > button');
    list("cvedir", '.canvas-edge-popup[data-pop="dir"] > button');
    if (S.label && vis(S.label.input)) t += " [cvelab:" + esc(S.label.id) + "]";
    if (S.menu && vis(S.menu)) t += " [cvemenu:" + [...S.menu.querySelectorAll(".canvas-edge-menu-item")].map(x => x.dataset.act + "@" + ctr(x)).join("|") + "]";
    const fit = c.controlsEl && c.controlsEl.querySelector(".canvas-control.mod-zoom-fit");
    if (vis(fit)) t += " [cvefit:" + ctr(fit) + "]";
    return t;
  }

  Object.defineProperty(window, "CanvasEdges", {
    configurable: false, enumerable: false, writable: false,
    value: Object.freeze({ attach, paint, done, census }),
  });
})();
