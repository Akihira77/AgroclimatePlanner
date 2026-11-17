# UI Reference Analysis (Phase 0, input for Phase 2)

Source images: `main_dashboard.jpg`, `calendar.jpg`, `climate_monitor.jpg`, `crop_management.jpg`.

**Important finding:** none of the four references is an agricultural-weather product. They are: a generic farm-ops dashboard (FarmVista, English/US), a generic event calendar, a scientific climate-anomaly report figure (matplotlib), and a generic crop library (English). They define **layout and component patterns only**. All content, language, units, and data domains must be replaced with Indonesian agroclimate semantics.

Where the references conflict with `BRAINSTORM.md` (palette `#1D4938` forest green, `#F7F8F5` background), **BRAINSTORM.md wins**. The references' mint `#16A34A` and blue `#2563EB` accents are not adopted.

---

## 1. `main_dashboard.jpg` — dashboard layout pattern

- Shell: fixed ~230 px sidebar (logo top, nav mid, logout bottom) + topbar (~90 px: search left; bell with dot, divider, avatar + name/email right) + content grid.
- Page header: greeting H1 + one-line subtitle; right side period dropdown + primary export button.
- Row 1: 3 cards — (a) weather card with location pill, `C | F` segmented toggle, weekday, big temperature, high/low, condition, feels-like; (b) gauge/donut card with center total + legend percentages; (c) two stacked KPI cards (label + ⓘ, icon in tinted circle, big value, delta % + "from last month").
- Row 2: line/area chart card with two dropdown filters and a dashed drop-line tooltip; beside it a full-bleed photo card with an overlaid white sub-card containing 3 mini stat tiles.
- Row 3: task table (Task / Assigned To / Due Date / Status, gray header row, status column) + simple list-summary card (icon, name, right-aligned value).
- Mobile variant: hamburger topbar, bottom tab bar (Dashboard / Weather / Soil & Water / Account).

**Adopt:** card/grid rhythm, KPI pattern with delta, table + summary-list pairing, overlay mini-stats on field imagery.
**Reject:** generic greeting, English copy, acres/$, gauge-as-production.

## 2. `calendar.jpg` — annual calendar pattern

- Centered white card on tinted page; toolbar with `Today`, range `‹ May 21 – 26 ›`, segmented view switcher (Year/Week/Month/Day).
- 12-month grid (4×3) with 1 px separators; per-month 7-column day grid; day numbers tiny; **colored outline rings** on days mark events; overlay event popups with color-coded tag chip + title + one-liner.

**Adopt:** 12-month grid, ring markers per day, colored tag chips, view switcher, popup detail card.
**Must design (absent in ref):** multi-day planting-window shading, `+N` crop overflow, forecast-vs-climatology visual distinction, month navigation for monthly mode, legend for marker semantics, accessible labels.

## 3. `climate_monitor.jpg` — climate visualization pattern

Scientific figure, no web chrome. Panels: recent precipitation anomaly (%), seasonal anomaly outlook (with "preliminary" vs "forecast" annotation split), 15-day forecast (mm), 3-month tercile probability (Above/Normal/Below Normal), 3-month very-high-temperature probability (>80th percentile).
Colorbars: diverging brown→red→orange→yellow→white→green→blue; tercile teal/gray/tan; probability yellow→dark red. Explicit "Dry Mask" chip marks no-data regions.

**Adopt:** the entire visualization vocabulary — diverging anomaly scale, tercile probability categories, explicit no-data masking, and above all the **"PRELIMINARY DATA / FORECAST DATA" annotation split**, which maps directly to this project's observation-vs-forecast separation rule. Wrap each in a standard card with title + date-range subtitle + HTML legend (never a baked-in image).

## 4. `crop_management.jpg` — catalog/master-detail pattern

- 72 px icon rail (collapsible), then ~240 px list column (selected row tinted), then main area: H1 + tab underline, full-width search, action buttons (`+ Add New`, `Clone A Template`, two filter dropdowns).
- Card grid: photo (4:3), bold name, white bordered stage badge, trash icon bottom-right.

**Adopt:** master-detail catalog, `Clone A Template` (maps to "duplicate agronomic profile"), stage badge, filter dropdowns.
**Reject:** photo-first cards (crops here are agronomic records, not shop items) — instead: deterministic generated crop icon + key agronomic facts (duration, water need). Keep a compact grid at low density.

---

## 5. Component inventory to build in Phase 2

Sidebar (expanded + icon rail + mobile bottom tabs) · topbar · page header with period selector · KPI card (value + delta + info tooltip) · weather/observation card with source-freshness chip · gauge · line/area chart card · calendar year-grid · calendar month-grid · day-detail dialog · crop icon (deterministic SVG) with `+N` overflow · master-detail catalog · data table · status badge · segmented control · filter dropdown · empty/error/skeleton/stale states.

## 6. Density and shape rules taken from references

- Card radius 16 px, buttons/inputs 8 px, chips/pills fully rounded, thumbnails 6 px.
- Flat cards: 1 px `border` + white surface, shadow only on floating popups.
- Spacing: 24 px page gutter, 16 px card gap, 16–20 px card padding, table row ~52 px.
- Type scale: 40 px hero metric / 28 px page title / 22 px KPI value / 20 px card title / 14 px body / 12 px meta. Reference used a geometric sans; project should use a neutral grotesque with tabular numerals for metrics.

## 7. Open design decisions (resolve in Phase 2)

1. Marker semantics for planting windows (excellent/good/conditional/poor) and how `insufficient_data` appears without implying "poor".
2. Visual grammar separating daily-forecast markers from dekadal/monthly outlook markers.
3. Satellite/temperature units, Indonesian labels, Asia/Jakarta date and time formatting.
4. Sidebar information architecture per BRAINSTORM Phase 7 (9 nav items).
5. Whether the annual calendar is the default landing view or the dashboard is.
