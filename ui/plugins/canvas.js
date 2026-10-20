// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* canvas core plugin (goal canvas-core): .canvas files in the JSON Canvas 1.0
   format, written from the open spec (https://jsoncanvas.org/spec/1.0/, MIT)
   and from the public API surface plugins call (clean room).

   Load order (index.html): ... api.js -> settings.js -> canvas.js -> main.js.
   This file runs NO code at load beyond defining one factory,
   window.__osCanvasFactory(deps), which main.js calls ONCE and then deletes.

   The document model keeps the PARSED objects: an edit changes only the known
   field it is about (x, y, width, height, text, ...), so every field this
   app does not know — on the root, a node or an edge — round-trips untouched
   and in its original key order. A file is only ever written after an edit;
   an opened-and-closed file is never rewritten, so it stays byte-identical. */
(function () {
  "use strict";
  const NODE_TYPES = ["text", "file", "link", "group"];
  const SIDES = ["top", "right", "bottom", "left"];
  const ENDS = ["none", "arrow"];
  const BG_STYLES = ["cover", "ratio", "repeat"];
  const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const isNum = v => typeof v === "number" && Number.isFinite(v);
  const optStr = (o, k) => !(k in o) || typeof o[k] === "string";
  const optIn = (o, k, set) => !(k in o) || set.includes(o[k]);

  class CanvasFormatError extends Error {
    constructor(msg) { super(msg); this.name = "CanvasFormatError"; }
  }

  /* text -> the document {nodes:[], edges:[], ...unknown}, or throws
     CanvasFormatError naming the first violation. An empty (or all-space) file
     is an empty canvas — a new canvas is created that way. */
  function parseCanvas(text) {
    if (typeof text !== "string") throw new CanvasFormatError("canvas text is not a string");
    if (!text.trim()) return { nodes: [], edges: [] };
    let doc;
    try { doc = JSON.parse(text); } catch (e) { throw new CanvasFormatError("not valid JSON: " + (e && e.message)); }
    validateCanvas(doc);
    if (!("nodes" in doc)) doc.nodes = [];
    if (!("edges" in doc)) doc.edges = [];
    return doc;
  }

  function validateCanvas(doc) {
    const bad = m => { throw new CanvasFormatError(m); };
    if (!isObj(doc)) bad("top level is not an object");
    if ("nodes" in doc && !Array.isArray(doc.nodes)) bad("nodes is not an array");
    if ("edges" in doc && !Array.isArray(doc.edges)) bad("edges is not an array");
    const ids = new Set();
    (doc.nodes || []).forEach((n, i) => {
      const at = "nodes[" + i + "]";
      if (!isObj(n)) bad(at + " is not an object");
      if (typeof n.id !== "string" || !n.id) bad(at + ".id is not a non-empty string");
      if (ids.has(n.id)) bad(at + ".id \"" + n.id + "\" is a duplicate");
      ids.add(n.id);
      if (!NODE_TYPES.includes(n.type)) bad(at + ".type " + JSON.stringify(n.type) + " is not text/file/link/group");
      for (const k of ["x", "y", "width", "height"]) if (!isNum(n[k])) bad(at + "." + k + " is not a number");
      if (!optStr(n, "color")) bad(at + ".color is not a string");
      if (n.type === "text" && typeof n.text !== "string") bad(at + ".text is not a string");
      if (n.type === "file" && (typeof n.file !== "string" || !optStr(n, "subpath"))) bad(at + ".file/subpath is not a string");
      if (n.type === "link" && typeof n.url !== "string") bad(at + ".url is not a string");
      if (n.type === "group" && (!optStr(n, "label") || !optStr(n, "background") || !optIn(n, "backgroundStyle", BG_STYLES)))
        bad(at + " has a bad label/background/backgroundStyle");
    });
    const eids = new Set();
    (doc.edges || []).forEach((e, i) => {
      const at = "edges[" + i + "]";
      if (!isObj(e)) bad(at + " is not an object");
      if (typeof e.id !== "string" || !e.id) bad(at + ".id is not a non-empty string");
      if (eids.has(e.id)) bad(at + ".id \"" + e.id + "\" is a duplicate");
      eids.add(e.id);
      if (!ids.has(e.fromNode)) bad(at + ".fromNode " + JSON.stringify(e.fromNode) + " is not a node");
      if (!ids.has(e.toNode)) bad(at + ".toNode " + JSON.stringify(e.toNode) + " is not a node");
      if (!optIn(e, "fromSide", SIDES) || !optIn(e, "toSide", SIDES)) bad(at + " has a bad fromSide/toSide");
      if (!optIn(e, "fromEnd", ENDS) || !optIn(e, "toEnd", ENDS)) bad(at + " has a bad fromEnd/toEnd");
      if (!optStr(e, "color") || !optStr(e, "label")) bad(at + " has a bad color/label");
    });
    return true;
  }

  // the document -> JSON Canvas text (tab-indented). Validates first: never write a canvas we could not read back.
  function serializeCanvas(doc) {
    validateCanvas(doc);
    return JSON.stringify(doc, null, "\t");
  }

  // a fresh id: 16 lowercase hex digits, not in `taken` (a Set or array of ids)
  function newId(taken) {
    const has = taken instanceof Set ? x => taken.has(x) : x => (taken || []).includes(x);
    for (;;) {
      const b = new Uint8Array(8); crypto.getRandomValues(b);
      const id = Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
      if (!has(id)) return id;
    }
  }

  // spec node color: a preset "1".."6" or a hex "#rgb"/"#rrggbb"; anything else renders uncolored
  const PRESET = { 1: "red", 2: "orange", 3: "yellow", 4: "green", 5: "cyan", 6: "purple" };
  function colorOf(c) {
    if (typeof c !== "string") return null;
    if (PRESET[c]) return "var(--color-" + PRESET[c] + ", " + ({ 1: "#e93147", 2: "#ec7500", 3: "#e0ac00", 4: "#08b94e", 5: "#00bfbc", 6: "#7852ee" })[c] + ")";
    return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c) ? c : null;
  }

  const model = Object.freeze({ NODE_TYPES, SIDES, ENDS, CanvasFormatError, parseCanvas, validateCanvas, serializeCanvas, newId, colorOf });

  Object.defineProperty(window, "__osCanvasFactory", {
    configurable: true, enumerable: false, writable: false,
    value: function canvasFactory(/* deps: the core plugin + view, ledger items 4-7 */) {
      return { model };
    },
  });
})();
