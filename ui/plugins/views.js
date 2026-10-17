// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* plugin-views (recon T-b): Obsidian's View / ItemView / FileView /
   WorkspaceLeaf, written from the public obsidian-api typings (obsidian.d.ts)
   and plugin source only (clean room).

   Load order (index.html): loader.js -> views.js -> api.js -> main.js.
   This file runs NO code at load beyond defining one factory,
   window.__osPluginViews(deps), which api.js calls ONCE while it builds the
   "obsidian" module and then deletes, so no plugin can reach it. Everything
   these classes need from the plugin host (Component, Events, the DOM helpers,
   the vault model, main.js's tab groups) comes in through `deps`, read at
   CALL time — the same rule api.js keeps with main.js. */
(function () {
  "use strict";
  Object.defineProperty(window, "__osPluginViews", {
    configurable: true, enumerable: false, writable: false,
    value: function viewsFactory(d) {
      const { Component, Events, installDom, mk, setIcon } = d;

      class View extends Component {
        constructor(leaf) {
          super(); installDom();
          this.leaf = leaf; this.app = leaf && leaf.app;
          this.containerEl = mk("div", { cls: "workspace-leaf-content" });
          this.navigation = false; this.icon = "";
          this.scope = null;
        }
        getViewType() { return ""; }
        getDisplayText() { return ""; }
        getIcon() { return this.icon; }
        getState() { return {}; }
        setState() { return Promise.resolve(); }
        getEphemeralState() { return {}; }
        setEphemeralState() {}
        onOpen() { return Promise.resolve(); }
        onClose() { return Promise.resolve(); }
        onResize() {}
        onPaneMenu() {}
        onHeaderMenu() {}
      }
      /* Obsidian's leaf DOM: .workspace-leaf-content > .view-header + .view-content.
         The app's tab strip is the header here, so .view-header only shows once
         the view adds an action (addAction) — its buttons have nowhere else to go. */
      class ItemView extends View {
        constructor(leaf) {
          super(leaf);
          this.headerEl = this.containerEl.createDiv({ cls: "view-header" });
          this.headerEl.hidden = true;
          this.titleEl = this.headerEl.createDiv({ cls: "view-header-title" });
          this.actionsEl = this.headerEl.createDiv({ cls: "view-actions" });
          this.contentEl = this.containerEl.createDiv({ cls: "view-content" });
        }
        addAction(icon, title, cb) {
          const b = mk("a", { cls: "clickable-icon view-action", attr: { "aria-label": title, title } });
          setIcon(b, icon);
          this.actionsEl.prepend(b);
          this.headerEl.hidden = false;
          this.registerDomEvent(b, "click", e => { try { cb(e); } catch (er) { console.error("[plugin] view action:", er); } });
          return b;
        }
      }
      class FileView extends ItemView {
        constructor(leaf) { super(leaf); this.file = null; this.allowNoFile = false; this.navigation = true; }
        getDisplayText() { return this.file ? this.file.basename : "No file"; }
        getState() { return this.file ? { file: this.file.path } : {}; }
        async setState(state) {
          const p = state && state.file, f = p && d.vault().getAbstractFileByPath(p);
          if (!(f instanceof d.TFile()) || f === this.file) return;
          if (this.file) try { await this.onUnloadFile(this.file); } catch (e) { console.error(e); }
          this.file = f;
          try { await this.onLoadFile(f); } catch (e) { console.error(e); }
        }
        onLoadFile() { return Promise.resolve(); }
        onUnloadFile() { return Promise.resolve(); }
        onRename() { return Promise.resolve(); }
        canAcceptExtension(ext) { return ext === "md"; }
      }
      class EditableFileView extends FileView {}
      class TextFileView extends EditableFileView { constructor(leaf) { super(leaf); this.data = ""; } }


      /* ------------------------------------------------ the view host
         A plugin view in the MAIN area is a tab of kind "unk" (main.js W4: a
         leaf type the app has no view of its own for) whose utype is a
         registered view type. main.js asks PVHOST.mount(g, t) when such a tab
         becomes active; the tab's raw leaf (t.raw) is what workspace.json
         persists, so a plugin view survives a restart and comes back live when
         its plugin registers the type again. Each live tab has a record
         {t, leaf, view, type, pid}; the view is loaded and opened once, its
         containerEl lives in the group's .content and is shown/hidden. */
      const types = new Map();          // view type -> {factory, pid}
      const recs = new Map();           // tab object -> record
      const tabLeaf = new WeakMap();    // tab object -> WorkspaceLeaf (identity)
      const M = () => ({                // main.js top-level names, read at call time
        groups: typeof groups === "function" ? groups : () => [],
        fg: typeof fg === "function" ? fg : () => null,
      });
      const activeTab = g => (g && g.active >= 0 ? g.tabs[g.active] : null);
      const groupOfTab = t => { for (const g of M().groups()) if (g.tabs.indexOf(t) >= 0) return g; return null; };
      const isPvTab = t => !!t && t.kind === "unk" && types.has(t.utype);
      const newId = () => { try { if (typeof wsId === "function") return wsId(); } catch (_) {} let s = ""; for (let i = 0; i < 16; i++) s += "0123456789abcdef"[Math.random() * 16 | 0]; return s; };
      const safe = (what, f) => { try { const r = f(); if (r && typeof r.catch === "function") r.catch(e => console.error("[plugin] " + what + ":", e)); return r; } catch (e) { console.error("[plugin] " + what + ":", e); } };
      function leafOfTab(t) { let l = tabLeaf.get(t); if (!l) { l = new WorkspaceLeaf(d.app()); l._t = t; tabLeaf.set(t, l); } return l; }
      function syncTab(r) {             // the tab's label + persisted raw leaf follow the view
        const t = r.t, v = r.view;
        let st = {}; try { st = v.getState() || {}; } catch (_) {}
        let title = ""; try { title = String(v.getDisplayText() || ""); } catch (_) {}
        let icon = ""; try { icon = String(v.getIcon() || ""); } catch (_) {}
        if (!t.lid) t.lid = (t.raw && t.raw.id) || newId();
        const raw = { id: t.lid, type: "leaf", state: { type: r.type, state: JSON.parse(JSON.stringify(st)), icon: icon || undefined, title: title || r.type } };
        if (t.raw && t.raw.group) raw.group = t.raw.group;
        t.raw = raw;
        const name = title || r.type;
        if (t.name !== name) { t.name = name; const g = groupOfTab(t); if (g && typeof renderTabs === "function") try { renderTabs(g); } catch (_) {} }
      }
      function makeView(t, type, state) {   // instantiate + load + onOpen, once per tab
        const ty = types.get(type); if (!ty) return null;
        const leaf = leafOfTab(t);
        let view;
        try { view = ty.factory(leaf); } catch (e) { console.error("[plugin] view factory " + type + ":", e); return null; }
        if (!view) return null;
        const r = { t, leaf, view, type, pid: ty.pid, opened: null };
        recs.set(t, r);
        view.containerEl.classList.add("os-pv");
        view.containerEl.dataset.type = type;
        view.containerEl.hidden = true;
        safe("view load " + type, () => view.load());
        r.opened = (async () => {
          try { await view.onOpen(); } catch (e) { console.error("[plugin] view onOpen " + type + ":", e); }
          if (state && Object.keys(state).length) try { await view.setState(state, {}); } catch (e) { console.error("[plugin] view setState " + type + ":", e); }
          syncTab(r); d.touch();
        })();
        syncTab(r);
        return r;
      }
      function closeRec(r) {
        recs.delete(r.t);
        r.view.containerEl.remove();
        safe("view onClose " + r.type, () => r.view.onClose());
        safe("view unload " + r.type, () => r.view.unload());
        d.touch();
      }
      const PV = {
        mount(g, t) {                   // main.js loadActive: t (active, kind unk) -> true if a plugin view shows it
          if (!isPvTab(t)) return false;
          let r = recs.get(t);
          if (!r) { const st = t.raw && t.raw.state; r = makeView(t, t.utype, st && st.state); if (!r) return false; }
          const ce = r.view.containerEl;
          if (ce.parentNode !== g.content) g.content.appendChild(ce);
          for (const x of g.content.querySelectorAll(":scope > .os-pv")) x.hidden = x !== ce;
          ce.hidden = false;
          d.touch();
          return true;
        },
        hide(g, t) {                    // main.js loadActive: whatever g shows next, other plugin views go
          if (!g || !g.content || !recs.size) return;
          const keep = recs.get(t);
          for (const x of g.content.querySelectorAll(":scope > .os-pv")) if (!keep || x !== keep.view.containerEl) x.hidden = true;
        },
        sideHide(side) { sideHide(side); },        // main.js setRTab / setPane: a built-in sidebar tab shows
        sideShowing(side) { return sideShowing(side); },   // main.js cmdToggleRight: a plugin pane is what reopens
      };
      function sweep() {                // a tab closed / collapsed by the app: its view closes
        if (!recs.size) return;
        const live = new Set();
        for (const g of M().groups()) for (const t of g.tabs) live.add(t);
        for (const [t, r] of [...recs]) if (!live.has(t) && !r.side) closeRec(r);
      }
      async function openTabView(g, t, at, active) {   // insert t into g at `at` (no splice: tabclose census)
        if (typeof flushSave === "function") try { await flushSave(g); } catch (_) {}
        g.tabs.push(t);
        if (at < g.tabs.length - 1) { g.tabs.copyWithin(at + 1, at); g.tabs[at] = t; }
        if (active !== false || g.active < 0) { g.active = g.tabs.indexOf(t); if (typeof focusGroup === "function") try { focusGroup(g); } catch (_) {} if (typeof loadActive === "function") await loadActive(g); }
        else if (typeof renderTabs === "function") renderTabs(g);
      }
      async function closeTabOf(t) {
        const g = groupOfTab(t); if (!g) { const r = recs.get(t); if (r) closeRec(r); return; }
        const i = g.tabs.indexOf(t);
        if (typeof closeTab === "function") await closeTab(g, i, "plugin-detach", "plugin");
        const r = recs.get(t); if (r) closeRec(r);
      }
      const pvTab = (type, name) => ({ kind: "unk", name: name || type, utype: type, raw: null, lid: newId(), mode: "source", hist: [], hpos: -1 });

      /* A leaf. Three shapes (hidden fields, never enumerable):
           group leaf  _g    one of the app's tab groups (M1: its active tab is the view)
           tab leaf    _t    one plugin-view tab (identity per tab: leafOfTab)
           pending     _g + _nt (new tab) | _split ("row"|"col"): getLeaf(true|'tab'|'split')
                       — becomes a tab leaf on its first setViewState of a plugin type
           side leaf   _side "right"|"left" (getRightLeaf/getLeftLeaf) */
      class WorkspaceLeaf extends Events {
        constructor(app) {
          super(); this.app = app;
          for (const k of ["_g", "_v", "_t", "_split", "_side"]) Object.defineProperty(this, k, { value: null, writable: true });
          Object.defineProperty(this, "_nt", { value: false, writable: true });
        }
        get _grp() { return this._t ? groupOfTab(this._t) : this._g; }
        get view() {
          const r = this._t ? recs.get(this._t) : sideRec(this);
          if (r) return r.view;
          if (this._t || this._side) return emptyView(this);
          const t = activeTab(this._g), ra = isPvTab(t) && recs.get(t);
          return ra ? ra.view : d.leafView(this);
        }
        get containerEl() { return this.view.containerEl; }
        get parent() { return null; }
        getViewState() {
          const r = this._t ? recs.get(this._t) : sideRec(this);
          if (r) { let st = {}; try { st = r.view.getState() || {}; } catch (_) {} return { type: r.type, state: st }; }
          if (this._t) { const s = this._t.raw && this._t.raw.state; return { type: this._t.utype, state: (s && s.state) || {} }; }
          if (this._side) return { type: "empty", state: {} };
          const t = activeTab(this._g), ra = isPvTab(t) && recs.get(t);
          if (ra) return leafOfTab(t).getViewState();
          const f = d.groupFile(this._g); return f ? { type: "markdown", state: { file: f.path } } : { type: "empty", state: {} };
        }
        async setViewState(vs, eState) {
          const type = vs && vs.type;
          if (type && types.has(type)) return openTyped(this, type, (vs && vs.state) || {}, vs.active);
          if (this._side && (type === "empty" || !type)) return;
          const p = vs && vs.state && vs.state.file; const f = p && d.vault().getAbstractFileByPath(p);
          if (!(f instanceof d.TFile())) return;
          return this.openFile(f, { state: vs.state, eState, active: vs.active });
        }
        openFile(file, openState) {
          if (this._t || this._side) {   // a plugin leaf asked to show a note: a new tab in its group (or the focused one)
            const n = new WorkspaceLeaf(this.app); n._g = this._grp || M().fg(); n._nt = true;
            return d.openFileIn(n, file, openState);
          }
          return d.openFileIn(this, file, openState);
        }
        getDisplayText() { const v = this.view; try { const s = v && v.getDisplayText(); if (s) return s; } catch (_) {} const f = !this._t && d.groupFile(this._g); return f ? f.basename : ""; }
        getIcon() { const v = this.view; try { const s = v && v.getIcon(); if (s) return s; } catch (_) {} return "file"; }
        updateHeader() { const r = this._t ? recs.get(this._t) : sideRec(this); if (r) { if (r.t) syncTab(r); else sideSync(r); } }
        setPinned(p) { if (this._t) { this._t.pinned = !!p; const g = this._grp; if (g && typeof renderTabs === "function") renderTabs(g); } }
        togglePinned() { if (this._t) this.setPinned(!this._t.pinned); }
        get pinned() { return !!(this._t && this._t.pinned); }
        setGroup() {} setGroupMember() {}
        detach() { if (this._t) return closeTabOf(this._t); if (this._side) return sideDetach(this); }
        getEphemeralState() { const v = this.view; try { return (v && v.getEphemeralState && v.getEphemeralState()) || {}; } catch (_) { return {}; } }
        setEphemeralState(s) { const v = this.view; try { if (v && v.setEphemeralState) v.setEphemeralState(s); } catch (_) {} }
        loadIfDeferred() { return Promise.resolve(); }
        get isDeferred() { return false; }
        onResize() { const v = this.view; try { if (v && v.onResize) v.onResize(); } catch (_) {} }
      }
      const emptyOf = new WeakMap();
      function emptyView(leaf) { let v = emptyOf.get(leaf); if (!v) { v = new View(leaf); v.getViewType = () => (leaf._t ? leaf._t.utype : "empty"); emptyOf.set(leaf, v); } return v; }

      async function openTyped(leaf, type, state, active) {
        if (leaf._side) return sideOpenView(leaf, type, state, active);
        if (leaf._t) {                  // a tab leaf: same type -> new state; other type -> a new view in the same tab
          const t = leaf._t, g = groupOfTab(t);
          let r = recs.get(t);
          if (r && r.type === type) { await r.opened; try { await r.view.setState(state, {}); } catch (e) { console.error(e); } syncTab(r); }
          else {
            if (r) closeRec(r);
            t.utype = type; r = makeView(t, type, state); if (!r) return;
            if (g && activeTab(g) === t && typeof loadActive === "function") await loadActive(g);
            await r.opened;
          }
          if (active && g) await reveal(leaf);
          return;
        }
        const g = leaf._g || M().fg(); if (!g) return;
        const t = pvTab(type);
        if (leaf._nt || leaf._split) { leaf._t = t; leaf._nt = false; tabLeaf.set(t, leaf); }
        const r = makeView(t, type, state); if (!r) return;
        const split = leaf._split; leaf._split = null;
        if (split && typeof splitWith === "function") await splitWith(g, split, t);
        else await openTabView(g, t, g.active >= 0 ? g.active + 1 : g.tabs.length, true);
        await r.opened;
        d.touch();
      }
      async function reveal(leaf) {
        if (leaf._side) return sideReveal(leaf);
        const g = leaf._grp; if (!g) return;
        if (typeof focusGroup === "function") try { focusGroup(g); } catch (_) {}
        if (leaf._t) { const i = g.tabs.indexOf(leaf._t); if (i >= 0 && i !== g.active && typeof switchTab === "function") await switchTab(g, i); }
        d.touch();
      }
      function leafOfGroup(g, groupLeaf) {   // what Obsidian calls the group's leaf: the ACTIVE tab's
        const t = activeTab(g);
        return isPvTab(t) ? leafOfTab(t) : groupLeaf(g);
      }
      function leavesOfType(type) {
        const out = [];
        for (const g of M().groups()) for (const t of g.tabs) if (t.kind === "unk" && t.utype === type) out.push(leafOfTab(t));
        for (const s of sideRecs()) if (s.type === type) out.push(s.leaf);
        return out;
      }
      function iterateLeaves(cb, groupLeaf, withSide) {
        for (const g of M().groups()) {
          let note = false;
          for (const t of g.tabs) {
            if (t.kind === "unk") { if (cb(leafOfTab(t)) === true) return true; }
            else if (!note) { note = true; if (cb(groupLeaf(g)) === true) return true; }
          }
          if (!g.tabs.length && cb(groupLeaf(g)) === true) return true;
        }
        if (withSide) for (const s of sideRecs()) if (cb(s.leaf) === true) return true;
        return false;
      }
      function getLeaf(newLeaf, dir) {
        const g = M().fg();
        if (!g) return null;
        if (!newLeaf) return null;      // caller (api.js) answers false with the active leaf
        const n = new WorkspaceLeaf(d.app()); n._g = g;
        if (newLeaf === "split") n._split = dir === "horizontal" ? "col" : "row";   // Obsidian's word is the opposite of ours
        else n._nt = true;               // true | "tab" | "window" (no windows here: a tab)
        return n;
      }
      function registerView(pid, type, factory) {
        type = String(type);
        if (types.has(type)) throw new Error("View type \"" + type + "\" is already registered");
        types.set(type, { factory, pid });
        // tabs restored from workspace.json (kind unk) of this type come alive; a SHOWING one re-mounts now
        for (const g of M().groups()) { const t = activeTab(g); if (t && t.kind === "unk" && t.utype === type && typeof loadActive === "function") safe("remount " + type, () => loadActive(g)); }
        sideRegistered(type);
        d.touch();
      }
      async function unregisterView(type) {   // plugin unload: its views go (Obsidian detaches them)
        if (!types.has(type)) return;
        const leaves = leavesOfType(type);
        for (const l of leaves) { try { await l.detach(); } catch (e) { console.error(e); } }
        types.delete(type);
        for (const [t, r] of [...recs]) if (r.type === type) closeRec(r);
        d.touch();
      }

      /* sidebars (getRightLeaf / getLeftLeaf): a plugin view gets its own icon
         button in the sidebar's strip (#rtabs before #rtoggle / #stabs) and its
         own .spane in #rside / #side. Showing it hides the built-in panes; a
         built-in tab click (setRTab / setPane) calls PV.sideHide(side) back.
         Side views are NOT persisted in workspace.json: plugins re-create them
         on onLayoutReady (Obsidian plugins all do: ensureSideLeaf / getRightLeaf). */
      const sides = [];                 // side records {leaf, view, type, pid, side, opened, btn, pane}
      const sideRecs = () => sides;
      const sideRec = leaf => sides.find(s => s.leaf === leaf) || null;
      const SIDE = {
        right: { strip: "rtabs", host: "rside", before: "rtoggle", ids: ["rpane-bl", "rpane-out", "rpane-tags", "rpane-toc"], tab: "rtab-" },
        left:  { strip: "stabs", host: "side", before: null, ids: ["pane-files", "pane-search", "pane-bm"], tab: "stab-" },
      };
      const byId = id => document.getElementById(id);
      function sideSync(r) {            // the strip button's icon + tooltip follow the view
        let title = ""; try { title = String(r.view.getDisplayText() || ""); } catch (_) {}
        let icon = ""; try { icon = String(r.view.getIcon() || ""); } catch (_) {}
        r.btn.title = title || r.type; r.btn.setAttribute("aria-label", r.btn.title);
        if (r.icon !== icon) { r.icon = icon; r.btn.textContent = ""; try { setIcon(r.btn, icon || "box"); } catch (_) {} }
      }
      function sideShowing(side) { return sides.some(s => s.side === side && !s.pane.hidden); }
      function sideHide(side) {         // a built-in tab shows: every plugin pane of that side hides
        if (!sides.length) return;
        for (const s of sides) if (s.side === side) { s.pane.hidden = true; s.btn.classList.remove("active"); }
        d.touch();
      }
      function sideShow(r) {
        const c = SIDE[r.side];
        for (const id of c.ids) { const p = byId(id); if (p) p.hidden = true; }
        for (const b of document.querySelectorAll("#" + c.strip + " > .stab")) if (b !== r.btn) b.classList.remove("active");
        for (const s of sides) if (s.side === r.side && s !== r) s.pane.hidden = true;
        r.pane.hidden = false; r.btn.classList.add("active");
        safe("view onResize " + r.type, () => r.view.onResize());
        if (typeof updateTitle === "function") try { updateTitle(); } catch (_) {}
        d.touch();
      }
      function sideMount(leaf, type, state) {
        const ty = types.get(type); if (!ty) return null;
        const c = SIDE[leaf._side], strip = byId(c.strip), host = byId(c.host);
        if (!strip || !host) return null;
        let view;
        try { view = ty.factory(leaf); } catch (e) { console.error("[plugin] view factory " + type + ":", e); return null; }
        if (!view) return null;
        const btn = mk("button", { cls: "stab os-pv-tab" });
        btn.dataset.type = type;
        const pane = mk("div", { cls: "spane os-pv-pane" });
        pane.dataset.type = type; pane.hidden = true;
        view.containerEl.classList.add("os-pv");
        view.containerEl.dataset.type = type;
        pane.appendChild(view.containerEl);
        const before = c.before ? byId(c.before) : null;
        if (before && before.parentNode === strip) strip.insertBefore(btn, before); else strip.appendChild(btn);
        const vs = byId("vswitch");
        if (leaf._side === "left" && vs && vs.parentNode === host) host.insertBefore(pane, vs); else host.appendChild(pane);
        const r = { leaf, view, type, pid: ty.pid, side: leaf._side, opened: null, btn, pane, icon: null };
        sides.push(r);
        btn.onclick = () => sideShow(r);
        safe("view load " + type, () => view.load());
        r.opened = (async () => {
          try { await view.onOpen(); } catch (e) { console.error("[plugin] view onOpen " + type + ":", e); }
          if (state && Object.keys(state).length) try { await view.setState(state, {}); } catch (e) { console.error("[plugin] view setState " + type + ":", e); }
          sideSync(r); d.touch();
        })();
        sideSync(r);
        return r;
      }
      function sideClose(r) {
        const i = sides.indexOf(r); if (i < 0) return;
        sides.splice(i, 1);
        const wasShown = !r.pane.hidden;
        r.btn.remove(); r.pane.remove();
        safe("view onClose " + r.type, () => r.view.onClose());
        safe("view unload " + r.type, () => r.view.unload());
        if (wasShown) {                 // the strip falls back to the built-in tab the app had
          if (r.side === "right" && typeof setRTab === "function") safe("rtab", () => setRTab(typeof rTab === "string" ? rTab : "bl", false));
          else if (r.side === "left" && typeof setPane === "function") safe("ltab", () => setPane(typeof sidePane === "string" ? sidePane : "files"));
        }
        if (typeof updateTitle === "function") try { updateTitle(); } catch (_) {}
        d.touch();
      }
      function sideRegistered() {}
      async function sideOpenView(leaf, type, state, active) {
        let r = sideRec(leaf);
        if (r && r.type === type) { await r.opened; try { await r.view.setState(state, {}); } catch (e) { console.error(e); } sideSync(r); }
        else { if (r) sideClose(r); r = sideMount(leaf, type, state); if (!r) return; await r.opened; }
        if (active) await sideReveal(leaf);   // a background open stays a strip button until revealed
      }
      async function sideReveal(leaf) {
        const r = sideRec(leaf); if (!r) return;
        if (r.side === "right" && typeof rightOpen !== "undefined" && !rightOpen && typeof cmdToggleRight === "function") await cmdToggleRight();
        if (r.side === "left" && typeof sideOpen !== "undefined" && !sideOpen && typeof cmdToggleSide === "function") await cmdToggleSide();
        sideShow(r);
      }
      async function sideDetach(leaf) { const r = sideRec(leaf); if (r) sideClose(r); }
      function getSideLeaf(side) { const l = new WorkspaceLeaf(d.app()); l._side = side; return l; }

      // [pview:<n types>|<type>@<where><+ shown|- hidden>,...] — where: t<pane index> main-area tab, r / l sidebar
      function censusTok() {
        if (!types.size && !recs.size && !sides.length) return "";
        const gs = M().groups(), cs = s => String(s).replace(/[[\]|,@+\s-]+/g, "_").slice(0, 40);
        const one = r => cs(r.type) + "@" + (r.side ? r.side[0] : "t" + gs.indexOf(groupOfTab(r.t))) + (r.view.containerEl.isConnected && !r.view.containerEl.hidden && r.view.containerEl.getClientRects().length ? "+" : "-");
        return " [pview:" + types.size + "|" + [...recs.values(), ...sides].map(one).join(",") + "]";
      }
      const host = { PV, sweep, censusTok, registerView, unregisterView, leavesOfType, iterateLeaves, getLeaf, getSideLeaf,
                     reveal, leafOfGroup, leafOfTab, isPvTab, recs, types, sideHide, sideShowing };
      return { View, ItemView, FileView, EditableFileView, TextFileView, WorkspaceLeaf, host };
    },
  });
})();

/* the "obsidian" module, part WORKSPACE (api-parity stage 0: moved here from api.js,
   behaviour-neutral): the views factory is taken ONCE and removed from window, then
   app.workspace over the app's tab groups. A separate closure: it sees only what
   api.js hands it in K. Segment contract: see api-core.js. */
(function () {
  "use strict";
  const parts = window.__osApiParts || (window.__osApiParts = Object.create(null));
  const reg = (id, fn) => { if (!(id in parts)) parts[id] = fn; };
  reg("workspace:views", function (K) {
    const { host, be } = K;
    const { Component, Events, installDom, mk, setIcon, touch } = K;
    /* --------------------------------------------- views (ui/plugins/views.js)
       View / ItemView / FileView / WorkspaceLeaf live in views.js (goal
       plugin-views). Its factory is taken ONCE here and removed from window, so
       plugin code cannot reach it; its deps are read at call time. */
    const viewsFactory = window.__osPluginViews;
    try { delete window.__osPluginViews; } catch (_) {}
    if (typeof viewsFactory !== "function") { console.error("[plugin] views.js did not load"); return false; }
    const { View, ItemView, FileView, EditableFileView, TextFileView, WorkspaceLeaf, host: views } = viewsFactory({
      Component, Events, installDom, mk, setIcon, app: () => K.app, touch: () => touch(),
      vault: () => K.vault, TFile: () => K.TFile,
      leafView: l => K.leafView(l), groupFile: g => K.groupFile(g), openFileIn: (l, f, o) => K.openFileIn(l, f, o),
    });
    Object.assign(K, { EditableFileView, FileView, ItemView, TextFileView, View, WorkspaceLeaf, views });
  });
  reg("workspace:workspace", function (K) {
    const { host, be } = K;
    const { EA, Events, MarkdownView, Menu, TFile, View, WorkspaceLeaf, bridge, changed, debounce, files, normalizePath, noteOf, parseLinktext, resolveLink, touch, vault, views } = K;
    /* ------------------------------------------- workspace (item 5)
       Leaves are the app's tab groups (main.js `groups()` / `state.focused`),
       read at call time. file-open / active-leaf-change are detected by
       focusTick(), which the [plg:] census runs on every updateTitle — the one
       place main.js already reports "something on screen changed" — so this
       needs no new hook in main.js. */
    const leafOf = new WeakMap();
    const groupLeaf = g => { if (!g) return null; let l = leafOf.get(g); if (!l) { l = new WorkspaceLeaf(K.app); l._g = g; leafOf.set(g, l); } return l; };
    const leafFor = g => (g ? views.leafOfGroup(g, groupLeaf) : null);   // plugin-views: a plugin-view tab is its own leaf
    const allGroups = () => { try { return typeof groups === "function" ? groups() : []; } catch (_) { return []; } };
    const focusedGroup = () => { try { return typeof state !== "undefined" && state ? state.focused : null; } catch (_) { return null; } };
    function groupFile(g) {
      const t = g && g.active >= 0 ? g.tabs[g.active] : null;
      if (!t || t.kind || !K.st.modelOn) return null;
      const f = files.get(t.name + ".md");
      return f instanceof TFile ? f : null;
    }
    function leafView(l) {
      const f = groupFile(l._g);
      if (!l._v) {
        const mv = new MarkdownView(l); Object.defineProperty(mv, "file", { configurable: true, get: () => groupFile(l._g) });   // no editor-api: a file-only stand-in
        const ev = new View(l); ev.getViewType = () => "empty";
        l._v = { mv, ev };
      }
      if (f && EA) { const mv = EA.viewFor(l._g.view, l); if (mv) return mv; }   // editor-api: the active tab's own MarkdownView (.editor = its CM6 view)
      return f ? l._v.mv : l._v.ev;
    }
    async function openFileIn(leaf, file, openState) {
      if (!(file instanceof TFile) || file.extension !== "md") return;
      const name = noteOf(file.path), g = leaf && leaf._g;
      if (g && g !== focusedGroup() && typeof focusGroup === "function") try { focusGroup(g); } catch (_) {}
      if (leaf && leaf._split && g && typeof splitWith === "function" && typeof mkTab === "function") { const d0 = leaf._split; leaf._split = null; await splitWith(g, d0, mkTab(name)); }
      else if (leaf && leaf._nt && typeof openNewTab === "function") { leaf._nt = false; await openNewTab(name, g || undefined); }
      else if (typeof openInTab === "function") await openInTab(name);
      const sub = openState && openState.eState && openState.eState.subpath;
      if (sub && typeof navAnchor === "function") try { await navAnchor(focusedGroup(), sub.replace(/^#/, "")); } catch (_) {}
      touch();
    }
    let lastLeaf = null, lastFile;
    function focusTick() {
      views.sweep();                       // plugin-views: a plugin-view tab the app closed -> its view closes
      if (!K.st.modelOn || !K.st.layoutReady) return;
      const l = leafFor(focusedGroup()), f = l ? groupFile(l._g) : null;
      if (l !== lastLeaf) { lastLeaf = l; queueMicrotask(() => workspace.trigger("active-leaf-change", l)); }
      if (f !== lastFile) { lastFile = f; queueMicrotask(() => { workspace.trigger("file-open", f); if (l) workspace.trigger("layout-change"); }); }
    }
    const workspace = new Events();
    Object.assign(workspace, {
      layoutReady: false,
      containerEl: document.body,
      onLayoutReady(cb) { if (K.st.layoutReady) queueMicrotask(() => { try { cb(); } catch (e) { console.error(e); } }); else workspace.on("layout-ready", cb); },
      iterateAllLeaves(cb) { views.iterateLeaves(cb, groupLeaf, true); },
      iterateRootLeaves(cb) { views.iterateLeaves(cb, groupLeaf, false); },
      getLeavesOfType(t) { const pv = views.leavesOfType(t); if (pv.length || views.types.has(t)) return pv; return allGroups().map(groupLeaf).filter(l => l && l.view.getViewType() === t); },
      detachLeavesOfType(t) { for (const l of views.leavesOfType(t)) l.detach(); },
      getRightLeaf() { return views.getSideLeaf("right"); },
      getLeftLeaf() { return views.getSideLeaf("left"); },
      async ensureSideLeaf(type, side, o) {
        o = o || {}; let l = views.leavesOfType(type)[0];
        if (!l) { l = views.getSideLeaf(side === "left" ? "left" : "right"); await l.setViewState({ type, state: o.state || {}, active: !!o.active }); }
        if (o.reveal !== false) await views.reveal(l);
        return l;
      },
      getActiveViewOfType(C) { const l = workspace.activeLeaf, v = l && l.view; return v && C && v instanceof C ? v : null; },
      getActiveFile() { return groupFile(focusedGroup()); },
      getMostRecentLeaf() { return workspace.activeLeaf; },
      getUnpinnedLeaf() { return workspace.activeLeaf; },
      getLeaf(newLeaf, dir) { if (!newLeaf) return workspace.activeLeaf; return views.getLeaf(newLeaf, dir) || workspace.activeLeaf; },
      splitActiveLeaf(dir) { return workspace.getLeaf("split", dir); },
      createLeafBySplit(leaf, dir) { return workspace.getLeaf("split", dir); },
      createLeafInParent() { return workspace.getLeaf("tab"); },
      setActiveLeaf(l) { if (l && (l._t || l._side)) { views.reveal(l); return; } if (l && l._g && typeof focusGroup === "function") try { focusGroup(l._g); } catch (_) {} },
      revealLeaf(l) { if (l && (l._t || l._side)) return views.reveal(l); workspace.setActiveLeaf(l); return Promise.resolve(); },
      async openLinkText(lt, src, newLeaf, openState) {
        const { path, subpath } = parseLinktext(lt);
        let f = path ? resolveLink(path, src) : vault.getFileByPath(src || "");
        if (!f) f = await vault.create(normalizePath(path.endsWith(".md") ? path : path + ".md"), "");
        const os = Object.assign({}, openState || {}); if (subpath) os.eState = Object.assign({}, os.eState, { subpath });
        return workspace.getLeaf(newLeaf).openFile(f, os);
      },
      getLastOpenFiles() { return []; },
      updateOptions() { if (EA) EA.reconfigureAll(); },   // editor-api: a plugin mutated its registered extension array
      requestSaveLayout: debounce(() => {}, 0),
      leftRibbon: {
        collapsed: false,
        get ribbonItemsEl() { return document.getElementById("ribbon"); },
        // read-only view of plugin ribbon icons (cmdr's "Left Ribbon" tab maps it); a copy, so remove() on it can't detach app buttons
        get items() { return [...document.querySelectorAll("#ribbon .os-plugin-ribbon")].map(b => ({ id: (b.dataset.plugin || "") + ":" + b.title, title: b.title, icon: (b.firstElementChild && b.firstElementChild.dataset.icon) || "", buttonEl: b })); },
      },
      rightRibbon: { collapsed: false },
    });
    /* plugin-views item 5: workspace "file-menu" / "editor-menu". main.js builds its
       own .ctxmenu (noteMenu: the explorer row) and asks PMENU before placing it; a
       plugin's handler gets a Menu whose rows land in THAT menu after a rule, so they
       share its styling, its close-on-mousedown and its [menu:] census. Nothing is
       added — not even the rule — when no handler adds a row. "editor-menu" opens a
       menu of plugin rows only, and only once bridge.editor yields an Editor. */
    function menuHook(name, m, args) {
      const a = workspace._ev.get(name);
      if (!a || !a.length) return 0;
      const menu = new Menu(); menu.dom = m;
      workspace.trigger(name, menu, ...args);
      const it = menu.items.slice();
      while (it.length && it[0] === null) it.shift();
      while (it.length && it[it.length - 1] === null) it.pop();
      const n = it.filter(Boolean).length;
      if (!n) return 0;
      if (m.childElementCount) { const s = document.createElement("div"); s.className = "sep"; m.appendChild(s); }
      for (const x of it) {
        if (x === null) { const s = document.createElement("div"); s.className = "sep"; m.appendChild(s); }
        else m.appendChild(x.dom);
      }
      return n;
    }
    const PM = {
      fileMenu(m, name, source) {
        const f = files.get(name + ".md");
        return f instanceof TFile ? menuHook("file-menu", m, [f, source || "file-explorer-context-menu", null]) : 0;
      },
      editorMenu(e) {
        const x = bridge.editor ? bridge.editor() : null;
        if (!x || !x.editor) return false;
        const m = document.createElement("div");
        m.className = "ctxmenu menu os-plugin-menu";
        if (!menuHook("editor-menu", m, [x.editor, x.view])) return false;
        if (typeof closeMenu === "function") closeMenu();
        if (typeof placeMenu === "function") placeMenu(m, e.clientX, e.clientY);
        return true;
      },
    };
    const menuOn = workspace.on;
    workspace.on = function (name, cb, ctx) {   // main.js's PMENU is set lazily: api.js loads before main.js declares it
      if (name === "file-menu" || name === "editor-menu") try { PMENU = PM; } catch (_) {}
      return menuOn.call(this, name, cb, ctx);
    };
    Object.defineProperty(workspace, "activeLeaf", { configurable: true, enumerable: true, get() {
      const g = focusedGroup() || allGroups()[0];
      return g ? leafFor(g) : null;
    } });
    // editor-api: the focused note's MarkdownView (a MarkdownFileInfo: .editor, .file), or null
    Object.defineProperty(workspace, "activeEditor", { configurable: true, enumerable: true, get() { return EA && K.st.modelOn ? EA.activeEditor() : null; } });
    if (EA) bridge.editor = () => { const mv = K.st.modelOn ? EA.activeEditor() : null; return mv && mv.editor ? { editor: mv.editor, view: mv } : null; };
    Object.assign(K, { allGroups, focusTick, focusedGroup, groupFile, leafFor, leafView, openFileIn, workspace });
  });
})();
