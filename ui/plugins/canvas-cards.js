// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* canvas cards (goal cv-cards): what a card on a canvas board shows, written from
   the public help pages (help.obsidian.md/plugins/canvas) and the JSON Canvas 1.0
   spec (jsoncanvas.org/spec/1.0, MIT) — clean room.

     text card   its Markdown through the app's renderer (X.MarkdownRenderer, the same
                 sanitizing Rust render notes use); an internal [[link]] in it opens the
                 note in a new tab on click
     file card   image -> <img>, audio -> <audio controls>, video -> <video controls>,
                 any other non-note file -> its name + extension, opened with the system
                 default app on double-click (a note card stays canvas.js's md embed)
     link card   Ctrl/Cmd-click hands the URL to the app's ONE external-link gate
                 (main.js a.ext capture -> open_external, Rust re-checks the scheme)
     group       background image (JSON Canvas "background" + "backgroundStyle"
                 cover | ratio | repeat); double-click its label to rename, Enter saves
     every card  the wheel scrolls a card's own content only while it is selected;
                 unselected, the wheel keeps panning the board

   Load order (index.html): ... canvas.js -> canvas-cards.js -> main.js. This file runs
   no code at load beyond one stylesheet and one frozen global, window.__osCanvasCards,
   whose hooks canvas.js's node render() bodies call, and whose census(view) main.js
   canvasTok() appends ([cvcard:] [cvext:]).
   Media bytes ride the app's image scheme (opensidian-img://localhost/<path>), which
   serves the image types the app allows; anything else the scheme refuses stays an
   empty element rather than a fetch of anything outside the vault. */
(function () {
  "use strict";
  const IMG = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
  const AUD = new Set(["mp3", "wav", "m4a", "ogg", "3gp", "flac"]);
  const VID = new Set(["mp4", "webm", "ogv", "mov", "mkv"]);
  const BG = { cover: 1, ratio: 1, repeat: 1 };
  const ST = { ext: "", extN: 0 };      // the last URL a link card handed to open_external
  const LINK_SEL = "a.wiki, a.internal-link";

  const extOf = p => { const n = String(p || "").split("/").pop(); const d = n.lastIndexOf("."); return d > 0 ? n.slice(d + 1).toLowerCase() : ""; };
  const nameOf = p => String(p || "").split("/").pop();
  const mediaUrl = p => "opensidian-img://localhost/" + String(p).split("/").map(encodeURIComponent).join("/");
  const mk = (tag, cls, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; if (parent) parent.appendChild(e); return e; };
  const ping = ctx => { if (ctx && ctx.deps && typeof ctx.deps.changed === "function") try { ctx.deps.changed(); } catch (_) {} };
  const later = (ctx, ms) => setTimeout(() => ping(ctx), ms || 30);
  const selected = node => !!(node.canvas && node.canvas.selection && node.canvas.selection.has(node));
  const srcPath = node => (node.canvas && node.canvas.path) || "";

  // content rules only (.canvas-node-*): the rendered markdown is block HTML, not the
  // pre-wrap plain text .canvas-text was styled for
  const css = mk("style");
  css.textContent =
    ".canvas-node .canvas-text.markdown-rendered { white-space: normal }\n" +
    ".canvas-node .canvas-text.markdown-rendered > :first-child { margin-top: 0 }\n" +
    ".canvas-node .canvas-text.markdown-rendered > :last-child { margin-bottom: 0 }\n" +
    ".canvas-node-container > .canvas-file-img { display: block; width: 100%; height: 100%; object-fit: contain }\n" +
    ".canvas-node-container > .canvas-file-media { display: block; width: 100%; max-height: 100%; box-sizing: border-box; padding: 8px }\n" +
    ".canvas-node.is-selected.cc-media > .canvas-node-content-blocker { display: none }\n" +
    ".canvas-file-other { padding: 8px 12px; display: flex; flex-direction: column; gap: 4px }\n" +
    ".canvas-file-other-ext { color: var(--text-muted, #999); font-size: 12px; text-transform: uppercase }\n" +
    ".canvas-node-label > .canvas-group-label-input { font: inherit; color: var(--text-normal, #ddd); min-width: 160px }\n" +
    // goal cvf-textedit: the card editor in the text font, live-preview heading sizes, the link suggester
    ".canvas-node.cc-lp .cvf-text-editor .cm-scroller, .canvas-node.cc-lp .cvf-text-editor .cm-content { font-family: var(--font-text, system-ui, sans-serif) }\n" +
    ".canvas-node.cc-lp .cm-line.cc-lp-h { font-weight: 700; line-height: 1.3 }\n" +
    ".canvas-node.cc-lp .cm-line.cc-lp-h1 { font-size: 1.8em } .canvas-node.cc-lp .cm-line.cc-lp-h2 { font-size: 1.5em }\n" +
    ".canvas-node.cc-lp .cm-line.cc-lp-h3 { font-size: 1.3em } .canvas-node.cc-lp .cm-line.cc-lp-h4 { font-size: 1.15em }\n" +
    ".canvas-node.cc-lp .cc-lp-strong { font-weight: 700 }\n" +
    ".canvas-node.cc-lp .cc-lp-link { color: var(--text-accent, #a78bfa); text-decoration: underline }\n" +
    ".canvas-link-suggest { position: fixed; z-index: 60; min-width: 220px; max-width: 360px; background: var(--background-primary, #1e1e1e); color: var(--text-normal, #ddd);" +
    " border: 1px solid var(--background-modifier-border, #444); border-radius: 6px; box-shadow: 0 4px 14px rgba(0,0,0,.35); font-size: 13px; overflow: hidden }\n" +
    ".canvas-link-suggest-list { max-height: 260px; overflow-y: auto; padding: 4px }\n" +
    ".canvas-link-suggest-item { padding: 4px 8px; border-radius: 4px; cursor: pointer }\n" +
    ".canvas-link-suggest-item.is-selected { background: var(--background-modifier-hover, #333) }\n" +
    ".canvas-link-suggest-path { color: var(--text-muted, #999); font-size: 11px }\n" +
    ".canvas-link-suggest-foot { padding: 4px 8px; color: var(--text-faint, #888); font-size: 11px; border-top: 1px solid var(--background-modifier-border, #444) }\n";
  (document.head || document.documentElement).appendChild(css);

  /* the app's external-link gate: main.js swallows any click on an a.ext in the capture
     phase and hands its href to open_external ([ext:N] counts it). A transient anchor
     goes through exactly that path; its own listener cancels the default navigation in
     case no gate is installed (a canvas never navigates the webview). */
  function openExternal(url, ctx) {
    if (!/^https?:\/\//i.test(url)) return false;
    const a = mk("a", "ext");
    a.href = url; a.hidden = true;
    a.addEventListener("click", e => e.preventDefault());
    document.body.appendChild(a);
    try { a.click(); } finally { a.remove(); }
    ST.ext = url; ST.extN++;
    ping(ctx);
    return true;
  }

  /* one set of listeners per node element (render() runs again on every edit) */
  function wire(node, ctx) {
    node._ccCtx = ctx;
    const cv = node.canvas;
    if (cv && !cv._ccWired && cv.wrapperEl) {      // the census follows selection + pan, which canvas.js does not announce
      cv._ccWired = true;
      cv.wrapperEl.addEventListener("pointerdown", () => later(node._ccCtx, 40));
      cv.wrapperEl.addEventListener("wheel", () => requestAnimationFrame(() => ping(node._ccCtx)), { passive: true });
    }
    if (node._ccWired) return;
    node._ccWired = true;
    const box = node.containerEl;
    box.addEventListener("pointerdown", e => {
      const c = node._ccCtx, s = node._cc || {};
      if (node.isEditing || e.button !== 0) return;
      if (s.kind === "text") {                       // an internal link under the pointer (the blocker sits over it)
        const hit = document.elementsFromPoint(e.clientX, e.clientY).map(x => x.closest && x.closest(LINK_SEL)).find(a => a && node.contentEl.contains(a));
        if (hit) {
          e.stopPropagation(); e.preventDefault();
          const lt = (hit.dataset.note || hit.getAttribute("data-href") || hit.textContent || "") + (hit.dataset.anchor ? "#" + hit.dataset.anchor : "");
          // a selected card's link opens in place (Back returns to the board); Ctrl/Cmd, or a card not yet selected: a new tab
          const how = e.ctrlKey || e.metaKey || !selected(node) ? "tab" : false;
          if (lt && c.app && c.app.workspace) c.app.workspace.openLinkText(lt, srcPath(node), how).catch(err => console.error("[canvas] open link:", err));
          return;
        }
      }
      if (s.kind === "link" && (e.ctrlKey || e.metaKey) && !e.target.classList.contains("canvas-node-resizer")) {
        e.stopPropagation(); e.preventDefault();
        openExternal(String(node.data.url || ""), c);
        return;
      }
      if ((s.kind === "audio" || s.kind === "video") && selected(node) && e.target === s.media) e.stopPropagation();   // its native controls take the press
    });
    box.addEventListener("wheel", e => {
      if (node.isEditing || e.ctrlKey || e.metaKey || !selected(node)) return;   // unselected: the board pans (canvas.js)
      const sc = node.contentEl;
      if (!(sc.scrollHeight > sc.clientHeight + 1)) return;
      const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? sc.clientHeight : 1;
      e.preventDefault(); e.stopPropagation();
      sc.scrollTop += e.deltaY * k;
      requestAnimationFrame(() => ping(node._ccCtx));
    }, { passive: false });
    /* An other-kind file opens on a double press. The board takes pointer capture on every press
       (canvas.js), so the second click and the dblclick land on the wrapper, not on this card:
       detect the double press here, before the wrapper sees it. dblclick stays as a fallback for
       a press that did reach the card, deduped against the press that already opened. */
    let lastP = 0, px = 0, py = 0, opened = 0;
    const openOther = () => {
      const c = node._ccCtx, s = node._cc || {};
      opened = Date.now();
      s.open = (s.open || 0) + 1;
      const fn = c.app && typeof c.app.openWithDefaultApp === "function" ? c.app.openWithDefaultApp : null;
      if (fn) Promise.resolve(fn.call(c.app, node.data.file)).catch(err => console.warn("[canvas] open file:", err));
      ping(c);
    };
    box.addEventListener("pointerdown", e => {
      const s = node._cc || {};
      if (s.kind !== "other" || node.isEditing || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.target.classList.contains("canvas-node-resizer")) return;
      const now = Date.now(), dbl = now - lastP < 500 && Math.abs(e.clientX - px) + Math.abs(e.clientY - py) < 8;
      lastP = now; px = e.clientX; py = e.clientY;
      if (!dbl) return;                              // a single press still selects / drags the card (canvas.js)
      lastP = 0;
      e.stopPropagation(); e.preventDefault();
      openOther();
    });
    box.addEventListener("dblclick", e => {
      const s = node._cc || {};
      if (s.kind !== "other" || node.isEditing) return;
      e.stopPropagation();
      if (Date.now() - opened > 600) openOther();
    });
  }

  /* ------------------------------------------------ text card editor (goal cvf-textedit)
     canvas-files.js mounts the CM6 note editor in a text card; this layer, hooked on the node
     instance once, adds what the card editor does on top of a plain CM6 view:
       - entering edit selects the card alone (the node toolbar shows over it while editing);
         leaving edit keeps it selected, a further Escape on the board clears the selection
       - live preview: a heading line paints large, '#' / '**' / '[[ ]]' markup is hidden on
         every line the caret is not on; proportional text font
       - '[[' adds its closing ']]'; inside '[[...' a link suggester lists the vault's notes:
         Up/Down move, Enter/Tab insert, Escape closes it (and only it) */
  const LP = { v: null };
  function lpExt(Vw) {
    if (LP.v) return LP.v;
    const D = Vw.Decoration, hide = D.replace({}), strong = D.mark({ class: "cc-lp-strong" }), lnk = D.mark({ class: "cc-lp-link" });
    const head = [1, 2, 3, 4, 5, 6].map(n => D.line({ class: "cc-lp-h cc-lp-h" + n }));
    const build = v => {
      const s = v.state, doc = s.doc, out = [], caret = new Set();
      for (const r of s.selection.ranges) for (let i = doc.lineAt(r.from).number, b = doc.lineAt(r.to).number; i <= b; i++) caret.add(i);
      for (const vr of v.visibleRanges) {
        for (let p = vr.from; p <= vr.to;) {
          const ln = doc.lineAt(p), t = ln.text, off = !caret.has(ln.number);
          const h = /^(#{1,6})[ \t]+/.exec(t);
          if (h) { out.push(head[h[1].length - 1].range(ln.from)); if (off) out.push(hide.range(ln.from, ln.from + h[0].length)); }
          const re = /\*\*(?=\S)([^*\n]*?\S)\*\*|\[\[([^\]|\n]+)(\|[^\]\n]*)?\]\]/g;
          let m;
          while ((m = re.exec(t))) {
            const a = ln.from + m.index, b = a + m[0].length;
            const in0 = m[2] === undefined ? a + 2 : m[3] ? a + 2 + m[2].length + 1 : a + 2;
            if (in0 < b - 2) out.push((m[2] === undefined ? strong : lnk).range(in0, b - 2));
            if (off) { out.push(hide.range(a, in0)); out.push(hide.range(b - 2, b)); }
          }
          p = ln.to + 1;
        }
      }
      return D.set(out, true);
    };
    const plugin = Vw.ViewPlugin.fromClass(class {
      constructor(v) { this.decorations = build(v); }
      update(u) { if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = build(u.view); }
    }, { decorations: p => p.decorations });
    // the second '[' of '[[' brings its ']]' (not when they are already there)
    const close = Vw.EditorView.inputHandler.of((view, from, to, ins) => {
      const d = view.state.doc;
      if (ins !== "[" || from < 1 || d.sliceString(from - 1, from) !== "[" || d.sliceString(to, to + 2) === "]]") return false;
      view.dispatch({ changes: { from, to, insert: "[]]" }, selection: { anchor: from + 1 }, userEvent: "input.type" });
      return true;
    });
    // the note editor's keys (caret to doc start/end, word moves, undo/redo): the bare embed editor has none
    const C = (window.__osModules || {})["@codemirror/commands"], keys = [];
    if (C && Array.isArray(C.defaultKeymap)) {
      if (typeof C.history === "function") keys.push(C.history());
      keys.push(Vw.keymap.of([].concat(C.defaultKeymap, Array.isArray(C.historyKeymap) ? C.historyKeymap : [])));
    }
    return (LP.v = [plugin, close].concat(keys));
  }

  // '[[query' before the caret on its line, not yet closed: { start (after '[['), q } or null
  function sugAt(view) {
    const s = view.state, r = s.selection.main;
    if (!r.empty) return null;
    const ln = s.doc.lineAt(r.head), before = ln.text.slice(0, r.head - ln.from), i = before.lastIndexOf("[[");
    if (i < 0) return null;
    const q = before.slice(i + 2);
    return /[\]|#^\n]/.test(q) ? null : { start: ln.from + i + 2, q };
  }
  function sugFiles(app, q) {
    let all = [];
    try { all = app && app.vault ? app.vault.getMarkdownFiles() : []; } catch (_) { all = []; }
    const lq = q.toLowerCase(), hits = [];
    for (const f of all) {
      const b = String(f.basename || nameOf(f.path).replace(/\.md$/i, "")).toLowerCase(), p = String(f.path).toLowerCase();
      const sc = !lq ? 0 : b.startsWith(lq) ? 0 : b.includes(lq) ? 1 : p.includes(lq) ? 2 : -1;
      if (sc >= 0) hits.push({ f, sc, b });
    }
    hits.sort((x, y) => x.sc - y.sc || x.b.localeCompare(y.b) || String(x.f.path).localeCompare(String(y.f.path)));
    return hits.slice(0, 10).map(h => h.f);
  }
  function sugClose(node) {
    const g = node._ccSug;
    if (!g || !g.el) return;
    g.el.remove(); g.el = null; g.files = [];
    ping(node._ccCtx);
  }
  function sugPaint(g) {
    g.list.textContent = "";
    g.files.forEach((f, i) => {
      const it = mk("div", "canvas-link-suggest-item" + (i === g.idx ? " is-selected" : ""), g.list);
      mk("div", "canvas-link-suggest-title", it).textContent = f.basename || nameOf(f.path).replace(/\.md$/i, "");
      const dir = String(f.path).includes("/") ? String(f.path).slice(0, String(f.path).lastIndexOf("/")) : "";
      if (dir) mk("div", "canvas-link-suggest-path", it).textContent = dir;
      it.addEventListener("pointerdown", e => { e.preventDefault(); e.stopPropagation(); g.idx = i; sugPick(g.node); });
    });
  }
  function sugUpdate(node, view) {
    const g = node._ccSug || (node._ccSug = { node, el: null, files: [], idx: 0, start: -1, dis: -1 });
    const at = view.hasFocus ? sugAt(view) : null;
    if (!at) { g.dis = -1; sugClose(node); return; }
    if (at.start === g.dis) { sugClose(node); return; }      // Escape closed it for this '[['
    g.start = at.start; g.view = view;
    const files = sugFiles(node._ccCtx && node._ccCtx.app, at.q);
    if (!files.length) { sugClose(node); return; }
    if (!g.el) {
      g.el = mk("div", "canvas-link-suggest", document.body);
      g.list = mk("div", "canvas-link-suggest-list", g.el);
      mk("div", "canvas-link-suggest-foot", g.el).textContent = "↑↓ choose · ↵ insert · esc dismiss";
      g.el.addEventListener("pointerdown", e => { e.preventDefault(); e.stopPropagation(); });
      g.el.addEventListener("wheel", e => e.stopPropagation(), { passive: true });
    }
    const same = g.files.length === files.length && g.files.every((f, i) => f === files[i]);
    if (!same) { g.files = files; g.idx = 0; }
    sugPaint(g);
    const c = view.coordsAtPos(Math.max(0, at.start - 2));
    if (c) { g.el.style.left = Math.round(c.left) + "px"; g.el.style.top = Math.round(c.bottom + 4) + "px"; }
    ping(node._ccCtx);
  }
  function sugPick(node) {
    const g = node._ccSug, view = g && g.view;
    if (!g || !g.el || !view || !g.files[g.idx]) return;
    const f = g.files[g.idx], base = f.basename || nameOf(f.path).replace(/\.md$/i, "");
    let lt = base;
    try { if (g.files.length && node._ccCtx.app.vault.getMarkdownFiles().filter(x => x.basename === base).length > 1) lt = String(f.path).replace(/\.md$/i, ""); } catch (_) {}
    const head = view.state.selection.main.head, doc = view.state.doc;
    const closed = doc.sliceString(head, head + 2) === "]]";
    view.dispatch({ changes: { from: g.start, to: head, insert: lt + (closed ? "" : "]]") }, selection: { anchor: g.start + lt.length + 2 }, userEvent: "input.complete" });
    sugClose(node);
  }
  function sugKey(node, e) {
    const g = node._ccSug;
    if (!g || !g.el) return;
    const n = g.files.length;
    if (e.key === "Escape") { g.dis = g.start; sugClose(node); }
    else if (e.key === "ArrowDown") { g.idx = (g.idx + 1) % n; sugPaint(g); ping(node._ccCtx); }
    else if (e.key === "ArrowUp") { g.idx = (g.idx + n - 1) % n; sugPaint(g); ping(node._ccCtx); }
    else if (e.key === "Enter" || e.key === "Tab") sugPick(node);
    else return;
    e.preventDefault(); e.stopPropagation();
  }
  function edExtend(node) {
    const st = node._cvfEd, M = window.__osModules || {}, Vw = M["@codemirror/view"], Sx = M["@codemirror/state"];
    if (!st || !st.em || !st.em.cm || !Vw || !Sx || st._cc) return;
    st._cc = true;
    node.containerEl.classList.add("cc-lp");
    try {
      st.em.cm.dispatch({ effects: Sx.StateEffect.appendConfig.of([lpExt(Vw),
        Vw.EditorView.updateListener.of(u => {
          if (!(u.docChanged || u.selectionSet || u.focusChanged)) return;
          sugUpdate(node, u.view);
          // the census (caret line, painted lines) follows the caret: one refresh per frame
          if (!node._ccRaf) node._ccRaf = requestAnimationFrame(() => { node._ccRaf = 0; ping(node._ccCtx); });
        })]) });
    } catch (e) { console.error("[canvas] text card editor extensions:", e); }
    st.host.addEventListener("keydown", e => sugKey(node, e), true);   // before the editor and the card's own Escape
  }
  function edHook(node) {
    if (node._ccEd) return;
    node._ccEd = true;
    const start = node.startEditing, stop = node.stopEditing;
    node.startEditing = function () {
      const r = start.apply(this, arguments);
      if (this.isEditing && !this._gone) {
        const c = this.canvas;
        if (c && typeof c.select === "function" && !(c.selection.size === 1 && c.selection.has(this))) c.select(this, false);
        edExtend(this);
        ping(this._ccCtx);
      }
      return r;
    };
    node.stopEditing = function () {
      sugClose(this);
      if (this._ccSug) this._ccSug.dis = -1;
      return stop.apply(this, arguments);
    };
  }

  function text(node, ctx) {
    wire(node, ctx);
    edHook(node);
    const seq = (node._ccSeq = (node._ccSeq || 0) + 1);
    node._cc = { kind: "text", md: 0, tags: "" };
    const src = String(node.data.text == null ? "" : node.data.text);
    const MR = ctx.X && ctx.X.MarkdownRenderer;
    if (!MR || typeof MR.render !== "function") return;
    const out = mk("div", "canvas-text markdown-rendered");
    Promise.resolve(MR.render(ctx.app, src, out, srcPath(node), node)).then(() => {
      if (node._ccSeq !== seq || node.isEditing || node._gone) return;
      node.contentEl.textContent = "";
      node.contentEl.appendChild(out);
      const tags = [];
      for (const x of out.querySelectorAll("*")) { const t = x.tagName.toLowerCase(); if (!tags.includes(t)) tags.push(t); }
      node._cc.md = 1; node._cc.tags = tags.slice(0, 12).join(".");
      ping(ctx);
    }, e => console.error("[canvas] text card render:", e));
  }

  // a non-note file card; false = not ours (a note, a canvas, a missing file: canvas.js paints it)
  function file(node, ctx) {
    wire(node, ctx);
    const p = String(node.data.file || ""), ext = ctx.file && ctx.file.extension ? String(ctx.file.extension).toLowerCase() : extOf(p);
    node.containerEl.classList.remove("cc-media");
    // the vault model lists notes, canvases and images only: no TFile for an .mp3/.zip says nothing
    const tracked = ext === "md" || ext === "canvas" || IMG.has(ext);
    if (ext === "md" || ext === "canvas" || (ctx.missing && tracked) || !p) { node._cc = { kind: ext === "md" && !ctx.missing ? "note" : "missing" }; return false; }   // goal cv-model: a note not in the vault model is missing, not a note
    const host = node.contentEl;
    if (IMG.has(ext)) {
      const img = mk("img", "canvas-file-img", host);
      img.alt = nameOf(p); img.draggable = false;
      img.addEventListener("load", () => ping(ctx), { once: true });
      img.addEventListener("error", () => ping(ctx), { once: true });
      img.src = mediaUrl(p);
      node._cc = { kind: "image", img };
      return true;
    }
    if (AUD.has(ext) || VID.has(ext)) {
      const kind = AUD.has(ext) ? "audio" : "video";
      const m = mk(kind, "canvas-file-media", host);
      m.controls = true; m.preload = "metadata";
      m.src = mediaUrl(p);
      node.containerEl.classList.add("cc-media");
      node._cc = { kind, media: m };
      return true;
    }
    const box = mk("div", "canvas-file-other", host);
    mk("div", "canvas-file-other-name", box).textContent = nameOf(p);
    mk("div", "canvas-file-other-ext", box).textContent = ext || "file";
    node._cc = { kind: "other", open: (node._cc && node._cc.open) || 0 };
    return true;
  }

  function link(node, ctx) {
    wire(node, ctx);
    node._cc = { kind: "link" };
  }

  function group(node, ctx) {
    wire(node, ctx);
    const d = node.data, c = node.contentEl, s = c.style;
    const bg = typeof d.background === "string" ? d.background : "";
    const how = BG[d.backgroundStyle] ? d.backgroundStyle : "cover";
    if (bg) {
      s.backgroundImage = 'url("' + mediaUrl(bg) + '")';
      s.backgroundPosition = "center";
      s.backgroundSize = how === "cover" ? "cover" : how === "ratio" ? "contain" : "auto";
      s.backgroundRepeat = how === "repeat" ? "repeat" : "no-repeat";
    } else { s.backgroundImage = ""; s.backgroundPosition = ""; s.backgroundSize = ""; s.backgroundRepeat = ""; }
    node._cc = { kind: "group", bg: bg ? how : "-", ren: node._cc && node._cc.ren ? 1 : 0 };
    const lab = node.labelEl;
    if (lab._ccWired) return;
    lab._ccWired = true;
    let last = 0, lx = 0, ly = 0;
    lab.addEventListener("pointerdown", e => {
      if (e.target !== lab || e.button !== 0) return;
      const now = Date.now(), dbl = now - last < 500 && Math.abs(e.clientX - lx) + Math.abs(e.clientY - ly) < 8;
      last = now; lx = e.clientX; ly = e.clientY;
      if (!dbl) return;                              // a single press still selects / drags the group (canvas.js)
      e.stopPropagation(); e.preventDefault();
      last = 0;
      rename(node);
    });
    lab.addEventListener("dblclick", e => { if (e.target === lab) { e.stopPropagation(); rename(node); } });
  }

  function rename(node) {
    const ctx = node._ccCtx, lab = node.labelEl, d = node.data;
    if (node._ccRen || (node.canvas && node.canvas.readonly)) return;
    node._ccRen = true; if (node._cc) node._cc.ren = 1;
    lab.textContent = "";
    const inp = mk("input", "canvas-group-label-input", lab);
    inp.type = "text"; inp.value = d.label || ""; inp.spellcheck = false;
    for (const ev of ["pointerdown", "dblclick", "wheel", "keyup"]) inp.addEventListener(ev, e => e.stopPropagation());
    let done = false;
    const finish = keep => {
      if (done) return; done = true;
      const v = inp.value.trim();
      node._ccRen = false; if (node._cc) node._cc.ren = 0;
      if (keep && v !== (d.label || "")) { if (v) d.label = v; else delete d.label; node.canvas.requestSave(); }
      lab.textContent = d.label || "";
      try { node.canvas.wrapperEl.focus({ preventScroll: true }); } catch (_) {}
      ping(ctx);
    };
    inp.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    inp.addEventListener("blur", () => finish(true));
    setTimeout(() => { try { inp.focus(); inp.select(); } catch (_) {} }, 0);
    ping(ctx);
  }

  /* census: one token per painted card of the visible canvas view, the board's pan,
     the last external open. Read off the DOM, not off node state, where it can be. */
  function census(v) {
    if (!v || !v.canvas) return "";
    const esc = x => String(x == null ? "" : x).replace(/[[\]|@]/g, "_").replace(/\s+/g, " ").trim();
    const vis = e => !!e && e.getClientRects().length > 0;
    const ctr = e => { const r = e.getBoundingClientRect(); return Math.round(r.x + r.width / 2) + "," + Math.round(r.y + r.height / 2); };
    let t = "", k = 0;
    for (const n of v.canvas.nodes.values()) {
      if (k >= 16 || !vis(n.containerEl)) continue;
      k++;
      const s = n._cc || {}, id = esc(n.id), ty = n.data.type;
      if (ty === "text") {
        const a = n.contentEl.querySelector(LINK_SEL);
        t += " [cvcard:" + id + "|md=" + (s.md && n.contentEl.querySelector(".markdown-rendered") ? 1 : 0) + "|kind=text|tags=" + esc(s.tags || "") + (vis(a) ? "|lnk=" + ctr(a) : "") + "]";
      } else if (ty === "file") {
        if (s.kind === "image") t += " [cvcard:" + id + "|img=" + (s.img && s.img.complete && s.img.naturalWidth > 0 ? 1 : 0) + "|kind=image]";
        else if (s.kind === "audio" || s.kind === "video") t += " [cvcard:" + id + "|kind=" + s.kind + "|ctl=" + (s.media && s.media.controls && n.contentEl.contains(s.media) ? 1 : 0) + "]";
        else if (s.kind === "other") t += " [cvcard:" + id + "|kind=other|name=" + esc(nameOf(n.data.file)) + "|open=" + (s.open || 0) + "]";
        else t += " [cvcard:" + id + "|kind=" + (s.kind || "note") + "|sel=" + (v.canvas.selection.has(n) ? 1 : 0) + "|st=" + Math.round(n.contentEl.scrollTop) +
                  "|txt=" + esc(n.contentEl.textContent).slice(0, 48) + "]";
      } else if (ty === "link") {
        const a = n.contentEl.querySelector(".canvas-link");
        t += " [cvcard:" + id + "|kind=link" + (vis(a) ? "|at=" + ctr(a) : "") + "]";
      } else if (ty === "group") {
        const cs = getComputedStyle(n.contentEl), bg = n.data.background;
        t += " [cvcard:" + id + "|kind=group" + (vis(n.labelEl) ? "|lab=" + ctr(n.labelEl) : "") + "|ren=" + (n._ccRen ? 1 : 0) + "|bg=" + esc(s.bg || "-") +
             "|rep=" + esc(cs.backgroundRepeat) + "|url=" + (bg && cs.backgroundImage.includes(mediaUrl(bg)) ? 1 : 0) + "]";
      }
    }
    t += " [cvcard:@pan|" + Math.round(v.canvas.tx) + "," + Math.round(v.canvas.ty) + "]";
    if (ST.ext) t += " [cvext:" + esc(ST.ext) + "]";
    return t;
  }

  Object.defineProperty(window, "__osCanvasCards", {
    configurable: false, enumerable: false, writable: false,
    value: Object.freeze({ text, file, link, group, census }),
  });
})();
