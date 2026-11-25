# Data licences

The routing networks (`net.json` in this repository, `data/net-v2.json` on the `data/network-v2`
branch) combine the open datasets below. Each is a **Derived Database** of
OpenStreetMap and is made available under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
You may copy, share and adapt it if you keep the attribution below and share any adapted
database under the ODbL as well.

| Data | Source | Licence | Attribution |
|---|---|---|---|
| Streets (named roads, expressways removed) in `net.json` | OpenStreetMap, via github.com/evgeniyarbatov/singapore-streets | ODbL 1.0 | © OpenStreetMap contributors |
| Streets, pavements, footpaths, steps in `net-v2.json`; housing estates, schools and parks used to classify them | OpenStreetMap (Geofabrik / openstreetmap.fr extracts) | ODbL 1.0 | © OpenStreetMap contributors |
| Land boundary used to cut `net-v2.json` to Singapore | URA Master Plan 2019 Region Boundary (No Sea), data.gov.sg | Singapore Open Data Licence 1.0 | Contains information from the Master Plan 2019 Region Boundary (No Sea) dataset accessed from data.gov.sg, made available under the Singapore Open Data Licence 1.0 |
| Park connectors | NParks Park Connector Network, data.gov.sg (via github.com/happydugong/cyclesg) | Singapore Open Data Licence 1.0 | Contains information from the Park Connector Network dataset accessed from data.gov.sg, made available under the Singapore Open Data Licence 1.0 |
| Closures (`closures.json`) | NParks PCN notices; extents drawn by hand | — | pcn.nparks.gov.sg/notices |

Services used at run time (not stored in this repository):

| Service | Terms |
|---|---|
| OneMap basemap tiles | © OneMap / Singapore Land Authority, attribution required |
| Esri World Imagery | © Esri, Maxar, Earthstar Geographics; Esri terms of use |
| Open-Meteo elevation API | CC BY 4.0, free for non-commercial use, rate-limited per minute, hour and day; the app caches what it fetches |
| Copernicus DEM GLO-90 (behind the elevation API) | Free licence; attribution: produced using Copernicus WorldDEM-90 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved |
| OneMap address search | OneMap terms of use |
| OpenFreeMap vector tiles (3D view) | Free public instance, no key; attribution "OpenFreeMap © OpenMapTiles Data from OpenStreetMap"; offered as-is and may change |

The code is under the MIT licence (`LICENSE`); the bundled Leaflet files are under Leaflet's BSD 2-Clause licence (`LICENSE-LEAFLET`), and MapLibre GL JS in `vendor/maplibre/` under its BSD 3-Clause licence (`vendor/maplibre/LICENSE.txt`).
