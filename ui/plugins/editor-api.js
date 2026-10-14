// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* editor-api (recon T-c): Obsidian's Editor / MarkdownView / registerEditorExtension /
   EditorSuggest over the CM6 EditorView each note tab already owns (ui/editor.js Ed.mount).
   Loaded by index.html AFTER editor.js and BEFORE api.js. It defines ONE installer,
   window.__osEditorApi(ctx), which api.js calls once while it builds the API object and
   then deletes — no plugin ever sees it. Everything here works on the shared
   window.__osModules instances, so a plugin's ViewPlugin / StateField / Decoration is
   the same class the editor runs.

   Positions: Obsidian's EditorPosition is {line, ch}, both 0-based, ch in UTF-16 code
   units (CM6's own unit), lines split on \n, \r\n and \r alike (CM6 normalises; getValue
   joins with \n). Offsets are clamped to the document like CM6 does.

   Extensions: every view carries ONE Compartment (Ed.PX) whose content is
   Ed.pxExt(view): nothing until a plugin is loaded (restricted mode and an empty
   plugin set pay nothing per keystroke), then the info fields + the editor-change /
   paste / drop / suggest hooks + every registered extension. register/unregister
   reconfigures every open view; a view made later (new tab, setText's fresh state)
   reads Ed.pxExt when it builds its state. */
(function () {
  "use strict";
  const M = window.__osModules || {};
  const S = M["@codemirror/state"], V = M["@codemirror/view"], C = M["@codemirror/commands"];

  function install(ctx) {
    const EdG = typeof Ed !== "undefined" ? Ed : null;
    if (!S || !V || !EdG) return null;
    const app = () => ctx.app(), ws = () => ctx.app().workspace;

    /* ---------------------------------------------------------------- Editor */
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    class Editor {
      constructor(v) { Object.defineProperty(this, "_v", { value: v }); }
      get cm() { return this._v.cm; }
      get _d() { return this._v.cm.state.doc; }
      getDoc() { return this; }
      refresh() { this.cm.requestMeasure(); }
      getValue() { return this._d.toString(); }
      setValue(s) { this.cm.dispatch({ changes: { from: 0, to: this._d.length, insert: String(s == null ? "" : s) } }); }
      getLine(n) { const d = this._d; return n >= 0 && n < d.lines ? d.line(n + 1).text : ""; }
      setLine(n, text) { const d = this._d; if (n < 0 || n >= d.lines) return; const l = d.line(n + 1); this.cm.dispatch({ changes: { from: l.from, to: l.to, insert: String(text) } }); }
      lineCount() { return this._d.lines; }
      firstLine() { return 0; }
      lastLine() { return this._d.lines - 1; }
      posToOffset(p) {
        const d = this._d; if (!p) return 0;
        if (p.line < 0) return 0;
        if (p.line + 1 > d.lines) return d.length;
        const l = d.line((p.line | 0) + 1);
        return l.from + clamp(p.ch | 0, 0, l.length);
      }
      offsetToPos(o) { const d = this._d, x = clamp(o | 0, 0, d.length), l = d.lineAt(x); return { line: l.number - 1, ch: x - l.from }; }
      getCursor(which) {
        const r = this.cm.state.selection.main;
        const o = which === "from" ? r.from : which === "to" ? r.to : which === "anchor" ? r.anchor : r.head;
        return this.offsetToPos(o);
      }
      setCursor(pos, ch) {
        const p = typeof pos === "number" ? { line: pos, ch: ch == null ? 0 : ch } : pos;
        this.cm.dispatch({ selection: { anchor: this.posToOffset(p) }, scrollIntoView: true });
      }
      getSelection() { const r = this.cm.state.selection.main; return this.cm.state.sliceDoc(r.from, r.to); }
      setSelection(anchor, head) {
        const a = this.posToOffset(anchor), h = head ? this.posToOffset(head) : a;
        this.cm.dispatch({ selection: { anchor: a, head: h }, scrollIntoView: true });
      }
      listSelections() { return this.cm.state.selection.ranges.map(r => ({ anchor: this.offsetToPos(r.anchor), head: this.offsetToPos(r.head) })); }
      setSelections(ranges, main) {
        if (!ranges || !ranges.length) return;
        const rs = ranges.map(r => S.EditorSelection.range(this.posToOffset(r.anchor), this.posToOffset(r.head || r.anchor)));
        this.cm.dispatch({ selection: S.EditorSelection.create(rs, clamp(main | 0, 0, rs.length - 1)) });
      }
      somethingSelected() { return this.cm.state.selection.ranges.some(r => !r.empty); }
      replaceSelection(text, origin) {
        const tr = this.cm.state.replaceSelection(String(text == null ? "" : text));
        this.cm.dispatch(tr, { userEvent: origin ? String(origin) : "input" });
      }
      replaceRange(text, from, to, origin) {
        const a = this.posToOffset(from), b = to ? this.posToOffset(to) : a;
        this.cm.dispatch({ changes: { from: Math.min(a, b), to: Math.max(a, b), insert: String(text == null ? "" : text) }, userEvent: origin ? String(origin) : undefined });
      }
      getRange(from, to) { const a = this.posToOffset(from), b = this.posToOffset(to); return this.cm.state.sliceDoc(Math.min(a, b), Math.max(a, b)); }
      wordAt(pos) { const w = this.cm.state.wordAt(this.posToOffset(pos)); return w ? { from: this.offsetToPos(w.from), to: this.offsetToPos(w.to) } : null; }
      focus() { this.cm.focus(); }
      blur() { this.cm.contentDOM.blur(); }
      hasFocus() { return this.cm.hasFocus; }
      getScrollInfo() { const s = this._v.lp || this.cm.scrollDOM; return { top: s.scrollTop, left: s.scrollLeft, height: s.scrollHeight, width: s.scrollWidth, clientHeight: s.clientHeight, clientWidth: s.clientWidth }; }
      scrollTo(x, y) { const s = this._v.lp || this.cm.scrollDOM; if (x != null) s.scrollLeft = x; if (y != null) s.scrollTop = y; }
      scrollIntoView(range, center) {
        const r = range && range.from ? range : { from: this.getCursor("from"), to: this.getCursor("to") };
        const a = this.posToOffset(r.from), b = this.posToOffset(r.to || r.from);
        this.cm.dispatch({ effects: V.EditorView.scrollIntoView(S.EditorSelection.range(a, b), { y: center ? "center" : "nearest" }) });
      }
      /* EditorTransaction: {replaceSelection?, changes?: EditorChange[], selection?, selections?} -> ONE dispatch */
      transaction(tx, origin) {
        if (!tx) return;
        const ue = origin ? String(origin) : undefined;
        const sels = tx.selections || (tx.selection ? [tx.selection] : null);
        // selections are read in the coordinates of the doc they apply to: AFTER the changes
        const selOf = () => S.EditorSelection.create(sels.map(s => S.EditorSelection.range(this.posToOffset(s.from), this.posToOffset(s.to || s.from))), 0);
        if (tx.changes && tx.changes.length) {
          const ch = tx.changes.map(c => { const a = this.posToOffset(c.from), b = c.to ? this.posToOffset(c.to) : a; return { from: Math.min(a, b), to: Math.max(a, b), insert: String(c.text == null ? "" : c.text) }; });
          this.cm.dispatch({ changes: ch, userEvent: ue });
        }
        if (sels && sels.length) this.cm.dispatch({ selection: selOf() });
        if (tx.replaceSelection != null) this.replaceSelection(tx.replaceSelection, origin);   // replaces the selections just set (or the current ones)
      }
      undo() { if (C) C.undo(this.cm); }
      redo() { if (C) C.redo(this.cm); }
      exec(cmd) {
        const map = {
          goUp: "cursorLineUp", goDown: "cursorLineDown", goLeft: "cursorCharLeft", goRight: "cursorCharRight",
          goStart: "cursorDocStart", goEnd: "cursorDocEnd", goWordLeft: "cursorGroupLeft", goWordRight: "cursorGroupRight",
          indentMore: "indentMore", indentLess: "indentLess", newlineAndIndent: "insertNewlineAndIndent",
          swapLineUp: "moveLineUp", swapLineDown: "moveLineDown", deleteLine: "deleteLine",
          undo: "undo", redo: "redo", selectAll: "selectAll",
        };
        const f = C && C[map[cmd]];
        if (typeof f === "function") f(this.cm);
      }
      processLines(read, write, ignoreEmpty) {
        const d = this._d, ch = [];
        for (let i = 0; i < d.lines; i++) {
          const l = d.line(i + 1); if (ignoreEmpty && !l.text) continue;
          const st = read(i, l.text), r = write(i, l.text, st);
          if (r) ch.push({ from: this.posToOffset(r.from), to: r.to ? this.posToOffset(r.to) : this.posToOffset(r.from), insert: String(r.text) });
        }
        if (ch.length) this.cm.dispatch({ changes: ch });
      }
    }
    const edOf = new WeakMap();   // tab view -> Editor
    const editorFor = v => { if (!v || !v.cm) return null; let e = edOf.get(v); if (!e) { e = new Editor(v); edOf.set(v, e); } return e; };

    /* ---------------------------------------------------------- MarkdownView
       One per tab view (v): .editor drives v.cm, .file is that tab's note.
       Extends api.js's TextFileView (or plugin-views' FileView once it lands). */
    const Base = ctx.TextFileView || ctx.FileView || class { constructor(leaf) { this.leaf = leaf; } };
    const tabOf = v => (v && v.tab && !v.tab.kind ? v.tab : null);
    class MarkdownView extends Base {
      constructor(leaf, v) {
        super(leaf);
        Object.defineProperty(this, "_tv", { value: v || null, writable: true });
        if (v) {
          const self = this;
          Object.defineProperty(this, "file", { configurable: true, enumerable: true, get() { const t = tabOf(self._tv); return t ? ctx.fileOf(t.name) : null; }, set() {} });
          Object.defineProperty(this, "containerEl", { configurable: true, enumerable: true, get() { const g = self._tv.g; return (g && g.pane) || self._tv.lp; }, set() {} });
          Object.defineProperty(this, "contentEl", { configurable: true, enumerable: true, get() { const g = self._tv.g; return (g && g.content) || self._tv.lp; }, set() {} });
          Object.defineProperty(this, "leaf", { configurable: true, enumerable: true, get() { return ctx.leafFor(self._tv.g) || leaf; }, set() {} });
        }
        this.previewMode = {
          containerEl: v ? v.preview : null,
          rerender() {}, getScroll: () => (v && v.preview ? v.preview.scrollTop : 0), applyScroll(y) { if (v && v.preview) v.preview.scrollTop = y; },
          get: () => (v && v.cm ? v.cm.state.doc.toString() : ""), set() {}, clear() {},
        };
      }
      getViewType() { return "markdown"; }
      getDisplayText() { const f = this.file; return f ? f.basename : ""; }
      getIcon() { return "document"; }
      get editor() { return editorFor(this._tv); }
      get sourceMode() { return { cmEditor: this.editor }; }
      get currentMode() { return this.getMode() === "preview" ? this.previewMode : this.editMode; }
      get editMode() { return { editor: this.editor, sourceMode: !!(this._tv && this._tv.lp && this._tv.lp.classList.contains("src")) }; }
      getMode() { const t = tabOf(this._tv); return t && t.mode === "reading" ? "preview" : "source"; }
      getViewData() { const e = this.editor; return e ? e.getValue() : ""; }
      setViewData(data, clear) {
        const e = this.editor; if (!e) return;
        if (clear && this._tv && this._tv.g && this._tv.g.view === this._tv) Ed.setText(this._tv.g, data);   // fresh state + history; setText rebuilds the plugin compartment
        else e.setValue(data);
      }
      clear() {}
      getState() { const t = tabOf(this._tv), f = this.file; return { mode: this.getMode(), source: !!(t && t.mode === "source"), file: f ? f.path : null }; }
      getEphemeralState() { const e = this.editor; return e ? { cursor: { from: e.getCursor("from"), to: e.getCursor("to") } } : {}; }
      setEphemeralState(st) { const e = this.editor; if (e && st && st.cursor) e.setSelection(st.cursor.from, st.cursor.to); }
      showSearch() {}
      requestSave() { const g = this._tv && this._tv.g; if (g && typeof scheduleSave === "function") try { scheduleSave(g); } catch (_) {} }
      save() { this.requestSave(); return Promise.resolve(); }
    }
    const mvOf = new WeakMap();   // tab view -> MarkdownView
    function viewFor(v, leaf) {
      if (!v || !tabOf(v)) return null;
      let mv = mvOf.get(v); if (!mv) { mv = new MarkdownView(leaf || ctx.leafFor(v.g), v); mvOf.set(v, mv); }
      return mv;
    }
    function allViews() {
      const out = new Set();
      for (const g of ctx.groups()) { if (g.view && g.view.cm) out.add(g.view); for (const t of g.tabs || []) if (t.view && t.view.cm) out.add(t.view); }
      return [...out];
    }
    const activeTabView = () => { const g = ctx.focused(); return g && g.active >= 0 && tabOf(g.view) ? g.view : null; };

    /* ------------------------------------------------- the info StateFields */
    const infoField = S.StateField.define({ create: () => null, update: v => v });
    const lpFx = S.StateEffect.define();
    const lpField = S.StateField.define({ create: () => true, update(v, tr) { for (const e of tr.effects) if (e.is(lpFx)) v = e.value; return v; } });
    const edField = S.StateField.define({ create: () => null, update: v => v });
    const isLp = v => !(v.lp && v.lp.classList.contains("src"));

    /* ---------------------------------------------------- registered exts */
    const exts = [];          // {ext, owner}
    const suggests = [];      // EditorSuggest instances
    let active = false;       // a plugin has loaded: views carry the base hooks
    const hasEv = n => { const w = ws(), a = w && w._ev && w._ev.get(n); return !!(a && a.length); };
    function hooks(v) {
      return [
        V.EditorView.updateListener.of(u => {
          if (u.docChanged && hasEv("editor-change")) { const mv = viewFor(v); if (mv) queueMicrotask(() => ws().trigger("editor-change", mv.editor, mv)); }
          if (suggests.length && (u.docChanged || u.selectionSet)) queueMicrotask(() => suggestCheck(v, u.docChanged));
        }),
        V.EditorView.domEventHandlers({
          paste: e => { const mv = viewFor(v); if (mv && hasEv("editor-paste")) ws().trigger("editor-paste", e, mv.editor, mv); return e.defaultPrevented; },
          drop: e => { const mv = viewFor(v); if (mv && hasEv("editor-drop")) ws().trigger("editor-drop", e, mv.editor, mv); return e.defaultPrevented; },
        }),
        S.Prec.highest(V.EditorView.domEventHandlers({ keydown: e => suggestKey(v, e) })),
      ];
    }
    EdG.pxExt = function (v) {
      if (!active) return [];
      const out = [infoField.init(() => viewFor(v)), lpField.init(() => isLp(v)), edField.init(() => v.cm || null), hooks(v)];
      for (const x of exts) out.push(x.ext);
      return out;
    };
    let bad = 0;
    function reconfigure(v) {
      if (!v.cm || !EdG.PX) return;
      try { v.cm.dispatch({ effects: EdG.PX.reconfigure(EdG.pxExt(v)) }); }
      catch (e) {
        // one bad extension (not an Extension, a throwing facet) must not take the editor down:
        // drop the newest one and retry once
        bad++; console.error("[plugin] editor extension rejected:", e);
        const x = exts.pop(); if (x && x.owner) console.error("[plugin] " + x.owner + ": registerEditorExtension dropped");
        try { v.cm.dispatch({ effects: EdG.PX.reconfigure(EdG.pxExt(v)) }); } catch (_) {}
      }
    }
    const reconfigureAll = () => { for (const v of allViews()) reconfigure(v); ctx.touch(); };
    function activate() { if (active) return; active = true; reconfigureAll(); }
    function addExt(owner, ext) {
      const rec = { ext, owner };
      exts.push(rec); activate(); reconfigureAll();
      return () => { const i = exts.indexOf(rec); if (i >= 0) { exts.splice(i, 1); reconfigureAll(); } };
    }

    /* ------------------------------------------------------- EditorSuggest
       onTrigger(cursor, editor, file) -> {start, end, query} | null after a doc change;
       getSuggestions(ctx) (sync or Promise) -> renderSuggestion(item, el) into a popup
       drawn with the wikilink autocomplete's .ac styling; ArrowUp/Down, Enter/Tab
       choose, Escape closes (keydown at Prec.highest, ahead of Ed.onKey). */
    class PopoverSuggest {
      constructor(app_) { this.app = app_; this.isOpen = false; this.suggestEl = document.createElement("div"); this.suggestEl.className = "ac os-esug suggestion-container"; this.suggestEl.hidden = true; this._items = []; this._sel = 0; }
      open() { this.isOpen = true; this.suggestEl.hidden = false; }
      close() { this.isOpen = false; this.suggestEl.hidden = true; this.suggestEl.textContent = ""; this._items = []; ctx.touch(); }
      renderSuggestion() {} selectSuggestion() {}
    }
    class EditorSuggest extends PopoverSuggest {
      constructor(app_) { super(app_); this.context = null; this.limit = 100; this.instructions = []; }
      setInstructions(i) { this.instructions = i || []; }
      onTrigger() { return null; }
      getSuggestions() { return []; }
      close() { super.close(); this.context = null; }
    }
    let openS = null, reqN = 0;
    function draw(s, v) {
      const el = s.suggestEl, g = v.g;
      el.textContent = "";
      s._items.forEach((it, i) => {
        const d = document.createElement("div");
        d.className = "suggestion-item" + (i === s._sel ? " sel is-selected" : "");
        try { s.renderSuggestion(it, d); } catch (e) { console.error("[plugin] renderSuggestion:", e); }
        d.addEventListener("mousedown", e => { e.preventDefault(); choose(s, i, e); });
        el.appendChild(d);
      });
      if (el.parentNode !== g.content) g.content.appendChild(el);
      const xy = EdG.caretXY(g);
      el.style.left = Math.max(0, Math.min(xy[0], g.content.clientWidth - 200)) + "px";
      el.style.top = Math.min(xy[1], Math.max(0, g.content.clientHeight - 60)) + "px";
      s.open(); ctx.touch();
    }
    function choose(s, i, e) {
      const it = s._items[i]; if (it === undefined) return;
      try { s.selectSuggestion(it, e || new KeyboardEvent("keydown")); } catch (er) { console.error("[plugin] selectSuggestion:", er); }
      s.close(); if (openS === s) openS = null;
    }
    function suggestCheck(v, docChanged) {
      const g = v.g;
      if (!g || g.view !== v || !v.cm || !v.cm.hasFocus) { if (openS) { openS.close(); openS = null; } return; }
      const ed = editorFor(v), mv = viewFor(v), cur = ed.getCursor("head"), file = mv ? mv.file : null;
      if (!docChanged) {   // a caret move outside the trigger range closes it
        if (openS && openS.context) { const c = openS.context, o = ed.posToOffset(cur); if (o < ed.posToOffset(c.start) || o > ed.posToOffset(c.end)) { openS.close(); openS = null; } }
        return;
      }
      for (const s of suggests) {
        let t = null;
        try { t = s.onTrigger(cur, ed, file); } catch (e) { console.error("[plugin] onTrigger:", e); }
        if (!t) continue;
        if (openS && openS !== s) openS.close();
        openS = s; s.context = Object.assign({}, t, { editor: ed, file });
        const n = ++reqN;
        Promise.resolve().then(() => s.getSuggestions(s.context)).then(items => {
          if (n !== reqN || openS !== s) return;
          s._items = (items || []).slice(0, s.limit || 100); s._sel = 0;
          if (!s._items.length) { s.close(); openS = null; return; }
          draw(s, v);
        }).catch(e => console.error("[plugin] getSuggestions:", e));
        return;
      }
      if (openS) { openS.close(); openS = null; }
    }
    function suggestKey(v, e) {
      const s = openS; if (!s || !s.isOpen || !s._items.length) return false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { s._sel = (s._sel + (e.key === "ArrowDown" ? 1 : s._items.length - 1)) % s._items.length; draw(s, v); }
      else if (e.key === "Enter" || e.key === "Tab") choose(s, s._sel, e);
      else if (e.key === "Escape") { s.close(); openS = null; }
      else return false;
      e.preventDefault(); e.stopPropagation(); return true;
    }
    function addSuggest(s) {
      if (!s) return () => {};
      suggests.push(s); activate();
      return () => { const i = suggests.indexOf(s); if (i >= 0) suggests.splice(i, 1); if (openS === s) { s.close(); openS = null; } s.suggestEl.remove(); };
    }

    /* ------------------------------------------- live-preview flag follows the mode */
    function tick() {
      if (!active) return;
      const v = activeTabView(); if (!v || !v.cm) return;
      const f = v.cm.state.field(lpField, false);
      if (f !== undefined && f !== isLp(v)) v.cm.dispatch({ effects: lpFx.of(isLp(v)) });
    }
    // [pext:x<exts>,s<suggests>,v<views carrying the base hooks>,d=<value><count>+... of the [data-os-probe]
    // nodes drawn in the focused editor (a gate probe tags its decorations with it; "0" = none),o<suggest items open>]
    function tok() {
      if (!active) return "";
      const v = activeTabView(), m = {}; let nv = 0;
      for (const w of allViews()) if (w.cm.state.field(infoField, false) !== undefined) nv++;
      if (v && v.cm) for (const n of v.cm.contentDOM.querySelectorAll("[data-os-probe]")) { const k = String(n.getAttribute("data-os-probe")).replace(/[^A-Za-z0-9]/g, "").slice(0, 8); m[k] = (m[k] || 0) + 1; }
      const d = Object.keys(m).sort().map(k => k + m[k]).join("+") || "0";
      return " [pext:x" + exts.length + ",s" + suggests.length + ",v" + nv + ",d=" + d + ",o" + (openS && openS.isOpen ? openS._items.length : 0) + (bad ? ",bad" + bad : "") + "]";
    }

    return {
      Editor, MarkdownView, EditorSuggest, PopoverSuggest,
      editorInfoField: infoField, editorViewField: infoField, editorLivePreviewField: lpField, editorEditorField: edField,
      viewFor, editorFor, activeTabView, addExt, addSuggest, activate, reconfigureAll, tick, tok,
      activeEditor() { const v = activeTabView(), mv = v && viewFor(v); return mv ? mv : null; },
    };
  }
  Object.defineProperty(window, "__osEditorApi", { value: install, configurable: true, writable: false, enumerable: false });
})();
