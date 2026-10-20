// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* plugin-loader (recon M1), ledger item 6: Settings > Community plugins.
   goal/noplugins removed the pane; M1 brings back the COMMUNITY half only
   (Core plugins stays removed, operator 2026-10-01):
     - Options > "Community plugins" (pane id "community"): a Restricted mode
       toggle (default ON = no plugin code runs; the flag lives outside the vault,
       ~/.opensidian.json plugins_trusted[<vault>], so a vault cannot ship itself
       trusted) and the installed list (<vault>/.obsidian/plugins/<id>/manifest.json)
       with one enable toggle per plugin (.obsidian/community-plugins.json,
       Obsidian's format). cp-browser: a Browse button opens the community plugin
       browser (ui/plugins/browser.js) on this pane; copying a folder in still works.
     - a "Community plugins" GROUP under it with one entry per setting tab a
       LOADED plugin registered (pane id "plg:<id>"); the group exists only while
       it has entries (no empty heading — noplugins' structural rule).
   main.js calls in at four points (buildSettingsNav, showSettingsPage, setTok,
   closeSettings); everything else lives here so cm6-editor's main.js edits do
   not collide with it. Census (only while settings is open):
     [cpp:<R|T>,<installed>,<enabled>]   on the community pane
     [cpr:<x>,<y>,<1 restricted|0>]      the restricted toggle's centre
     [cpbb:<x>,<y>]                      the Browse button; [cpb...] browser.js tok() while browsing
     [cpt=<id>:<x>,<y>,<on>,<loaded>,<gear x|0>]   one per installed plugin
     [cpn=<pane id>:<x>,<y>]             every community nav entry's centre
     [ptab:<id>,<setting-items>,<elements>]  a plugin tab is on screen (display() ran) */
"use strict";
(function () {
  const host = window.__osPluginHost;
  if (!host || !host.app) return;
  const setting = host.app.setting;
  let busy = false;           // one toggle round-trip at a time (a double click is one intent)
  /* cp-browser: the community plugin browser (ui/plugins/browser.js) is written into the page right
     after this script, while index.html is still parsing (before the loader's seal), and hands itself
     back through adoptBrowser() once. browsing = it owns #spage on the community pane. */
  let browser = null, browsing = false;
  if (document.readyState === "loading") document.write('<script src="plugins/browser.js"><\/script>');
  function adoptBrowser(b) {
    // only while index.html is parsing: no plugin code has run yet (plugins load after the vault opens)
    if (browser || document.readyState !== "loading" || !b || typeof b.open !== "function") return false;
    browser = b;
    return true;
  }
  const browserCtx = Object.freeze({
    host,
    page: () => (typeof settingsOpen !== "undefined" && settingsOpen && sPane === "community" && browsing ? document.getElementById("spage") : null),
    back: () => { stopBrowsing(); rebuild(); },
    title: () => updateTitle(),
  });
  function stopBrowsing() { if (browsing && browser) browser.close(); browsing = false; }
  function startBrowsing() {
    if (!browser) return;
    browsing = true;
    const pg = document.getElementById("spage"); pg.innerHTML = "";
    browser.open(browserCtx, true);
  }

  const el = (tag, cls, txt) => { const d = document.createElement(tag); if (cls) d.className = cls; if (txt != null) d.textContent = txt; return d; };
  const tabOf = id => setting.pluginTabs.find(t => t && t.id === id) || null;

  function toggle(on, onclick) {
    const t = el("div", "sctl toggle live" + (on ? " on" : ""));
    t.appendChild(el("i"));
    t.tabIndex = 0; t.setAttribute("role", "switch"); t.setAttribute("aria-checked", on ? "true" : "false");
    t.onclick = ev => { ev.stopPropagation(); onclick(); };
    t.onkeydown = ev => { if (ev.key === " " || ev.key === "Enter") { ev.preventDefault(); onclick(); } };
    return t;
  }
  function row(card, label, desc, ctls, dis) {
    const r = el("div", "srow" + (dis ? " dis" : ""));
    if (dis) r.setAttribute("aria-disabled", "true");
    const info = el("div", "sinfo");
    info.appendChild(el("div", "slabel", label));
    for (const d of [].concat(desc || [])) if (d) info.appendChild(el("div", "sdesc", d));
    r.appendChild(info);
    for (const c of ctls || []) r.appendChild(c);
    card.appendChild(r);
    return r;
  }

  /* ---- nav: Options > Community plugins, then the per-plugin group ---- */
  function nav(n) {
    for (const d of [...n.querySelectorAll("[data-cp]")]) d.remove();
    const entry = (pane, text) => {
      const d = el("div", "snavi", text);
      d.dataset.pane = pane; d.dataset.cp = "1"; d.tabIndex = 0;
      d.onclick = () => showSettingsPage(pane);
      d.onkeydown = ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); showSettingsPage(pane); } };
      if (typeof sPane !== "undefined" && sPane === pane) d.classList.add("sel");
      n.appendChild(d);
    };
    entry("community", "Community plugins");
    const tabs = setting.pluginTabs.filter(t => t && t.id);
    if (!tabs.length) return;
    const h = el("div", "snavh", "Community plugins"); h.dataset.cp = "1";
    n.appendChild(h);
    for (const t of tabs.slice().sort((a, b) => String(a.name).localeCompare(String(b.name))))
      entry("plg:" + t.id, String(t.name || t.id));
  }
  /* a plugin added/removed a setting tab: the group follows (nav is otherwise built once). A tab
     removed while on screen was hidden by removeSettingTab (activeTab null); like stock, the page
     stays where it is (the next open() goes to General, a nav click anywhere) */
  function tabsChanged() {
    const n = document.getElementById("snav");
    if (n && n.dataset.built === "1") nav(n);
  }

  function leaveTab() { if (setting.activeTab) setting.closeActiveTab(); }
  /* closeSettings: the active tab is hidden and a plugin tab's containerEl leaves the page */
  function closeUi() {
    const t = setting.activeTab;
    leaveTab();
    if (t && t._pane === undefined && t.containerEl && t.containerEl.parentNode === document.getElementById("spage")) t.containerEl.remove();
  }

  /* ---- panes ----
     Every pane is a tab of app.setting (api-ui.js ui:setting): the app's own panes are its built-in
     tabs (settingTabs, pane id in _pane), a loaded plugin's tab is "plg:<id>". A nav click or
     showSettingsPage goes through app.setting.openTab, so activeTab / lastTabId / hide() / display()
     are the same whether the user or a plugin switched the pane. */
  let inBuiltin = false;      // main.js is building one of its own panes for a built-in tab
  const builtinOf = pane => setting.settingTabs.find(t => t._pane === pane) || null;
  const paneOf = t => t._pane !== undefined ? t._pane : "plg:" + t.id;
  function selNav(id) { for (const d of document.getElementById("snav").querySelectorAll(".snavi")) d.classList.toggle("sel", d.dataset.pane === id); }
  function clearPage(id, cls) {
    stopBrowsing();
    fontPage = null; sPane = id; selNav(id);
    const pg = document.getElementById("spage"); pg.innerHTML = ""; pg.className = cls;
    sRowsShown = 0; sEnabledShown = 0;
    return pg;
  }
  /* showSettingsPage(id) asks here first: true = handled */
  function show(id) {
    if (inBuiltin) return false;
    let t;
    if (id === "community") t = builtinOf("community");
    else if (String(id).startsWith("plg:")) t = tabOf(id.slice(4)) || builtinOf("community");   // its plugin unloaded since
    else {
      const e = typeof SMODEL !== "undefined" && SMODEL ? SMODEL.nav.find(n => n.id === id) || SMODEL.nav.find(n => n.entry === id) : null;
      t = builtinOf(e ? e.id : "hotkeys");     // main.js's own fallback pane
    }
    if (!t) { leaveTab(); return false; }
    try { setting.openTab(t); } catch (e) {
      console.error("[plugin] " + t.id + " settings display:", e);
      const pg = document.getElementById("spage");
      if (pg && t._pane === undefined) pg.appendChild(el("div", "sempty", "This plugin's settings failed to render: " + (e && e.message || e)));
    }
    if (t._pane === undefined || t._pane === "community") updateTitle();   // main.js's panes update the census themselves
    return true;
  }
  /* app.setting.open(): the pane the modal opens on */
  function pane(t) { sPane = paneOf(t); }
  /* app.setting.openTab(t), before t.display(): a plugin tab goes on the page when the modal is open.
     Its containerEl goes on as is: stock never empties it around open/display/hide, so children the
     tab's constructor built there (a header + content pair display() fills) stay; display() clears itself */
  function mount(t) {
    pane(t);
    if (t._pane !== undefined || typeof settingsOpen === "undefined" || !settingsOpen) return;
    const pg = clearPage(sPane, "rows os-plugin-tab");
    pg.appendChild(t.containerEl);
    // api-settings: a declarative tab (getSettingDefinitions) refreshes its settingItems on every open
    try { if (typeof t.update === "function") t.update(); } catch (e) { console.error("[plugin] " + t.id + " settings update:", e); }
  }
  /* a built-in tab's display(): its pane, built by main.js (or the community pane, built here) */
  function builtin(t) {
    if (typeof settingsOpen === "undefined" || !settingsOpen) return;
    if (t._pane === "community") {
      const pg = clearPage("community", "rows");
      buildCommunity(pg);
      host.refresh().then(() => { if (settingsOpen && sPane === "community") rebuild(); }, () => {});
      return;
    }
    inBuiltin = true;
    try { showSettingsPage(t._pane); } finally { inBuiltin = false; }
  }
  function rebuild() {
    const pg = document.getElementById("spage"); if (!pg) return;
    if (browsing && browser) { browser.open(browserCtx, false); return; }
    pg.innerHTML = ""; pg.className = "rows"; buildCommunity(pg); updateTitle();
  }
  function buildCommunity(pg) {
    const s = host.state();
    const restricted = !s.trusted;
    const c1 = el("div", "scard"); pg.appendChild(c1);
    const rt = toggle(restricted, () => act(() => host.setRestricted(!restricted)));
    rt.id = "cprestrict";
    row(c1, "Restricted mode", [
      restricted ? "On: no community plugin code runs in this vault." : "Off: enabled community plugins run with this app's access to your vault.",
      "Plugins are third-party code. Turn restricted mode off only for plugins you trust."], [rt]);
    if (browser) {
      const b = el("button", "cpb-btn cpb-cta", "Browse");
      b.id = "cpbrowse"; b.type = "button";
      b.onclick = ev => { ev.stopPropagation(); startBrowsing(); };
      row(c1, "Community plugin list", "Find plugins in the public community list, then install, update or remove them here.", [b]);
    }
    pg.appendChild(el("div", "ssec", "Installed plugins"));
    const c2 = el("div", "scard"); pg.appendChild(c2);
    const ids = Object.keys(s.installed).sort((a, b) => String(s.installed[a].name || a).localeCompare(String(s.installed[b].name || b)));
    if (!ids.length) {
      row(c2, "No community plugins installed", "Copy a plugin folder (main.js + manifest.json) into .obsidian/plugins/ in this vault.", [], true);
    }
    for (const id of ids) {
      const m = s.installed[id] || {};
      const on = s.enabled.includes(id), loaded = s.loaded.includes(id);
      const st = host.status.get(id);
      const ctls = [];
      if (loaded && tabOf(id)) {
        const g = el("div", "sctl cpgear", "⚙"); g.title = "Options"; g.tabIndex = 0;
        g.onclick = ev => { ev.stopPropagation(); showSettingsPage("plg:" + id); };
        ctls.push(g);
      }
      const t = toggle(on, () => act(() => host.setEnabled(id, !on)));
      t.dataset.plugin = id;
      ctls.push(t);
      const desc = [
        "Version " + (m.version || "?") + (m.author ? " · By " + m.author : ""),
        m.description || "",
        st && st.state === "failed" ? "Failed to load: " + String(st.error || "") : (restricted && on ? "Enabled, not running: restricted mode is on." : ""),
      ];
      const r = row(c2, String(m.name || id), desc, ctls, restricted);
      r.dataset.plugin = id;
    }
    /* goal canvas-core: the "Core plugins" section (the Core plugins nav entry stays removed,
       goal/noplugins): one row per core plugin this app implements — today Canvas. Its toggle is
       the plugin's enable()/disable(): the canvas view type + .canvas extension come and go with it,
       and the choice persists app-wide. Not gated by restricted mode: it is app code, not a plugin. */
    const core = coreList();
    if (core.length) {
      pg.appendChild(el("div", "ssec", "Core plugins"));
      const c3 = el("div", "scard"); pg.appendChild(c3);
      for (const [cid, p, name, desc] of core) {
        const on = !!p.enabled;
        const t = toggle(on, () => act(() => (on ? p.disable() : p.enable())));
        t.dataset.core = cid;
        const r = row(c3, name, desc, [t]);
        r.dataset.core = cid;
      }
    }
    sRowsShown = 1 + (browser ? 1 : 0) + ids.length + core.length;
    sEnabledShown = (restricted ? 0 : ids.length) + 1 + (browser ? 1 : 0) + core.length;
  }
  const CORE_DESC = { canvas: ["Canvas", "Open and edit .canvas files (JSON Canvas): text, note, link and group cards on a board."] };
  function coreList() {
    const ip = host.app.internalPlugins, ps = ip && ip.plugins || {};
    return Object.keys(CORE_DESC).filter(id => ps[id] && typeof ps[id].enable === "function")
      .map(id => [id, ps[id], CORE_DESC[id][0], CORE_DESC[id][1]]);
  }
  async function act(f) {
    if (busy) return; busy = true;
    try { await f(); } catch (e) { console.error("[plugin] settings:", e); }
    busy = false;
    if (settingsOpen && sPane === "community") rebuild();
    if (typeof refreshTree === "function") refreshTree().catch(() => {});   // canvas on/off: .canvas rows follow
    const n = document.getElementById("snav"); if (n && n.dataset.built === "1") nav(n);
  }
  /* ---- census ---- */
  const ctr = d => { const b = d.getBoundingClientRect(); return Math.round(b.left + b.width / 2) + "," + Math.round(b.top + b.height / 2); };
  function tok() {
    if (typeof settingsOpen === "undefined" || !settingsOpen) return "";
    let t = "";
    const n = document.getElementById("snav");
    if (n) for (const d of n.querySelectorAll(".snavi[data-cp]")) t += " [cpn=" + d.dataset.pane + ":" + ctr(d) + "]";
    if (sPane === "community") {
      const s = host.state();
      t += " [cpp:" + (s.trusted ? "T" : "R") + "," + Object.keys(s.installed).length + "," + s.enabled.length + "]";
      const r = document.getElementById("cprestrict");
      if (r) t += " [cpr:" + ctr(r) + "," + (r.classList.contains("on") ? 1 : 0) + "]";
      const bb = document.getElementById("cpbrowse");
      if (bb) t += " [cpbb:" + ctr(bb) + "]";
      if (browsing && browser) t += browser.tok();
      for (const row of document.querySelectorAll("#spage .srow[data-plugin]")) {
        const id = row.dataset.plugin, tg = row.querySelector(".toggle"), g = row.querySelector(".cpgear");
        t += " [cpt=" + id + ":" + ctr(tg) + "," + (tg.classList.contains("on") ? 1 : 0) + "," +
             (s.loaded.includes(id) ? 1 : 0) + "," + (g ? ctr(g).split(",")[0] : 0) + "]";
      }
      for (const tg of document.querySelectorAll("#spage .toggle[data-core]")) {
        const p = (host.app.internalPlugins.plugins || {})[tg.dataset.core];
        t += " [cpc=" + tg.dataset.core + ":" + ctr(tg) + "," + (tg.classList.contains("on") ? 1 : 0) + "," + (p && p._loaded ? 1 : 0) + "]";
      }
    } else if (String(sPane).startsWith("plg:") && setting.activeTab && setting.activeTab.containerEl.isConnected) {
      const ce = setting.activeTab.containerEl;
      t += " [ptab:" + setting.activeTab.id + "," + ce.querySelectorAll(".setting-item").length + "," + ce.querySelectorAll("*").length + "]";
    }
    return t;
  }

  /* kept for older callers: app.setting.openTabById */
  const openTab = id => setting.openTabById(id);

  const api = Object.freeze({ nav, show, tok, tabsChanged, close: () => { stopBrowsing(); closeUi(); }, openTab, pane, mount, builtin, adoptBrowser });
  Object.defineProperty(window, "__osPluginSettings", { value: api, writable: false, configurable: false });
  Object.defineProperty(window, "openPluginSettingTab", { value: openTab, writable: false, configurable: false });
})();
