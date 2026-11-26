/* RouteBackend — the part of the planner that does the heavy work: loading the walk network, routing,
 * snapping drawn lines to it, and the route editor with its undo history. It runs in a Web Worker
 * (worker.js), so the page stays responsive while it works; if a worker cannot start, the page runs
 * the same code itself. Messages in and out are plain objects:
 *
 *   in  {t:'load', urls, settings}         -> {t:'loaded', parts, url, ms} | {t:'failed', errors}
 *   in  {t:'settings', profile?, pcnFactor?, avoidClosures?}  -> {t:'settings', profile}
 *   in  {t:'blocked', edges}               (closures: edge ids the page worked out on its own copy)
 *   in  {t:'cmd', id, op, args}            -> {t:'state', id, result, changed, state}
 *   in  {t:'cues', id}                     -> {t:'cues', id, coords, cues}   (turn-by-turn, engine.turnCues)
 *   in  {t:'path', id, a, b}               -> {t:'path', id, coords}   (tests only)
 *
 * `parts` is a light copy of the network for the page: coordinates as 32-bit floats (good to about a
 * metre, enough to place closures), map-pixel coordinates for drawing, and no adjacency, since the page
 * never routes. Its buffers are moved, not copied, so the page receives them at no cost. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'), require('./engine.js'));
  else root.RouteBackend = factory(root.RunCore, root.RouteEngine);
})(typeof self !== 'undefined' ? self : this, function (RC, RE) {
  'use strict';
  const OPS = new Set(['addPoint', 'addTrace', 'erase', 'outAndBack', 'closeLoop', 'removeFinish', 'reverse', 'trim', 'clear', 'load',
    'undo', 'redo', 'addWaypoint', 'updateWaypoint', 'removeWaypoint', 'setSnap']);

  async function fetchNetwork(url) {
    const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (/\.bin\.gz(\?|$)/.test(url)) {
      if (typeof DecompressionStream !== 'function') throw new Error('this browser cannot unpack .gz');
      const raw = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      return RC.Network.fromBinary(new Uint8Array(raw));
    }
    return RC.Network.fromText(await r.text());
  }

  /** Light copy for the page, plus the list of buffers that can be moved rather than copied. Also the
   *  vertices in Web Mercator pixels at zoom 0 (256 px world, as Leaflet), which the page draws tiles from. */
  function lightParts(net) {
    const p = net.toParts(), move = [], n = net.lat.length, px = new Float32Array(n), py = new Float32Array(n);
    // 32-bit offsets from an origin: exact to ~0.01 px even at zoom 18, half the memory of absolute doubles
    const X = (lo) => (lo + 180) / 360 * 256, Y = (la) => { const sn = Math.sin(la * Math.PI / 180); return (0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI)) * 256; };
    const x0 = n ? X(net.lon[0]) : 0, y0 = n ? Y(net.lat[0]) : 0;
    for (let i = 0; i < n; i++) { px[i] = X(net.lon[i]) - x0; py[i] = Y(net.lat[i]) - y0; }
    p.px = px; p.py = py; p.pxy0 = [x0, y0]; move.push(px.buffer, py.buffer);
    for (const k of ['lat', 'lon', 'nLat', 'nLon', 'bbox']) { p[k] = Float32Array.from(p[k]); move.push(p[k].buffer); }
    for (const k of ['eStart', 'eKind', 'eFlag', 'eName', 'eLen', 'eU', 'eV', 'gridStart', 'gridEdges']) { p[k] = p[k].slice(); move.push(p[k].buffer); }
    delete p.adjStart; delete p.adj; p.light = true;
    return { parts: p, move };
  }

  function RouteBackend(post) {
    let net = null, router = null, editor = null, changed = false;
    const settings = { profile: 'roads', pcnFactor: 0.8, avoidClosures: true };
    const state = () => ({ coords: editor.coords, wps: editor.wps, canUndo: editor.canUndo(), canRedo: editor.canRedo(), snap: editor.snap, finish: editor.finish, base: editor.finish ? editor.base : null });
    function apply(s) {
      Object.assign(settings, s);
      if (!router) return;
      router.pcnFactor = settings.pcnFactor; router.avoidClosures = settings.avoidClosures; router.setProfile(settings.profile);
    }
    return {
      async handle(m) {
        if (m.t === 'load') {
          Object.assign(settings, m.settings || {});
          const errors = [];
          for (const url of m.urls) {
            const t0 = Date.now();
            try {
              net = await fetchNetwork(url);
              router = new RE.Router(net, settings.profile); apply({});
              editor = new RE.RouteEditor(router); editor.onChange(() => { changed = true; });
              const { parts, move } = lightParts(net);
              post({ t: 'loaded', parts, url, ms: Date.now() - t0, profile: router.profile }, move);
              return;
            } catch (e) { errors.push(`${url}: ${e.message}`); net = null; }
          }
          post({ t: 'failed', errors });
        } else if (m.t === 'settings') {
          apply(m); post({ t: 'settings', profile: router ? router.profile : settings.profile });
        } else if (m.t === 'blocked') {
          if (!net) return;
          net.blocked.fill(0); for (const e of m.edges) net.blocked[e] = 1;
        } else if (m.t === 'cmd') {
          let result;
          changed = false;
          try {
            if (!editor) throw new Error('The map data is not loaded');
            if (!OPS.has(m.op)) throw new Error(`Unknown command ${m.op}`);
            if (m.op === 'setSnap') { editor.snap = !!m.args[0]; result = { ok: true }; } else result = editor[m.op](...(m.args || []));
          } catch (e) { result = { ok: false, msg: 'Something went wrong with that edit. ' + e.message }; }
          post({ t: 'state', id: m.id, result, changed, state: editor ? state() : null });
        } else if (m.t === 'cues') {   // turn-by-turn for the current route
          const c = editor && editor.coords.length > 1 ? editor.coords : [];
          post({ t: 'cues', id: m.id, coords: c, cues: c.length ? RE.turnCues(net, c, { turnaround: editor.finish === 'outback' ? editor.baseDistance : 0 }) : [] });
        } else if (m.t === 'path') {
          post({ t: 'path', id: m.id, coords: router ? router.path(m.a, m.b) : null });
        }
      },
    };
  }
  RouteBackend.lightParts = lightParts;
  return RouteBackend;
});
