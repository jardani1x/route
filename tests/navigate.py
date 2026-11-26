# Usage: serve the site on port 8766 (python3 -m http.server 8766), then: python3 tests/navigate.py
# NET_FILE=/path/net-v3.bin.gz serves that footpath network (else net.json); ENGINE=inline runs the engine in the page.
"""Browser test of following a route (Start) and of taking a finish off again.
Map tiles (OneMap, OpenStreetMap) are replaced by a 1-pixel PNG; the footpath network falls back to net.json.
Checks:
  finish: the example is an out & back; "Take it off" halves it; the finish menu shows it as on/off; a tap
          after out & back extends the way out and the way back follows.
  start:  the Start button opens the turn-by-turn panel; the browser location (Playwright geolocation)
          reaches it ("head ... to the start"); fixes along the route show the next turn and the metres to
          it; three fixes 150 m away say "off the route"; taps on the map do not edit while following; the
          layers menu switches to OpenStreetMap (tiles asked for with a Referer, attribution shown);
          Simulate moves along; the end says "You have arrived"; Stop puts the planner back."""
import asyncio, base64, json, math, os, re, sys
from playwright.async_api import async_playwright

NET_FILE = os.environ.get('NET_FILE')
BROWSER = os.environ.get('BROWSER', 'chromium')   # chromium, or webkit (Safari's engine)
URL = 'http://localhost:8766/index.html' + ('?worker=0' if os.environ.get('ENGINE') == 'inline' else '')
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
results, osm_requests = {}, []


async def new_page(b, viewport, allow=True):
    ctx = await b.new_context(viewport=viewport, geolocation={'latitude': 1.3620, 'longitude': 103.8480, 'accuracy': 10},
                              permissions=['geolocation'] if allow else [])
    pg = await ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.route(re.compile(r'api\.open-meteo\.com|arcgisonline\.com|openfreemap\.org'), lambda r: r.abort())
    async def network(route):   # the footpath network: NET_FILE, or unreachable (the app falls back to net.json)
        if NET_FILE and NET_FILE.endswith('.gz') == route.request.url.endswith('.gz'):
            return await route.fulfill(status=200, path=NET_FILE, headers={'content-type': 'application/octet-stream', 'access-control-allow-origin': '*'})
        await route.abort()
    await pg.route(re.compile(r'raw\.githubusercontent\.com'), network)
    async def tile(route):
        if 'tile.openstreetmap.org' in route.request.url:
            osm_requests.append({'url': route.request.url, 'referer': (await route.request.all_headers()).get('referer')})
        await route.fulfill(status=200, body=PNG, headers={'content-type': 'image/png', 'access-control-allow-origin': '*'})
    await pg.route(re.compile(r'onemap\.gov\.sg/maps/tiles|tile\.openstreetmap\.org'), tile)
    await pg.goto(URL); await pg.wait_for_selector('#loading', state='hidden', timeout=60000)
    return ctx, pg, errs


async def nav_state(pg):
    return await pg.evaluate("""() => ({ dist: document.querySelector('#navDist').textContent, text: document.querySelector('#navText').textContent,
        then: document.querySelector('#navThen').textContent, warn: document.querySelector('#navWarn').hidden ? '' : document.querySelector('#navWarn').textContent,
        done: document.querySelector('#navDone').textContent, left: document.querySelector('#navLeft').textContent,
        along: window.__jalan.nav.last ? Math.round(window.__jalan.nav.last.along) : null, status: window.__jalan.nav.last ? window.__jalan.nav.last.status : null })""")


async def fix_at(pg, d, side=0, acc=8):
    """A position d metres along the followed route, side metres to its right."""
    await pg.evaluate("""([d, side, acc]) => { const J = window.__jalan, cs = J.nav.coords, G = window.RouteEngine.geo, cum = G.cumul(cs);
        const p = G.pointAt(cs, cum, d), q = G.pointAt(cs, cum, Math.min(cum[cs.length - 1], d + 5));
        const dy = (q[0] - p[0]) * 110574, dx = (q[1] - p[1]) * 111300, n = Math.hypot(dx, dy) || 1;
        const hd = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
        J.fix(p[0] - (dx / n) * side / 110574, p[1] + (dy / n) * side / 111300, acc, side ? null : hd); }""", [d, side, acc])


ATTR_CLEAR = """(() => { const a = document.querySelector('.leaflet-control-attribution'), r = a.getBoundingClientRect(), pts = [];
    for (let y = r.top + 4; y < r.bottom; y += 13) for (const f of [0.08, 0.5, 0.92]) pts.push([r.left + r.width * f, y]);
    return pts.every(([x, y]) => { const e = document.elementFromPoint(x, y); return e && a.contains(e); }); })()"""


async def main():
    async with async_playwright() as p:
        b = await (p.webkit.launch() if BROWSER == 'webkit' else p.chromium.launch(args=['--no-sandbox']))
        ctx, pg, errs = await new_page(b, {'width': 1100, 'height': 760})

        # ---- 1. out & back / loop can be taken off and the route changed afterwards ----
        r = results['finish'] = {}
        await pg.click('#exampleBtn'); await pg.evaluate("window.__jalan.idle()")
        full = await pg.evaluate("window.__jalan.editor.distance")
        r['example_is_outback'] = await pg.evaluate("window.__jalan.editor.finish === 'outback'")
        r['finish_line_shown'] = await pg.is_visible('#finishLine')
        await pg.click('#finishOff'); await pg.evaluate("window.__jalan.idle()")
        half = await pg.evaluate("window.__jalan.editor.distance")
        r['take_off_halves'] = abs(half * 2 - full) < 2 and await pg.evaluate("window.__jalan.editor.finish === null")
        r['finish_line_hidden_after'] = not await pg.is_visible('#finishLine')
        await pg.click('#finishBtn'); await pg.wait_for_selector('#finishPop:not([hidden])')
        await pg.click('#finishPop button:has-text("Out & back")'); await pg.evaluate("window.__jalan.idle()")
        r['menu_puts_it_back'] = await pg.evaluate("window.__jalan.editor.finish === 'outback'")
        await pg.click('#finishBtn'); await pg.wait_for_selector('#finishPop:not([hidden])')
        r['menu_shows_on'] = await pg.get_attribute('#finishPop button:has-text("Out & back")', 'aria-checked')
        await pg.keyboard.press('Escape')
        # a tap past the turnaround extends the way out; the way back follows
        before = await pg.evaluate("window.__jalan.editor.baseDistance")
        end = await pg.evaluate("(() => { const b = window.__jalan.editor.base; return b[b.length - 1]; })()")
        # a place on the network ~300 m on, shown in the middle of the map (the stats card covers the bottom)
        pt = await pg.evaluate("""async ([la, lo]) => { const J = window.__jalan, p = await J.path([la, lo], [la - 0.0025, lo + 0.0004]), t = p[p.length - 1];
            J.map.setView(t, 16, { animate: false }); const q = J.map.latLngToContainerPoint(t); return [q.x, q.y]; }""", end)
        box = await pg.locator('#map').bounding_box()
        await pg.mouse.click(box['x'] + pt[0], box['y'] + pt[1]); await pg.evaluate("window.__jalan.idle()")
        after = await pg.evaluate("[window.__jalan.editor.finish, window.__jalan.editor.baseDistance, window.__jalan.editor.distance]")
        r['tap_extends_way_out'] = after[0] == 'outback' and after[1] > before + 100 and abs(after[2] - 2 * after[1]) < 2
        r['way_out_m'] = [round(before), round(after[1])]
        await pg.click('#undoBtn'); await pg.evaluate("window.__jalan.idle()")

        # ---- 2. Start: turn-by-turn ----
        r = results['start'] = {}
        r['start_enabled'] = await pg.is_enabled('#startBtn')
        start = await pg.evaluate("window.__jalan.editor.coords[0]")
        await ctx.set_geolocation({'latitude': start[0] + 0.0027, 'longitude': start[1], 'accuracy': 10})   # ~300 m north
        await pg.click('#startBtn')
        await pg.wait_for_selector('#navTop:not([hidden])', timeout=10000)
        await pg.wait_for_function("document.querySelector('#navText').textContent.includes('to the start')", timeout=10000)
        s = await nav_state(pg); r['gps_before_start'] = s['text'] + ' | ' + s['dist']
        r['planner_hidden'] = await pg.evaluate("['.tools', '.history', '#stats'].every(q => getComputedStyle(document.querySelector(q)).display === 'none')")
        r['layers_button_visible'] = await pg.is_visible('#layersBtn')
        cues = await pg.evaluate("window.__jalan.nav.cues.map(c => ({ d: Math.round(c.d), type: c.type, text: c.text }))")
        r['cues'] = cues
        turn = next(c for c in cues if c['type'] not in ('depart',) and c['d'] > 250)
        for d in range(0, turn['d'] - 120 + 1, 15): await fix_at(pg, d)
        await fix_at(pg, turn['d'] - 120)
        s = await nav_state(pg)
        r['next_turn'] = s
        r['shows_turn_and_metres'] = s['text'] == turn['text'] and re.fullmatch(r'1[12]0 m', s['dist']) is not None and s['status'] == 'on'
        # off the route: three fixes 150 m to the side
        for k in range(3): await fix_at(pg, turn['d'] - 115 + 5 * k, side=150)
        s = await nav_state(pg); r['off_route'] = s['warn']
        r['off_route_ok'] = s['warn'].startswith('Off the route: the nearest part is') and s['status'] == 'off'
        await fix_at(pg, turn['d'] - 100); s = await nav_state(pg); r['back_on_route'] = s['warn'] == '' and s['status'] == 'on'
        # map taps do not edit while following
        n0 = await pg.evaluate("window.__jalan.editor.coords.length")
        await pg.mouse.click(box['x'] + 300, box['y'] + 400); await pg.wait_for_timeout(300); await pg.evaluate("window.__jalan.idle()")
        r['tap_does_not_edit'] = n0 == await pg.evaluate("window.__jalan.editor.coords.length")
        # OpenStreetMap from the layers menu while following
        await pg.click('#layersBtn'); await pg.click('#layersPop button:has-text("OpenStreetMap")'); await pg.wait_for_timeout(1200)
        r['osm_tiles'] = len(osm_requests)
        r['osm_referer'] = osm_requests[0]['referer'] if osm_requests else None
        r['osm_attribution'] = 'OpenStreetMap' in await pg.inner_text('.leaflet-control-attribution')
        r['osm_still_following'] = await pg.is_visible('#navTop')
        await pg.screenshot(path='/tmp/navigate_desktop.png')
        # Simulate runs along the route
        a0 = (await nav_state(pg))['along']
        await pg.click('#navSim'); await pg.wait_for_timeout(2600); await pg.click('#navSim')
        a1 = (await nav_state(pg))['along']
        r['simulate_moves_m'] = a1 - a0
        # the turnaround (out & back) and the finish
        L = await pg.evaluate("Math.round(window.RouteEngine.geo.length(window.__jalan.nav.coords))")
        for d in range(a1, L + 1, 20): await fix_at(pg, d)
        await fix_at(pg, L)
        s = await nav_state(pg); r['arrived'] = s['text']
        r['arrived_ok'] = s['text'].startswith('You have arrived') and s['status'] == 'done'
        await pg.click('#navStop')
        r['stop_restores'] = await pg.evaluate("!document.body.classList.contains('nav') && document.querySelector('#navTop').hidden && getComputedStyle(document.querySelector('.tools')).display !== 'none' && window.__jalan.editor.coords.length > 1")
        r['basemap_kept'] = await pg.evaluate("JSON.parse(localStorage.getItem('jalan.settings') || localStorage.getItem('settings') || '{}').basemap || null")
        r['errors'] = errs

        # ---- 2b. the real browser location (watchPosition), not the test hook ----
        r = results['live'] = {}
        ctx3, lp, lerr = await new_page(b, {'width': 390, 'height': 780})
        await lp.click('#exampleBtn'); await lp.evaluate("window.__jalan.idle()")
        route = await lp.evaluate("(() => { const G = window.RouteEngine.geo, cs = window.__jalan.editor.coords, cum = G.cumul(cs); return [0, 40, 80, 120, 160, 200, 240, 280].map(d => G.pointAt(cs, cum, d)); })()")
        await ctx3.set_geolocation({'latitude': route[0][0], 'longitude': route[0][1], 'accuracy': 6})
        await lp.click('#startBtn'); await lp.wait_for_selector('#navTop:not([hidden])')
        alongs, dots = [], []
        for q in route:
            await ctx3.set_geolocation({'latitude': q[0], 'longitude': q[1], 'accuracy': 6}); await lp.wait_for_timeout(700)
            st = await lp.evaluate("(() => { const n = window.__jalan.nav; return [n.last ? Math.round(n.last.along) : null, n.me ? [n.me.getLatLng().lat, n.me.getLatLng().lng] : null]; })()")
            alongs.append(st[0]); dots.append(st[1])
        r['along_from_gps'] = alongs
        r['dot_moves'] = dots[-1] is not None and abs(dots[-1][0] - route[-1][0]) < 1e-5 and abs(dots[-1][1] - route[-1][1]) < 1e-5
        r['gps_line'] = await lp.inner_text('#navGps')
        # the watch goes quiet: the watchdog starts it again, and fixes come through after that
        await lp.evaluate("window.__jalan.loc.stallMs = 1500")
        await lp.wait_for_timeout(4500)
        r['watch_restarts'] = await lp.evaluate("window.__jalan.loc.restarts")
        await ctx3.set_geolocation({'latitude': route[0][0] + 0.0001, 'longitude': route[0][1], 'accuracy': 6}); await lp.wait_for_timeout(700)
        r['fix_after_restart'] = await lp.evaluate("(() => { const n = window.__jalan.nav; return !!n.me && Math.abs(n.me.getLatLng().lat - %f) < 1e-6; })()" % (route[0][0] + 0.0001))
        await lp.evaluate("window.__jalan.loc.stallMs = 12000")
        # approximate location (iPhone with Precise Location off): explained, progress not moved
        a0 = await lp.evaluate("window.__jalan.nav.last.along")
        await ctx3.set_geolocation({'latitude': 1.3500, 'longitude': 103.8400, 'accuracy': 3000}); await lp.wait_for_timeout(700)
        r['approx_warning'] = await lp.evaluate("document.querySelector('#navWarn').hidden ? '' : document.querySelector('#navWarn').textContent")
        r['approx_holds_progress'] = await lp.evaluate("window.__jalan.nav.last.along") == a0
        await lp.click('#navStop')
        # the location button: a live dot that follows; move the map to stop following; tap to follow again; tap to stop
        await ctx3.set_geolocation({'latitude': route[0][0], 'longitude': route[0][1], 'accuracy': 8})
        await lp.click('#locateBtn'); await lp.wait_for_function("window.__jalan.me !== null", timeout=8000)
        mes = []
        for q in route[1:5]:
            await ctx3.set_geolocation({'latitude': q[0], 'longitude': q[1], 'accuracy': 8}); await lp.wait_for_timeout(700)
            mes.append(await lp.evaluate("(() => { const m = window.__jalan.me, c = window.__jalan.map.getCenter(); return [m.lat, m.lng, Math.round(window.__jalan.map.distance(c, m))]; })()"))
        r['locate_dot_moves'] = all(abs(m[0] - q[0]) < 1e-5 and abs(m[1] - q[1]) < 1e-5 for m, q in zip(mes, route[1:5]))
        r['locate_map_follows_m'] = max(m[2] for m in mes)
        box3 = await lp.locator('#map').bounding_box()
        await lp.mouse.move(box3['x'] + 200, box3['y'] + 300); await lp.mouse.down(); await lp.mouse.move(box3['x'] + 120, box3['y'] + 220, steps=6); await lp.mouse.up()
        r['drag_stops_following'] = await lp.get_attribute('#locateBtn', 'data-follow') == 'false' and await lp.get_attribute('#locateBtn', 'aria-pressed') == 'true'
        await lp.click('#locateBtn'); r['tap_follows_again'] = await lp.get_attribute('#locateBtn', 'data-follow') == 'true'
        await lp.click('#locateBtn')
        r['tap_stops'] = await lp.evaluate("window.__jalan.me === null && window.__jalan.loc.watch === null") and await lp.get_attribute('#locateBtn', 'aria-pressed') == 'false'
        # approximate location from the button: says how to turn on Precise Location
        await ctx3.set_geolocation({'latitude': 1.3500, 'longitude': 103.8400, 'accuracy': 3000})
        await lp.click('#locateBtn'); await lp.wait_for_timeout(900)
        r['locate_approx_toast'] = await lp.evaluate("document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent")
        await lp.click('#locateBtn')
        r['errors'] = lerr
        # location not allowed: says so instead of doing nothing
        ctx4, dp, derr = await new_page(b, {'width': 390, 'height': 780}, allow=False)
        await dp.click('#locateBtn'); await dp.wait_for_timeout(1500)
        r['denied_toast'] = await dp.evaluate("document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent")

        # ---- 3. phone layout while following ----
        ctx2, ph, perr = await new_page(b, {'width': 390, 'height': 780})
        await ph.click('#exampleBtn'); await ph.evaluate("window.__jalan.idle()")
        credits = {'planner_onemap': await ph.evaluate(ATTR_CLEAR)}
        await ph.click('#startBtn'); await ph.wait_for_selector('#navTop:not([hidden])')
        credits['nav_onemap'] = await ph.evaluate(ATTR_CLEAR)
        await ph.click('#layersBtn'); await ph.click('#layersPop button:has-text("OpenStreetMap")'); await ph.wait_for_timeout(300)
        credits['nav_osm'] = await ph.evaluate(ATTR_CLEAR)
        for d in range(0, 400, 20): await fix_at(ph, d)
        await ph.wait_for_timeout(1200); await ph.screenshot(path='/tmp/navigate_phone.png')
        results['phone'] = {'state': await nav_state(ph), 'panels_fit': await ph.evaluate("""(() => { const r = (q) => document.querySelector(q).getBoundingClientRect();
            const t = r('#navTop'), bt = r('#navBottom'), ly = r('#layersBtn'), stop = r('#navStop');
            const apart = (a, b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
            return t.left >= 0 && t.right <= innerWidth && bt.bottom <= innerHeight && t.bottom < bt.top && apart(ly, bt)
              && stop.right <= innerWidth && stop.bottom <= innerHeight && document.elementFromPoint(stop.left + stop.width / 2, stop.top + stop.height / 2) === document.querySelector('#navStop'); })()"""),
            'follows_m': await ph.evaluate("(() => { const J = window.__jalan; return Math.round(J.map.distance(J.map.getCenter(), J.nav.me.getLatLng())); })()"),
            'credits_readable': credits, 'errors': perr}
        await b.close()

    print(json.dumps(results, indent=1))
    f, s = results['finish'], results['start']
    checks = {
        'example is an out & back': f['example_is_outback'] and f['finish_line_shown'],
        '"Take it off" removes the out & back': f['take_off_halves'] and f['finish_line_hidden_after'],
        'finish menu puts it back and shows it on': f['menu_puts_it_back'] and f['menu_shows_on'] == 'true',
        'tap after out & back extends the way out': f['tap_extends_way_out'],
        'Start enabled with a route': s['start_enabled'],
        'location reaches the panel before the start': 'to the start' in s['gps_before_start'],
        'planner tools hidden, layers button kept': s['planner_hidden'] and s['layers_button_visible'],
        'next turn and metres to it': s['shows_turn_and_metres'],
        'off the route after three fixes': s['off_route_ok'] and s['back_on_route'],
        'map taps do not edit while following': s['tap_does_not_edit'],
        'OpenStreetMap tiles with a Referer and attribution': s['osm_tiles'] > 0 and (s['osm_referer'] or '').startswith('http://localhost:8766') and s['osm_attribution'] and s['osm_still_following'],
        'Simulate moves along the route': s['simulate_moves_m'] > 40,
        'arrival': s['arrived_ok'],
        'Stop restores the planner': s['stop_restores'],
        'phone layout fits (layers button clear of the panel, Stop tappable)': results['phone']['panels_fit'],
        'map follows the position': results['phone']['follows_m'] < 20,
        'map credits not covered on a phone (OneMap, OpenStreetMap)': all(results['phone']['credits_readable'].values()),
        'Start follows the browser location (watchPosition)': all(a is not None for a in results['live']['along_from_gps'][1:]) and results['live']['along_from_gps'][-1] >= 230 and results['live']['dot_moves'],
        'GPS status shown': results['live']['gps_line'].startswith('GPS ±'),
        'a quiet watch is started again': results['live']['watch_restarts'] >= 1 and results['live']['fix_after_restart'],
        'approximate location explained, progress held': 'approximate location' in results['live']['approx_warning'] and results['live']['approx_holds_progress'],
        'location button: live dot that moves and is followed': results['live']['locate_dot_moves'] and results['live']['locate_map_follows_m'] < 25,
        'location button: drag stops following, tap follows again, tap stops': results['live']['drag_stops_following'] and results['live']['tap_follows_again'] and results['live']['tap_stops'],
        'location button: approximate location explained': 'approximate location' in results['live']['locate_approx_toast'],
        'location refused: says so': 'Location is off' in (results['live']['denied_toast'] or ''),
        'no page errors': not s['errors'] and not results['phone']['errors'] and not results['live']['errors'],
    }
    bad = [k for k, v in checks.items() if not v]
    for k, v in checks.items(): print(('PASS  ' if v else 'FAIL  ') + k)
    sys.exit(1 if bad else 0)


asyncio.run(main())
