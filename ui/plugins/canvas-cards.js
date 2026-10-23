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
    ".canvas-node-label > .canvas-group-label-input { font: inherit; color: var(--text-normal, #ddd); min-width: 160px }\n";
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
          if (lt && c.app && c.app.workspace) c.app.workspace.openLinkText(lt, srcPath(node), "tab").catch(err => console.error("[canvas] open link:", err));
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
    box.addEventListener("dblclick", e => {
      const c = node._ccCtx, s = node._cc || {};
      if (s.kind !== "other" || node.isEditing) return;
      e.stopPropagation();
      s.open = (s.open || 0) + 1;
      const fn = c.app && typeof c.app.openWithDefaultApp === "function" ? c.app.openWithDefaultApp : null;
      if (fn) Promise.resolve(fn.call(c.app, node.data.file)).catch(err => console.warn("[canvas] open file:", err));
      ping(c);
    });
  }

  function text(node, ctx) {
    wire(node, ctx);
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
    if (ext === "md" || ext === "canvas" || (ctx.missing && tracked) || !p) { node._cc = { kind: ext === "md" ? "note" : "missing" }; return false; }
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
