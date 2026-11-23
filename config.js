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
    osm: {
      label: 'OpenStreetMap',
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      minZoom: 3, maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
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
  networkUrl: 'net.json',
  center: [1.3521, 103.8198],
  zoom: 12,
};
