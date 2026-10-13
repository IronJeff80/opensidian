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
       Obsidian's format). Browse/install is OUT of M1: install = copy the folder.
     - a "Community plugins" GROUP under it with one entry per setting tab a
       LOADED plugin registered (pane id "plg:<id>"); the group exists only while
       it has entries (no empty heading — noplugins' structural rule).
   main.js calls in at four points (buildSettingsNav, showSettingsPage, setTok,
   closeSettings); everything else lives here so cm6-editor's main.js edits do
   not collide with it. Census (only while settings is open):
     [cpp:<R|T>,<installed>,<enabled>]   on the community pane
     [cpr:<x>,<y>,<1 restricted|0>]      the restricted toggle's centre
     [cpt=<id>:<x>,<y>,<on>,<loaded>,<gear x|0>]   one per installed plugin
     [cpn=<pane id>:<x>,<y>]             every community nav entry's centre
     [ptab:<id>,<setting-items>,<elements>]  a plugin tab is on screen (display() ran) */
"use strict";
(function () {
  const host = window.__osPluginHost;
  if (!host || !host.app) return;
  const setting = host.app.setting;
  let busy = false;           // one toggle round-trip at a time (a double click is one intent)

  const el = (tag, cls, txt) => { const d = document.createElement(tag); if (cls) d.className = cls; if (txt != null) d.textContent = txt; return d; };
  const isOurs = id => id === "community" || String(id).startsWith("plg:");
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
  /* a plugin added/removed a setting tab: the group follows (nav is otherwise built once) */
  function tabsChanged() {
    const n = document.getElementById("snav");
    if (n && n.dataset.built === "1") nav(n);
    if (typeof settingsOpen !== "undefined" && settingsOpen && String(sPane).startsWith("plg:") && !tabOf(sPane.slice(4)))
      showSettingsPage("community");     // the tab on screen belonged to a plugin that just unloaded
  }

  function leaveTab() { if (setting.activeTab) setting.closeActiveTab(); }

  /* ---- panes ---- */
  function show(id) {
    if (!isOurs(id)) { leaveTab(); return false; }
    if (String(id).startsWith("plg:") && !tabOf(id.slice(4))) id = "community";   // its plugin unloaded since
    leaveTab();
    fontPage = null;
    sPane = id;
    for (const d of document.getElementById("snav").querySelectorAll(".snavi")) d.classList.toggle("sel", d.dataset.pane === id);
    const pg = document.getElementById("spage"); pg.innerHTML = ""; pg.className = "rows";
    sRowsShown = 0; sEnabledShown = 0;
    if (id === "community") { buildCommunity(pg); host.refresh().then(() => { if (settingsOpen && sPane === "community") rebuild(); }, () => {}); }
    else buildTab(pg, id.slice(4));
    updateTitle();
    return true;
  }
  function rebuild() {
    const pg = document.getElementById("spage"); if (!pg) return;
    pg.innerHTML = ""; buildCommunity(pg); updateTitle();
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
    sRowsShown = 1 + ids.length;
    sEnabledShown = (restricted ? 0 : ids.length) + 1;
  }
  async function act(f) {
    if (busy) return; busy = true;
    try { await f(); } catch (e) { console.error("[plugin] settings:", e); }
    busy = false;
    if (settingsOpen && sPane === "community") rebuild();
    const n = document.getElementById("snav"); if (n && n.dataset.built === "1") nav(n);
  }
  function buildTab(pg, id) {
    const t = tabOf(id);
    if (!t) { row(pg.appendChild(el("div", "scard")), "This plugin has no settings tab", "", [], true); return; }
    pg.className = "rows os-plugin-tab";
    t.containerEl.empty ? t.containerEl.empty() : (t.containerEl.innerHTML = "");
    pg.appendChild(t.containerEl);
    setting.activeTab = t;
    try { t.display(); } catch (e) {
      console.error("[plugin] " + id + " settings display:", e);
      pg.appendChild(el("div", "sempty", "This plugin's settings failed to render: " + (e && e.message || e)));
    }
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
      for (const row of document.querySelectorAll("#spage .srow[data-plugin]")) {
        const id = row.dataset.plugin, tg = row.querySelector(".toggle"), g = row.querySelector(".cpgear");
        t += " [cpt=" + id + ":" + ctr(tg) + "," + (tg.classList.contains("on") ? 1 : 0) + "," +
             (s.loaded.includes(id) ? 1 : 0) + "," + (g ? ctr(g).split(",")[0] : 0) + "]";
      }
    } else if (String(sPane).startsWith("plg:") && setting.activeTab && setting.activeTab.containerEl.isConnected) {
      const ce = setting.activeTab.containerEl;
      t += " [ptab:" + setting.activeTab.id + "," + ce.querySelectorAll(".setting-item").length + "," + ce.querySelectorAll("*").length + "]";
    }
    return t;
  }

  /* Obsidian's app.setting.openTabById(id): "community-plugins" is its id for the pane */
  async function openTab(id) {
    if (!settingsOpen) await openSettings();
    showSettingsPage(id === "community-plugins" ? "community" : tabOf(id) ? "plg:" + id : "community");
  }

  const api = Object.freeze({ nav, show, tok, tabsChanged, close: leaveTab, openTab });
  Object.defineProperty(window, "__osPluginSettings", { value: api, writable: false, configurable: false });
  Object.defineProperty(window, "openPluginSettingTab", { value: openTab, writable: false, configurable: false });
})();
