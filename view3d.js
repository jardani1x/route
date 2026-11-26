/* View3D — a tilted 3D view of the route among the buildings around it.
 * Drawing and editing stay on the flat Leaflet map; this view only shows the current route. It uses
 * MapLibre GL JS (vendor/maplibre, loaded the first time the view opens) and OpenFreeMap vector tiles,
 * whose OpenStreetMap buildings carry heights (from the height or building:levels tags; a building
 * without either is drawn low). Needs WebGL and an internet connection. */
(function (root) {
  'use strict';
  const BLD = 'jalan-buildings', ROUTE = 'jalan-route', SRC = 'jalan-route', PTS = 'jalan-points';
  let loading = null;

  function webglOK() {
    try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; }
  }
  function loadLib(base) {
    if (root.maplibregl) return Promise.resolve(root.maplibregl);
    if (loading) return loading;
    const add = (tag, attrs) => new Promise((res, rej) => {
      const el = Object.assign(document.createElement(tag), attrs);
      el.onload = res; el.onerror = () => rej(new Error('could not load ' + (attrs.src || attrs.href)));
      document.head.appendChild(el);
    });
    loading = Promise.all([add('link', { rel: 'stylesheet', href: base + 'maplibre-gl.css' }), add('script', { src: base + 'maplibre-gl.js' })])
      .then(() => root.maplibregl).catch((e) => { loading = null; throw e; });
    return loading;
  }

  /**
   * opts: container (element), lib (folder with maplibre-gl.js/.css), styles {light, dark}, attribution (html),
   *       isDark(), colors() -> {route, casing, start, end, waypoint, buildingLow, buildingHigh},
   *       onError(message) for problems worth telling the person about once.
   */
  function View3D(opts) {
    let map = null, data = { coords: [], wps: [] }, dark = null, warned = false;

    const lngLat = (p) => [p[1], p[0]];
    function geo() {
      const f = [];
      if (data.coords.length >= 2) f.push({ type: 'Feature', properties: { k: 'line' }, geometry: { type: 'LineString', coordinates: data.coords.map(lngLat) } });
      if (data.coords.length) {
        f.push({ type: 'Feature', properties: { k: 'start' }, geometry: { type: 'Point', coordinates: lngLat(data.coords[0]) } });
        if (data.coords.length >= 2) f.push({ type: 'Feature', properties: { k: 'end' }, geometry: { type: 'Point', coordinates: lngLat(data.coords[data.coords.length - 1]) } });
      }
      for (const w of data.wps) f.push({ type: 'Feature', properties: { k: 'wp' }, geometry: { type: 'Point', coordinates: [w.lon, w.lat] } });
      return { type: 'FeatureCollection', features: f };
    }

    /** Our layers on top of whichever base style is loaded: height-tinted buildings and the route. */
    function addLayers() {
      const c = opts.colors(), st = map.getStyle();
      // the base style's own 3D buildings (liberty has some) give way to ours
      for (const l of st.layers) if (l.type === 'fill-extrusion' && l.id !== BLD) map.removeLayer(l.id);
      const firstLabel = (st.layers.find((l) => l.type === 'symbol') || {}).id;
      if (st.sources.openmaptiles && !map.getLayer(BLD)) {
        map.addLayer({
          id: BLD, type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 13,
          filter: ['!=', ['get', 'hide_3d'], true],
          paint: {
            'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 0], 0, c.buildingLow, 60, c.buildingHigh],
            // rise from the ground as you zoom in, so zooming out does not leave a forest of spikes
            'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.5, ['coalesce', ['get', 'render_height'], 0]],
            'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.5, ['coalesce', ['get', 'render_min_height'], 0]],
            'fill-extrusion-opacity': 0.88,
          },
        }, firstLabel);
      }
      if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: geo() });
      // the route is drawn last, so blocks never hide it
      if (!map.getLayer(ROUTE + '-casing')) map.addLayer({ id: ROUTE + '-casing', type: 'line', source: SRC, filter: ['==', ['get', 'k'], 'line'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': c.casing, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 5, 17, 11] } });
      if (!map.getLayer(ROUTE)) map.addLayer({ id: ROUTE, type: 'line', source: SRC, filter: ['==', ['get', 'k'], 'line'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': c.route, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 3, 17, 7] } });
      if (!map.getLayer(PTS)) map.addLayer({ id: PTS, type: 'circle', source: SRC, filter: ['!=', ['get', 'k'], 'line'],
        paint: { 'circle-radius': ['match', ['get', 'k'], 'wp', 6, 8], 'circle-color': ['match', ['get', 'k'], 'start', c.start, 'end', c.end, c.waypoint], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5, 'circle-pitch-alignment': 'map' } });
    }

    function styleUrl() { return opts.isDark() ? opts.styles.dark : opts.styles.light; }

    async function open(view, route) {
      if (!webglOK()) throw new Error('The 3D view needs WebGL, which this browser has turned off.');
      const gl = await loadLib(opts.lib);
      data = route;
      const center = [view.center[1], view.center[0]], zoom = Math.max(13.5, view.zoom - 1);   // Leaflet 256 px tiles -> MapLibre 512 px
      const calm = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!map) {
        dark = opts.isDark();
        map = new gl.Map({
          container: opts.container, style: styleUrl(), center, zoom, pitch: 0, bearing: 0, maxPitch: 75, attributionControl: false,
        });
        // compass only (tap to face north and flatten); the page's own zoom buttons work in 3D too
        map.addControl(new gl.NavigationControl({ showZoom: false, visualizePitch: true }), 'top-left');
        map.addControl(new gl.AttributionControl({ compact: true, customAttribution: opts.attribution }), 'top-right');
        map.on('style.load', addLayers);
        map.on('error', (e) => {
          if (warned) return; warned = true;
          const msg = (e && e.error && (e.error.message || e.error.status)) || 'unknown error';
          if (opts.onError) opts.onError(`Parts of the 3D map could not load (${msg}). It needs a connection to OpenFreeMap.`);
        });
        // offline, the style never loads and 'load' never fires: go on after an error or 12 s
        await new Promise((res) => { if (map.loaded()) return res(); map.once('load', res); map.once('error', res); setTimeout(res, 12000); });
      } else {
        map.resize();
        if (dark !== opts.isDark()) { dark = opts.isDark(); map.setStyle(styleUrl()); }   // style.load re-adds our layers
        else update(route);
        map.jumpTo({ center, zoom, pitch: 0, bearing: 0 });
      }
      map.easeTo({ pitch: 60, bearing: -20, duration: calm ? 0 : 900 });
    }

    function update(route) {
      data = route;
      const s = map && map.getSource(SRC); if (s) s.setData(geo());
    }

    /** Where the 3D camera is looking, for the flat map to pick up (Leaflet zoom). */
    function view() {
      const c = map.getCenter(); return { center: [c.lat, c.lng], zoom: map.getZoom() + 1 };
    }
    function zoomBy(d) { if (map) map.easeTo({ zoom: map.getZoom() + d, duration: 250 }); }
    function themeChanged() { if (map && dark !== opts.isDark()) { dark = opts.isDark(); map.setStyle(styleUrl()); } }

    return { open, update, view, zoomBy, themeChanged, get map() { return map; }, get failed() { return warned; } };
  }
  View3D.webglOK = webglOK;
  root.View3D = View3D;
})(typeof self !== 'undefined' ? self : this);
