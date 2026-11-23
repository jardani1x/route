# Jalan Route Planner (v0.1, basic)

A browser route planner for walking, running and cycling in Singapore, modelled on the free
("Basic") tier of the Footpath app. Trace a line and it snaps to roads and park connectors, or
tap points and it routes between them.

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
`fetch('net.json')` from local files.

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
| Elevation chart during planning | Open-Meteo elevation (Copernicus 90 m DEM), climb total, hover chart to see the spot on the map |
| Route waypoints | Waypoint tool (K): name + notes, draggable, exported to GPX |
| Save routes / sync | Saved in the browser (localStorage); inside claude.ai they sync to your account |
| Share routes | "Copy share link" encodes the route in the URL |
| Import GPX | Button or drag-and-drop |
| Basic street & satellite maps | OneMap, OpenStreetMap, Esri satellite, plus a built-in offline map |
| Search | Streets and park connectors offline; OneMap address search online |
| Show my location | One-off locate (needs HTTPS) |

Also included although Footpath charges for it: GPX export.

Not built yet (Footpath Elite or beyond Basic): cue sheets, turn-by-turn voice navigation, live GPS
tracking along the route, lists/folders, merge/duplicate/split routes, slope colouring,
3D terrain, offline tile downloads, PDF printing, activity logging, watch sync.

## Files

| File | Role |
|---|---|
| `index.html` | Layout and styles |
| `app.js` | UI: map, tools, pointer input, stats, search, storage, import/export |
| `engine.js` | Route editing: trace matching, eraser, replace, finish actions, undo/redo, share codec |
| `core.js` | Network loading, spatial index, snapping, A* routing, GPX/ZIP helpers |
| `config.js` | Tile, elevation and search endpoints (edit when self-hosting) |
| `net.json` | Singapore walk network: named streets (expressways and flyovers removed) + NParks park connectors, with dual carriageways linked |
| `leaflet.js`, `leaflet.css` | Leaflet 1.9.4 |

## Limits to know

- The network has named streets and park connectors only. Unnamed footpaths, linkways and
  trails inside parks are missing, so snapping prefers roads where a footpath would be better.
- Routes follow road centrelines, so they sit a few metres off the pavement.
- The Kallang park connector closure at St Andrew's Village / St Michael's estate (NParks,
  until 2H 2027) is avoided by default; its extent is approximated.
- Elevation uses a 90 m terrain model: good for trends, not for exact climb on short hills.
- Tile servers have usage policies: OpenStreetMap's tiles are for light use only, and Esri
  imagery needs attribution. For heavy use, switch `config.js` to a tile provider you have a key for.

## Data and licences

- Streets: © OpenStreetMap contributors, ODbL (via github.com/evgeniyarbatov/singapore-streets).
- Park connectors: NParks, Singapore Open Data Licence (via data.gov.sg).
- Basemaps: OneMap © Singapore Land Authority; © OpenStreetMap; imagery © Esri.
- Elevation: Open-Meteo (CC BY 4.0).

## Tests

`tests/test_engine.js` (Node: `node tests/test_engine.js`) checks trace matching against a known 5 km route with hand jitter,
plus every editor operation and the codecs. `tests/smoke.py` (Playwright, with the site served on port 8766) drives the page:
draw, tap, erase, undo/redo, out & back, waypoints, save, export → import, share link, search,
the offline-tile fallback, and the online basemap path with stubbed tile and elevation servers.
`tests/pan_while_drawing.py` (Playwright) checks right-drag and Space-drag panning in Draw mode on desktop,
and one-finger drawing, two-finger pan, pinch-zoom and stroke-then-second-finger on a touch screen.
