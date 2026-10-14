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
        }
        getViewType() { return ""; }
        getDisplayText() { return ""; }
        getIcon() { return this.icon; }
        getState() { return {}; }
        setState() { return Promise.resolve(); }
        onOpen() { return Promise.resolve(); }
        onClose() { return Promise.resolve(); }
      }
      class ItemView extends View {
        constructor(leaf) { super(leaf); this.contentEl = this.containerEl.createDiv({ cls: "view-content" }); }
        addAction(icon, title, cb) {
          const b = this.containerEl.createDiv({ cls: "clickable-icon view-action", attr: { "aria-label": title } });
          setIcon(b, icon); b.addEventListener("click", cb); return b;
        }
      }
      class FileView extends ItemView { constructor(leaf) { super(leaf); this.file = null; this.allowNoFile = false; } }
      class EditableFileView extends FileView {}
      class TextFileView extends EditableFileView { constructor(leaf) { super(leaf); this.data = ""; } }

      /* A leaf = one of the app's tab groups (M1: a group IS a leaf; its active
         tab is the leaf's view). `_g` is the group object, `_nt` a leaf from
         getLeaf(true)/splitActiveLeaf whose openFile opens a NEW tab there. */
      class WorkspaceLeaf extends Events {
        constructor(app) {
          super(); this.app = app;
          Object.defineProperty(this, "_g", { value: null, writable: true });
          Object.defineProperty(this, "_nt", { value: false, writable: true });
          Object.defineProperty(this, "_v", { value: null, writable: true });
        }
        get view() { return d.leafView(this); }
        getViewState() { const f = d.groupFile(this._g); return f ? { type: "markdown", state: { file: f.path } } : { type: "empty", state: {} }; }
        setViewState(vs) { const p = vs && vs.state && vs.state.file; const f = p && d.vault().getAbstractFileByPath(p); return f instanceof d.TFile() ? this.openFile(f) : Promise.resolve(); }
        openFile(file, openState) { return d.openFileIn(this, file, openState); }
        getDisplayText() { const f = d.groupFile(this._g); return f ? f.basename : ""; }
        getIcon() { return "file"; }
        setPinned() {} togglePinned() {} setGroup() {} detach() {}
        getEphemeralState() { return {}; } setEphemeralState() {}
      }
      return { View, ItemView, FileView, EditableFileView, TextFileView, WorkspaceLeaf };
    },
  });
})();
