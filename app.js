/* Jalan Route Planner — UI controller.
 * Sections: config/state · storage · map + basemaps · tools & pointer input · rendering · stats & elevation ·
 * search · popovers & drawer · import/export/share · keyboard · boot. Route logic lives in engine.js. */
(() => {
  'use strict';
  const CFG = window.RP_CONFIG;
  const RC = window.RunCore, RE = window.RouteEngine;
  const $ = (s) => document.querySelector(s);
  const IN_CLAUDE = !!(window.claude && window.claude.use);   // running as a claude.ai artifact page

  // ---------------- constants & state ----------------
  const OFFICIAL_CLOSURE = [[1.335786, 103.862072], [1.335786, 103.867464], [1.324301, 103.867464], [1.324301, 103.862072]];
  const EXAMPLE = { name: 'Example: Bishan Rd to Kallang PCN, out & back', taps: [[1.35707, 103.85017], [1.34349, 103.85733]] };
  const ACT = { walk: { label: 'Walking', pace: 720 }, run: { label: 'Running', pace: 360 }, cycle: { label: 'Cycling', pace: 200 } };
  const MI = 1609.344;
  const LS = 'jalan.v1.';
  const lsGet = (k, d) => { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) { /* storage unavailable: convenience only */ } };
  const saved = lsGet('settings', {});
  const S = Object.assign({ units: 'km', activity: 'run', paces: { walk: 720, run: 360, cycle: 200 }, basemap: 'street', showPcn: true, preferPcn: true, avoidClosures: true }, saved);
  S.paces = Object.assign({ walk: 720, run: 360, cycle: 200 }, saved.paces || {});
  let tool = 'pan', net = null, router = null, editor = null, tilesBlocked = false;
  const saveSettings = () => lsSet('settings', { units: S.units, activity: S.activity, paces: S.paces, basemap: S.basemap, showPcn: S.showPcn, preferPcn: S.preferPcn, avoidClosures: S.avoidClosures });

  // ---------------- small UI helpers ----------------
  let toastT = 0;
  function toast(msg, ms = 3200) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms); }
  const report = (r) => { if (r && !r.ok && r.msg) toast(r.msg); return r; };
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const fmtDist = (m, dp = 2) => (S.units === 'mi' ? (m / MI).toFixed(dp) : (m / 1000).toFixed(dp));
  const unitLabel = () => (S.units === 'mi' ? 'mi' : 'km');
  function fmtTime(sec) { sec = Math.round(sec); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`; }
  const fmtPace = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  function parsePace(str) { const m = /^\s*(\d{1,2})(?::(\d{1,2}))?\s*$/.exec(str || ''); if (!m) return null; const v = +m[1] * 60 + +(m[2] || 0); return v >= 60 && v <= 1800 ? v : null; }
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------------- storage (cloud when the artifact offers it, else this browser) ----------------
  const store = {
    cloud: null, routes: [], loading: false,
    list() { return this.cloud ? this.routes : lsGet('routes', []); },
    async save(r) {
      if (this.cloud) {
        try { await this.cloud.doc(r.id).set(r); return 'cloud'; }
        catch (e) { if (e && e.code === 'quota_exceeded') throw new Error('Storage is full. Delete a saved route and try again.'); }
      }
      const list = lsGet('routes', []).filter(x => x.id !== r.id); list.push(r); lsSet('routes', list); renderSaved(); return 'local';
    },
    async remove(r) {
      if (this.cloud && r._cloud) { await this.cloud.doc(r.id).delete(); return; }
      lsSet('routes', lsGet('routes', []).filter(x => x.id !== r.id)); renderSaved();
    },
  };

  // ---------------- map & basemaps ----------------
  const map = L.map('map', { zoomControl: false, minZoom: 11, maxZoom: 19, doubleClickZoom: false, boxZoom: false,
    maxBounds: [[1.10, 103.50], [1.55, 104.20]], maxBoundsViscosity: 0.8 }).setView(CFG.center, CFG.zoom);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  const TILE = 256;
  let PX = null, PY = null;
  const merc = (la) => { const s = Math.sin(la * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE; };
  const unmercY = (y) => { const n = Math.PI - 2 * Math.PI * y / TILE; return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };
  function themeColors() { return { road: cssVar('--road'), casing: cssVar('--road-casing'), fill: cssVar('--road-fill'), pcn: cssVar('--pcn'), label: cssVar('--label'), halo: cssVar('--halo'), font: cssVar('--font-body') }; }
  function strokeEdges(ctx, ids, sc, ox, oy, test) {
    ctx.beginPath();
    for (const e of ids) {
      if (!test(e)) continue;
      const a = net.eStart[e], b = net.eStart[e + 1];
      let lx = PX[a] * sc - ox, ly = PY[a] * sc - oy; ctx.moveTo(lx, ly);
      for (let i = a + 1; i < b; i++) { const x = PX[i] * sc - ox, y = PY[i] * sc - oy; if (i < b - 1 && Math.abs(x - lx) < 0.8 && Math.abs(y - ly) < 0.8) continue; ctx.lineTo(x, y); lx = x; ly = y; }
    }
    ctx.stroke();
  }
  function drawLabels(ctx, ids, sc, ox, oy, z, th, roads) {
    const seen = new Set(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const e of ids) {
      const kind = net.eKind[e], name = net.nameOf(e);
      if (!name || kind === 2 || (kind === 0 && (!roads || z < 16)) || (kind === 1 && z < 15) || seen.has(name)) continue;
      let best = null;
      for (let i = net.eStart[e]; i < net.eStart[e + 1] - 1; i++) {
        const x1 = PX[i] * sc - ox, y1 = PY[i] * sc - oy, x2 = PX[i + 1] * sc - ox, y2 = PY[i + 1] * sc - oy, L2 = Math.hypot(x2 - x1, y2 - y1);
        if (!best || L2 > best.L) best = { L: L2, x1, y1, x2, y2 };
      }
      ctx.font = `${kind === 1 ? 'italic 600' : '600'} ${z >= 17 ? 12 : 11}px ${th.font}`;
      const w = ctx.measureText(name).width; if (!best || best.L < w + 16) continue;
      const cx = (best.x1 + best.x2) / 2, cy = (best.y1 + best.y2) / 2, half = w / 2 + 6;
      if (cx - half < 2 || cx + half > TILE - 2 || cy - half < 2 || cy + half > TILE - 2) continue;
      let ang = Math.atan2(best.y2 - best.y1, best.x2 - best.x1); if (ang > Math.PI / 2) ang -= Math.PI; if (ang < -Math.PI / 2) ang += Math.PI;
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(ang); ctx.lineWidth = 3; ctx.strokeStyle = th.halo; ctx.strokeText(name, 0, 0);
      ctx.fillStyle = kind === 1 ? th.pcn : th.label; ctx.fillText(name, 0, 0); ctx.restore(); seen.add(name);
    }
  }
  /** Canvas tiles drawn from the bundled network: the offline basemap (roads + PCN) or a PCN-only overlay. */
  const NetLayer = L.GridLayer.extend({
    createTile(c) {
      const cv = document.createElement('canvas'), r = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = cv.height = TILE * r; if (!net) return cv;
      const ctx = cv.getContext('2d'); ctx.scale(r, r); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const z = c.z, sc = Math.pow(2, z), ox = c.x * TILE, oy = c.y * TILE, pad = 24, roads = this.options.roads;
      const n = unmercY((oy - pad) / sc), s = unmercY((oy + TILE + pad) / sc), w = (ox - pad) / sc / TILE * 360 - 180, e = (ox + TILE + pad) / sc / TILE * 360 - 180;
      const ids = net.edgesIn(s, w, n, e), th = themeColors();
      const isRoad = (id) => net.eKind[id] === 0, isPcn = (id) => net.eKind[id] === 1;
      if (roads) {
        if (z >= 15) { const rw = z >= 18 ? 9 : z >= 17 ? 7 : z >= 16 ? 5 : 3.2; ctx.strokeStyle = th.casing; ctx.lineWidth = rw + 1.6; strokeEdges(ctx, ids, sc, ox, oy, isRoad); ctx.strokeStyle = th.fill; ctx.lineWidth = rw; strokeEdges(ctx, ids, sc, ox, oy, isRoad); }
        else { ctx.strokeStyle = th.road; ctx.lineWidth = z >= 14 ? 1.6 : z >= 13 ? 1.1 : 0.7; strokeEdges(ctx, ids, sc, ox, oy, isRoad); }
      }
      if (this.options.pcn) {
        if (!roads) { ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = (z >= 15 ? 3 : 2) + 2.5; strokeEdges(ctx, ids, sc, ox, oy, isPcn); }
        ctx.strokeStyle = th.pcn; ctx.lineWidth = z >= 17 ? 4 : z >= 15 ? 3 : z >= 13 ? 2 : 1.4; strokeEdges(ctx, ids, sc, ox, oy, isPcn);
      }
      if (z >= 15) drawLabels(ctx, ids, sc, ox, oy, z, th, roads);
      return cv;
    },
  });
  const offlineBase = new NetLayer({ tileSize: TILE, roads: true, pcn: true, updateWhenZooming: false, keepBuffer: 3, attribution: 'Roads © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> · Park connectors © NParks' });
  const pcnOverlay = new NetLayer({ tileSize: TILE, roads: false, pcn: true, updateWhenZooming: false, keepBuffer: 3, attribution: 'Park connectors © NParks' });
  const tileLayers = {};
  for (const [id, b] of Object.entries(CFG.basemaps)) {
    const tl = L.tileLayer(b.url, { minZoom: 11, maxZoom: 19, maxNativeZoom: b.maxZoom, attribution: b.attribution, crossOrigin: true });
    tl._stats = { load: 0, error: 0 };
    tl.on('tileload', () => { tl._stats.load++; }); tl.on('tileerror', () => { tl._stats.error++; checkTiles(tl); });
    tileLayers[id] = tl;
  }
  let activeBase = null;
  function checkTiles(tl) {
    if (tilesBlocked || tl !== activeBase) return;
    if (tl._stats.error >= 4 && tl._stats.load === 0) {
      tilesBlocked = true; setBasemap('offline', true);
      showBanner('Online map tiles cannot load here, so this is the built-in offline map of roads and park connectors.');
    }
  }
  function setBasemap(id, auto) {
    if (activeBase) map.removeLayer(activeBase);
    if (tilesBlocked && id !== 'offline') id = 'offline';
    activeBase = id === 'offline' ? offlineBase : tileLayers[id];
    activeBase.addTo(map); activeBase.bringToBack();
    if (id !== 'offline' && S.showPcn) pcnOverlay.addTo(map); else map.removeLayer(pcnOverlay);
    if (!auto) { S.basemap = id; saveSettings(); }
    renderLayersPop();
  }

  // overlays (drawing order: route under markers)
  const routePane = map.createPane('route'); routePane.style.zIndex = 450;
  const routeLayer = L.layerGroup().addTo(map), markerLayer = L.layerGroup().addTo(map), wpLayer = L.layerGroup().addTo(map), miscLayer = L.layerGroup().addTo(map);

  // ---------------- tools & pointer input ----------------
  const mpp = () => 40075016.686 * Math.cos(map.getCenter().lat * Math.PI / 180) / (TILE * Math.pow(2, map.getZoom()));
  const tolM = (px) => Math.max(8, Math.min(300, px * mpp()));
  const COARSE = window.matchMedia('(pointer: coarse)').matches;
  const MOVE_HINT = COARSE ? 'Use two fingers to move or zoom the map.' : 'Right-drag, or hold Space and drag, to move the map.';
  const TOOL_HINT = { draw: `Draw: trace along roads and paths, then lift to add it. ${MOVE_HINT}`, erase: `Eraser: rub over the part of the route to remove. ${MOVE_HINT}`, waypoint: 'Waypoint: tap where you want a marker.' };
  function setTool(t) {
    tool = tool === t ? 'pan' : t;
    $('#toolDraw').setAttribute('aria-pressed', String(tool === 'draw'));
    $('#toolErase').setAttribute('aria-pressed', String(tool === 'erase'));
    $('#toolWaypoint').setAttribute('aria-pressed', String(tool === 'waypoint'));
    const el = map.getContainer(); el.classList.remove('tool-draw', 'tool-erase', 'tool-waypoint'); if (tool !== 'pan') el.classList.add('tool-' + tool);
    const drawing = tool === 'draw' || tool === 'erase';
    if (drawing && !spacePan) { map.dragging.disable(); el.style.touchAction = 'none'; } else { map.dragging.enable(); el.style.touchAction = drawing ? 'none' : ''; }
    showBanner(TOOL_HINT[tool] || (tilesBlocked ? 'Offline map of roads and park connectors.' : ''));
    if (editor) renderRoute();
  }
  function setSnap(v) { editor.snap = v; $('#toolSnap').setAttribute('aria-pressed', String(v)); toast(v ? 'Snap to roads and paths: on' : 'Snap off: lines go exactly where you draw', 1800); }
  function showBanner(text) { const b = $('#banner'); b.textContent = text || ''; b.hidden = !text; }

  const mapEl = map.getContainer(), pointers = new Set();
  let stroke = null, panDrag = null, spacePan = false, suppressMenu = false;
  const isDrawing = () => tool === 'draw' || tool === 'erase';
  function cancelStroke() { if (stroke) { map.removeLayer(stroke.layer); stroke = null; } }
  function finishStroke(s) {
    map.removeLayer(s.layer);
    if (s.kind === 'draw') report(editor.addTrace(s.pts, tolM(28)));
    else report(editor.erase(s.pts, tolM(18)));
  }
  mapEl.addEventListener('pointerdown', (e) => {
    pointers.add(e.pointerId);
    // Right- or middle-button drag moves the map in every mode (left button is busy drawing)
    if (e.pointerType !== 'touch' && (e.button === 2 || e.button === 1) && !stroke) {
      panDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 };
      try { mapEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      mapEl.classList.add('panning'); e.preventDefault(); return;
    }
    if (!isDrawing() || spacePan) return;
    if (pointers.size > 1) {
      // Second finger: hand the gesture to Leaflet's pinch (it pans and zooms). Keep what was already
      // drawn if it was a real stroke, drop it if it was just the first finger of the pinch landing.
      if (stroke) { const s = stroke; stroke = null; if (s.travel > 40 && s.pts.length >= 4) finishStroke(s); else map.removeLayer(s.layer); }
      return;
    }
    if ((e.pointerType === 'mouse' && e.button !== 0) || e.target.closest('.leaflet-marker-icon, .leaflet-control, .leaflet-popup')) return;
    const ll = map.mouseEventToLatLng(e);
    stroke = { id: e.pointerId, kind: tool, pts: [[ll.lat, ll.lng]], px: [e.clientX, e.clientY], travel: 0,
      layer: L.polyline([ll], tool === 'draw' ? { color: cssVar('--route'), weight: 4, opacity: .75, dashArray: '6 6', interactive: false } : { color: cssVar('--danger'), weight: Math.round(18 * 2), opacity: .25, lineCap: 'round', interactive: false }).addTo(map) };
    try { mapEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    e.preventDefault();
  });
  mapEl.addEventListener('pointermove', (e) => {
    if (panDrag && e.pointerId === panDrag.id) {
      const dx = e.clientX - panDrag.x, dy = e.clientY - panDrag.y;
      if (dx || dy) { map.panBy([-dx, -dy], { animate: false }); panDrag.x = e.clientX; panDrag.y = e.clientY; panDrag.moved += Math.abs(dx) + Math.abs(dy); }
      return;
    }
    if (!stroke || e.pointerId !== stroke.id) return;
    const step = Math.hypot(e.clientX - stroke.px[0], e.clientY - stroke.px[1]); if (step < 3) return;
    stroke.px = [e.clientX, e.clientY]; stroke.travel += step;
    const ll = map.mouseEventToLatLng(e); stroke.pts.push([ll.lat, ll.lng]); stroke.layer.addLatLng(ll);
  });
  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (panDrag && e.pointerId === panDrag.id) {
      if (panDrag.moved > 3) { suppressMenu = true; setTimeout(() => { suppressMenu = false; }, 400); }
      panDrag = null; mapEl.classList.remove('panning'); return;
    }
    if (!stroke || e.pointerId !== stroke.id) return;
    const s = stroke; stroke = null;
    if (e.type === 'pointercancel') { map.removeLayer(s.layer); return; }
    finishStroke(s);
  }
  mapEl.addEventListener('pointerup', endPointer);
  mapEl.addEventListener('pointercancel', endPointer);
  // No browser context menu on the map: right-drag is for moving it
  mapEl.addEventListener('contextmenu', (e) => { if (isDrawing() || panDrag || suppressMenu) e.preventDefault(); });
  // Hold Space to drag the map with the left button while drawing (like design apps)
  function setSpacePan(on) {
    if (spacePan === on) return; spacePan = on;
    mapEl.classList.toggle('space-pan', on);
    if (isDrawing()) { if (on) map.dragging.enable(); else map.dragging.disable(); }
  }
  window.addEventListener('blur', () => setSpacePan(false));
  map.on('click', (e) => {
    if (!editor || tool === 'draw' || tool === 'erase') return;
    if (tool === 'waypoint') { openWaypoint(null, e.latlng.lat, e.latlng.lng); return; }
    report(editor.addPoint(e.latlng.lat, e.latlng.lng, tolM(36)));
  });

  // ---------------- rendering ----------------
  const icon = (cls, html = '', size = 20) => L.divIcon({ className: '', html: `<div class="mk ${cls}">${html}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
  function renderRoute() {
    routeLayer.clearLayers(); markerLayer.clearLayers();
    const cs = editor.coords;
    if (cs.length >= 2) {
      L.polyline(cs, { pane: 'route', color: '#ffffff', weight: 9, opacity: .95, interactive: false }).addTo(routeLayer);
      L.polyline(cs, { pane: 'route', color: cssVar('--route'), weight: 5, opacity: 1, interactive: false }).addTo(routeLayer);
      // distance markers every km / mile
      const unit = S.units === 'mi' ? MI : 1000, cum = RE.geo.cumul(cs), L0 = cum[cs.length - 1];
      for (let k = 1; k * unit < L0 - unit * 0.05; k++) {
        if (L0 / unit > 60 && k % 5) continue;
        L.marker(RE.geo.pointAt(cs, cum, k * unit), { icon: icon('km', String(k)), interactive: false, keyboard: false }).addTo(markerLayer);
      }
    }
    if (cs.length) {
      const closed = cs.length > 1 && RE.geo.D(cs[0], cs[cs.length - 1]) < 5;
      // in Draw/Eraser mode the end markers must not swallow the stroke that starts on them
      const live = tool === 'pan' || tool === 'waypoint';
      const st = L.marker(cs[0], { icon: icon('start'), title: 'Start: tap for finish options', zIndexOffset: 900, interactive: live, keyboard: live }).addTo(markerLayer);
      if (live) st.on('click', () => openFinish(st.getLatLng()));
      if (cs.length > 1 && !closed) { const en = L.marker(cs[cs.length - 1], { icon: icon('end'), title: 'End: tap for finish options', zIndexOffset: 900, interactive: live, keyboard: live }).addTo(markerLayer); if (live) en.on('click', () => openFinish(en.getLatLng())); }
    }
    wpLayer.clearLayers();
    editor.wps.forEach((w, i) => {
      const m = L.marker([w.lat, w.lon], { icon: icon('wp', String(i + 1), 28), draggable: true, title: w.title, zIndexOffset: 1000 }).addTo(wpLayer);
      m.on('click', () => openWaypoint(w));
      m.on('dragend', () => { const p = m.getLatLng(); editor.updateWaypoint(w.id, { lat: p.lat, lon: p.lng }); });
    });
    $('#undoBtn').disabled = !editor.canUndo(); $('#redoBtn').disabled = !editor.canRedo();
    $('#clearBtn').disabled = !editor.coords.length && !editor.wps.length;
    renderStats();
  }

  // ---------------- stats & elevation ----------------
  let elev = null, elevTimer = 0, elevSeq = 0, elevState = 'idle';
  const elevCache = new Map();
  function renderStats() {
    const L0 = editor.distance;
    $('#statDist').innerHTML = `${fmtDist(L0)}<small>${unitLabel()}</small>`;
    const pace = S.paces[S.activity];
    $('#statTime').textContent = fmtTime(L0 / (S.units === 'mi' ? MI : 1000) * (S.units === 'mi' ? pace * MI / 1000 : pace));
    $('#statTimeLabel').textContent = `${ACT[S.activity].label} time`;
    clearTimeout(elevTimer);
    if (editor.coords.length < 2) { elev = null; elevState = 'idle'; $('#statGain').textContent = '–'; drawChart(); return; }
    elevState = 'loading'; drawChart(); elevTimer = setTimeout(fetchElevation, 600);
  }
  async function fetchElevation() {
    const seq = ++elevSeq, cs = editor.coords, { pts, dists } = RE.elevationSamples(cs, 200, 20);
    const key = RE.encode(pts);
    try {
      let vals = elevCache.get(key);
      if (!vals) {
        vals = [];
        for (let i = 0; i < pts.length; i += 100) {
          const chunk = pts.slice(i, i + 100);
          const url = `${CFG.elevationUrl}?latitude=${chunk.map(p => p[0].toFixed(5)).join(',')}&longitude=${chunk.map(p => p[1].toFixed(5)).join(',')}`;
          const ctrl = new AbortController(), to = setTimeout(() => ctrl.abort(), 8000);
          const r = await fetch(url, { signal: ctrl.signal }); clearTimeout(to);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const j = await r.json(); if (!Array.isArray(j.elevation) || j.elevation.length !== chunk.length) throw new Error('bad elevation payload');
          vals.push(...j.elevation);
        }
        elevCache.set(key, vals);
      }
      if (seq !== elevSeq) return;
      elev = { d: dists, h: vals, gl: RE.gainLoss(vals, 2) }; elevState = 'ok';
      $('#statGain').innerHTML = `${Math.round(elev.gl.gain)}<small>m</small>`;
    } catch (err) {
      if (seq !== elevSeq) return;
      elev = null; elevState = 'unavailable'; $('#statGain').textContent = '–';
    }
    drawChart();
  }
  let hoverMk = null;
  function drawChart() {
    const box = $('#chart'), msg = $('#chartMsg');
    box.querySelectorAll('svg, .tip').forEach(n => n.remove());
    if (elevState !== 'ok' || !elev) {
      msg.hidden = false;
      msg.textContent = editor && editor.coords.length >= 2
        ? (elevState === 'loading' ? 'Loading elevation…' : IN_CLAUDE ? 'Elevation is not available in this preview. It works when the site is hosted on the web.' : 'Elevation is not available right now (it needs an internet connection to Open-Meteo).')
        : 'Tap the map to start a route, or press Draw and trace it.';
      return;
    }
    msg.hidden = true;
    const W = box.clientWidth || 400, H = box.clientHeight || 70, padB = 14, padL = 30;
    const { d, h } = elev, Lm = d[d.length - 1] || 1, lo = Math.floor(Math.min(...h) - 2), hi = Math.ceil(Math.max(...h) + 2);
    const x = (v) => padL + (W - padL) * v / Lm, y = (v) => (H - padB) - (H - padB - 4) * (v - lo) / Math.max(1, hi - lo);
    let line = ''; h.forEach((v, i) => { line += `${i ? 'L' : 'M'}${x(d[i]).toFixed(1)},${y(v).toFixed(1)}`; });
    const area = `${line}L${x(Lm).toFixed(1)},${H - padB}L${padL},${H - padB}Z`;
    const route = cssVar('--route'), muted = cssVar('--muted'), lineC = cssVar('--line');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Elevation from ${Math.round(Math.min(...h))} to ${Math.round(Math.max(...h))} m; climb ${Math.round(elev.gl.gain)} m`);
    svg.innerHTML = `<line x1="${padL}" y1="${H - padB}" x2="${W}" y2="${H - padB}" stroke="${lineC}"/>`
      + `<path d="${area}" fill="${route}" fill-opacity=".16"/><path d="${line}" fill="none" stroke="${route}" stroke-width="2"/>`
      + `<text x="${padL - 4}" y="${y(hi) + 8}" text-anchor="end" font-size="10" fill="${muted}">${hi} m</text>`
      + `<text x="${padL - 4}" y="${H - padB}" text-anchor="end" font-size="10" fill="${muted}">${lo} m</text>`
      + `<text x="${W}" y="${H - 2}" text-anchor="end" font-size="10" fill="${muted}">${fmtDist(Lm, 1)} ${unitLabel()}</text>`
      + `<line id="cx" x1="0" x2="0" y1="0" y2="${H - padB}" stroke="${muted}" stroke-dasharray="3 3" visibility="hidden"/>`;
    box.appendChild(svg);
    const tip = document.createElement('div'); tip.className = 'tip'; tip.hidden = true; box.appendChild(tip);
    const cum = RE.geo.cumul(editor.coords);
    const move = (ev) => {
      const r = svg.getBoundingClientRect(), px = (ev.clientX - r.left) * W / r.width, dd = Math.max(0, Math.min(Lm, (px - padL) / (W - padL) * Lm));
      let i = 0; while (i < d.length - 1 && d[i + 1] < dd) i++;
      const u = d[i + 1] > d[i] ? (dd - d[i]) / (d[i + 1] - d[i]) : 0, hv = h[i] + u * ((h[i + 1] ?? h[i]) - h[i]);
      const cx = svg.querySelector('#cx'); cx.setAttribute('x1', x(dd)); cx.setAttribute('x2', x(dd)); cx.setAttribute('visibility', 'visible');
      tip.hidden = false; tip.style.left = `${x(dd) / W * 100}%`; tip.textContent = `${fmtDist(dd)} ${unitLabel()} · ${Math.round(hv)} m`;
      const p = RE.geo.pointAt(editor.coords, cum, dd);
      if (!hoverMk) hoverMk = L.marker(p, { icon: icon('hover', '', 14), interactive: false, keyboard: false }).addTo(miscLayer); else hoverMk.setLatLng(p);
    };
    const leave = () => { tip.hidden = true; svg.querySelector('#cx').setAttribute('visibility', 'hidden'); if (hoverMk) { miscLayer.removeLayer(hoverMk); hoverMk = null; } };
    svg.addEventListener('pointermove', move); svg.addEventListener('pointerdown', move); svg.addEventListener('pointerleave', leave);
  }

  // ---------------- search ----------------
  let nameIndex = [];
  function buildNameIndex() {
    const byName = new Map();
    for (let e = 0; e < net.E; e++) {
      const n = net.nameOf(e); if (!n || net.eKind[e] === 2) continue;
      let r = byName.get(n); const b = e * 4;
      if (!r) byName.set(n, r = { name: n, kind: net.eKind[e], s: 90, w: 180, n: -90, e: -180, low: n.toLowerCase() });
      r.s = Math.min(r.s, net.bbox[b]); r.w = Math.min(r.w, net.bbox[b + 1]); r.n = Math.max(r.n, net.bbox[b + 2]); r.e = Math.max(r.e, net.bbox[b + 3]);
    }
    nameIndex = Array.from(byName.values());
  }
  let searchOnline = !IN_CLAUDE, searchTimer = 0, searchSeq = 0, results = [];
  function localSearch(q) {
    const toks = q.toLowerCase().split(/\s+/).filter(Boolean); if (!toks.length) return [];
    return nameIndex.filter(r => toks.every(t => r.low.includes(t)))
      .sort((a, b) => (b.low.startsWith(toks[0]) - a.low.startsWith(toks[0])) || a.name.length - b.name.length).slice(0, 6)
      .map(r => ({ title: r.name, detail: r.kind === 1 ? 'Park connector' : 'Street', bounds: [[r.s, r.w], [r.n, r.e]] }));
  }
  const titleCase = (s) => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
  async function onlineSearch(q, seq) {
    if (!searchOnline || q.length < 3) return;
    try {
      const r = await fetch(`${CFG.searchUrl}?searchVal=${encodeURIComponent(q)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`);
      if (!r.ok) throw new Error(r.status); const j = await r.json(); if (seq !== searchSeq) return;
      const extra = (j.results || []).slice(0, 6).map(x => ({ title: titleCase(x.SEARCHVAL || x.BUILDING || x.ADDRESS), detail: titleCase(x.ADDRESS || ''), point: [+x.LATITUDE, +x.LONGITUDE] }))
        .filter(x => isFinite(x.point[0]) && isFinite(x.point[1]));
      results = results.concat(extra).slice(0, 10); renderResults();
    } catch (err) { searchOnline = false; }
  }
  function renderResults() {
    const box = $('#results'); box.textContent = '';
    box.hidden = !results.length;
    results.forEach((r, i) => {
      const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'option'); b.id = 'res' + i;
      b.innerHTML = `<span class="t">${esc(r.title)}</span><span class="d">${esc(r.detail)}</span>`;
      b.addEventListener('click', () => pickResult(r)); box.appendChild(b);
    });
  }
  let searchPin = null;
  function pickResult(r) {
    $('#results').hidden = true; $('#search').value = r.title; $('#search').blur();
    if (searchPin) miscLayer.removeLayer(searchPin);
    if (r.bounds) map.fitBounds(r.bounds, { maxZoom: 17, padding: [40, 40] });
    else { map.setView(r.point, 17); searchPin = L.marker(r.point, { title: r.title }).addTo(miscLayer); searchPin.bindTooltip(r.title, { permanent: false }); }
  }

  // ---------------- popovers ----------------
  function placePop(pop, anchorEl, point) {
    pop.hidden = false; const pw = pop.offsetWidth, ph = pop.offsetHeight, W = window.innerWidth, H = window.innerHeight;
    let x, y;
    if (point) { const p = map.latLngToContainerPoint(point); x = p.x - pw / 2; y = p.y - ph - 18; if (y < 10) y = p.y + 18; }
    else { const r = anchorEl.getBoundingClientRect(); x = r.right - pw; y = r.top - ph - 8; if (y < 10) y = r.bottom + 8; }
    pop.style.left = `${Math.max(8, Math.min(W - pw - 8, x))}px`; pop.style.top = `${Math.max(8, Math.min(H - ph - 8, y))}px`;
  }
  function closePops() { $('#layersPop').hidden = true; $('#finishPop').hidden = true; }
  function renderLayersPop() {
    const pop = $('#layersPop'); pop.textContent = '';
    const h = document.createElement('h4'); h.textContent = 'Map'; pop.appendChild(h);
    const opts = Object.entries(CFG.basemaps).map(([id, b]) => [id, b.label]).concat([['offline', 'Offline (roads + park connectors)']]);
    for (const [id, label] of opts) {
      const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'menuitemradio');
      const on = (activeBase === offlineBase ? 'offline' : Object.keys(tileLayers).find(k => tileLayers[k] === activeBase)) === id;
      b.setAttribute('aria-checked', String(on)); b.textContent = label;
      if (tilesBlocked && id !== 'offline') { b.disabled = true; b.title = 'Online tiles cannot load here'; b.style.opacity = .45; }
      b.addEventListener('click', () => { setBasemap(id); closePops(); }); pop.appendChild(b);
    }
    const sep = document.createElement('div'); sep.className = 'sep'; pop.appendChild(sep);
    const pc = document.createElement('button'); pc.type = 'button'; pc.setAttribute('role', 'menuitemcheckbox'); pc.setAttribute('aria-checked', String(S.showPcn)); pc.textContent = 'Park connectors';
    pc.addEventListener('click', () => { S.showPcn = !S.showPcn; $('#showPcn').checked = S.showPcn; saveSettings(); setBasemap(activeBase === offlineBase ? 'offline' : S.basemap, true); });
    pop.appendChild(pc);
  }
  function openFinish(point) {
    const pop = $('#finishPop'); pop.textContent = '';
    const h = document.createElement('h4'); h.textContent = 'Finish route'; pop.appendChild(h);
    const add = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'menuitem'); b.textContent = label; b.addEventListener('click', () => { closePops(); report(fn()); }); pop.appendChild(b); };
    add('Out & back (retrace to the start)', () => editor.outAndBack());
    add('Close the loop (route back to the start)', () => editor.closeLoop());
    add('Reverse direction', () => editor.reverse());
    const sep = document.createElement('div'); sep.className = 'sep'; pop.appendChild(sep);
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = `<label for="trimKm" class="small">Trim to</label><input id="trimKm" type="number" min="0.1" step="0.1" inputmode="decimal" value="${(editor.distance / (S.units === 'mi' ? MI : 1000) / 2).toFixed(1)}"><span class="small">${unitLabel()}</span><button type="button" class="btn">Trim</button>`;
    row.querySelector('button').addEventListener('click', () => { const v = parseFloat(row.querySelector('input').value); closePops(); report(editor.trim(v * (S.units === 'mi' ? MI : 1000))); });
    pop.appendChild(row);
    placePop(pop, $('#finishBtn'), point);
    pop.querySelector('button').focus();
  }

  // ---------------- waypoints ----------------
  let wpEditing = null;
  function openWaypoint(w, lat, lon) {
    wpEditing = w ? { id: w.id } : { lat, lon };
    $('#wpTitle').textContent = w ? 'Edit waypoint' : 'New waypoint';
    $('#wpName').value = w ? w.title : `Waypoint ${editor.wps.length + 1}`; $('#wpNotes').value = w ? (w.notes || '') : '';
    $('#wpDelete').hidden = !w;
    $('#wpDialog').showModal(); $('#wpName').select();
  }
  $('#wpForm').addEventListener('submit', (ev) => {
    ev.preventDefault(); const title = $('#wpName').value.trim() || 'Waypoint', notes = $('#wpNotes').value.trim();
    if (wpEditing.id) editor.updateWaypoint(wpEditing.id, { title, notes }); else editor.addWaypoint(wpEditing.lat, wpEditing.lon, title, notes);
    $('#wpDialog').close();
  });
  $('#wpCancel').addEventListener('click', () => $('#wpDialog').close());
  $('#wpDelete').addEventListener('click', () => { if (wpEditing && wpEditing.id) editor.removeWaypoint(wpEditing.id); $('#wpDialog').close(); });

  // ---------------- drawer: saved routes, import/export/share, settings ----------------
  function openDrawer() { $('#drawer').classList.add('open'); $('#scrim').hidden = false; $('#menuBtn').setAttribute('aria-expanded', 'true'); renderSaved(); }
  function closeDrawer() { $('#drawer').classList.remove('open'); $('#scrim').hidden = true; $('#menuBtn').setAttribute('aria-expanded', 'false'); }
  function renderSaved() {
    const box = $('#savedList'); box.textContent = '';
    const list = store.list().slice().sort((a, b) => (b.updated || 0) - (a.updated || 0));
    if (!list.length) { const p = document.createElement('p'); p.className = 'small'; p.textContent = store.loading ? 'Loading saved routes…' : 'No saved routes yet.'; box.appendChild(p); }
    for (const r of list) {
      const it = document.createElement('div'); it.className = 'item';
      it.innerHTML = `<button type="button" class="open"><span class="t"></span><span class="d"></span></button><span class="acts"><button type="button" data-a="del">Delete</button></span>`;
      it.querySelector('.t').textContent = r.name;
      it.querySelector('.d').textContent = `${fmtDist(r.distance || 0)} ${unitLabel()} · ${new Date(r.updated || r.created || Date.now()).toLocaleDateString()}`;
      it.querySelector('.open').addEventListener('click', () => { loadRoute(RE.decode(r.poly), r.wps || []); closeDrawer(); toast(`Opened ${r.name}`); });
      it.querySelector('[data-a="del"]').addEventListener('click', async () => { try { await store.remove(r); toast('Deleted'); } catch (e) { toast('Could not delete. Try again.'); } });
      box.appendChild(it);
    }
    $('#storeNote').textContent = store.cloud ? 'Saved to your Claude account, so they appear on your other devices.' : 'Saved in this browser.';
  }
  function loadRoute(coords, wps) {
    editor.load(coords, wps.map(w => ({ lat: w.lat, lon: w.lon, title: w.title || 'Waypoint', notes: w.notes || '' })));
    fitRoute();
  }
  function fitRoute() {
    const pts = editor.coords.concat(editor.wps.map(w => [w.lat, w.lon])); if (!pts.length) return;
    if (pts.length === 1) { map.setView(pts[0], 16); return; }
    map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [70, 120], paddingBottomRight: [70, 170], maxZoom: 17 });
  }
  $('#saveBtn').addEventListener('click', () => {
    if (editor.coords.length < 2) { toast('Draw a route first'); return; }
    $('#saveName').value = `${ACT[S.activity].label.replace(/ing$/, '')} ${fmtDist(editor.distance, 1)} ${unitLabel()}`; $('#saveDialog').showModal(); $('#saveName').select();
  });
  $('#saveCancel').addEventListener('click', () => $('#saveDialog').close());
  $('#saveForm').addEventListener('submit', async (ev) => {
    ev.preventDefault(); const name = $('#saveName').value.trim() || 'My route'; $('#saveDialog').close();
    const now = Date.now(), r = { id: 'r' + now.toString(36), kind: 'route', name, poly: RE.encode(editor.coords), wps: editor.wps.map(({ lat, lon, title, notes }) => ({ lat: +lat.toFixed(6), lon: +lon.toFixed(6), title, notes })), distance: Math.round(editor.distance), activity: S.activity, created: now, updated: now };
    try { const where = await store.save(r); toast(where === 'cloud' ? `Saved “${name}” to your account` : `Saved “${name}” in this browser`); renderSaved(); }
    catch (e) { toast(e.message || 'Could not save'); }
  });
  function gpxText() {
    const name = $('#saveName').value.trim() || `Route ${fmtDist(editor.distance)} ${unitLabel()}`;
    const x = (s) => esc(s);
    const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<gpx version="1.1" creator="Jalan Route Planner" xmlns="http://www.topografix.com/GPX/1/1">', `  <metadata><name>${x(name)}</name></metadata>`];
    for (const w of editor.wps) lines.push(`  <wpt lat="${w.lat.toFixed(7)}" lon="${w.lon.toFixed(7)}"><name>${x(w.title)}</name>${w.notes ? `<desc>${x(w.notes)}</desc>` : ''}</wpt>`);
    lines.push('  <trk>', `    <name>${x(name)}</name>`, '    <trkseg>');
    for (const c of RC.densify(editor.coords, 10)) lines.push(`      <trkpt lat="${c[0].toFixed(7)}" lon="${c[1].toFixed(7)}"/>`);
    lines.push('    </trkseg>', '  </trk>', '</gpx>', '');
    return { name, text: lines.join('\n') };
  }
  let downloads = null;
  $('#exportBtn').addEventListener('click', async () => {
    if (editor.coords.length < 2) { toast('Draw a route first'); return; }
    const { name, text } = gpxText(), file = name.replace(/[^\w.-]+/g, '_') || 'route';
    if (IN_CLAUDE) {
      if (!downloads) { try { await navigator.clipboard.writeText(text); toast('Saving files is not available here, so the GPX was copied instead.'); } catch (e) { toast('Exporting is not available in this view.'); } return; }
      try { await downloads.save({ filename: file + '.zip', data: RC.zipOne(file + '.gpx', text) }); toast('Saved as a .zip: open it to get the .gpx file.', 4500); }
      catch (e) { toast(e && e.code === 'declined' ? 'Not saved' : 'Saving files is not available here.'); }
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'application/gpx+xml' }));
    const a = document.createElement('a'); a.href = url; a.download = file + '.gpx'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000); toast('GPX downloaded');
  });
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (ev) => { const f = ev.target.files[0]; if (f) await importFile(f); ev.target.value = ''; });
  function parseGpxDom(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('That file is not valid GPX.');
    const pts = Array.from(doc.querySelectorAll('trkpt, rtept')).map(p => [parseFloat(p.getAttribute('lat')), parseFloat(p.getAttribute('lon'))]).filter(p => isFinite(p[0]) && isFinite(p[1]));
    const wps = Array.from(doc.querySelectorAll('wpt')).map(w => ({ lat: parseFloat(w.getAttribute('lat')), lon: parseFloat(w.getAttribute('lon')), title: (w.querySelector('name') || {}).textContent || 'Waypoint', notes: (w.querySelector('desc') || {}).textContent || '' })).filter(w => isFinite(w.lat) && isFinite(w.lon));
    const name = (doc.querySelector('metadata > name, trk > name, rte > name') || {}).textContent || '';
    return { pts, wps, name };
  }
  async function importFile(f) {
    try {
      const g = parseGpxDom(await f.text());
      if (!g.pts.length && !g.wps.length) { toast('No track, route or waypoints found in that file.'); return; }
      loadRoute(g.pts, g.wps); closeDrawer(); toast(`Opened ${g.name || f.name}: ${fmtDist(editor.distance)} ${unitLabel()}`);
    } catch (e) { toast(e.message || 'Could not read that file.'); }
  }
  // drag & drop a GPX anywhere
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) { dragDepth++; $('#dropzone').hidden = false; e.preventDefault(); } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropzone').hidden = true; });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => { e.preventDefault(); dragDepth = 0; $('#dropzone').hidden = true; const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) await importFile(f); });
  $('#shareBtn').hidden = IN_CLAUDE;
  $('#shareBtn').addEventListener('click', async () => {
    if (editor.coords.length < 2) { toast('Draw a route first'); return; }
    const link = `${location.href.split('#')[0]}#route=${RE.toShare(editor.coords, editor.wps)}`;
    try { await navigator.clipboard.writeText(link); toast('Share link copied'); } catch (e) { history.replaceState(null, '', link); toast('Copy the link from the address bar'); }
  });
  $('#exportNote').textContent = IN_CLAUDE ? 'Here, Export saves a .zip with the .gpx inside (or copies the GPX text).' : '';

  // settings
  function syncSettings() {
    $('#units').value = S.units; $('#showPcn').checked = S.showPcn; $('#preferPcn').checked = S.preferPcn; $('#avoidClosures').checked = S.avoidClosures;
    $('#activity').value = S.activity; $('#paceAct').textContent = ACT[S.activity].label.toLowerCase(); $('#paceUnit').textContent = unitLabel();
    $('#pace').value = fmtPace(S.units === 'mi' ? S.paces[S.activity] * MI / 1000 : S.paces[S.activity]);
  }
  $('#units').addEventListener('change', (e) => { S.units = e.target.value; saveSettings(); syncSettings(); renderRoute(); });
  $('#activity').addEventListener('change', (e) => { S.activity = e.target.value; saveSettings(); syncSettings(); renderStats(); });
  $('#pace').addEventListener('change', (e) => {
    const v = parsePace(e.target.value); if (!v) { toast('Pace looks like 5:30 (minutes:seconds)'); syncSettings(); return; }
    S.paces[S.activity] = S.units === 'mi' ? v * 1000 / MI : v; saveSettings(); syncSettings(); renderStats();
  });
  $('#showPcn').addEventListener('change', (e) => { S.showPcn = e.target.checked; saveSettings(); setBasemap(activeBase === offlineBase ? 'offline' : S.basemap, true); });
  $('#preferPcn').addEventListener('change', (e) => { S.preferPcn = e.target.checked; router.pcnFactor = S.preferPcn ? 0.8 : 1; saveSettings(); });
  $('#avoidClosures').addEventListener('change', (e) => { S.avoidClosures = e.target.checked; router.avoidClosures = S.avoidClosures; saveSettings(); });

  // ---------------- map controls ----------------
  $('#zoomIn').addEventListener('click', () => map.zoomIn());
  $('#zoomOut').addEventListener('click', () => map.zoomOut());
  $('#layersBtn').addEventListener('click', () => { const p = $('#layersPop'); if (!p.hidden) { closePops(); return; } closePops(); renderLayersPop(); placePop(p, $('#layersBtn')); });
  $('#finishBtn').addEventListener('click', () => { if (!$('#finishPop').hidden) { closePops(); return; } if (editor.coords.length < 2) { toast('Draw a route first'); return; } closePops(); openFinish(null); });
  let meMk = null, meCircle = null;
  $('#locateBtn').addEventListener('click', () => {
    if (!navigator.geolocation) { toast('Location is not available in this browser'); return; }
    navigator.geolocation.getCurrentPosition((p) => {
      const ll = [p.coords.latitude, p.coords.longitude];
      if (meMk) { miscLayer.removeLayer(meMk); miscLayer.removeLayer(meCircle); }
      meCircle = L.circle(ll, { radius: p.coords.accuracy, color: '#2563eb', weight: 1, fillOpacity: .1, interactive: false }).addTo(miscLayer);
      meMk = L.marker(ll, { icon: icon('me', '', 18), interactive: false }).addTo(miscLayer); map.setView(ll, Math.max(map.getZoom(), 16));
    }, (err) => toast(err.code === 1 ? 'Location permission was refused' : 'Could not get your location'), { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  });
  $('#toolDraw').addEventListener('click', () => setTool('draw'));
  $('#toolErase').addEventListener('click', () => setTool('erase'));
  $('#toolWaypoint').addEventListener('click', () => setTool('waypoint'));
  $('#toolSnap').addEventListener('click', () => setSnap(!editor.snap));
  $('#undoBtn').addEventListener('click', () => report(editor.undo()));
  $('#redoBtn').addEventListener('click', () => report(editor.redo()));
  $('#clearBtn').addEventListener('click', () => { if (report(editor.clear()).ok) toast('Cleared. Undo brings it back.'); });
  $('#menuBtn').addEventListener('click', openDrawer); $('#closeDrawer').addEventListener('click', closeDrawer); $('#scrim').addEventListener('click', closeDrawer);
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.popover, #layersBtn, #finishBtn, .leaflet-marker-icon')) closePops(); if (!e.target.closest('#searchCard')) $('#results').hidden = true; });

  // search box
  $('#search').addEventListener('input', (e) => {
    const q = e.target.value.trim(); const seq = ++searchSeq; results = net ? localSearch(q) : []; renderResults();
    clearTimeout(searchTimer); searchTimer = setTimeout(() => onlineSearch(q, seq), 350);
  });
  $('#search').addEventListener('keydown', (e) => { if (e.key === 'Enter' && results.length) { e.preventDefault(); pickResult(results[0]); } if (e.key === 'Escape') { $('#results').hidden = true; e.target.blur(); } });
  $('#search').addEventListener('focus', () => { if (results.length) $('#results').hidden = false; });

  // ---------------- keyboard ----------------
  let shiftAlone = false;
  const typing = (t) => t && (t.closest('input, textarea, select, [contenteditable="true"]') || document.querySelector('dialog[open]'));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Shift') shiftAlone = false;
    if (typing(e.target) || !editor) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); report(e.shiftKey ? editor.redo() : editor.undo()); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); report(editor.redo()); return; }
    if (mod || e.altKey) return;
    if (e.key === ' ' && isDrawing()) { e.preventDefault(); if (document.activeElement && document.activeElement.tagName === 'BUTTON') document.activeElement.blur(); if (!e.repeat) setSpacePan(true); return; }
    if (e.key === 'Shift') { shiftAlone = true; return; }
    if (e.key === 'Enter') { if (e.target.closest('button, a, summary')) return; e.preventDefault(); setTool('draw'); }
    else if (e.key.toLowerCase() === 'e') setTool('erase');
    else if (e.key.toLowerCase() === 'k') setTool('waypoint');
    else if (e.key === 'Escape') { closePops(); closeDrawer(); if (tool !== 'pan') setTool(tool); }
    else if (e.key === '+' || e.key === '=') map.zoomIn();
    else if (e.key === '-' || e.key === '_') map.zoomOut();
  });
  document.addEventListener('keyup', (e) => { if (e.key === ' ') { if (spacePan) e.preventDefault(); setSpacePan(false); } if (e.key === 'Shift' && shiftAlone && !typing(e.target) && editor) setSnap(!editor.snap); shiftAlone = false; });

  // theme changes repaint canvas tiles and the route colours
  const repaint = () => { offlineBase.redraw(); pcnOverlay.redraw(); if (editor) renderRoute(); };
  const mq = window.matchMedia('(prefers-color-scheme: dark)'); if (mq.addEventListener) mq.addEventListener('change', repaint);
  new MutationObserver(repaint).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.addEventListener('resize', () => { if (elevState === 'ok') drawChart(); });

  // ---------------- optional claude.ai page capabilities ----------------
  async function initCapabilities() {
    if (!IN_CLAUDE) return;
    try { downloads = await window.claude.use('downloads'); } catch (e) { downloads = null; }
    let db = null, user = null;
    try { [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]); } catch (e) { return; }
    if (!db || !user) return;
    let id = null; try { id = await user.id(); } catch (e) { id = null; } if (!id) return;
    store.cloud = db.collection('data/users/' + id); store.loading = true; renderSaved();
    const timer = setTimeout(() => { if (store.loading) { store.loading = false; renderSaved(); } }, 10000);
    store.cloud.onSnapshot((snap) => {
      store.routes = snap.docs.map(d => Object.assign({}, d.data(), { id: d.id, _cloud: true })).filter(r => r.kind === 'route');
      if (!snap.metadata.fromCache) { store.loading = false; clearTimeout(timer); }
      renderSaved();
    }, () => { clearTimeout(timer); store.cloud = null; store.loading = false; renderSaved(); });
  }

  // ---------------- boot ----------------
  async function boot() {
    syncSettings();
    setBasemap(IN_CLAUDE ? 'offline' : (S.basemap in tileLayers || S.basemap === 'offline' ? S.basemap : 'street'), true);
    if (IN_CLAUDE) { tilesBlocked = true; renderLayersPop(); }
    try {
      const r = await fetch(CFG.networkUrl); if (!r.ok) throw new Error(r.status);
      net = RC.Network.fromText(await r.text());
    } catch (e) { $('#loading').textContent = 'The map data did not load. Check your connection and reload the page.'; return; }
    PX = new Float64Array(net.lat.length); PY = new Float64Array(net.lat.length);
    for (let i = 0; i < net.lat.length; i++) { PX[i] = (net.lon[i] + 180) / 360 * TILE; PY[i] = merc(net.lat[i]); }
    for (const e of net.setBlockedFromPolygons([OFFICIAL_CLOSURE], [1, 2])) net.blocked[e] = 1;
    router = new RE.Router(net); router.pcnFactor = S.preferPcn ? 0.8 : 1; router.avoidClosures = S.avoidClosures;
    editor = new RE.RouteEditor(router);
    let draftT = 0;
    editor.onChange(() => { renderRoute(); clearTimeout(draftT); draftT = setTimeout(() => lsSet('draft', { poly: RE.encode(editor.coords), wps: editor.wps }), 400); });
    buildNameIndex();
    offlineBase.redraw(); pcnOverlay.redraw();
    // open: shared link > last draft > example
    let opened = false;
    const m = /^#route=([\w-]+)$/.exec(location.hash);
    if (m) { try { const s = RE.fromShare(m[1]); loadRoute(s.coords, s.wps); opened = true; toast('Opened a shared route'); } catch (e) { toast('That share link is damaged'); } }
    const draft = lsGet('draft', null);
    if (!opened && draft && draft.poly) { const cs = RE.decode(draft.poly); if (cs.length) { loadRoute(cs, draft.wps || []); opened = true; } }
    if (!opened) {
      editor.addPoint(...EXAMPLE.taps[0], 100); for (const t of EXAMPLE.taps.slice(1)) editor.addPoint(...t, 100);
      editor.outAndBack(); editor.past = []; editor.future = []; renderRoute(); fitRoute();
      toast('Example route loaded. Press the bin to clear it and start your own.', 5000);
    }
    $('#loading').hidden = true;
    if (tilesBlocked) showBanner('Offline map of roads and park connectors.');
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { offlineBase.redraw(); pcnOverlay.redraw(); });
    initCapabilities();
  }
  window.__jalan = { map, get editor() { return editor; }, get router() { return router; }, get tilesBlocked() { return tilesBlocked; }, get tool() { return tool; } };  // for automated tests
  boot();
})();
