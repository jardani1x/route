/* Jalan Route Planner — endpoints. Edit here when self-hosting.
 * Every online service is optional: without them the planner draws its own offline map
 * of Singapore's roads and park connectors and still routes, measures, saves and exports. */
window.RP_CONFIG = {
  basemaps: {
    street: {
      label: 'Street (OneMap)',
      url: 'https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png',
      minZoom: 11, maxZoom: 19,
      attribution: '<a href="https://www.onemap.gov.sg/" target="_blank" rel="noopener">OneMap</a> © contributors | <a href="https://www.sla.gov.sg/" target="_blank" rel="noopener">Singapore Land Authority</a>',
    },
    satellite: {
      label: 'Satellite (Esri)',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      minZoom: 3, maxZoom: 19,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    },
  },
  // Open-Meteo elevation API (Copernicus DEM, ~90 m grid): up to 100 points per request
  elevationUrl: 'https://api.open-meteo.com/v1/elevation',
  // OneMap address search (no key needed)
  searchUrl: 'https://www.onemap.gov.sg/api/common/elastic/search',
  // Walk network, tried in order. The first two are rebuilt monthly from OpenStreetMap by
  // .github/workflows/build-network.yml (streets, pavements, footpaths, park connectors): the compact binary
  // (1.4 MB; needs a browser that can unpack .gz) and the same network as JSON (4.3 MB). net.json is the older
  // roads-and-park-connectors network kept as a last resort.
  networkUrls: ['https://raw.githubusercontent.com/jardani1x/route/data/network-v2/data/net-v3.bin.gz',
    'https://raw.githubusercontent.com/jardani1x/route/data/network-v2/data/net-v2.json', 'net.json'],
  closuresUrl: 'closures.json',
  center: [1.3521, 103.8198],
  zoom: 12,
  // 3D view (MapLibre GL JS, loaded on first use from vendor/maplibre): OpenFreeMap vector tiles, free and
  // keyless, with OpenStreetMap building heights. Offered as-is by OpenFreeMap and may change.
  map3d: {
    lib: 'vendor/maplibre/',
    styles: { light: 'https://tiles.openfreemap.org/styles/liberty', dark: 'https://tiles.openfreemap.org/styles/dark' },
    attribution: '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  },
};
