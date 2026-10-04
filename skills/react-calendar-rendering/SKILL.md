---
topic: React calendar rendering optimization
type: class-level procedure
owner: curator-managed
---

# React Calendar Rendering (`react-calendar-rendering`)

## Purpose
When rendering large calendar spans (many months, or year-view with 100+ months up to
2126), the default approach of mounting every day/cell at once blocks the main thread and
makes view-switching appear frozen. This skill is the standing procedure for rendering
calendar grids fast and compact while keeping every month reachable.

Trigger: any view that lays out a long continuous strip of month/day cells (YearView,
MonthView, DatePickerModal mini-grid).

## Always-on rules
- **Bound the rendered set, never the logical set.** The full month range (up to 2126) is
  fine to *compute*; only the DOM near the viewport is mounted. Placate scroll height with
  measured-height spacers so scroll physics stays correct.
- **Render on an `rAF` frame for batched mounts.** When mounting a window of ~30 months,
  split into chunks of ~10 and yield via requestAnimationFrame so the browser can paint
  the chrome between chunks — avoids "the page is frozen" perception.
- **Compact density is the default.** Mini-day cells: font 10px, gap 1px, aspect-ratio 1,
  border-radius 3px. Month title: 11px. Gap between month blocks: 8px. These fit ~36
  months (±18) on a typical 1080p screen without horizontal scroll.
- **Sticky year headers** (`position: sticky; top: 0`) remain even when windowed — users
  must see year boundaries while scrolling.

## Procedure
1. **Compute the full range** (pure, cheap): build month list from `startOfMonth(anchor)`
   forward to the horizon (`new Date(2126, 11, 1)`). Cache with `useMemo`.
2. **Group by year** for sticky headers — single pass into a `Map<number, Date[]>`.
3. **Window the render**: maintain `{ from, to }` indices into the *flattened* list
   (year header = 1 item, then months). Measure one month block once via
   `getBoundingClientRect`; store height in a ref.
4. **Update range on scroll/resize** with a `{ passive: true }` listener:
   `first = floor((scrollTop - vh*0.5) / monthHeight)`, clip to bounds, add a viewport
   buffer of ~50% height above and below.
5. **Render spacers** above/below the window: `height: from * monthHeight` and
   `height: (total - to) * monthHeight`. `aria-hidden="true"` so they aren't in the a11y
   tree.
6. **Anchor scroll**: `useEffect` calling `ref.scrollIntoView({ block: 'center' })` on the
   anchor month when `anchor` changes.
7. **Color bands**: a day with N task colors → vertical `linear-gradient` bands; single
   color → tinted `backgroundColor: ${color}22`. Cap bands at 4 so cells don't clutter.

## Pitfalls
- **Don't stretch the range to the horizon by default.** Earlier sessions tried rendering
  every month to 2126 at once (~140 months, 5040 mini-days) and the user called it "ужас".
  Always window. If the user asks for "go to 2126", keep reaching there *lazily* from the
  month view — don't mount the whole strip in YearView.
- **`aspect-ratio: 1` on mini-days fights windowing math.** The measured block height
  depends on the cell being square; if you set a fixed `height` instead, the spacer heights
  drift and the page "jumps" on scroll. Keep `aspect-ratio` so measurement is stable.
- **Sticky headers + windowing desync if spacers use a stale height.** Re-measure month
  height whenever the month list identity changes (anchor year swap), not just on mount.
- **CSS removed from a section can break other components.** `weekday-picker`,
  `weekday-swatch`, `year-date-picker` live in the YEAR CSS section but are used by
  TaskModal (recurrence picker + date picker). If editing year CSS, keep or migrate these
  selectors — a grep for the class names across components first.
- **Discriminated unions in TSX need `kind`, not `type`.** `type: 'year'` is assignable
  but TS narrows on `kind`; using `type` produced unreachable-comparison errors. Name the
  discriminator `kind`.
- **Passive scroll listeners**: never use `{ passive: false }` on a scroll listener that
  only reads `scrollTop` — Chrome will warn and the optimization is wasted.

## References
- `references/compaction.md` — viewport window formula and buffer constants.
- `references/colors.md` — the `dayBg` tint/gradient recipe and the 4-band cap.
