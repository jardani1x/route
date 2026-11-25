# Usage: serve the site on port 8766 (python3 -m http.server 8766 from the site folder), then: python3 tests/smoke.py
# With NET_FILE=/path/net-v3.bin.gz (or net-v2.json) the footpath network is served from that file; without it
# the footpath network is unreachable and the app must fall back to the bundled net.json.
# ENGINE=inline runs the route engine in the page (?worker=0) instead of the Web Worker.
"""Headless browser test of the Jalan Route Planner (served locally).
Run A: tiles unreachable -> offline fallback; full editing workflow; save/export/import/share.
Run B: tile servers stubbed with a local PNG -> online basemap stays, no fallback."""
import asyncio, json, base64, os, re
from playwright.async_api import async_playwright

URL = 'http://localhost:8766/index.html'
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
results = {}
NET_FILE = os.environ.get('NET_FILE')
ENGINE = os.environ.get('ENGINE', 'worker')
URL_Q = '?worker=0' if ENGINE == 'inline' else ''

async def serve_network(pg):
    """The footpath network normally comes from raw.githubusercontent.com: serve NET_FILE, or make it unreachable."""
    async def handle(route):
        same_type = NET_FILE and NET_FILE.endswith('.gz') == route.request.url.endswith('.gz')
        if same_type: await route.fulfill(status=200, path=NET_FILE, headers={'content-type': 'application/octet-stream' if NET_FILE.endswith('.gz') else 'text/plain', 'access-control-allow-origin': '*'})
        else: await route.abort()
    await pg.route(re.compile(r'raw\.githubusercontent\.com/.+/net-v[23]\.(json|bin\.gz)'), handle)

async def pts_for(pg, a, b, noise=0):
    """Screen points along a routed path between two lat/lons (to drive the Draw tool like a finger)."""
    return await pg.evaluate("""async ([a,b,noise]) => {
      const J = window.__jalan, p = await J.path(a, b); const out = [];
      const cs = window.RouteEngine.geo.resample(p, 12);
      let s = 3; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - .5; };
      for (const c of cs) { const q = J.map.latLngToContainerPoint(c); out.push([q.x + rnd() * noise, q.y + rnd() * noise]); }
      return {pts: out, len: window.RouteEngine.geo.length(p)};
    }""", [a, b, noise])

async def drag(pg, pts):
    box = await pg.locator('#map').bounding_box()
    await pg.mouse.move(box['x'] + pts[0][0], box['y'] + pts[0][1]); await pg.mouse.down()
    for x, y in pts[1:]: await pg.mouse.move(box['x'] + x, box['y'] + y, steps=2)
    await pg.mouse.up(); await pg.wait_for_timeout(400)

async def ev(pg, expr):
    """Evaluate once the route engine has answered every edit sent so far."""
    return await pg.evaluate(f"async () => {{ await window.__jalan.idle(); return ({expr}); }}")

async def dist(pg): return await ev(pg, "window.__jalan.editor.distance")

async def run_a(p):
    b = await p.chromium.launch(args=['--no-sandbox'])
    ctx = await b.new_context(viewport={'width': 1280, 'height': 820}, accept_downloads=True, permissions=['clipboard-read', 'clipboard-write'])
    pg = await ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(f'pageerror: {e}'))
    pg.on('console', lambda m: errs.append(f'console.{m.type}: {m.text}') if m.type == 'error' and 'Failed to load resource' not in m.text else None)
    # map tiles and Open-Meteo unreachable, the same in CI (which has internet) as offline
    await pg.route(re.compile(r'onemap\.gov\.sg/maps/tiles|arcgisonline\.com|api\.open-meteo\.com'), lambda r: r.abort())
    await serve_network(pg)
    await pg.goto(URL + URL_Q); await pg.wait_for_selector('#loading', state='hidden', timeout=30000); await pg.wait_for_timeout(2500)
    r = results['A'] = {}
    r['engine'] = await pg.evaluate("window.__jalan.engine")
    r['network_file'] = await pg.evaluate("window.__jalan.net.meta.format")
    r['footpath_network'] = await pg.evaluate("window.__jalan.net.hasPaths")
    r['paths_select_enabled'] = not await pg.locator('#paths').is_disabled()
    if r['footpath_network']:
        await pg.select_option('#paths', 'all'); await pg.wait_for_function("window.__jalan.profile === 'all'", timeout=5000)
        r['profile_after_all'] = await pg.evaluate("window.__jalan.profile")
        await pg.select_option('#paths', 'roads'); await pg.wait_for_function("window.__jalan.profile === 'roads'", timeout=5000)
    r['profile'] = await pg.evaluate("window.__jalan.profile")
    r['empty_on_first_visit'] = await dist(pg) == 0
    await pg.click('#exampleBtn'); await pg.wait_for_timeout(400)
    r['example_km'] = round(await dist(pg) / 1000, 3)
    r['fallback_to_offline'] = await pg.evaluate("window.__jalan.tilesBlocked")
    r['banner'] = await pg.text_content('#banner')
    await pg.screenshot(path='./shot_desktop.png')
    # clear, then tap two points in pan mode
    await pg.click('#clearBtn'); r['after_clear'] = await dist(pg)
    await pg.evaluate("window.__jalan.map.setView([1.3545, 103.8515], 16)"); await pg.wait_for_timeout(500)
    for ll in ([1.35707, 103.85017], [1.35142, 103.855]):
        q = await pg.evaluate("ll => { const p = window.__jalan.map.latLngToContainerPoint(ll); return [p.x, p.y]; }", ll)
        box = await pg.locator('#map').bounding_box(); await pg.mouse.click(box['x'] + q[0], box['y'] + q[1]); await pg.wait_for_timeout(300)
    r['two_taps_km'] = round(await dist(pg) / 1000, 3)
    # draw: trace (with 6 px hand jitter) from the route end along the park connector to Braddell Rd
    await pg.click('#toolDraw')
    tr = await pts_for(pg, [1.35142, 103.855], [1.34349, 103.85733], noise=6)
    before = await dist(pg); await drag(pg, tr['pts']); after = await dist(pg)
    r['draw_added_m'] = round(after - before); r['draw_expected_m'] = round(tr['len'])
    # eraser: rub over the middle of the route (it should shrink then reconnect)
    await pg.click('#toolErase')
    await pg.evaluate("() => { const J = window.__jalan, cs = J.editor.coords, c = window.RouteEngine.geo.cumul(cs); J.map.setView(window.RouteEngine.geo.pointAt(cs, c, c[cs.length-1]*0.5), 17, {animate: false}); }"); await pg.wait_for_timeout(300)
    mid = await pg.evaluate("() => { const J = window.__jalan, cs = J.editor.coords, c = window.RouteEngine.geo.cumul(cs); const p = window.RouteEngine.geo.pointAt(cs, c, c[cs.length-1]*0.5); const q = J.map.latLngToContainerPoint(p); return [q.x, q.y]; }")
    b0 = await dist(pg); await drag(pg, [[mid[0] - 25, mid[1] - 25], [mid[0], mid[1]], [mid[0] + 25, mid[1] + 25]]); r['erase_middle_change_m'] = round(await dist(pg) - b0)
    # the gap is joined another way; where there is none within 8x the erased length, the route keeps it and says so
    r['erase_note'] = await pg.text_content('#toast') if await pg.is_visible('#toast') else ''
    await pg.click('#undoBtn'); r['undo_restores'] = abs(await dist(pg) - b0) < 0.01
    await pg.click('#redoBtn'); r['redo_reapplies'] = abs(await dist(pg) - b0) > 1 if r['erase_middle_change_m'] else None
    await pg.click('#undoBtn')
    # keyboard: Escape back to pan, Shift toggles snap
    await pg.keyboard.press('Escape'); r['tool_after_escape'] = await pg.get_attribute('#toolErase', 'aria-pressed')
    await pg.keyboard.press('Shift'); r['snap_after_shift'] = await pg.get_attribute('#toolSnap', 'aria-pressed'); await pg.keyboard.press('Shift')
    # finish: out & back doubles
    L = await dist(pg); await pg.click('#finishBtn'); await pg.click('#finishPop button:has-text("Out & back")')
    r['out_back_ratio'] = round(await dist(pg) / L, 4)
    # waypoint
    await pg.click('#toolWaypoint'); box = await pg.locator('#map').bounding_box(); await pg.mouse.click(box['x'] + 700, box['y'] + 300)
    await pg.fill('#wpName', 'Water point'); await pg.click('#wpForm button[type=submit]'); r['waypoints'] = await ev(pg, "window.__jalan.editor.wps.map(w => w.title)")
    await pg.keyboard.press('k')
    await pg.wait_for_function("!document.querySelector('#chartMsg').textContent.includes('Loading')", timeout=15000)
    r['elevation_msg'] = await pg.text_content('#chartMsg')   # Open-Meteo is blocked in this run
    # save + list
    await pg.click('#menuBtn'); await pg.click('#saveBtn'); await pg.fill('#saveName', 'Test loop'); await pg.click('#saveForm button[type=submit]'); await pg.wait_for_timeout(300)
    r['saved_list'] = await pg.locator('#savedList .item .t').all_text_contents()
    # export GPX (download)
    async with pg.expect_download() as dl: await pg.click('#exportBtn')
    d = await dl.value; path = './export_test.gpx'; await d.save_as(path)
    gpx = open(path).read(); r['export_file'] = d.suggested_filename; r['export_trkpts'] = gpx.count('<trkpt'); r['km_at_export'] = round(await dist(pg) / 1000, 3); r['export_wpts'] = gpx.count('<wpt')
    # share link round trip
    await pg.click('#shareBtn'); link = await pg.evaluate("navigator.clipboard.readText()"); r['share_len'] = len(link)
    # import the exported file
    await pg.click('#closeDrawer'); await pg.click('#clearBtn')
    await pg.set_input_files('#importFile', path); await pg.wait_for_timeout(500)
    r['import_km'] = round(await dist(pg) / 1000, 3); r['import_wps'] = await ev(pg, "window.__jalan.editor.wps.length")
    # open the share link in a fresh page
    pg2 = await ctx.new_page(); await pg2.goto(link); await pg2.wait_for_selector('#loading', state='hidden', timeout=30000); await pg2.wait_for_timeout(500)
    r['share_open_km'] = round(await dist(pg2) / 1000, 3)
    # closures: drawn on the map; a route through one shows a warning when avoidance is off
    r['closure_segments_drawn'] = await pg.evaluate("document.querySelectorAll('.leaflet-overlay-pane path[stroke-dasharray=\"4 7\"]').length")
    await pg.click('#menuBtn'); await pg.uncheck('#avoidClosures'); await pg.click('#closeDrawer'); await pg.click('#clearBtn'); await ev(pg, "0")
    await pg.evaluate("() => { const ed = window.__jalan.editor; ed.addPoint(1.3366, 103.8640, 80); ed.addPoint(1.3245, 103.8673, 80); }"); await ev(pg, "0"); await pg.wait_for_timeout(300)
    r['closure_warning'] = await pg.text_content('#closureWarn') if await pg.is_visible('#closureWarn') else ''
    await pg.click('#menuBtn'); await pg.check('#avoidClosures'); await pg.click('#closeDrawer'); await pg.click('#clearBtn'); await ev(pg, "0")
    await pg.evaluate("() => { const ed = window.__jalan.editor; ed.addPoint(1.3366, 103.8640, 80); ed.addPoint(1.3245, 103.8673, 80); }"); await ev(pg, "0"); await pg.wait_for_timeout(300)
    r['closure_warning_when_avoiding'] = await pg.is_visible('#closureWarn')
    r['closure_avoiding_route'] = await ev(pg, "[window.__jalan.editor.coords.length, Math.round(window.__jalan.editor.distance)]")   # for diagnosis
    # search (offline index)
    await pg.fill('#search', 'kallang park'); await pg.wait_for_timeout(300); r['search_first'] = (await pg.locator('#results button .t').all_text_contents())[:3]
    # reload keeps the draft
    await pg.reload(); await pg.wait_for_selector('#loading', state='hidden', timeout=30000); r['draft_after_reload_km'] = round(await dist(pg) / 1000, 3)
    # phone layout screenshot
    await pg.set_viewport_size({'width': 390, 'height': 844}); await pg.wait_for_timeout(800); await pg.screenshot(path='./shot_phone.png')
    r['errors'] = errs
    await b.close()

async def run_b(p):
    b = await p.chromium.launch(args=['--no-sandbox'])
    ctx = await b.new_context(viewport={'width': 1000, 'height': 700})
    pg = await ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    hits = {'tiles': 0, 'elev': 0, 'elev_points': 0, 'e429': 0}
    async def tile(route): hits['tiles'] += 1; await route.fulfill(status=200, body=PNG, headers={'content-type': 'image/png', 'access-control-allow-origin': '*'})
    async def elev(route):
        # the first request is refused as Open-Meteo does when its rate limit is hit; the app must wait and retry
        hits['elev'] += 1; q = route.request.url; n = len(re.search(r'latitude=([^&]+)', q).group(1).split('%2C' if '%2C' in q else ','))
        if hits['elev'] == 1:
            hits['e429'] += 1
            await route.fulfill(status=429, body='{"error":true,"reason":"Minutely API request limit exceeded. Please try again in one minute."}', headers={'content-type': 'application/json', 'access-control-allow-origin': '*'}); return
        hits['elev_points'] += n
        # flat ground at 8 m with a 14 m 'roof' on every 25th grid point (one ~44 m cell): smoothing must remove them
        await route.fulfill(status=200, body=json.dumps({'elevation': [8 + (14 if i % 25 == 0 else 0) for i in range(n)]}), headers={'content-type': 'application/json', 'access-control-allow-origin': '*'})
    await pg.route(re.compile(r'onemap\.gov\.sg/maps/tiles|arcgisonline\.com'), tile)
    await pg.route(re.compile(r'api\.open-meteo\.com'), elev)
    await serve_network(pg)
    await pg.goto(URL + URL_Q); await pg.wait_for_selector('#loading', state='hidden', timeout=30000)
    await pg.click('#exampleBtn')
    r = results['B'] = {}
    try:
        await pg.wait_for_function("document.querySelector('#chartMsg').textContent.includes('busy')", timeout=5000); r['busy_note'] = True
    except Exception: r['busy_note'] = False
    await pg.wait_for_function("/\\d/.test(document.querySelector('#statGain').textContent)", timeout=15000)
    r['elevation_429s'] = hits['e429']; r['elevation_points'] = hits['elev_points']
    r['route_samples'] = await pg.evaluate("window.RouteEngine.elevationSamples(window.__jalan.editor.coords, 200, 20).pts.length")
    # undo (one way) and redo (out & back again): every cell is cached, so nothing more is asked
    await pg.click('#undoBtn'); await pg.wait_for_timeout(1500); await pg.click('#redoBtn'); await pg.wait_for_timeout(1500)
    r['elevation_points_after_undo_redo'] = hits['elev_points'] - r['elevation_points']
    r['tiles_served'] = hits['tiles']; r['fallback'] = await pg.evaluate("window.__jalan.tilesBlocked")
    r['elevation_requests'] = hits['elev']; r['climb'] = await pg.text_content('#statGain'); r['chart_drawn'] = await pg.locator('#chart svg').count()
    await pg.click('#layersBtn'); r['layers_menu'] = await pg.locator('#layersPop button').all_text_contents()
    await pg.click('#layersPop button:has-text("Satellite")'); await pg.wait_for_timeout(500); r['tiles_after_satellite'] = hits['tiles']
    r['errors'] = errs
    await b.close()

async def run_c(p):
    """The worker script cannot load: the page must run the engine itself and still route."""
    b = await p.chromium.launch(args=['--no-sandbox']); ctx = await b.new_context(viewport={'width': 1000, 'height': 700}); pg = await ctx.new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.route(re.compile(r'onemap\.gov\.sg|arcgisonline\.com|open-meteo'), lambda r: r.abort())
    await pg.route(re.compile(r'/worker\.js$'), lambda r: r.fulfill(status=404, body='missing'))
    await serve_network(pg)
    await pg.goto(URL); await pg.wait_for_selector('#loading', state='hidden', timeout=60000)
    r = results['C'] = {}
    r['engine'] = await pg.evaluate("window.__jalan.engine")
    await pg.evaluate("() => { const ed = window.__jalan.editor; ed.addPoint(1.35707, 103.85017, 100); ed.addPoint(1.3540, 103.8520, 100); }")
    r['km'] = round(await dist(pg) / 1000, 3); r['errors'] = errs
    await b.close()

CHECKS = [
    ('A', 'footpath_network', lambda v: v is bool(NET_FILE)),
    ('A', 'paths_select_enabled', lambda v: v is bool(NET_FILE)),
    ('A', 'profile', lambda v: v == 'roads'),
    ('A', 'elevation_msg', lambda v: 'could not be reached' in v),
    ('A', 'engine', lambda v: v == ENGINE),
    ('A', 'network_file', lambda v: v == ('run-net-3' if (NET_FILE or '').endswith('.gz') else 'run-net-2' if NET_FILE else 'run-net-1')),
    ('A', 'profile_after_all', lambda v: v == ('all' if NET_FILE else None)),
    ('A', 'empty_on_first_visit', lambda v: v is True),
    ('A', 'example_km', lambda v: 3.0 < v < 4.0),
    ('A', 'two_taps_km', lambda v: 0.6 < v < 1.1),
    ('A', 'draw_added_m', lambda v: v > 700),
    ('A', 'undo_restores', lambda v: v is True),
    ('A', 'redo_reapplies', lambda v: v is not False),
    ('A', 'erase_note', lambda v: 'no other way' in v if results['A'].get('erase_middle_change_m') == 0 else True),
    ('A', 'out_back_ratio', lambda v: abs(v - 2) < 0.01),
    ('A', 'waypoints', lambda v: v == ['Water point']),
    ('A', 'saved_list', lambda v: 'Test loop' in v),
    ('A', 'export_trkpts', lambda v: v > 100),
    ('A', 'import_km', lambda v, r=None: True),
    ('A', 'closure_segments_drawn', lambda v: v > 0),
    ('A', 'closure_warning', lambda v: 'closed stretch' in v),
    ('A', 'closure_warning_when_avoiding', lambda v: v is False),
    ('A', 'search_first', lambda v: any('Kallang' in x for x in v)),
    ('A', 'errors', lambda v: v == []),
    ('B', 'fallback', lambda v: v is False),
    ('B', 'tiles_served', lambda v: v > 0),
    ('B', 'chart_drawn', lambda v: v == 1),
    ('B', 'elevation_429s', lambda v: v == 1),
    ('B', 'busy_note', lambda v: v is True),
    ('B', 'elevation_points', lambda v: v < results['B']['route_samples'] * 0.6),
    ('B', 'elevation_points_after_undo_redo', lambda v: v <= max(3, 0.15 * results['B']['elevation_points'])),
    ('B', 'climb', lambda v: v.replace('≈', '').replace('m', '').strip().isdigit() and int(v.replace('≈', '').replace('m', '')) < 10),
    ('B', 'layers_menu', lambda v: 'OpenStreetMap' not in v and 'Satellite (Esri)' in v),
    ('B', 'errors', lambda v: v == []),
    ('C', 'engine', lambda v: v == 'inline'),
    ('C', 'km', lambda v: 0.2 < v < 1.5),
    ('C', 'errors', lambda v: v == []),
]

async def main():
    async with async_playwright() as p:
        await run_a(p); await run_b(p); await run_c(p)
    print(json.dumps(results, indent=1, ensure_ascii=False))
    bad = [f'{g}.{k} = {results[g].get(k)!r}' for g, k, ok in CHECKS if not ok(results[g].get(k))]
    if results['A'].get('import_km') != results['A'].get('km_at_export'): bad.append(f"import_km {results['A'].get('import_km')} != km_at_export {results['A'].get('km_at_export')}")
    print('FAILED: ' + '; '.join(bad) if bad else 'ALL BROWSER CHECKS PASSED')
    raise SystemExit(1 if bad else 0)
asyncio.run(main())
