// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* the "obsidian" module, part FNS (api-parity stage 0: split out of api.js,
   behaviour-neutral): the top-level functions — icons (setIcon getIcon
   addIcon removeIcon getIconIds), normalizePath, debounce, prepare*Search,
   renderMatches, parseFrontMatter*, requestUrl, htmlToMarkdown,
   sanitizeHTMLToDom, parseYaml / stringifyYaml, getAllTags, parseLinktext,
   getLinkpath. Segment contract: see api-core.js. */
(function () {
  "use strict";
  const parts = window.__osApiParts || (window.__osApiParts = Object.create(null));
  const reg = (id, fn) => { if (!(id in parts)) parts[id] = fn; };
  reg("fns:icons", function (K) {
    const { host, be } = K;
    /* ------------------------------------------------------------- icons
       A tiny built-in set (drawn here, lucide-style 24x24 strokes) + addIcon().
       An unknown name draws a neutral square so a button never renders empty. */
    const P = (d) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + d + "</svg>";
    const ICONS = {
      "dice": P('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1"/><circle cx="15.5" cy="15.5" r="1"/><circle cx="12" cy="12" r="1"/>'),
      "calendar": P('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'),
      "calendar-days": P('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>'),
      "calendar-range": P('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M7 14h4M13 18h4"/>'),
      "plus": P('<path d="M12 5v14M5 12h14"/>'),
      "plus-circle": P('<circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/>'),
      "x": P('<path d="M18 6L6 18M6 6l12 12"/>'),
      "cross": P('<path d="M18 6L6 18M6 6l12 12"/>'),
      "check": P('<path d="M20 6L9 17l-5-5"/>'),
      "trash": P('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'),
      "trash-2": P('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>'),
      "pencil": P('<path d="M17 3l4 4L7 21H3v-4z"/>'),
      "settings": P('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>'),
      "gear": P('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>'),
      "search": P('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'),
      "chevron-down": P('<path d="M6 9l6 6 6-6"/>'),
      "chevron-up": P('<path d="M18 15l-6-6-6 6"/>'),
      "chevron-right": P('<path d="M9 18l6-6-6-6"/>'),
      "chevron-left": P('<path d="M15 18l-6-6 6-6"/>'),
      "arrow-up": P('<path d="M12 19V5M5 12l7-7 7 7"/>'),
      "arrow-down": P('<path d="M12 5v14M19 12l-7 7-7-7"/>'),
      "file": P('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>'),
      "file-text": P('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h6"/>'),
      "folder": P('<path d="M3 7V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
      "star": P('<path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/>'),
      "info": P('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>'),
      "command": P('<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>'),
      "terminal": P('<path d="M4 17l6-6-6-6M12 19h8"/>'),
      "more-vertical": P('<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>'),
      "more-horizontal": P('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
      "grip-vertical": P('<circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/>'),
      "eye": P('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
      "eye-off": P('<path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A9 9 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a9 9 0 0 0 5.4-1.6"/>'),
      "zap": P('<path d="M13 2L3 14h9l-1 8 10-12h-9z"/>'),
      "link": P('<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>'),
      "refresh-cw": P('<path d="M21 2v6h-6M3 22v-6h6M3.5 9a9 9 0 0 1 15-3.4L21 8M3 16l2.5 2.4A9 9 0 0 0 20.5 15"/>'),
      "copy": P('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
      "external-link": P('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>'),
      "image": P('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>'),
      "palette": P('<circle cx="12" cy="12" r="10"/><circle cx="8" cy="10" r="1"/><circle cx="12" cy="7" r="1"/><circle cx="16" cy="10" r="1"/>'),
    };
    const custom = new Map();           // addIcon: name -> svg inner content (viewBox 0 0 100 100)
    const DEFAULT_ICON = P('<rect x="4" y="4" width="16" height="16" rx="3"/>');
    function iconSvg(name) {
      name = String(name || "").replace(/^lucide-/, "");
      if (custom.has(name)) return '<svg viewBox="0 0 100 100" width="100%" height="100%" fill="currentColor">' + custom.get(name) + "</svg>";
      return ICONS[name] || DEFAULT_ICON;
    }
    function setIcon(el, name) {
      if (!el) return;
      el.innerHTML = iconSvg(name);
      const s = el.firstElementChild; if (s) { s.classList.add("svg-icon"); s.dataset.icon = String(name || ""); }
    }
    function getIcon(name) { const d = document.createElement("div"); setIcon(d, name); return d.firstElementChild; }
    const addIcon = (name, svg) => { custom.set(String(name), String(svg)); };
    const removeIcon = name => { custom.delete(String(name)); };
    const getIconIds = () => [...Object.keys(ICONS), ...custom.keys()];

    Object.assign(K, { P, addIcon, getIcon, getIconIds, removeIcon, setIcon });
  });
  reg("fns:util", function (K) {
    const { host, be } = K;
    /* ----------------------------------------------------------- utility */
    const normalizePath = p => {
      let s = String(p == null ? "" : p).replace(/\\/g, "/").replace(/[  ]/g, " ").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
      s = s.normalize("NFC");
      return s === "" ? "/" : s;
    };
    const debounce = (cb, ms = 0, resetTimer = false) => {
      let t = null, last = null;
      const f = function (...a) {
        last = a;
        if (t && !resetTimer) return f;
        clearTimeout(t);
        t = setTimeout(() => { t = null; cb.apply(this, last); }, ms);
        return f;
      };
      f.cancel = () => { clearTimeout(t); t = null; return f; };
      f.run = () => { if (t) { clearTimeout(t); t = null; return cb.apply(null, last); } };
      return f;
    };
    Object.assign(K, { debounce, normalizePath });
  });
  reg("fns:search", function (K) {
    const { host, be } = K;
    // fuzzy subsequence match: score favours early + contiguous hits (same idea as the app's palette)
    function prepareFuzzySearch(q) {
      const ql = String(q).toLowerCase().replace(/\s+/g, "");
      return text => {
        if (!ql) return { score: 0, matches: [] };
        const t = String(text).toLowerCase(); let i = 0, score = 0, prev = -2; const m = [];
        for (let j = 0; j < t.length && i < ql.length; j++) if (t[j] === ql[i]) { score -= (j - prev - 1) * 0.1 + j * 0.001; if (j === prev + 1 && m.length) m[m.length - 1][1] = j + 1; else m.push([j, j + 1]); prev = j; i++; }
        return i === ql.length ? { score, matches: m } : null;
      };
    }
    function prepareSimpleSearch(q) {
      const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
      return text => { const t = String(text).toLowerCase(), m = []; for (const w of words) { const i = t.indexOf(w); if (i < 0) return null; m.push([i, i + w.length]); } return { score: 0, matches: m }; };
    }
    function renderMatches(el, text, matches, offset = 0) {
      let at = 0;
      for (const [a0, b0] of matches || []) { const a = a0 - offset, b = b0 - offset; if (b <= 0 || a >= text.length) continue; if (a > at) el.appendText(text.slice(at, a)); el.createSpan({ cls: "suggestion-highlight", text: text.slice(Math.max(a, 0), b) }); at = b; }
      if (at < text.length) el.appendText(text.slice(at));
    }
    const parseFrontMatterEntry = (fm, key) => {
      if (!fm) return null;
      if (key instanceof RegExp) { for (const k of Object.keys(fm)) if (key.test(k)) return fm[k]; return null; }
      return Object.prototype.hasOwnProperty.call(fm, key) ? fm[key] : null;
    };
    const parseFrontMatterAliases = fm => { const v = parseFrontMatterEntry(fm, /^alias(es)?$/i); return v == null ? null : [].concat(v).map(String); };
    const parseFrontMatterTags = fm => { const v = parseFrontMatterEntry(fm, /^tags?$/i); return v == null ? null : [].concat(v).flatMap(x => String(x).split(/[,\s]+/)).filter(Boolean).map(t => t.startsWith("#") ? t : "#" + t); };
    const requestUrl = () => Promise.reject(new Error("requestUrl is not supported in opensidian yet (M1)"));
    const htmlToMarkdown = h => String(h).replace(/<[^>]+>/g, "");
    const sanitizeHTMLToDom = h => { const t = document.createElement("template"); t.innerHTML = String(h); for (const s of t.content.querySelectorAll("script,iframe,object,embed")) s.remove(); return t.content; };

    Object.assign(K, { htmlToMarkdown, parseFrontMatterAliases, parseFrontMatterEntry, parseFrontMatterTags, prepareFuzzySearch, prepareSimpleSearch, renderMatches, requestUrl, sanitizeHTMLToDom });
  });
  reg("fns:yaml", function (K) {
    const { host, be } = K;
    function parseScalar(v) {
      v = v.trim();
      if (!v) return null;
      if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) return v.slice(1, -1);
      if (v[0] === "[" && v.endsWith("]")) return v.slice(1, -1).split(",").map(x => parseScalar(x)).filter(x => x !== null);
      if (/^(true|false)$/i.test(v)) return /^true$/i.test(v);
      if (/^(null|~)$/i.test(v)) return null;
      if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
      return v;
    }
    function parseYaml(src) {   // the frontmatter subset: key: scalar | [a, b] | block list
      const o = {}; let key = null;
      for (const raw of String(src).split("\n")) {
        const l = raw.replace(/\r$/, "");
        if (!l.trim() || /^\s*#/.test(l)) continue;
        let m;
        if (key && (m = l.match(/^\s*-\s*(.*)$/))) { if (!Array.isArray(o[key])) o[key] = []; const v = parseScalar(m[1]); if (v !== null) o[key].push(v); continue; }
        if ((m = l.match(/^([^\s:#][^:]*?)\s*:(?:\s+(.*))?$/))) { key = m[1].trim(); o[key] = parseScalar(m[2] || ""); continue; }
      }
      return o;
    }
    const stringifyYaml = o => Object.keys(o || {}).map(k => k + ": " + (Array.isArray(o[k]) ? "[" + o[k].join(", ") + "]" : o[k] == null ? "" : String(o[k]))).join("\n") + "\n";
    Object.assign(K, { parseYaml, stringifyYaml });
  });
  reg("fns:links", function (K) {
    const { host, be } = K;
    const { parseFrontMatterTags } = K;
    function getAllTags(c) {
      if (!c) return null;
      const t = (c.tags || []).map(x => x.tag);
      const ft = c.frontmatter ? parseFrontMatterTags(c.frontmatter) : null;
      return (ft || []).concat(t);
    }
    const parseLinktext = lt => { const s = String(lt), i = s.indexOf("#"); return i < 0 ? { path: s, subpath: "" } : { path: s.slice(0, i), subpath: s.slice(i) }; };
    const getLinkpath = lt => parseLinktext(lt).path;
    Object.assign(K, { getAllTags, getLinkpath, parseLinktext });
  });
})();
