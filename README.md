# Jalan Route Planner (v0.2)

A browser route planner for walking and running in Singapore, modelled on the free ("Basic") tier
of the Footpath app. Trace a line and it snaps to streets, pavements, footpaths and park connectors,
or tap points and it routes between them.

**Route along** (Settings) chooses what routes may use:

- *Streets, park connectors and public paths* (default): streets and their pavements, park connectors,
  park and waterfront paths, footbridges. It keeps out of housing estates: no short cuts between
  blocks or through condos, except the few paths that are the only way from a park connector to the street.
- *Every footpath, including between blocks*: every path, steps included.

Paths inside schools, military land and prisons are never used.

## Run it

It is a static site: no build step, no server code. With GitHub Pages serving this repo from
`main` at the root, it is live at https://jardani1x.github.io/route/.

Locally:

```bash
python3 -m http.server 8000      # from the repo root, then open http://localhost:8000
```

Any static host works (GitHub Pages, Netlify, Cloudflare Pages, nginx on a Raspberry Pi).
`.nojekyll` tells GitHub Pages to serve the files as they are.
Opening `index.html` straight from disk (`file://`) does not work, because the browser blocks
`fetch()` of the network files from local files.

## The walk network

`.github/workflows/build-network.yml` builds the network on the 2nd of each month (and whenever
the builder changes) from OpenStreetMap, NParks park connectors and URA's land boundary, and
publishes it to the `data/network-v2` branch (`data/network-v2-preview` for other branches) in two
formats: `net-v3.bin.gz`, a compact binary (1.4 MB; layout in `scripts/pack_network.py`), and
`net-v2.json` (4.3 MB gzipped on the wire). The app loads the binary from raw.githubusercontent.com,
falls back to the JSON in browsers that cannot unpack `.gz` (Safari before 16.4), and to the older
`net.json` in this repo (named streets and park connectors only) if both fail; the footpath setting
is then disabled.

`scripts/build_network.py` keeps OSM ways people may walk on (no expressways, no `foot=no` or private
access), splits them where they share a node (bridges and tunnels stay unconnected), cuts them to
Singapore's land, marks the paths that follow an NParks park connector line, flags paths in housing
estates (OSM residential land, within 20 m of a home, or deep inside a block that is mostly homes,
but not in parks), and drops pieces under 300 m that connect to nothing. `scripts/check_network.py`
fails the build if any of 12 towns spread over the island has no path nearby, and
`tests/test_network_v2.js` must pass on the binary before anything is published. `stats.json` beside
the network reports coverage: in the November 2026 build 94.6% of the NParks park connector lines
have an OSM way within 12 m and 89.8% are marked as park connectors.

## What it does (v0.1)

| Footpath Basic feature (footpathapp.com, checked 23 Nov 2026) | Here |
|---|---|
| Snap-to-map route creation (trace with finger, or tap points) | Draw tool + tap-to-route; HMM map matching snaps traces to the network |
| Toggle Snap to Map | Magnet button / Shift |
| Route editing: eraser, trace over a section to replace it | Eraser (E) trims ends or removes a middle stretch and reconnects; tracing between two route points replaces that section |
| Undo / redo / clear | Buttons, Ctrl+Z, Ctrl+Shift+Z |
| Move the map while drawing | Right-drag (or middle-drag), or hold Space and drag; two fingers to pan and pinch on touch screens (one finger keeps drawing) |
| Finish route | Out & back, close loop, reverse, trim to a distance |
| Measure distance | km or miles, distance markers, time from your pace per activity |
| Elevation chart during planning | Open-Meteo elevation (Copernicus 90 m surface model), smoothed over ~270 m so roofs and trees are not counted as climb; hover the chart to see the spot on the map |
| Route waypoints | Waypoint tool (K): name + notes, draggable, exported to GPX |
| Save routes / sync | Saved in this browser (localStorage); sync across devices is planned |
| Share routes | "Copy share link" encodes the route in the URL |
| Import GPX | Button or drag-and-drop |
| Basic street & satellite maps | OneMap street, Esri satellite, plus a built-in offline map |
| Search | Streets and park connectors offline; OneMap address search online |
| Show my location | One-off locate (needs HTTPS) |

Also included although Footpath charges for it: GPX export.

Closures: `closures.json` lists known closures with start and end dates. Active ones are drawn
dashed red, the planner warns when a route goes through one, and "Route around closures"
(on by default) keeps new routes out of them.

Not built yet (Footpath Elite or beyond Basic): cue sheets, turn-by-turn voice navigation, live GPS
tracking along the route, lists/folders, merge/duplicate/split routes, slope colouring,
3D terrain, offline tile downloads, PDF printing, activity logging, watch sync.

## How the page stays responsive

The route engine (network, routing, snapping a drawn line, the editor and its undo history) runs in a
Web Worker (`worker.js` → `backend.js`), so drawing a long line or loading the map never freezes the
page. The worker downloads and unpacks the network, then hands the page a light copy for drawing the
offline map and closures (32-bit coordinates, no routing tables; its buffers are moved, not copied).
Edits are messages answered in order with the editor's new state; a "Working out the route…" note
appears if one takes longer than a quarter of a second. If a worker cannot start, the page runs the
same `backend.js` itself (also forced with `?worker=0`). Map tiles drawn from the network are
painted one per task.

Measured in Chrome with its CPU slowed down 4x on a desktop (not a real phone), November 2026 network:

| | v0.2 (JSON, on the page) | v0.3 (binary, worker) |
|---|---|---|
| Download | 4.3 MB | 1.4 MB |
| Longest freeze while loading | 1.6 s | 0.09 s |
| Page blocked while loading, total | 3.3 s | 0.4 s |
| Freeze while snapping a 4.6 km drawn line | 3.6 s | 0.08 s |

## Files

| File | Role |
|---|---|
| `index.html` | Layout and styles |
| `app.js` | UI: map, tools, pointer input, stats, search, storage, import/export; talks to the engine by messages |
| `worker.js`, `backend.js` | The route engine's home: loads the network, runs the editor, answers edits |
| `engine.js` | Route editing: trace matching, eraser, replace, finish actions, undo/redo, share codec |
| `core.js` | Network loading (binary run-net-3, JSON run-net-1/2), spatial grid, snapping, A* routing with the two profiles, GPX helpers |
| `config.js` | Tile, elevation and search endpoints (edit when self-hosting) |
| `closures.json` | Known closures with dates and approximate extents |
| `net.json` | Fallback walk network (v1): named streets (expressways and flyovers removed) + NParks park connectors, with dual carriageways linked |
| `scripts/build_network.py` | Builds the footpath network (v2) from OSM + NParks + URA land boundary |
| `scripts/check_network.py` | Fails a build that misses part of the island |
| `scripts/pack_network.py` | Packs the JSON network into the binary `net-v3.bin.gz` |
| `leaflet.js`, `leaflet.css` | Leaflet 1.9.4 |

## Limits to know

- "Housing estate" is worked out from OSM data, so it is not perfect: some paths between blocks
  are still allowed where OSM has neither residential land nor buildings mapped, and some paths beside
  estates are avoided. Tell me where it is wrong.
- Where OSM maps the pavement as part of the road, routes follow the road centreline and sit a
  few metres off the pavement.
- The footpath network is 1.4 MB to download. The engine and the page each keep a copy in memory
  (about 47 MB and 39 MB of arrays); very old phones may still struggle.
- The speed figures above come from Chrome's CPU slowdown on a desktop, which does not slow the worker
  itself as much as a real phone would. On a phone, expect long lines to take a second or two to snap;
  the page stays usable while they do.
- Closure extents in `closures.json` are drawn by hand from NParks notices, so they are approximate.
- Elevation uses a 90 m terrain model: good for trends, not for exact climb on short hills.
- Esri imagery comes with its own terms of use. For heavy use, switch `config.js` to a tile
  provider you have a key for.

## Data and licences

Code: MIT (`LICENSE`). `leaflet.js` and `leaflet.css` are Leaflet 1.9.4 under its BSD 2-Clause
licence (`LICENSE-LEAFLET`). Data: see `DATA_LICENSE.md`. Both networks are Derived Databases of OpenStreetMap under the ODbL 1.0.

- Streets and paths: © OpenStreetMap contributors, ODbL.
- Park connectors: NParks, Singapore Open Data Licence (via data.gov.sg).
- Land boundary: URA Master Plan 2019 Region Boundary (No Sea), Singapore Open Data Licence (via data.gov.sg).
- Basemaps: OneMap © Singapore Land Authority; © OpenStreetMap; imagery © Esri.
- Elevation: Open-Meteo (CC BY 4.0).

## Tests

GitHub Actions (`.github/workflows/test.yml`) runs them on every pull request and every push to `main`,
the browser tests on `net.json` (footpath network blocked), on the latest footpath build as JSON and as
binary, and on the binary with the engine in the page instead of the worker (`ENGINE=inline`).
`tests/test_network_v2.js` routes between public places on the footpath network in both modes and checks
that the default mode never uses an estate path. `tests/test_build_network.py` runs the builder on a
hand-made OSM file and checks the binary reads back as the same network.


`tests/test_engine.js` (Node: `node tests/test_engine.js`) checks trace matching against a known 5 km route with hand jitter,
plus every editor operation and the codecs. `tests/smoke.py` (Playwright, with the site served on port 8766) drives the page:
draw, tap, erase, undo/redo, out & back, waypoints, save, export → import, share link, search,
the offline-tile fallback, and the online basemap path with stubbed tile and elevation servers.
`tests/pan_while_drawing.py` (Playwright) checks right-drag and Space-drag panning in Draw mode on desktop,
and one-finger drawing, two-finger pan, pinch-zoom and stroke-then-second-finger on a touch screen.
