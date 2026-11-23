"""Moving the map while drawing: right-drag and Space+drag (desktop), two fingers (touch).
Serve the repo root on port 8766 first: python3 -m http.server 8766"""
import asyncio, json
from playwright.async_api import async_playwright

URL = 'http://localhost:8766/index.html'
R = {}

async def state(pg):
    return await pg.evaluate("() => { const J = window.__jalan, c = J.map.getCenter(); return {lat: c.lat, lng: c.lng, zoom: J.map.getZoom(), dist: J.editor.distance, tool: J.tool}; }")

def moved_px(a, b, zoom):   # approximate on-screen shift between two centres
    import math
    mpp = 40075016.686 * math.cos(math.radians(a['lat'])) / (256 * 2 ** zoom)
    dx = (b['lng'] - a['lng']) * 111319.49 * math.cos(math.radians(a['lat'])) / mpp
    dy = (b['lat'] - a['lat']) * 110574 / mpp
    return round(dx), round(dy)

async def ready(pg):
    await pg.goto(URL); await pg.wait_for_selector('#loading', state='hidden', timeout=30000)
    await pg.evaluate("() => window.__jalan.map.setView([1.3500, 103.8545], 16, {animate: false})"); await pg.wait_for_timeout(400)

async def desktop(p):
    b = await p.chromium.launch(args=['--no-sandbox']); ctx = await b.new_context(viewport={'width': 1280, 'height': 800})
    pg = await ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    await ready(pg)
    await pg.evaluate("() => { window.__menuBlocked = null; window.addEventListener('contextmenu', e => { window.__menuBlocked = e.defaultPrevented; }); }")
    await pg.click('#toolDraw'); r = R['desktop'] = {'hint': await pg.text_content('#banner')}
    s0 = await state(pg)
    # right-button drag 200 px left, 100 px up
    await pg.mouse.move(700, 400); await pg.mouse.down(button='right')
    for i in range(1, 11): await pg.mouse.move(700 - 20 * i, 400 - 10 * i)
    await pg.mouse.up(button='right'); await pg.wait_for_timeout(200)
    await pg.evaluate("() => document.getElementById('map').dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 500, clientY: 300}))")
    s1 = await state(pg)
    r['right_drag_shift_px'] = moved_px(s0, s1, s0['zoom']); r['right_drag_route_changed'] = abs(s1['dist'] - s0['dist']) > 0.01
    r['context_menu_blocked'] = await pg.evaluate("window.__menuBlocked"); r['still_draw_tool'] = s1['tool'] == 'draw'
    # hold Space, left-drag: pans without drawing (focus is still on the Draw button)
    await pg.keyboard.down(' ')
    await pg.mouse.move(600, 400); await pg.mouse.down()
    for i in range(1, 11): await pg.mouse.move(600 + 15 * i, 400 + 5 * i)
    await pg.mouse.up(); await pg.keyboard.up(' '); await pg.wait_for_timeout(200)
    s2 = await state(pg)
    r['space_drag_shift_px'] = moved_px(s1, s2, s1['zoom']); r['space_drag_route_changed'] = abs(s2['dist'] - s1['dist']) > 0.01
    r['space_kept_draw_tool'] = s2['tool'] == 'draw'
    # plain left drag still draws: clear, then trace along a known path on screen
    if await pg.is_enabled('#clearBtn'): await pg.click('#clearBtn')
    if (await state(pg))['tool'] != 'draw': await pg.click('#toolDraw')
    s2 = await state(pg)
    pts = await pg.evaluate("""() => { const J = window.__jalan, p = J.router.path([1.35142, 103.855], [1.3470, 103.8562]);
       return window.RouteEngine.geo.resample(p, 12).map(c => { const q = J.map.latLngToContainerPoint(c); return [q.x, q.y]; }); }""")
    await pg.mouse.move(*pts[0]); await pg.mouse.down()
    for x, y in pts[1:]: await pg.mouse.move(x, y, steps=2)
    await pg.mouse.up(); await pg.wait_for_timeout(400)
    s3 = await state(pg); r['left_drag_added_m'] = round(s3['dist'] - s2['dist']); r['left_drag_expected_m'] = await pg.evaluate("() => Math.round(window.RouteEngine.geo.length(window.__jalan.router.path([1.35142, 103.855], [1.3470, 103.8562])))")
    r['errors'] = errs; await b.close()

async def touch(p):
    b = await p.chromium.launch(args=['--no-sandbox'])
    ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    pg = await ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    await ready(pg); cdp = await ctx.new_cdp_session(pg)
    async def touch_ev(kind, points):
        await cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [{'x': x, 'y': y, 'id': i} for i, (x, y) in points]})
    await pg.tap('#toolDraw'); r = R['touch'] = {'hint': await pg.text_content('#banner')}
    s0 = await state(pg)
    # one finger draws
    pts = await pg.evaluate("""() => { const J = window.__jalan, p = J.router.path([1.3510, 103.8550], [1.3485, 103.8557]);
       return window.RouteEngine.geo.resample(p, 10).map(c => { const q = J.map.latLngToContainerPoint(c); return [q.x, q.y]; }); }""")
    await touch_ev('touchStart', [(0, pts[0])])
    for q in pts[1:]: await touch_ev('touchMove', [(0, q)])
    await touch_ev('touchEnd', []); await pg.wait_for_timeout(400)
    s1 = await state(pg); r['one_finger_draw_added_m'] = round(s1['dist'] - s0['dist'])
    # two fingers pan (both move 100 px right, 60 px down) without drawing
    a, c = (150, 400), (250, 420)
    await touch_ev('touchStart', [(0, a)]); await pg.wait_for_timeout(30); await touch_ev('touchStart', [(0, a), (1, c)])
    for i in range(1, 11): await touch_ev('touchMove', [(0, (a[0] + 10 * i, a[1] + 6 * i)), (1, (c[0] + 10 * i, c[1] + 6 * i))])
    await touch_ev('touchEnd', [(0, (a[0] + 100, a[1] + 60))]); await touch_ev('touchEnd', []); await pg.wait_for_timeout(500)
    s2 = await state(pg)
    r['two_finger_shift_px'] = moved_px(s1, s2, s1['zoom']); r['two_finger_route_changed'] = abs(s2['dist'] - s1['dist']) > 0.01
    # two fingers pinch outwards: zoom in
    await touch_ev('touchStart', [(0, (170, 400)), (1, (220, 400))])
    for i in range(1, 11): await touch_ev('touchMove', [(0, (170 - 8 * i, 400)), (1, (220 + 8 * i, 400))])
    await touch_ev('touchEnd', []); await pg.wait_for_timeout(700)
    s3 = await state(pg); r['pinch_zoom'] = [s2['zoom'], s3['zoom']]; r['pinch_route_changed'] = abs(s3['dist'] - s2['dist']) > 0.01
    # a real stroke, then a second finger lands: the stroke is kept, then the map pans
    await pg.evaluate("() => window.__jalan.map.setView([1.3500, 103.8545], 16, {animate: false})"); await pg.wait_for_timeout(300)
    s4 = await state(pg)
    pts = await pg.evaluate("""() => { const J = window.__jalan, p = J.router.path([1.3485, 103.8557], [1.3460, 103.8563]);
       return window.RouteEngine.geo.resample(p, 10).map(c => { const q = J.map.latLngToContainerPoint(c); return [q.x, q.y]; }); }""")
    await touch_ev('touchStart', [(0, pts[0])])
    for q in pts[1:]: await touch_ev('touchMove', [(0, q)])
    last = pts[-1]; await touch_ev('touchStart', [(0, last), (1, (last[0] + 80, last[1]))])
    for i in range(1, 6): await touch_ev('touchMove', [(0, (last[0], last[1] - 12 * i)), (1, (last[0] + 80, last[1] - 12 * i))])
    await touch_ev('touchEnd', []); await pg.wait_for_timeout(500)
    s5 = await state(pg); r['stroke_kept_when_second_finger_lands_m'] = round(s5['dist'] - s4['dist'])
    r['errors'] = errs; await b.close()

async def main():
    async with async_playwright() as p:
        await desktop(p); await touch(p)
    print(json.dumps(R, indent=1))
    d, t = R['desktop'], R['touch']
    near = lambda v, want, tol: abs(v[0] - want[0]) <= tol and abs(v[1] - want[1]) <= tol
    checks = [
        ('right-drag moves the map', near(d['right_drag_shift_px'], (200, -100), 15)),
        ('right-drag leaves the route alone', not d['right_drag_route_changed']),
        ('no context menu while drawing', d['context_menu_blocked'] is True),
        ('Space-drag moves the map', abs(d['space_drag_shift_px'][0]) > 100),
        ('Space-drag leaves the route alone', not d['space_drag_route_changed']),
        ('Space keeps the Draw tool', d['space_kept_draw_tool']),
        ('left-drag still draws', d['left_drag_added_m'] > 300),
        ('one finger draws', t['one_finger_draw_added_m'] > 200),
        ('two fingers move the map', near(t['two_finger_shift_px'], (-100, 60), 15)),
        ('two fingers leave the route alone', not t['two_finger_route_changed']),
        ('pinch zooms in', t['pinch_zoom'][1] > t['pinch_zoom'][0]),
        ('stroke kept when a second finger lands', t['stroke_kept_when_second_finger_lands_m'] > 200),
        ('no page errors', not d['errors'] and not t['errors']),
    ]
    bad = [n for n, ok in checks if not ok]
    print('FAILED: ' + '; '.join(bad) if bad else 'ALL GESTURE CHECKS PASSED')
    raise SystemExit(1 if bad else 0)
asyncio.run(main())
