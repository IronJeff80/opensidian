// SPDX-License-Identifier: GPL-3.0-or-later
/* Settings ▸ Keychain (goal keychain-pane) — the vault's secrets, over the SAME backend
   app.secretStorage uses: the backend command secrets_op (src-tauri/src/secrets.rs), i.e. the
   freedesktop Secret Service, one keyring item per (vault, id), no plaintext fallback, and an
   answer only for a TRUSTED vault (restricted mode off). Nothing here is a second store.

   VALUES NEVER COME BACK. The pane lists with op "ids" (the backend reads no value at all), so
   a stored secret is never in this process's memory because of this pane. A value typed into
   the add / edit form lives in that form's password input until Save; the input is cleared and
   the form removed whether the store succeeded or not, and the value is never put in the DOM,
   the census, a log line or a notice. Ids are not secret (stock shows them; SecretComponent
   lists them) and are what the census and the rows carry.

   THE CALLOUT IS THE BACKEND'S ANSWER, not a transcription: hidden while the Secret Service
   answers; with none it shows the backend's own `unsupported:` cause and says secrets CANNOT
   be stored (stock's "will be stored without encryption" sentence is false for this app); a
   restricted-mode vault shows the backend's refusal. In every non-ok state "+" is disabled and
   nothing pretends to have stored anything.

   After a successful add / edit / delete the plugin runtime's copy (api-vault.js, loaded once
   at plugin start) is told to re-read, so app.secretStorage and the pane cannot disagree.

   Census: [skc:<state>/<ids>/<shown>/<form>/<seq>] while the pane is built —
   state ok|unsupported|refused|error|loading, form -|add|edit|del, seq = finished backend calls
   (a phase waits for it to move instead of sleeping). [skcmsg:<class>] = the form's error line,
   classified (dup|invalid|empty|backend|-), never its text. */
const KC = (() => {
  const ID_RE = /^[a-z0-9-]{1,64}$/;   // secrets::valid_id, the backend re-checks every id it is given
  const LEARN = "https://www.opensidian.org";
  let st = "loading", why = "", ids = [], q = "", root = null, form = null, formKind = "-", msgCls = "-", seq = 0, gen = 0;
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const errText = e => String((e && e.message) || e);
  const call = (op, a) => inv("secrets_op", Object.assign({ op }, a || {}));
  const live = () => !!(root && root.isConnected);
  const changed = () => { try { window.dispatchEvent(new CustomEvent("os-secrets-changed")); } catch (_) {} };
  const tick = () => { seq++; if (typeof updateTitle === "function") updateTitle(); };

  function classify(e) {
    const m = errText(e);
    if (/^unsupported: /.test(m)) return ["unsupported", m];
    if (/^EPERM: restricted mode/.test(m)) return ["refused", m];
    return ["error", m];
  }
  async function refresh() {
    const g = ++gen;
    try {
      const r = await call("ids");
      if (g !== gen) return;
      ids = Array.isArray(r && r.ids) ? r.ids.filter(x => typeof x === "string") : [];
      st = "ok"; why = "";
    } catch (e) {
      if (g !== gen) return;
      ids = []; [st, why] = classify(e);
    }
    paint(); tick();
  }

  function callout() {
    const c = el("div", "kc-callout"); c.dataset.kc = "callout";
    c.hidden = st === "ok" || st === "loading";
    if (c.hidden) return c;
    const title = st === "refused" ? "Secret storage is off in restricted mode"
      : st === "unsupported" ? "Secret storage not available" : "Secret storage failed";
    const body = st === "refused"
      ? "This vault is in restricted mode, so no secret can be read or stored here. Turn restricted mode off in Community plugins to use the keychain."
      : st === "unsupported"
        ? "Secrets are kept only in your operating system's secret store (a Secret Service such as GNOME Keyring or KWallet). None is reachable, so secrets cannot be stored. Opensidian has no unencrypted fallback."
        : "The secret store answered with an error, so the list below may be incomplete.";
    c.append(el("div", "kc-ctitle", title), el("div", "kc-cbody", body));
    const cause = el("div", "kc-cause", why); cause.dataset.kc = "cause"; c.appendChild(cause);
    const a = el("a", "kc-learn", "Learn more"); a.href = LEARN; a.dataset.kc = "learn";
    a.onclick = ev => { ev.preventDefault(); inv("open_external", { url: LEARN }).catch(err => console.warn("open_external:", errText(err))); };
    c.appendChild(a);
    return c;
  }
  function rows() {
    const list = el("div", "scard kc-list"); list.dataset.kc = "list";
    const shown = ids.filter(id => !q || id.includes(q.toLowerCase()));
    if (st === "ok" && !ids.length) list.appendChild(el("div", "kc-empty", "No secrets yet. Use + to add one."));
    else if (st === "ok" && !shown.length) list.appendChild(el("div", "kc-empty", "No secret matches \"" + q + "\"."));
    for (const id of shown) {
      const r = el("div", "srow kcrow"); r.dataset.kcid = id;
      const info = el("div", "sinfo"); info.appendChild(el("div", "slabel kc-id", id));
      const ed = el("button", "kc-edit", "Edit"); ed.dataset.kc = "edit:" + id; ed.title = "Replace the value of " + id;
      ed.onclick = () => openForm("edit", id);
      const del = el("button", "kc-del mod-warning", "Delete"); del.dataset.kc = "del:" + id; del.title = "Delete " + id;
      del.onclick = () => openForm("del", id);
      r.append(info, ed, del);
      list.appendChild(r);
    }
    return list;
  }
  function paint() {
    if (!live()) return;
    const keepFocus = document.activeElement && document.activeElement.id === "kcfind";
    root.textContent = "";
    const head = el("div", "kc-head");
    head.appendChild(el("div", "ssec kc-title", "Secrets"));
    const add = el("button", "kc-add", "+"); add.id = "kcadd"; add.dataset.kc = "add"; add.title = "Add secret";
    add.disabled = st !== "ok"; add.onclick = () => openForm("add");
    head.appendChild(add);
    const find = el("input", "kc-find"); find.id = "kcfind"; find.dataset.kc = "find";
    find.placeholder = "Find secret..."; find.spellcheck = false; find.autocomplete = "off"; find.value = q;
    find.oninput = () => { q = find.value.trim(); const l = root.querySelector(".kc-list"); if (l) l.replaceWith(rows()); tick(); };
    root.append(head, find, callout(), rows());
    if (keepFocus) { find.focus(); find.setSelectionRange(find.value.length, find.value.length); }
  }

  function closeForm() {
    if (!form) return;
    for (const i of form.querySelectorAll("input")) i.value = "";   // the typed value goes with the form
    form.remove(); form = null; formKind = "-"; msgCls = "-";
    tick();
  }
  function openForm(kind, id) {
    closeForm();
    if (kind !== "del" && st !== "ok") return;
    formKind = kind; msgCls = "-";
    const ov = form = el("div", "kc-modal"); ov.dataset.kc = "modal-" + kind;
    const card = el("div", "kc-card"); ov.appendChild(card);
    const msg = el("div", "kc-msg"); msg.hidden = true; msg.dataset.kc = "msg";
    const fail = (cls, text) => { msgCls = cls; msg.textContent = text; msg.hidden = false; tick(); };
    const btns = el("div", "kc-btns");
    const cancel = el("button", "kc-cancel", "Cancel"); cancel.dataset.kc = "cancel"; cancel.onclick = closeForm;
    let idIn = null, valIn = null, busy = false;
    const go = async () => {
      if (busy) return;
      if (kind === "del") {
        busy = true;
        try { await call("delete", { id }); closeForm(); changed(); await refresh(); }
        catch (e) { busy = false; fail("backend", errText(e)); const [s, w] = classify(e); if (s !== "error") { st = s; why = w; paint(); } }
        return;
      }
      const sid = kind === "add" ? idIn.value.trim() : id;
      if (!ID_RE.test(sid)) return fail("invalid", "Invalid id: use 1-64 lowercase letters, digits or dashes.");
      if (kind === "add" && ids.includes(sid)) return fail("dup", "A secret with this id already exists. Use Edit to replace its value.");
      if (!valIn.value) return fail("empty", "The secret value is empty.");
      busy = true;
      const value = valIn.value; valIn.value = "";   // out of the DOM before the round trip
      try { await call("set", { id: sid, value }); closeForm(); changed(); await refresh(); }
      catch (e) { busy = false; fail("backend", errText(e)); const [s, w] = classify(e); if (s !== "error") { st = s; why = w; paint(); } }
    };
    if (kind === "del") {
      card.append(el("div", "kc-mtitle", "Delete secret"),
        el("div", "kc-mbody", "Delete \"" + id + "\" from your operating system's secret store? Plugins that use it will no longer find it. This cannot be undone."));
      const ok = el("button", "kc-ok mod-warning", "Delete"); ok.dataset.kc = "confirm"; ok.onclick = go;
      btns.append(cancel, ok);
    } else {
      card.appendChild(el("div", "kc-mtitle", kind === "add" ? "Add secret" : "Edit secret"));
      if (kind === "add") {
        idIn = el("input", "kc-idin"); idIn.dataset.kc = "id"; idIn.placeholder = "id (e.g. my-api-key)";
        idIn.spellcheck = false; idIn.autocomplete = "off"; idIn.maxLength = 64;
        card.appendChild(idIn);
      } else card.appendChild(el("div", "kc-mbody", "Replace the value of \"" + id + "\". The current value is not shown."));
      valIn = el("input", "kc-valin"); valIn.type = "password"; valIn.dataset.kc = "value";
      valIn.placeholder = "secret value"; valIn.autocomplete = "new-password"; valIn.spellcheck = false;
      card.appendChild(valIn);
      const ok = el("button", "kc-ok mod-cta", "Save"); ok.dataset.kc = "save"; ok.onclick = go;
      btns.append(cancel, ok);
    }
    card.append(msg, btns);
    // the settings modal owns the keyboard at document level (hkKey: Escape closes settings);
    // inside the form, Escape = Cancel and Enter = Save, and neither reaches settings
    ov.addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeForm(); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); go(); }
      else e.stopPropagation();
    });
    ov.addEventListener("mousedown", e => { e.stopPropagation(); if (e.target === ov) closeForm(); });
    document.body.appendChild(ov);
    (idIn || valIn || cancel).focus();
    tick();
  }

  return {
    build(pg) {   // showSettingsPage("keychain")
      closeForm();
      pg.className = "rows kcpane";
      root = el("div", "kc-root"); root.dataset.kc = "root"; pg.appendChild(root);
      st = "loading"; why = ""; q = "";
      paint(); refresh();
    },
    close: closeForm,   // settings closed or pane switched
    tok() {
      if (!live()) return "";
      const shown = ids.filter(id => !q || id.includes(q.toLowerCase())).length;
      return " [skc:" + st + "/" + ids.length + "/" + shown + "/" + formKind + "/" + seq + "] [skcmsg:" + msgCls + "]";
    },
  };
})();
