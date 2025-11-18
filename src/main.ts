import {
  App,
  MarkdownPostProcessorContext,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  parseYaml
} from "obsidian";

/* =========================================
   Settings model
   ========================================= */

interface TimelineConfig {
  maxSummaryLines?: number;
  cardWidth?: number;
  cardHeight?: number;
  boxHeight?: number;
  sideGapLeft?: number;
  sideGapRight?: number;
  colors?: {
    bg?: string;
    accent?: string;
    hover?: string;
    title?: string;
    date?: string;
  };
  months?: string[] | string;
}

interface SimpleTimelineSettings {
  // Global defaults (used when a timeline has no own override)
  dateFormat: "D MMMM YYYY";
  cardWidth: number;
  cardHeight: number;
  boxHeight: number;
  sideGapLeft: number;
  sideGapRight: number;
  maxSummaryLines: number;

  // Global default colors
  defaultColors: {
    bg?: string;
    accent?: string;
    hover?: string;
    title?: string;
    date?: string;
  };

  // Per‑timeline configuration
  timelineConfigs: Record<string, TimelineConfig>;

  // Legacy fields (migrated into timelineConfigs once)
  monthOverrides: Record<string, string | string[]>;
  styleOverrides: Record<string, { bg?: string; accent?: string }>;

  // Migration flag
  migratedLegacy?: boolean;
}

const DEFAULT_SETTINGS: SimpleTimelineSettings = {
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

/* =========================================
   Data types for renderer
   ========================================= */

type FCDate =
  | string
  | { year: number; month: number | string; day: number };

type CardData = {
  file: TFile;
  title: string;
  summary?: string;
  start: { y: number; m: number; d: number; mName?: string };
  end?: { y: number; m: number; d: number; mName?: string };
  imgSrc?: string;
  primaryTl?: string;
};

/* =========================================
   Main plugin
   ========================================= */

export default class SimpleTimeline extends Plugin {
  settings: SimpleTimelineSettings;

  async onload() {
    await this.loadSettings();
    await this.migrateLegacyToTimelineConfigs();

    this.registerMarkdownCodeBlockProcessor(
      "timeline-cal",
      async (src, el, ctx) => this.renderTimeline(src, el, ctx)
    );

    this.addCommand({
      id: "set-cal-date",
      name: "Timeline: Set date",
      checkCallback: (checking) => {
        const file = this.getActiveFile();
        if (!file) return false;
        if (!checking) this.promptSetDate(file, false);
        return true;
      }
    });
    this.addCommand({
      id: "set-cal-range",
      name: "Timeline: Set date range",
      checkCallback: (checking) => {
        const file = this.getActiveFile();
        if (!file) return false;
        if (!checking) this.promptSetDate(file, true);
        return true;
      }
    });
    this.addCommand({
      id: "edit-timelines",
      name: "Timeline: Edit timelines",
      checkCallback: (checking) => {
        const file = this.getActiveFile();
        if (!file) return false;
        if (!checking) this.promptEditTimelines(file);
        return true;
      }
    });
    this.addCommand({
      id: "set-summary",
      name: "Timeline: Set summary",
      checkCallback: (checking) => {
        const file = this.getActiveFile();
        if (!file) return false;
        if (!checking) this.promptSetSummary(file);
        return true;
      }
    });
    this.addCommand({
      id: "adopt-first-image",
      name: "Timeline: Use first image as tl-image",
      checkCallback: (checking) => {
        const file = this.getActiveFile();
        if (!file) return false;
        if (!checking) this.adoptFirstImage(file);
        return true;
      }
    });

    this.addSettingTab(new SimpleTimelineSettingsTab(this.app, this));
  }

  onunload() {}

  // ---------- UI commands ----------

  private getActiveFile(): TFile | null {
    const f = this.app.workspace.getActiveFile();
    return f && f.extension === "md" ? f : null;
  }

  private async promptSetDate(file: TFile, range: boolean) {
    const start = await promptModal(this.app, {
      title: "Set fc-date",
      placeholder: "1165-03-01 or {year: 1165, month: 3, day: 1}"
    });
    if (!start) return;
    const end = range
      ? await promptModal(this.app, {
          title: "Set fc-end (optional)",
          placeholder: "leave empty for no end"
        })
      : null;

    await this.app.fileManager.processFrontMatter(file, (fm) => {
      try {
        fm["fc-date"] = this.tryParseYamlOrString(start);
        if (range && end) fm["fc-end"] = this.tryParseYamlOrString(end);
        else if (!range) delete fm["fc-end"];
      } catch {
        new Notice("Invalid date.");
      }
    });
  }

  private async promptEditTimelines(file: TFile) {
    const cur = this.app.metadataCache.getFileCache(file)?.frontmatter?.["timelines"];
    const val = await promptModal(this.app, {
      title: "Timelines (comma-separated)",
      value: cur ? String(cur) : "",
      placeholder: "Travel, Expedition, Notes"
    });
    if (val == null) return;
    const arr = String(val).split(",").map((s) => s.trim()).filter(Boolean);
    await this.app.fileManager.processFrontMatter(file, (fm) => (fm["timelines"] = arr));
  }

  private async promptSetSummary(file: TFile) {
    const cur = this.app.metadataCache.getFileCache(file)?.frontmatter?.["tl-summary"] ?? "";
    const val = await promptModal(this.app, {
      title: "Short summary",
      value: String(cur),
      placeholder: "Multi-line allowed (YAML | or |- in frontmatter)"
    });
    if (val == null) return;
    await this.app.fileManager.processFrontMatter(file, (fm) => (fm["tl-summary"] = String(val)));
  }

  private async adoptFirstImage(file: TFile) {
    const link = await this.findImageForFile(file);
    if (!link) {
      new Notice("No image found.");
      return;
    }
    await this.app.fileManager.processFrontMatter(file, (fm) => (fm["tl-image"] = link));
    new Notice("tl-image set from first image.");
  }

  private tryParseYamlOrString(input: string): any {
    const trimmed = String(input).trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || trimmed.includes(":"))
      return parseYaml(trimmed);
    return trimmed;
  }

  // ---------- Renderer ----------

  private async renderTimeline(src: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    // Code block options
    let opts: any = {};
    try { opts = parseYaml(src) ?? {}; } catch {}
    const namesRaw: string[] = (
      Array.isArray(opts.names) ? opts.names : (opts.name ? [opts.name] : String(opts.names ?? "").split(","))
    ).map((s) => String(s).trim()).filter(Boolean);
    const filterNames = namesRaw.length ? namesRaw : [];

    // Collect card data
    const files = this.app.vault.getMarkdownFiles();
    const cards: CardData[] = [];
    for (const f of files) {
      const cache = this.app.metadataCache.getFileCache(f);
      const fm: any = cache?.frontmatter;
      if (!fm) continue;
      if (!("fc-date" in fm)) continue;

      const tlList = Array.isArray(fm["timelines"]) ? fm["timelines"].map((s: any) => String(s)) : [];
      if (filterNames.length && !tlList.some((t) => filterNames.includes(t))) continue;

      const start = this.parseFcDate(fm["fc-date"]);
      if (!start) continue;
      const end = fm["fc-end"] ? this.parseFcDate(fm["fc-end"]) : undefined;

      const primaryTl = filterNames.length ? tlList.find((t) => filterNames.includes(t)) || tlList[0] : tlList[0];

      const months = this.getMonths(primaryTl);
      const mNameStart = months[(start.m - 1 + months.length) % months.length] ?? String(start.m);
      const mNameEnd = end ? months[(end.m - 1 + months.length) % months.length] ?? String(end.m) : undefined;

      const title = String(fm["tl-title"] ?? f.basename);

      let summary: string | undefined = fm["tl-summary"] ? String(fm["tl-summary"]) : undefined;
      // If no explicit tl-summary, take the first meaningful paragraph from the note
      if (!summary) {
        summary = await this.extractFirstParagraph(f);
      }

      const imgSrc = await this.resolveImageSrc(f, fm, ctx.sourcePath);

      cards.push({
        file: f,
        title,
        summary,
        start: { ...start, mName: mNameStart },
        end: end ? { ...end, mName: mNameEnd } : undefined,
        imgSrc,
        primaryTl
      });
    }

    // Sort by start date
    cards.sort((a, b) => (a.start.y*10000 + a.start.m*100 + a.start.d) - (b.start.y*10000 + b.start.m*100 + b.start.d));

    // Render
    const wrapper = el.createDiv({ cls: "tl-wrapper tl-cross-mode" });

    for (const c of cards) {
      const row = wrapper.createDiv({ cls: "tl-row" }) as HTMLDivElement;

      // Config for this timeline
      const cfg = this.getConfigFor(c.primaryTl);

      // Fixed dimensions (inline)
      const W = cfg.cardWidth;
      const H = cfg.cardHeight;
      const BH = cfg.boxHeight;
      row.style.paddingLeft = `${cfg.sideGapLeft}px`;
      row.style.paddingRight = `${cfg.sideGapRight}px`;

      // Colors as CSS variables on the row (for both image and box)
      row.style.setProperty("--tl-bg", cfg.colors.bg || "var(--background-primary)");
      row.style.setProperty("--tl-accent", cfg.colors.accent || "var(--background-modifier-border)");
      row.style.setProperty("--tl-hover", cfg.colors.hover || "var(--interactive-accent)");

      const grid = row.createDiv({ cls: "tl-grid" }) as HTMLDivElement;
      grid.style.display = "grid";
      grid.style.alignItems = "center";
      grid.style.columnGap = "0";

      const hasMedia = !!c.imgSrc;
      grid.style.gridTemplateColumns = hasMedia ? `${W}px 1fr` : `1fr`;

      let media: HTMLDivElement | null = null;
      if (hasMedia) {
        media = grid.createDiv({ cls: "tl-media" }) as HTMLDivElement;
        media.style.width = `${W}px`;
        media.style.height = `${H}px`;
        media.style.position = "relative";

        const img = media.createEl("img", { attr: { src: c.imgSrc!, alt: c.title, loading: "lazy" } }) as HTMLImageElement;
        img.style.width = "100%";
        img.style.height = "100%";
        img.style.objectFit = "cover";
        img.style.display = "block";
      }

      const box = grid.createDiv({ cls: `tl-box callout ${hasMedia ? "has-media" : "no-media"}` }) as HTMLDivElement;
      box.style.height = `${BH}px`;
      box.style.boxSizing = "border-box";
      // Also set colors on the box itself (for themes that don't pick up row vars)
      box.style.setProperty("--tl-bg", cfg.colors.bg || "var(--background-primary)");
      box.style.setProperty("--tl-accent", cfg.colors.accent || "var(--background-modifier-border)");
      box.style.setProperty("--tl-hover", cfg.colors.hover || "var(--interactive-accent)");

      const titleEl = box.createEl("h1", { cls: "tl-title", text: c.title });
      const dateEl = box.createEl("h4", { cls: "tl-date", text: this.formatRange(c.start, c.end) });
      const sum = box.createDiv({ cls: "tl-summary" });

      // Apply custom title/date colors for this timeline (if set)
      if (cfg.colors.title) {
        titleEl.style.color = cfg.colors.title;
        titleEl.classList.add("tl-title-colored");
      }
      if (cfg.colors.date) {
        dateEl.style.color = cfg.colors.date;
        dateEl.classList.add("tl-date-colored");
      }

      if (c.summary) sum.setText(c.summary);

      // Popover: only image (if present) and box
      if (media) {
        const aImg = media.createEl("a", {
          cls: "internal-link tl-hover-anchor",
          href: c.file.path,
          attr: { "data-href": c.file.path, "aria-label": c.title }
        }) as HTMLAnchorElement;
        this.attachHoverForAnchor(aImg, media, c.file.path, ctx.sourcePath);
      }
      const aBox = box.createEl("a", {
        cls: "internal-link tl-hover-anchor",
        href: c.file.path,
        attr: { "data-href": c.file.path, "aria-label": c.title }
      }) as HTMLAnchorElement;
      this.attachHoverForAnchor(aBox, box, c.file.path, ctx.sourcePath);

      // Ensure exactly maxSummaryLines lines are visible (ellipsis on the last one)
      this.applyFixedLineClamp(sum, cfg.maxSummaryLines);
    }
  }

  // Line clamp helper
  private applyFixedLineClamp(summaryEl: HTMLElement, lines: number) {
    const n = Math.max(1, Math.floor(lines || this.settings.maxSummaryLines));
    summaryEl.classList.add("tl-clamp");
    summaryEl.style.setProperty("--tl-summary-lines", String(n));
    summaryEl.style.setProperty("--tl-summary-lh", "1.4");
    (summaryEl.style as any).display = "-webkit-box";
    (summaryEl.style as any).WebkitBoxOrient = "vertical";
    (summaryEl.style as any).WebkitLineClamp = String(n);
    summaryEl.style.maxHeight = `calc(${n} * 1.4em)`;
    summaryEl.style.overflow = "hidden";
  }

  private formatRange(
    a: { y: number; m: number; d: number; mName?: string },
    b?: { y: number; m: number; d: number; mName?: string }
  ) {
    const f = (x: typeof a) => `${x.d} ${x.mName ?? x.m} ${x.y}`;

    if (!b) return f(a);

    // Same start and end day: show a single date, not "1–1"
    const sameDay = a.y === b.y && a.m === b.m && a.d === b.d;
    if (sameDay) return f(a);

    const sameMY = a.y === b.y && a.m === b.m;
    return sameMY ? `${a.d}–${b.d} ${a.mName ?? a.m} ${a.y}` : `${f(a)} – ${f(b)}`;
  }

  private parseFcDate(val: FCDate): { y: number; m: number; d: number } | null {
    if (typeof val === "string") {
      const m = val.trim().match(/^(\d{1,6})-(\d{1,2})-(\d{1,2})/);
      return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
    } else if (val && typeof val === "object") {
      const y = Number(val.year);
      const d = Number(val.day);
      const mRaw = (val as any).month;
      let m: number;
      if (typeof mRaw === "number") m = mRaw;
      else {
        const months = this.getMonths();
        const idx = months.findIndex((x) => x.toLowerCase() === String(mRaw).toLowerCase());
        m = idx >= 0 ? idx + 1 : Number(mRaw) || 1;
      }
      return { y, m, d };
    }
    return null;
  }

  private getMonths(calKey?: string): string[] {
    // 1) Per-timeline config
    if (calKey) {
      const tl = this.settings.timelineConfigs[calKey];
      if (tl?.months) {
        const m = Array.isArray(tl.months) ? tl.months : String(tl.months).split(",").map((s) => s.trim()).filter(Boolean);
        if (m.length) return m;
      }
      // 2) Legacy (only used before migration)
      if (!this.settings.migratedLegacy) {
        const legacy = this.settings.monthOverrides[calKey];
        if (legacy) {
          const arr = Array.isArray(legacy) ? legacy : String(legacy).split(",").map((s) => s.trim()).filter(Boolean);
          if (arr.length) return arr;
        }
      }
    }
    // 3) Default: English month names
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

  private getConfigFor(name?: string): {
    maxSummaryLines: number;
    cardWidth: number;
    cardHeight: number;
    boxHeight: number;
    sideGapLeft: number;
    sideGapRight: number;
    colors: { bg?: string; accent?: string; hover?: string; title?: string; date?: string };
    months?: string[] | string;
  } {
    const base = {
      maxSummaryLines: this.settings.maxSummaryLines,
      cardWidth: this.settings.cardWidth,
      cardHeight: this.settings.cardHeight,
      boxHeight: this.settings.boxHeight,
      sideGapLeft: this.settings.sideGapLeft,
      sideGapRight: this.settings.sideGapRight,
      colors: {
        ...(this.settings.defaultColors || {})
      } as { bg?: string; accent?: string; hover?: string; title?: string; date?: string },
      months: undefined as string[] | string | undefined
    };
    if (!name) return base;

    const tl = this.settings.timelineConfigs[name] || {};
    base.maxSummaryLines = tl.maxSummaryLines ?? base.maxSummaryLines;
    base.cardWidth = tl.cardWidth ?? base.cardWidth;
    base.cardHeight = tl.cardHeight ?? base.cardHeight;
    base.boxHeight = tl.boxHeight ?? base.boxHeight;
    base.sideGapLeft = tl.sideGapLeft ?? base.sideGapLeft;
    base.sideGapRight = tl.sideGapRight ?? base.sideGapRight;
    base.colors = { ...base.colors, ...(tl.colors || {}) };

    // Legacy styleOverrides
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

    base.months = tl.months ?? (!this.settings.migratedLegacy ? this.settings.monthOverrides[name] : undefined);
    return base;
  }

  private async resolveImageSrc(file: TFile, fm: any, sourcePath: string): Promise<string | undefined> {
    const tryResolveLink = (link: string): string | undefined => {
      if (/^https?:\/\//i.test(link)) return link;
      const dest = this.app.metadataCache.getFirstLinkpathDest(link, sourcePath);
      if (dest && dest instanceof TFile) return this.app.vault.getResourcePath(dest);
      return undefined;
    };

    if (fm?.["tl-image"]) {
      const src = tryResolveLink(String(fm["tl-image"]));
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
    const parent = this.app.vault.getAbstractFileByPath(file.parent?.path ?? "");
    if (parent && "children" in parent) {
      for (const ch of (parent as any).children as TAbstractFile[]) {
        if (ch instanceof TFile && /\.(png|jpe?g|webp|gif|avif)$/i.test(ch.name)) {
          return this.app.vault.getResourcePath(ch);
        }
      }
    }
    return undefined;
  }

  private async findImageForFile(file: TFile): Promise<string | undefined> {
    const cache = this.app.metadataCache.getFileCache(file);
    for (const e of cache?.embeds ?? []) {
      if (/\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(e.link)) return e.link;
    }
    for (const l of cache?.links ?? []) {
      if (/\.(png|jpe?g|webp|gif|avif)$/i.test(l.link)) return l.link;
    }
    const parent = this.app.vault.getAbstractFileByPath(file.parent?.path ?? "");
    if (parent && "children" in parent) {
      for (const ch of (parent as any).children as TAbstractFile[]) {
        if (ch instanceof TFile && /\.(png|jpe?g|webp|gif|avif)$/i.test(ch.name)) {
          return ch.path;
        }
      }
    }
    return undefined;
  }

  private attachHoverForAnchor(anchorEl: HTMLElement, hoverParent: HTMLElement, filePath: string, sourcePath: string) {
    const openPopover = (evt?: MouseEvent | TouchEvent) => {
      (this.app.workspace as any).trigger("hover-link", {
        event: evt ?? new MouseEvent("mouseenter"),
        source: "simple-timeline",
        hoverParent,
        targetEl: anchorEl,
        linktext: filePath,
        sourcePath
      });
    };
    anchorEl.addEventListener("mouseenter", (e) => openPopover(e as MouseEvent));
    let t: number | null = null;
    anchorEl.addEventListener("touchstart", (e) => { t = window.setTimeout(() => openPopover(e), 350); }, { passive: true });
    const clear = () => { if (t) { clearTimeout(t); t = null; } };
    ["touchend","touchmove","touchcancel"].forEach((ev) => anchorEl.addEventListener(ev, clear, { passive: true }));
  }

  private async extractFirstParagraph(file: TFile): Promise<string | undefined> {
    try {
      const raw = await this.app.vault.read(file);
      // Strip frontmatter
      const text = raw.replace(/^---[\s\S]*?---\s*/m, "");
      // Split into paragraphs
      const paras = text.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter(Boolean);
      for (const p of paras) {
        // Skip headings, lists, blockquotes
        if (/^(#{1,6}\s|>\s|[-*+]\s|\d+\.\s)/.test(p)) continue;
        let clean = p
          .replace(/!\[[^\]]*\]\([^)]+\)/g, "") // images
          .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links -> text
          .replace(/`{1,3}[^`]*`{1,3}/g, "") // inline code
          .replace(/[*_~]/g, "") // emphasis
          .replace(/\s+/g, " ")
          .trim();
        if (clean) {
          if (clean.length > 400) clean = clean.slice(0, 397) + "…";
          return clean;
        }
      }
    } catch {}
    return undefined;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }

  private async migrateLegacyToTimelineConfigs() {
    if (this.settings.migratedLegacy) return;
    const keys = new Set<string>([
      ...Object.keys(this.settings.styleOverrides || {}),
      ...Object.keys(this.settings.monthOverrides || {})
    ]);
    for (const k of keys) {
      if (!k) continue;
      if (!this.settings.timelineConfigs[k]) this.settings.timelineConfigs[k] = {};
      const tl = this.settings.timelineConfigs[k];
      const so = this.settings.styleOverrides[k];
      if (so) {
        tl.colors = {
          ...(tl.colors || {}),
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
}

/* =========================================
   Modal helpers
   ========================================= */

class InputModal extends Modal {
  private resolve!: (val: string | null) => void;
  private valueInit?: string;
  private placeholder?: string;
  private titleText?: string;

  constructor(app: App, opts: { title?: string; value?: string; placeholder?: string }) {
    super(app);
    this.valueInit = opts.value;
    this.placeholder = opts.placeholder;
    this.titleText = opts.title;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    if (this.titleText) contentEl.createEl("h3", { text: this.titleText });

    const input = contentEl.createEl("input", { type: "text" });
    input.style.width = "100%";
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

    setTimeout(() => {
      input.focus();
      input.select();
    }, 50);
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }

  waitForClose(): Promise<string | null> {
    return new Promise((res) => (this.resolve = res));
  }
}

async function promptModal(app: App, opts: { title?: string; value?: string; placeholder?: string }) {
  const m = new InputModal(app, opts);
  m.open();
  return await m.waitForClose();
}

class TimelineConfigModal extends Modal {
  private plugin: SimpleTimeline;
  private initialKey?: string;
  private initialCfg?: TimelineConfig;
  private resolve!: (val: { key: string; cfg: TimelineConfig } | null) => void;

  constructor(app: App, plugin: SimpleTimeline, params?: { key?: string; cfg?: TimelineConfig }) {
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
    const cfg: TimelineConfig = this.initialCfg ?? {};

    // Name
    new Setting(contentEl)
      .setName("Name")
      .setDesc("Example: Travel")
      .addText((t) => t.setValue(key).onChange((v) => (key = v.trim())));

    // Numeric props
    const addNum = (name: string, prop: keyof TimelineConfig, ph: string) =>
      new Setting(contentEl)
        .setName(name)
        .setDesc("Empty = use defaults")
        .addText((t) => {
          const cur = cfg[prop] as number | undefined;
          t.setPlaceholder(ph).setValue(cur != null ? String(cur) : "");
          t.onChange((v) => {
            const vv = v.trim();
            if (vv === "") (cfg as any)[prop] = undefined;
            else {
              const n = Number(vv);
              if (Number.isFinite(n)) (cfg as any)[prop] = Math.floor(n);
            }
          });
        });

    addNum("Max. summary lines", "maxSummaryLines", "e.g. 7");
    addNum("Image width", "cardWidth", "e.g. 200");
    addNum("Image height", "cardHeight", "e.g. 315");
    addNum("Box height", "boxHeight", "e.g. 289");
    addNum("Inner left padding", "sideGapLeft", "e.g. 40");
    addNum("Inner right padding", "sideGapRight", "e.g. 40");

    // Colors
    cfg.colors ||= {};
    new Setting(contentEl)
      .setName("Box background")
      .setDesc("Empty = default/theme color")
      .addColorPicker((cp) => {
        cp.setValue(cfg.colors!.bg || "");
        cp.onChange((v) => (cfg.colors!.bg = v || undefined));
      });

    new Setting(contentEl)
      .setName("Box border")
      .setDesc("Empty = default/theme color")
      .addColorPicker((cp) => {
        cp.setValue(cfg.colors!.accent || "");
        cp.onChange((v) => (cfg.colors!.accent = v || undefined));
      });

    new Setting(contentEl)
      .setName("Hover background")
      .setDesc("Empty = default/theme color")
      .addColorPicker((cp) => {
        cp.setValue(cfg.colors!.hover || "");
        cp.onChange((v) => (cfg.colors!.hover = v || undefined));
      });

    new Setting(contentEl)
      .setName("Title color")
      .setDesc("Empty = default/theme color")
      .addColorPicker((cp) => {
        cp.setValue(cfg.colors!.title || "");
        cp.onChange((v) => (cfg.colors!.title = v || undefined));
      });

    new Setting(contentEl)
      .setName("Date color")
      .setDesc("Empty = default/theme color")
      .addColorPicker((cp) => {
        cp.setValue(cfg.colors!.date || "");
        cp.onChange((v) => (cfg.colors!.date = v || undefined));
      });

    // Months
    let monthsText = Array.isArray(cfg.months)
      ? cfg.months.join(", ")
      : cfg.months ?? "";
    new Setting(contentEl)
      .setName("Month names")
      .setDesc("Comma‑separated or YAML list (empty = English months)")
      .addTextArea((ta) => {
        ta.inputEl.rows = 3;
        ta.setValue(monthsText);
        ta.onChange((v) => (monthsText = v));
      });

    // Buttons
    const btns = contentEl.createDiv({ cls: "modal-button-container" });
    const saveBtn = btns.createEl("button", { text: "Save" });
    const cancelBtn = btns.createEl("button", { text: "Cancel" });

    saveBtn.addEventListener("click", async () => {
      const k = key.trim();
      if (!k) {
        new Notice("Please enter a name.");
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

  waitForClose(): Promise<{ key: string; cfg: TimelineConfig } | null> {
    return new Promise((res) => (this.resolve = res));
  }
}

function parseMonths(text: string): string[] | string | undefined {
  if (!text) return undefined;
  // YAML list?
  try {
    if (text.includes("\n") && /(\n-|\n\s*-)/.test(text)) {
      const y = parseYaml(text);
      if (Array.isArray(y)) return y.map(String).filter(Boolean);
    }
  } catch {}
  // Comma‑separated or single value
  if (text.includes(",")) return text.split(",").map((s) => s.trim()).filter(Boolean);
  return text.trim();
}

/* Modal for global defaults */

class DefaultsModal extends Modal {
  private plugin: SimpleTimeline;
  private resolve!: (saved: boolean) => void;
  private draft: {
    cardWidth: number;
    cardHeight: number;
    boxHeight: number;
    sideGapLeft: number;
    sideGapRight: number;
    maxSummaryLines: number;
    colors: {
      bg?: string;
      accent?: string;
      hover?: string;
      title?: string;
      date?: string;
    };
  };

  constructor(app: App, plugin: SimpleTimeline) {
    super(app);
    this.plugin = plugin;
    this.draft = {
      cardWidth: plugin.settings.cardWidth,
      cardHeight: plugin.settings.cardHeight,
      boxHeight: plugin.settings.boxHeight,
      sideGapLeft: plugin.settings.sideGapLeft,
      sideGapRight: plugin.settings.sideGapRight,
      maxSummaryLines: plugin.settings.maxSummaryLines,
      colors: { ...(plugin.settings.defaultColors || {}) }
    };
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Edit defaults" });

    const addNum = (name: string, key: keyof typeof this.draft, placeholder: string) =>
      new Setting(contentEl)
        .setName(name)
        .addText((t) => {
          t.setPlaceholder(placeholder);
          t.setValue(String(this.draft[key] as number));
          t.onChange((v) => {
            const n = Number(v);
            if (Number.isFinite(n)) (this.draft as any)[key] = Math.floor(n);
          });
        });

    addNum("Image width", "cardWidth", "200");
    addNum("Image height", "cardHeight", "315");
    addNum("Box height", "boxHeight", "289");
    addNum("Inner left padding", "sideGapLeft", "40");
    addNum("Inner right padding", "sideGapRight", "40");
    addNum("Max. summary lines", "maxSummaryLines", "7");

    // Global default colors
    new Setting(contentEl)
      .setName("Box background (default)")
      .setDesc("Empty = theme color")
      .addColorPicker((cp) => {
        cp.setValue(this.draft.colors.bg || "");
        cp.onChange((v) => (this.draft.colors.bg = v || undefined));
      });

    new Setting(contentEl)
      .setName("Box border (default)")
      .setDesc("Empty = theme color")
      .addColorPicker((cp) => {
        cp.setValue(this.draft.colors.accent || "");
        cp.onChange((v) => (this.draft.colors.accent = v || undefined));
      });

    new Setting(contentEl)
      .setName("Hover background (default)")
      .setDesc("Empty = var(--interactive-accent)")
      .addColorPicker((cp) => {
        cp.setValue(this.draft.colors.hover || "");
        cp.onChange((v) => (this.draft.colors.hover = v || undefined));
      });

    new Setting(contentEl)
      .setName("Title color (default)")
      .setDesc("Empty = theme color")
      .addColorPicker((cp) => {
        cp.setValue(this.draft.colors.title || "");
        cp.onChange((v) => (this.draft.colors.title = v || undefined));
      });

    new Setting(contentEl)
      .setName("Date color (default)")
      .setDesc("Empty = theme color")
      .addColorPicker((cp) => {
        cp.setValue(this.draft.colors.date || "");
        cp.onChange((v) => (this.draft.colors.date = v || undefined));
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

  waitForClose(): Promise<boolean> {
    return new Promise((res) => (this.resolve = res));
  }
}

/* =========================================
   Settings UI
   ========================================= */

class SimpleTimelineSettingsTab extends PluginSettingTab {
  plugin: SimpleTimeline;
  constructor(app: App, plugin: SimpleTimeline) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Simple Timeline – Settings" });

    containerEl.createEl("h3", { text: "Timelines" });

    // Defaults dialog
    new Setting(containerEl)
      .setName("Global defaults")
      .setDesc("Used by all timelines that do not define their own values (including default colors).")
      .addButton((b) =>
        b.setButtonText("Edit").onClick(async () => {
          const saved = await openDefaultsWizard(this.app, this.plugin);
          if (saved) {
            await this.plugin.saveSettings();
            this.display();
            new Notice("Defaults saved.");
          }
        })
      );

    // Per‑timeline configuration
    new Setting(containerEl)
      .setName("Timeline configurations")
      .setDesc("Custom sizes, colors and month names per timeline.")
      .addButton((b) =>
        b.setButtonText("New timeline").onClick(async () => {
          const result = await openTimelineWizard(this.app, this.plugin);
          if (result) {
            this.display();
            new Notice(`Timeline “${result.key}” saved.`);
          }
        })
      );

    // Existing timelines
    const keys = Object.keys(this.plugin.settings.timelineConfigs).sort((a, b) =>
      a.localeCompare(b)
    );
    for (const key of keys) {
      const row = new Setting(containerEl).setName(key);
      row.addButton((b) =>
        b.setButtonText("Edit").onClick(async () => {
          const result = await openTimelineWizard(this.app, this.plugin, key);
          if (result) {
            this.display();
            new Notice(`Timeline “${result.key}” saved.`);
          }
        })
      );
      row.addButton((b) =>
        b
          .setWarning()
          .setButtonText("Delete")
          .onClick(async () => {
            delete this.plugin.settings.timelineConfigs[key];
            await this.plugin.saveSettings();
            this.display();
            new Notice(`Timeline “${key}” deleted.`);
          })
      );
    }

    const hint = containerEl.createDiv({ cls: "setting-item-description" });
    hint.textContent =
      "Note: older “styles per timeline” / “month overrides” were migrated once and will not be imported again.";
  }
}

/* Timeline wizard */

async function openTimelineWizard(
  app: App,
  plugin: SimpleTimeline,
  existingKey?: string
) {
  const initCfg = existingKey
    ? plugin.settings.timelineConfigs[existingKey]
    : undefined;
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
      new Notice("A timeline with this name already exists.");
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

/* Defaults wizard */

async function openDefaultsWizard(app: App, plugin: SimpleTimeline) {
  const modal = new DefaultsModal(app, plugin);
  modal.open();
  const saved = await modal.waitForClose();
  if (saved) {
    await plugin.saveSettings();
  }
  return saved;
}