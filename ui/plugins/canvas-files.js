// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* canvas files (goal cv-files): every kind of file sits on the board. Written from the
   public help pages (help.obsidian.md/plugins/canvas) and the JSON Canvas 1.0 spec
   (jsoncanvas.org/spec/1.0, MIT) — clean room.

     PDF file card      the app's ONE pdf frame builder (editor.js Ed.pdfFill) inside the card;
                        a PDF pdf_info refuses (over pdf.rs MAX_PDF_BYTES, broken) stays the
                        "other" card canvas-cards.js paints
     canvas file card   the shapes-only preview cv-vault paints for ![[X.canvas]] (main.js
                        cvEmbedPaint: one rect per node, one path per edge) — read from the file,
                        so a card on its own canvas is depth 1, never a recursion; a double press
                        opens the canvas in a canvas tab
     text card editing  the note editor (app.embedRegistry md embed -> showEditor(), a CM6
                        EmbedEditor), created on edit and destroyed on stop: one editor at a time
     link card menu     "Copy URL" / "Change URL" added to cv-menus' card menu through its
                        canvas:node-menu event (no second contextmenu listener)
     refused canvas     a file refused ONLY for edges naming a missing card offers "Open read-only":
                        the valid part paints with the board read-only and the view still broken,
                        so nothing is ever written (canvas.js save() refuses a broken view)

   Load order (index.html): ... canvas.js -> canvas-*.js -> canvas-files.js -> main.js. This file
   runs no code at load beyond one stylesheet, one capture pointerdown listener (a double press on a
   text card opens its editor) and one frozen global, window.__osCanvasFiles, whose
   hooks canvas.js calls (FileNode.renderContent, TextNode.startEditing/stopEditing, the parse-refusal
   path of CanvasView.loadPath) and whose census(view) main.js canvasTok() appends. */
(function () {
  "use strict";
  const ST = { app: null, X: null, prompt: null, copyN: 0, copyOk: 0, hooked: null };
  const mk = (tag, cls, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; if (parent) parent.appendChild(e); return e; };
  const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const extOf = p => { const n = String(p || "").split("/").pop(); const d = n.lastIndexOf("."); return d > 0 ? n.slice(d + 1).toLowerCase() : ""; };
  const ping = ctx => { const d = ctx && ctx.deps; if (d && typeof d.changed === "function") try { d.changed(); } catch (_) {} };
  const G = name => { try { return typeof window[name] === "function" ? window[name] : null; } catch (_) { return null; } };
  const EdG = () => { try { return typeof Ed !== "undefined" ? Ed : null; } catch (_) { return null; } };      // editor.js (global lexical)
  const invG = () => { try { return typeof inv === "function" ? inv : null; } catch (_) { return null; } };   // main.js (global lexical)

  const css = mk("style");
  css.textContent =
    ".canvas-node-container > .canvas-file-pdf { display: flex; flex-direction: column; width: 100%; box-sizing: border-box; overflow: hidden;" +
    " user-select: none; white-space: normal }\n" +
    ".canvas-node-container > .canvas-file-canvas { display: block; width: 100%; height: 100%; box-sizing: border-box; padding: 6px }\n" +
    ".canvas-node-container > .cvf-text-editor { width: 100%; height: 100%; box-sizing: border-box; padding: 4px 8px }\n" +
    ".cvf-text-editor .cm-editor { height: 100%; outline: none }\n" +
    ".canvas-error .cvf-ro-btn { margin-top: 10px; cursor: pointer }\n" +
    ".canvas-error.cvf-ro { position: absolute; left: 8px; top: 8px; margin: 0; padding: 6px 10px; z-index: 3; max-width: 60%;" +
    " background: var(--background-primary, #1e1e1e) }\n" +
    ".canvas-error.cvf-ro .canvas-error-message { font-size: 12px }\n";
  (document.head || document.documentElement).appendChild(css);

  function remember(ctx) {
    if (ctx && ctx.app) ST.app = ctx.app;
    if (ctx && ctx.X) ST.X = ctx.X;
    hookMenus();
  }

  /* ------------------------------------------------ file cards */
  // true = painted here; false = not ours (canvas-cards.js / canvas.js paint it)
  function file(node, ctx) {
    remember(ctx);
    const p = String(node.data.file || ""), ext = ctx.file && ctx.file.extension ? String(ctx.file.extension).toLowerCase() : extOf(p);
    node._cvfSeq = (node._cvfSeq || 0) + 1;
    node._cvf = null; node._cvfWhy = ""; node._cvfErr = "";
    if (ext === "pdf" && EdG() && invG()) return pdf(node, ctx, p);
    if (ext === "canvas" && ctx.file && G("cvEmbedPaint")) return nested(node, ctx, p);
    if (ext === "pdf" || ext === "canvas") node._cvfWhy = (ext === "pdf" ? (EdG() ? "" : "ed") + (invG() ? "" : "inv") : (ctx.file ? "" : "file") + (G("cvEmbedPaint") ? "" : "paint")) || "?";   // census: why the card fell through
    return false;
  }

  function pdf(node, ctx, p) {
    const E = EdG(), seq = node._cvfSeq, host = node.contentEl;
    const enc = typeof E.pctEnc === "function" ? E.pctEnc(p) : p;
    node._cc = { kind: "pdf" };
    node._cvf = { kind: "pdf", s: null };
    Promise.resolve().then(() => invG()("pdf_info", { path: enc })).catch(e => { node._cvfErr = String(e && e.message || e).slice(0, 60); return null; }).then(info => {
      if (node._cvfSeq !== seq || node._gone) return;
      host.textContent = "";
      if (!info || !info.pages) {                // over the cap / not a PDF: the "other" card (open with the default app)
        node._cvfWhy = info ? "pages" : "info";
        node._cvf = { kind: "other" };
        const cc = window.__osCanvasCards;
        if (cc) cc.file(node, ctx); else mk("div", "canvas-node-placeholder", host).textContent = p;
        ping(ctx);
        return;
      }
      const s = mk("span", "internal-embed pdf-embed canvas-file-pdf", host);
      s.dataset.pdf = enc; s.dataset.page = "1"; s.dataset.height = ""; s.dataset.alt = p.split("/").pop();
      s.contentEditable = "false";
      node._cvf.s = s;
      new MutationObserver(() => ping(ctx)).observe(s, { attributes: true, attributeFilter: ["class", "data-of"] });
      E.pdfFill(s);
      ping(ctx);
    });
    return true;
  }

  function nested(node, ctx, p) {
    const host = node.contentEl, seq = node._cvfSeq;
    node._cc = { kind: "canvas" };
    const s = mk("span", "cv-embed canvas-file-canvas", host);
    s.dataset.canvas = p; s.title = p;
    const link = mk("a"); link.textContent = p;    // cvEmbedPaint's fallback (an unreadable canvas keeps a plain link)
    node._cvf = { kind: "canvas", s };
    Promise.resolve(G("cvEmbedPaint")(s, link)).catch(e => console.error("[canvas] canvas card:", e)).then(() => {
      if (node._cvfSeq !== seq || node._gone) return;
      if (!s.isConnected) { host.textContent = ""; mk("div", "canvas-node-placeholder", host).textContent = p + " — could not be read"; }
      ping(ctx);
    });
    wireOpen(node, ctx);
    return true;
  }

  // a double press on a canvas card opens it (the board captures the pointer: detect it on the card's own press)
  function wireOpen(node, ctx) {
    node._cvfCtx = ctx;
    if (node._cvfOpenWired) return;
    node._cvfOpenWired = true;
    let last = 0, px = 0, py = 0;
    const open = () => {
      const p = String(node.data.file || ""), oc = G("openCanvas");
      if (oc) Promise.resolve(oc(p)).catch(e => console.error("[canvas] open canvas:", e));
      else if (ST.app) ST.app.workspace.getLeaf("tab").setViewState({ type: "canvas", state: { file: p }, active: true }).catch(e => console.error(e));
    };
    node.containerEl.addEventListener("pointerdown", e => {
      if (!node._cvf || node._cvf.kind !== "canvas" || node.isEditing || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.target.classList && e.target.classList.contains("canvas-node-resizer")) return;
      const now = Date.now(), dbl = now - last < 500 && Math.abs(e.clientX - px) + Math.abs(e.clientY - py) < 8;
      last = now; px = e.clientX; py = e.clientY;
      if (!dbl) return;                             // a single press still selects / drags the card
      last = 0;
      e.stopPropagation(); e.preventDefault();
      open();
    });
  }

  /* ------------------------------------------------ text card editing (CM6) */
  function startEditing(node, ctx) {
    remember(ctx);
    const app = ctx.app, reg = app && app.embedRegistry;
    const mdc = reg && reg.embedByExtension && Object.prototype.hasOwnProperty.call(reg.embedByExtension, "md") ? reg.embedByExtension.md : null;
    if (typeof mdc !== "function" || !node.canvas || node.canvas.readonly) return false;
    // one editor at a time on the board
    for (const n of node.canvas.nodes.values()) if (n !== node && n.isEditing) try { n.stopEditing(); } catch (_) {}
    const host = mk("div", "cvf-text-editor");
    let child, em;
    try {
      child = mdc({ app, containerEl: host, linktext: "", sourcePath: node.canvas.path || "", depth: 1 }, null, "");
      node.addChild(child);
      em = child.showEditor();
      if (!em || !em.cm) throw new Error("no editor");
    } catch (e) {
      console.error("[canvas] text card editor:", e);
      if (child) try { node.removeChild(child); } catch (_) {}
      return false;                                 // canvas.js falls back to its textarea
    }
    node.isEditing = true;
    node.containerEl.classList.add("is-editing");
    node.contentEl.textContent = "";
    node.contentEl.appendChild(host);
    em.set(node.data.text, true);
    node._cvfEd = { child, em, host };
    em.onUpdate = (u, docChanged) => {
      if (!docChanged || node._cvfEd === null) return;
      const v = em.get();
      if (v !== node.data.text) { node.data.text = v; node.canvas.requestSave(); }
    };
    host.addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); node.stopEditing(); }
      e.stopPropagation();
    });
    for (const ev of ["dblclick", "wheel", "keyup"]) host.addEventListener(ev, e => e.stopPropagation(), { passive: true });
    host.addEventListener("focusout", e => {
      if (e.relatedTarget && host.contains(e.relatedTarget)) return;
      setTimeout(() => { const st = node._cvfEd; if (st && st.host === host && !host.contains(document.activeElement)) node.stopEditing(); }, 0);
    });
    setTimeout(() => {
      try { em.cm.focus(); const L = em.cm.state.doc.length; em.cm.dispatch({ selection: { anchor: L } }); } catch (_) {}
      ping(ctx);
    }, 0);
    ping(ctx);
    return true;
  }

  function stopEditing(node, ctx) {
    const st = node._cvfEd;
    if (!st) return false;
    node._cvfEd = null;
    let v = node.data.text;
    try { v = st.em.get(); } catch (_) {}
    const hadFocus = st.host.contains(document.activeElement);
    node.isEditing = false;
    node.containerEl.classList.remove("is-editing");
    try { node.removeChild(st.child); } catch (e) { console.error(e); }   // the embed unloads: its CM6 view is destroyed
    st.host.remove();
    const ch = v !== node.data.text;
    node.data.text = v;
    node.renderContent();
    if (ch) node.canvas.requestSave();
    if (hadFocus && node.canvas && node.canvas.wrapperEl) try { node.canvas.wrapperEl.focus({ preventScroll: true }); } catch (_) {}
    ping(ctx);
    return true;
  }

  /* The board takes pointer capture on every press (canvas.js), so the dblclick of a double press
     lands on the wrapper, where nodeOf() finds no card and a NEW text card is made (canvas-cards.js
     documents the same for other-kind files). A double press on a text card is therefore detected
     on its second pointerdown, before the board sees it, and opens that card's editor. */
  let dpId = "", dpT = 0, dpX = 0, dpY = 0;
  document.addEventListener("pointerdown", e => {
    const t = e.target, card = t && t.closest ? t.closest(".canvas-node.canvas-node-text[data-node-id]") : null;
    if (!card || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) { dpId = ""; return; }
    if (t.closest("textarea, input, .markdown-source-view, [contenteditable=true], .canvas-node-resizer, .canvas-node-label")) { dpId = ""; return; }
    const id = card.dataset.nodeId, now = Date.now();
    const dbl = id === dpId && now - dpT < 500 && Math.abs(e.clientX - dpX) + Math.abs(e.clientY - dpY) < 8;
    dpId = id; dpT = now; dpX = e.clientX; dpY = e.clientY;
    if (!dbl) return;                               // the first press still selects / drags the card
    dpId = "";
    const app = ST.app || (window.__osPluginHost && window.__osPluginHost.app) || null;
    let node = null;
    try {
      for (const l of app ? app.workspace.getLeavesOfType("canvas") : []) {
        const v = l.view;
        if (v && v.canvas && v.containerEl && v.containerEl.contains(card)) { node = v.canvas.nodes.get(id) || null; break; }
      }
    } catch (_) { node = null; }
    if (!node || node.isEditing || !node.canvas || node.canvas.readonly || typeof node.startEditing !== "function") return;
    e.stopPropagation(); e.preventDefault();
    node.startEditing();
  }, true);

  /* ------------------------------------------------ link card menu */
  function hookMenus() {
    const app = ST.app;
    if (!app || !app.workspace || typeof app.workspace.on !== "function" || ST.hooked === app) return;
    ST.hooked = app;
    app.workspace.on("canvas:node-menu", (menu, node) => {
      if (!menu || !node || !node.data || node.data.type !== "link" || (node.canvas && node.canvas.readonly)) return;
      menu.addItem(i => i.setTitle("Copy URL").onClick(() => { copyText(String(node.data.url || "")); refocus(node); }));
      menu.addItem(i => i.setTitle("Change URL").onClick(() => changeUrl(node)));
    });
  }

  // no programmatic clipboard in this tree: a copy command inside the menu click, its copy event carries the URL
  function copyText(t) {
    ST.copyN++;
    let ok = false;
    const back = document.activeElement;           // the copy textarea borrows focus; give it back (Escape, keys keep working)
    const ta = mk("textarea");
    ta.value = t; ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-10000px;top:0;width:10px;height:10px;opacity:0";
    document.body.appendChild(ta);
    const on = e => { try { e.clipboardData.setData("text/plain", t); e.preventDefault(); ok = true; } catch (_) {} };
    document.addEventListener("copy", on, true);
    try { ta.focus(); ta.select(); ok = document.execCommand("copy") || ok; } catch (_) {}
    document.removeEventListener("copy", on, true);
    ta.remove();
    if (back && back !== document.body && back.isConnected && typeof back.focus === "function") try { back.focus({ preventScroll: true }); } catch (_) {}
    if (!ok && navigator.clipboard && typeof navigator.clipboard.writeText === "function") navigator.clipboard.writeText(t).then(() => { ST.copyOk = 1; }, () => {});
    ST.copyOk = ok ? 1 : 0;
  }

  function changeUrl(node) {
    const X = ST.X, app = ST.app;
    if (!X || !app || typeof X.Modal !== "function") return;
    const m = new X.Modal(app);
    m.modalEl.classList.add("cvf-url-prompt");
    m.setTitle("Change URL");
    const input = mk("input", "", m.contentEl);
    input.type = "text"; input.spellcheck = false; input.value = String(node.data.url || "");
    const later = () => setTimeout(() => ping(node._ccCtx || node._cvfCtx || null) || bump(), 0);
    input.addEventListener("input", later);
    input.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        const v = String(input.value || "").trim();
        m.close();
        if (!/^https?:\/\/[^\s/]+/i.test(v)) { notify("Canvas: not a web address — " + v); return; }
        if (v !== node.data.url && node.canvas && node.canvas.nodes.get(node.id) === node && !node.canvas.readonly) {
          node.data.url = v; node.renderContent(); node.canvas.requestSave();
        }
      } else if (e.key === "Escape") { e.preventDefault(); m.close(); }
    });
    m.onClose = () => { if (ST.prompt && ST.prompt.m === m) ST.prompt = null; refocus(node); later(); };
    ST.prompt = { kind: "url", m, input };
    m.open();
    setTimeout(() => { try { input.focus(); input.select(); } catch (_) {} later(); }, 0);
  }
  // the board keeps the keyboard after a menu action / prompt (Escape, Delete, undo keys reach it)
  const refocus = node => { const w = node && node.canvas && node.canvas.wrapperEl; if (w) setTimeout(() => { if (w.isConnected && (!document.activeElement || document.activeElement === document.body)) try { w.focus({ preventScroll: true }); } catch (_) {} }, 0); };
  const bump = () => { const u = G("updateTitle"); if (u) try { u(); } catch (_) {} };
  const notify = msg => { try { if (ST.X && ST.X.Notice) new ST.X.Notice(msg); } catch (_) {} };

  /* ------------------------------------------------ refused canvas: read-only open */
  // called by canvas.js right after setError() for a file that did not parse; offers the button
  // only when the sole problem is edges naming a missing card
  function refused(view, text, ctx) {
    remember(ctx);
    view._cvfRO = null;
    let doc;
    try { doc = JSON.parse(text); } catch (_) { return false; }
    if (!isObj(doc) || !Array.isArray(doc.nodes) || ("edges" in doc && !Array.isArray(doc.edges))) return false;
    const ids = new Set(doc.nodes.filter(isObj).map(n => n.id));
    const edges = doc.edges || [];
    const keep = edges.filter(e => isObj(e) && ids.has(e.fromNode) && ids.has(e.toNode));
    const skip = edges.length - keep.length;
    if (!skip) return false;
    const clean = Object.assign({}, doc, { edges: keep });
    try { ctx.model.validateCanvas(clean); } catch (_) { return false; }
    const box = view.errorEl, p = view.path;
    if (!box) return false;
    const b = mk("button", "cvf-ro-btn", box);
    b.type = "button"; b.textContent = "Open read-only";
    b.title = "Show the valid part of this canvas. Nothing is written to the file.";
    b.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); openReadOnly(view, clean, skip, p, ctx); });
    ping(ctx);
    return true;
  }

  function openReadOnly(view, doc, skip, p, ctx) {
    if (view.path !== p || !view.broken || !view.errorEl) return;
    const c = view.canvas;
    view.dirty = false;
    c.readonly = true;                               // no edit takes; view.broken stays set: save() never writes
    c.wrapperEl.hidden = false;
    c.importData(doc);
    view._cvfRO = { path: p, skip };
    const box = view.errorEl;
    box.classList.add("cvf-ro");
    const b = box.querySelector(".cvf-ro-btn"); if (b) b.remove();
    const msg = box.querySelector(".canvas-error-message");
    if (msg) msg.textContent = "Read-only: " + skip + " edge" + (skip === 1 ? "" : "s") + " naming a missing card " + (skip === 1 ? "is" : "are") + " not shown. The file is never written.";
    c.fitted = false;
    requestAnimationFrame(() => { if (view.path === p && c.wrapperEl.getBoundingClientRect().width) { c.fitted = true; c.zoomToFit(); } ping(ctx); });
    ping(ctx);
  }

  /* ------------------------------------------------ rename: file cards follow the note (CV-143)
     main.js runUpdateLinks0 (the CONSENTED half of R34) calls this once. Note names carry no
     extension there; a file card names the vault path. Open canvas views save first (a pending
     edit is not lost), the Rust op rewrites only the matching "file" tokens, and every open view
     on a rewritten canvas reloads from disk (a stale view would otherwise save the old path back). */
  async function relink(old, nn, env) {
    const inv = env && env.inv, app = (env && env.app) || ST.app;
    if (typeof inv !== "function" || !old || !nn) return [];
    const md = s => (/\.[^/.]+$/.test(s) ? s : s + ".md");
    const from = md(String(old)), to = md(String(nn));
    if (from === to) return [];
    let leaves = [];
    try { leaves = app && app.workspace ? app.workspace.getLeavesOfType("canvas") : []; } catch (_) { leaves = []; }
    for (const l of leaves) if (l.view && typeof l.view.flush === "function") try { await l.view.flush(); } catch (e) { console.error("[canvas] relink flush:", e); }
    const wrote = await inv("canvas_io", { op: "relink", path: "", data: JSON.stringify({ from, to }) });
    const set = new Set(Array.isArray(wrote) ? wrote : []);
    for (const l of leaves) {
      const v = l.view;
      if (v && v.path && set.has(v.path) && !v.broken && typeof v.loadPath === "function") try { await v.loadPath(v.path); } catch (e) { console.error("[canvas] relink reload:", e); }
    }
    return [...set];
  }

  /* ------------------------------------------------ census (main.js canvasTok)
     [cvcard:<id>|kind=pdf|pages=<n>|frame=0|1|loaded=0|1]  [cvfile:<id>|rects=<n>|paths=<n>]  [cvfile:<id>|ext=<text>]
     [cvfile:cm=<CM6 editors on the board>|ta=<textareas>|ed=<editing card id or ->]  [cvfile:robtn@x,y]
     [cvfile:ro|n=|e=|skip=]  [cvfprompt:url|<value>]  [cvfcopy:n=|ok=]  [cvfcover:x,y] */
  function census(v) {
    if (!v || !v.canvas) return "";
    if (v.app && !ST.app) { ST.app = v.app; hookMenus(); }
    const esc = x => String(x == null ? "" : x).replace(/[[\]|@]/g, "_").replace(/\s+/g, " ").trim();
    const vis = e => !!e && e.isConnected && e.getClientRects().length > 0;
    const ctr = e => { const r = e.getBoundingClientRect(); return Math.round(r.x + r.width / 2) + "," + Math.round(r.y + r.height / 2); };
    let t = "", k = 0, ed = "-";
    for (const n of v.canvas.nodes.values()) {
      if (n.data.type === "text" && n.isEditing && ed === "-") ed = esc(n.id);
      if (n.data.type !== "file" || k >= 16 || !vis(n.containerEl)) continue;
      const f = n._cvf || {}, id = esc(n.id);
      if (n._cvfWhy) t += " [cvfwhy:" + id + "=" + esc(n._cvfWhy + (n._cvfErr ? ":" + n._cvfErr : "")) + "]";   // a PDF / canvas card that fell back, and why
      if (f.kind === "pdf") {
        k++;
        const s = f.s;
        t += " [cvcard:" + id + "|kind=pdf|pages=" + (s ? (+s.dataset.of || 0) : 0) + "|frame=" + (s && s.querySelector(".pdf-container") ? 1 : 0) +
             "|loaded=" + (s && s.classList.contains("is-loaded") ? 1 : 0) + "]";
      } else if (f.kind === "canvas") {
        k++;
        const s = f.s, ok = s && s.isConnected;
        t += " [cvfile:" + id + "|rects=" + (ok ? s.querySelectorAll("svg rect").length : 0) + "|paths=" + (ok ? s.querySelectorAll("svg path").length : 0) + "]";
      } else if (n._cc && n._cc.kind === "other") {
        const x = n.contentEl.querySelector(".canvas-file-other-ext");
        if (x) { k++; t += " [cvfile:" + id + "|ext=" + esc(x.textContent) + "]"; }
      }
    }
    const root = v.canvas.nodeEl || v.containerEl;
    t += " [cvfile:cm=" + root.querySelectorAll(".canvas-node-text .cm-editor").length + "|ta=" + root.querySelectorAll("textarea.canvas-node-textarea").length + "|ed=" + ed + "]";
    const b = v.errorEl && v.errorEl.querySelector(".cvf-ro-btn");
    if (vis(b)) t += " [cvfile:robtn@" + ctr(b) + "]";
    const ro = v._cvfRO;
    if (ro && ro.path === v.path && v.broken) t += " [cvfile:ro|n=" + v.canvas.nodes.size + "|e=" + v.canvas.edges.size + "|skip=" + ro.skip + "]";
    if (ST.prompt && vis(ST.prompt.input)) t += " [cvfprompt:" + ST.prompt.kind + "|" + esc(String(ST.prompt.input.value).slice(0, 80)) + "]";
    if (ST.copyN) t += " [cvfcopy:n=" + ST.copyN + "|ok=" + ST.copyOk + "]";
    { // a toast lying over the undo control (it takes the click): its centre, so a driver dismisses it like a user
      const u = v.canvas.controlsEl && v.canvas.controlsEl.querySelector(".mod-undo");
      if (vis(u)) {
        const r = u.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        const nt = hit && hit.closest ? hit.closest(".notice") : null;
        if (nt) t += " [cvfcover:" + ctr(nt) + "]";
      }
    }
    return t;
  }

  Object.defineProperty(window, "__osCanvasFiles", {
    configurable: false, enumerable: false, writable: false,
    value: Object.freeze({ file, startEditing, stopEditing, refused, relink, census }),
  });
})();
