// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* canvas menus (goal cv-menus): everything on the board is reachable from a menu —
   the card / selection / board context menus, the pickers and prompts they open,
   the card toolbar at the bottom of the board and drops from the file explorer.
   Written from the public help pages and the JSON Canvas 1.0 spec (clean room).

   Load order (index.html): canvas.js -> canvas-history.js -> canvas-cards.js ->
   canvas-select.js -> canvas-menus.js -> main.js. This file runs NO code at load
   beyond defining window.CanvasMenus; canvas.js calls install(canvas, ctx) once
   per board at the end of wire() (ctx = {X, app, deps, changed, NODE_CLASS}).

   Right-click
     a card        -> (the card joins / becomes the selection) Create group, and by kind:
                      text  Convert to file (prompt: the note name, in the canvas's folder)
                      file  Swap file (picker: files of the same kind), Narrow to heading
                            (picker: the note's headings and ^blocks), Show full note
                      group Set / Replace background (picker: images), Remove background,
                            Background style: Cover | Fit | Repeat
                      a multi-selection: Create group (around it), Remove
     the board     -> Add card, Add note from vault, Add media from vault, Add web page
                      (prompt: the URL), Create group (an empty one at the pointer)
   The card toolbar (bottom centre) holds Text / Note / Media: a click adds at the
   centre of the view, a drag adds at the release point (note / media ask the picker).
   A file dragged from the explorer (app.dragManager.draggable) drops as a file card
   centred on the drop point.
   Every edit ends in canvas.requestSave(), so cv-history makes it undoable. */
(function () {
  "use strict";
  const IMG = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
  const MEDIA = new Set([...IMG, "mp3", "wav", "m4a", "ogg", "3gp", "flac", "mp4", "webm", "ogv", "mov", "mkv", "pdf"]);
  const PAD = 20;                       // group padding around the selection, canvas units
  const STYLES = [["cover", "Cover"], ["ratio", "Fit"], ["repeat", "Repeat"]];
  let open = null;                      // the picker / prompt on screen: {kind, type: "pick"|"prompt", m, input}
  let styled = false;

  const el = (tag, cls, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; if (parent) parent.appendChild(e); return e; };
  const extOf = p => { const n = String(p || "").split("/").pop(); const d = n.lastIndexOf("."); return d > 0 ? n.slice(d + 1).toLowerCase() : ""; };
  const dirOf = p => { const s = String(p || ""); const i = s.lastIndexOf("/"); return i > 0 ? s.slice(0, i) : ""; };
  const kindOf = p => { const x = extOf(p); return x === "md" ? "note" : MEDIA.has(x) ? "media" : x === "canvas" ? "canvas" : "file"; };
  const ro = c => !!(c.readonly || (c.options && c.options.readOnly));
  const C = c => c._cvm;
  const ping = c => { const s = C(c); if (s && typeof s.ctx.changed === "function") try { s.ctx.changed(); } catch (_) {} };
  const later = c => setTimeout(() => ping(c), 0);
  const notify = (c, msg) => { const d = C(c) && C(c).ctx.deps; if (d && typeof d.notify === "function") d.notify(msg); };

  function style() {
    if (styled) return; styled = true;
    const s = document.createElement("style");
    s.dataset.owner = "canvas-menus";
    s.textContent = [
      ".canvas-card-menu { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); z-index: 4; display: flex; gap: 2px; padding: 4px; border-radius: 8px; background: var(--background-secondary, #262626); border: 1px solid var(--background-modifier-border, #444); box-shadow: 0 2px 8px rgba(0,0,0,.3); user-select: none }",
      ".canvas-card-menu-item { font: inherit; font-size: 12px; min-width: 54px; padding: 4px 10px; border: 0; border-radius: 5px; background: transparent; color: var(--text-muted, #aaa); cursor: grab }",
      ".canvas-card-menu-item:hover { background: var(--background-modifier-hover, #333); color: var(--text-normal, #ddd) }",
      ".canvas-wrapper.is-card-dragging, .canvas-wrapper.is-card-dragging * { cursor: copy }",
      ".canvas-menus-prompt input { width: 100%; box-sizing: border-box; font: inherit; padding: 6px 8px }",
      ".canvas-menus-prompt .canvas-menus-hint { margin-top: 6px; font-size: 12px; color: var(--text-muted, #aaa) }",
    ].join("\n");
    document.head.appendChild(s);
  }

  /* ---------------------------------------------- mutations (all end in requestSave) */
  function addData(c, d, front) {
    const N = C(c).ctx.NODE_CLASS[d.type];
    const n = c.addNode(new N(c, d));
    if (front) {                        // a new group goes FIRST in nodes[] (JSON Canvas: lower index = below)
      const rest = [...c.nodes].filter(([k]) => k !== n.id);
      c.nodes.clear(); c.nodes.set(n.id, n); for (const [k, v] of rest) c.nodes.set(k, v);
    }
    c.renderEdges(); c.requestSave(); later(c);
    return n;
  }
  // the node's object changed kind (text -> file): a new node class over the SAME object, same id, same place in nodes[] and the layer
  function replaceNode(c, old, d) {
    const N = C(c).ctx.NODE_CLASS[d.type];
    if (old.isEditing) try { old.stopEditing(); } catch (_) {}
    const nn = new N(c, d), sel = c.selection.has(old);
    const layer = d.type === "group" ? c.groupEl : c.nodeEl, next = old.containerEl.parentNode === layer ? old.containerEl.nextSibling : null;
    const order = [...c.nodes];
    c.selection.delete(old); old.detach();
    c.nodes.clear(); for (const [k, v] of order) c.nodes.set(k, k === old.id ? nn : v);
    layer.insertBefore(nn.containerEl, next);
    nn.load(); nn.render();
    if (sel) c.select(nn, false);
    c.renderEdges(); c.requestSave(); later(c);
    return nn;
  }
  function newId(c) {
    const taken = c.ids();
    for (;;) { const b = new Uint8Array(8); crypto.getRandomValues(b); const id = Array.from(b, x => x.toString(16).padStart(2, "0")).join(""); if (!taken.has(id)) return id; }
  }
  function groupAt(c, p) {
    return addData(c, { id: newId(c), type: "group", x: Math.round(p.x), y: Math.round(p.y), width: 400, height: 300 }, true);
  }
  function groupAround(c, nodes) {
    if (!nodes.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) { const d = n.data; x0 = Math.min(x0, d.x); y0 = Math.min(y0, d.y); x1 = Math.max(x1, d.x + d.width); y1 = Math.max(y1, d.y + d.height); }
    const g = addData(c, { id: newId(c), type: "group", x: Math.floor(x0 - PAD), y: Math.floor(y0 - PAD), width: Math.ceil(x1 - x0 + 2 * PAD), height: Math.ceil(y1 - y0 + 2 * PAD) }, true);
    c.select(g, false);
    return g;
  }
  function addFile(c, path, pos, center) {
    const w = 400, h = kindOf(path) === "note" ? 400 : 300;
    const n = c.createFileNode({ file: path, pos: center ? { x: pos.x - w / 2, y: pos.y - h / 2 } : pos, size: { width: w, height: h } });
    c.renderEdges(); later(c);
    return n;
  }
  function addLink(c, url, pos) {
    return addData(c, { id: newId(c), type: "link", url, x: Math.round(pos.x), y: Math.round(pos.y), width: 400, height: 300 });
  }
  async function convertToFile(c, n, name) {
    const { app } = C(c).ctx;
    name = String(name || "").trim().replace(/\.md$/i, "").replace(/[\\:*?"<>|]/g, "").replace(/^\/+|\/+$/g, "");
    if (!name) return;
    const dir = dirOf(c.path), path = (dir ? dir + "/" : "") + name + ".md";
    if (app.vault.getAbstractFileByPath(path)) { notify(c, "Canvas: " + path + " already exists — pick another name"); return; }
    if (c.nodes.get(n.id) !== n || n.data.type !== "text") return;
    try { await app.vault.create(path, n.data.text); }
    catch (e) { notify(c, "Canvas: " + path + " was not created — " + String((e && e.message) || e)); return; }
    if (c.nodes.get(n.id) !== n) return;
    const d = n.data;
    delete d.text; d.type = "file"; d.file = path;
    replaceNode(c, n, d);
  }
  function swapFile(c, n, path) { if (c.nodes.get(n.id) !== n) return; n.setFilePath(path, ""); n.renderContent(); c.requestSave(); later(c); }
  function narrow(c, n, sub) { if (c.nodes.get(n.id) !== n) return; n.setFilePath(n.data.file, sub); n.renderContent(); c.requestSave(); later(c); }
  function setBackground(c, g, path, how) {
    const d = g.data;
    if (path === null) { delete d.background; delete d.backgroundStyle; }
    else if (path !== undefined) d.background = path;
    if (how) d.backgroundStyle = how;
    g.renderContent(); c.requestSave(); later(c);
  }

  /* ---------------------------------------------- pickers and prompts */
  function files(c, pred) {
    const { app } = C(c).ctx;
    let fs = [];
    try { fs = app.vault.getFiles(); } catch (_) {}
    return fs.filter(f => f && typeof f.path === "string" && pred(f)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }
  function picker(c, kind, placeholder, items, text, choose) {
    const { X, app } = C(c).ctx;
    if (!items.length) { notify(c, "Canvas: nothing to pick (" + kind + ")"); return null; }
    class Pick extends X.FuzzySuggestModal {
      getItems() { return items; }
      getItemText(i) { return text(i); }
      onChooseItem(i) { setTimeout(() => { try { choose(i); } catch (e) { console.error("[canvas] menu:", e); } }, 0); }
      onClose() { if (open && open.m === this) open = null; later(c); }
    }
    const m = new Pick(app);
    m.setPlaceholder(placeholder);
    open = { kind, type: "pick", m, input: m.inputEl };
    m.inputEl.addEventListener("input", () => later(c));
    m.open(); later(c);
    return m;
  }
  function prompt(c, kind, title, value, hint, submit) {
    const { X, app } = C(c).ctx;
    const m = new X.Modal(app);
    m.modalEl.classList.add("canvas-menus-prompt");
    m.setTitle(title);
    const input = el("input", "", m.contentEl);
    input.type = "text"; input.spellcheck = false; input.value = value || "";
    if (hint) el("div", "canvas-menus-hint", m.contentEl).textContent = hint;
    input.addEventListener("input", () => later(c));
    input.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); const v = input.value; m.close(); setTimeout(() => { try { submit(v); } catch (er) { console.error("[canvas] menu:", er); } }, 0); }
      else if (e.key === "Escape") { e.preventDefault(); m.close(); }
    });
    m.onClose = () => { if (open && open.m === m) open = null; later(c); };
    open = { kind, type: "prompt", m, input };
    m.open();
    setTimeout(() => { try { input.focus(); input.select(); } catch (_) {} later(c); }, 0);
    return m;
  }
  const pickNote = (c, then) => picker(c, "note", "Add a note from the vault…", files(c, f => f.extension === "md"), f => f.path, f => then(f.path));
  const pickMedia = (c, then) => picker(c, "media", "Add media from the vault…", files(c, f => MEDIA.has(String(f.extension).toLowerCase())), f => f.path, f => then(f.path));
  const askUrl = (c, then) => prompt(c, "url", "Add web page", "https://", "The page is shown as a link card; it is never loaded.", v => {
    const u = String(v || "").trim();
    if (!/^https?:\/\/[^\s/]+/i.test(u)) { notify(c, "Canvas: not a web address — " + u); return; }
    then(u);
  });
  // the note's headings and ^blocks, read from its text (fenced code skipped)
  async function sections(c, n) {
    const { app } = C(c).ctx;
    const f = n.file || (app.vault.getAbstractFileByPath && app.vault.getAbstractFileByPath(n.data.file));
    if (!f) return [];
    let t = "";
    try { t = await app.vault.cachedRead(f); } catch (_) { return []; }
    const out = []; let fence = false;
    for (const line of t.split("\n")) {
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
      if (fence) continue;
      const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (h) { out.push({ label: h[2], sub: "#" + h[2] }); continue; }
      const b = /\s\^([A-Za-z0-9-]+)\s*$/.exec(line);
      if (b) out.push({ label: "^" + b[1] + "  " + line.replace(/\s\^[A-Za-z0-9-]+\s*$/, "").trim().slice(0, 40), sub: "#^" + b[1] });
    }
    return out;
  }

  /* ---------------------------------------------- the context menus */
  function nodeOf(c, t) { const e = t && t.closest ? t.closest(".canvas-node") : null; return e && c.nodes.get(e.dataset.nodeId) || null; }
  function onContext(c, e) {
    const t = e.target;
    if (t && t.closest && t.closest("textarea, .markdown-source-view, [contenteditable=true], .canvas-controls, .canvas-card-menu, .canvas-selection-toolbar")) return;
    e.preventDefault();
    if (ro(c)) return;
    const { X, app } = C(c).ctx;
    const n = nodeOf(c, t), m = new X.Menu();
    const item = (title, fn, on) => m.addItem(i => { i.setTitle(title).onClick(() => { try { fn(); } catch (er) { console.error("[canvas] menu:", er); } }); if (on !== undefined) i.setChecked(on); });
    if (n) {
      if (!c.selection.has(n)) c.select(n, false);
      const sel = [...c.selection], d = n.data;
      if (sel.length === 1) {
        if (d.type === "text") item("Convert to file", () => {
          const first = String(d.text || "").split("\n").map(s => s.replace(/^#+\s*/, "").trim()).find(Boolean) || "Untitled";
          prompt(c, "convert", "Convert to file", first.slice(0, 60), "The card's text becomes a note of this name, in the canvas's folder.", v => convertToFile(c, n, v));
        });
        if (d.type === "file") {
          const k = kindOf(d.file);
          item("Swap file", () => picker(c, "swap", "Swap for another " + (k === "file" ? "file" : k) + "…",
            files(c, f => f.path !== d.file && kindOf(f.path) === k), f => f.path, f => swapFile(c, n, f.path)));
          if (k === "note") {
            item("Narrow to heading", () => sections(c, n).then(list => picker(c, "narrow", "Show only a heading or block…", list, s => s.label, s => narrow(c, n, s.sub))));
            if (d.subpath) item("Show full note", () => narrow(c, n, ""));
          }
        }
        if (d.type === "group") {
          const bg = typeof d.background === "string" && d.background;
          item(bg ? "Replace background" : "Set background", () => picker(c, "background", "Background image…",
            files(c, f => IMG.has(String(f.extension).toLowerCase())), f => f.path, f => setBackground(c, n, f.path)));
          if (bg) {
            item("Remove background", () => setBackground(c, n, null));
            const cur = d.backgroundStyle || "cover";
            for (const [v, label] of STYLES) item("Background style: " + label, () => setBackground(c, n, undefined, v), cur === v);
          }
        }
      }
      item("Create group", () => groupAround(c, [...c.selection]));
      item("Remove", () => c.deleteSelection());
      try { app.workspace.trigger(sel.length > 1 ? "canvas:selection-menu" : "canvas:node-menu", m, sel.length > 1 ? c : n); } catch (_) {}
    } else {
      const p = c.toCanvas(e.clientX, e.clientY);
      item("Add card", () => c.createTextNode({ pos: p, focus: true }));
      item("Add note from vault", () => pickNote(c, path => addFile(c, path, p)));
      item("Add media from vault", () => pickMedia(c, path => addFile(c, path, p)));
      item("Add web page", () => askUrl(c, u => addLink(c, u, p)));
      item("Create group", () => { c.deselectAll(); groupAt(c, p); });
      try { app.workspace.trigger("canvas:menu", m, c); } catch (_) {}
    }
    m.showAtMouseEvent(e);
  }

  /* ---------------------------------------------- the card toolbar */
  const TOOLS = [["text", "Text", "Drag to add a card"], ["note", "Note", "Drag to add a note from the vault"], ["media", "Media", "Drag to add media from the vault"]];
  function toolbar(c) {
    const bar = el("div", "canvas-card-menu", c.wrapperEl);
    C(c).bar = bar;
    for (const [kind, label, title] of TOOLS) {
      const b = el("button", "canvas-card-menu-item mod-" + kind, bar);
      b.type = "button"; b.textContent = label; b.title = title; b.setAttribute("aria-label", title); b.dataset.tool = kind;
      let down = null;
      b.addEventListener("pointerdown", e => {
        e.stopPropagation(); if (e.button !== 0 || ro(c)) return; e.preventDefault();
        down = { x: e.clientX, y: e.clientY, moved: false };
        try { b.setPointerCapture(e.pointerId); } catch (_) {}
      });
      b.addEventListener("pointermove", e => {
        if (!down) return;
        if (!down.moved && Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > 5) { down.moved = true; c.wrapperEl.classList.add("is-card-dragging"); }
      });
      const end = (e, cancel) => {
        if (!down) return;
        const d = down; down = null;
        try { b.releasePointerCapture(e.pointerId); } catch (_) {}
        c.wrapperEl.classList.remove("is-card-dragging");
        if (cancel || ro(c)) return;
        const r = c.wrapperEl.getBoundingClientRect(), br = bar.getBoundingClientRect();
        let pos, center = true;
        if (d.moved) {
          const inBoard = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
          const onBar = e.clientX >= br.left && e.clientX <= br.right && e.clientY >= br.top && e.clientY <= br.bottom;
          if (!inBoard || onBar) return;
          pos = c.toCanvas(e.clientX, e.clientY);
        } else pos = c.toCanvas(r.left + r.width / 2, r.top + r.height / 2);
        use(c, kind, pos, center);
      };
      b.addEventListener("pointerup", e => end(e, false));
      b.addEventListener("pointercancel", e => end(e, true));
      b.addEventListener("click", e => e.stopPropagation());
      b.addEventListener("dblclick", e => e.stopPropagation());
    }
  }
  function use(c, kind, pos, center) {
    if (kind === "text") { c.createTextNode({ pos: center ? { x: pos.x - 125, y: pos.y - 30 } : pos, focus: true }); later(c); return; }
    if (kind === "note") pickNote(c, path => addFile(c, path, pos, center));
    else pickMedia(c, path => addFile(c, path, pos, center));
  }

  /* ---------------------------------------------- drops from the file explorer */
  function dragged(c) {
    const { app, X } = C(c).ctx, dm = app && app.dragManager, d = dm && dm.draggable;
    if (!d) return [];
    const fs = d.type === "file" ? [d.file] : d.type === "files" ? d.files || [] : [];
    return fs.filter(f => f && (!X.TFile || f instanceof X.TFile) && typeof f.path === "string");
  }
  function onDragOver(c, e) {
    if (ro(c) || !dragged(c).length) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = "copy"; } catch (_) {}
  }
  function onDrop(c, e) {
    const fs = dragged(c);
    if (ro(c) || !fs.length) return;
    e.preventDefault(); e.stopPropagation();
    const p = c.toCanvas(e.clientX, e.clientY);
    fs.forEach((f, i) => addFile(c, f.path, { x: p.x + i * 30, y: p.y + i * 30 }, true));
  }

  function install(c, ctx) {
    if (!c || c._cvm || !ctx || !ctx.X || !ctx.NODE_CLASS) return;
    c._cvm = { ctx, bar: null };
    style();
    const w = c.wrapperEl;
    w.addEventListener("contextmenu", e => onContext(c, e));
    w.addEventListener("dragover", e => onDragOver(c, e));
    w.addEventListener("drop", e => onDrop(c, e));
    toolbar(c);
  }

  /* ---------------------------------------------- census (main.js canvasTok)
     [cvtool:text@x,y|note@x,y|media@x,y]  the card toolbar's buttons (centres, client px)
     [cvmpick:<kind>|n=<rows>|<first row>]  a picker is open (kind note|media|swap|narrow|background)
     [cvmprompt:<kind>|<typed value>]       a prompt is open (kind convert|url)
     [cvmrow:<note>@x,y|...]                the explorer's visible note rows (drag sources, at most 12) */
  function census(v) {
    const esc = s => String(s).replace(/[[\]|@]/g, "_");
    const vis = e => !!e && e.isConnected && e.getClientRects().length > 0;
    const ctr = e => { const r = e.getBoundingClientRect(); return Math.round(r.x + r.width / 2) + "," + Math.round(r.y + r.height / 2); };
    let t = "";
    const s = v && v.canvas && C(v.canvas);
    if (s && vis(s.bar)) {
      const bs = [...s.bar.querySelectorAll(".canvas-card-menu-item")].filter(vis);
      if (bs.length) t += " [cvtool:" + bs.map(b => esc(b.dataset.tool) + "@" + ctr(b)).join("|") + "]";
    }
    if (open && open.m && open.m._open !== false && vis(open.input)) {
      if (open.type === "pick") {
        const rows = [...open.m.resultContainerEl.querySelectorAll(".suggestion-item")];
        t += " [cvmpick:" + esc(open.kind) + "|n=" + rows.length + "|" + esc(rows.length ? rows[0].textContent.slice(0, 60) : "") + "]";
      } else t += " [cvmprompt:" + esc(open.kind) + "|" + esc(String(open.input.value).slice(0, 80)) + "]";
    }
    const rows = [...document.querySelectorAll("#tree .trow.note")].filter(vis).slice(0, 12);
    if (rows.length) t += " [cvmrow:" + rows.map(r => esc(r.dataset.note) + "@" + ctr(r)).join("|") + "]";
    return t;
  }

  const api = { install, census, groupAround, groupAt, convertToFile };
  Object.defineProperty(window, "CanvasMenus", { configurable: true, enumerable: false, writable: false, value: Object.freeze(api) });
})();
