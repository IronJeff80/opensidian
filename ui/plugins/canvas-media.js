// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* canvas media cards (goal cvf-media): how a file card looks and answers when the file is not a note.
   Written from the public help pages (help.obsidian.md/plugins/canvas) and the JSON Canvas 1.0 spec — clean room.

     label            a non-note card is labelled with the file name INCLUDING its extension; a note keeps its bare name
     other file       a file icon above the full file name, centred (no separate extension badge)
     missing file     the label carries a warning icon and the stored path; the body says the file is missing (stock wording behind CV_MISSING_STOCK)
                      and offers Create new note (notes only) / Swap file... / Remove. Create makes the empty file at
                      the stored path and opens the card's editor; Swap picks another vault file (the board saves, so
                      Ctrl+Z restores the old path); Remove deletes the card (Ctrl+Z restores it)
     canvas file      a miniature of that board: one box per card, with the card's text, read from the file
     PDF file         canvas-files.js paints the app's PDF frame; this file adds an editable page number, "of N" and an
                      outline toggle to its toolbar, and a wheel over a SELECTED PDF card scrolls the pages, not the board
     double-click     on an image / PDF / audio / video / missing card only selects it (no new text card); on a canvas
                      card it opens that canvas in the same tab

   Load order (index.html): ... canvas-files.js -> canvas-media.js -> main.js. canvas-files.js file() hands every
   file card here first (one dispatch line); main.js canvasTok() appends census(view). At load this file adds one
   stylesheet, one capture dblclick listener and the frozen global window.CanvasMedia.

   census: [cvm:<id>|k=<kind>|lbl=<label>|...] per painted file card (audio/video: ctl rs dur ct vw; other: icon tx;
   canvas: nf pv tx; missing: warn msg; note: ed fo), [cvmb:<id>|missing-create@x,y|missing-swap@x,y|missing-remove@x,y],
   [cvmpdf:<id>|pdf-page-input@x,y|pdf-outline-toggle@x,y|pdf-zoom-out@x,y|pdf-zoom-in@x,y|pg=|of=|top=],
   [cvmpick:swap|n=<rows>|<first row>] while the Swap file picker is open. */
(function () {
  "use strict";
  // the missing card says "<path> could not be found." only with this flag on; off (default) it keeps develop's
  // "<path> — empty or not found", which phases cvplain CV-MISS and apicanvas detached.fileNode[neg] still assert
  // (coordinator ruling 2, 2026-10-26: no old-phase edits without operator go)
  const CV_MISSING_STOCK = true;
  const IMG = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
  const AUD = new Set(["mp3", "wav", "m4a", "ogg", "3gp", "flac"]);
  const VID = new Set(["mp4", "webm", "ogv", "mov", "mkv"]);
  const ST = { pick: null };
  const nodes = new WeakMap();                       // card element -> node, for the dblclick hit test
  const mk = (tag, cls, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; if (parent) parent.appendChild(e); return e; };
  const nameOf = p => String(p || "").split("/").pop();
  const extOf = p => { const n = nameOf(p); const d = n.lastIndexOf("."); return d > 0 ? n.slice(d + 1).toLowerCase() : ""; };
  const ping = ctx => { const d = ctx && ctx.deps; if (d && typeof d.changed === "function") try { d.changed(); } catch (_) {} };
  const invG = () => { try { return typeof inv === "function" ? inv : null; } catch (_) { return null; } };   // main.js (global lexical)
  const stop = e => e.stopPropagation();
  const NS = "http://www.w3.org/2000/svg";
  function icon(cls, paths) {
    const s = document.createElementNS(NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("class", cls);
    s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", "2");
    s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round");
    for (const d of paths) { const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); s.appendChild(p); }
    return s;
  }
  const fileIcon = () => icon("cvm-file-icon", ["M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z", "M14 3v5h5"]);
  const warnIcon = () => icon("cvm-warn-icon", ["M12 3 2 21h20z", "M12 10v5", "M12 18h.01"]);

  const css = mk("style");
  css.textContent =
    ".canvas-node-label .cvm-warn-icon { width: 12px; height: 12px; vertical-align: -2px; margin-right: 4px; color: var(--text-error, #e93147) }\n" +
    ".canvas-node-container > .canvas-file-other { display: flex; flex-direction: column; align-items: center; justify-content: center;" +
    " gap: 6px; height: 100%; box-sizing: border-box; padding: 8px; text-align: center }\n" +
    ".canvas-file-other .cvm-file-icon { width: 28px; height: 28px; color: var(--text-muted, #999) }\n" +
    ".canvas-file-other .canvas-file-other-ext { display: none }\n" +
    ".cvm-missing { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; height: 100%;" +
    " box-sizing: border-box; padding: 10px; text-align: center }\n" +
    ".cvm-missing-msg { color: var(--text-muted, #999); word-break: break-word }\n" +
    ".cvm-missing-btns { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; position: relative; z-index: 2 }\n" +
    ".cvm-missing-btns button { cursor: pointer; padding: 4px 10px }\n" +
    ".cvm-preview { position: relative; width: 100%; height: 100%; overflow: hidden }\n" +
    ".cvm-pv-node { position: absolute; box-sizing: border-box; border: 1px solid var(--background-modifier-border, #555); border-radius: 4px;" +
    " overflow: hidden; font-size: 11px; padding: 2px 4px; color: var(--text-normal, #ddd); background: var(--background-secondary, #262626) }\n" +
    ".canvas-node .pdf-embed .pdf-toolbar { position: relative; z-index: 2 }\n" +
    ".canvas-node .pdf-embed.cvm-pdf .pdf-counter { display: none }\n" +
    ".cvm-pdf-page { width: 3em; text-align: center; padding: 1px 2px }\n" +
    ".cvm-pdf-of { flex: 1 1 auto; white-space: nowrap }\n" +
    ".pdf-embed .cvm-pdf-outline::before { content: \"\\2630\" }\n" +
    ".cvm-pdf-outline-list { display: none; position: absolute; left: 0; top: 39px; bottom: 0; width: 70px; overflow: auto; z-index: 3;" +
    " background: var(--background-secondary, #262626); border-right: 1px solid var(--background-modifier-border, #555) }\n" +
    ".cvm-pdf.is-outline .cvm-pdf-outline-list { display: block }\n" +
    ".cvm-pdf-outline-list div { padding: 4px 8px; cursor: pointer; font-size: 12px }\n" +
    ".canvas-node.is-selected.cvm-pdf-card > .canvas-node-content-blocker { display: none }\n";
  (document.head || document.documentElement).appendChild(css);

  function label(node, text, warn) {
    const l = node.labelEl;
    l.textContent = "";
    if (warn) l.appendChild(warnIcon());
    l.appendChild(document.createTextNode(text));
  }

  /* ------------------------------------------------ dispatch (canvas-files.js file())
     true = painted here; false = not ours (canvas-files / canvas-cards / canvas.js paint it as before) */
  function file(node, ctx, next) {
    const p = String(node.data.file || "");
    const ext = ctx.file && ctx.file.extension ? String(ctx.file.extension).toLowerCase() : extOf(p);
    node._cvmSeq = (node._cvmSeq || 0) + 1;
    node._cvmCtx = ctx;
    nodes.set(node.containerEl, node);
    node.containerEl.classList.remove("cvm-pdf-card");
    wire(node);
    if (!p) { node._cvm = null; return false; }
    const tracked = ext === "md" || ext === "canvas" || IMG.has(ext);
    if (!ctx.file && ctx.missing && tracked) return missing(node, ctx, p, ext);
    if (ext === "md") { node._cvm = { k: "note" }; return false; }
    if (ext === "canvas") {
      if (!ctx.file) { node._cvm = null; return false; }
      return preview(node, ctx, p);
    }
    const name = nameOf(p);
    if (ext === "pdf") {
      ctx._cvm = true;
      let r = false;
      try { r = next(node, ctx); } catch (e) { console.error("[canvas] media pdf:", e); }
      label(node, name);
      node._cvm = { k: "pdf" };
      if (r) { node.containerEl.classList.add("cvm-pdf-card"); pdfWatch(node, ctx); }
      return r;
    }
    const cc = window.__osCanvasCards;
    if (!cc) return false;
    let r = false;
    try { r = cc.file(node, ctx); } catch (e) { console.error("[canvas] media card:", e); }
    if (!r) { node._cvm = null; return false; }
    label(node, name);
    const s = node._cc || {};
    node._cvm = { k: s.kind || "other" };
    if (s.kind === "other") {
      const box = node.contentEl.querySelector(".canvas-file-other");
      if (box && !box.querySelector(".cvm-file-icon")) box.insertBefore(fileIcon(), box.firstChild);
    }
    if ((s.kind === "audio" || s.kind === "video") && s.media)
      for (const ev of ["loadedmetadata", "loadeddata", "error", "timeupdate"]) s.media.addEventListener(ev, () => ping(ctx));
    return true;
  }

  /* ------------------------------------------------ missing file */
  function missing(node, ctx, p, ext) {
    const host = node.contentEl;
    host.textContent = "";
    label(node, p, true);
    node._cc = { kind: "missing" };
    const box = mk("div", "cvm-missing", host);
    const msg = mk("div", "cvm-missing-msg", box);
    msg.textContent = CV_MISSING_STOCK ? p + " could not be found." : p + " — empty or not found";
    const bs = mk("div", "cvm-missing-btns", box);
    const btn = (kind, text, act) => {
      const b = mk("button", "mod-cta cvm-" + kind, bs);
      b.type = "button"; b.textContent = text; b.dataset.cvm = kind;
      b.addEventListener("pointerdown", stop);
      b.addEventListener("mousedown", stop);
      b.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); try { act(); } catch (er) { console.error("[canvas] missing card:", er); } });
      return b;
    };
    if (ext === "md") btn("missing-create", "Create new note", () => create(node, ctx, p));
    btn("missing-swap", "Swap file...", () => swap(node, ctx));
    btn("missing-remove", "Remove", () => { if (!node.canvas.readonly) node.canvas.removeNode(node); });
    node._cvm = { k: "missing", msg };
    ping(ctx);
    return true;
  }

  async function create(node, ctx, p) {
    const cn = typeof window.createNote === "function" ? window.createNote : null;
    if (!cn) return;
    const r = await cn(p.replace(/\.md$/i, ""), "");
    if (r === "err") return;
    const app = ctx.app, seq = node._cvmSeq;
    for (let i = 0; i < 30; i++) {                      // the vault model learns the new file
      let f = null; try { f = app.vault.getAbstractFileByPath(p); } catch (_) {}
      if (f) break;
      await new Promise(res => setTimeout(res, 100));
    }
    if (node._gone || node._cvmSeq !== seq || node.canvas.nodes.get(node.id) !== node) return;
    node.renderContent();
    for (let i = 0; i < 20 && !node.isEditable(); i++) await new Promise(res => setTimeout(res, 100));
    await new Promise(res => setTimeout(res, 150));
    if (!node.isEditable() || node._gone) { ping(ctx); return; }
    try { node.canvas.select(node); } catch (_) {}
    node.startEditing();
    const focus = () => {
      try { const ed = node.editorApi(); if (ed && typeof ed.focus === "function") ed.focus(); } catch (_) {}
      const cm = node.contentEl.querySelector(".cm-content");
      if (cm && !node.containerEl.contains(document.activeElement)) try { cm.focus(); } catch (_) {}
      ping(ctx);
    };
    focus(); setTimeout(focus, 80); setTimeout(focus, 250);
  }

  function swap(node, ctx) {
    const { X, app } = ctx;
    if (!X || !X.FuzzySuggestModal) return;
    let items = [];
    try { items = app.vault.getFiles().filter(f => f && typeof f.path === "string" && f.path !== node.canvas.path); } catch (_) {}
    items.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    class Pick extends X.FuzzySuggestModal {
      getItems() { return items; }
      getItemText(f) { return f.path; }
      onChooseItem(f) {
        setTimeout(() => {
          if (node.canvas.nodes.get(node.id) !== node || node.canvas.readonly) return;
          node.setFilePath(f.path);
          node.renderContent();
          ping(ctx);
        }, 0);
      }
      onClose() { if (ST.pick && ST.pick.m === this) ST.pick = null; setTimeout(() => ping(ctx), 0); }
    }
    const m = new Pick(app);
    m.setPlaceholder("Swap for another file…");
    ST.pick = { m, input: m.inputEl };
    m.inputEl.addEventListener("input", () => setTimeout(() => ping(ctx), 0));
    m.open();
    setTimeout(() => ping(ctx), 0);
  }

  /* ------------------------------------------------ canvas file: a miniature of the board */
  function preview(node, ctx, p) {
    const host = node.contentEl, seq = node._cvmSeq;
    host.textContent = "";
    label(node, nameOf(p));
    node._cc = { kind: "canvas" };
    const box = mk("div", "cvm-preview", host);
    node._cvm = { k: "canvas", box };
    const iv = invG();
    Promise.resolve(iv ? iv("canvas_io", { op: "read", path: p }) : null).then(t => JSON.parse(t), () => null).catch(() => null).then(doc => {
      if (node._cvmSeq !== seq || node._gone) return;
      const ns = doc && Array.isArray(doc.nodes) ? doc.nodes.filter(n => n && typeof n === "object") : [];
      const num = v => (typeof v === "number" && isFinite(v) ? v : 0);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const n of ns) { x0 = Math.min(x0, num(n.x)); y0 = Math.min(y0, num(n.y)); x1 = Math.max(x1, num(n.x) + num(n.width)); y1 = Math.max(y1, num(n.y) + num(n.height)); }
      if (!ns.length) { x0 = y0 = 0; x1 = y1 = 100; }
      const pad = 20, W = Math.max(1, x1 - x0 + 2 * pad), H = Math.max(1, y1 - y0 + 2 * pad);
      const bw = box.clientWidth || num(node.data.width), bh = box.clientHeight || num(node.data.height);
      const k = Math.min(bw / W, bh / H) || 1, ox = (bw - W * k) / 2, oy = (bh - H * k) / 2;
      for (const n of [...ns.filter(n => n.type === "group"), ...ns.filter(n => n.type !== "group")]) {
        const d = mk("div", "cvm-pv-node", box);
        d.style.left = Math.round(ox + (num(n.x) - x0 + pad) * k) + "px";
        d.style.top = Math.round(oy + (num(n.y) - y0 + pad) * k) + "px";
        d.style.width = Math.max(2, Math.round(num(n.width) * k)) + "px";
        d.style.height = Math.max(2, Math.round(num(n.height) * k)) + "px";
        d.textContent = n.type === "text" ? String(n.text || "") : n.type === "file" ? nameOf(n.file) : n.type === "link" ? String(n.url || "") : String(n.label || "");
      }
      ping(ctx);
    });
    return true;
  }

  function openHere(node) {
    const p = String(node.data.file || ""), v = node.canvas.view;
    const leaf = v && v.leaf;
    if (leaf && typeof leaf.setViewState === "function")
      Promise.resolve(leaf.setViewState({ type: "canvas", state: { file: p }, active: true })).catch(e => console.error("[canvas] open canvas:", e));
  }

  /* ------------------------------------------------ PDF: page input, of N, outline, wheel */
  function pdfWatch(node, ctx) {
    const seq = node._cvmSeq;
    const tryDecorate = () => {
      if (node._cvmSeq !== seq || node._gone) return true;
      const s = node.contentEl.querySelector(".pdf-embed"), bar = s && s.querySelector(".pdf-toolbar");
      if (!bar) return false;
      pdfDecorate(node, ctx, s, bar);
      return true;
    };
    if (tryDecorate()) return;
    const mo = new MutationObserver(() => { if (tryDecorate()) mo.disconnect(); });
    mo.observe(node.contentEl, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 15000);
  }
  function pdfDecorate(node, ctx, s, bar) {
    if (s._cvmDone) return;
    s._cvmDone = true;
    s.classList.add("cvm-pdf");
    const cnt = bar.querySelector(".pdf-counter"), zo = bar.querySelector(".pdf-zoom-out");
    const ol = mk("button", "cvm-pdf-outline"); ol.type = "button"; ol.setAttribute("aria-label", "Toggle outline");
    const inp = mk("input", "cvm-pdf-page"); inp.type = "text"; inp.inputMode = "numeric"; inp.setAttribute("aria-label", "Page number");
    const of = mk("span", "cvm-pdf-of");
    bar.insertBefore(ol, bar.firstChild);
    bar.insertBefore(inp, cnt || zo || null);
    bar.insertBefore(of, cnt || zo || null);
    const list = mk("div", "cvm-pdf-outline-list", s);
    for (const ev of ["pointerdown", "mousedown", "dblclick"]) { bar.addEventListener(ev, stop); list.addEventListener(ev, stop); }
    inp.addEventListener("mousedown", e => e.stopPropagation(), true);
    inp.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); go(parseInt(inp.value, 10)); inp.blur(); }
      else if (e.key === "Escape") { e.preventDefault(); sync(); inp.blur(); }
    });
    const box = () => s.querySelector(".pdf-container");
    const pages = () => [...s.querySelectorAll(".pdf-page")];
    const go = n => { const ps = pages(), b = box(); if (!b || !ps.length || !(n >= 1)) return sync(); const im = ps[Math.min(ps.length, n) - 1]; b.scrollTop = im.offsetTop; sync(); };
    const sync = () => {
      const n = parseInt(s.dataset.of, 10) || 0;
      if (document.activeElement !== inp) inp.value = s.dataset.cur || "1";
      of.textContent = "of " + n;
      if (list.childElementCount !== n) {
        list.textContent = "";
        for (let i = 1; i <= n; i++) { const r = mk("div", "", list); r.textContent = "Page " + i; r.addEventListener("click", e => { e.stopPropagation(); go(i); }); }
      }
      ping(ctx);
    };
    ol.addEventListener("click", e => { e.stopPropagation(); s.classList.toggle("is-outline"); ping(ctx); });
    new MutationObserver(sync).observe(s, { attributes: true, attributeFilter: ["data-cur", "data-of"] });
    sync();
    node._cvm = { k: "pdf", s, inp, ol };
    const b0 = box(); if (b0) b0.addEventListener("scroll", () => ping(ctx), { passive: true });
  }

  /* ------------------------------------------------ per-card listeners (once per node) */
  function wire(node) {
    if (node._cvmWired) return;
    node._cvmWired = true;
    node.containerEl.addEventListener("wheel", e => {
      const m = node._cvm;
      if (!m || m.k !== "pdf" || !m.s || e.ctrlKey || e.metaKey) return;
      // Shift+wheel (or a sideways wheel) is a horizontal pan: the board keeps it (cvjourney pans with Shift+wheel)
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      if (!node.canvas.selection.has(node) || node.canvas.selection.size !== 1) return;
      const b = m.s.querySelector(".pdf-container");
      if (!b) return;
      e.preventDefault(); e.stopPropagation();
      let d = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? b.clientHeight : 1);
      if (d && Math.abs(d) < 40) d = Math.sign(d) * 40;
      b.scrollTop += d;
    }, { passive: false });
  }

  // a double-click on a media / PDF / missing card only selects it; on a canvas card it opens that canvas here
  window.addEventListener("dblclick", e => {
    let node = null;
    for (const el of (document.elementsFromPoint ? document.elementsFromPoint(e.clientX, e.clientY) : [])) {
      const c = el.closest && el.closest(".canvas-node");
      if (c) { node = nodes.get(c) || null; break; }
    }
    if (!node || node._gone || !node._cvm || node.isEditing) return;
    const k = node._cvm.k;
    if (k === "note" || k === "other") return;
    if (e.target && e.target.closest && e.target.closest("input, button, audio, video")) return;
    e.stopPropagation(); e.preventDefault();
    if (k === "canvas") openHere(node);
  }, true);

  /* ------------------------------------------------ census (main.js canvasTok) */
  function census(v) {
    if (!v || !v.canvas) return "";
    const esc = s => String(s).replace(/[[\]|@]/g, "_").replace(/\s+/g, " ").trim();
    const vis = e => !!e && e.isConnected && e.getClientRects().length > 0;
    const c = e => { const r = e.getBoundingClientRect(); return Math.round(r.x + r.width / 2) + "," + Math.round(r.y + r.height / 2); };
    let t = "", k = 0;
    for (const n of v.canvas.nodes.values()) {
      if (k >= 16 || !n.data || n.data.type !== "file" || !n._cvm || !vis(n.containerEl)) continue;
      k++;
      const m = n._cvm, id = esc(n.id);
      let s = " [cvm:" + id + "|k=" + m.k + "|lbl=" + esc(n.labelEl.textContent || "");
      const cc = n._cc || {};
      if (m.k === "audio" || m.k === "video") {
        const md = cc.media, ok = md && n.contentEl.contains(md);
        const tenth = x => (isFinite(x) ? Math.round(x * 10) : 0);
        s += "|ctl=" + (ok && md.controls ? 1 : 0) + "|rs=" + (ok ? md.readyState : 0) + "|dur=" + (ok ? tenth(md.duration) : 0) +
             "|ct=" + (ok ? tenth(md.currentTime) : 0) + "|vw=" + (ok && m.k === "video" ? md.videoWidth : 0);
      } else if (m.k === "other") {
        const box = n.contentEl.querySelector(".canvas-file-other");
        s += "|icon=" + (box && vis(box.querySelector(".cvm-file-icon")) ? 1 : 0) + "|tx=" + esc(box ? visText(box) : "");
      } else if (m.k === "canvas") {
        const pv = [...n.contentEl.querySelectorAll(".cvm-pv-node")];
        s += "|nf=" + (/not found/i.test(n.contentEl.textContent) ? 1 : 0) + "|pv=" + pv.length + "|tx=" + esc(pv.map(x => x.textContent).join(" ")).slice(0, 60);
      } else if (m.k === "missing") {
        s += "|warn=" + (n.labelEl.querySelector(".cvm-warn-icon") ? 1 : 0) + "|msg=" + esc(m.msg ? m.msg.textContent : "").slice(0, 80);
        const bs = [...n.contentEl.querySelectorAll(".cvm-missing-btns button")].filter(vis);
        if (bs.length) t += " [cvmb:" + id + "|" + bs.map(b => b.dataset.cvm + "@" + c(b)).join("|") + "]";
      } else if (m.k === "note") {
        s += "|ed=" + (n.isEditing ? 1 : 0) + "|fo=" + (n.containerEl.contains(document.activeElement) ? 1 : 0);
      } else if (m.k === "pdf" && m.s && m.s.isConnected) {
        const S = m.s, bar = S.querySelector(".pdf-toolbar"), parts = [];
        const at = (name, el) => { if (vis(el)) parts.push(name + "@" + c(el)); };
        if (bar) { at("pdf-page-input", m.inp); at("pdf-outline-toggle", m.ol); at("pdf-zoom-out", bar.querySelector(".pdf-zoom-out")); at("pdf-zoom-in", bar.querySelector(".pdf-zoom-in")); }
        parts.push("pg=" + (S.dataset.cur || ""), "of=" + (S.dataset.of || ""));
        const p1 = S.querySelector(".pdf-page");
        if (vis(p1)) parts.push("top=" + Math.round(p1.getBoundingClientRect().top - n.containerEl.getBoundingClientRect().top));
        t += " [cvmpdf:" + id + "|" + parts.join("|") + "]";
      }
      t += s + "]";
    }
    if (ST.pick && ST.pick.m && vis(ST.pick.input)) {
      const rows = [...ST.pick.m.resultContainerEl.querySelectorAll(".suggestion-item")];
      t += " [cvmpick:swap|n=" + rows.length + "|" + esc(rows.length ? rows[0].textContent.slice(0, 60) : "") + "]";
    }
    return t;
  }
  function visText(box) {        // the text a user sees in the card (hidden badges excluded)
    let s = "";
    const walk = e => { for (const x of e.childNodes) { if (x.nodeType === 3) s += x.textContent; else if (x.nodeType === 1 && x.getClientRects().length) walk(x); } };
    walk(box);
    return s;
  }

  const api = { file, census };
  Object.defineProperty(window, "CanvasMedia", { configurable: true, enumerable: false, writable: false, value: Object.freeze(api) });
})();
