// opensidian, a vault-compatible markdown notes app.
// Copyright (C) 2026 Jendrik Poloczek
// SPDX-License-Identifier: GPL-3.0-or-later
/* the "obsidian" module, part SETTINGS (api-parity stage 0: split out of
   api.js, behaviour-neutral): Modal, SuggestModal / FuzzySuggestModal, the
   setting controls (BaseComponent .. ExtraButtonComponent), Setting,
   SettingTab / PluginSettingTab, SettingGroup, SettingPage,
   ConfirmationModal, MenuItem / Menu, the app.setting hook and
   AbstractInputSuggest. Segment contract: see api-core.js. */
(function () {
  "use strict";
  const parts = window.__osApiParts || (window.__osApiParts = Object.create(null));
  const reg = (id, fn) => { if (!(id in parts)) parts[id] = fn; };
  reg("ui:modal", function (K) {
    const { host, be } = K;
    const { Component, Scope, installDom, mk, prepareFuzzySearch, renderMatches, scopes, setIcon, touch } = K;
    /* ------------------------------------------------------------- Modal */
    const openModals = [];
    class Modal {
      constructor(app) {
        installDom();
        this.app = app;
        this.scope = new Scope();
        this.shouldRestoreSelection = true;
        this.containerEl = mk("div", { cls: "modal-container os-plugin-modal" });
        this.bgEl = this.containerEl.createDiv({ cls: "modal-bg" });
        this.modalEl = this.containerEl.createDiv({ cls: "modal" });
        this.closeButtonEl = this.modalEl.createDiv({ cls: "modal-close-button", attr: { "aria-label": "Close" } });
        this.titleEl = this.modalEl.createDiv({ cls: "modal-title" });
        this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
        this.closeButtonEl.addEventListener("click", () => this.close());
        this.bgEl.addEventListener("click", () => this.close());
        this.scope.register([], "Escape", () => { this.close(); return false; });
        this._open = false;
      }
      open() {
        if (this._open) return;
        this._open = true;
        this._prevFocus = document.activeElement;
        document.body.appendChild(this.containerEl);
        openModals.push(this); scopes.push(this.scope);
        try { this.onOpen(); } catch (e) { console.error("[plugin] Modal.onOpen:", e); }
        touch();
      }
      close() {
        if (!this._open) return;
        this._open = false;
        this.containerEl.remove();
        const i = openModals.indexOf(this); if (i >= 0) openModals.splice(i, 1);
        const j = scopes.lastIndexOf(this.scope); if (j >= 0) scopes.splice(j, 1);
        try { this.onClose(); } catch (e) { console.error("[plugin] Modal.onClose:", e); }
        if (this.shouldRestoreSelection && this._prevFocus && this._prevFocus.focus) try { this._prevFocus.focus(); } catch (_) {}
        touch();
      }
      onOpen() {}
      onClose() {}
      setTitle(t) { this.titleEl.textContent = t; return this; }
      setContent(c) { this.contentEl.textContent = ""; if (c instanceof Node) this.contentEl.appendChild(c); else this.contentEl.textContent = String(c); return this; }
    }

    /* ---------------------------------------------- SuggestModal / Fuzzy */
    class SuggestModal extends Modal {
      constructor(app) {
        super(app);
        this.limit = 100;
        this.emptyStateText = "No results found.";
        this.modalEl.addClass("prompt");
        this.titleEl.remove(); this.contentEl.remove();
        this.inputEl = this.modalEl.createEl("input", { cls: "prompt-input", attr: { type: "text", spellcheck: "false" } });
        this.resultContainerEl = this.modalEl.createDiv({ cls: "prompt-results" });
        this.instructionsEl = this.modalEl.createDiv({ cls: "prompt-instructions" });
        this._items = []; this._sel = 0;
        this.inputEl.addEventListener("input", () => this._update());
        this.scope.register([], "ArrowDown", () => { this._move(1); return false; });
        this.scope.register([], "ArrowUp", () => { this._move(-1); return false; });
        this.scope.register([], "Enter", e => { this._choose(e); return false; });
      }
      setPlaceholder(p) { this.inputEl.setAttribute("placeholder", p); }
      setInstructions(list) { this.instructionsEl.empty(); for (const i of list || []) { const d = this.instructionsEl.createDiv({ cls: "prompt-instruction" }); d.createSpan({ cls: "prompt-instruction-command", text: i.command }); d.createSpan({ text: i.purpose }); } }
      onOpen() { this._update(); this.inputEl.focus(); }
      async _update() {
        let r; try { r = await this.getSuggestions(this.inputEl.value); } catch (e) { console.error(e); r = []; }
        this._items = (r || []).slice(0, this.limit); this._sel = 0;
        this.resultContainerEl.empty();
        if (!this._items.length) { this.resultContainerEl.createDiv({ cls: "suggestion-empty", text: this.emptyStateText }); touch(); return; }
        this._items.forEach((v, i) => {
          const el = this.resultContainerEl.createDiv({ cls: "suggestion-item" + (i === 0 ? " is-selected" : "") });
          try { this.renderSuggestion(v, el); } catch (e) { console.error(e); }
          el.addEventListener("mousemove", () => this._setSel(i));
          el.addEventListener("click", e => { this._sel = i; this._choose(e); });
        });
        touch();
      }
      _setSel(i) { const k = this.resultContainerEl.children; if (k[this._sel]) k[this._sel].classList.remove("is-selected"); this._sel = i; if (k[i]) { k[i].classList.add("is-selected"); k[i].scrollIntoView({ block: "nearest" }); } }
      _move(d) { if (this._items.length) this._setSel((this._sel + d + this._items.length) % this._items.length); }
      _choose(e) { const v = this._items[this._sel]; if (v !== undefined) this.selectSuggestion(v, e); }
      selectSuggestion(v, e) { this.close(); this.onChooseSuggestion(v, e); }
      getSuggestions() { return []; }
      renderSuggestion(v, el) { el.setText(String(v)); }
      onChooseSuggestion() {}
    }
    class FuzzySuggestModal extends SuggestModal {
      getSuggestions(q) {
        const f = prepareFuzzySearch(q), out = [];
        for (const item of this.getItems()) { const m = f(this.getItemText(item)); if (m) out.push({ item, match: m }); }
        if (q) out.sort((a, b) => b.match.score - a.match.score);
        return out;
      }
      renderSuggestion(fm, el) { renderMatches(el, this.getItemText(fm.item), fm.match.matches); }
      onChooseSuggestion(fm, e) { this.onChooseItem(fm.item, e); }
      getItems() { return []; }
      getItemText(i) { return String(i); }
      onChooseItem() {}
    }

    /* ------------------------------------------------- Setting + controls */
    class BaseComponent {
      constructor() { this.disabled = false; }
      then(cb) { cb(this); return this; }
      setDisabled(d) { this.disabled = !!d; return this; }
    }
    class ValueComponent extends BaseComponent {
      registerOptionListener(listeners, key) { listeners[key] = v => { if (v !== undefined) this.setValue(v); return this.getValue(); }; return this; }
    }
    class AbstractTextComponent extends ValueComponent {
      constructor(inputEl) { super(); this.inputEl = inputEl; this._cb = null; inputEl.addEventListener("input", () => this.onChanged()); }
      setDisabled(d) { super.setDisabled(d); this.inputEl.disabled = !!d; return this; }
      getValue() { return this.inputEl.value; }
      setValue(v) { this.inputEl.value = v == null ? "" : v; return this; }
      setPlaceholder(p) { this.inputEl.placeholder = p; return this; }
      onChanged() { if (this._cb) this._cb(this.getValue()); }
      onChange(cb) { this._cb = cb; return this; }
    }
    class TextComponent extends AbstractTextComponent {
      constructor(containerEl) { installDom(); super(containerEl.createEl("input", { attr: { type: "text", spellcheck: "false" } })); }
    }
    class SearchComponent extends AbstractTextComponent {
      constructor(containerEl) {
        installDom();
        const box = containerEl.createDiv({ cls: "search-input-container" });
        super(box.createEl("input", { attr: { type: "search", spellcheck: "false" } }));
        this.containerEl = box;
        this.clearButtonEl = box.createDiv({ cls: "search-input-clear-button" });
        this.clearButtonEl.addEventListener("click", () => { this.setValue(""); this.onChanged(); });
      }
      setClass(c) { this.containerEl.addClass(c); return this; }
    }
    class TextAreaComponent extends AbstractTextComponent {
      constructor(containerEl) { installDom(); super(containerEl.createEl("textarea", { attr: { spellcheck: "false" } })); }
    }
    class MomentFormatComponent extends TextComponent {
      setDefaultFormat(f) { this.defaultFormat = f; if (!this.inputEl.placeholder) this.setPlaceholder(f); return this; }
      setSampleEl(el) { this.sampleEl = el; return this; }
      updateSample() {}
    }
    class ToggleComponent extends ValueComponent {
      constructor(containerEl) {
        super(); installDom();
        this.toggleEl = containerEl.createDiv({ cls: "checkbox-container" });
        this.toggleEl.createEl("input", { attr: { type: "checkbox", tabindex: "0" } });
        this._v = false; this._cb = null;
        this.toggleEl.addEventListener("click", e => { e.preventDefault(); this.onClick(); });
      }
      setDisabled(d) { super.setDisabled(d); this.toggleEl.toggleClass("is-disabled", !!d); return this; }
      getValue() { return this._v; }
      setValue(v) { this._v = !!v; this.toggleEl.toggleClass("is-enabled", this._v); const i = this.toggleEl.querySelector("input"); if (i) i.checked = this._v; return this; }
      setTooltip(t) { this.toggleEl.setAttribute("aria-label", t); this.toggleEl.title = t; return this; }
      onClick() { if (this.disabled) return; this.setValue(!this._v); if (this._cb) this._cb(this._v); }
      onChange(cb) { this._cb = cb; return this; }
    }
    class DropdownComponent extends ValueComponent {
      constructor(containerEl) { super(); installDom(); this.selectEl = containerEl.createEl("select", { cls: "dropdown" }); this._cb = null; this.selectEl.addEventListener("change", () => { if (this._cb) this._cb(this.getValue()); }); }
      setDisabled(d) { super.setDisabled(d); this.selectEl.disabled = !!d; return this; }
      addOption(v, label) { this.selectEl.createEl("option", { value: v, text: label }); return this; }
      addOptions(o) { for (const [v, l] of Object.entries(o)) this.addOption(v, l); return this; }
      getValue() { return this.selectEl.value; }
      setValue(v) { this.selectEl.value = v; return this; }
      onChange(cb) { this._cb = cb; return this; }
    }
    class SliderComponent extends ValueComponent {
      constructor(containerEl) { super(); installDom(); this.sliderEl = containerEl.createEl("input", { cls: "slider", attr: { type: "range" } }); this._cb = null; this.sliderEl.addEventListener("input", () => { if (this._cb) this._cb(this.getValue()); }); }
      setDisabled(d) { super.setDisabled(d); this.sliderEl.disabled = !!d; return this; }
      setLimits(min, max, step) { if (min != null) this.sliderEl.min = min; if (max != null) this.sliderEl.max = max; this.sliderEl.step = step === "any" || step == null ? "any" : step; return this; }
      getValue() { return +this.sliderEl.value; }
      setValue(v) { this.sliderEl.value = v; return this; }
      getValuePretty() { return String(this.getValue()); }
      setDynamicTooltip() { return this; }
      showTooltip() {}
      setInstant() { return this; }
      onChange(cb) { this._cb = cb; return this; }
    }
    class ColorComponent extends ValueComponent {
      constructor(containerEl) { super(); installDom(); this.colorPickerEl = containerEl.createEl("input", { attr: { type: "color" } }); this._cb = null; this.colorPickerEl.addEventListener("input", () => { if (this._cb) this._cb(this.getValue()); }); }
      setDisabled(d) { super.setDisabled(d); this.colorPickerEl.disabled = !!d; return this; }
      getValue() { return this.colorPickerEl.value; }
      setValue(v) { this.colorPickerEl.value = v; return this; }
      getValueRgb() { const h = this.getValue().replace("#", ""); return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }; }
      setValueRgb(c) { const x = n => (n | 0).toString(16).padStart(2, "0"); return this.setValue("#" + x(c.r) + x(c.g) + x(c.b)); }
      getValueHsl() { return { h: 0, s: 0, l: 0 }; }
      setValueHsl() { return this; }
      onChange(cb) { this._cb = cb; return this; }
    }
    class ButtonComponent extends BaseComponent {
      constructor(containerEl) { super(); installDom(); this.buttonEl = containerEl.createEl("button"); this._cb = null; this.buttonEl.addEventListener("click", e => { if (!this.disabled && this._cb) this._cb(e); }); }
      setDisabled(d) { super.setDisabled(d); this.buttonEl.disabled = !!d; return this; }
      setCta() { this.buttonEl.addClass("mod-cta"); return this; }
      removeCta() { this.buttonEl.removeClass("mod-cta"); return this; }
      setWarning() { this.buttonEl.addClass("mod-warning"); return this; }
      setTooltip(t) { this.buttonEl.setAttribute("aria-label", t); this.buttonEl.title = t; return this; }
      setButtonText(t) { this.buttonEl.textContent = t; return this; }
      setIcon(i) { setIcon(this.buttonEl, i); return this; }
      setClass(c) { this.buttonEl.addClass(c); return this; }
      onClick(cb) { this._cb = cb; return this; }
    }
    class ExtraButtonComponent extends BaseComponent {
      constructor(containerEl) { super(); installDom(); this.extraSettingsEl = containerEl.createDiv({ cls: "clickable-icon extra-setting-button" }); this._cb = null; this.extraSettingsEl.addEventListener("click", () => { if (!this.disabled && this._cb) this._cb(); }); }
      setDisabled(d) { super.setDisabled(d); this.extraSettingsEl.toggleClass("is-disabled", !!d); return this; }
      setTooltip(t) { this.extraSettingsEl.setAttribute("aria-label", t); this.extraSettingsEl.title = t; return this; }
      setIcon(i) { setIcon(this.extraSettingsEl, i); return this; }
      onClick(cb) { this._cb = cb; return this; }
    }
    class Setting {
      constructor(containerEl) {
        installDom();
        this.settingEl = containerEl.createDiv({ cls: "setting-item" });
        this.infoEl = this.settingEl.createDiv({ cls: "setting-item-info" });
        this.nameEl = this.infoEl.createDiv({ cls: "setting-item-name" });
        this.descEl = this.infoEl.createDiv({ cls: "setting-item-description" });
        this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
        this.components = [];
      }
      setName(n) { this.nameEl.setText(n); return this; }
      setDesc(d) { this.descEl.setText(d); return this; }
      setClass(c) { this.settingEl.addClass(c); return this; }
      setTooltip(t) { this.nameEl.title = t; return this; }
      setHeading() { this.settingEl.addClass("setting-item-heading"); return this; }
      setDisabled(d) { this.settingEl.toggleClass("is-disabled", !!d); for (const c of this.components) c.setDisabled && c.setDisabled(d); return this; }
      _add(C, cb) { const c = new C(this.controlEl); this.components.push(c); if (cb) cb(c); return this; }
      addButton(cb) { return this._add(ButtonComponent, cb); }
      addExtraButton(cb) { return this._add(ExtraButtonComponent, cb); }
      addToggle(cb) { return this._add(ToggleComponent, cb); }
      addText(cb) { return this._add(TextComponent, cb); }
      addSearch(cb) { return this._add(SearchComponent, cb); }
      addTextArea(cb) { return this._add(TextAreaComponent, cb); }
      addMomentFormat(cb) { return this._add(MomentFormatComponent, cb); }
      addDropdown(cb) { return this._add(DropdownComponent, cb); }
      addColorPicker(cb) { return this._add(ColorComponent, cb); }
      addSlider(cb) { return this._add(SliderComponent, cb); }
      then(cb) { cb(this); return this; }
      clear() { this.controlEl.empty(); this.components = []; return this; }
    }
    class SettingTab {
      constructor() { installDom(); this.containerEl = mk("div", { cls: "vertical-tab-content" }); }
      display() {}
      hide() { this.containerEl.empty(); }
    }
    class PluginSettingTab extends SettingTab {
      constructor(app, plugin) { super(); this.app = app; this.plugin = plugin; }
    }
    /* td-census-fix: Templater 2.25.0 (minAppVersion 1.13.0) subclasses these at
       module scope, so without them it cannot even load. Bounded shapes: enough
       for a settings page / confirmation dialog to render and answer, not the
       whole declarative settings model.
         SettingGroup(containerEl): a .setting-group with an optional heading;
           addSetting(cb) appends a Setting to its items.
         SettingPage: a sub-page of a settings tab (containerEl, display/update/hide).
         ConfirmationModal(app): a Modal with a button row — addButton(cb),
           addCheckbox(label, cb(checked)), addCancelButton(). */
    class SettingGroup {
      constructor(containerEl) {
        installDom();
        this.groupEl = containerEl.createDiv({ cls: "setting-group" });
        this.headerEl = this.groupEl.createDiv({ cls: "setting-group-heading setting-item-heading" }); this.headerEl.hidden = true;
        this.listEl = this.groupEl.createDiv({ cls: "setting-items" });
      }
      setHeading(t) { this.headerEl.hidden = false; this.headerEl.textContent = ""; if (t instanceof Node) this.headerEl.appendChild(t); else this.headerEl.textContent = String(t); return this; }
      addClass(c) { this.groupEl.addClass(c); return this; }
      addSetting(cb) { const s = new Setting(this.listEl); if (cb) cb(s); return this; }
    }
    class SettingPage {
      constructor() { installDom(); this.app = K.app; this.containerEl = mk("div", { cls: "setting-page" }); this.icon = ""; }
      display() {}
      update() { this.containerEl.empty(); this.display(); }
      hide() { this.containerEl.empty(); }
    }
    class ConfirmationModal extends Modal {
      constructor(app_) { super(app_); this.buttonContainerEl = this.modalEl.createDiv({ cls: "modal-button-container" }); }
      addButton(cb) { const b = new ButtonComponent(this.buttonContainerEl); if (cb) cb(b); return this; }
      addCheckbox(label, cb) {
        const l = this.buttonContainerEl.createEl("label", { cls: "mod-checkbox" });
        const i = l.createEl("input", { attr: { type: "checkbox" } }); l.appendText(" " + String(label));
        i.addEventListener("change", () => { if (cb) cb(i.checked); });
        return this;
      }
      addCancelButton(cb) { return this.addButton(b => { b.setButtonText("Cancel").onClick(() => { this.close(); if (cb) cb(); }); }); }
    }

    /* -------------------------------------------------------------- Menu
       Shown through main.js's own context-menu machine (placeMenu/closeMenu),
       so a plugin menu looks like ours and publishes the same [menu:] census. */
    class MenuItem {
      constructor(menu) {
        this.menu = menu;
        this.dom = document.createElement("div");
        this.dom.className = "menu-item";
        this.iconEl = document.createElement("span"); this.iconEl.className = "menu-item-icon";
        this.titleEl = document.createElement("span"); this.titleEl.className = "menu-item-title";
        this.dom.append(this.iconEl, this.titleEl);
        this.callback = null; this.section = "";
        this.dom.onmousedown = e => e.stopPropagation();
        this.dom.onclick = e => { if (this.disabled) return; menu.hide(); if (this.callback) try { this.callback(e); } catch (er) { console.error("[plugin] menu item:", er); } };
      }
      setTitle(t) { if (t instanceof Node) { this.titleEl.textContent = ""; this.titleEl.appendChild(t); } else this.titleEl.textContent = t; return this; }
      setIcon(i) { if (i) setIcon(this.iconEl, i); else this.iconEl.textContent = ""; return this; }
      setChecked(c) { this.dom.classList.toggle("mod-checked", !!c); return this; }
      setDisabled(d) { this.disabled = !!d; this.dom.classList.toggle("dis", !!d); return this; }
      setIsLabel(l) { this.dom.classList.toggle("is-label", !!l); return this; }
      setWarning(w) { this.dom.classList.toggle("mod-warning", !!w); return this; }
      setSection(s) { this.section = s; return this; }
      onClick(cb) { this.callback = cb; return this; }
      setSubmenu() { return new Menu(); }
    }
    class Menu extends Component {
      constructor() { super(); this.items = []; this._hide = []; this.dom = null; }
      setNoIcon() { return this; }
      setUseNativeMenu() { return this; }
      addItem(cb) { const it = new MenuItem(this); this.items.push(it); cb(it); return this; }
      addSeparator() { this.items.push(null); return this; }
      showAtMouseEvent(e) { return this.showAtPosition({ x: e.clientX, y: e.clientY }); }
      showAtPosition(p) {
        installDom();
        if (typeof closeMenu === "function") closeMenu();
        const m = document.createElement("div");
        m.className = "ctxmenu menu os-plugin-menu";
        for (const it of this.items) {
          if (it === null) { const s = document.createElement("div"); s.className = "sep"; m.appendChild(s); }
          else m.appendChild(it.dom);
        }
        this.dom = m;
        if (typeof placeMenu === "function") placeMenu(m, p.x, p.y);
        else { m.style.left = p.x + "px"; m.style.top = p.y + "px"; document.body.appendChild(m); }
        this.load();
        // main.js closes menus from its document mousedown / Escape; notice that
        const watch = () => { if (this.dom && !this.dom.isConnected) this._closed(); };
        this._mo = new MutationObserver(watch); this._mo.observe(document.body, { childList: true });
        return this;
      }
      _closed() { if (this._mo) this._mo.disconnect(); this._mo = null; const d = this.dom; this.dom = null; if (!d) return; this.unload(); for (const f of this._hide.splice(0)) try { f(); } catch (e) { console.error(e); } }
      hide() { if (this.dom && typeof closeMenu === "function" && typeof menuEl !== "undefined" && menuEl === this.dom) closeMenu(); else if (this.dom) this.dom.remove(); this._closed(); }
      close() { this.hide(); }
      onHide(cb) { this._hide.push(cb); }
      static forEvent(e) { const m = new Menu(); m._evt = e; return m; }
    }

    Object.assign(K, { AbstractTextComponent, BaseComponent, ButtonComponent, ColorComponent, ConfirmationModal, DropdownComponent, ExtraButtonComponent, FuzzySuggestModal, Menu, MenuItem, Modal, MomentFormatComponent, PluginSettingTab, SearchComponent, Setting, SettingGroup, SettingPage, SettingTab, SliderComponent, SuggestModal, TextAreaComponent, TextComponent, ToggleComponent, ValueComponent, openModals });
  });
  reg("ui:setting", function (K) {
    const { host, be } = K;
    const tabsChanged = () => { const s = window.__osPluginSettings; if (s) try { s.tabsChanged(); } catch (e) { console.error(e); } };
    const setting = {   // Settings modal hook — ui/plugins/settings.js renders the tabs (item 6)
      activeTab: null, pluginTabs: [],
      open() { if (typeof openSettings === "function" && typeof settingsOpen !== "undefined" && !settingsOpen) openSettings(); },
      close() { if (typeof closeSettings === "function") closeSettings(); },
      openTabById(id) { if (typeof openPluginSettingTab === "function") return openPluginSettingTab(id); setting.open(); },
      closeActiveTab() { if (setting.activeTab) { try { setting.activeTab.hide(); } catch (_) {} setting.activeTab = null; } },
      addSettingTab(t) { setting.pluginTabs.push(t); tabsChanged(); },
      removeSettingTab(t) { const i = setting.pluginTabs.indexOf(t); if (i >= 0) { setting.pluginTabs.splice(i, 1); tabsChanged(); } },
    };
    Object.assign(K, { setting });
  });
  reg("ui:inputsuggest", function (K) {
    const { host, be } = K;
    const { EA, td } = K;
    /* AbstractInputSuggest (td-census-fix: Templater 2.25.0's folder/file pickers
       in its settings tab subclass it, at module scope): a suggestion popover bound
       to an <input> / contenteditable. Typing calls getSuggestions(value); a click
       or Enter calls selectSuggestion(item, evt), whose default hands the item to
       the onSelect callback; Escape / blur close it. */
    class AbstractInputSuggest extends (EA ? EA.PopoverSuggest : class { constructor(a) { this.app = a; this.isOpen = false; this.suggestEl = document.createElement("div"); } open() { this.isOpen = true; } close() { this.isOpen = false; } }) {
      constructor(app_, textInputEl) {
        super(app_);
        this.textInputEl = textInputEl; this.limit = 100; this._cb = null; this._items = []; this._sel = 0;
        this.suggestEl.className = "suggestion-container os-isug"; this.suggestEl.hidden = true;
        const el = textInputEl;
        if (!el || typeof el.addEventListener !== "function") return;
        el.addEventListener("input", () => this._refresh());
        el.addEventListener("focus", () => this._refresh());
        el.addEventListener("blur", () => setTimeout(() => this.close(), 150));
        el.addEventListener("keydown", e => {
          if (!this.isOpen || !this._items.length) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); this._sel = (this._sel + (e.key === "ArrowDown" ? 1 : this._items.length - 1)) % this._items.length; this._draw(); }
          else if (e.key === "Enter") { e.preventDefault(); this._choose(this._sel, e); }
          else if (e.key === "Escape") { e.preventDefault(); this.close(); }
        });
      }
      getValue() { const el = this.textInputEl; return el ? (el.isContentEditable ? el.textContent : String(el.value || "")) : ""; }
      setValue(v) { const el = this.textInputEl; if (!el) return; if (el.isContentEditable) el.textContent = String(v); else el.value = String(v); }
      onSelect(cb) { this._cb = cb; return this; }
      getSuggestions() { return []; }
      selectSuggestion(item, evt) { if (this._cb) this._cb(item, evt); }
      _refresh() {
        const q = this.getValue();
        Promise.resolve().then(() => this.getSuggestions(q)).then(items => {
          this._items = (items || []).slice(0, this.limit || 100); this._sel = 0;
          if (!this._items.length || document.activeElement !== this.textInputEl) { this.close(); return; }
          this._draw();
        }).catch(e => console.error("[plugin] AbstractInputSuggest.getSuggestions:", e));
      }
      _draw() {
        const el = this.suggestEl; el.textContent = "";
        this._items.forEach((it, i) => {
          const d = document.createElement("div");
          d.className = "suggestion-item" + (i === this._sel ? " is-selected" : "");
          try { this.renderSuggestion(it, d); } catch (e) { console.error("[plugin] renderSuggestion:", e); }
          d.addEventListener("mousedown", e => { e.preventDefault(); this._choose(i, e); });
          el.appendChild(d);
        });
        const r = this.textInputEl.getBoundingClientRect();
        Object.assign(el.style, { position: "fixed", left: r.left + "px", top: r.bottom + "px", minWidth: r.width + "px", zIndex: 1000 });
        if (el.parentNode !== document.body) document.body.appendChild(el);
        el.hidden = false; this.open();
      }
      _choose(i, e) {
        const it = this._items[i]; if (it === undefined) return;
        try { this.selectSuggestion(it, e); } catch (er) { console.error("[plugin] selectSuggestion:", er); }
        this.close();
      }
      close() { super.close(); this.suggestEl.hidden = true; this.suggestEl.textContent = ""; this._items = []; }
    }
    Object.assign(K, { AbstractInputSuggest });
  });
})();
