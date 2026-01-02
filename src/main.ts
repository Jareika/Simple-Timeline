import * as ObsidianNS from "obsidian";
import {
  App,
  MarkdownPostProcessorContext,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  parseYaml
} from "obsidian";

type TimelineAlign = "left" | "right";
type HorizontalMode = "mixed" | "stacked";
type HorizontalEdge = "media" | "box";

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
  align?: TimelineAlign;
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

  // Bases integration (optional)
  enableBasesIntegration: boolean;
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
  migratedLegacy: false,

  enableBasesIntegration: false
};

/* =========================================
   Data types for renderer
   ========================================= */

type FCDate =
  | string
  | {
      year: number;
      month: number | string;
      day: number;
    };

type CardData = {
  file: TFile;
  title: string;
  summary?: string;
  start: { y: number; m: number; d: number; mName?: string };
  end?: { y: number; m: number; d: number; mName?: string };
  imgSrc?: string;
  primaryTl?: string;
};

type FrontmatterLike = Record<string, unknown>;

type ResolvedTimelineRenderConfig = {
  maxSummaryLines: number;
  cardWidth: number;
  cardHeight: number;
  boxHeight: number;
  sideGapLeft: number;
  sideGapRight: number;
  align: TimelineAlign;
  colors: {
    bg?: string;
    accent?: string;
    hover?: string;
    title?: string;
    date?: string;
  };
  months?: string[] | string;
};

/* numeric settings we edit via the wizards */
type TimelineNumericKey =
  | "maxSummaryLines"
  | "cardWidth"
  | "cardHeight"
  | "boxHeight"
  | "sideGapLeft"
  | "sideGapRight";

type DefaultsNumericKey =
  | "cardWidth"
  | "cardHeight"
  | "boxHeight"
  | "sideGapLeft"
  | "sideGapRight"
  | "maxSummaryLines";

/* =========================================
   Small helpers
   ========================================= */

type CssProps = Record<string, string>;

function setCssProps(el: HTMLElement, props: CssProps): void {
  const style = el.style as CSSStyleDeclaration & { [key: string]: string };
  for (const [name, value] of Object.entries(props)) {
    if (name.startsWith("--")) {
      style.setProperty(name, value);
    } else {
      style[name] = value;
    }
  }
}

type UnknownRecord = Record<string, unknown>;

function isRecord(v: unknown): v is UnknownRecord {
  return typeof v === "object" && v !== null;
}

function isFunction(v: unknown): v is (...args: unknown[]) => unknown {
  return typeof v === "function";
}

function primitiveToString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return String(v);
  return undefined;
}

function toCommaListString(v: unknown): string | undefined {
  const prim = primitiveToString(v);
  if (prim != null) return prim;

  if (Array.isArray(v)) {
    const parts = v
      .map((x) => primitiveToString(x))
      .filter((x): x is string => typeof x === "string" && x.length > 0);
    if (parts.length) return parts.join(", ");
  }

  return undefined;
}

function normalizeStringArray(v: unknown): string[] {
  if (typeof v === "string") {
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  if (Array.isArray(v)) {
    return v
      .map((x) => primitiveToString(x))
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return [];
}

function splitTimelineList(raw: string): string[] {
  const cleaned = raw.replace(/[\]["]/g, "");
  return cleaned
    .split(/[,;\n]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function ymdSortKey(v: { y: number; m: number; d: number }): number {
  return v.y * 10000 + v.m * 100 + v.d;
}

type Ymd = { y: number; m: number; d: number };

type BasesOrderMode = "bases" | "start-asc" | "start-desc";

function parseBasesOrderMode(raw: string): BasesOrderMode {
  const t = raw.trim().toLowerCase();
  if (t === "start-desc" || t === "desc") return "start-desc";
  if (t === "start-asc" || t === "asc") return "start-asc";
  return "bases";
}

function parseHorizontalMode(v: unknown): HorizontalMode | undefined {
  const s = primitiveToString(v)?.trim().toLowerCase();
  if (s === "mixed" || s === "stacked") return s;
  return undefined;
}

/* =========================================
   Bases integration constants + types
   ========================================= */

const BASES_VIEW_TYPE_CROSS = "simple-timeline-cross";
const BASES_VIEW_TYPE_HORIZONTAL = "simple-timeline-horizontal";

/** Minimal shape of Bases view options used by registerBasesView(). */
interface BasesViewOption {
  type: string;
  displayName: string;
  key: string;
  default: string;
}

/** Minimal shape of the spec passed to registerBasesView(). */
interface BasesViewSpec {
  name: string;
  icon: string;
  factory: (controller: unknown, containerEl: HTMLElement) => unknown;
  options: () => BasesViewOption[];
}

type RegisterBasesViewFn = (type: string, spec: BasesViewSpec) => void;

interface BasesConfigLike {
  get(key: string): unknown;
}

interface BasesValueLike {
  isEmpty?: () => boolean;
  toString: () => string;
  renderTo?: (el: HTMLElement, ctx?: unknown) => void;

  year?: unknown;
  month?: unknown;
  day?: unknown;
}

interface BasesEntryLike {
  file?: unknown;
  getValue?: (path: string) => BasesValueLike | null | undefined;
}

interface BasesGroupLike {
  key?: unknown;
  entries?: BasesEntryLike[];
}

interface BasesDataLike {
  groupedData?: BasesGroupLike[];
}

/** Minimal runtime surface of BasesView we use. */
interface BasesViewRuntime {
  app: App;
  data?: BasesDataLike;
  config: BasesConfigLike;
  controller?: unknown;
}

type BasesViewConstructor = new (controller: unknown) => BasesViewRuntime;

type BasesTimelineItem = {
  entry: BasesEntryLike;
  file: TFile;
  start: { y: number; m: number; d: number };
  end?: { y: number; m: number; d: number };
  title: string;
  summary?: string;
  imgSrc?: string;
  sortKey: number;
  pos: number;
};

/* =========================================
   Main plugin
   ========================================= */

export default class SimpleTimeline extends Plugin {
  settings: SimpleTimelineSettings;

  public getCalendariumCurrentYmd(): Ymd | null {
    // Soft integration: Calendarium may not be installed / api may not exist.
    const plugins = (this.app as unknown as { plugins?: unknown }).plugins;
    if (!isRecord(plugins)) return null;

    const getPlugin = plugins["getPlugin"];
    if (!isFunction(getPlugin)) return null;

    const calendarium = getPlugin.call(plugins, "calendarium");
    if (!isRecord(calendarium)) return null;

    const apiRoot = calendarium["api"];
    if (!isRecord(apiRoot)) return null;

    const directGetCurrentDate = apiRoot["getCurrentDate"];
    if (isFunction(directGetCurrentDate)) {
      const raw = directGetCurrentDate.call(apiRoot);
      if (isRecord(raw)) {
        const y = Number(raw["year"]);
        const monthZeroBased = Number(raw["month"]);
        const d = Number(raw["day"]);
        if (
          Number.isFinite(y) &&
          Number.isFinite(monthZeroBased) &&
          Number.isFinite(d) &&
          y !== 0
        ) {
          return { y, m: monthZeroBased + 1, d };
        }
      }
    }

    const getAPI = apiRoot["getAPI"];
    if (!isFunction(getAPI)) return null;

    let calendarApi: unknown;
    try {
      calendarApi = getAPI.call(apiRoot);
    } catch {
      return null;
    }
    if (!isRecord(calendarApi)) return null;

    const getCurrentDate = calendarApi["getCurrentDate"];
    if (!isFunction(getCurrentDate)) return null;

    const raw = getCurrentDate.call(calendarApi);
    if (!isRecord(raw)) return null;

    const y = Number(raw["year"]);
    const monthZeroBased = Number(raw["month"]);
    const d = Number(raw["day"]);

    if (
      Number.isFinite(y) &&
      Number.isFinite(monthZeroBased) &&
      Number.isFinite(d) &&
      y !== 0
    ) {
      return { y, m: monthZeroBased + 1, d };
    }

    return null;
  }

  public jumpContainerToYmd(
    containerEl: HTMLElement,
    ymd: Ymd,
    selector = ".tl-row"
  ): boolean {
    const targetKey = ymdSortKey(ymd);
    const rows = Array.from(containerEl.querySelectorAll<HTMLElement>(selector));

    let exact: HTMLElement | null = null;
    let nextAfter: { key: number; el: HTMLElement } | null = null;
    let lastBefore: { key: number; el: HTMLElement } | null = null;

    for (const row of rows) {
      const startKeyRaw = row.dataset.tlStartKey;
      if (!startKeyRaw) continue;
      const startKey = Number(startKeyRaw);
      if (!Number.isFinite(startKey)) continue;

      const endKeyRaw = row.dataset.tlEndKey;
      const endKey = endKeyRaw ? Number(endKeyRaw) : startKey;
      const endKeyOk = Number.isFinite(endKey) ? endKey : startKey;

      // Range match: start <= today <= end
      if (targetKey >= startKey && targetKey <= endKeyOk) {
        exact = row;
        break;
      }

      if (startKey >= targetKey) {
        if (!nextAfter || startKey < nextAfter.key) nextAfter = { key: startKey, el: row };
      } else {
        if (!lastBefore || startKey > lastBefore.key) lastBefore = { key: startKey, el: row };
      }
    }

    const target = exact ?? nextAfter?.el ?? lastBefore?.el;
    if (!target) return false;

    try {
      target.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    } catch {
      target.scrollIntoView();
    }
    return true;
  }

  async onload() {
    await this.loadSettings();
    await this.migrateLegacyToTimelineConfigs();

    // Optional Bases integration (register view type only if user enabled it)
    this.tryRegisterBasesViews();

    this.registerMarkdownCodeBlockProcessor("timeline-cal", (src, el, ctx) =>
      this.renderTimeline(src, el, ctx)
    );

    this.registerMarkdownCodeBlockProcessor("timeline-h", (src, el, ctx) =>
      this.renderTimelineHorizontal(src, el, ctx)
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
    // no-op
  }

  // ---------- Frontmatter helpers (avoid unsafe any) ----------

  private getFrontmatter(file: TFile): FrontmatterLike | undefined {
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter as unknown;
    return isRecord(fm) ? (fm as FrontmatterLike) : undefined;
  }

  private getFrontmatterValue(file: TFile, key: string): unknown {
    return this.getFrontmatter(file)?.[key];
  }

  // ---------- UI commands ----------

  private getActiveFile() {
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

    await this.app.fileManager.processFrontMatter(file, (fm: FrontmatterLike) => {
      try {
        fm["fc-date"] = this.tryParseYamlOrString(start);
        if (range && end) {
          fm["fc-end"] = this.tryParseYamlOrString(end);
        } else if (!range) {
          delete fm["fc-end"];
        }
      } catch {
        new Notice("Invalid date.");
      }
    });
  }

  private async promptEditTimelines(file: TFile) {
    const curVal = this.getFrontmatterValue(file, "timelines");
    const curStr = toCommaListString(curVal) ?? "";

    const val = await promptModal(this.app, {
      title: "Timelines (comma-separated)",
      value: curStr,
      placeholder: "Travel, Expedition, Notes"
    });
    if (val == null) return;
    const arr = String(val)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    await this.app.fileManager.processFrontMatter(file, (fm: FrontmatterLike) => {
      fm["timelines"] = arr;
    });
  }

  private async promptSetSummary(file: TFile) {
    const curVal = this.getFrontmatterValue(file, "tl-summary");
    const curStr = primitiveToString(curVal) ?? "";

    const val = await promptModal(this.app, {
      title: "Short summary",
      value: curStr,
      placeholder: "Multi-line allowed (YAML | or |- in frontmatter)"
    });
    if (val == null) return;
    await this.app.fileManager.processFrontMatter(file, (fm: FrontmatterLike) => {
      fm["tl-summary"] = String(val);
    });
  }

  private async adoptFirstImage(file: TFile) {
    const link = this.findImageForFile(file);
    if (!link) {
      new Notice("No image found.");
      return;
    }
    await this.app.fileManager.processFrontMatter(file, (fm: FrontmatterLike) => {
      fm["tl-image"] = link;
    });
    new Notice("Timeline image set from first image.");
  }

  private tryParseYamlOrString(input: string): unknown {
    const trimmed = String(input).trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || trimmed.includes(":")) {
      return parseYaml(trimmed);
    }
    return trimmed;
  }

  // ---------- Bases integration ----------

  /**
   * Registers Bases views if:
   * - user enabled it in plugin settings
   * - Obsidian version exposes registerBasesView + BasesView at runtime
   *
   * Important: we keep this implementation "soft" so the plugin does not crash
   * on older Obsidian builds that do not include Bases.
   */
  private tryRegisterBasesViews(): void {
    if (!this.settings.enableBasesIntegration) return;

    const maybeRegister = (this as unknown as { registerBasesView?: unknown })
      .registerBasesView;

    if (!isFunction(maybeRegister)) {
      console.debug(
        "simple-timeline: Bases integration enabled, but registerBasesView is not available (Obsidian too old?)."
      );
      return;
    }

    const maybeBasesView = (ObsidianNS as unknown as UnknownRecord)["BasesView"];
    if (!isFunction(maybeBasesView)) {
      console.debug(
        "simple-timeline: Bases integration enabled, but BasesView is not available (Obsidian too old?)."
      );
      return;
    }

    const BasesViewCtor = maybeBasesView as unknown as BasesViewConstructor;

    abstract class TimelineBasesBaseView extends BasesViewCtor {
      protected hostEl: HTMLElement;
      protected plugin: SimpleTimeline;
      protected renderToken = 0;

      constructor(controller: unknown, parentEl: HTMLElement, plugin: SimpleTimeline) {
        super(controller);
        this.plugin = plugin;

        this.hostEl = parentEl.createDiv({ cls: "tl-bases-host" });
        setCssProps(this.hostEl, {
          boxSizing: "border-box",
          paddingLeft: "var(--file-margins, 24px)",
          paddingRight: "var(--file-margins, 24px)"
        });
      }

      protected getOptionString(key: string, fallback: string): string {
        const v = this.config.get(key);
        return typeof v === "string" ? v : fallback;
      }

      protected getGroupKeyText(v: unknown): string {
        const prim = primitiveToString(v);
        if (prim != null) return prim;

        if (isRecord(v)) {
          const ts = v["toString"];
          if (isFunction(ts)) {
            try {
              const out = ts.call(v);
              if (typeof out === "string" && out !== "[object Object]") return out;
            } catch {
              // ignore
            }
          }
        }
        return "";
      }

      protected getTimelineKeyFromEntry(
        entry: BasesEntryLike,
        timelineProperty: string
      ): string | undefined {
        if (!timelineProperty) return undefined;
        const v = entry.getValue?.(timelineProperty);
        if (!v || v.isEmpty?.()) return undefined;

        const raw = String(v.toString?.() ?? "").trim();
        if (!raw) return undefined;

        const candidates = splitTimelineList(raw);
        if (!candidates.length) return undefined;

        for (const c of candidates) {
          if (this.plugin.settings.timelineConfigs[c]) return c;
        }
        return candidates[0];
      }

      protected getControllerFilePath(): string | undefined {
        const c = this.controller;
        if (!c || !isRecord(c)) return undefined;

        const maybeFile = c["file"];
        if (maybeFile instanceof TFile) return maybeFile.path;

        if (isRecord(maybeFile)) {
          const p = maybeFile["path"];
          if (typeof p === "string") return p;
        }
        return undefined;
      }

      protected resolveImageFromEntryValue(
        entry: BasesEntryLike,
        imageProp: string,
        sourcePath: string
      ): string | undefined {
        if (!imageProp) return undefined;

        const v = entry.getValue?.(imageProp);
        if (!v || v.isEmpty?.()) return undefined;

        // Try to let Bases render the value into HTML, then extract <img src="...">
        try {
          if (typeof v.renderTo === "function") {
            const tmp = document.createElement("div");
            try {
              const renderContext = (this.app as unknown as { renderContext?: unknown })
                .renderContext;
              v.renderTo(tmp, renderContext ?? this.app);
            } catch {
              v.renderTo(tmp);
            }
            const img = tmp.querySelector("img");
            const src = img?.getAttribute("src") ?? undefined;
            if (src) return src;
          }
        } catch {
          // ignore and fall back to string parsing
        }

        const s = String(v.toString?.() ?? "").trim();
        if (!s) return undefined;

        return this.plugin.resolveLinkToSrc(s, sourcePath);
      }

      protected valueToYmd(
        value: BasesValueLike | null | undefined
      ): { y: number; m: number; d: number } | null {
        if (!value) return null;
        if (typeof value.isEmpty === "function" && value.isEmpty()) return null;

        // 1) Direct fields (best case)
        const yRaw = value.year;
        const mRaw = value.month;
        const dRaw = value.day;

        const y = Number(yRaw);
        const m = Number(mRaw);
        const d = Number(dRaw);

        if (
          Number.isFinite(y) &&
          Number.isFinite(m) &&
          Number.isFinite(d) &&
          y !== 0 &&
          m >= 1 &&
          m <= 12 &&
          d >= 1 &&
          d <= 31
        ) {
          return { y, m, d };
        }

        // 2) String parse (YYYY-MM-DD...)
        const raw = String(value.toString?.() ?? value).trim();
        const match = raw.match(/^(\d{1,6})-(\d{1,2})-(\d{1,2})/);
        if (match) {
          return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
        }

        // 3) Numeric epoch (ms)
        const asNum = Number(raw);
        if (Number.isFinite(asNum) && asNum > 0) {
          const dt = new Date(asNum);
          if (!Number.isNaN(dt.getTime())) {
            return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
          }
        }

        return null;
      }

      protected buildItemFromEntry(
        entry: BasesEntryLike,
        startProp: string,
        endProp: string,
        titleProp: string,
        summaryProp: string,
        imageProp: string,
        pos: number
      ): BasesTimelineItem | null {
        const maybeFile = entry.file;
        if (!(maybeFile instanceof TFile)) return null;
        const file = maybeFile;

        const startValue = entry.getValue?.(startProp);
        const start = this.valueToYmd(startValue);
        if (!start) return null;

        const endValue = endProp ? entry.getValue?.(endProp) : null;
        const end = this.valueToYmd(endValue) ?? undefined;

        const titleValue = titleProp ? entry.getValue?.(titleProp) : null;
        const title =
          titleValue && !titleValue.isEmpty?.()
            ? String(titleValue.toString())
            : file.basename;

        let summary: string | undefined;
        const summaryValue = summaryProp ? entry.getValue?.(summaryProp) : null;
        if (summaryValue && !summaryValue.isEmpty?.()) {
          summary = String(summaryValue.toString());
        }

        const imgSrc = this.resolveImageFromEntryValue(entry, imageProp, file.path);

        return {
          entry,
          file,
          start,
          end,
          title,
          summary,
          imgSrc,
          sortKey: ymdSortKey(start),
          pos
        };
      }

      protected renderCrossCard(
        wrapper: HTMLElement,
        c: CardData,
        cfg: ResolvedTimelineRenderConfig
      ): HTMLElement {
        const row = wrapper.createDiv({ cls: "tl-row" });

        // used for jump-to-today
        row.dataset.tlStartKey = String(ymdSortKey({ y: c.start.y, m: c.start.m, d: c.start.d }));
        if (c.end) {
          row.dataset.tlEndKey = String(ymdSortKey({ y: c.end.y, m: c.end.m, d: c.end.d }));
        } else {
          delete row.dataset.tlEndKey;
        }

        const align: TimelineAlign = cfg.align ?? "left";
        if (align === "right") row.addClass("tl-align-right");

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
        const hasMedia = !!c.imgSrc;
        grid.addClass(hasMedia ? "has-media" : "no-media");

        setCssProps(grid, {
          display: "grid",
          alignItems: "center",
          columnGap: "0",
          "--tl-media-w": `${W}px`
        });

        let media: HTMLDivElement | null = null;
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

        const titleEl = box.createEl("h1", { cls: "tl-title", text: c.title });
        const dateEl = box.createEl("h4", {
          cls: "tl-date",
          text: this.plugin.formatRange(c.start, c.end)
        });
        const sum = box.createDiv({ cls: "tl-summary" });

        titleEl.classList.add("tl-title-colored");
        dateEl.classList.add("tl-date-colored");

        if (cfg.colors.title) titleEl.style.color = cfg.colors.title;
        if (cfg.colors.date) dateEl.style.color = cfg.colors.date;

        if (c.summary) sum.setText(c.summary);

        const basesSourcePath = this.getControllerFilePath() ?? c.file.path;

        // Popover / click area only on image & box
        if (media) {
          const aImg = media.createEl("a", {
            cls: "internal-link tl-hover-anchor",
            href: c.file.path,
            attr: { "data-href": c.file.path, "aria-label": c.title }
          });

          // Ensure pointer events even if Bases container CSS is special
          setCssProps(aImg, {
            position: "absolute",
            inset: "0",
            zIndex: "5",
            display: "block",
            pointerEvents: "auto"
          });

          this.plugin.attachHoverForAnchor(aImg, media, c.file.path, basesSourcePath);
        }

        const aBox = box.createEl("a", {
          cls: "internal-link tl-hover-anchor",
          href: c.file.path,
          attr: { "data-href": c.file.path, "aria-label": c.title }
        });

        setCssProps(aBox, {
          position: "absolute",
          inset: "0",
          zIndex: "5",
          display: "block",
          pointerEvents: "auto"
        });

        this.plugin.attachHoverForAnchor(aBox, box, c.file.path, basesSourcePath);
        this.plugin.applyFixedLineClamp(sum, cfg.maxSummaryLines);

        return row;
      }

      protected getHorizontalEdges(
        c: CardData,
        cfg: ResolvedTimelineRenderConfig
      ): { left: HorizontalEdge; right: HorizontalEdge } {
        const hasMedia = !!c.imgSrc;
        const align: TimelineAlign = cfg.align ?? "left";
        if (!hasMedia) return { left: "box", right: "box" };
        if (align === "right") return { left: "box", right: "media" };
        return { left: "media", right: "box" };
      }

      protected applyHorizontalJoin(
        a: { el: HTMLElement; right: HorizontalEdge },
        b: { el: HTMLElement; left: HorizontalEdge }
      ) {
        // Only "glue" boxes. Images keep their rounded corners and size.
        if (a.right === "box") a.el.classList.add("tl-h-join-right-box");
        if (b.left === "box") b.el.classList.add("tl-h-join-left-box");
      }

      protected async buildCardData(
        it: BasesTimelineItem,
        tlKey: string | undefined,
        months: string[]
      ): Promise<CardData> {
        let summary = it.summary;
        if (!summary) {
          summary = await this.plugin.extractFirstParagraph(it.file);
        }

        const mNameStart =
          months[(it.start.m - 1 + months.length) % months.length] ?? String(it.start.m);
        const mNameEnd = it.end
          ? months[(it.end.m - 1 + months.length) % months.length] ?? String(it.end.m)
          : undefined;

        return {
          file: it.file,
          title: it.title,
          summary,
          start: { ...it.start, mName: mNameStart },
          end: it.end ? { ...it.end, mName: mNameEnd } : undefined,
          imgSrc: it.imgSrc,
          primaryTl: tlKey
        };
      }
    }

    class TimelineBasesCrossView extends TimelineBasesBaseView {
      readonly type = BASES_VIEW_TYPE_CROSS;

      public onDataUpdated(): void {
        this.hostEl.empty();

        const controls = this.hostEl.createDiv({ cls: "tl-controls" });
        const todayBtn = controls.createEl("button", { text: "Today" });

        const wrapper = this.hostEl.createDiv({ cls: "tl-wrapper tl-cross-mode" });

        const timelineConfigNameRaw = this.getOptionString("timelineConfig", "").trim();
        const timelineConfigName = timelineConfigNameRaw || undefined;

        const timelineProperty = this.getOptionString("timelineProperty", "note.timelines").trim();

        const startProp = this.getOptionString("startProperty", "note.fc-date");
        const endProp = this.getOptionString("endProperty", "note.fc-end");
        const titleProp = this.getOptionString("titleProperty", "note.tl-title");
        const summaryProp = this.getOptionString("summaryProperty", "note.tl-summary");
        const imageProp = this.getOptionString("imageProperty", "note.tl-image");
        const jumpToToday =
          this.getOptionString("jumpToToday", "false").trim().toLowerCase() === "true";

        todayBtn.addEventListener("click", () => {
          const today = this.plugin.getCalendariumCurrentYmd();
          if (!today) {
            new Notice("Calendarium is not installed");
            return;
          }
          const ok = this.plugin.jumpContainerToYmd(wrapper, today);
          if (!ok) new Notice("No timeline entry found for today");
        });

        const orderMode = parseBasesOrderMode(this.getOptionString("orderMode", "bases"));

        const token = ++this.renderToken;
        const groups = this.data?.groupedData ?? [];

        const hasMeaningfulGroups = groups.some((g) => {
          const t = this.getGroupKeyText(g.key);
          return !!t && t !== "null";
        });

        const renderItems = async (items: BasesTimelineItem[]) => {
          const list = [...items];
          if (orderMode === "start-asc" || orderMode === "start-desc") {
            const dir = orderMode === "start-desc" ? -1 : 1;
            list.sort((a, b) => {
              if (a.sortKey !== b.sortKey) return dir * (a.sortKey - b.sortKey);
              return a.pos - b.pos;
            });
          }

          for (const it of list) {
            if (token !== this.renderToken) return;

            const tlKey =
              timelineConfigName ?? this.getTimelineKeyFromEntry(it.entry, timelineProperty);

            const cfg = this.plugin.getConfigFor(tlKey);
            const months: string[] = this.plugin.getMonths(tlKey);

            const card = await this.buildCardData(it, tlKey, months);
            if (token !== this.renderToken) return;

            this.renderCrossCard(wrapper, card, cfg);
          }
        };

        if (hasMeaningfulGroups) {
          void (async () => {
            let pos = 0;
            for (const group of groups) {
              if (token !== this.renderToken) return;

              const keyText = this.getGroupKeyText(group.key);
              if (keyText && keyText !== "null") {
                const h = wrapper.createEl("h3", { text: keyText });
                h.addClass("tl-bases-group-title");
              }

              const groupItems: BasesTimelineItem[] = [];
              for (const entry of group.entries ?? []) {
                const it = this.buildItemFromEntry(
                  entry,
                  startProp,
                  endProp,
                  titleProp,
                  summaryProp,
                  imageProp,
                  pos++
                );
                if (it) groupItems.push(it);
              }

              await renderItems(groupItems);
            }

            if (token !== this.renderToken) return;
            if (jumpToToday) {
              const today = this.plugin.getCalendariumCurrentYmd();
              if (today) this.plugin.jumpContainerToYmd(wrapper, today);
            }
          })();
          return;
        }

        const items: BasesTimelineItem[] = [];
        let pos = 0;
        for (const group of groups) {
          for (const entry of group.entries ?? []) {
            const it = this.buildItemFromEntry(
              entry,
              startProp,
              endProp,
              titleProp,
              summaryProp,
              imageProp,
              pos++
            );
            if (it) items.push(it);
          }
        }

        void (async () => {
          await renderItems(items);

          if (token !== this.renderToken) return;
          if (jumpToToday) {
            const today = this.plugin.getCalendariumCurrentYmd();
            if (today) this.plugin.jumpContainerToYmd(wrapper, today);
          }
        })();
      }
    }

    class TimelineBasesHorizontalView extends TimelineBasesBaseView {
      readonly type = BASES_VIEW_TYPE_HORIZONTAL;

      public onDataUpdated(): void {
        this.hostEl.empty();

        const controls = this.hostEl.createDiv({ cls: "tl-controls" });
        const todayBtn = controls.createEl("button", { text: "Today" });

        // One shared scroller (like markdown timeline-h)
        const scroller = this.hostEl.createDiv({ cls: "tl-h-scroller" });

        const timelineConfigNameRaw = this.getOptionString("timelineConfig", "").trim();
        const timelineConfigName = timelineConfigNameRaw || undefined;

        const timelineProperty = this.getOptionString("timelineProperty", "note.timelines").trim();

        const startProp = this.getOptionString("startProperty", "note.fc-date");
        const endProp = this.getOptionString("endProperty", "note.fc-end");
        const titleProp = this.getOptionString("titleProperty", "note.tl-title");
        const summaryProp = this.getOptionString("summaryProperty", "note.tl-summary");
        const imageProp = this.getOptionString("imageProperty", "note.tl-image");

        const jumpToToday =
          this.getOptionString("jumpToToday", "false").trim().toLowerCase() === "true";

        const orderMode = parseBasesOrderMode(this.getOptionString("orderMode", "bases"));
        const mode: HorizontalMode =
          parseHorizontalMode(this.getOptionString("mode", "stacked")) ?? "stacked";

        todayBtn.addEventListener("click", () => {
          const today = this.plugin.getCalendariumCurrentYmd();
          if (!today) {
            new Notice("Calendarium is not installed");
            return;
          }
          const ok = this.plugin.jumpContainerToYmd(scroller, today, ".tl-h-item");
          if (!ok) new Notice("No timeline entry found for today");
        });

        const token = ++this.renderToken;
        const groups = this.data?.groupedData ?? [];

        const hasMeaningfulGroups = groups.some((g) => {
          const t = this.getGroupKeyText(g.key);
          return !!t && t !== "null";
        });

        const renderHorizontalItems = async (items: BasesTimelineItem[], host: HTMLElement) => {
          const wrapper = host.createDiv({
            cls:
              mode === "stacked"
                ? "tl-h-content tl-horizontal tl-h-stacked"
                : "tl-h-content tl-horizontal tl-h-mixed"
          });

          const list = [...items];
          if (orderMode === "start-asc" || orderMode === "start-desc") {
            const dir = orderMode === "start-desc" ? -1 : 1;
            list.sort((a, b) => {
              if (a.sortKey !== b.sortKey) return dir * (a.sortKey - b.sortKey);
              return a.pos - b.pos;
            });
          }

          if (mode === "mixed") {
            const rendered: Array<{ el: HTMLElement; left: HorizontalEdge; right: HorizontalEdge }> =
              [];

            for (const it of list) {
              if (token !== this.renderToken) return;

              const tlKey =
                timelineConfigName ?? this.getTimelineKeyFromEntry(it.entry, timelineProperty);

              const cfg = this.plugin.getConfigFor(tlKey);
              const months: string[] = this.plugin.getMonths(tlKey);

              const card = await this.buildCardData(it, tlKey, months);
              if (token !== this.renderToken) return;

              const rowEl = this.renderCrossCard(wrapper, card, cfg);
              rowEl.addClass("tl-h-item");

              const edges = this.getHorizontalEdges(card, cfg);
              rendered.push({ el: rowEl, ...edges });
            }

            for (let i = 0; i < rendered.length - 1; i++) {
              this.applyHorizontalJoin(
                { el: rendered[i].el, right: rendered[i].right },
                { el: rendered[i + 1].el, left: rendered[i + 1].left }
              );
            }

            return;
          }

          // stacked: union-axis (only existing dates become columns)
          // axis order depends on orderMode:
          // - bases: order of first appearance
          // - start-asc/desc: date order
          const axisKeys: number[] = [];
          const seen = new Set<number>();
          for (const it of list) {
            const k = ymdSortKey(it.start);
            if (!seen.has(k)) {
              seen.add(k);
              axisKeys.push(k);
            }
          }
          if (orderMode === "start-asc") axisKeys.sort((a, b) => a - b);
          if (orderMode === "start-desc") axisKeys.sort((a, b) => b - a);

          const colByKey = new Map<number, number>();
          for (let i = 0; i < axisKeys.length; i++) colByKey.set(axisKeys[i], i + 1);

          setCssProps(wrapper, { "--tl-h-cols": String(axisKeys.length) });

          // group by timeline key
          const byTl = new Map<string, BasesTimelineItem[]>();
          for (const it of list) {
            const tlKey =
              timelineConfigName ?? this.getTimelineKeyFromEntry(it.entry, timelineProperty);
            const k = tlKey ?? "default";

            const arr = byTl.get(k);
            if (arr) arr.push(it);
            else byTl.set(k, [it]);
          }

          // Keep Bases order for timeline groups when orderMode=bases (stable),
          // otherwise alphabetical (predictable).
          const tlKeys: string[] =
            orderMode === "bases" ? Array.from(byTl.keys()) : Array.from(byTl.keys()).sort();

          for (const tlKey of tlKeys) {
            if (token !== this.renderToken) return;

            const rowItems = byTl.get(tlKey) ?? [];
            const cfg = this.plugin.getConfigFor(tlKey);
            const months: string[] = this.plugin.getMonths(tlKey);

            const rowWrap = wrapper.createDiv({ cls: "tl-h-timeline" });
            const rowGrid = rowWrap.createDiv({ cls: "tl-h-row" });
            setCssProps(rowGrid, { "--tl-h-cols": String(axisKeys.length) });

            // by dateKey, keep stable order
            const byDate = new Map<number, BasesTimelineItem[]>();
            for (const it of rowItems) {
              const k = ymdSortKey(it.start);
              const arr = byDate.get(k);
              if (arr) arr.push(it);
              else byDate.set(k, [it]);
            }

            const dateKeysSorted = Array.from(byDate.keys()).sort((a, b) => {
              const ca = colByKey.get(a) ?? 0;
              const cb = colByKey.get(b) ?? 0;
              return ca - cb;
            });

            const renderedSlots: Array<{
              col: number;
              el: HTMLElement;
              left: HorizontalEdge;
              right: HorizontalEdge;
            }> = [];

            for (const dateKey of dateKeysSorted) {
              if (token !== this.renderToken) return;

              const col = colByKey.get(dateKey);
              if (!col) continue;

              const slot = rowGrid.createDiv({ cls: "tl-h-slot" });
              setCssProps(slot, { "--tl-h-col": String(col) });

              const cardsAtDate = byDate.get(dateKey) ?? [];
              let stored = false;

              for (const it of cardsAtDate) {
                const card = await this.buildCardData(it, tlKey, months);
                if (token !== this.renderToken) return;

                const rowEl = this.renderCrossCard(slot, card, cfg);
                rowEl.addClass("tl-h-item");

                if (!stored) {
                  const edges = this.getHorizontalEdges(card, cfg);
                  renderedSlots.push({ col, el: rowEl, ...edges });
                  stored = true;
                }
              }
            }

            renderedSlots.sort((a, b) => a.col - b.col);
            for (let i = 0; i < renderedSlots.length - 1; i++) {
              const a = renderedSlots[i];
              const b = renderedSlots[i + 1];
              if (b.col === a.col + 1) {
                this.applyHorizontalJoin({ el: a.el, right: a.right }, { el: b.el, left: b.left });
              }
            }
          }
        };

        const renderGroup = async (groupItems: BasesTimelineItem[], groupTitle?: string) => {
          if (groupTitle) {
            const h = scroller.createDiv({ cls: "tl-bases-group-title" });
            h.createEl("h3", { text: groupTitle });
          }
          const groupHost = scroller.createDiv({ cls: "tl-h-group" });
          await renderHorizontalItems(groupItems, groupHost);
        };

        if (hasMeaningfulGroups) {
          void (async () => {
            let pos = 0;
            for (const group of groups) {
              if (token !== this.renderToken) return;

              const groupItems: BasesTimelineItem[] = [];
              for (const entry of group.entries ?? []) {
                const it = this.buildItemFromEntry(
                  entry,
                  startProp,
                  endProp,
                  titleProp,
                  summaryProp,
                  imageProp,
                  pos++
                );
                if (it) groupItems.push(it);
              }

              const title = this.getGroupKeyText(group.key);
              await renderGroup(groupItems, title && title !== "null" ? title : undefined);
            }

            if (token !== this.renderToken) return;
            if (jumpToToday) {
              const today = this.plugin.getCalendariumCurrentYmd();
              if (today) this.plugin.jumpContainerToYmd(scroller, today, ".tl-h-item");
            }
          })();
          return;
        }

        const items: BasesTimelineItem[] = [];
        let pos = 0;
        for (const group of groups) {
          for (const entry of group.entries ?? []) {
            const it = this.buildItemFromEntry(
              entry,
              startProp,
              endProp,
              titleProp,
              summaryProp,
              imageProp,
              pos++
            );
            if (it) items.push(it);
          }
        }

        void (async () => {
          await renderHorizontalItems(items, scroller);

          if (token !== this.renderToken) return;
          if (jumpToToday) {
            const today = this.plugin.getCalendariumCurrentYmd();
            if (today) this.plugin.jumpContainerToYmd(scroller, today, ".tl-h-item");
          }
        })();
      }
    }

    const registerBasesView = maybeRegister as unknown as RegisterBasesViewFn;

    // Cross (existing)
    registerBasesView.call(this, BASES_VIEW_TYPE_CROSS, {
      name: "Timeline (Cross)",
      icon: "lucide-calendar-days",
      factory: (controller: unknown, containerEl: HTMLElement) =>
        new TimelineBasesCrossView(controller, containerEl, this),
      options: () => [
        {
          type: "text",
          displayName: "Timeline config name (optional, forces one config)",
          key: "timelineConfig",
          default: ""
        },
        {
          type: "text",
          displayName:
            "Timeline property (used if timelineConfig is empty; can be multi-value)",
          key: "timelineProperty",
          default: "note.timelines"
        },
        { type: "text", displayName: "Start date property", key: "startProperty", default: "note.fc-date" },
        { type: "text", displayName: "Jump to Calendarium 'today' on refresh (true|false)", key: "jumpToToday", default: "false" },
        { type: "text", displayName: "Order mode (bases|start-asc|start-desc). Default: bases", key: "orderMode", default: "bases" },
        { type: "text", displayName: "End date property (optional)", key: "endProperty", default: "note.fc-end" },
        { type: "text", displayName: "Title property", key: "titleProperty", default: "note.tl-title" },
        { type: "text", displayName: "Summary property", key: "summaryProperty", default: "note.tl-summary" },
        { type: "text", displayName: "Image property", key: "imageProperty", default: "note.tl-image" }
      ]
    });

    // NEW: Horizontal (Bases)
    registerBasesView.call(this, BASES_VIEW_TYPE_HORIZONTAL, {
      name: "Timeline (Horizontal)",
      icon: "lucide-arrow-left-right",
      factory: (controller: unknown, containerEl: HTMLElement) =>
        new TimelineBasesHorizontalView(controller, containerEl, this),
      options: () => [
        {
          type: "text",
          displayName: "Mode (stacked|mixed). Default: stacked",
          key: "mode",
          default: "stacked"
        },
        {
          type: "text",
          displayName: "Timeline config name (optional, forces one config)",
          key: "timelineConfig",
          default: ""
        },
        {
          type: "text",
          displayName:
            "Timeline property (used if timelineConfig is empty; can be multi-value)",
          key: "timelineProperty",
          default: "note.timelines"
        },
        { type: "text", displayName: "Start date property", key: "startProperty", default: "note.fc-date" },
        { type: "text", displayName: "Jump to Calendarium 'today' on refresh (true|false)", key: "jumpToToday", default: "false" },
        { type: "text", displayName: "Order mode (bases|start-asc|start-desc). Default: bases", key: "orderMode", default: "bases" },
        { type: "text", displayName: "End date property (optional)", key: "endProperty", default: "note.fc-end" },
        { type: "text", displayName: "Title property", key: "titleProperty", default: "note.tl-title" },
        { type: "text", displayName: "Summary property", key: "summaryProperty", default: "note.tl-summary" },
        { type: "text", displayName: "Image property", key: "imageProperty", default: "note.tl-image" }
      ]
    });
  }

  // ---------- Markdown renderers ----------

  private parseBlockOptionsObject(src: string): UnknownRecord {
    if (!src.trim()) return {};
    try {
      const raw = parseYaml(src) as unknown;
      return isRecord(raw) ? raw : {};
    } catch (e) {
      console.debug("simple-timeline: invalid block options", e);
      return {};
    }
  }

  private parseNamesFromOptions(opts: UnknownRecord): string[] {
    const namesValue = opts["names"] ?? opts["name"];
    return normalizeStringArray(namesValue);
  }

  private parseJumpToTodayFromOptions(opts: UnknownRecord): boolean {
    const v = opts["jumpToToday"];
    return v === true;
  }

  private getHorizontalEdges(c: CardData, cfg: ResolvedTimelineRenderConfig): { left: HorizontalEdge; right: HorizontalEdge } {
    const hasMedia = !!c.imgSrc;
    const align: TimelineAlign = cfg.align ?? "left";
    if (!hasMedia) return { left: "box", right: "box" };
    if (align === "right") return { left: "box", right: "media" };
    return { left: "media", right: "box" };
  }

  private applyHorizontalJoin(
    a: { el: HTMLElement; right: HorizontalEdge },
    b: { el: HTMLElement; left: HorizontalEdge }
  ) {
    // Only "glue" boxes. Images keep their rounded corners and size.
    if (a.right === "box") a.el.classList.add("tl-h-join-right-box");
    if (b.left === "box") b.el.classList.add("tl-h-join-left-box");
  }

  private async collectCards(filterNames: string[], ctx: MarkdownPostProcessorContext): Promise<CardData[]> {
    const files = this.app.vault.getMarkdownFiles();
    const cards: CardData[] = [];

    for (const f of files) {
      const fm = this.getFrontmatter(f);
      if (!fm) continue;
      if (!Object.prototype.hasOwnProperty.call(fm, "fc-date")) continue;

      const timelinesVal = fm["timelines"];
      let tlList: string[] = [];
      if (Array.isArray(timelinesVal)) {
        tlList = timelinesVal
          .map((x) => primitiveToString(x))
          .filter((x): x is string => typeof x === "string")
          .map((s) => s.trim())
          .filter(Boolean);
      } else if (typeof timelinesVal === "string") {
        tlList = splitTimelineList(timelinesVal);
      }

      if (filterNames.length && !tlList.some((t) => filterNames.includes(t))) continue;

      const start = this.parseFcDate(fm["fc-date"] as FCDate | undefined);
      if (!start) continue;

      const end = fm["fc-end"]
        ? this.parseFcDate(fm["fc-end"] as FCDate | undefined)
        : undefined;

      const primaryTl = filterNames.length
        ? tlList.find((t) => filterNames.includes(t)) || tlList[0]
        : tlList[0];

      const months = this.getMonths(primaryTl);
      const mNameStart =
        months[(start.m - 1 + months.length) % months.length] ?? String(start.m);
      const mNameEnd = end
        ? months[(end.m - 1 + months.length) % months.length] ?? String(end.m)
        : undefined;

      const tlTitleVal = fm["tl-title"];
      const title = primitiveToString(tlTitleVal) ?? f.basename;

      const rawSummary = fm["tl-summary"];
      let summary: string | undefined;
      if (typeof rawSummary === "string") summary = rawSummary;
      else if (typeof rawSummary === "number" || typeof rawSummary === "boolean") summary = String(rawSummary);
      else if (rawSummary != null) {
        try {
          summary = JSON.stringify(rawSummary);
        } catch {
          summary = undefined;
        }
      }

      if (!summary) summary = await this.extractFirstParagraph(f);

      const imgSrc = this.resolveImageSrc(f, fm, ctx.sourcePath ?? f.path);

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

    cards.sort((a, b) => ymdSortKey(a.start) - ymdSortKey(b.start));
    return cards;
  }

  private renderCrossCardRow(
    wrapper: HTMLElement,
    c: CardData,
    cfg: ResolvedTimelineRenderConfig,
    sourcePathForHover: string,
    extraRowClasses: string[] = []
  ): HTMLElement {
    const row = wrapper.createDiv({ cls: ["tl-row", ...extraRowClasses].join(" ") });

    row.dataset.tlStartKey = String(ymdSortKey({ y: c.start.y, m: c.start.m, d: c.start.d }));
    if (c.end) {
      row.dataset.tlEndKey = String(ymdSortKey({ y: c.end.y, m: c.end.m, d: c.end.d }));
    } else {
      delete row.dataset.tlEndKey;
    }

    const align: TimelineAlign = cfg.align ?? "left";
    if (align === "right") row.addClass("tl-align-right");

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
    const hasMedia = !!c.imgSrc;
    grid.addClass(hasMedia ? "has-media" : "no-media");

    setCssProps(grid, {
      display: "grid",
      alignItems: "center",
      columnGap: "0",
      "--tl-media-w": `${W}px`
    });

    let media: HTMLDivElement | null = null;
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

    const titleEl = box.createEl("h1", { cls: "tl-title", text: c.title });
    const dateEl = box.createEl("h4", { cls: "tl-date", text: this.formatRange(c.start, c.end) });
    const sum = box.createDiv({ cls: "tl-summary" });

    titleEl.classList.add("tl-title-colored");
    dateEl.classList.add("tl-date-colored");

    if (cfg.colors.title) titleEl.style.color = cfg.colors.title;
    if (cfg.colors.date) dateEl.style.color = cfg.colors.date;

    if (c.summary) sum.setText(c.summary);

    // Popover: only image (if present) and box
    if (media) {
      const aImg = media.createEl("a", {
        cls: "internal-link tl-hover-anchor",
        href: c.file.path,
        attr: { "data-href": c.file.path, "aria-label": c.title }
      });
      this.attachHoverForAnchor(aImg, media, c.file.path, sourcePathForHover);
    }
    const aBox = box.createEl("a", {
      cls: "internal-link tl-hover-anchor",
      href: c.file.path,
      attr: { "data-href": c.file.path, "aria-label": c.title }
    });
    this.attachHoverForAnchor(aBox, box, c.file.path, sourcePathForHover);

    this.applyFixedLineClamp(sum, cfg.maxSummaryLines);

    return row;
  }

  // ---------- Renderer (timeline-cal) ----------

  private async renderTimeline(src: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    const opts = this.parseBlockOptionsObject(src);
    const filterNames = this.parseNamesFromOptions(opts);
    const jumpToToday = this.parseJumpToTodayFromOptions(opts);

    const cards = await this.collectCards(filterNames, ctx);

    const controls = el.createDiv({ cls: "tl-controls" });
    const todayBtn = controls.createEl("button", { text: "Today" });

    const wrapper = el.createDiv({ cls: "tl-wrapper tl-cross-mode" });

    todayBtn.addEventListener("click", () => {
      const today = this.getCalendariumCurrentYmd();
      if (!today) {
        new Notice("Calendarium is not installed.");
        return;
      }
      const ok = this.jumpContainerToYmd(wrapper, today);
      if (!ok) new Notice("No timeline entry for today found.");
    });

    for (const c of cards) {
      const cfg = this.getConfigFor(c.primaryTl);
      this.renderCrossCardRow(wrapper, c, cfg, ctx.sourcePath);
    }

    if (jumpToToday) {
      const today = this.getCalendariumCurrentYmd();
      if (today) this.jumpContainerToYmd(wrapper, today);
    }
  }

  // ---------- Renderer (timeline-h) ----------

  private async renderTimelineHorizontal(src: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    const opts = this.parseBlockOptionsObject(src);
    const filterNames = this.parseNamesFromOptions(opts);
    const jumpToToday = this.parseJumpToTodayFromOptions(opts);
    const mode: HorizontalMode = parseHorizontalMode(opts["mode"]) ?? "mixed";

    const cards = await this.collectCards(filterNames, ctx);

    const controls = el.createDiv({ cls: "tl-controls" });
    const todayBtn = controls.createEl("button", { text: "Today" });

    const scroller = el.createDiv({ cls: "tl-h-scroller" });

    const wrapper = scroller.createDiv({
      cls:
        mode === "stacked"
          ? "tl-h-content tl-horizontal tl-h-stacked"
          : "tl-h-content tl-horizontal tl-h-mixed"
    });

    todayBtn.addEventListener("click", () => {
      const today = this.getCalendariumCurrentYmd();
      if (!today) {
        new Notice("Calendarium is not installed.");
        return;
      }
      const ok = this.jumpContainerToYmd(scroller, today, ".tl-h-item");
      if (!ok) new Notice("No timeline entry for today found.");
    });

    if (mode === "mixed") {
      const rendered: Array<{ el: HTMLElement; left: HorizontalEdge; right: HorizontalEdge }> = [];

      for (const c of cards) {
        const cfg = this.getConfigFor(c.primaryTl);
        const rowEl = this.renderCrossCardRow(wrapper, c, cfg, ctx.sourcePath, ["tl-h-item"]);
        const edges = this.getHorizontalEdges(c, cfg);
        rendered.push({ el: rowEl, ...edges });
      }

      for (let i = 0; i < rendered.length - 1; i++) {
        this.applyHorizontalJoin(
          { el: rendered[i].el, right: rendered[i].right },
          { el: rendered[i + 1].el, left: rendered[i + 1].left }
        );
      }

      if (jumpToToday) {
        const today = this.getCalendariumCurrentYmd();
        if (today) this.jumpContainerToYmd(scroller, today, ".tl-h-item");
      }
      return;
    }

    // stacked: union-axis (only existing dates become columns)
    const axisKeys = Array.from(new Set(cards.map((c) => ymdSortKey(c.start)))).sort((a, b) => a - b);
    const colByKey = new Map<number, number>();
    for (let i = 0; i < axisKeys.length; i++) colByKey.set(axisKeys[i], i + 1);

    setCssProps(wrapper, { "--tl-h-cols": String(axisKeys.length) });

    const byTl = new Map<string, CardData[]>();
    for (const c of cards) {
      const key = c.primaryTl ?? "default";
      const list = byTl.get(key);
      if (list) list.push(c);
      else byTl.set(key, [c]);
    }

    const orderedTlKeys =
      filterNames.length > 0
        ? filterNames.filter((k) => byTl.has(k))
        : Array.from(byTl.keys()).sort((a, b) => a.localeCompare(b));

    for (const tlKey of orderedTlKeys) {
      const list = byTl.get(tlKey) ?? [];
      list.sort((a, b) => ymdSortKey(a.start) - ymdSortKey(b.start));

      const cfg = this.getConfigFor(tlKey);

      const tlRowWrap = wrapper.createDiv({ cls: "tl-h-timeline" });
      const rowGrid = tlRowWrap.createDiv({ cls: "tl-h-row" });
      setCssProps(rowGrid, { "--tl-h-cols": String(axisKeys.length) });

      const byDate = new Map<number, CardData[]>();
      for (const c of list) {
        const k = ymdSortKey(c.start);
        const arr = byDate.get(k);
        if (arr) arr.push(c);
        else byDate.set(k, [c]);
      }

      const sortedDateKeys = Array.from(byDate.keys()).sort((a, b) => {
        const ca = colByKey.get(a) ?? 0;
        const cb = colByKey.get(b) ?? 0;
        return ca - cb;
      });

      const renderedSlots: Array<{ col: number; el: HTMLElement; left: HorizontalEdge; right: HorizontalEdge }> = [];

      for (const dateKey of sortedDateKeys) {
        const col = colByKey.get(dateKey);
        if (!col) continue;

        const cardsAtDate = byDate.get(dateKey) ?? [];
        if (!cardsAtDate.length) continue;

        const slot = rowGrid.createDiv({ cls: "tl-h-slot" });
        setCssProps(slot, { "--tl-h-col": String(col) });

        let stored = false;
        for (const c of cardsAtDate) {
          const rowEl = this.renderCrossCardRow(slot, c, cfg, ctx.sourcePath, ["tl-h-item"]);
          if (!stored) {
            const edges = this.getHorizontalEdges(c, cfg);
            renderedSlots.push({ col, el: rowEl, ...edges });
            stored = true;
          }
        }
      }

      renderedSlots.sort((a, b) => a.col - b.col);
      for (let i = 0; i < renderedSlots.length - 1; i++) {
        const a = renderedSlots[i];
        const b = renderedSlots[i + 1];
        if (b.col === a.col + 1) {
          this.applyHorizontalJoin({ el: a.el, right: a.right }, { el: b.el, left: b.left });
        }
      }
    }

    if (jumpToToday) {
      const today = this.getCalendariumCurrentYmd();
      if (today) this.jumpContainerToYmd(scroller, today, ".tl-h-item");
    }
  }

  // Line clamp helper
  public applyFixedLineClamp(summaryEl: HTMLElement, lines: number) {
    const n = Math.max(1, Math.floor(lines || this.settings.maxSummaryLines));
    summaryEl.classList.add("tl-clamp");
    setCssProps(summaryEl, {
      "--tl-summary-lines": String(n),
      "--tl-summary-lh": "1.4"
    });
  }

  public formatRange(
    a: { y: number; m: number; d: number; mName?: string },
    b?: { y: number; m: number; d: number; mName?: string }
  ) {
    const f = (x: typeof a) => `${x.d} ${x.mName ?? x.m} ${x.y}`;

    if (!b) return f(a);

    const sameDay = a.y === b.y && a.m === b.m && a.d === b.d;
    if (sameDay) return f(a);

    const sameMY = a.y === b.y && a.m === b.m;
    return sameMY ? `${a.d}–${b.d} ${a.mName ?? a.m} ${a.y}` : `${f(a)} – ${f(b)}`;
  }

  private parseFcDate(val: FCDate | undefined): { y: number; m: number; d: number } | null {
    if (!val) return null;

    if (typeof val === "string") {
      const m = val.trim().match(/^(\d{1,6})-(\d{1,2})-(\d{1,2})/);
      return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
    }

    const y = Number(val.year);
    const d = Number(val.day);
    const mRaw = val.month;
    let mNum: number;

    if (typeof mRaw === "number") {
      mNum = mRaw;
    } else {
      const months = this.getMonths();
      const idx = months.findIndex((x) => x.toLowerCase() === String(mRaw).toLowerCase());
      mNum = idx >= 0 ? idx + 1 : Number(mRaw) || 1;
    }
    return { y, m: mNum, d };
  }

  public getMonths(calKey?: string): string[] {
    if (calKey) {
      const tl = this.settings.timelineConfigs[calKey];
      if (tl?.months) {
        const m = Array.isArray(tl.months)
          ? tl.months
          : String(tl.months)
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
        if (m.length) return m;
      }
      if (!this.settings.migratedLegacy) {
        const legacy = this.settings.monthOverrides[calKey];
        if (legacy) {
          const arr = Array.isArray(legacy)
            ? legacy
            : String(legacy)
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
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

  public getConfigFor(name?: string): ResolvedTimelineRenderConfig {
    const base: ResolvedTimelineRenderConfig = {
      maxSummaryLines: this.settings.maxSummaryLines,
      cardWidth: this.settings.cardWidth,
      cardHeight: this.settings.cardHeight,
      boxHeight: this.settings.boxHeight,
      sideGapLeft: this.settings.sideGapLeft,
      sideGapRight: this.settings.sideGapRight,
      align: "left" as TimelineAlign,
      colors: { ...(this.settings.defaultColors || {}) },
      months: undefined
    };
    if (!name) return base;

    const tl = this.settings.timelineConfigs[name] || {};
    base.maxSummaryLines = tl.maxSummaryLines ?? base.maxSummaryLines;
    base.cardWidth = tl.cardWidth ?? base.cardWidth;
    base.cardHeight = tl.cardHeight ?? base.cardHeight;
    base.boxHeight = tl.boxHeight ?? base.boxHeight;
    base.sideGapLeft = tl.sideGapLeft ?? base.sideGapLeft;
    base.sideGapRight = tl.sideGapRight ?? base.sideGapRight;
    base.align = tl.align ?? base.align;
    base.colors = { ...base.colors, ...(tl.colors || {}) };

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

    base.months =
      tl.months ??
      (!this.settings.migratedLegacy ? this.settings.monthOverrides[name] : undefined);

    return base;
  }

  public resolveLinkToSrc(link: string, sourcePath: string): string | undefined {
    if (/^https?:\/\//i.test(link)) return link;
    const dest = this.app.metadataCache.getFirstLinkpathDest(link, sourcePath);
    if (dest && dest instanceof TFile) {
      return this.app.vault.getResourcePath(dest);
    }
    return undefined;
  }

  private resolveImageSrc(file: TFile, fm: FrontmatterLike, sourcePath: string): string | undefined {
    const fmImage = fm["tl-image"];
    if (typeof fmImage === "string") {
      const src = this.resolveLinkToSrc(fmImage, sourcePath);
      if (src) return src;
    }

    const cache = this.app.metadataCache.getFileCache(file);

    for (const e of cache?.embeds ?? []) {
      if (/\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(e.link)) {
        const src = this.resolveLinkToSrc(e.link, sourcePath);
        if (src) return src;
      }
    }
    for (const l of cache?.links ?? []) {
      if (/\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(l.link)) {
        const src = this.resolveLinkToSrc(l.link, sourcePath);
        if (src) return src;
      }
    }

    const parent = this.app.vault.getAbstractFileByPath(file.parent?.path ?? "");
    if (parent instanceof TFolder) {
      for (const ch of parent.children) {
        if (ch instanceof TFile && /\.(png|jpe?g|webp|gif|avif)$/i.test(ch.name)) {
          return this.app.vault.getResourcePath(ch);
        }
      }
    }
    return undefined;
  }

  private findImageForFile(file: TFile): string | undefined {
    const cache = this.app.metadataCache.getFileCache(file);
    for (const e of cache?.embeds ?? []) {
      if (/\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(e.link)) return e.link;
    }
    for (const l of cache?.links ?? []) {
      if (/\.(png|jpe?g|webp|gif|avif)$/i.test(l.link)) return l.link;
    }
    const parent = this.app.vault.getAbstractFileByPath(file.parent?.path ?? "");
    if (parent instanceof TFolder) {
      for (const ch of parent.children) {
        if (ch instanceof TFile && /\.(png|jpe?g|webp|gif|avif)$/i.test(ch.name)) {
          return ch.path;
        }
      }
    }
    return undefined;
  }

  public attachHoverForAnchor(
    anchorEl: HTMLElement,
    hoverParent: HTMLElement,
    filePath: string,
    sourcePath: string
  ) {
    const makeForcedHoverEvent = (evt?: MouseEvent | TouchEvent): MouseEvent | TouchEvent => {
      // Touch: keep original (no ctrl concept)
      if (evt && typeof TouchEvent !== "undefined" && evt instanceof TouchEvent) return evt;

      const m: MouseEvent | undefined = evt && evt instanceof MouseEvent ? evt : undefined;

      const clientX = m?.clientX ?? 0;
      const clientY = m?.clientY ?? 0;
      const screenX = m?.screenX ?? 0;
      const screenY = m?.screenY ?? 0;

      // Force modifier keys "true" to avoid any "require Ctrl/Cmd" gating
      // in different containers (Bases / Reading view).
      return new MouseEvent("mousemove", {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        screenX,
        screenY,
        ctrlKey: true,
        metaKey: true,
        shiftKey: m?.shiftKey ?? false,
        altKey: m?.altKey ?? false
      });
    };

    const openPopover = (evt?: MouseEvent | TouchEvent) => {
      const ws = this.app.workspace as unknown as {
        trigger: (
          name: string,
          data: {
            event: MouseEvent | TouchEvent;
            source: string;
            hoverParent: HTMLElement;
            targetEl: HTMLElement;
            linktext: string;
            sourcePath: string;
          }
        ) => void;
      };
      ws.trigger("hover-link", {
        event: makeForcedHoverEvent(evt),
        source: "simple-timeline",
        hoverParent,
        targetEl: anchorEl,
        linktext: filePath,
        sourcePath
      });
    };

    anchorEl.addEventListener("mouseenter", (e: MouseEvent) => openPopover(e));

    let t: number | null = null;
    anchorEl.addEventListener(
      "touchstart",
      (e: TouchEvent) => {
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
    ["touchend", "touchmove", "touchcancel"].forEach((ev) =>
      anchorEl.addEventListener(ev, clear, { passive: true })
    );
  }

  public async extractFirstParagraph(file: TFile): Promise<string | undefined> {
    try {
      const raw = await this.app.vault.read(file);
      const text = raw.replace(/^---[\s\S]*?---\s*/m, "");
      const paras = text
        .split(/\r?\n\s*\r?\n/)
        .map((p) => p.trim())
        .filter(Boolean);

      for (const p of paras) {
        if (/^(#{1,6}\s|>\s|[-*+]\s|\d+\.\s)/.test(p)) continue;
        let clean = p
          .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
          .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
          .replace(/`{1,3}[^`]*`{1,3}/g, "")
          .replace(/[*_~]/g, "")
          .replace(/\s+/g, " ")
          .trim();

        if (clean) {
          if (clean.length > 400) clean = `${clean.slice(0, 397)}…`;
          return clean;
        }
      }
    } catch (e) {
      console.debug("simple-timeline: unable to extract summary", e);
    }
    return undefined;
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      (await this.loadData()) as Partial<SimpleTimelineSettings> | null
    );
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
    this.contentEl.empty();
  }

  waitForClose(): Promise<string | null> {
    return new Promise((res) => {
      this.resolve = res;
    });
  }
}

async function promptModal(app: App, opts: { title?: string; value?: string; placeholder?: string }) {
  const m = new InputModal(app, opts);
  m.open();
  return m.waitForClose();
}

class TimelineConfigModal extends Modal {
  private plugin: SimpleTimeline;
  private initialKey?: string;
  private initialCfg?: TimelineConfig;
  private resolve!: (val: { key: string; cfg: TimelineConfig } | null) => void;

  constructor(
    app: App,
    plugin: SimpleTimeline,
    params?: { key?: string; cfg?: TimelineConfig }
  ) {
    super(app);
    this.plugin = plugin;
    this.initialKey = params?.key;
    this.initialCfg = params?.cfg ? (JSON.parse(JSON.stringify(params.cfg)) as TimelineConfig) : {};
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.initialKey ? "Edit timeline" : "Create timeline" });

    let key = this.initialKey ?? "";
    const cfg: TimelineConfig = this.initialCfg ?? {};

    const addNum = (name: string, prop: TimelineNumericKey, ph: string) =>
      new Setting(contentEl)
        .setName(name)
        .setDesc("Empty = use defaults")
        .addText((t) => {
          const cur = cfg[prop];
          t.setPlaceholder(ph).setValue(cur != null ? String(cur) : "");
          t.onChange((v) => {
            const vv = v.trim();
            if (vv === "") {
              delete cfg[prop];
            } else {
              const n = Number(vv);
              if (Number.isFinite(n)) cfg[prop] = Math.floor(n);
            }
          });
        });

    new Setting(contentEl)
      .setName("Name")
      .setDesc("Example: travel")
      .addText((t) =>
        t.setValue(key).onChange((v) => {
          key = v.trim();
        })
      );

    new Setting(contentEl)
      .setName("Alignment")
      .setDesc("Where the image is placed in the cross layout.")
      .addDropdown((d) => {
        const cur: TimelineAlign = cfg.align ?? "left";
        d.addOption("left", "Left (image left)");
        d.addOption("right", "Right (image right)");
        d.setValue(cur);
        d.onChange((v) => {
          if (v === "right") cfg.align = "right";
          else delete cfg.align;
        });
      });

    addNum("Max. summary lines", "maxSummaryLines", "e.g. 7");
    addNum("Image width", "cardWidth", "e.g. 200");
    addNum("Image height", "cardHeight", "e.g. 315");
    addNum("Box height", "boxHeight", "e.g. 289");
    addNum("Inner left padding", "sideGapLeft", "e.g. 40");
    addNum("Inner right padding", "sideGapRight", "e.g. 40");

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

    let monthsText =
      Array.isArray(cfg.months) && cfg.months.length > 0
        ? cfg.months.join(", ")
        : (cfg.months as string | undefined) ?? "";

    new Setting(contentEl)
      .setName("Month names")
      .setDesc("Set own month names. Separate them with comma.")
      .addTextArea((ta) => {
        ta.inputEl.rows = 3;
        ta.setValue(monthsText);
        ta.onChange((v) => (monthsText = v));
      });

    const btns = contentEl.createDiv({ cls: "modal-button-container" });
    const saveBtn = btns.createEl("button", { text: "Save" });
    const cancelBtn = btns.createEl("button", { text: "Cancel" });

    saveBtn.addEventListener("click", () => {
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
  try {
    if (text.includes("\n") && /(\n-|\n\s*-)/.test(text)) {
      const y = parseYaml(text) as unknown;
      if (Array.isArray(y)) return y.map((v) => String(v)).filter(Boolean);
    }
  } catch (e) {
    console.debug("simple-timeline: invalid months YAML", e);
  }

  if (text.includes(",")) {
    return text
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
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

    const addNum = (name: string, key: DefaultsNumericKey, placeholder: string) =>
      new Setting(contentEl)
        .setName(name)
        .addText((t) => {
          t.setPlaceholder(placeholder);
          t.setValue(String(this.draft[key]));
          t.onChange((v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return;

            if (key === "maxSummaryLines") this.draft.maxSummaryLines = Math.floor(n);
            else if (key === "cardWidth") this.draft.cardWidth = Math.floor(n);
            else if (key === "cardHeight") this.draft.cardHeight = Math.floor(n);
            else if (key === "boxHeight") this.draft.boxHeight = Math.floor(n);
            else if (key === "sideGapLeft") this.draft.sideGapLeft = Math.floor(n);
            else if (key === "sideGapRight") this.draft.sideGapRight = Math.floor(n);
          });
        });

    addNum("Image width", "cardWidth", "200");
    addNum("Image height", "cardHeight", "315");
    addNum("Box height", "boxHeight", "289");
    addNum("Inner left padding", "sideGapLeft", "40");
    addNum("Inner right padding", "sideGapRight", "40");
    addNum("Max. summary lines", "maxSummaryLines", "7");

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

    new Setting(containerEl)
      .setName("Bases integration (optional)")
      .setDesc(
        "Registers custom bases view types (cross + horizontal). Requires Obsidian with bases support. Toggle needs a plugin reload to take effect."
      )
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.enableBasesIntegration)
          .onChange(async (v) => {
            this.plugin.settings.enableBasesIntegration = v;
            await this.plugin.saveSettings();
            new Notice(
              "Saved. Please reload the plugin (or restart Obsidian) for bases view registration changes to apply."
            );
          })
      );

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

    const keys = Object.keys(this.plugin.settings.timelineConfigs).sort((a, b) => a.localeCompare(b));
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

async function openTimelineWizard(app: App, plugin: SimpleTimeline, existingKey?: string) {
  const initCfg = existingKey ? plugin.settings.timelineConfigs[existingKey] : undefined;
  const modal = new TimelineConfigModal(app, plugin, { key: existingKey, cfg: initCfg });
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