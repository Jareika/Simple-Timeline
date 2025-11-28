"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => SimpleTimeline
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var DEFAULT_SETTINGS = {
  dateFormat: "D MMMM YYYY",
  cardWidth: 200,
  cardHeight: 315,
  boxHeight: 289,
  sideGapLeft: 40,
  sideGapRight: 40,
  maxSummaryLines: 7,
  defaultColors: {},
  timelineConfigs: {},
  monthOverrides: {},
  styleOverrides: {},
  migratedLegacy: false
};
function setCssProps(el, props) {
  const style = el.style;
  for (const [name, value] of Object.entries(props)) {
    if (name.startsWith("--")) {
      style.setProperty(name, value);
    } else {
      style[name] = value;
    }
  }
}
var SimpleTimeline = class extends import_obsidian.Plugin {
  async onload() {
    await this.loadSettings();
    await this.migrateLegacyToTimelineConfigs();
    this.registerMarkdownCodeBlockProcessor(
      "timeline-cal",
      (src, el, ctx) => this.renderTimeline(src, el, ctx)
    );
    this.addCommand({
      id: "set-cal-date",
      name: "Timeline set date",
      checkCallback: (checking) => {
        const file = this.getActiveFile();
        if (!file) return false;
        if (!checking) void this.promptSetDate(file, false);
        return true;
      }
    });
    this.addCommand({
      id: "set-cal-range",
      name: "Timeline set date range",
      checkCallback: (checking) => {
        const file = this.getActiveFile();
        if (!file) return false;
        if (!checking) void this.promptSetDate(file, true);
        return true;
      }
    });
    this.addCommand({
      id: "edit-timelines",
      name: "Timeline edit timelines",
      checkCallback: (checking) => {
        const file = this.getActiveFile();
        if (!file) return false;
        if (!checking) void this.promptEditTimelines(file);
        return true;
      }
    });
    this.addCommand({
      id: "set-summary",
      name: "Timeline set summary",
      checkCallback: (checking) => {
        const file = this.getActiveFile();
        if (!file) return false;
        if (!checking) void this.promptSetSummary(file);
        return true;
      }
    });
    this.addCommand({
      id: "adopt-first-image",
      name: "Timeline use first image as tl image",
      checkCallback: (checking) => {
        const file = this.getActiveFile();
        if (!file) return false;
        if (!checking) void this.adoptFirstImage(file);
        return true;
      }
    });
    this.addSettingTab(new SimpleTimelineSettingsTab(this.app, this));
  }
  onunload() {
  }
  // ---------- UI commands ----------
  getActiveFile() {
    const f = this.app.workspace.getActiveFile();
    return f && f.extension === "md" ? f : null;
  }
  async promptSetDate(file, range) {
    const start = await promptModal(this.app, {
      title: "Set fc-date",
      placeholder: "1165-03-01 or {year: 1165, month: 3, day: 1}"
    });
    if (!start) return;
    const end = range ? await promptModal(this.app, {
      title: "Set fc-end (optional)",
      placeholder: "leave empty for no end"
    }) : null;
    await this.app.fileManager.processFrontMatter(
      file,
      (fm) => {
        try {
          fm["fc-date"] = this.tryParseYamlOrString(start);
          if (range && end) {
            fm["fc-end"] = this.tryParseYamlOrString(end);
          } else if (!range) {
            delete fm["fc-end"];
          }
        } catch {
          new import_obsidian.Notice("Invalid date.");
        }
      }
    );
  }
  async promptEditTimelines(file) {
    const cur = this.app.metadataCache.getFileCache(file)?.frontmatter?.["timelines"];
    const val = await promptModal(this.app, {
      title: "Timelines (comma-separated)",
      value: cur ? String(cur) : "",
      placeholder: "Travel, Expedition, Notes"
    });
    if (val == null) return;
    const arr = String(val).split(",").map((s) => s.trim()).filter(Boolean);
    await this.app.fileManager.processFrontMatter(
      file,
      (fm) => {
        fm["timelines"] = arr;
      }
    );
  }
  async promptSetSummary(file) {
    const cur = this.app.metadataCache.getFileCache(file)?.frontmatter?.["tl-summary"] ?? "";
    const val = await promptModal(this.app, {
      title: "Short summary",
      value: String(cur),
      placeholder: "Multi-line allowed (YAML | or |- in frontmatter)"
    });
    if (val == null) return;
    await this.app.fileManager.processFrontMatter(
      file,
      (fm) => {
        fm["tl-summary"] = String(val);
      }
    );
  }
  async adoptFirstImage(file) {
    const link = this.findImageForFile(file);
    if (!link) {
      new import_obsidian.Notice("No image found.");
      return;
    }
    await this.app.fileManager.processFrontMatter(
      file,
      (fm) => {
        fm["tl-image"] = link;
      }
    );
    new import_obsidian.Notice("Timeline image set from first image.");
  }
  tryParseYamlOrString(input) {
    const trimmed = String(input).trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}") || trimmed.includes(":")) {
      return (0, import_obsidian.parseYaml)(trimmed);
    }
    return trimmed;
  }
  // ---------- Renderer ----------
  async renderTimeline(src, el, ctx) {
    let opts = {};
    try {
      opts = (0, import_obsidian.parseYaml)(src) ?? {};
    } catch (e) {
      console.debug("simple-timeline: invalid block options", e);
    }
    const namesValue = opts.names ?? opts.name;
    const namesRaw = typeof namesValue === "string" ? namesValue.split(",").map((s) => s.trim()).filter(Boolean) : Array.isArray(namesValue) ? namesValue.map((s) => String(s).trim()).filter(Boolean) : [];
    const filterNames = namesRaw.length ? namesRaw : [];
    const files = this.app.vault.getMarkdownFiles();
    const cards = [];
    for (const f of files) {
      const cache = this.app.metadataCache.getFileCache(f);
      const fm = cache?.frontmatter;
      if (!fm) continue;
      if (!Object.prototype.hasOwnProperty.call(fm, "fc-date")) continue;
      const timelinesVal = fm["timelines"];
      const tlList = Array.isArray(timelinesVal) ? timelinesVal.map((s) => String(s)) : [];
      if (filterNames.length && !tlList.some((t) => filterNames.includes(t))) {
        continue;
      }
      const start = this.parseFcDate(fm["fc-date"]);
      if (!start) continue;
      const end = fm["fc-end"] ? this.parseFcDate(fm["fc-end"]) : void 0;
      const primaryTl = filterNames.length ? tlList.find((t) => filterNames.includes(t)) || tlList[0] : tlList[0];
      const months = this.getMonths(primaryTl);
      const mNameStart = months[(start.m - 1 + months.length) % months.length] ?? String(start.m);
      const mNameEnd = end ? months[(end.m - 1 + months.length) % months.length] ?? String(end.m) : void 0;
      const title = String(fm["tl-title"] ?? f.basename);
      const rawSummary = fm["tl-summary"];
      let summary;
      if (typeof rawSummary === "string") {
        summary = rawSummary;
      } else if (typeof rawSummary === "number" || typeof rawSummary === "boolean") {
        summary = String(rawSummary);
      } else if (rawSummary != null) {
        try {
          summary = JSON.stringify(rawSummary);
        } catch {
          summary = void 0;
        }
      }
      if (!summary) {
        summary = await this.extractFirstParagraph(f);
      }
      const imgSrc = this.resolveImageSrc(
        f,
        fm,
        ctx.sourcePath ?? f.path
      );
      cards.push({
        file: f,
        title,
        summary,
        start: { ...start, mName: mNameStart },
        end: end ? { ...end, mName: mNameEnd } : void 0,
        imgSrc,
        primaryTl
      });
    }
    cards.sort(
      (a, b) => a.start.y * 1e4 + a.start.m * 100 + a.start.d - (b.start.y * 1e4 + b.start.m * 100 + b.start.d)
    );
    const wrapper = el.createDiv({ cls: "tl-wrapper tl-cross-mode" });
    for (const c of cards) {
      const row = wrapper.createDiv({ cls: "tl-row" });
      const cfg = this.getConfigFor(c.primaryTl);
      const W = cfg.cardWidth;
      const H = cfg.cardHeight;
      const BH = cfg.boxHeight;
      setCssProps(row, {
        paddingLeft: `${cfg.sideGapLeft}px`,
        paddingRight: `${cfg.sideGapRight}px`,
        "--tl-bg": cfg.colors.bg || "var(--background-primary)",
        "--tl-accent": cfg.colors.accent || "var(--background-modifier-border)",
        "--tl-hover": cfg.colors.hover || "var(--interactive-accent)"
      });
      const grid = row.createDiv({ cls: "tl-grid" });
      setCssProps(grid, {
        display: "grid",
        alignItems: "center",
        columnGap: "0"
      });
      const hasMedia = !!c.imgSrc;
      setCssProps(grid, {
        gridTemplateColumns: hasMedia ? `${W}px 1fr` : "1fr"
      });
      let media = null;
      if (hasMedia && c.imgSrc) {
        media = grid.createDiv({ cls: "tl-media" });
        setCssProps(media, {
          width: `${W}px`,
          height: `${H}px`,
          position: "relative"
        });
        const img = media.createEl("img", {
          attr: { src: c.imgSrc, alt: c.title, loading: "lazy" }
        });
        setCssProps(img, {
          width: "100%",
          height: "100%",
          objectFit: "cover",
          display: "block"
        });
      }
      const box = grid.createDiv({
        cls: `tl-box callout ${hasMedia ? "has-media" : "no-media"}`
      });
      setCssProps(box, {
        height: `${BH}px`,
        boxSizing: "border-box",
        "--tl-bg": cfg.colors.bg || "var(--background-primary)",
        "--tl-accent": cfg.colors.accent || "var(--background-modifier-border)",
        "--tl-hover": cfg.colors.hover || "var(--interactive-accent)"
      });
      const titleEl = box.createEl("h1", {
        cls: "tl-title",
        text: c.title
      });
      const dateEl = box.createEl("h4", {
        cls: "tl-date",
        text: this.formatRange(c.start, c.end)
      });
      const sum = box.createDiv({ cls: "tl-summary" });
      titleEl.classList.add("tl-title-colored");
      dateEl.classList.add("tl-date-colored");
      if (cfg.colors.title) {
        titleEl.style.color = cfg.colors.title;
      }
      if (cfg.colors.date) {
        dateEl.style.color = cfg.colors.date;
      }
      if (c.summary) {
        sum.setText(c.summary);
      }
      if (media) {
        const aImg = media.createEl("a", {
          cls: "internal-link tl-hover-anchor",
          href: c.file.path,
          attr: { "data-href": c.file.path, "aria-label": c.title }
        });
        this.attachHoverForAnchor(aImg, media, c.file.path, ctx.sourcePath);
      }
      const aBox = box.createEl("a", {
        cls: "internal-link tl-hover-anchor",
        href: c.file.path,
        attr: { "data-href": c.file.path, "aria-label": c.title }
      });
      this.attachHoverForAnchor(aBox, box, c.file.path, ctx.sourcePath);
      this.applyFixedLineClamp(sum, cfg.maxSummaryLines);
    }
  }
  // Line clamp helper
  applyFixedLineClamp(summaryEl, lines) {
    const n = Math.max(1, Math.floor(lines || this.settings.maxSummaryLines));
    summaryEl.classList.add("tl-clamp");
    setCssProps(summaryEl, {
      "--tl-summary-lines": String(n),
      "--tl-summary-lh": "1.4"
    });
  }
  formatRange(a, b) {
    const f = (x) => `${x.d} ${x.mName ?? x.m} ${x.y}`;
    if (!b) return f(a);
    const sameDay = a.y === b.y && a.m === b.m && a.d === b.d;
    if (sameDay) return f(a);
    const sameMY = a.y === b.y && a.m === b.m;
    return sameMY ? `${a.d}\u2013${b.d} ${a.mName ?? a.m} ${a.y}` : `${f(a)} \u2013 ${f(b)}`;
  }
  parseFcDate(val) {
    if (!val) return null;
    if (typeof val === "string") {
      const m = val.trim().match(/^(\d{1,6})-(\d{1,2})-(\d{1,2})/);
      return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
    }
    const y = Number(val.year);
    const d = Number(val.day);
    const mRaw = val.month;
    let mNum;
    if (typeof mRaw === "number") {
      mNum = mRaw;
    } else {
      const months = this.getMonths();
      const idx = months.findIndex(
        (x) => x.toLowerCase() === String(mRaw).toLowerCase()
      );
      mNum = idx >= 0 ? idx + 1 : Number(mRaw) || 1;
    }
    return { y, m: mNum, d };
  }
  getMonths(calKey) {
    if (calKey) {
      const tl = this.settings.timelineConfigs[calKey];
      if (tl?.months) {
        const m = Array.isArray(tl.months) ? tl.months : String(tl.months).split(",").map((s) => s.trim()).filter(Boolean);
        if (m.length) return m;
      }
      if (!this.settings.migratedLegacy) {
        const legacy = this.settings.monthOverrides[calKey];
        if (legacy) {
          const arr = Array.isArray(legacy) ? legacy : String(legacy).split(",").map((s) => s.trim()).filter(Boolean);
          if (arr.length) return arr;
        }
      }
    }
    return [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December"
    ];
  }
  getConfigFor(name) {
    const base = {
      maxSummaryLines: this.settings.maxSummaryLines,
      cardWidth: this.settings.cardWidth,
      cardHeight: this.settings.cardHeight,
      boxHeight: this.settings.boxHeight,
      sideGapLeft: this.settings.sideGapLeft,
      sideGapRight: this.settings.sideGapRight,
      colors: {
        ...this.settings.defaultColors || {}
      },
      months: void 0
    };
    if (!name) return base;
    const tl = this.settings.timelineConfigs[name] || {};
    base.maxSummaryLines = tl.maxSummaryLines ?? base.maxSummaryLines;
    base.cardWidth = tl.cardWidth ?? base.cardWidth;
    base.cardHeight = tl.cardHeight ?? base.cardHeight;
    base.boxHeight = tl.boxHeight ?? base.boxHeight;
    base.sideGapLeft = tl.sideGapLeft ?? base.sideGapLeft;
    base.sideGapRight = tl.sideGapRight ?? base.sideGapRight;
    base.colors = { ...base.colors, ...tl.colors || {} };
    if (!this.settings.migratedLegacy) {
      const legacy = this.settings.styleOverrides[name];
      if (legacy) {
        base.colors = {
          bg: base.colors.bg ?? legacy.bg,
          accent: base.colors.accent ?? legacy.accent,
          hover: base.colors.hover,
          title: base.colors.title,
          date: base.colors.date
        };
      }
    }
    base.months = tl.months ?? (!this.settings.migratedLegacy ? this.settings.monthOverrides[name] : void 0);
    return base;
  }
  resolveImageSrc(file, fm, sourcePath) {
    const tryResolveLink = (link) => {
      if (/^https?:\/\//i.test(link)) return link;
      const dest = this.app.metadataCache.getFirstLinkpathDest(
        link,
        sourcePath
      );
      if (dest && dest instanceof import_obsidian.TFile) {
        return this.app.vault.getResourcePath(dest);
      }
      return void 0;
    };
    const fmImage = fm["tl-image"];
    if (typeof fmImage === "string") {
      const src = tryResolveLink(fmImage);
      if (src) return src;
    }
    const cache = this.app.metadataCache.getFileCache(file);
    for (const e of cache?.embeds ?? []) {
      if (/\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(e.link)) {
        const src = tryResolveLink(e.link);
        if (src) return src;
      }
    }
    for (const l of cache?.links ?? []) {
      if (/\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(l.link)) {
        const src = tryResolveLink(l.link);
        if (src) return src;
      }
    }
    const parent = this.app.vault.getAbstractFileByPath(
      file.parent?.path ?? ""
    );
    if (parent instanceof import_obsidian.TFolder) {
      for (const ch of parent.children) {
        if (ch instanceof import_obsidian.TFile && /\.(png|jpe?g|webp|gif|avif)$/i.test(ch.name)) {
          return this.app.vault.getResourcePath(ch);
        }
      }
    }
    return void 0;
  }
  findImageForFile(file) {
    const cache = this.app.metadataCache.getFileCache(file);
    for (const e of cache?.embeds ?? []) {
      if (/\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(e.link)) {
        return e.link;
      }
    }
    for (const l of cache?.links ?? []) {
      if (/\.(png|jpe?g|webp|gif|avif)$/i.test(l.link)) {
        return l.link;
      }
    }
    const parent = this.app.vault.getAbstractFileByPath(
      file.parent?.path ?? ""
    );
    if (parent instanceof import_obsidian.TFolder) {
      for (const ch of parent.children) {
        if (ch instanceof import_obsidian.TFile && /\.(png|jpe?g|webp|gif|avif)$/i.test(ch.name)) {
          return ch.path;
        }
      }
    }
    return void 0;
  }
  attachHoverForAnchor(anchorEl, hoverParent, filePath, sourcePath) {
    const openPopover = (evt) => {
      this.app.workspace.trigger("hover-link", {
        event: evt ?? new MouseEvent("mouseenter"),
        source: "simple-timeline",
        hoverParent,
        targetEl: anchorEl,
        linktext: filePath,
        sourcePath
      });
    };
    anchorEl.addEventListener(
      "mouseenter",
      (e) => openPopover(e)
    );
    let t = null;
    anchorEl.addEventListener(
      "touchstart",
      (e) => {
        t = window.setTimeout(() => openPopover(e), 350);
      },
      { passive: true }
    );
    const clear = () => {
      if (t) {
        window.clearTimeout(t);
        t = null;
      }
    };
    ["touchend", "touchmove", "touchcancel"].forEach(
      (ev) => anchorEl.addEventListener(ev, clear, { passive: true })
    );
  }
  async extractFirstParagraph(file) {
    try {
      const raw = await this.app.vault.read(file);
      const text = raw.replace(/^---[\s\S]*?---\s*/m, "");
      const paras = text.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter(Boolean);
      for (const p of paras) {
        if (/^(#{1,6}\s|>\s|[-*+]\s|\d+\.\s)/.test(p)) continue;
        let clean = p.replace(/!\[[^\]]*\]\([^)]+\)/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/`{1,3}[^`]*`{1,3}/g, "").replace(/[*_~]/g, "").replace(/\s+/g, " ").trim();
        if (clean) {
          if (clean.length > 400) clean = `${clean.slice(0, 397)}\u2026`;
          return clean;
        }
      }
    } catch (e) {
      console.debug("simple-timeline: unable to extract summary", e);
    }
    return void 0;
  }
  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  async migrateLegacyToTimelineConfigs() {
    if (this.settings.migratedLegacy) return;
    const keys = /* @__PURE__ */ new Set([
      ...Object.keys(this.settings.styleOverrides || {}),
      ...Object.keys(this.settings.monthOverrides || {})
    ]);
    for (const k of keys) {
      if (!k) continue;
      if (!this.settings.timelineConfigs[k]) {
        this.settings.timelineConfigs[k] = {};
      }
      const tl = this.settings.timelineConfigs[k];
      const so = this.settings.styleOverrides[k];
      if (so) {
        tl.colors = {
          ...tl.colors || {},
          bg: tl.colors?.bg ?? so.bg,
          accent: tl.colors?.accent ?? so.accent
        };
      }
      const mo = this.settings.monthOverrides[k];
      if (mo && !tl.months) tl.months = mo;
    }
    this.settings.migratedLegacy = true;
    this.settings.styleOverrides = {};
    this.settings.monthOverrides = {};
    await this.saveSettings();
  }
};
var InputModal = class extends import_obsidian.Modal {
  constructor(app, opts) {
    super(app);
    this.valueInit = opts.value;
    this.placeholder = opts.placeholder;
    this.titleText = opts.title;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    if (this.titleText) {
      contentEl.createEl("h3", { text: this.titleText });
    }
    const input = contentEl.createEl("input", { type: "text" });
    setCssProps(input, { width: "100%" });
    input.placeholder = this.placeholder ?? "";
    if (this.valueInit != null) input.value = this.valueInit;
    const btns = contentEl.createDiv({ cls: "modal-button-container" });
    const ok = btns.createEl("button", { text: "OK" });
    const cancel = btns.createEl("button", { text: "Cancel" });
    ok.addEventListener("click", () => {
      this.close();
      this.resolve(input.value.trim());
    });
    cancel.addEventListener("click", () => {
      this.close();
      this.resolve(null);
    });
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 50);
  }
  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
  waitForClose() {
    return new Promise((res) => {
      this.resolve = res;
    });
  }
};
async function promptModal(app, opts) {
  const m = new InputModal(app, opts);
  m.open();
  return m.waitForClose();
}
var TimelineConfigModal = class extends import_obsidian.Modal {
  constructor(app, plugin, params) {
    super(app);
    this.plugin = plugin;
    this.initialKey = params?.key;
    this.initialCfg = params?.cfg ? JSON.parse(JSON.stringify(params.cfg)) : {};
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", {
      text: this.initialKey ? "Edit timeline" : "Create timeline"
    });
    let key = this.initialKey ?? "";
    const cfg = this.initialCfg ?? {};
    const addNum = (name, prop, ph) => new import_obsidian.Setting(contentEl).setName(name).setDesc("Empty = use defaults").addText((t) => {
      const cur = cfg[prop];
      t.setPlaceholder(ph).setValue(cur != null ? String(cur) : "");
      t.onChange((v) => {
        const vv = v.trim();
        if (vv === "") {
          delete cfg[prop];
        } else {
          const n = Number(vv);
          if (Number.isFinite(n)) {
            cfg[prop] = Math.floor(n);
          }
        }
      });
    });
    new import_obsidian.Setting(contentEl).setName("Name").setDesc("Example: travel").addText(
      (t) => t.setValue(key).onChange((v) => {
        key = v.trim();
      })
    );
    addNum("Max. summary lines", "maxSummaryLines", "e.g. 7");
    addNum("Image width", "cardWidth", "e.g. 200");
    addNum("Image height", "cardHeight", "e.g. 315");
    addNum("Box height", "boxHeight", "e.g. 289");
    addNum("Inner left padding", "sideGapLeft", "e.g. 40");
    addNum("Inner right padding", "sideGapRight", "e.g. 40");
    cfg.colors || (cfg.colors = {});
    new import_obsidian.Setting(contentEl).setName("Box background").setDesc("Empty = default/theme color").addColorPicker((cp) => {
      cp.setValue(cfg.colors.bg || "");
      cp.onChange((v) => {
        cfg.colors.bg = v || void 0;
      });
    });
    new import_obsidian.Setting(contentEl).setName("Box border").setDesc("Empty = default/theme color").addColorPicker((cp) => {
      cp.setValue(cfg.colors.accent || "");
      cp.onChange((v) => {
        cfg.colors.accent = v || void 0;
      });
    });
    new import_obsidian.Setting(contentEl).setName("Hover background").setDesc("Empty = default/theme color").addColorPicker((cp) => {
      cp.setValue(cfg.colors.hover || "");
      cp.onChange((v) => {
        cfg.colors.hover = v || void 0;
      });
    });
    new import_obsidian.Setting(contentEl).setName("Title color").setDesc("Empty = default/theme color").addColorPicker((cp) => {
      cp.setValue(cfg.colors.title || "");
      cp.onChange((v) => {
        cfg.colors.title = v || void 0;
      });
    });
    new import_obsidian.Setting(contentEl).setName("Date color").setDesc("Empty = default/theme color").addColorPicker((cp) => {
      cp.setValue(cfg.colors.date || "");
      cp.onChange((v) => {
        cfg.colors.date = v || void 0;
      });
    });
    let monthsText = Array.isArray(cfg.months) && cfg.months.length > 0 ? cfg.months.join(", ") : cfg.months ?? "";
    new import_obsidian.Setting(contentEl).setName("Month names").setDesc("You can use custom month names. Example: Lunareth, Veloria, Obscyra.").addTextArea((ta) => {
      ta.inputEl.rows = 3;
      ta.setValue(monthsText);
      ta.onChange((v) => {
        monthsText = v;
      });
    });
    const btns = contentEl.createDiv({ cls: "modal-button-container" });
    const saveBtn = btns.createEl("button", { text: "Save" });
    const cancelBtn = btns.createEl("button", { text: "Cancel" });
    saveBtn.addEventListener("click", () => {
      const k = key.trim();
      if (!k) {
        new import_obsidian.Notice("Please enter a name.");
        return;
      }
      const parsedMonths = parseMonths(monthsText.trim());
      cfg.months = parsedMonths;
      this.close();
      this.resolve({ key: k, cfg });
    });
    cancelBtn.addEventListener("click", () => {
      this.close();
      this.resolve(null);
    });
  }
  onClose() {
    this.contentEl.empty();
  }
  waitForClose() {
    return new Promise((res) => {
      this.resolve = res;
    });
  }
};
function parseMonths(text) {
  if (!text) return void 0;
  try {
    if (text.includes("\n") && /(\n-|\n\s*-)/.test(text)) {
      const y = (0, import_obsidian.parseYaml)(text);
      if (Array.isArray(y)) {
        return y.map((v) => String(v)).filter(Boolean);
      }
    }
  } catch (e) {
    console.debug("simple-timeline: invalid months YAML", e);
  }
  if (text.includes(",")) {
    return text.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return text.trim();
}
var DefaultsModal = class extends import_obsidian.Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.draft = {
      cardWidth: plugin.settings.cardWidth,
      cardHeight: plugin.settings.cardHeight,
      boxHeight: plugin.settings.boxHeight,
      sideGapLeft: plugin.settings.sideGapLeft,
      sideGapRight: plugin.settings.sideGapRight,
      maxSummaryLines: plugin.settings.maxSummaryLines,
      colors: { ...plugin.settings.defaultColors || {} }
    };
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Edit defaults" });
    const addNum = (name, key, placeholder) => new import_obsidian.Setting(contentEl).setName(name).addText((t) => {
      t.setPlaceholder(placeholder);
      t.setValue(String(this.draft[key]));
      t.onChange((v) => {
        const n = Number(v);
        if (Number.isFinite(n)) {
          if (key === "maxSummaryLines") {
            this.draft.maxSummaryLines = Math.floor(n);
          } else if (key === "cardWidth") {
            this.draft.cardWidth = Math.floor(n);
          } else if (key === "cardHeight") {
            this.draft.cardHeight = Math.floor(n);
          } else if (key === "boxHeight") {
            this.draft.boxHeight = Math.floor(n);
          } else if (key === "sideGapLeft") {
            this.draft.sideGapLeft = Math.floor(n);
          } else if (key === "sideGapRight") {
            this.draft.sideGapRight = Math.floor(n);
          }
        }
      });
    });
    addNum("Image width", "cardWidth", "200");
    addNum("Image height", "cardHeight", "315");
    addNum("Box height", "boxHeight", "289");
    addNum("Inner left padding", "sideGapLeft", "40");
    addNum("Inner right padding", "sideGapRight", "40");
    addNum("Max. summary lines", "maxSummaryLines", "7");
    new import_obsidian.Setting(contentEl).setName("Box background (default)").setDesc("Empty = theme color").addColorPicker((cp) => {
      cp.setValue(this.draft.colors.bg || "");
      cp.onChange((v) => {
        this.draft.colors.bg = v || void 0;
      });
    });
    new import_obsidian.Setting(contentEl).setName("Box border (default)").setDesc("Empty = theme color").addColorPicker((cp) => {
      cp.setValue(this.draft.colors.accent || "");
      cp.onChange((v) => {
        this.draft.colors.accent = v || void 0;
      });
    });
    new import_obsidian.Setting(contentEl).setName("Hover background (default)").setDesc("Empty = var(--interactive-accent)").addColorPicker((cp) => {
      cp.setValue(this.draft.colors.hover || "");
      cp.onChange((v) => {
        this.draft.colors.hover = v || void 0;
      });
    });
    new import_obsidian.Setting(contentEl).setName("Title color (default)").setDesc("Empty = theme color").addColorPicker((cp) => {
      cp.setValue(this.draft.colors.title || "");
      cp.onChange((v) => {
        this.draft.colors.title = v || void 0;
      });
    });
    new import_obsidian.Setting(contentEl).setName("Date color (default)").setDesc("Empty = theme color").addColorPicker((cp) => {
      cp.setValue(this.draft.colors.date || "");
      cp.onChange((v) => {
        this.draft.colors.date = v || void 0;
      });
    });
    const btns = contentEl.createDiv({ cls: "modal-button-container" });
    const saveBtn = btns.createEl("button", { text: "Save" });
    const cancelBtn = btns.createEl("button", { text: "Cancel" });
    saveBtn.addEventListener("click", () => {
      const s = this.plugin.settings;
      s.cardWidth = this.draft.cardWidth;
      s.cardHeight = this.draft.cardHeight;
      s.boxHeight = this.draft.boxHeight;
      s.sideGapLeft = this.draft.sideGapLeft;
      s.sideGapRight = this.draft.sideGapRight;
      s.maxSummaryLines = Math.max(1, Math.floor(this.draft.maxSummaryLines));
      s.defaultColors = { ...this.draft.colors };
      this.close();
      this.resolve(true);
    });
    cancelBtn.addEventListener("click", () => {
      this.close();
      this.resolve(false);
    });
  }
  onClose() {
    this.contentEl.empty();
  }
  waitForClose() {
    return new Promise((res) => {
      this.resolve = res;
    });
  }
};
var SimpleTimelineSettingsTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian.Setting(containerEl).setName("Global defaults").setDesc(
      "Used by all timelines that do not define their own values (including default colors)."
    ).addButton(
      (b) => b.setButtonText("Edit").onClick(async () => {
        const saved = await openDefaultsWizard(this.app, this.plugin);
        if (saved) {
          await this.plugin.saveSettings();
          this.display();
          new import_obsidian.Notice("Defaults saved.");
        }
      })
    );
    new import_obsidian.Setting(containerEl).setName("Timeline configurations").setDesc("Custom sizes, colors and month names per timeline.").addButton(
      (b) => b.setButtonText("New timeline").onClick(async () => {
        const result = await openTimelineWizard(this.app, this.plugin);
        if (result) {
          this.display();
          new import_obsidian.Notice(`Timeline \u201C${result.key}\u201D saved.`);
        }
      })
    );
    const keys = Object.keys(this.plugin.settings.timelineConfigs).sort(
      (a, b) => a.localeCompare(b)
    );
    for (const key of keys) {
      const row = new import_obsidian.Setting(containerEl).setName(key);
      row.addButton(
        (b) => b.setButtonText("Edit").onClick(async () => {
          const result = await openTimelineWizard(
            this.app,
            this.plugin,
            key
          );
          if (result) {
            this.display();
            new import_obsidian.Notice(`Timeline \u201C${result.key}\u201D saved.`);
          }
        })
      );
      row.addButton(
        (b) => b.setWarning().setButtonText("Delete").onClick(async () => {
          delete this.plugin.settings.timelineConfigs[key];
          await this.plugin.saveSettings();
          this.display();
          new import_obsidian.Notice(`Timeline \u201C${key}\u201D deleted.`);
        })
      );
    }
    const hint = containerEl.createDiv({
      cls: "setting-item-description"
    });
    hint.textContent = "Note: older \u201Cstyles per timeline\u201D / \u201Cmonth overrides\u201D were migrated once and will not be imported again.";
  }
};
async function openTimelineWizard(app, plugin, existingKey) {
  const initCfg = existingKey ? plugin.settings.timelineConfigs[existingKey] : void 0;
  const modal = new TimelineConfigModal(app, plugin, {
    key: existingKey,
    cfg: initCfg
  });
  modal.open();
  const res = await modal.waitForClose();
  if (!res) return null;
  const { key: newKey, cfg } = res;
  if (existingKey && existingKey !== newKey) {
    if (plugin.settings.timelineConfigs[newKey]) {
      new import_obsidian.Notice("A timeline with this name already exists.");
      return null;
    }
    plugin.settings.timelineConfigs[newKey] = cfg;
    delete plugin.settings.timelineConfigs[existingKey];
  } else {
    plugin.settings.timelineConfigs[newKey] = cfg;
  }
  await plugin.saveSettings();
  return { key: newKey, cfg };
}
async function openDefaultsWizard(app, plugin) {
  const modal = new DefaultsModal(app, plugin);
  modal.open();
  const saved = await modal.waitForClose();
  if (saved) {
    await plugin.saveSettings();
  }
  return saved;
}
