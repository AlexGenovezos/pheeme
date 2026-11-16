# Hourly weather in the calendar grid

## Why

Alex wants the calendar to feel alive *and* to say something useful: looking at a week, you
should see that it rains Tuesday from 2 to 5 pm, not only that Tuesday is "Showers, 63°/42°".
Today the weather is a small icon in each day's header (`DayWeather`), from a daily forecast,
moving only while pointed at. This puts the weather in the hours themselves.

## Goals

- In Day and Week view, each forecast day shows its weather as soft bands in the hours it
  happens: rain streaks for 2–5 pm, a warm wash for a sunny morning, snow, fog, a storm.
- The bands carry information at rest. They're still pictures by default and move only briefly
  (see Motion), so an open calendar costs no more battery than one without weather.
- Everything stays readable and clickable: events, the now line, click/drag to create.

## Non-goals

- Month view, the event popover's place forecast and the header icon keep the daily forecast
  as they are (the header tooltip gains the runs, below).
- No hourly temperatures, wind, or per-hour numbers in the grid.
- No weather for event locations in the grid; only the home location.

## Anti-goals

- A calendar that animates continuously, keeps the GPU busy while idle, or shows up in Activity
  Monitor's energy column.
- Weather that competes with events: if it makes an event harder to read, it's wrong.
- Layout shift when the forecast arrives (bands are absolutely placed, so they never move
  anything).

## Approaches

- **A. Moving CSS textures.** Bands always animate (one transform-only layer each), paused when
  the window is hidden, unfocused or idle. Most alive; a constant compositor cost while in use.
- **B. Particle canvas.** JS draws individual drops ~20 fps. Most realistic; most battery, and
  fiddly to keep in step with scroll and resize.
- **C. Still bands that move briefly.** — **chosen by Alex.** The same bands as A, but still by
  default; they play for a few seconds on specific moments, then stop.

## Design

### Data (Rust, `weather.rs`)

- `weather_forecast` also asks Open-Meteo for `hourly=weather_code,precipitation,is_day`.
  Same request, same one-hour cache, same 16 days. Its answer becomes `{ days, hours }`. The
  hourly times come as the place's local wall time; Rust turns them into UTC instants with the
  response's IANA `timezone` (chrono-tz), so DST changes inside the 16 days are right.
- The answer gains `hours: HourForecast[]`, each `{ at: <UTC ms>, code, precipitation, isDay }`;
  hours with a missing value are dropped (as `days_of` drops days).
- Browser preview (`src/preview/weather.ts`) fakes hourly data with at least one rain run, one
  sunny run and one snow run in the visible week.

### Runs (frontend, pure and tested)

A new pure module (e.g. `src/weather/hourly.ts`) turns hours into **runs** per calendar day:

- Each hour gets a *band kind* from its code (`condition` in `codes.ts`): `clear` (only while
  `isDay`) → `sun`; `fog` → `fog`; `drizzle`/`rain` → `rain`; `snow` → `snow`; `storm` → `storm`.
  `partly`, `cloudy` and clear night hours draw nothing, so ordinary days stay quiet.
- Consecutive hours of the same band kind merge into one run `{ kind, startMin, endMin,
  intensity }`, intensity the run's heaviest (`condition`'s intensity, raised by `precipitation`
  where the code understates it — builder's call on thresholds).
- Hours are placed in the **calendar's time zone** (the grid's, from `dates.ts`), not the home
  place's. A run crossing midnight splits into two days' runs.
- A one-hour run is kept (a shower at 3 pm is exactly the useful thing).

### Bands (Day / Week grid)

- Each run is an absolutely placed, `pointer-events: none` element inside its
  `.cal-grid__column`, `top`/`height` from `HOUR_PX` like events, full column width, under the
  events and the now line (lower z-index). Click/drag to create, drops and hover on events work
  as before.
- Looks, reusing WeatherArt's language and weather.css tokens (light and dark):
  - `rain`/`storm`: a faint blue-grey tint with slanted streaks (a repeating SVG or gradient
    texture); denser and darker with intensity. Storm is darker and adds an occasional flash
    while moving.
  - `snow`: a faint cool tint with scattered flakes.
  - `sun`: a warm wash, strongest at the run's middle, fading at its ends.
  - `fog`: soft horizontal bands.
  - Edges fade over ~10 minutes so a run doesn't look like an event block.
- The day header's tooltip and `aria-label` (`DayWeather`) add the runs in words: "Showers,
  high 63°, low 42°. Rain 2–5 pm, sun 9 am–1 pm." The bands themselves are `aria-hidden`.
- Days outside the forecast and days before today draw no bands. Today's past hours draw
  like the rest (builder may dim them if the grid already dims the past).
- Bands are a picture of the forecast, so they render only once it has loaded; there's nothing
  to hold a place for (absolutely placed, no layout shift).

### Motion

Still by default. The texture inside a band moves with a transform-only animation on one layer
(no per-drop elements, no JS per frame) and only:

1. **On arrival:** when Calendar mode comes to the front, or the view, week or day changes,
   every visible band plays once for ~4 s, then stops.
2. **On entering a day:** when the pointer moves into a day's column (or its header), that
   day's bands play for ~4 s, then hold still even if the pointer stays. Moving into another
   day plays that one. A pointer resting in the grid costs nothing. (Decided: pointing plays
   briefly, not for as long as the pointer stays, since in Day view the column is the whole
   grid and in Week view the pointer is nearly always over some day.)

Never moves when Settings › Calendar › Animate weather is off, with reduced motion, or while
the window is hidden or unfocused (pausing at once on blur/hide). A stopped band holds its last
frame (no snapping back).

### Battery check

At rest nothing animates: no running CSS animation and no timers while the bands are still
(checked in the running app: `document.getAnimations()` holds no running animation once the
burst is over). While a day plays, cost is bounded by that day's few bands for ~4 s.

## Left to the builder

- Exact colours, opacities, streak density, durations (within "a few seconds" for arrival).
- Precipitation thresholds for intensity.
- How the arrival burst is triggered (a class with a timeout on the grid is the obvious way).
