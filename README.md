# Simple Timeline

Simple Timeline is an Obsidian plugin that renders visual timelines from note frontmatter.

It reads `fc-date` / `fc-end` fields (compatible with [Calendarium]-style frontmatter) and shows each note as a card: image on the left, a callout‑like box on the right, with native Obsidian popovers on hover.

## Features

- Uses `fc-date` / `fc-end` from note frontmatter.
- “Cross” layout:
  - Left: fixed image with rounded corners.
  - Right: fixed‑height card using your theme’s H1/H4 styles.
- Native Obsidian page preview:
  - Hover over image or card to open the note preview.
  - Works without holding Ctrl.
- Responsive layout:
  - Wide screens: image left, card right.
  - Narrow screens: image stacked on top of the card, behaving like a single combined “card”.
- Summary handling:
  - Optional `tl-summary` frontmatter (multi‑line YAML `|` / `|-` supported).
  - If missing, the plugin uses the first meaningful paragraph from the note body.
  - Summary is clamped to a configurable number of lines with a native multi‑line ellipsis.
- Colors and sizing:
  - Global defaults for image size, card height, paddings and colors.
  - Per‑timeline overrides (including title/date color and hover background).
- Month names:
  - English by default (`January`…`December`).
  - Custom month names per timeline (useful for fantasy calendars).
- No runtime dependency on Calendarium:
  - Just reuses its `fc-date` / `fc-end` convention.

## Installation

Until it is available in the community plugin browser, you can install it manually:

1. Build the plugin (or download a release ZIP, if available).
2. Copy the contents (`main.js`, `manifest.json`, `styles.css` and `versions.json`) into a folder named `simple-timeline` inside your vault’s `.obsidian/plugins` directory.
3. Enable **Simple Timeline** in *Settings → Community plugins*.

Minimum Obsidian version: `1.6.7`.

## Usage

### 1. Frontmatter in your notes

Add at least `fc-date` to any note you want to see on a timeline.


---
fc-date: 1165-04-01       # required
fc-end: 1165-04-03        # optional (end of range)
timelines: [Travel]       # one or more timeline names
tl-title: Arrival in Hollowhome 2   # optional display title
tl-summary: |-            # optional custom summary
  Late in the afternoon we reached the old cemetery...
  The fence was swallowed by vines...
tl-image: assets/hollowhome.jpg    # optional image override
---

### 2. YAML Codeblock for display (timeline-cal)
~~~timeline-cal
name/names: YourTimeline, YourSecondTimelineIfYouLikeToShowTwo...orMore
~~~