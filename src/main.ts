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
  dateFormat: "D MMMM YYYY";
  cardWidth: number;
  cardHeight: number;
  boxHeight: number;
  sideGapLeft: number;
  sideGapRight: number;
  maxSummaryLines: number;
  defaultColors: {
    bg?: string;
    accent?: string;
    hover?: string;
    title?: string;
    date?: string;
  };
  timelineConfigs: Record<string, TimelineConfig>;
  monthOverrides: Record<string, string | string[]>;
  styleOverrides: Record<string, { bg?: string; accent?: string }>;
  migratedLegacy?: boolean;
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
type UnknownRecord = Record<string, unknown>;
type Ymd = { y: number; m: number; d: number };
type BasesOrderMode = "bases" | "start-asc" | "start-desc";

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

interface LinkCacheLike {
  link: string;
}

interface FileCacheLike {
  frontmatter?: unknown;
  embeds?: LinkCacheLike[];
  links?: LinkCacheLike[];
}

type BasesValueLike = {
  isEmpty?: () => boolean;
  toString: () => string;
  renderTo?: (el: HTMLElement, ctx?: unknown) => void;
  year?: unknown;
  month?: unknown;
  day?: unknown;
};

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

interface BasesConfigLike {
  get(key: string): unknown;
}

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
  start: Ymd;
  end?: Ymd;
  title: string;
  summary?: string;
  imgSrc?: string;
  sortKey: number;
  pos: number;
};

interface BasesViewOption {
  type: string;
  displayName: string;
  key: string;
  default: string;
}

interface BasesViewSpec {
  name: string;
  icon: string;
  factory: (controller: unknown, containerEl: HTMLElement) => unknown;
  options: () => BasesViewOption[];
}

type RegisterBasesViewFn = (type: string, spec: BasesViewSpec) => void;

const BASES_VIEW_TYPE_CROSS = "simple-timeline-cross";
const BASES_VIEW_TYPE_HORIZONTAL = "simple-timeline-horizontal";

type CssProps = Record<string, string>;

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

function toCommaListString(v: unknown): string | undefined {
  const prim = primitiveToString(v);
  if (prim != null) return prim;

  if (!Array.isArray(v)) return undefined;

  const parts = v
    .map((x) => primitiveToString(x))
    .filter((x): x is string => typeof x === "string" && x.length > 0);

  return parts.length ? parts.join(", ") : undefined;
}

function splitTimelineList(raw: string): string[] {
  const cleaned = raw.replace(/[\]["']/g, "");
  return cleaned
    .split(/[,;\n]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function ymdSortKey(v: Ymd): number {
  return v.y * 10000 + v.m * 100 + v.d;
}

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

function setCssProps(el: HTMLElement, props: CssProps): void {
  for (const [name, value] of Object.entries(props)) {
    if (name.startsWith("--")) el.style.setProperty(name, value);
    else (el.style as CSSStyleDeclaration & Record<string, string>)[name] = value;
  }
}

function clearEl(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function addClasses(el: HTMLElement, ...classes: Array<string | undefined>): void {
  for (const cls of classes) {
    if (cls) el.classList.add(cls);
  }
}

function setText(el: HTMLElement, text: string): void {
  el.textContent = text;
}

function getDocumentFor(el?: HTMLElement): Document {
  return el?.ownerDocument ?? document;
}

type CreateOpts = {
  cls?: string | string[];
  text?: string;
  attr?: Record<string, string>;
};

function appendEl<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tag: K,
  opts?: CreateOpts
): HTMLElementTagNameMap[K] {
  const el = getDocumentFor(parent).createElement(tag);
  if (opts?.cls) {
    const classes = Array.isArray(opts.cls) ? opts.cls : opts.cls.split(/\s+/).filter(Boolean);
    addClasses(el, ...classes);
  }
  if (opts?.text != null) el.textContent = opts.text;
  if (opts?.attr) {
    for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
  }
  parent.appendChild(el);
  return el;
}

function appendDiv(parent: HTMLElement, cls?: string | string[]): HTMLDivElement {
  return appendEl(parent, "div", cls ? { cls } : undefined);
}

function cloneConfig(cfg?: TimelineConfig): TimelineConfig {
  if (!cfg) return {};
  return JSON.parse(JSON.stringify(cfg)) as TimelineConfig;
}

function parseMonths(text: string): string[] | string | undefined {
  if (!text) return undefined;

  try {
    if (text.includes("\n") && /(\n-|\n\s*-)/.test(text)) {
      const y = parseYaml(text) as unknown;
      if (Array.isArray(y)) {
        return y.map((v) => String(v)).filter(Boolean);
      }
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

export default class SimpleTimeline extends Plugin {
  settings!: SimpleTimelineSettings;

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.migrateLegacyToTimelineConfigs();

    this.tryRegisterBasesViews();

    this.registerMarkdownCodeBlockProcessor(
      "timeline-cal",
      (src: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
        void this.renderTimeline(src, el, ctx);
      }
    );

    this.registerMarkdownCodeBlockProcessor(
      "timeline-h",
      (src: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
        void this.renderTimelineHorizontal(src, el, ctx);
      }
    );

    this.addCommand({
      id: "set-cal-date",
      name: "Timeline set date",
      checkCallback: (checking: boolean) => {
        const file = this.getActiveMarkdownFile();
        if (!file) return false;
        if (!checking) void this.promptSetDate(file, false);
        return true;
      }
    });

    this.addCommand({
      id: "set-cal-range",
      name: "Timeline set date range",
      checkCallback: (checking: boolean) => {
        const file = this.getActiveMarkdownFile();
        if (!file) return false;
        if (!checking) void this.promptSetDate(file, true);
        return true;
      }
    });

    this.addCommand({
      id: "edit-timelines",
      name: "Timeline edit timelines",
      checkCallback: (checking: boolean) => {
        const file = this.getActiveMarkdownFile();
        if (!file) return false;
        if (!checking) void this.promptEditTimelines(file);
        return true;
      }
    });

    this.addCommand({
      id: "set-summary",
      name: "Timeline set summary",
      checkCallback: (checking: boolean) => {
        const file = this.getActiveMarkdownFile();
        if (!file) return false;
        if (!checking) void this.promptSetSummary(file);
        return true;
      }
    });

    this.addCommand({
      id: "adopt-first-image",
      name: "Timeline use first image as tl image",
      checkCallback: (checking: boolean) => {
        const file = this.getActiveMarkdownFile();
        if (!file) return false;
        if (!checking) void this.adoptFirstImage(file);
        return true;
      }
    });

    this.addSettingTab(new SimpleTimelineSettingsTab(this.app, this));
  }

  onunload(): void {
    // no-op
  }

  private getActiveMarkdownFile(): TFile | null {
    const file = this.app.workspace.getActiveFile();
    if (!file) return null;
    return file.extension === "md" ? file : null;
  }

  private getFileCacheSafe(file: TFile): FileCacheLike {
    const raw = this.app.metadataCache.getFileCache(file) as unknown;
    if (!isRecord(raw)) return {};
    return raw as FileCacheLike;
  }

  private getFrontmatter(file: TFile): FrontmatterLike | undefined {
    const cache = this.getFileCacheSafe(file);
    const fm = cache.frontmatter;
    return isRecord(fm) ? (fm as FrontmatterLike) : undefined;
  }

  private getFrontmatterValue(file: TFile, key: string): unknown {
    return this.getFrontmatter(file)?.[key];
  }

  private async updateFrontmatter(
    file: TFile,
    updater: (fm: FrontmatterLike) => void
  ): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, updater);

  }

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
    return normalizeStringArray(opts["names"] ?? opts["name"]);
  }

  private parseJumpToTodayFromOptions(opts: UnknownRecord): boolean {
    return opts["jumpToToday"] === true;
  }

  private tryParseYamlOrString(input: string): unknown {
    const trimmed = String(input).trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || trimmed.includes(":")) {
      return parseYaml(trimmed);
    }
    return trimmed;
  }

  public getCalendariumCurrentYmd(): Ymd | null {
    const pluginsRoot = (this.app as unknown as { plugins?: unknown }).plugins;
    if (!isRecord(pluginsRoot)) return null;

    const getPlugin = pluginsRoot["getPlugin"];
    if (!isFunction(getPlugin)) return null;

    const calendarium = getPlugin.call(pluginsRoot, "calendarium");
    if (!isRecord(calendarium)) return null;

    const apiRoot = calendarium["api"];
    if (!isRecord(apiRoot)) return null;

    const directGetCurrentDate = apiRoot["getCurrentDate"];
    if (isFunction(directGetCurrentDate)) {
      const raw = directGetCurrentDate.call(apiRoot);
      if (isRecord(raw)) {
        const y = Number(raw["year"]);
        const monthZero = Number(raw["month"]);
        const d = Number(raw["day"]);
        if (Number.isFinite(y) && Number.isFinite(monthZero) && Number.isFinite(d) && y !== 0) {
          return { y, m: monthZero + 1, d };
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
    const monthZero = Number(raw["month"]);
    const d = Number(raw["day"]);

    if (Number.isFinite(y) && Number.isFinite(monthZero) && Number.isFinite(d) && y !== 0) {
      return { y, m: monthZero + 1, d };
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
      const rangeEnd = Number.isFinite(endKey) ? endKey : startKey;

      if (targetKey >= startKey && targetKey <= rangeEnd) {
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

  private parseFcDate(val: FCDate | undefined, calKey?: string): Ymd | null {
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
      const months = this.getMonths(calKey);
      const idx = months.findIndex((x) => x.toLowerCase() === String(mRaw).toLowerCase());
      mNum = idx >= 0 ? idx + 1 : Number(mRaw) || 1;
    }

    if (!Number.isFinite(y) || !Number.isFinite(mNum) || !Number.isFinite(d)) return null;
    return { y, m: mNum, d };
  }

  public formatRange(
    a: { y: number; m: number; d: number; mName?: string },
    b?: { y: number; m: number; d: number; mName?: string }
  ): string {
    const f = (x: typeof a) => `${x.d} ${x.mName ?? x.m} ${x.y}`;

    if (!b) return f(a);

    const sameDay = a.y === b.y && a.m === b.m && a.d === b.d;
    if (sameDay) return f(a);

    const sameMonthYear = a.y === b.y && a.m === b.m;
    return sameMonthYear ? `${a.d}–${b.d} ${a.mName ?? a.m} ${a.y}` : `${f(a)} – ${f(b)}`;
  }

  public getMonths(calKey?: string): string[] {
    if (calKey) {
      const tl = this.settings.timelineConfigs[calKey];
      if (tl?.months) {
        const months = Array.isArray(tl.months)
          ? tl.months
          : String(tl.months)
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
        if (months.length) return months;
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
      align: "left",
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

  public applyFixedLineClamp(summaryEl: HTMLElement, lines: number): void {
    const n = Math.max(1, Math.floor(lines || this.settings.maxSummaryLines));
    addClasses(summaryEl, "tl-clamp");
    setCssProps(summaryEl, {
      "--tl-summary-lines": String(n),
      "--tl-summary-lh": "1.4"
    });
  }

  public resolveLinkToSrc(link: string, sourcePath: string): string | undefined {
    if (/^https?:\/\//i.test(link)) return link;
    const dest = this.app.metadataCache.getFirstLinkpathDest(link, sourcePath);
    return dest instanceof TFile ? this.app.vault.getResourcePath(dest) : undefined;
  }

  private getParentFolder(file: TFile): TFolder | null {
    const parentPath = file.parent?.path ?? "";
    const parent = this.app.vault.getAbstractFileByPath(parentPath);
    return parent instanceof TFolder ? parent : null;
  }

  private resolveImageSrc(file: TFile, fm: FrontmatterLike, sourcePath: string): string | undefined {
    const fmImage = fm["tl-image"];
    if (typeof fmImage === "string") {
      const src = this.resolveLinkToSrc(fmImage, sourcePath);
      if (src) return src;
    }

    const cache = this.getFileCacheSafe(file);

    for (const e of cache.embeds ?? []) {
      if (/\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(e.link)) {
        const src = this.resolveLinkToSrc(e.link, sourcePath);
        if (src) return src;
      }
    }

    for (const l of cache.links ?? []) {
      if (/\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(l.link)) {
        const src = this.resolveLinkToSrc(l.link, sourcePath);
        if (src) return src;
      }
    }

    const parent = this.getParentFolder(file);
    if (!parent) return undefined;

    for (const ch of parent.children) {
      if (ch instanceof TFile && /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(ch.name)) {
        return this.app.vault.getResourcePath(ch);
      }
    }

    return undefined;
  }

  private findImageForFile(file: TFile): string | undefined {
    const cache = this.getFileCacheSafe(file);

    for (const e of cache.embeds ?? []) {
      if (/\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(e.link)) return e.link;
    }

    for (const l of cache.links ?? []) {
      if (/\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(l.link)) return l.link;
    }

    const parent = this.getParentFolder(file);
    if (!parent) return undefined;

    for (const ch of parent.children) {
      if (ch instanceof TFile && /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(ch.name)) {
        return ch.path;
      }
    }

    return undefined;
  }

  public attachHoverForAnchor(
    anchorEl: HTMLElement,
    hoverParent: HTMLElement,
    filePath: string,
    sourcePath: string
  ): void {
    const makeForcedHoverEvent = (evt?: MouseEvent | TouchEvent): MouseEvent | TouchEvent => {
      if (evt && typeof TouchEvent !== "undefined" && evt instanceof TouchEvent) return evt;

      const m = evt instanceof MouseEvent ? evt : undefined;
      const ownerDocument = getDocumentFor(anchorEl);
      const view = ownerDocument.defaultView ?? window;

      return new view.MouseEvent("mousemove", {
        bubbles: true,
        cancelable: true,
        clientX: m?.clientX ?? 0,
        clientY: m?.clientY ?? 0,
        screenX: m?.screenX ?? 0,
        screenY: m?.screenY ?? 0,
        ctrlKey: true,
        metaKey: true,
        shiftKey: m?.shiftKey ?? false,
        altKey: m?.altKey ?? false
      });
    };

    const ws = this.app.workspace as unknown as {
      trigger?: (
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

    const openPopover = (evt?: MouseEvent | TouchEvent) => {
      if (!isFunction(ws.trigger)) return;
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

    let timer: number | null = null;

    anchorEl.addEventListener(
      "touchstart",
      (e: TouchEvent) => {
        timer = window.setTimeout(() => openPopover(e), 350);
      },
      { passive: true }
    );

    const clear = () => {
      if (timer != null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    for (const ev of ["touchend", "touchmove", "touchcancel"] as const) {
      anchorEl.addEventListener(ev, clear, { passive: true });
    }
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
          .replace(/!\[[^\]]*]\([^)]+\)/g, "")
          .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
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

  private async promptSetDate(file: TFile, range: boolean): Promise<void> {
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

    await this.updateFrontmatter(file, (fm) => {
      try {
        fm["fc-date"] = this.tryParseYamlOrString(start);
        if (range && end) fm["fc-end"] = this.tryParseYamlOrString(end);
        else if (!range) delete fm["fc-end"];
      } catch {
        new Notice("Invalid date.");
      }
    });
  }

  private async promptEditTimelines(file: TFile): Promise<void> {
    const curVal = this.getFrontmatterValue(file, "timelines");
    const curStr = toCommaListString(curVal) ?? "";

    const val = await promptModal(this.app, {
      title: "Timelines (comma-separated)",
      value: curStr,
      placeholder: "Travel, Expedition, Notes"
    });
    if (val == null) return;

    const arr = val
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    await this.updateFrontmatter(file, (fm) => {
      fm["timelines"] = arr;
    });
  }

  private async promptSetSummary(file: TFile): Promise<void> {
    const curVal = this.getFrontmatterValue(file, "tl-summary");
    const curStr = primitiveToString(curVal) ?? "";

    const val = await promptModal(this.app, {
      title: "Short summary",
      value: curStr,
      placeholder: "Multi-line allowed (YAML | or |- in frontmatter)"
    });
    if (val == null) return;

    await this.updateFrontmatter(file, (fm) => {
      fm["tl-summary"] = String(val);
    });
  }

  private async adoptFirstImage(file: TFile): Promise<void> {
    const link = this.findImageForFile(file);
    if (!link) {
      new Notice("No image found.");
      return;
    }

    await this.updateFrontmatter(file, (fm) => {
      fm["tl-image"] = link;
    });

    new Notice("Timeline image set from first image.");
  }

  private async collectCards(
    filterNames: string[],
    ctx: MarkdownPostProcessorContext
  ): Promise<CardData[]> {
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

      const primaryTl = filterNames.length
        ? tlList.find((t) => filterNames.includes(t)) || tlList[0]
        : tlList[0];

      const start = this.parseFcDate(fm["fc-date"] as FCDate | undefined, primaryTl);
      if (!start) continue;

      const end = fm["fc-end"]
        ? this.parseFcDate(fm["fc-end"] as FCDate | undefined, primaryTl) ?? undefined
        : undefined;

      const months = this.getMonths(primaryTl);
      const mNameStart = months[(start.m - 1 + months.length) % months.length] ?? String(start.m);
      const mNameEnd = end
        ? months[(end.m - 1 + months.length) % months.length] ?? String(end.m)
        : undefined;

      const title = primitiveToString(fm["tl-title"]) ?? f.basename;

      let summary: string | undefined;
      const rawSummary = fm["tl-summary"];
      if (typeof rawSummary === "string") summary = rawSummary;
      else if (typeof rawSummary === "number" || typeof rawSummary === "boolean") {
        summary = String(rawSummary);
      } else if (rawSummary != null) {
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

  private getHorizontalEdges(
    c: CardData,
    cfg: ResolvedTimelineRenderConfig
  ): { left: HorizontalEdge; right: HorizontalEdge } {
    const hasMedia = !!c.imgSrc;
    const align = cfg.align ?? "left";
    if (!hasMedia) return { left: "box", right: "box" };
    if (align === "right") return { left: "box", right: "media" };
    return { left: "media", right: "box" };
  }

  private applyHorizontalJoin(
    a: { el: HTMLElement; right: HorizontalEdge },
    b: { el: HTMLElement; left: HorizontalEdge }
  ): void {
    if (a.right === "box") addClasses(a.el, "tl-h-join-right-box");
    if (b.left === "box") addClasses(b.el, "tl-h-join-left-box");
  }

  private buildRoot(el: HTMLElement): HTMLDivElement {
    const root = appendDiv(el, "simple-timeline");
    return root;
  }

  private renderCrossCardRow(
    wrapper: HTMLElement,
    c: CardData,
    cfg: ResolvedTimelineRenderConfig,
    sourcePathForHover: string,
    extraRowClasses: string[] = []
  ): HTMLElement {
    const row = appendDiv(wrapper, ["tl-row", ...extraRowClasses]);
    row.dataset.tlStartKey = String(ymdSortKey({ y: c.start.y, m: c.start.m, d: c.start.d }));
    if (c.end) {
      row.dataset.tlEndKey = String(ymdSortKey({ y: c.end.y, m: c.end.m, d: c.end.d }));
    }

    if ((cfg.align ?? "left") === "right") addClasses(row, "tl-align-right");

    setCssProps(row, {
      paddingLeft: `${cfg.sideGapLeft}px`,
      paddingRight: `${cfg.sideGapRight}px`,
      "--tl-bg": cfg.colors.bg || "var(--background-primary)",
      "--tl-accent": cfg.colors.accent || "var(--background-modifier-border)",
      "--tl-hover": cfg.colors.hover || "var(--interactive-accent)"
    });

    const grid = appendDiv(row, "tl-grid");
    const hasMedia = !!c.imgSrc;
    addClasses(grid, hasMedia ? "has-media" : "no-media");

    setCssProps(grid, {
      display: "grid",
      alignItems: "center",
      "--tl-media-w": `${cfg.cardWidth}px`
    });

    let media: HTMLDivElement | null = null;

    if (hasMedia && c.imgSrc) {
      media = appendDiv(grid, "tl-media");
      setCssProps(media, {
        width: `${cfg.cardWidth}px`,
        height: `${cfg.cardHeight}px`,
        position: "relative"
      });

      const img = appendEl(media, "img", {
        attr: {
          src: c.imgSrc,
          alt: c.title,
          loading: "lazy"
        }
      });

      setCssProps(img, {
        width: "100%",
        height: "100%",
        objectFit: "cover",
        display: "block"
      });
    }

    const box = appendDiv(grid, ["tl-box", "callout", hasMedia ? "has-media" : "no-media"]);
    setCssProps(box, {
      height: `${cfg.boxHeight}px`,
      boxSizing: "border-box",
      "--tl-bg": cfg.colors.bg || "var(--background-primary)",
      "--tl-accent": cfg.colors.accent || "var(--background-modifier-border)",
      "--tl-hover": cfg.colors.hover || "var(--interactive-accent)"
    });

    const titleEl = appendEl(box, "h1", { cls: ["tl-title", "tl-title-colored"], text: c.title });
    const dateEl = appendEl(box, "h4", {
      cls: ["tl-date", "tl-date-colored"],
      text: this.formatRange(c.start, c.end)
    });
    const sum = appendDiv(box, "tl-summary");

    if (cfg.colors.title) titleEl.style.color = cfg.colors.title;
    if (cfg.colors.date) dateEl.style.color = cfg.colors.date;
    if (c.summary) setText(sum, c.summary);

    if (media) {
      const aImg = appendEl(media, "a", {
        cls: ["internal-link", "tl-hover-anchor"],
        attr: {
          href: c.file.path,
          "data-href": c.file.path,
          "aria-label": c.title
        }
      });
      this.attachHoverForAnchor(aImg, media, c.file.path, sourcePathForHover);
    }

    const aBox = appendEl(box, "a", {
      cls: ["internal-link", "tl-hover-anchor"],
      attr: {
        href: c.file.path,
        "data-href": c.file.path,
        "aria-label": c.title
      }
    });
    this.attachHoverForAnchor(aBox, box, c.file.path, sourcePathForHover);

    this.applyFixedLineClamp(sum, cfg.maxSummaryLines);
    return row;
  }

  private async renderTimeline(
    src: string,
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext
  ): Promise<void> {
    clearEl(el);

    const root = this.buildRoot(el);
    const opts = this.parseBlockOptionsObject(src);
    const filterNames = this.parseNamesFromOptions(opts);
    const jumpToToday = this.parseJumpToTodayFromOptions(opts);
    const cards = await this.collectCards(filterNames, ctx);

    const controls = appendDiv(root, "tl-controls");
    const todayBtn = appendEl(controls, "button", { text: "Today" });
    const wrapper = appendDiv(root, ["tl-wrapper", "tl-cross-mode"]);

    todayBtn.addEventListener("click", () => {
      const today = this.getCalendariumCurrentYmd();
      if (!today) {
        new Notice("Calendarium is not installed.");
        return;
      }
      const ok = this.jumpContainerToYmd(wrapper);
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

  private async renderTimelineHorizontal(
    src: string,
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext
  ): Promise<void> {
    clearEl(el);

    const root = this.buildRoot(el);
    const opts = this.parseBlockOptionsObject(src);
    const filterNames = this.parseNamesFromOptions(opts);
    const jumpToToday = this.parseJumpToTodayFromOptions(opts);
    const mode: HorizontalMode = parseHorizontalMode(opts["mode"]) ?? "mixed";
    const cards = await this.collectCards(filterNames, ctx);

    const controls = appendDiv(root, "tl-controls");
    const todayBtn = appendEl(controls, "button", { text: "Today" });
    const scroller = appendDiv(root, "tl-h-scroller");
    const wrapper = appendDiv(scroller, [
      "tl-h-content",
      "tl-horizontal",
      mode === "stacked" ? "tl-h-stacked" : "tl-h-mixed"
    ]);

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
        rendered.push({ el: rowEl, ...this.getHorizontalEdges(c, cfg) });
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

      const tlRowWrap = appendDiv(wrapper, "tl-h-timeline");
      const rowGrid = appendDiv(tlRowWrap, "tl-h-row");
      setCssProps(rowGrid, { "--tl-h-cols": String(axisKeys.length) });

      const byDate = new Map<number, CardData[]>();
      for (const c of list) {
        const k = ymdSortKey(c.start);
        const arr = byDate.get(k);
        if (arr) arr.push(c);
        else byDate.set(k, [c]);
      }

      const renderedSlots: Array<{
        col: number;
        el: HTMLElement;
        left: HorizontalEdge;
        right: HorizontalEdge;
      }> = [];

      for (const dateKey of Array.from(byDate.keys()).sort((a, b) => {
        const ca = colByKey.get(a) ?? 0;
        const cb = colByKey.get(b) ?? 0;
        return ca - cb;
      })) {
        const col = colByKey.get(dateKey);
        if (!col) continue;

        const slot = appendDiv(rowGrid, "tl-h-slot");
        setCssProps(slot, { "--tl-h-col": String(col) });

        const cardsAtDate = byDate.get(dateKey) ?? [];
        let stored = false;

        for (const c of cardsAtDate) {
          const rowEl = this.renderCrossCardRow(slot, c, cfg, ctx.sourcePath, ["tl-h-item"]);
          if (!stored) {
            renderedSlots.push({ col, el: rowEl, ...this.getHorizontalEdges(c, cfg) });
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

  private tryRegisterBasesViews(): void {
    if (!this.settings.enableBasesIntegration) return;

    const maybeRegister = (this as unknown as { registerBasesView?: unknown }).registerBasesView;
    if (!isFunction(maybeRegister)) {
      console.debug("simple-timeline: registerBasesView not available.");
      return;
    }

    const maybeBasesView = (ObsidianNS as unknown as UnknownRecord)["BasesView"];
    if (!isFunction(maybeBasesView)) {
      console.debug("simple-timeline: BasesView not available.");
      return;
    }

    const registerBasesView = maybeRegister as RegisterBasesViewFn;
    const BasesViewCtor = maybeBasesView as BasesViewConstructor;

    abstract class TimelineBasesBaseView extends BasesViewCtor {
      protected hostEl: HTMLElement;
      protected plugin: SimpleTimeline;
      protected renderToken = 0;

      constructor(controller: unknown, parentEl: HTMLElement, plugin: SimpleTimeline) {
        super(controller);
        this.plugin = plugin;
        this.hostEl = appendDiv(parentEl, ["simple-timeline", "tl-bases-host"]);
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

        if (isRecord(v) && isFunction(v["toString"])) {
          try {
            const out = v["toString"]();
            if (typeof out === "string" && out !== "[object Object]") return out;
          } catch {
            // ignore
          }
        }

        return "";
      }

      protected getControllerFilePath(): string | undefined {
        const c = this.controller;
        if (!isRecord(c)) return undefined;

        const maybeFile = c["file"];
        if (maybeFile instanceof TFile) return maybeFile.path;
        if (isRecord(maybeFile) && typeof maybeFile["path"] === "string") {
          return maybeFile["path"];
        }

        return undefined;
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

      protected valueToYmd(value: BasesValueLike | null | undefined): Ymd | null {
        if (!value) return null;
        if (typeof value.isEmpty === "function" && value.isEmpty()) return null;

        const y = Number(value.year);
        const m = Number(value.month);
        const d = Number(value.day);

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

        const raw = String(value.toString?.() ?? value).trim();
        const match = raw.match(/^(\d{1,6})-(\d{1,2})-(\d{1,2})/);
        if (match) return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };

        const asNum = Number(raw);
        if (Number.isFinite(asNum) && asNum > 0) {
          const dt = new Date(asNum);
          if (!Number.isNaN(dt.getTime())) {
            return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
          }
        }

        return null;
      }

      protected resolveImageFromEntryValue(
        entry: BasesEntryLike,
        imageProp: string,
        sourcePath: string
      ): string | undefined {
        if (!imageProp) return undefined;

        const v = entry.getValue?.(imageProp);
        if (!v || v.isEmpty?.()) return undefined;

        try {
          if (typeof v.renderTo === "function") {
            const tmp = getDocumentFor(this.hostEl).createElement("div");
            const renderContext = (this.app as unknown as { renderContext?: unknown }).renderContext;
            if (renderContext !== undefined) v.renderTo(tmp, renderContext);
            else v.renderTo(tmp);

            const img = tmp.querySelector<HTMLImageElement>("img");
            const src = img?.getAttribute("src") ?? undefined;
            if (src) return src;
          }
        } catch {
          // ignore
        }

        const s = String(v.toString?.() ?? "").trim();
        return s ? this.plugin.resolveLinkToSrc(s, sourcePath) : undefined;
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
        if (!(entry.file instanceof TFile)) return null;

        const file = entry.file;
        const start = this.valueToYmd(entry.getValue?.(startProp));
        if (!start) return null;

        const end = endProp ? this.valueToYmd(entry.getValue?.(endProp)) ?? undefined : undefined;
        const titleValue = titleProp ? entry.getValue?.(titleProp) : null;
        const title =
          titleValue && !titleValue.isEmpty?.() ? String(titleValue.toString()) : file.basename;

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

      protected async buildCardData(
        it: BasesTimelineItem,
        tlKey: string | undefined,
        months: string[]
      ): Promise<CardData> {
        let summary = it.summary;
        if (!summary) summary = await this.plugin.extractFirstParagraph(it.file);

        const mNameStart = months[(it.start.m - 1 + months.length) % months.length] ?? String(it.start.m);
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

      protected renderCrossCard(
        wrapper: HTMLElement,
        c: CardData,
        cfg: ResolvedTimelineRenderConfig
      ): HTMLElement {
        const sourcePath = this.getControllerFilePath() ?? c.file.path;
        return this.plugin.renderCrossCardRow(wrapper, c, cfg, sourcePath);
      }
    }

    class TimelineBasesCrossView extends TimelineBasesBaseView {
      readonly type = BASES_VIEW_TYPE_CROSS;

      public onDataUpdated(): void {
        clearEl(this.hostEl);

        const controls = appendDiv(this.hostEl, "tl-controls");
        const todayBtn = appendEl(controls, "button", { text: "Today" });
        const wrapper = appendDiv(this.hostEl, ["tl-wrapper", "tl-cross-mode"]);

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
        const token = ++this.renderToken;
        const groups = this.data?.groupedData ?? [];

        todayBtn.addEventListener("click", () => {
          const today = this.plugin.getCalendariumCurrentYmd();
          if (!today) {
            new Notice("Calendarium is not installed");
            return;
          }
          const ok = this.plugin.jumpContainerToYmd(wrapper, today);
          if (!ok) new Notice("No timeline entry found for today");
        });

        const renderItems = async (items: BasesTimelineItem[]) => {
          const list = [...items];
          if (orderMode === "start-asc" || orderMode === "start-desc") {
            const dir = orderMode === "start-desc" ? -1 : 1;
            list.sort((a, b) => (a.sortKey !== b.sortKey ? dir * (a.sortKey - b.sortKey) : a.pos - b.pos));
          }

          for (const it of list) {
            if (token !== this.renderToken) return;

            const tlKey = timelineConfigName ?? this.getTimelineKeyFromEntry(it.entry, timelineProperty);
            const cfg = this.plugin.getConfigFor(tlKey);
            const months = this.plugin.getMonths(tlKey);
            const card = await this.buildCardData(it, tlKey, months);

            if (token !== this.renderToken) return;
            this.renderCrossCard(wrapper, card, cfg);
          }
        };

        const hasMeaningfulGroups = groups.some((g) => {
          const t = this.getGroupKeyText(g.key);
          return !!t && t !== "null";
        });

        if (hasMeaningfulGroups) {
          void (async () => {
            let pos = 0;

            for (const group of groups) {
              if (token !== this.renderToken) return;

              const keyText = this.getGroupKeyText(group.key);
              if (keyText && keyText !== "null") {
                const h = appendEl(wrapper, "h3", { cls: "tl-bases-group-title", text: keyText });
                void h;
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
        clearEl(this.hostEl);

        const controls = appendDiv(this.hostEl, "tl-controls");
        const todayBtn = appendEl(controls, "button", { text: "Today" });
        const scroller = appendDiv(this.hostEl, "tl-h-scroller");

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

        const token = ++this.renderToken;
        const groups = this.data?.groupedData ?? [];

        todayBtn.addEventListener("click", () => {
          const today = this.plugin.getCalendariumCurrentYmd();
          if (!today) {
            new Notice("Calendarium is not installed");
            return;
          }
          const ok = this.plugin.jumpContainerToYmd(scroller, today, ".tl-h-item");
          if (!ok) new Notice("No timeline entry found for today");
        });

        const renderHorizontalItems = async (items: BasesTimelineItem[], host: HTMLElement) => {
          const wrapper = appendDiv(host, [
            "tl-h-content",
            "tl-horizontal",
            mode === "stacked" ? "tl-h-stacked" : "tl-h-mixed"
          ]);

          const list = [...items];
          if (orderMode === "start-asc" || orderMode === "start-desc") {
            const dir = orderMode === "start-desc" ? -1 : 1;
            list.sort((a, b) => (a.sortKey !== b.sortKey ? dir * (a.sortKey - b.sortKey) : a.pos - b.pos));
          }

          if (mode === "mixed") {
            const rendered: Array<{ el: HTMLElement; left: HorizontalEdge; right: HorizontalEdge }> = [];

            for (const it of list) {
              if (token !== this.renderToken) return;

              const tlKey = timelineConfigName ?? this.getTimelineKeyFromEntry(it.entry, timelineProperty);
              const cfg = this.plugin.getConfigFor(tlKey);
              const months = this.plugin.getMonths(tlKey);
              const card = await this.buildCardData(it, tlKey, months);

              if (token !== this.renderToken) return;

              const rowEl = this.renderCrossCard(wrapper, card, cfg);
              addClasses(rowEl, "tl-h-item");
              rendered.push({ el: rowEl, ...this.plugin.getHorizontalEdges(card, cfg) });
            }

            for (let i = 0; i < rendered.length - 1; i++) {
              this.plugin.applyHorizontalJoin(
                { el: rendered[i].el, right: rendered[i].right },
                { el: rendered[i + 1].el, left: rendered[i + 1].left }
              );
            }

            return;
          }

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

          const byTl = new Map<string, BasesTimelineItem[]>();
          for (const it of list) {
            const tlKey = timelineConfigName ?? this.getTimelineKeyFromEntry(it.entry, timelineProperty);
            const k = tlKey ?? "default";
            const arr = byTl.get(k);
            if (arr) arr.push(it);
            else byTl.set(k, [it]);
          }

          const tlKeys =
            orderMode === "bases" ? Array.from(byTl.keys()) : Array.from(byTl.keys()).sort();

          for (const tlKey of tlKeys) {
            if (token !== this.renderToken) return;

            const rowItems = byTl.get(tlKey) ?? [];
            const cfg = this.plugin.getConfigFor(tlKey);
            const months = this.plugin.getMonths(tlKey);

            const rowWrap = appendDiv(wrapper, "tl-h-timeline");
            const rowGrid = appendDiv(rowWrap, "tl-h-row");
            setCssProps(rowGrid, { "--tl-h-cols": String(axisKeys.length) });

            const byDate = new Map<number, BasesTimelineItem[]>();
            for (const it of rowItems) {
              const k = ymdSortKey(it.start);
              const arr = byDate.get(k);
              if (arr) arr.push(it);
              else byDate.set(k, [it]);
            }

            const renderedSlots: Array<{
              col: number;
              el: HTMLElement;
              left: HorizontalEdge;
              right: HorizontalEdge;
            }> = [];

            for (const dateKey of Array.from(byDate.keys()).sort((a, b) => {
              const ca = colByKey.get(a) ?? 0;
              const cb = colByKey.get(b) ?? 0;
              return ca - cb;
            })) {
              if (token !== this.renderToken) return;

              const col = colByKey.get(dateKey);
              if (!col) continue;

              const slot = appendDiv(rowGrid, "tl-h-slot");
              setCssProps(slot, { "--tl-h-col": String(col) });

              const cardsAtDate = byDate.get(dateKey) ?? [];
              let stored = false;

              for (const it of cardsAtDate) {
                const card = await this.buildCardData(it, tlKey, months);
                if (token !== this.renderToken) return;

                const rowEl = this.renderCrossCard(slot, card, cfg);
                addClasses(rowEl, "tl-h-item");

                if (!stored) {
                  renderedSlots.push({ col, el: rowEl, ...this.plugin.getHorizontalEdges(card, cfg) });
                  stored = true;
                }
              }
            }

            renderedSlots.sort((a, b) => a.col - b.col);
            for (let i = 0; i < renderedSlots.length - 1; i++) {
              const a = renderedSlots[i];
              const b = renderedSlots[i + 1];
              if (b.col === a.col + 1) {
                this.plugin.applyHorizontalJoin(
                  { el: a.el, right: a.right },
                  { el: b.el, left: b.left }
                );
              }
            }
          }
        };

        const renderGroup = async (items: BasesTimelineItem[], groupTitle?: string) => {
          if (groupTitle) {
            const titleWrap = appendDiv(scroller, "tl-bases-group-title");
            appendEl(titleWrap, "h3", { text: groupTitle });
          }
          const groupHost = appendDiv(scroller, "tl-h-group");
          await renderHorizontalItems(items, groupHost);
        };

        const hasMeaningfulGroups = groups.some((g) => {
          const t = this.getGroupKeyText(g.key);
          return !!t && t !== "null";
        });

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
          if (jumpToToday) {
            const today = this.plugin.getCalendariumCurrentYmd();
            if (today) this.plugin.jumpContainerToYmd(scroller, today, ".tl-h-item");
          }
        })();
      }
    }

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
          displayName: "Timeline property (used if timelineConfig is empty; can be multi-value)",
          key: "timelineProperty",
          default: "note.timelines"
        },
        {
          type: "text",
          displayName: "Start date property",
          key: "startProperty",
          default: "note.fc-date"
        },
        {
          type: "text",
          displayName: "Jump to Calendarium 'today' on refresh (true|false)",
          key: "jumpToToday",
          default: "false"
        },
        {
          type: "text",
          displayName: "Order mode (bases|start-asc|start-desc). Default: bases",
          key: "orderMode",
          default: "bases"
        },
        {
          type: "text",
          displayName: "End date property (optional)",
          key: "endProperty",
          default: "note.fc-end"
        },
        {
          type: "text",
          displayName: "Title property",
          key: "titleProperty",
          default: "note.tl-title"
        },
        {
          type: "text",
          displayName: "Summary property",
          key: "summaryProperty",
          default: "note.tl-summary"
        },
        {
          type: "text",
          displayName: "Image property",
          key: "imageProperty",
          default: "note.tl-image"
        }
      ]
    });

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
          displayName: "Timeline property (used if timelineConfig is empty; can be multi-value)",
          key: "timelineProperty",
          default: "note.timelines"
        },
        {
          type: "text",
          displayName: "Start date property",
          key: "startProperty",
          default: "note.fc-date"
        },
        {
          type: "text",
          displayName: "Jump to Calendarium 'today' on refresh (true|false)",
          key: "jumpToToday",
          default: "false"
        },
        {
          type: "text",
          displayName: "Order mode (bases|start-asc|start-desc). Default: bases",
          key: "orderMode",
          default: "bases"
        },
        {
          type: "text",
          displayName: "End date property (optional)",
          key: "endProperty",
          default: "note.fc-end"
        },
        {
          type: "text",
          displayName: "Title property",
          key: "titleProperty",
          default: "note.tl-title"
        },
        {
          type: "text",
          displayName: "Summary property",
          key: "summaryProperty",
          default: "note.tl-summary"
        },
        {
          type: "text",
          displayName: "Image property",
          key: "imageProperty",
          default: "note.tl-image"
        }
      ]
    });
  }

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as Partial<SimpleTimelineSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async migrateLegacyToTimelineConfigs(): Promise<void> {
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

class InputModal extends Modal {
  private resolvePromise!: (val: string | null) => void;
  private valueInit?: string;
  private placeholder?: string;
  private titleText?: string;

  constructor(app: App, opts: { title?: string; value?: string; placeholder?: string }) {
    super(app);
    this.valueInit = opts.value;
    this.placeholder = opts.placeholder;
    this.titleText = opts.title;
  }

  onOpen(): void {
    const { contentEl } = this;
    clearEl(contentEl);

    if (this.titleText) {
      appendEl(contentEl, "h3", { text: this.titleText });
    }

    const input = appendEl(contentEl, "input");
    input.type = "text";
    input.placeholder = this.placeholder ?? "";
    if (this.valueInit != null) input.value = this.valueInit;
    setCssProps(input, { width: "100%" });

    const btns = appendDiv(contentEl, "modal-button-container");
    const ok = appendEl(btns, "button", { text: "OK" });
    const cancel = appendEl(btns, "button", { text: "Cancel" });

    ok.addEventListener("click", () => {
      this.close();
      this.resolvePromise(input.value.trim());
    });

    cancel.addEventListener("click", () => {
      this.close();
      this.resolvePromise(null);
    });

    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 50);
  }

  onClose(): void {
    clearEl(this.contentEl);
  }

  waitForClose(): Promise<string | null> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }
}

async function promptModal(
  app: App,
  opts: { title?: string; value?: string; placeholder?: string }
): Promise<string | null> {
  const modal = new InputModal(app, opts);
  modal.open();
  return modal.waitForClose();
}

class TimelineConfigModal extends Modal {
  private plugin: SimpleTimeline;
  private initialKey?: string;
  private initialCfg?: TimelineConfig;
  private resolvePromise!: (val: { key: string; cfg: TimelineConfig } | null) => void;

  constructor(
    app: App,
    plugin: SimpleTimeline,
    params?: { key?: string; cfg?: TimelineConfig }
  ) {
    super(app);
    this.plugin = plugin;
    this.initialKey = params?.key;
    this.initialCfg = cloneConfig(params?.cfg);
  }

  onOpen(): void {
    const { contentEl } = this;
    clearEl(contentEl);

    appendEl(contentEl, "h3", { text: this.initialKey ? "Edit timeline" : "Create timeline" });

    let key = this.initialKey ?? "";
    const cfg: TimelineConfig = this.initialCfg ?? {};

    const addNum = (name: string, prop: TimelineNumericKey, placeholder: string) =>
      new Setting(contentEl)
        .setName(name)
        .setDesc("Empty = use defaults")
        .addText((t) => {
          const cur = cfg[prop];
          t.setPlaceholder(placeholder).setValue(cur != null ? String(cur) : "");
          t.onChange((v) => {
            const vv = v.trim();
            if (vv === "") {
              delete cfg[prop];
              return;
            }
            const n = Number(vv);
            if (Number.isFinite(n)) cfg[prop] = Math.floor(n);
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

    addNum("Max. summary lines", "maxSummaryLines", "7");
    addNum("Image width", "cardWidth", "200");
    addNum("Image height", "cardHeight", "315");
    addNum("Box height", "boxHeight", "289");
    addNum("Inner left padding", "sideGapLeft", "40");
    addNum("Inner right padding", "sideGapRight", "40");

    cfg.colors ||= {};

    new Setting(contentEl)
      .setName("Box background")
      .setDesc("Empty = default/theme color")
      .addColorPicker((cp) => {
        cp.setValue(cfg.colors?.bg || "");
        cp.onChange((v) => {
          cfg.colors ||= {};
          cfg.colors.bg = v || undefined;
        });
      });

    new Setting(contentEl)
      .setName("Box border")
      .setDesc("Empty = default/theme color")
      .addColorPicker((cp) => {
        cp.setValue(cfg.colors?.accent || "");
        cp.onChange((v) => {
          cfg.colors ||= {};
          cfg.colors.accent = v || undefined;
        });
      });

    new Setting(contentEl)
      .setName("Hover background")
      .setDesc("Empty = default/theme color")
      .addColorPicker((cp) => {
        cp.setValue(cfg.colors?.hover || "");
        cp.onChange((v) => {
          cfg.colors ||= {};
          cfg.colors.hover = v || undefined;
        });
      });

    new Setting(contentEl)
      .setName("Title color")
      .setDesc("Empty = default/theme color")
      .addColorPicker((cp) => {
        cp.setValue(cfg.colors?.title || "");
        cp.onChange((v) => {
          cfg.colors ||= {};
          cfg.colors.title = v || undefined;
        });
      });

    new Setting(contentEl)
      .setName("Date color")
      .setDesc("Empty = default/theme color")
      .addColorPicker((cp) => {
        cp.setValue(cfg.colors?.date || "");
        cp.onChange((v) => {
          cfg.colors ||= {};
          cfg.colors.date = v || undefined;
        });
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
        ta.onChange((v) => {
          monthsText = v;
        });
      });

    const btns = appendDiv(contentEl, "modal-button-container");
    const saveBtn = appendEl(btns, "button", { text: "Save" });
    const cancelBtn = appendEl(btns, "button", { text: "Cancel" });

    saveBtn.addEventListener("click", () => {
      const k = key.trim();
      if (!k) {
        new Notice("Please enter a name.");
        return;
      }

      cfg.months = parseMonths(monthsText.trim());
      this.close();
      this.resolvePromise({ key: k, cfg });
    });

    cancelBtn.addEventListener("click", () => {
      this.close();
      this.resolvePromise(null);
    });
  }

  onClose(): void {
    clearEl(this.contentEl);
  }

  waitForClose(): Promise<{ key: string; cfg: TimelineConfig } | null> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }
}

class DefaultsModal extends Modal {
  private plugin: SimpleTimeline;
  private resolvePromise!: (saved: boolean) => void;
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

  onOpen(): void {
    const { contentEl } = this;
    clearEl(contentEl);

    appendEl(contentEl, "h3", { text: "Edit defaults" });

    const addNum = (name: string, key: DefaultsNumericKey, placeholder: string) =>
      new Setting(contentEl)
        .setName(name)
        .addText((t) => {
          t.setPlaceholder(placeholder);
          t.setValue(String(this.draft[key]));
          t.onChange((v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return;

            if (key === "cardWidth") this.draft.cardWidth = Math.floor(n);
            else if (key === "cardHeight") this.draft.cardHeight = Math.floor(n);
            else if (key === "boxHeight") this.draft.boxHeight = Math.floor(n);
            else if (key === "sideGapLeft") this.draft.sideGapLeft = Math.floor(n);
            else if (key === "sideGapRight") this.draft.sideGapRight = Math.floor(n);
            else this.draft.maxSummaryLines = Math.floor(n);
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

    const btns = appendDiv(contentEl, "modal-button-container");
    const saveBtn = appendEl(btns, "button", { text: "Save" });
    const cancelBtn = appendEl(btns, "button", { text: "Cancel" });

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
      this.resolvePromise(true);
    });

    cancelBtn.addEventListener("click", () => {
      this.close();
      this.resolvePromise(false);
    });
  }

  onClose(): void {
    clearEl(this.contentEl);
  }

  waitForClose(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }
}

class SimpleTimelineSettingsTab extends PluginSettingTab {
  plugin: SimpleTimeline;

  constructor(app: App, plugin: SimpleTimeline) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    clearEl(containerEl);

    new Setting(containerEl)
      .setName("Bases integration (optional)")
      .setDesc(
        "Registers custom bases view types (cross + horizontal). Requires Obsidian with bases support. Toggle needs a plugin reload to take effect."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableBasesIntegration).onChange(async (v) => {
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
        b.setWarning().setButtonText("Delete").onClick(async () => {
          delete this.plugin.settings.timelineConfigs[key];
          await this.plugin.saveSettings();
          this.display();
          new Notice(`Timeline “${key}” deleted.`);
        })
      );
    }

    const hint = appendDiv(containerEl, "setting-item-description");
    hint.textContent =
      "Note: older “styles per timeline” / “month overrides” were migrated once and will not be imported again.";
  }
}

async function openTimelineWizard(
  app: App,
  plugin: SimpleTimeline,
  existingKey?: string
): Promise<{ key: string; cfg: TimelineConfig } | null> {
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

async function openDefaultsWizard(app: App, plugin: SimpleTimeline): Promise<boolean> {
  const modal = new DefaultsModal(app, plugin);
  modal.open();

  const saved = await modal.waitForClose();
  if (saved) await plugin.saveSettings();
  return saved;
}