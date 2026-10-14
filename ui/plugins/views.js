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
        if (leaf._side) return sideOpen(leaf, type, state, active);
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

      /* sidebars — item 3 fills these in (getRightLeaf / getLeftLeaf) */
      const sides = [];                 // side records {leaf, view, type, pid, side, opened}
      const sideRecs = () => sides;
      const sideRec = leaf => sides.find(s => s.leaf === leaf) || null;
      function sideSync() {}
      function sideRegistered() {}
      async function sideOpen(leaf, type, state, active) {   // until item 3: a tab in the focused group
        const n = new WorkspaceLeaf(d.app()); n._g = M().fg(); n._nt = true;
        leaf._side = null;
        await openTyped(n, type, state, active);
        if (n._t) { leaf._t = n._t; tabLeaf.set(n._t, leaf); }
      }
      async function sideReveal() {}
      async function sideDetach() {}
      function getSideLeaf(side) { const l = new WorkspaceLeaf(d.app()); l._side = side; return l; }

      // [pview:<n types>|<type>@<where><+ shown|- hidden>,...] — where: t<pane index> main-area tab, r / l sidebar
      function censusTok() {
        if (!types.size && !recs.size && !sides.length) return "";
        const gs = M().groups(), cs = s => String(s).replace(/[[\]|,@+\s-]+/g, "_").slice(0, 40);
        const one = r => cs(r.type) + "@" + (r.side ? r.side[0] : "t" + gs.indexOf(groupOfTab(r.t))) + (r.view.containerEl.isConnected && !r.view.containerEl.hidden && r.view.containerEl.getClientRects().length ? "+" : "-");
        return " [pview:" + types.size + "|" + [...recs.values(), ...sides].map(one).join(",") + "]";
      }
      const host = { PV, sweep, censusTok, registerView, unregisterView, leavesOfType, iterateLeaves, getLeaf, getSideLeaf,
                     reveal, leafOfGroup, leafOfTab, isPvTab, recs, types };
      return { View, ItemView, FileView, EditableFileView, TextFileView, WorkspaceLeaf, host };
    },
  });
})();
