// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* cp-browser: the community plugin browser, opened from Settings > Community plugins > Browse.
   Every byte from the network is fetched by Rust (src-tauri/src/plugin_store.rs: https only, a
   five-host GitHub allowlist re-checked on every redirect, timeouts, byte caps, no token); this
   page only calls the four store commands and renders what they return.

   Privileges: settings.js writes this script into the page WHILE index.html is still parsing, so it
   runs before the loader's seal (ui/plugins/loader.js) deletes window.__TAURI__. The invoke handle
   is captured into this closure and never stored anywhere a plugin can reach: the browser hands
   itself to settings.js through its one-shot adoptBrowser() and defines nothing on window.

   Installing writes files and enables nothing; Enable is the same act as the installed list's
   toggle (host.setEnabled), and the restricted-mode switch stays on the Community plugins page.

   Census (settings.js tok(), only while the browser is on screen):
     [cpb:<W|L|D|E>,<rows shown>,<matches>,<total>,<sort>,<list loads>]   W loading, L list, D detail, E failed
     [cpbq:<x>,<y>,<query length>]   the search box      [cpbs=<sort>:<x>,<y>,<1 selected|0>]
     [cpbr=<id>:<x>,<y>]             the first 12 rows    [cpbk:<x>,<y>]   the Back control
     [cpbf:<x>,<y>]                  Refresh (list + releases fetched again)
     [cpbd=<id>:<installed|->,<latest|->,<update 0|1>,<enabled 0|1>,<loaded 0|1>,<readme chars>,<intact -|0|1>]
     [cpbdn:<name>|<author>]          [cpba=<install|update|uninstall|enable>:<x>,<y>]
     [cpbbusy:<action>]  [cpbok:<action>:<id>]  [cpberr:<message>]   the last action's outcome */
"use strict";
(function () {
  const T = window.__TAURI__;
  const invoke = T && T.core && T.core.invoke ? T.core.invoke.bind(T.core) : null;
  const S = window.__osPluginSettings;
  if (!invoke || !S || typeof S.adoptBrowser !== "function") return;

  const SHOW = 100;            // rows rendered at once; the search narrows the rest
  const SORTS = [["downloads", "Most downloaded"], ["name", "Name"], ["updated", "Recently updated"]];
  let ctx = null;              // {host, page(), back(), title()} from settings.js, per open()
  let view = "W", rows = null, listErr = "", q = "", sort = "downloads", matches = 0, shown = 0;
  let sel = null, det = null, detErr = "", busy = "", ok = "", err = "", note = "";
  let gen = 0;                 // a late reply for a page the user already left is dropped
  let loads = 0;               // list loads completed (census: a Refresh is seen to land)

  const el = (tag, cls, txt) => { const d = document.createElement(tag); if (cls) d.className = cls; if (txt != null) d.textContent = txt; return d; };
  const msg = e => String(e && e.message || e || "unknown error");
  const fmt = n => Number(n || 0).toLocaleString("en-US");
  const page = () => ctx && ctx.page();
  const title = () => { if (ctx) ctx.title(); };
  function btn(label, cls, onclick) {
    const b = el("button", "cpb-btn" + (cls ? " " + cls : ""), label);
    b.type = "button";
    b.onclick = ev => { ev.stopPropagation(); onclick(); };
    return b;
  }

  /* ---- README: plugin_store renders it with our own render_md (raw HTML demoted to text, scheme
     allowlist, no images). This is the second pass, on the DOM: only plain text structure survives,
     every attribute but a link's href is dropped, and a click on a link does nothing. ---- */
  const KEEP = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "CODE", "EM",
    "STRONG", "B", "I", "S", "DEL", "A", "BR", "HR", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "SPAN", "DIV", "SUP", "SUB", "KBD"]);
  const DROP = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "IMG", "SVG", "MATH", "VIDEO", "AUDIO", "SOURCE",
    "LINK", "META", "BASE", "FORM", "INPUT", "BUTTON", "TEXTAREA", "SELECT", "TEMPLATE", "NOSCRIPT", "FRAME", "FRAMESET"]);
  function clean(src, dst) {
    for (const n of [...src.childNodes]) {
      if (n.nodeType === 3) { dst.appendChild(document.createTextNode(n.nodeValue)); continue; }
      if (n.nodeType !== 1 || DROP.has(n.tagName)) continue;
      if (!KEEP.has(n.tagName)) { clean(n, dst); continue; }   // unknown wrapper: keep its text, not the element
      const c = document.createElement(n.tagName.toLowerCase());
      if (n.tagName === "A") {
        const h = n.getAttribute("href") || "";
        if (/^https?:\/\//i.test(h)) c.title = h;
        c.className = "cpb-link";
      }
      clean(n, c);
      dst.appendChild(c);
    }
  }
  function readme(html) {
    const box = el("div", "cpb-readme");
    const doc = new DOMParser().parseFromString("<body>" + String(html || "") + "</body>", "text/html");   // inert: no script runs, nothing loads
    clean(doc.body, box);
    box.addEventListener("click", ev => { if (ev.target.closest("a")) { ev.preventDefault(); ev.stopPropagation(); } }, true);
    return box;
  }

  /* ---- list ---- */
  async function loadList(refresh) {
    const g = ++gen;
    view = "W"; listErr = ""; render();
    try {
      const r = await invoke("store_list", { refresh: !!refresh });
      if (g !== gen) return;
      rows = Array.isArray(r) ? r : []; view = "L"; loads++;
    } catch (e) {
      if (g !== gen) return;
      listErr = msg(e); view = "E";
    }
    render();
  }
  function filtered() {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const out = (rows || []).filter(r => {
      if (!terms.length) return true;
      const hay = (r.name + "\n" + r.author + "\n" + r.description + "\n" + r.id).toLowerCase();
      return terms.every(t => hay.includes(t));
    });
    const by = {
      downloads: (a, b) => (b.downloads - a.downloads) || String(a.name).localeCompare(String(b.name)),
      name: (a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" }),
      updated: (a, b) => (b.updated - a.updated) || String(a.name).localeCompare(String(b.name)),
    }[sort];
    return out.sort(by);
  }
  function renderRows(box) {
    box.innerHTML = "";
    const st = ctx.host.state();
    const all = filtered();
    matches = all.length; shown = Math.min(SHOW, matches);
    const card = el("div", "scard");
    for (const r of all.slice(0, SHOW)) {
      const row = el("div", "srow cpb-row");
      row.dataset.store = r.id; row.tabIndex = 0;
      const info = el("div", "sinfo");
      info.appendChild(el("div", "slabel", r.name || r.id));
      const bits = [r.author ? "By " + r.author : "", fmt(r.downloads) + " downloads", st.installed[r.id] ? "Installed" : ""].filter(Boolean);
      info.appendChild(el("div", "sdesc", bits.join(" · ")));
      if (r.description) info.appendChild(el("div", "sdesc", r.description));
      row.appendChild(info);
      row.onclick = () => openDetail(r.id);
      row.onkeydown = ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openDetail(r.id); } };
      card.appendChild(row);
    }
    if (!matches) card.appendChild(el("div", "sempty", q ? "Nothing in the list matches “" + q + "”." : "The list is empty."));
    box.appendChild(card);
    if (matches > shown) box.appendChild(el("div", "cpb-more", "Showing " + shown + " of " + fmt(matches) + ". Type to narrow the list."));
    const c = box.parentNode && box.parentNode.querySelector(".cpb-count");
    if (c) c.textContent = fmt(matches) + (matches === 1 ? " plugin" : " plugins");
  }
  function renderList(pg) {
    const bar = el("div", "cpb-bar");
    const back = btn("← Community plugins", "cpb-back", () => ctx.back()); back.id = "cpbback";
    bar.appendChild(back);
    bar.appendChild(el("div", "cpb-count"));
    // the list and each repo's latest release are cached for a while (GitHub's anonymous rate limit);
    // this fetches both again, so a release published since shows up as an update
    const rf = btn("Refresh", "", () => loadList(true)); rf.id = "cpbrefresh"; rf.title = "Fetch the list and the latest releases again";
    bar.appendChild(rf);
    pg.appendChild(bar);
    const tools = el("div", "cpb-tools");
    const inp = el("input", "cpb-q"); inp.id = "cpbq"; inp.type = "search"; inp.placeholder = "Search by name, author or description";
    inp.value = q; inp.spellcheck = false; inp.autocomplete = "off";
    let t = 0;
    inp.oninput = () => { clearTimeout(t); t = setTimeout(() => { q = inp.value; renderRows(box); title(); }, 120); };
    // typing stays in the box (the settings modal treats keys as chords); Esc clears it, then closes settings
    inp.onkeydown = ev => {
      if (ev.key === "Escape" && !inp.value) return;
      ev.stopPropagation();
      if (ev.key === "Escape") { ev.preventDefault(); inp.value = ""; q = ""; renderRows(box); title(); }
    };
    tools.appendChild(inp);
    const seg = el("div", "cpb-sort");
    for (const [k, label] of SORTS) {
      const b = btn(label, "cpb-sortb" + (k === sort ? " on" : ""), () => {
        sort = k;
        for (const x of seg.children) x.classList.toggle("on", x.dataset.sort === k);
        renderRows(box); title();
      });
      b.dataset.sort = k;
      seg.appendChild(b);
    }
    tools.appendChild(seg);
    pg.appendChild(tools);
    const box = el("div", "cpb-rows");
    pg.appendChild(box);
    renderRows(box);
  }

  /* ---- detail ---- */
  async function openDetail(id) {
    sel = id; det = null; detErr = ""; ok = ""; err = ""; note = ""; view = "D";
    render();
    await loadDetail();
  }
  async function loadDetail() {
    const g = ++gen, id = sel;
    try {
      const d = await invoke("store_detail", { id });
      if (g !== gen) return;
      det = d; detErr = "";
    } catch (e) {
      if (g !== gen) return;
      det = null; detErr = msg(e);
    }
    render();
  }
  async function act(name, f) {
    if (busy) return;
    const id = sel;
    busy = name; ok = ""; err = ""; note = ""; render();
    try {
      await f(id);
      ok = name;
    } catch (e) {
      err = msg(e);
      console.error("[plugin-store] " + name + " " + id + ":", e);
    }
    busy = "";
    try { await ctx.host.refresh(); } catch (_) {}
    if (sel === id && view === "D") await loadDetail(); else render();
  }
  const install = () => act("install", async id => { await invoke("store_install", { id }); });
  const update = () => act("update", async id => {
    const was = ctx.host.state().loaded.includes(id);
    await invoke("store_install", { id });
    if (was) {                                   // the running copy is the old code: reload it
      await ctx.host.refresh();
      ctx.host.disable(id);
      const r = await ctx.host.enable(id);
      if (r && r.ok === false) throw new Error("updated, but it failed to load: " + msg(r.error));
    }
  });
  const uninstall = () => act("uninstall", async id => {
    if (ctx.host.state().enabled.includes(id) || ctx.host.state().loaded.includes(id)) await ctx.host.setEnabled(id, false);
    await invoke("store_uninstall", { id });
  });
  const enable = () => act("enable", async id => {
    const r = await ctx.host.setEnabled(id, true);
    if (r && r.ok === false) throw new Error("enabled, but it failed to load: " + msg(r.error));
    if (!ctx.host.state().trusted) note = "Enabled. It runs once restricted mode is off (Community plugins page).";
  });
  function renderDetail(pg) {
    const bar = el("div", "cpb-bar");
    const back = btn("← All plugins", "cpb-back", () => { sel = null; det = null; ok = ""; err = ""; note = ""; gen++; view = rows ? "L" : "W"; if (rows) render(); else loadList(false); });
    back.id = "cpbback";
    bar.appendChild(back);
    pg.appendChild(bar);
    const e = det && det.entry || (rows || []).find(r => r.id === sel) || { id: sel };
    const head = el("div", "cpb-head");
    head.appendChild(el("div", "cpb-name", e.name || sel));
    const by = [e.author ? "By " + e.author : "", e.repo ? "github.com/" + e.repo : ""].filter(Boolean).join(" · ");
    if (by) head.appendChild(el("div", "sdesc", by));
    if (e.description) head.appendChild(el("div", "cpb-desc", e.description));
    pg.appendChild(head);
    if (!det) {
      pg.appendChild(el("div", detErr ? "cpb-err" : "sempty", detErr ? "Could not load this plugin: " + detErr : "Loading…"));
      return;
    }
    const st = ctx.host.state();
    const inst = det.installed || "", latest = det.latest && det.latest.version || "";
    const facts = el("div", "cpb-facts");
    const fact = (k, v) => { const f = el("div", "cpb-fact"); f.appendChild(el("span", "cpb-k", k)); f.appendChild(el("span", "cpb-v", v)); facts.appendChild(f); };
    fact("Latest version", latest || "no release" + (det.releaseError ? " (" + det.releaseError + ")" : ""));
    if (inst) fact("Installed", inst + (det.update ? " — update available" : ""));
    fact("Downloads", fmt(e.downloads));
    if (det.audit && det.audit.files) fact("Files", det.audit.intact ? "match the sha256 recorded at install" : "changed since install");
    pg.appendChild(facts);
    const acts = el("div", "cpb-acts");
    const a = (name, label, f, cls) => { const b = btn(busy === name ? label + "…" : label, cls, f); b.dataset.act = name; b.disabled = !!busy; acts.appendChild(b); };
    if (!inst) { if (latest) a("install", "Install", install, "cpb-cta"); }
    else {
      if (det.update) a("update", "Update to " + latest, update, "cpb-cta");
      if (!st.enabled.includes(sel)) a("enable", "Enable", enable, det.update ? "" : "cpb-cta");
      else acts.appendChild(el("span", "cpb-state", st.loaded.includes(sel) ? "Enabled, running" : st.trusted ? "Enabled" : "Enabled, not running: restricted mode is on"));
      a("uninstall", "Uninstall", uninstall, "cpb-danger");
    }
    pg.appendChild(acts);
    if (err) pg.appendChild(el("div", "cpb-err", err));
    else if (note) pg.appendChild(el("div", "cpb-note", note));
    else if (ok === "install") pg.appendChild(el("div", "cpb-note", "Installed. Nothing runs until you enable it."));
    pg.appendChild(el("div", "ssec", "README"));
    pg.appendChild(readme(det.readme));
  }

  function render() {
    const pg = page(); if (!pg) return;
    const keep = pg.querySelector("#cpbq"), had = keep && document.activeElement === keep;
    pg.innerHTML = ""; pg.classList.add("cpb");
    if (view === "D") renderDetail(pg);
    else if (view === "L") renderList(pg);
    else {
      const bar = el("div", "cpb-bar");
      const back = btn("← Community plugins", "cpb-back", () => ctx.back()); back.id = "cpbback";
      bar.appendChild(back); pg.appendChild(bar);
      if (view === "E") {
        pg.appendChild(el("div", "cpb-err", "Could not load the community plugin list: " + listErr));
        pg.appendChild(btn("Try again", "cpb-cta", () => loadList(true)));
      } else pg.appendChild(el("div", "sempty", "Loading the community plugin list…"));
    }
    if (had) { const i = pg.querySelector("#cpbq"); if (i) { i.focus(); i.selectionStart = i.selectionEnd = i.value.length; } }
    title();
  }

  /* settings.js: the Browse button (a fresh visit to the list), and a rebuild while it is on screen */
  function open(c, fresh) {
    ctx = c;
    if (fresh) { sel = null; det = null; ok = ""; err = ""; note = ""; q = ""; view = rows ? "L" : "W"; }
    if (!rows && view !== "D") return loadList(false);
    render();
  }
  function close() { gen++; ctx = null; }

  const safe = s => String(s == null ? "" : s).replace(/[\[\]\n\r]/g, " ").slice(0, 200);
  const ctr = d => { const b = d.getBoundingClientRect(); return Math.round(b.left + b.width / 2) + "," + Math.round(b.top + b.height / 2); };
  function tok() {
    const pg = page(); if (!pg) return "";
    let t = " [cpb:" + view + "," + (view === "L" ? shown : 0) + "," + (view === "L" ? matches : 0) + "," + (rows ? rows.length : 0) + "," + sort + "," + loads + "]";
    const b = pg.querySelector("#cpbback"); if (b) t += " [cpbk:" + ctr(b) + "]";
    if (view === "L") {
      const i = pg.querySelector("#cpbq"); if (i) t += " [cpbq:" + ctr(i) + "," + i.value.length + "]";
      const f = pg.querySelector("#cpbrefresh"); if (f) t += " [cpbf:" + ctr(f) + "]";
      for (const s of pg.querySelectorAll(".cpb-sortb")) t += " [cpbs=" + s.dataset.sort + ":" + ctr(s) + "," + (s.classList.contains("on") ? 1 : 0) + "]";
      let n = 0;
      for (const r of pg.querySelectorAll(".cpb-row")) { if (n++ >= 12) break; t += " [cpbr=" + r.dataset.store + ":" + ctr(r) + "]"; }
    } else if (view === "D" && sel) {
      if (det) {
        const st = ctx.host.state(), e = det.entry || {};
        const rd = pg.querySelector(".cpb-readme");
        const au = det.audit && det.audit.files ? (det.audit.intact ? 1 : 0) : "-";
        t += " [cpbd=" + sel + ":" + safe(det.installed || "-") + "," + safe(det.latest && det.latest.version || "-") + "," + (det.update ? 1 : 0) + "," +
             (st.enabled.includes(sel) ? 1 : 0) + "," + (st.loaded.includes(sel) ? 1 : 0) + "," + (rd ? rd.textContent.length : 0) + "," + au + "]";
        t += " [cpbdn:" + safe(e.name).replace(/\|/g, "/") + "|" + safe(e.author).replace(/\|/g, "/") + "]";
      } else if (detErr) t += " [cpberr:" + safe(detErr) + "]";
      for (const a of pg.querySelectorAll(".cpb-acts [data-act]")) t += " [cpba=" + a.dataset.act + ":" + ctr(a) + "]";
    }
    if (busy) t += " [cpbbusy:" + busy + "]";
    if (ok) t += " [cpbok:" + ok + ":" + sel + "]";
    if (err) t += " [cpberr:" + safe(err) + "]";
    return t;
  }

  S.adoptBrowser(Object.freeze({ open, close, tok }));
})();
