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
         leaf type the app has no view of its own for) whose utype is the view's
         type. main.js asks PVHOST.mount(g, t) when such a tab becomes active;
         the tab's raw leaf (t.raw) is what workspace.json persists, so a plugin
         view survives a restart and comes back live when its plugin registers
         the type again. Each live tab has a record {t, leaf, view, type, pid};
         the view is loaded and opened once (from the registered factory, or the
         instance WorkspaceLeaf.open was handed), its containerEl lives in the
         group's .content and is shown/hidden. */
      const types = new Map();          // view type -> {factory, pid}
      const recs = new Map();           // tab object -> record
      const tabLeaf = new WeakMap();    // tab object -> WorkspaceLeaf (identity: one leaf per tab)
      const M = () => ({                // main.js top-level names, read at call time
        groups: typeof groups === "function" ? groups : () => [],
        fg: typeof fg === "function" ? fg : () => null,
      });
      const hid = (o, k, v) => Object.defineProperty(o, k, { value: v, writable: true, configurable: true });
      const byId = id => document.getElementById(id);
      const activeTab = g => (g && g.active >= 0 ? g.tabs[g.active] : null);
      const groupOfTab = t => { for (const g of M().groups()) if (g.tabs.indexOf(t) >= 0) return g; return null; };
      const isPvTab = t => !!t && t.kind === "unk" && (recs.has(t) || types.has(t.utype));
      const typeOfTab = t => (!t ? "empty" : t.kind === "unk" ? t.utype : !t.kind ? "markdown" : t.kind === "gg" ? "graph" : t.kind === "lg" ? "localgraph" : String(t.kind));
      const newId = () => { try { if (typeof wsId === "function") return wsId(); } catch (_) {} let s = ""; for (let i = 0; i < 16; i++) s += "0123456789abcdef"[Math.random() * 16 | 0]; return s; };
      const safe = (what, f) => { try { const r = f(); if (r && typeof r.catch === "function") r.catch(e => console.error("[plugin] " + what + ":", e)); return r; } catch (e) { console.error("[plugin] " + what + ":", e); } };
      function leafOfTab(t) { let l = tabLeaf.get(t); if (!l) { l = new WorkspaceLeaf(d.app()); l._t = t; tabLeaf.set(t, l); } return l; }
      function bindLeaf(leaf, t) {      // leaf now IS tab t (a pending leaf landed, or the leaf moved to a new tab)
        const old = leaf._t;
        if (old && old !== t && tabLeaf.get(old) === leaf) tabLeaf.delete(old);
        leaf._t = t; leaf._g0 = null; leaf._nt = false; leaf._split = null;
        if (!t.lid) t.lid = leaf._id;   // the leaf keeps its id (the tab persists it)
        tabLeaf.set(t, leaf);
      }
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
      function makeView(t, type, state, inst) {   // instantiate (or adopt inst) + load + onOpen, once per tab
        const ty = types.get(type);
        const leaf = leafOfTab(t);
        let view = inst || null;
        if (!view) {
          if (!ty) return null;
          try { view = ty.factory(leaf); } catch (e) { console.error("[plugin] view factory " + type + ":", e); return null; }
          if (!view) return null;
        }
        const r = { t, leaf, view, type, pid: ty ? ty.pid : null, opened: null };
        recs.set(t, r);
        // main.js mounts a plugin-view tab only through PVHOST, which registerView arms; a view handed to
        // WorkspaceLeaf.open needs no registered type, so the first record arms it too (else the tab shows
        // "No view for" and the view's containerEl is never attached)
        try { if (typeof PVHOST !== "undefined" && !PVHOST) PVHOST = PV; } catch (_) {}
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

      /* ------------------------------------------- the layout tree (api-workspace)
         Obsidian's layout classes over main.js's own model, resolved LIVE at
         read time (nothing is mirrored, so nothing goes stale):
           rootSplit   WorkspaceRoot   main.js state.root (whatever node is the
                                       root right now; a new object after
                                       changeLayout, as stock's is)
           split node  WorkspaceSplit  one item per node object of the split tree
           group       WorkspaceTabs   one item per tab group; children = its leaves
           leaf        WorkspaceLeaf   one per TAB (leafOfTab); an empty group has one
           left/right  WorkspaceSidedock  the two sidebars (#side / #rside);
                       collapse/expand/toggle drive the app's own sidebar toggles
         getRoot walks .parent (never calls getRoot again), getContainer is the
         main root for anything outside a container (a sidedock, as in stock). */
      const S = () => { try { return typeof state !== "undefined" && state ? state : null; } catch (_) { return null; } };
      const parentNodeOf = x => { const s = S(); return s && typeof findParent === "function" ? findParent(s.root, x) : null; };
      const inLayout = x => { const s = S(); return !!s && (x === s.root || !!parentNodeOf(x)); };
      class WorkspaceItem extends Events {
        constructor() { super(); hid(this, "_k", null); hid(this, "_n", null); }
        get parent() { return itemParent(this); }
        get containerEl() { return itemEl(this); }
        getRoot() { let x = this; for (let p = x.parent; p; p = p.parent) x = p; return x; }
        getContainer() { const r = rootOf(this); return r instanceof WorkspaceContainer ? r : mainRoot(); }
      }
      class WorkspaceParent extends WorkspaceItem { get children() { return itemChildren(this); } }
      class WorkspaceSplit extends WorkspaceParent {
        get direction() { const n = this._k === "split" ? this._n : this._k === "root" ? (S() || {}).root : null; return n && n.dir === "col" ? "horizontal" : "vertical"; }
      }
      class WorkspaceContainer extends WorkspaceSplit {
        get doc() { const el = this.containerEl; return (el && el.ownerDocument) || document; }
        get win() { return this.doc.defaultView || window; }
      }
      class WorkspaceRoot extends WorkspaceContainer {}
      class WorkspaceWindow extends WorkspaceContainer {}      // a popout window's root: never built here (popouts are design-gated)
      class WorkspaceFloating extends WorkspaceParent {}       // the popout windows' parent: never built here
      class WorkspaceTabs extends WorkspaceParent {
        get currentTab() { const g = this._k === "tabs" ? this._n : null; return g ? Math.max(0, g.active) : 0; }
      }
      const sideIsOpen = side => { try { return side === "left" ? !!sideOpen : !!rightOpen; } catch (_) { return false; } };
      function sideToggle(side) {       // the app's own toggles (they flip the flag synchronously, then paint)
        const f = side === "left" ? (typeof cmdToggleSide === "function" ? cmdToggleSide : null) : (typeof cmdToggleRight === "function" ? cmdToggleRight : null);
        if (f) safe("sidedock " + side, () => f());
      }
      class WorkspaceSidedock extends WorkspaceSplit {
        get direction() { return "horizontal"; }
        get collapsed() { return !sideIsOpen(this._n); }
        collapse() {
          if (this.collapsed) return;
          const al = d.activeLeaf();    // focus leaves a sidebar that is going away
          if (al && al.getRoot() === this) { const g = M().fg() || M().groups()[0]; if (g && typeof focusGroup === "function") try { focusGroup(g); } catch (_) {} }
          sideToggle(this._n);
        }
        expand() { if (this.collapsed) sideToggle(this._n); }
        toggle() { if (this.collapsed) this.expand(); else this.collapse(); }
      }
      class WorkspaceRibbon {
        constructor(side) { hid(this, "_side", side === "right" ? "right" : "left"); this.collapsed = false; }
        get ribbonItemsEl() { return this._side === "left" ? byId("ribbon") : null; }
        // read-only view of plugin ribbon icons (cmdr's "Left Ribbon" tab maps it); a copy, so remove() on it can't detach app buttons
        get items() { return this._side !== "left" ? [] : [...document.querySelectorAll("#ribbon .os-plugin-ribbon")].map(b => ({ id: (b.dataset.plugin || "") + ":" + b.title, title: b.title, icon: (b.firstElementChild && b.firstElementChild.dataset.icon) || "", buttonEl: b })); }
      }
      let rootGen = 0, rootItem = null;
      function mainRoot() { if (!rootItem || rootItem._gen !== rootGen) { rootItem = new WorkspaceRoot(); rootItem._k = "root"; hid(rootItem, "_gen", rootGen); } return rootItem; }
      const splitItems = new WeakMap(), tabsItems = new WeakMap(), docks = {}, dockTabs = {}, ribbons = {};
      function tabsOf(g) { let it = tabsItems.get(g); if (!it) { it = new WorkspaceTabs(); it._k = "tabs"; it._n = g; tabsItems.set(g, it); } return it; }
      function itemOfNode(n) {          // a node of main.js's split tree -> its live item
        if (!n) return null;
        const s = S(); if (s && n === s.root) return mainRoot();
        if (!n.children) return tabsOf(n);
        let it = splitItems.get(n); if (!it) { it = new WorkspaceSplit(); it._k = "split"; it._n = n; splitItems.set(n, it); }
        return it;
      }
      function dock(side) { if (!docks[side]) { const it = new WorkspaceSidedock(); it._k = "dock"; it._n = side; docks[side] = it; } return docks[side]; }
      function dockTabsOf(side) { if (!dockTabs[side]) { const it = new WorkspaceTabs(); it._k = "docktabs"; it._n = side; dockTabs[side] = it; } return dockTabs[side]; }
      function ribbon(side) { return ribbons[side] || (ribbons[side] = new WorkspaceRibbon(side)); }
      function itemParent(it) {
        switch (it._k) {
          case "split": case "tabs": { if (!inLayout(it._n)) return null; const p = parentNodeOf(it._n); return p ? itemOfNode(p) : null; }
          case "docktabs": return dock(it._n);
          default: return null;         // the root, a sidedock, an item never placed in the layout
        }
      }
      function itemChildren(it) {
        const s = S();
        switch (it._k) {
          case "root": return s ? s.root.children.map(itemOfNode) : [];
          case "split": return (it._n.children || []).map(itemOfNode);
          case "tabs": { const g = it._n; return g.tabs.length ? g.tabs.map(leafOfTab) : [d.groupLeaf(g)]; }
          case "dock": return [dockTabsOf(it._n)];
          case "docktabs": return sides.filter(r => r.side === it._n).map(r => r.leaf);
          default: return [];
        }
      }
      function itemEl(it) {
        switch (it._k) {
          case "root": return byId("main");
          case "split": return it._n.el || null;
          case "tabs": return it._n.pane || null;
          case "dock": case "docktabs": return byId(it._n === "left" ? "side" : "rside");
          default: return null;
        }
      }
      function rootOf(it) { let x = it; for (let p = x.parent; p; p = p.parent) x = p; return x; }
      function leafParent(l) {
        if (l._side) return sideRec(l) ? dockTabsOf(l._side) : null;
        if (l._t) { const g = groupOfTab(l._t); return g ? tabsOf(g) : null; }
        if (l._split) return null;      // a pending split: its group does not exist yet
        const g = l._g0; return g && inLayout(g) ? tabsOf(g) : null;
      }

      /* leaf groups (setGroup / getGroupLeaves): a tab leaf's group IS the app's
         link group (R13, t.link), so grouped leaves are linked tabs that follow
         each other; the 16-hex string is the same `group` value workspace.json
         carries for that link (wsGrp). A leaf that is not a tab keeps it alone. */
      function leafGroup(l) {
        const t = l._t;
        if (!t) return l._gs;
        if (t.link == null || typeof wsGrp !== "object" || typeof wsIdOf !== "function") return null;
        return wsIdOf(wsGrp, "L" + t.link);
      }
      function setLeafGroup(l, hex) {
        hex = hex == null || hex === "" ? null : String(hex);
        const t = l._t;
        if (!t || typeof wsGrp !== "object" || typeof linkSeq !== "number") { l._gs = hex; return; }
        if (t.link != null) {           // leave the current link group; a group of one dissolves (R13.4)
          const L = t.link; delete t.link;
          const rest = []; for (const g of M().groups()) for (const x of g.tabs) if (x.link === L) rest.push(x);
          if (rest.length < 2) for (const x of rest) delete x.link;
        }
        if (hex) {
          let L = null;
          for (const k of Object.keys(wsGrp)) if (k[0] === "L" && wsGrp[k] === hex) { L = Number(k.slice(1)); break; }
          if (L == null || !Number.isFinite(L)) { linkSeq = linkSeq + 1; L = linkSeq; wsGrp["L" + L] = hex; }
          t.link = L;
        }
        if (typeof renderTabs === "function") for (const g of M().groups()) try { renderTabs(g); } catch (_) {}
        d.touch();
      }

      /* A leaf. Shapes (hidden fields, never enumerable):
           tab leaf    _t    one tab of a group, any kind (identity per tab: leafOfTab);
                             a plugin view's tab has a record in recs
           group leaf  _g0   an EMPTY tab group (no tab to be)
           pending     _g0 + _nt (new tab) | _split ("row"|"col"): getLeaf(true|'tab'|'split')
                       — becomes a tab leaf when something opens in it
           side leaf   _side "right"|"left" (getRightLeaf/getLeftLeaf) */
      class WorkspaceLeaf extends WorkspaceItem {
        constructor(app) {
          super(); this.app = app;
          for (const k of ["_g0", "_v", "_t", "_split", "_side", "_gs"]) hid(this, k, null);
          hid(this, "_nt", false); hid(this, "_id", newId());
          this.hoverPopover = null;
        }
        get _g() { return this._t ? groupOfTab(this._t) : this._g0; }
        set _g(g) { this._g0 = g; }
        get _grp() { return this._g; }
        get id() { const t = this._t; return t ? (t.lid || (t.lid = this._id)) : this._id; }
        get view() {
          if (this._side) { const r = sideRec(this); return r ? r.view : emptyView(this); }
          const t = this._t;
          if (t) { const r = recs.get(t); if (r) return r.view; if (t.kind === "unk") return emptyView(this); }
          else if (this._nt || this._split) return emptyView(this);
          return d.leafView(this);
        }
        get containerEl() { return this.view.containerEl; }
        get parent() { return leafParent(this); }
        get group() { return leafGroup(this); }
        getViewState() {
          const r = this._t ? recs.get(this._t) : sideRec(this);
          if (r) { let st = {}; try { st = r.view.getState() || {}; } catch (_) {} return { type: r.type, state: st }; }
          if (this._t && this._t.kind === "unk") { const s = this._t.raw && this._t.raw.state; return { type: this._t.utype, state: (s && s.state) || {} }; }
          if (this._side || this._nt || this._split) return { type: "empty", state: {} };
          return d.leafState(this);
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
          if ((this._t && this._t.kind === "unk") || this._side) {   // a plugin leaf asked to show a note: a new tab in its group (or the focused one)
            const n = new WorkspaceLeaf(this.app); n._g = this._grp || M().fg(); n._nt = true;
            return d.openFileIn(n, file, openState);
          }
          return d.openFileIn(this, file, openState);
        }
        async open(view) {              // show a View the caller built (for this leaf) in this leaf
          if (!(view instanceof View)) throw new TypeError("WorkspaceLeaf.open: expected a View");
          let type = ""; try { type = String(view.getViewType() || ""); } catch (_) {}
          await openTyped(this, type || "empty", null, true, view);
          return view;
        }
        getDisplayText() { const v = this.view; try { const s = v && v.getDisplayText(); if (s) return s; } catch (_) {} return ""; }
        getIcon() { const v = this.view; try { const s = v && v.getIcon(); if (s) return s; } catch (_) {} return "file"; }
        updateHeader() { const r = this._t ? recs.get(this._t) : sideRec(this); if (r) { if (r.t) syncTab(r); else sideSync(r); } }
        setPinned(p) { if (this._t) { this._t.pinned = !!p; const g = this._grp; if (g && typeof renderTabs === "function") renderTabs(g); } }
        togglePinned() { if (this._t) this.setPinned(!this._t.pinned); }
        get pinned() { return !!(this._t && this._t.pinned); }
        setGroup(group) { setLeafGroup(this, group); }
        setGroupMember(other) {
          if (!(other instanceof WorkspaceLeaf) || other === this) return;
          let g = other.group; if (g == null) { g = newId(); other.setGroup(g); }
          this.setGroup(g);
        }
        detach() {
          if (this._side) return sideDetach(this);
          if (this._t) return closeTabOf(this._t);
          const g = this._g0;               // an empty group's leaf: the empty pane goes (never the last one)
          if (g && !this._nt && !this._split && !g.tabs.length && M().groups().length > 1 && inLayout(g) && typeof collapseGroup === "function") return collapseGroup(g, "plugin-detach");
        }
        getEphemeralState() { const v = this.view; try { return (v && v.getEphemeralState && v.getEphemeralState()) || {}; } catch (_) { return {}; } }
        setEphemeralState(s) { const v = this.view; try { if (v && v.setEphemeralState) v.setEphemeralState(s); } catch (_) {} }
        loadIfDeferred() { return Promise.resolve(); }
        get isDeferred() { return false; }
        onResize() { const v = this.view; try { if (v && v.onResize) v.onResize(); } catch (_) {} }
      }
      const emptyOf = new WeakMap();
      function emptyView(leaf) { let v = emptyOf.get(leaf); if (!v) { v = new View(leaf); v.getViewType = () => (leaf._t ? leaf._t.utype : "empty"); emptyOf.set(leaf, v); } return v; }

      async function openTyped(leaf, type, state, active, inst) {
        if (leaf._side) return sideOpenView(leaf, type, state, active, inst);
        const t0 = leaf._t;
        if (t0 && t0.kind === "unk") {  // a plugin-view tab: same type -> new state; other type / a given view -> a new view in the same tab
          const t = t0, g = groupOfTab(t);
          let r = recs.get(t);
          if (r && r.type === type && !inst) { await r.opened; try { await r.view.setState(state, {}); } catch (e) { console.error(e); } syncTab(r); }
          else {
            if (r) closeRec(r);
            t.utype = type; r = makeView(t, type, state, inst); if (!r) return;
            if (g && activeTab(g) === t && typeof loadActive === "function") await loadActive(g);
            await r.opened;
          }
          if (active && g) await reveal(leaf);
          return;
        }
        const g = leaf._g || M().fg(); if (!g) return;
        const t = pvTab(type);
        let at = g.active >= 0 ? g.active + 1 : g.tabs.length;
        if (t0) { const i = g.tabs.indexOf(t0); if (i >= 0) at = i + 1; }
        const split = leaf._split;
        // the leaf moves to the new tab: a pending leaf lands, a note/graph tab's leaf follows its view
        // (the note tab stays, as before; it gets a leaf of its own on next use); a stale group leaf mirrors
        if (t0 || leaf._nt || split || !g.tabs.length) bindLeaf(leaf, t);
        const r = makeView(t, type, state, inst); if (!r) return;
        if (split && typeof splitWith === "function") await splitWith(g, split, t);
        else await openTabView(g, t, at, true);
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
      function leafOfGroup(g) {         // the group's leaf: its ACTIVE tab's (an empty group has one of its own)
        const t = activeTab(g);
        return t ? leafOfTab(t) : d.groupLeaf(g);
      }
      function mainLeaves() {
        const out = [];
        for (const g of M().groups()) { if (g.tabs.length) for (const t of g.tabs) out.push(leafOfTab(t)); else { const l = d.groupLeaf(g); if (l) out.push(l); } }
        return out;
      }
      function leavesOfType(type) {
        const out = [];
        for (const g of M().groups()) {
          for (const t of g.tabs) if (typeOfTab(t) === type) out.push(leafOfTab(t));
          if (!g.tabs.length && type === "empty") { const l = d.groupLeaf(g); if (l) out.push(l); }
        }
        for (const s of sideRecs()) if (s.type === type) out.push(s.leaf);
        return out;
      }
      function iterateLeaves(cb, withSide) {
        for (const l of mainLeaves()) if (cb(l) === true) return true;
        if (withSide) for (const s of sideRecs().slice()) if (cb(s.leaf) === true) return true;
        return false;
      }
      function getLeaf(newLeaf, dir) {
        const g = M().fg();
        if (!g) return null;
        if (!newLeaf) return null;      // caller (Workspace.getLeaf) answers false with the active leaf
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
      function sideMount(leaf, type, state, inst) {
        const ty = types.get(type);
        const c = SIDE[leaf._side], strip = byId(c.strip), host = byId(c.host);
        if (!strip || !host) return null;
        let view = inst || null;
        if (!view) {
          if (!ty) return null;
          try { view = ty.factory(leaf); } catch (e) { console.error("[plugin] view factory " + type + ":", e); return null; }
          if (!view) return null;
        }
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
        const r = { leaf, view, type, pid: ty ? ty.pid : null, side: leaf._side, opened: null, btn, pane, icon: null };
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
      async function sideOpenView(leaf, type, state, active, inst) {
        let r = sideRec(leaf);
        if (r && r.type === type && !inst) { await r.opened; try { await r.view.setState(state, {}); } catch (e) { console.error(e); } sideSync(r); }
        else { if (r) sideClose(r); r = sideMount(leaf, type, state, inst); if (!r) return; await r.opened; }
        if (active) await sideReveal(leaf);   // a background open stays a strip button until revealed
      }
      async function sideReveal(leaf) {
        const r = sideRec(leaf); if (!r) return;
        if (r.side === "right" && !sideIsOpen("right") && typeof cmdToggleRight === "function") await cmdToggleRight();
        if (r.side === "left" && !sideIsOpen("left") && typeof cmdToggleSide === "function") await cmdToggleSide();
        sideShow(r);
      }
      async function sideDetach(leaf) { const r = sideRec(leaf); if (r) sideClose(r); }
      function getSideLeaf(side) { const l = new WorkspaceLeaf(d.app()); l._side = side; return l; }

      /* ------------------------------------------- HoverPopover (api-workspace)
         A popover owned by a HoverParent (parent.hoverPopover). Born Showing and
         detached; after waitTime it is Shown: appended to <body>, placed under
         its target (or at staticPos), and it becomes parent.hoverPopover. The
         pointer leaving target and popover starts Hiding; HIDE_MS later it is
         Hidden, detached, unowned and unloaded (re-entering cancels). hide()
         ends it at once. hoverEl / state are accessors over a private record,
         so a subclass may still assign them. */
      const PopoverState = { Showing: 0, Shown: 1, Hiding: 2, Hidden: 3 };
      for (const k of Object.keys(PopoverState)) PopoverState[PopoverState[k]] = k;
      const pops = new WeakMap(), HIDE_MS = 300;
      class HoverPopover extends Component {
        constructor(parent, targetEl, waitTime, staticPos) {
          super(); installDom();
          const el = mk("div", { cls: "popover hover-popover" });
          const p = { el, state: PopoverState.Showing, parent: parent && typeof parent === "object" ? parent : null,
                      target: targetEl instanceof Element ? targetEl : null, pos: staticPos && typeof staticPos === "object" ? staticPos : null,
                      showT: null, hideT: null, off: [] };
          pops.set(this, p);
          const on = (n, ev, fn) => { n.addEventListener(ev, fn); p.off.push(() => n.removeEventListener(ev, fn)); };
          const leave = e => { const x = e && e.relatedTarget; if (x instanceof Node && (p.el.contains(x) || (p.target && p.target.contains(x)))) return; popLeave(this); };
          const enter = () => popEnter(this);
          if (p.target) { on(p.target, "mouseover", enter); on(p.target, "mouseout", leave); on(p.target, "mouseleave", leave); }
          on(el, "mouseenter", enter); on(el, "mouseleave", leave);
          const ms = Number(waitTime) > 0 ? Number(waitTime) : 0;
          p.showT = setTimeout(() => popShow(this), ms);
        }
        get hoverEl() { const p = pops.get(this); return p ? p.el : undefined; }
        set hoverEl(el) { const p = pops.get(this); if (p && el instanceof HTMLElement) p.el = el; }
        get state() { const p = pops.get(this); return p ? p.state : undefined; }
        set state(s) { const p = pops.get(this); if (p) p.state = s; }
        onShow() {}
        onHide() {}
        hide() { popHide(this); }
      }
      function popShow(hp) {
        const p = pops.get(hp); if (!p) return;
        p.showT = null;
        if (p.state !== PopoverState.Showing) return;
        const prev = p.parent && p.parent.hoverPopover;
        if (prev && prev !== hp && typeof prev.hide === "function") safe("hover popover", () => prev.hide());
        p.state = PopoverState.Shown;
        const el = p.el, s = el.style;
        s.position = "fixed"; s.zIndex = "1000"; s.maxWidth = "min(640px, 90vw)"; s.maxHeight = "min(480px, 80vh)"; s.overflow = "auto";
        if (!s.background) s.background = "var(--background-primary, #fff)";
        if (!s.border) s.border = "1px solid var(--background-modifier-border, #ccc)";
        if (!s.borderRadius) s.borderRadius = "8px";
        document.body.appendChild(el);
        popPlace(p);
        const down = e => { if (!(e.target instanceof Node) || !(el.contains(e.target) || (p.target && p.target.contains(e.target)))) popHide(hp); };
        document.addEventListener("mousedown", down, true);
        p.off.push(() => document.removeEventListener("mousedown", down, true));
        if (p.parent) p.parent.hoverPopover = hp;
        safe("hover popover load", () => hp.load());
        safe("hover popover onShow", () => hp.onShow());
      }
      function popPlace(p) {
        const el = p.el, W = window.innerWidth, H = window.innerHeight;
        let x = 0, y = 0, above = 0;
        if (p.pos) { x = Number(p.pos.x) || 0; y = Number(p.pos.y) || 0; above = y; }
        else if (p.target) { const r = p.target.getBoundingClientRect(); x = r.left; y = r.bottom + 6; above = r.top - 6; }
        const b = el.getBoundingClientRect();
        if (x + b.width > W - 8) x = Math.max(8, W - b.width - 8);
        if (y + b.height > H - 8 && above - b.height >= 8) y = above - b.height;
        el.style.left = Math.round(Math.max(0, x)) + "px"; el.style.top = Math.round(Math.max(0, y)) + "px";
      }
      function popLeave(hp) {
        const p = pops.get(hp); if (!p) return;
        if (p.state === PopoverState.Showing) return popHide(hp);   // left before it showed: it never does
        if (p.state !== PopoverState.Shown) return;
        p.state = PopoverState.Hiding;
        p.hideT = setTimeout(() => { p.hideT = null; if (p.state === PopoverState.Hiding) popHide(hp); }, HIDE_MS);
      }
      function popEnter(hp) {
        const p = pops.get(hp); if (!p || p.state !== PopoverState.Hiding) return;
        clearTimeout(p.hideT); p.hideT = null; p.state = PopoverState.Shown;
      }
      function popHide(hp) {
        const p = pops.get(hp); if (!p) return;
        clearTimeout(p.showT); clearTimeout(p.hideT); p.showT = p.hideT = null;
        if (p.state === PopoverState.Hidden) return;
        const shown = p.state !== PopoverState.Showing;
        p.state = PopoverState.Hidden;
        for (const f of p.off.splice(0)) try { f(); } catch (_) {}
        p.el.remove();
        if (p.parent && p.parent.hoverPopover === hp) p.parent.hoverPopover = null;
        if (shown) safe("hover popover onHide", () => hp.onHide());
        safe("hover popover unload", () => hp.unload());
      }

      // [pview:<n types>|<type>@<where><+ shown|- hidden>,...] — where: t<pane index> main-area tab, r / l sidebar
      function censusTok() {
        if (!types.size && !recs.size && !sides.length) return "";
        const gs = M().groups(), cs = s => String(s).replace(/[[\]|,@+\s-]+/g, "_").slice(0, 40);
        const one = r => cs(r.type) + "@" + (r.side ? r.side[0] : "t" + gs.indexOf(groupOfTab(r.t))) + (r.view.containerEl.isConnected && !r.view.containerEl.hidden && r.view.containerEl.getClientRects().length ? "+" : "-");
        return " [pview:" + types.size + "|" + [...recs.values(), ...sides].map(one).join(",") + "]";
      }
      const host = { PV, sweep, censusTok, registerView, unregisterView, leavesOfType, iterateLeaves, getLeaf, getSideLeaf,
                     reveal, leafOfGroup, leafOfTab, bindLeaf, activeTab, groupOfTab, typeOfTab, isPvTab, recs, types, sideHide, sideShowing,
                     mainRoot, newRoot() { rootGen++; }, dock, ribbon };
      const layout = { WorkspaceItem, WorkspaceParent, WorkspaceSplit, WorkspaceContainer, WorkspaceRoot, WorkspaceWindow,
                       WorkspaceFloating, WorkspaceTabs, WorkspaceSidedock, WorkspaceRibbon, HoverPopover };
      return { View, ItemView, FileView, EditableFileView, TextFileView, WorkspaceLeaf, layout, PopoverState, host };
    },
  });
})();
/* the "obsidian" module, part WORKSPACE: the views factory is taken ONCE and
   removed from window, then app.workspace (a Workspace) over the app's tab
   groups. A separate closure: it sees only what api.js hands it in K. Segment
   contract: see api-core.js. */
(function () {
  "use strict";
  const parts = window.__osApiParts || (window.__osApiParts = Object.create(null));
  const reg = (id, fn) => { if (!(id in parts)) parts[id] = fn; };
  reg("workspace:views", function (K) {
    const { Component, Events, installDom, mk, setIcon, touch } = K;
    /* --------------------------------------------- views (ui/plugins/views.js)
       View / ItemView / FileView / WorkspaceLeaf and the layout classes live
       in views.js. Its factory is taken ONCE here and removed from window, so
       plugin code cannot reach it; its deps are read at call time. */
    const viewsFactory = window.__osPluginViews;
    try { delete window.__osPluginViews; } catch (_) {}
    if (typeof viewsFactory !== "function") { console.error("[plugin] views.js did not load"); return false; }
    const { View, ItemView, FileView, EditableFileView, TextFileView, WorkspaceLeaf, layout, PopoverState, host: views } = viewsFactory({
      Component, Events, installDom, mk, setIcon, app: () => K.app, touch: () => touch(),
      vault: () => K.vault, TFile: () => K.TFile,
      leafView: l => K.leafView(l), groupFile: g => K.groupFile(g), openFileIn: (l, f, o) => K.openFileIn(l, f, o),
      groupLeaf: g => K.groupLeaf(g), leafState: l => K.leafState(l), activeLeaf: () => (K.workspace ? K.workspace.activeLeaf : null),
    });
    Object.assign(K, { EditableFileView, FileView, ItemView, TextFileView, View, WorkspaceLeaf, views, layout });
    Object.assign(K.exportClasses, layout);
    K.exportValues.PopoverState = PopoverState;
  });
  reg("workspace:workspace", function (K) {
    const { EA, Events, MarkdownView, Menu, TFile, View, WorkspaceLeaf, bridge, debounce, files, normalizePath, noteOf, parseLinktext, resolveLink, touch, vault, views } = K;
    /* ------------------------------------------- workspace
       Leaves are the app's tabs (one per tab; an empty group has one), the
       layout tree is main.js's split tree (views.js), all read at call time.
       file-open / active-leaf-change are detected by focusTick(), which the
       [plg:] census runs on every updateTitle — the one place main.js already
       reports "something on screen changed" — so this needs no new hook. */
    const leafOf = new WeakMap();       // group -> its EMPTY-group leaf (a tab, once the group has one, is its own leaf)
    const groupLeaf = g => {
      if (!g) return null;
      let l = leafOf.get(g);
      if (!l || l._t || l._nt || l._split) { l = new WorkspaceLeaf(K.app); l._g = g; leafOf.set(g, l); }
      return l;
    };
    const leafFor = g => (g ? views.leafOfGroup(g) : null);
    const allGroups = () => { try { return typeof groups === "function" ? groups() : []; } catch (_) { return []; } };
    const focusedGroup = () => { try { return typeof state !== "undefined" && state ? state.focused : null; } catch (_) { return null; } };
    const noteFile = t => { if (!t || t.kind || !K.st.modelOn) return null; const f = files.get(t.name + ".md"); return f instanceof TFile ? f : null; };
    function groupFile(g) { return noteFile(views.activeTab(g)); }
    function leafView(l) {              // a tab leaf that is not a plugin view: its note / graph / nothing
      const t = l._t, g = l._grp;
      if (!l._v) {
        const mv = new MarkdownView(l);   // no editor-api / a background tab: a file-only stand-in
        Object.defineProperty(mv, "file", { configurable: true, get: () => noteFile(l._t || views.activeTab(l._grp)) });
        const gv = new View(l); gv.getViewType = () => views.typeOfTab(l._t);
        gv.getDisplayText = () => (l._t && l._t.kind === "lg" ? "Graph of " + (l._t.center || "") : "Graph view");
        const ev = new View(l); ev.getViewType = () => "empty";
        Object.defineProperty(l, "_v", { value: { mv, gv, ev }, writable: true, configurable: true });
      }
      const tt = t || views.activeTab(g);
      if (tt && !tt.kind) {
        if (EA && K.st.modelOn) {
          let tv = null;
          if (g && g.view && g.view.tab === tt) tv = g.view; else if (tt.view) tv = tt.view;
          const mv = tv && EA.viewFor(tv, l); if (mv) return mv;
        }
        return l._v.mv;
      }
      if (tt && (tt.kind === "gg" || tt.kind === "lg")) return l._v.gv;
      return l._v.ev;
    }
    function leafState(l) {             // {type, state} of a tab leaf, in workspace.json's own words
      const t = l._t || views.activeTab(l._grp);
      if (!t) return { type: "empty", state: {} };
      if (typeof wsLeaf === "function") try { const w = wsLeaf(t); if (w && w.state) return { type: w.state.type, state: JSON.parse(JSON.stringify(w.state.state || {})) }; } catch (_) {}
      const f = noteFile(t); return f ? { type: "markdown", state: { file: f.path } } : { type: "empty", state: {} };
    }
    async function openFileIn(leaf, file, openState) {
      if (!(file instanceof TFile) || file.extension !== "md") return;
      const name = noteOf(file.path), g = leaf && leaf._grp;
      if (g && g !== focusedGroup() && typeof focusGroup === "function") try { focusGroup(g); } catch (_) {}
      if (leaf && leaf._t && g) {       // a tab leaf: that tab shows the note
        const t = leaf._t;
        const i = g.tabs.indexOf(t);
        if (i >= 0 && i !== g.active && typeof switchTab === "function") await switchTab(g, i);
        if (!t.kind) { if (t.name !== name && typeof navigate === "function") await navigate(g, name); }
        else if (typeof openNewTab === "function") { await openNewTab(name, g); const n = views.activeTab(g); if (n) views.bindLeaf(leaf, n); }
      } else if (leaf && leaf._split && g && typeof splitWith === "function" && typeof mkTab === "function") {
        const d0 = leaf._split, t = mkTab(name); views.bindLeaf(leaf, t); await splitWith(g, d0, t);
      } else if (leaf && leaf._nt && typeof openNewTab === "function") {
        await openNewTab(name, g || undefined);
        const n = views.activeTab(g || focusedGroup()); if (n) views.bindLeaf(leaf, n);
      } else if (typeof openInTab === "function") {
        const empty = g && !g.tabs.length;
        await openInTab(name);
        const n = views.activeTab(g || focusedGroup()); if (empty && n && leaf) views.bindLeaf(leaf, n);
      }
      const sub = openState && openState.eState && openState.eState.subpath;
      if (sub && typeof navAnchor === "function") try { await navAnchor(focusedGroup(), sub.replace(/^#/, "")); } catch (_) {}
      touch();
    }
    let lastLeaf = null, lastFile;
    function focusTick() {
      views.sweep();                       // a plugin-view tab the app closed -> its view closes
      if (!K.st.modelOn || !K.st.layoutReady) return;
      const l = leafFor(focusedGroup()), f = l ? groupFile(l._grp) : null;
      if (l !== lastLeaf) { lastLeaf = l; queueMicrotask(() => workspace.trigger("active-leaf-change", l)); }
      if (f !== lastFile) { lastFile = f; queueMicrotask(() => { workspace.trigger("file-open", f); if (l) workspace.trigger("layout-change"); }); }
    }
    const unsupported = what => { throw new Error("unsupported in opensidian: " + what); };
    class Workspace extends Events {
      constructor() {
        super();
        this.layoutReady = false;
        this.containerEl = document.body;
        this.leftSplit = views.dock("left");
        this.rightSplit = views.dock("right");
        this.leftRibbon = views.ribbon("left");
        this.rightRibbon = views.ribbon("right");
        this.requestSaveLayout = debounce(() => { if (typeof wsTouch === "function") try { wsTouch(); } catch (_) {} }, 0);
      }
      get rootSplit() { return views.mainRoot(); }
      get activeLeaf() { const g = focusedGroup() || allGroups()[0]; return g ? leafFor(g) : null; }
      set activeLeaf(l) { this.setActiveLeaf(l); }
      // editor-api: the focused note's MarkdownView (a MarkdownFileInfo: .editor, .file), or null
      get activeEditor() { return EA && K.st.modelOn ? EA.activeEditor() : null; }
      on(name, cb, ctx) {               // main.js's PMENU is set lazily: api.js loads before main.js declares it
        if (name === "file-menu" || name === "editor-menu") try { PMENU = PM; } catch (_) {}
        return super.on(name, cb, ctx);
      }
      onLayoutReady(cb) { if (K.st.layoutReady) queueMicrotask(() => { try { cb(); } catch (e) { console.error(e); } }); else this.on("layout-ready", cb); }
      iterateAllLeaves(cb) { views.iterateLeaves(cb, true); }
      iterateRootLeaves(cb) { views.iterateLeaves(cb, false); }
      getLeavesOfType(t) { return views.leavesOfType(String(t)); }
      detachLeavesOfType(t) { for (const l of views.leavesOfType(String(t))) l.detach(); }
      getRightLeaf() { return views.getSideLeaf("right"); }
      getLeftLeaf() { return views.getSideLeaf("left"); }
      async ensureSideLeaf(type, side, o) {
        o = o || {}; let l = views.leavesOfType(type)[0];
        if (!l) { l = views.getSideLeaf(side === "left" ? "left" : "right"); await l.setViewState({ type, state: o.state || {}, active: !!o.active }); }
        if (o.reveal !== false) await views.reveal(l);
        return l;
      }
      getActiveViewOfType(C) { const l = this.activeLeaf, v = l && l.view; return v && C && v instanceof C ? v : null; }
      getActiveFile() { return groupFile(focusedGroup()); }
      getMostRecentLeaf() { return this.activeLeaf; }
      getUnpinnedLeaf() { const l = this.activeLeaf; return l && l.pinned ? this.getLeaf("tab") : l; }
      getLeaf(newLeaf, dir) {
        if (!newLeaf) { const l = this.activeLeaf; if (!l || !l.pinned) return l; newLeaf = "tab"; }   // a pinned tab is not replaced
        return views.getLeaf(newLeaf, dir) || this.activeLeaf;
      }
      splitActiveLeaf(dir) { return this.getLeaf("split", dir); }
      createLeafBySplit(leaf, dir) { if (leaf && leaf._grp && typeof focusGroup === "function") try { focusGroup(leaf._grp); } catch (_) {} return this.getLeaf("split", dir); }
      createLeafInParent() { return this.getLeaf("tab"); }
      setActiveLeaf(l) { if (l && (l._t || l._side)) { views.reveal(l); return; } if (l && l._grp && typeof focusGroup === "function") try { focusGroup(l._grp); } catch (_) {} }
      revealLeaf(l) { if (l && (l._t || l._side)) return views.reveal(l); this.setActiveLeaf(l); return Promise.resolve(); }
      async openLinkText(lt, src, newLeaf, openState) {
        const { path, subpath } = parseLinktext(lt);
        let f = path ? resolveLink(path, src) : vault.getFileByPath(src || "");
        if (!f) f = await vault.create(normalizePath(path.endsWith(".md") ? path : path + ".md"), "");
        const os = Object.assign({}, openState || {}); if (subpath) os.eState = Object.assign({}, os.eState, { subpath });
        return this.getLeaf(newLeaf).openFile(f, os);
      }
      getLastOpenFiles() { try { return typeof mruList !== "undefined" && Array.isArray(mruList) ? mruList.slice(0, 10).map(n => n + ".md") : []; } catch (_) { return []; } }
      updateOptions() { if (EA) EA.reconfigureAll(); }   // editor-api: a plugin mutated its registered extension array
      getLeafById(id) { let hit = null; views.iterateLeaves(l => { if (l.id === id) { hit = l; return true; } }, true); return hit; }
      getGroupLeaves(group) { const out = []; if (group == null) return out; views.iterateLeaves(l => { if (l.group === group) out.push(l); }, true); return out; }
      getLayout() {                     // the layout as workspace.json carries it (lastOpenFiles is the file's, not the layout's)
        if (typeof wsDoc !== "function") return {};
        const d = wsDoc(); delete d.lastOpenFiles;
        if (!d["left-ribbon"]) d["left-ribbon"] = { hiddenItems: {} };
        return JSON.parse(JSON.stringify(d));
      }
      async changeLayout(lay) {         // replace the whole layout: a new root, new groups, new leaves
        if (!lay || typeof lay !== "object" || typeof wsApply !== "function") return;
        const old = allGroups();
        if (typeof flushSave === "function") for (const g of old) { try { await flushSave(g); } catch (_) {} }
        const names = typeof inv === "function" ? await inv("list_notes") : [];
        const ok = await wsApply(lay, names);
        if (!ok) return;
        views.newRoot();
        const live = new Set(allGroups());
        for (const g of old) if (!live.has(g)) { if (g.sim) { try { clearTimeout(g.sim); } catch (_) {} g.sim = null; } if (g.saveT) { clearTimeout(g.saveT); g.saveT = null; } }
        views.sweep();
        touch();
        this.trigger("layout-change");
      }
      async duplicateLeaf(leaf, type, dir) {
        const n = this.getLeaf(type === undefined ? false : type, dir);
        if (n && leaf && n !== leaf) await n.setViewState(leaf.getViewState(), leaf.getEphemeralState());
        return n;
      }
      handleLinkContextMenu(menu, linktext, sourcePath) {   // the link's rows in a context menu
        if (!menu || typeof menu.addItem !== "function") return false;
        const lt = String(linktext || "");
        menu.addItem(i => i.setTitle("Open in new tab").setIcon("lucide-file-plus").onClick(() => this.openLinkText(lt, sourcePath, "tab")));
        menu.addItem(i => i.setTitle("Open to the right").setIcon("lucide-separator-vertical").onClick(() => this.openLinkText(lt, sourcePath, "split")));
        const { path } = parseLinktext(lt);
        const f = path ? resolveLink(path, sourcePath) : null;
        if (f instanceof TFile) this.trigger("file-menu", menu, f, "link-context-menu", null);
        return true;
      }
      openPopoutLeaf() { unsupported("popout windows (Workspace.openPopoutLeaf): one window per vault"); }
      moveLeafToPopout() { unsupported("popout windows (Workspace.moveLeafToPopout): one window per vault"); }
    }
    const workspace = new Workspace();
    /* workspace "file-menu" / "editor-menu". main.js builds its own .ctxmenu
       (noteMenu: the explorer row) and asks PMENU before placing it; a plugin's
       handler gets a Menu whose rows land in THAT menu after a rule, so they
       share its styling, its close-on-mousedown and its [menu:] census. Nothing
       is added — not even the rule — when no handler adds a row. "editor-menu"
       opens a menu of plugin rows only, and only once bridge.editor yields an
       Editor. */
    function menuHook(name, m, args) {
      const a = workspace._ev.get(name);
      if (!a || !a.length) return 0;
      const menu = new Menu(); menu.dom = m;
      workspace.trigger(name, menu, ...args);
      // a MenuSeparator row (when that class exists) counts as a rule, like null
      const isSep = x => x === null || (typeof K.MenuSeparator === "function" && x instanceof K.MenuSeparator);
      const it = menu.items.slice();
      while (it.length && isSep(it[0])) it.shift();
      while (it.length && isSep(it[it.length - 1])) it.pop();
      const n = it.filter(x => x && !isSep(x)).length;
      if (!n) return 0;
      if (m.childElementCount) { const s = document.createElement("div"); s.className = "sep"; m.appendChild(s); }
      for (const x of it) {
        if (isSep(x)) { const s = document.createElement("div"); s.className = "sep"; m.appendChild(s); }
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
    if (EA) bridge.editor = () => { const mv = K.st.modelOn ? EA.activeEditor() : null; return mv && mv.editor ? { editor: mv.editor, view: mv } : null; };
    K.exportClasses.Workspace = Workspace;
    Object.assign(K, { allGroups, focusTick, focusedGroup, groupFile, groupLeaf, leafFor, leafState, leafView, openFileIn, workspace });
  });
})();
