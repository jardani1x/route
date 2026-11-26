# Usage: serve the site on port 8766 (python3 -m http.server 8766), then: python3 tests/view3d.py
"""Browser test of the 3D view. OpenFreeMap is replaced by a test style whose only vector tile
(tests/fixtures/buildings-z14.mvt) holds two buildings beside the example route, 40 m and 12 m tall.
Checks: the view opens tilted with our building and route layers, buildings render with their heights,
the route matches the editor, drawing tools are hidden, a theme change keeps the layers, Esc returns
to the flat map at the same place; offline it says OpenFreeMap could not load; without WebGL it says so."""
import asyncio, json, math, os, re, sys
from playwright.async_api import async_playwright

URL = 'http://localhost:8766/index.html'
HERE = os.path.dirname(os.path.abspath(__file__))
TILE = open(os.path.join(HERE, 'fixtures', 'buildings-z14.mvt'), 'rb').read()
STYLE = json.dumps({'version': 8, 'sources': {'openmaptiles': {'type': 'vector', 'tiles': ['https://tiles.openfreemap.org/test/{z}/{x}/{y}.pbf'], 'maxzoom': 14}},
                    'layers': [{'id': 'bg', 'type': 'background', 'paint': {'background-color': '#ece8e1'}}]})
GL = ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
results, styles_asked = {}, []


async def page_with(b, offline_3d=False, viewport=None):
    ctx = await b.new_context(viewport=viewport or {'width': 1100, 'height': 760})
    pg = await ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.route(re.compile(r'onemap\.gov\.sg/maps/tiles|arcgisonline\.com|api\.open-meteo\.com|raw\.githubusercontent\.com'), lambda r: r.abort())
    async def ofm(route):
        u = route.request.url
        if offline_3d: return await route.abort()
        if '/styles/' in u:
            styles_asked.append(u.rsplit('/', 1)[-1])
            return await route.fulfill(status=200, body=STYLE, headers={'content-type': 'application/json', 'access-control-allow-origin': '*'})
        body = TILE if u.endswith('/14/12918/8130.pbf') else b''
        await route.fulfill(status=200, body=body, headers={'content-type': 'application/x-protobuf', 'access-control-allow-origin': '*'})
    await pg.route(re.compile(r'tiles\.openfreemap\.org'), ofm)
    await pg.goto(URL); await pg.wait_for_selector('#loading', state='hidden', timeout=60000)
    return pg, errs


async def idle3d(pg):
    await pg.evaluate("""() => new Promise((r) => { const m = window.__jalan.map3d; const t = setTimeout(r, 8000);
        const done = () => { clearTimeout(t); r(); }; if (m.loaded() && m.areTilesLoaded() && !m.isMoving()) done(); else m.once('idle', done); })""")


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=GL)
        pg, errs = await page_with(b)
        r = results['view'] = {}
        await pg.click('#exampleBtn'); await pg.evaluate("window.__jalan.idle()")
        await pg.evaluate("window.__jalan.map.setView([1.35755, 103.8498], 17, {animate: false})")
        await pg.click('#view3dBtn')
        await pg.wait_for_function("window.__jalan.in3d === true", timeout=30000); await pg.wait_for_timeout(1300); await idle3d(pg)
        r.update(await pg.evaluate("""async () => { const J = window.__jalan, m = J.map3d, data = await m.getSource('jalan-route').getData();
            const line = data.features.find(f => f.properties.k === 'line');
            const b = m.queryRenderedFeatures({ layers: ['jalan-buildings'] }).map(f => f.properties.render_height);
            return { pitch: Math.round(m.getPitch()), layers: ['jalan-buildings', 'jalan-route', 'jalan-points'].filter(id => m.getLayer(id)),
                     route_points: line ? line.geometry.coordinates.length : 0, editor_points: J.editor.coords.length,
                     building_heights: [...new Set(b)].sort((x, y) => x - y), canvas: [m.getCanvas().width, m.getCanvas().height],
                     tools_hidden: getComputedStyle(document.querySelector('.tools')).display === 'none',
                     button: document.querySelector('#view3dBtn').textContent, center: [m.getCenter().lat, m.getCenter().lng] }; }"""))
        await pg.screenshot(path='/tmp/view3d_desktop.png')
        # theme change: the dark style loads and our layers come back
        await pg.evaluate("document.documentElement.setAttribute('data-theme', 'dark')"); await pg.wait_for_timeout(1500); await idle3d(pg)
        r['dark_style_asked'] = 'dark' in styles_asked
        r['layers_after_theme'] = await pg.evaluate("['jalan-buildings', 'jalan-route'].filter(id => window.__jalan.map3d.getLayer(id)).length")
        await pg.evaluate("document.documentElement.setAttribute('data-theme', 'light')")
        # back to 2D with Esc, at the same place
        c3 = await pg.evaluate("(() => { const c = window.__jalan.map3d.getCenter(); return [c.lat, c.lng]; })()")
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(400)
        c2 = await pg.evaluate("(() => { const c = window.__jalan.map.getCenter(); return [c.lat, c.lng]; })()")
        r['back_to_2d'] = await pg.evaluate("!window.__jalan.in3d && document.querySelector('#map3d').hidden && getComputedStyle(document.querySelector('.tools')).display !== 'none'")
        r['center_shift_m'] = round(math.hypot((c2[0] - c3[0]) * 110574, (c2[1] - c3[1]) * 111300))
        # reopen with the 3 key after an edit: the 3D route follows the editor
        await pg.click('#undoBtn'); await pg.evaluate("window.__jalan.idle()")
        await pg.keyboard.press('3'); await pg.wait_for_function("window.__jalan.in3d === true", timeout=15000)
        r['reopen_points'] = await pg.evaluate("async () => { const s = await window.__jalan.map3d.getSource('jalan-route').getData(); const l = s.features.find(f => f.properties.k === 'line'); return [l ? l.geometry.coordinates.length : 0, window.__jalan.editor.coords.length]; }")
        r['errors'] = errs
        # phone layout
        ph, perr = await page_with(b, viewport={'width': 390, 'height': 780})
        await ph.click('#view3dBtn'); await ph.wait_for_function("window.__jalan.in3d === true", timeout=30000); await ph.wait_for_timeout(1200)
        await ph.screenshot(path='/tmp/view3d_phone.png'); results['phone'] = {'opened': True, 'errors': perr}
        # OpenFreeMap unreachable: the view opens empty and says why
        off, oerr = await page_with(b, offline_3d=True)
        await off.click('#view3dBtn')
        try:
            await off.wait_for_function("document.querySelector('#toast').textContent.includes('OpenFreeMap')", timeout=20000); said = True
        except Exception: said = False
        results['offline'] = {'said_openfreemap': said, 'errors': oerr}
        await b.close()
        # no WebGL
        b2 = await p.chromium.launch(args=['--no-sandbox', '--disable-webgl', '--disable-webgl2', '--disable-3d-apis'])
        ng, nerr = await page_with(b2)
        await ng.click('#view3dBtn'); await ng.wait_for_timeout(1500)
        results['no_webgl'] = await ng.evaluate("({ said: document.querySelector('#toast').textContent.includes('WebGL'), in3d: window.__jalan.in3d, hidden: document.querySelector('#map3d').hidden })")
        results['no_webgl']['errors'] = nerr
        await b2.close()

    v = results['view']
    checks = [('opens tilted', 55 <= v['pitch'] <= 65), ('our layers', len(v['layers']) == 3), ('route matches the editor', v['route_points'] == v['editor_points'] > 10),
              ('buildings drawn with their heights', v['building_heights'] == [12, 40]), ('canvas has a size', min(v['canvas']) > 100),
              ('drawing tools hidden', v['tools_hidden']), ('button says 2D', v['button'] == '2D'),
              ('dark theme loads the dark style', v['dark_style_asked']), ('layers survive a theme change', v['layers_after_theme'] == 2),
              ('Esc returns to the flat map', v['back_to_2d']), ('same place on return', v['center_shift_m'] < 60),
              ('reopened route follows the editor', v['reopen_points'][0] == v['reopen_points'][1] > 1), ('no page errors', v['errors'] == [] and results['phone']['errors'] == []),
              ('offline says OpenFreeMap could not load', results['offline']['said_openfreemap']),
              ('no WebGL: says so and stays flat', results['no_webgl']['said'] and not results['no_webgl']['in3d'] and results['no_webgl']['hidden'])]
    print(json.dumps(results, indent=1))
    for name, ok in checks: print(('PASS ' if ok else 'FAIL ') + name)
    if not all(ok for _, ok in checks): sys.exit(1)
    print('ALL 3D CHECKS PASSED')

asyncio.run(main())
