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
| Open-Meteo elevation API | CC BY 4.0, free for non-commercial use |
| OneMap address search | OneMap terms of use |

The code licence is separate and is set in `LICENSE`.
