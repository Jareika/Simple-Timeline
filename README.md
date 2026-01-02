# Simple Timeline (Obsidian Plugin)

Simple Timeline renders timelines from note frontmatter. It can be used in:

- Markdown code blocks (`timeline-cal`, `timeline-h`)
- Bases views (optional integration)

It is designed to be theme-friendly and configurable.

---

##  Install / Enable

1. Install the plugin (manual or via BRAT / community store if available).
2. Enable it in **Settings → Community plugins**.
3. Enable **Page Preview** (recommended) to use hover popovers.

---

## Required Frontmatter

A note becomes a timeline entry when it has `fc-date`.

### Minimal
fc-date: 1165-03-01
fc-end: 1165-03-03
timelines: [Travelbook 1]
tl-title: Arrival in New York
tl-summary: |-
  We arrived after two days of travel.
  Weather: rain and wind.
tl-image: assets/my-image.png

Image can be:
- an external URL (https://...)
- an internal link/path to a vault file

Image selection priority
The plugin tries to find an image in this order:
- tl-image (frontmatter)
- first internal embed image (![[...]])
- first markdown image link (![](…))
- first image file in the note folder

## Markdown Code Blocks

A) Vertical “Cross” layout (default renderer)
~~~
```timeline-cal
names: Travelbook 1, Travelbook 2
jumpToToday: true
```
~~~

Shows one entry per row (image + callout box).

B) Horizontal timeline
~~~
```timeline-h
names: Reisebuch 1, Reisebuch 2
mode: stacked      # stacked | mixed
jumpToToday: false
```
~~~

Modes:
- mixed: all entries from all timelines in one horizontal row (chronological)
- stacked: one horizontal row per timeline; aligned by the union of existing dates (gaps appear only when a timeline has no entry for a date that another timeline has)

## Settings (Global + Per Timeline)
You can configure:
- image width / height
- box height
- inner left/right padding
- max summary lines (multi-line ellipsis)
- colors (background, border, hover, title, date)
- per-timeline month names (manual) (name, name,...)
Per-timeline configuration is stored under a timeline key (the same name you use in timelines:).

## Calendarium “Today” (optional)
If the Calendarium plugin is installed, the Timeline UI can jump to “today”:

In Markdown blocks: jumpToToday: true
In Bases views: option jumpToToday: "true"
If Calendarium is not installed, the button will show a notice.

## Bases Integration (optional)
Enable it in plugin settings:

Settings → Simple Timeline → Bases integration
After enabling, restart Obsidian or reload the plugin (required for view registration).

A) Bases view: Timeline (Cross)
View type:
simple-timeline-cross
B) Bases view: Timeline (Horizontal)
View type:
simple-timeline-horizontal

Common options (property mapping):
- timelineConfig (optional, forces one style config for all cards)
- timelineProperty (used when timelineConfig is empty)
- startProperty, endProperty
- titleProperty, summaryProperty, imageProperty
- orderMode: bases | start-asc | start-desc
- jumpToToday: "true" | "false"

Horizontal-only option:
- mode: stacked | mixed


Example YAML for Bases:
~~~
```base
views:
  - type: simple-timeline-horizontal # simple-timeline-cross
    name: Timeline (mixed)
    timelineConfig: ""
    startProperty: note.fc-date
    endProperty: note.fc-end
    titleProperty: note.tl-title
    summaryProperty: note.tl-summary
    imageProperty: note.tl-image
    orderMode: start-asc
	mode: stacked | mixed
```
~~~


