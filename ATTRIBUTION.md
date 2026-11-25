# Attribution

TowerCab's own code is under the [MIT licence](LICENSE). It draws on data, services and software that keep
their own terms. This file lists them. The app's footer credits the sources that are switched on.

## Data the app fetches while it runs

Nothing here is stored in this repository; your server fetches it. Using TowerCab means accepting the terms of
the sources you enable.

| Source                                                                    | Used for                                | Terms                                                                                                 |
| ------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [adsb.fi](https://adsb.fi)                                                | Aircraft positions                      | Open data for personal, non-commercial use; credit and a link are required                            |
| [adsb.lol](https://adsb.lol)                                              | Aircraft positions                      | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/); attribution required                      |
| [airplanes.live](https://airplanes.live)                                  | Aircraft positions (off by default)     | Access by agreement with airplanes.live                                                               |
| [The OpenSky Network](https://opensky-network.org)                        | Aircraft positions (off; fallback only) | Research and non-commercial use                                                                       |
| [OurAirports](https://ourairports.com/data/)                              | Airport positions, elevations, runways  | Public domain                                                                                         |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) via Overpass API | Runways, taxiways, aprons, buildings    | © OpenStreetMap contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)              |
| [aviationweather.gov](https://aviationweather.gov)                        | METAR                                   | US government work, public domain                                                                     |
| [planespotters.net](https://www.planespotters.net)                        | Aircraft photos                         | Photo © the photographer named under it; shown as a thumbnail linking to the photo's page             |
| [Wikimedia Commons](https://commons.wikimedia.org)                        | Pictures of aircraft types              | Each picture's own licence, named under it with the author; loaded from Wikimedia, linked to its page |
| [Wikipedia](https://en.wikipedia.org)                                     | Which picture goes with a type          | Asked for the file name of an article's lead image; no text is used                                   |
| [Cesium ion](https://cesium.com/platform/cesium-ion/)                     | Terrain; access to Google's 3D tiles    | Your own ion account and its terms; the free plan is for personal and non-commercial use              |
| Google Photorealistic 3D Tiles                                            | Photoreal base map                      | Google Maps Platform terms. Displayed with Google's attribution; never cached, proxied or stored      |
| [YouTube](https://www.youtube.com)                                        | Live cameras you add; camera search     | YouTube's terms; played only in YouTube's own embedded player                                         |
| [Windy.com](https://www.windy.com/webcams)                                | Webcams you approve; camera search      | Windy Webcams API terms: pictures loaded from Windy, not enlarged, linked to Windy, Windy credited    |
| [LiveATC](https://www.liveatc.net)                                        | A link in the side panel                | Linked only; its audio is not embedded or re-streamed                                                 |

## Data in this repository

| What                                                                 | From                                                                                      | Terms                                                                                 |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `apps/web/public/replays/klaf-pattern.jsonl`                         | Aircraft positions recorded from adsb.lol on 2026-11-24                                   | © adsb.lol contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)   |
| `apps/server/test/fixtures/adsblol-*.json`                           | adsb.lol API responses                                                                    | ODbL 1.0                                                                              |
| `apps/server/test/fixtures/adsbfi-*.json`                            | adsb.fi API responses, kept as small test samples                                         | adsb.fi open data terms                                                               |
| `apps/server/test/fixtures/opensky-states-kind.json`                 | An OpenSky Network API response, kept as a small test sample                              | The OpenSky Network terms                                                             |
| `apps/server/test/fixtures/ourairports-*.csv`                        | A few rows of OurAirports data                                                            | Public domain                                                                         |
| `apps/server/test/fixtures/overpass-klaf.json`                       | OpenStreetMap data for one airport                                                        | © OpenStreetMap contributors, ODbL 1.0                                                |
| `apps/server/test/fixtures/metar-klaf-kind.json`                     | aviationweather.gov                                                                       | Public domain                                                                         |
| `apps/server/test/fixtures/planespotters-a0d5d6.json`                | A planespotters.net API response (no image)                                               | planespotters.net; the photo it refers to is © its photographer                       |
| `apps/server/test/fixtures/{wikipedia,commons}-*.json`               | Wikipedia and Wikimedia Commons API responses (no image)                                  | Facts about a file; the photo they refer to is © Mike Burdett, CC BY-SA 2.0           |
| `docs/images/*.png`                                                  | Screenshots of the app in Schematic mode, showing OpenStreetMap, OurAirports and adsb.lol | © OpenStreetMap contributors (ODbL 1.0); positions © adsb.lol contributors (ODbL 1.0) |
| `config/config.example.yaml`: control tower positions for KLAF, KIND | FAA Digital Obstacle File                                                                 | US government work, public domain                                                     |

## Made for this project

| What                                                 | Notes                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `apps/web/public/models/*.glb`                       | Low-poly aircraft shapes generated by `scripts/gen-models.ts`. Original work, MIT like the code. |
| `packages/shared/data/aircraft-types.json`           | Aircraft type codes with wingspan and length, compiled by hand from published figures. MIT.      |
| `packages/shared/data/type-articles.json`            | Which Wikipedia article is about which type code, compiled by hand. MIT.                         |
| `apps/web/public/favicon.svg`, `unraid/towercab.png` | Original work, MIT.                                                                              |

## Software

The main libraries, all installed from npm at the versions in `pnpm-lock.yaml`:

| Library                                                                | Licence    |
| ---------------------------------------------------------------------- | ---------- |
| [CesiumJS](https://github.com/CesiumGS/cesium)                         | Apache-2.0 |
| [hls.js](https://github.com/video-dev/hls.js)                          | Apache-2.0 |
| [React](https://react.dev)                                             | MIT        |
| [Fastify](https://fastify.dev), [ws](https://github.com/websockets/ws) | MIT        |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)           | MIT        |
| [egm96-universal](https://www.npmjs.com/package/egm96-universal)       | MIT        |
| [zod](https://zod.dev), [pino](https://getpino.io)                     | MIT        |
| [yaml](https://eemeli.org/yaml/)                                       | ISC        |

Optional companions, run as their own containers and not part of TowerCab's image:
[go2rtc](https://github.com/AlexxIT/go2rtc) (MIT),
[docker-adsb-ultrafeeder](https://github.com/sdr-enthusiasts/docker-adsb-ultrafeeder) (GPLv3) and
[docker-dump978](https://github.com/sdr-enthusiasts/docker-dump978).
