// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* canvas drop (goal cv-drop): things dropped on the board become cards.
   Written from the public help page (Canvas: "Add cards from folders", "Add
   cards") and the JSON Canvas 1.0 spec (clean room).

   Load order (index.html): canvas.js -> ... -> canvas-edges.js -> canvas-drop.js
   -> main.js. This file registers two document listeners and defines
   window.CanvasDrop; it never edits canvas.js and needs no per-board install.

   A FOLDER from the file explorer (CV-100). The explorer's R24.6 mouse machine
   (main.js) drags folder rows too; over a plugin view it offers the drop as a
   dragover/drop whose payload is app.dragManager.draggable = {type: "folder",
   file: TFolder}. Over a board this file accepts it: one file card per DIRECT
   child file of the folder (no recursion, subfolders skipped), created at the
   drop point and laid out by CanvasArrange's grid (no second layout here), all
   in one synchronous turn -> ONE cv-history step (one undo removes them all).
   A folder with more than CAP files adds nothing and says so (a notice naming
   the cap). The new cards end selected.

   A FILE from another application (CV-101). A real OS drop reaches the page
   only as main.js's `drop-files` event -> attachDrop(paths, at); "Insert
   attachment" (R31.7) is the keyboard road into the same attachDrop. When the
   board under the drop point (or, with no point, the active leaf) is a canvas,
   attachDrop hands the paths here: attach_files copies them into the vault with
   its own caps and refusal sentences (the "note" argument is the board's path:
   the attachment folder is the vault's setting, the note only names the
   requester), and every file that landed becomes one file card at the drop
   point (no point: the last pointer position on that board, else its centre).
   A refused file adds no card; its sentence is shown through the host's drop
   banner. Browser URL drags are refused by attach_files (R31.8) — a URL becomes
   a link card through the board menu (cv-menus "Add web page"), not here.

   Census (main.js canvasTok, appended):
     [cvdrop:<copied>/<refused>]   the last attach on a board
     [cvdropf:<folder>|n=<cards added>|cap=<cap>]   the last folder drop (n=0 when refused)
     [cvdropmsg:<text>]            the last sentence this file showed (refusal / cap notice)
     [cvpaste:<type:size|none>|types=<clipboard types>|<vault path>]   goal cv-journeys: the last Ctrl+V the board handed to the catcher */
(function () {
  "use strict";
  const CAP = 50;                       // files per folder drop (help: "Add cards from folders")
  const IMG = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
  const HOST = window.__osPluginHost;   // captured at load: the loader seals the host before plugins run
  const app = HOST && HOST.app ? HOST.app : null, X = HOST && HOST.api ? HOST.api : null;
  let last = { att: "", fold: "", msg: "", paste: "" };
  let ptr = null;                       // {x, y, w}: the last pointer position over a board wrapper

  const vis = e => !!e && e.isConnected && e.getClientRects().length > 0;
  const ro = c => !!(c.readonly || (c.options && c.options.readOnly));
  const extOf = p => { const n = String(p || "").split("/").pop(); const d = n.lastIndexOf("."); return d > 0 ? n.slice(d + 1).toLowerCase() : ""; };
  const sizeOf = p => extOf(p) === "md" ? { width: 400, height: 400 } : { width: 400, height: IMG.has(extOf(p)) ? 300 : 400 };

  function boards() {
    try { return app.workspace.getLeavesOfType("canvas").map(l => l.view).filter(v => v && v.canvas && vis(v.containerEl)); }
    catch (_) { return []; }
  }
  function boardAt(el) {
    const w = el && el.closest ? el.closest(".canvas-wrapper") : null;
    if (!w) return null;
    const v = boards().find(b => b.canvas.wrapperEl === w);
    return v ? v.canvas : null;
  }
  function activeBoard() {
    try {
      const l = app.workspace.activeLeaf, v = l && l.view;
      if (v && v.canvas && v.getViewType && v.getViewType() === "canvas" && vis(v.containerEl)) return v.canvas;
    } catch (_) {}
    return null;
  }
  // the board an attach goes to, or null (attachDrop then does its note path): a drop point decides by what is
  // under it; no point (Insert attachment) = the active leaf
  function claim(at) {
    if (!app) return null;
    if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) {
      const k = window.devicePixelRatio || 1;
      return boardAt(document.elementFromPoint(at.x / k, at.y / k));
    }
    return activeBoard();
  }
  function pointOf(c, at) {
    if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) { const k = window.devicePixelRatio || 1; return c.toCanvas(at.x / k, at.y / k); }
    const r = c.wrapperEl.getBoundingClientRect();
    if (ptr && ptr.w === c.wrapperEl && ptr.x >= r.left && ptr.x <= r.right && ptr.y >= r.top && ptr.y <= r.bottom) return c.toCanvas(ptr.x, ptr.y);
    return c.toCanvas(r.left + r.width / 2, r.top + r.height / 2);
  }

  /* place: one file card per path, the grid's top-left at canvas point p; ONE history step */
  function place(c, paths, p) {
    const ns = paths.map(f => c.createFileNode({ file: f, pos: { x: p.x, y: p.y }, size: sizeOf(f), save: false }));
    if (ns.length > 1 && window.CanvasArrange) {
      c.deselectAll();
      ns.forEach((n, i) => c.select(n, i > 0));
      window.CanvasArrange.run(c, "arrange-grid");
    } else if (ns.length) c.select(ns[0], false);
    if (typeof c.renderEdges === "function") c.renderEdges();
    c.requestSave();                    // the step (cv-history commits once per turn)
    return ns;
  }

  /* ---------------------------------------------- CV-100: a folder from the explorer */
  function folderOf() {
    const dm = app && app.dragManager, d = dm && dm.draggable;
    if (!d || d.type !== "folder" || !d.file || !Array.isArray(d.file.children)) return null;
    return d.file;
  }
  function onDragOver(e) {
    const f = folderOf(); if (!f) return;
    const c = boardAt(e.target); if (!c || ro(c)) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = "copy"; } catch (_) {}
  }
  function onDrop(e) {
    const f = folderOf(); if (!f) return;
    const c = boardAt(e.target); if (!c || ro(c)) return;
    e.preventDefault(); e.stopPropagation();
    const files = f.children.filter(x => x && (!X || !X.TFile || x instanceof X.TFile) && typeof x.path === "string" && !Array.isArray(x.children))
      .map(x => x.path).sort();
    const name = f.path || "/";
    if (files.length > CAP) {
      last.fold = name + "|n=0|cap=" + CAP;
      say(c, "Canvas: " + name + " has " + files.length + " files, over the limit of " + CAP + " files per folder drop");
      return;
    }
    const ns = place(c, files, c.toCanvas(e.clientX, e.clientY));
    last.fold = name + "|n=" + ns.length + "|cap=" + CAP;
    // the census repaints when the explorer machine ends the drag (main.js updateTitle after a plugin drop)
  }
  function say(c, msg) {
    last.msg = msg;
    try { if (X && X.Notice) new X.Notice(msg); } catch (_) {}
  }

  /* ---------------------------------------------- CV-101: files from other applications */
  // host = {inv, refresh, say, update}: main.js's attach_files invoke, tree refresh, drop banner, census repaint
  // attach_files names a requester (it only checks the name stays inside the vault): the board's own path
  function noteOf(c) { const v = boards().find(b => b.canvas === c); return (v && v.path) || c.path || "canvas"; }
  async function attach(c, paths, at, host) {
    const p = pointOf(c, at);
    let a;
    try { a = await host.inv("attach_files", { note: noteOf(c), paths }); }
    catch (e) { last.att = "err"; last.msg = String((e && e.message) || e); host.say(last.msg); return host.update(); }
    if (a.copied.length) await host.refresh();
    if (a.copied.length && !ro(c)) place(c, a.copied, p);
    last.att = a.copied.length + "/" + a.refused.length;
    const msg = a.refused.concat(a.kept || []).join("\n");
    if (msg) last.msg = msg;
    host.say(msg);
    host.update();
  }

  /* ---------------------------------------------- goal cv-journeys J10: an image pasted on the board (Ctrl+V)
     WebKit runs the Paste editing command only into an editable selection, and a board is not editable: a Ctrl+V the
     board did not take (cv-history pastes its own copied cards and cancels the key) moves focus, for the duration of
     that one key, into a hidden contenteditable catcher. The paste lands there as a ClipboardEvent; an image file in
     its clipboardData is written NEW into the attachment folder (canvas_io paste: "Pasted image <stamp>.<ext>", the
     folder an OS drop uses) and becomes one file card at the last pointer position on the board (else its centre).
     Anything that is not an image is left alone (the catcher is emptied); focus goes back where it was. */
  const PASTE_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
  const inEd = t => !!(t && t.closest && t.closest("textarea, input, .markdown-source-view, [contenteditable=true], [contenteditable=\"\"]"));
  let catcher = null, pasteFor = null;
  function catcherEl() {
    if (catcher && catcher.isConnected) return catcher;
    catcher = document.createElement("div");
    catcher.className = "cvdrop-paste-catcher";
    catcher.contentEditable = "true";
    catcher.setAttribute("aria-hidden", "true");
    catcher.tabIndex = -1;
    catcher.style.cssText = "position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;opacity:0";
    catcher.addEventListener("paste", onPaste);
    document.body.appendChild(catcher);
    return catcher;
  }
  function giveBack() {
    const p = pasteFor; pasteFor = null;
    if (catcher) catcher.textContent = "";
    if (p && p.back && p.back.isConnected && document.activeElement === catcher) try { p.back.focus({ preventScroll: true }); } catch (_) {}
  }
  function onPasteKey(e) {
    if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || String(e.key).toLowerCase() !== "v") return;
    if (!app) { last.paste = "key|no-app"; return; }
    if (inEd(e.target)) return;
    // the keydown lands on the focused element: a card, the wrapper, or body (a click on the empty board focuses nothing)
    const top = e.target === document.body || e.target === document.documentElement;
    const c = boardAt(e.target) || (top ? activeBoard() : null);
    if (!c || ro(c)) { if (top) { last.paste = "key|no-board"; ping(c); } return; }
    pasteFor = { c, back: document.activeElement };
    const k = catcherEl();
    k.textContent = "";
    k.focus({ preventScroll: true });
    try { const r = document.createRange(); r.selectNodeContents(k); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } catch (_) {}
    last.paste = "key|armed";
    setTimeout(() => { if (pasteFor && last.paste === "key|armed") { last.paste = "key|no-paste-event"; ping(c); } giveBack(); }, 0);   // the paste (if any) ran inside this key's default action
  }
  function b64(buf) {
    const u = new Uint8Array(buf); let s = "";
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const stampNow = () => { const d = new Date(), z = n => String(n).padStart(2, "0"); return d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds()); };
  async function onPaste(e) {
    const pf = pasteFor; e.preventDefault(); e.stopPropagation();
    const cd = e.clipboardData;
    const types = cd ? [...(cd.types || [])] : [];
    let file = null;
    try {
      for (const it of cd ? [...(cd.items || [])] : []) if (it.kind === "file" && PASTE_EXT[it.type]) { file = it.getAsFile(); if (file) break; }
      if (!file) for (const f of cd ? [...(cd.files || [])] : []) if (PASTE_EXT[f.type]) { file = f; break; }
    } catch (_) {}
    last.paste = (file ? file.type + ":" + file.size : "none") + "|types=" + types.join(",");
    giveBack();
    const c = pf && pf.c;
    if (!file || !c || ro(c)) return ping(c);
    const inv = invG(); if (!inv) { last.paste += "|err=inv"; return ping(c); }
    const p = pointOf(c, null);
    let rel;
    try { rel = await inv("canvas_io", { op: "paste", path: noteOf(c), data: JSON.stringify({ ext: PASTE_EXT[file.type], stamp: stampNow(), b64: b64(await file.arrayBuffer()) }) }); }
    catch (err) { last.paste += "|err"; say(c, "Canvas: the pasted image was not saved — " + String((err && err.message) || err)); return ping(c); }
    try { if (typeof refreshTree === "function") await refreshTree(); } catch (_) {}   // main.js: the explorer row + the file model (vaultSync)
    if (!ro(c)) place(c, [rel], { x: p.x - 200, y: p.y - 150 });
    last.paste += "|" + rel;
    ping(c);
  }
  const invG = () => { try { return typeof inv === "function" ? inv : null; } catch (_) { return null; } };   // main.js (global lexical)
  function ping(c) { try { if (typeof updateTitle === "function") updateTitle(); } catch (_) {} }
  document.addEventListener("keydown", onPasteKey);
  // the paste lands where the engine puts it: the catcher when the focus move took, else the old focus (body / the
  // board wrapper) — a paste outside any editor while a board is up is the board's
  document.addEventListener("paste", e => {
    if (!app || e.defaultPrevented || (catcher && e.target === catcher) || inEd(e.target)) return;
    const top = e.target === document.body || e.target === document.documentElement;
    const c = (pasteFor && pasteFor.c) || boardAt(e.target) || (top ? activeBoard() : null);
    if (!c) return;
    if (!pasteFor) pasteFor = { c, back: null };
    onPaste(e);
  }, true);

  document.addEventListener("dragover", onDragOver);
  document.addEventListener("drop", onDrop);
  document.addEventListener("pointermove", e => {
    const w = e.target && e.target.closest ? e.target.closest(".canvas-wrapper") : null;
    if (w) ptr = { x: e.clientX, y: e.clientY, w };
  }, true);

  function census() {
    const esc = s => String(s).replace(/[[\]|@\n]/g, "_");
    let t = "";
    if (last.att) t += " [cvdrop:" + last.att + "]";
    if (last.fold) t += " [cvdropf:" + last.fold.replace(/[[\]@\n]/g, "_") + "]";
    if (last.paste) t += " [cvpaste:" + esc(last.paste.slice(0, 120)) + "]";
    if (last.msg) t += " [cvdropmsg:" + esc(last.msg.slice(0, 120)) + "]";
    return t;
  }

  const api = { claim, attach, census, CAP };
  Object.defineProperty(window, "CanvasDrop", { configurable: true, enumerable: false, writable: false, value: Object.freeze(api) });
})();
