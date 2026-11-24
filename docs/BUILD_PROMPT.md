# TowerCab: Claude Code build prompt

> How to use: create an empty folder, save this file as `docs/BUILD_PROMPT.md`, open Claude Code there and say:
> **"Read docs/BUILD_PROMPT.md and build TowerCab, phase by phase."**

> Note: the original prompt carried a Cesium ion token on this line. It was moved to the
> gitignored `.env` (`CESIUM_ION_TOKEN`) and is deliberately not stored in this file.

---

## Your role and how to work

You are building **TowerCab**, an open-source web app that shows live aircraft moving around an airport in a 3D scene, like the view from the tower cab, in a browser. You own the whole build: architecture, code, tests, Docker image and docs.

The code will be public at `github.com/clucraft/towercab`. It runs as a Docker container on an Unraid server.

Working rules:

1. Before writing code, write `docs/PLAN.md` (architecture, directory layout, phase checklist) and `docs/DECISIONS.md` (a running log of decisions and of every place you deviate from this prompt, with the reason). Then start Phase 0 without waiting for approval.
2. Work phase by phase (see **Delivery phases**). At the end of each phase run lint, typecheck, tests and `docker build`, fix anything that fails, tick off PLAN.md, and make a conventional commit. Ask me before you create the GitHub remote or push the first time. After that, push at the end of each phase.
3. **Check every external API against its live docs and responses before you write code for it.** Call each endpoint with curl, save a trimmed response under `apps/server/test/fixtures/`, and write parser tests against it. If this prompt disagrees with the live API or docs, the live API wins; log the difference in DECISIONS.md.
4. **Never invent URLs, stream IDs, coordinates or endpoints.** If you can't verify something, make it configurable, leave it empty, and say so in the README.
5. Keep secrets out of git. Everything sensitive comes from env vars, and you ship a `.env.example`.
6. Prefer boring, well-maintained dependencies and pin their versions. The app must run without any paid service.

---

## Product

- **Airport picker**, starting with **KLAF** (Purdue University Airport) and **KIND** (Indianapolis International). URLs can be shared, e.g. `/KLAF` or `/KIND?view=tower&mode=schematic`.
- **3D airport.** Photorealistic where possible, with a clean "schematic" mode as the alternative. Every tracked aircraft (ADS-B 1090, UAT 978, MLAT, TIS-B) is drawn as a 3D model at its real size and moves smoothly in real time: taxiing, holding short, lining up, taking off, landing and parking.
- **Click an aircraft** to see its callsign, registration, type, operator (if known), altitude, ground speed, heading, squawk, data source and data age. It also gets a "Follow" button and an optional photo.
- **View presets for each airport:** Tower cab, Overhead, each runway end, Free orbit and Follow selected aircraft.
- **Live cameras (optional).** Any livestream or webcam set up for the airport can open as picture-in-picture, side-by-side or a grid. Cameras whose position and direction are known appear as view cones in the 3D scene. **Match view** puts the 3D camera at the webcam's position so the labels line up with the video.
- **Side panel:**
  - aircraft list grouped by phase (parked, taxiing, departing, arriving, pattern)
  - METAR, wind and a hint at the active runway
  - health and freshness of each data source
  - links out to LiveATC, the FAA airport diagram and FlightAware
- **Footer disclaimer:** _Not for navigation or operational use._

Not in v1: user accounts, history beyond a short rolling buffer, native mobile apps, anything used to actually control traffic.

---

## Architecture

The repo is a TypeScript monorepo with pnpm workspaces:

```
towercab/
  apps/server       Node 24 LTS + Fastify + ws: data collection, merging, WebSocket fan-out, config, serves the built web app
  apps/web          Vite + React + TypeScript + CesiumJS (Cesium driven from a dedicated scene module, no Resium)
  packages/shared   zod schemas + shared types (Aircraft, AirportConfig, CameraConfig, WS messages, aircraft type table)
  config/           config.example.yaml
  docker/           Dockerfile, compose files
  unraid/           Community Applications template
  scripts/          model generator, recorder, soak test
  docs/
```

**Core rule: browsers never call ADS-B providers directly.** The server fetches data once per airport and fans it out over WebSocket. That way 1 viewer costs the same number of upstream requests as 50, rate limits are respected and API keys stay on the server.

### Server

- **Config:** `/config/config.yaml`, validated with zod and reloaded when the file changes. Env vars override secrets. On first start, if the file doesn't exist, copy the example in.
- **Provider adapters** all implement one interface, `AdsbProvider { id, fetchArea(lat, lon, radiusNm), health() }`, and convert their data to the shared `Aircraft` type.
- **Scheduler:**
  - One polling loop per airport. Poll fast (default 2 s) while at least one browser is subscribed to that airport. Slow down to 60 s, then pause, when nobody is watching.
  - Each provider gets a global token bucket that enforces its rate limit across all airports.
  - Back off exponentially on 429 and 5xx responses, and honor any retry-after headers.
  - When no one is watching, the container should sit at close to zero CPU and network use.
- **Merging:**
  - Key aircraft by ICAO hex. Keep the freshest position (fetch time minus `seen_pos`).
  - At equal freshness, prefer the local receiver over public sources.
  - **Never accept a position older than the one already sent to clients.** Data from different sources must not make an aircraft jump backwards.
  - Keep an aircraft for 30 s after its last update before removing it.
  - Remove TIS-B/ADS-R duplicates of a real ADS-B track: addresses that aren't ICAO addresses start with `~` in readsb. Match them on proximity plus callsign.
- **Classification:**
  - `onGround` is true when `alt_baro === "ground"` (a string, not a number), or when ground speed is under 40 kt and altitude is within about 150 ft of field elevation. Tune these thresholds and document them.
  - Phase is one of parked, taxiing, takeoff roll, departing, arriving, landing roll or pattern. Work it out from ground speed, vertical rate, distance from the field and how close the aircraft is to a runway.
- **Geofence:** a radius per airport (default 6 nm) and an altitude ceiling (default 5,000 to 6,000 ft AGL). The scene should show pattern and approach traffic, not airliners passing overhead at FL350.
- **WebSocket `/ws`:**
  - A browser subscribes to one airport and gets a full snapshot, then changes at 1 Hz, each stamped with server time.
  - Send a ping every 20 s. The client reconnects automatically with backoff.
  - Message schemas live in `packages/shared`.
- **REST endpoints:**

  | Endpoint              | Returns                                                                         |
  | --------------------- | ------------------------------------------------------------------------------- |
  | `/api/airports`       | List of configured airports                                                     |
  | `/api/airports/:icao` | Merged config, runways and layout GeoJSON                                       |
  | `/api/client-config`  | Tokens the browser may see, plus feature flags, so one image works for everyone |
  | `/api/cameras/:icao`  | Approved cameras for the airport                                                |
  | `/api/metar/:icao`    | Cached METAR                                                                    |
  | `/healthz`            | Health check                                                                    |
  | `/metrics`            | Prometheus metrics (optional)                                                   |

- **State:** the last 10 minutes of positions for each aircraft live in memory and feed the trails. SQLite (better-sqlite3) is used only for the camera discovery queue and cached reference data.
- **Logging:** pino, JSON in production. Honor `X-Forwarded-*` headers, because the app sits behind a reverse proxy.

### ADS-B data sources

Build these in this order. Each can be turned on or off in config, in any combination.

1. **Local `readsb` receiver** (highest priority when configured).
   - Read `http://<host>/data/aircraft.json` (served by tar1090/ultrafeeder, readsb format, `aircraft[]`). For lower latency, read readsb's TCP JSON position stream (port 30047) instead.
   - This is the only reliable way to see aircraft on the ground at KLAF:
     - Purdue's flight-school fleet is light GA aircraft, and much of it broadcasts on **UAT 978 MHz**, not 1090.
     - Ground position messages are weak and infrequent, so public aggregators only see the ramp if some feeder's antenna can see it.
   - Add an optional compose profile `receiver` that runs `ghcr.io/sdr-enthusiasts/docker-adsb-ultrafeeder` plus `ghcr.io/sdr-enthusiasts/docker-dump978` (one 1090 dongle and one 978 dongle), wired into TowerCab, with a docs page explaining USB passthrough on Unraid.
2. **adsb.lol:** `https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{nm}`. No key needed. The data is ODbL-licensed, so attribution is required.
3. **airplanes.live:** `https://api.airplanes.live/v2/point/{lat}/{lon}/{radius}`. No key needed. Limited to 1 request per second, non-commercial use only.
4. **adsb.fi:** `https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{nm}`. No key needed. Limited to 1 request per second, personal and non-commercial use only, attribution and a link required.
5. **OpenSky Network** (fallback only):
   - Endpoint: `/api/states/all` with a bounding box.
   - Uses **OAuth2 client-credentials** auth; username/password no longer works. Get a token from the OpenSky auth server and refresh it before it expires.
   - The daily credit budget is small, so watch `X-Rate-Limit-Remaining` and only use OpenSky when every other source is failing.

Sources 2 to 4 return the ADSBExchange v2-compatible schema (`ac[]`), with the same per-aircraft fields as readsb, so one parser should handle all three. Confirm that with the fixtures.

Default config: adsb.lol first, airplanes.live second, adsb.fi third, OpenSky off.

Fields that matter: `hex`, `flight`, `r`, `t`, `category`, `alt_baro`, `alt_geom`, `gs`, `track`, `true_heading`, `baro_rate`, `geom_rate`, `squawk`, `type` (adsb_icao / adsr_icao / tisb_* / mlat / …), `seen`, `seen_pos`, `rssi`, `nic`, `nac_p`. Check what readsb's README-json says about which datum `alt_geom` uses.

Optional extra: aircraft photos from the planespotters.net public photo API, looked up by hex. Check its current endpoint and terms; it requires attribution and a link back.

### Reference data

- **Airports and runways:** OurAirports `airports.csv` and `runways.csv` (public domain).
  - Download on first start, cache in `/data`, refresh weekly.
  - Use it for the reference point, field elevation, and runway ends (lat, lon, heading, elevation, width).
  - **To add an airport, you only add its ICAO code to config.** Everything else comes from the data, and config can override any value.
- **Airport layout:** OpenStreetMap via the Overpass API.
  - Fetch these features inside the `aeroway=aerodrome` boundary: `aeroway` = runway, taxiway, taxilane, apron, holding_position, parking_position, gate, terminal, hangar, tower, windsock, plus buildings.
  - Use one query per airport and set a proper User-Agent.
  - Cache the result as `/data/osm/{icao}.geojson` and refresh it weekly.
  - OSM data is ODbL, so it needs attribution.
- **Aircraft type table:** `packages/shared/data/aircraft-types.json` maps ICAO type codes to `{ class, wingspanM, lengthM }`.
  - At minimum, cover the types common at these two airports:
    - GA singles and twins: C152, C172, P28A, PA44, SR22, BE58
    - Turboprops and bizjets: PC12, C25B, CL30, E55P
    - Regional jets: CRJ2, CRJ9, E75L
    - Narrowbodies: A319, A320, A321, B737, B738, B739, B38M, B752
    - Heavy freighters (FedEx's IND hub): B763, B77L, MD11, A306
  - If a type isn't in the table, fall back to the ADS-B emitter category (A1 to A7), then to a generic model.
- **Weather:** METAR from the aviationweather.gov Data API (check the current endpoint and format), cached for 5 minutes. Use the altimeter setting to correct `alt_baro`, and use the wind to suggest the active runway.

### 3D rendering (apps/web)

Use the latest stable CesiumJS from npm, and copy and serve its static assets (`Workers`, `Assets`, `Widgets`) correctly in the production build (`CESIUM_BASE_URL`).

**Two base modes.** The user can switch between them, and the app falls back to Schematic on its own when Photoreal fails.

- **Photoreal: Google Photorealistic 3D Tiles.**
  - Support two ways in:
    - through Cesium ion with `CESIUM_ION_TOKEN` (CesiumJS has a helper for this; check its current name and signature, e.g. `createGooglePhotorealistic3DTileset`)
    - directly through the Google Map Tiles API with `GOOGLE_MAPS_API_KEY`
  - Keep the Google and Cesium credits visible at all times; they are required.
  - Follow Google's Map Tiles policies:
    - Don't cache, proxy or save tiles, or anything derived from them, to disk.
    - Keep OSM-derived layout layers in Schematic mode rather than drawing them over Google's imagery.
    - Re-check the current policy and record your decision in DECISIONS.md.
  - 3D coverage around Lafayette may be low resolution. If tiles fail to load or the quota runs out, switch to Schematic automatically and show a short notice.
- **Schematic: a clean, top-down, airport-radar-style view.**
  - It must work **with no tokens at all**: dark ground plus OSM vector layout draped on it.
  - Layout layers:
    - runways with centerlines and designators
    - taxiways labeled from the OSM `ref` tag
    - aprons and hold-short lines
    - buildings, terminal and tower extruded from OSM data
  - Use Cesium World Terrain when an ion token exists. Otherwise lay everything flat at field elevation (both airports are flat).
  - Use a dark palette that works at night.

**Aircraft**

- **Models:**
  - Use one glTF model per class, scaled to the real wingspan from the type table. A C172 at KLAF and a FedEx 777 at IND must look right next to their surroundings.
  - Placeholders: write `scripts/gen-models.ts`, which builds clean low-poly glTF for each class (fuselage, wings, tail, engines or props) using gltf-transform.
  - Only add third-party models if they are CC0 or CC-BY, and list them in `apps/web/public/models/ATTRIBUTION.md`.
  - Allow drop-in replacements from `/data/models/{class}.glb`.
- **Smooth motion:**
  - Render about 2 s behind real time, interpolating between received positions (a SampledPositionProperty or your own buffer).
  - When updates arrive late, estimate the position from ground speed and track for up to 10 s, then fade the aircraft out.
  - Never snap an aircraft backwards.
- **Orientation:**
  - Use `true_heading`, falling back to `track`.
  - **Freeze the heading below about 2 kt**, because track is noise when an aircraft is standing still.
  - Add a slight pitch on climb and descent, based on vertical rate.
- **Height. Wrong altitudes are the main reason aircraft float or sink into the ground**, so get this right and unit-test it:
  - Aircraft on the ground sit on the surface. Sample the terrain/tile height at their position with `sampleHeightMostDetailed` or `clampToHeight`, leaving the aircraft themselves out of the sample. Keep those samples in memory for the current session only; don't save them.
  - If sampling isn't possible, use field elevation converted from MSL to ellipsoid height with the local geoid offset. Compute that offset with an EGM96 library; it's roughly −33 m in central Indiana, but don't hardcode it.
  - Aircraft in the air: use `alt_geom` if it's present. Otherwise use `alt_baro` corrected with the METAR altimeter, then the geoid offset.
  - Acceptance check: wheels touch the runway when taking off and landing.
- **Labels:**
  - Callsign (or registration), type, altitude and ground speed.
  - Keep labels from overlapping and scale them with distance.
  - Color by phase.
  - Trails of up to 3 minutes, which can be turned off.
  - The selected aircraft is highlighted with a leader line to its label.
- **Performance:**
  - 60 fps with 150 aircraft at KIND on a mid-range GPU, and at least 30 fps on a recent laptop with integrated graphics.
  - Start with the Entity API, behind an `AircraftLayer` interface so it can move to primitives later if needed.
  - Use Cesium's request-render mode where it helps.

**Views and UI**

- **View presets** come from config and data:
  - **Tower cab:** the tower's position from OSM `aeroway=tower` or FAA data, marked approximate, at its real eye height, looking at the field.
  - **Overhead.**
  - **Runway ends:** generated from the runway data.
  - **Free orbit.**
  - **Follow:** a smooth chase camera behind the selected aircraft.
- **Look:** dark and clean, inspired by aviation displays.
- **Top bar:** airport switcher, Photoreal/Schematic switch, view presets, cameras button.
- **Right panel** (can be collapsed): aircraft list, METAR, source health.
- **Keyboard shortcuts:** `1`–`5` switch views, `F` follows the selected aircraft, `C` opens cameras, `S` toggles Schematic.
- **Mobile:** usable on a phone held sideways.
- **Attribution footer:** Cesium; Google (when Photoreal is on); OpenStreetMap contributors; adsb.lol (ODbL); airplanes.live; adsb.fi; OpenSky (when used); OurAirports; Windy and YouTube (when used).

### Live cameras

There is no reliable list of official 24/7 public livestreams for KLAF or KIND. Build cameras as a registry driven by config, with an optional discovery helper, and **ship with an empty camera list. Don't guess any URLs.**

- **Camera entry** in config:

  ```
  { id, airport, name,
    kind: youtube | hls | mjpeg | snapshot | iframe | webrtc,
    source,      // YouTube video/channel ID, URL, or go2rtc stream name
    attribution, link,
    pose?: { lat, lon, heightM, headingDeg, pitchDeg, hfovDeg },
    enabled }
  ```

- **Players:**
  - **YouTube:** the YouTube IFrame Player API, using a live video ID or a channel's live embed.
  - **HLS:** hls.js.
  - **MJPEG:** an `<img>` tag.
  - **Snapshot:** reload the image every N seconds.
  - **iframe:** last resort. Some sites block framing; detect that and show "Open in new tab" instead.
  - **WebRTC/MSE:** through an optional **go2rtc** sidecar (compose profile `cameras`) for anyone bringing their own RTSP camera.
  - The server proxies HLS, MJPEG and snapshot streams only when CORS requires it, and only for addresses on an allowlist. It must never act as an open proxy.
- **Layouts:** picture-in-picture (drag and resize), split (3D next to video), and a grid of every camera for the airport.
- **View cones and Match view:**
  - Cameras with a pose appear as see-through view cones in the scene.
  - Match view puts the Cesium camera at that pose and field of view.
  - Overlay mode draws 3D labels on top of the video, with an opacity slider.
  - This is a stretch goal, but design the data model for it now.
- **Discovery** (admin only, off by default):
  - **YouTube Data API v3 `search.list`:**
    - Location search with `type=video`, `eventType=live`, `location` set to the airport's reference point and `locationRadius` of about 10 km.
    - Plus keyword searches such as `"{ICAO} live"`, `"{city} airport live"` and `"plane spotting {city}"`.
    - Each search costs 100 quota units, so run at most every 6 hours per airport and cache the results.
  - **Windy Webcams API v3, `nearby` filter**, for weather and traffic cameras near the field.
    - Most of these are stills that update every few minutes.
    - Free-tier image URLs expire after about 10 minutes, so have the server refresh them.
    - Every image must link back to Windy.
  - **Approval queue:** results land in a queue at `/admin`.
    - `/admin` is protected by `ADMIN_TOKEN`, and admin routes are off entirely if that variable isn't set.
    - Nothing found by discovery is shown to viewers until it's approved.
    - In the admin page you set a camera's pose by clicking in the 3D scene and dragging the heading and field of view.
- **ATC audio:** link out to LiveATC's page for the airport. Don't embed or re-stream their audio.

---

## Deployment (Unraid)

- **Image:** `ghcr.io/clucraft/towercab`.
  - Multi-stage Dockerfile: build web, build server, then a slim runtime (`node:24-alpine` or distroless).
  - Runs as a non-root user, with a `HEALTHCHECK` on `/healthz`.
  - Listens on `PORT` (default **8790**).
- **Volumes:**
  - `/config`: config.yaml and camera entries.
  - `/data`: OurAirports and OSM caches, SQLite, model overrides.
- **Env vars:** `PORT`, `PUBLIC_URL`, `TZ`, `LOG_LEVEL`, `CESIUM_ION_TOKEN`, `GOOGLE_MAPS_API_KEY`, `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET`, `YOUTUBE_API_KEY`, `WINDY_API_KEY`, `ADMIN_TOKEN`. Document each one in the README and in `.env.example`.
- **Compose:** `docker-compose.yml` for the core app, plus the profiles `receiver` (ultrafeeder and dump978) and `cameras` (go2rtc).
- **Unraid template** `unraid/towercab.xml`:
  - appdata at `/mnt/user/appdata/towercab/{config,data}`
  - the port
  - every env var, with a description and masked secrets
  - icon, plus Support and Project URLs pointing to the GitHub repo
- **Reverse proxy:** the app sits behind **Zoraxy** at `towercab.basch.me`, pointing to `192.168.1.55:8790`.
  - The WebSocket must be same-origin (`/ws`) and survive the proxy.
  - The README explains how to restrict the Cesium ion token's allowed URLs and the Google key's HTTP referrers to the public hostname. Those values are visible in the browser by design.
- **GitHub Actions:**
  - CI on pull requests: lint, typecheck, test, build.
  - On pushes to main and on tags: build for amd64 and arm64 and push to GHCR with `latest`, the commit SHA and semver tags.
  - Dependabot for npm, GitHub Actions and Docker.
  - gitleaks secret scanning in CI.

## Public repo hygiene

- MIT license for the code. Licenses for third-party data and models go in `ATTRIBUTION.md`.
- **README:**
  - a hero screenshot or GIF (placeholder until real captures exist)
  - what the app is
  - quick start: docker run, compose and Unraid
  - how to get a free Cesium ion token
  - config reference
  - adding an airport and adding a camera
  - local receiver guide
  - data source terms (non-commercial notes)
  - the disclaimer
- `.gitignore` covers `.env`, `/data` and local config.
- **Tests:**
  - vitest for the server and shared packages:
    - parsers, tested against the saved fixtures
    - merging, including never going backwards in time
    - classification and geofence
    - the altitude pipeline
    - scheduler and rate limiting, using fake timers
  - A Playwright smoke test loads `/KLAF` with a mocked WebSocket feed and checks that aircraft appear.

---

## Starting config

Check every value against OurAirports/FAA when you build, and correct it.

```yaml
airports:
  - icao: KLAF
    name: Purdue University Airport
    # rough check only: ~40.41, -86.94, field elev ~606 ft. Take real values from OurAirports
    radiusNm: 6
    ceilingFtAgl: 5000
    tower: null # fill from OSM aeroway=tower / FAA; mark as approximate
    defaultView: tower
  - icao: KIND
    name: Indianapolis International Airport
    # rough check only: ~39.72, -86.29, field elev ~797 ft. Take real values from OurAirports
    radiusNm: 8
    ceilingFtAgl: 6000
    tower: null
    defaultView: overhead

providers:
  readsb: { enabled: false, url: "http://ultrafeeder/data/aircraft.json", priority: 0 }
  adsblol: { enabled: true, priority: 1 }
  airplaneslive: { enabled: true, priority: 2 }
  adsbfi: { enabled: true, priority: 3 }
  opensky: { enabled: false, priority: 9 }

polling:
  activeIntervalMs: 2000
  idleIntervalMs: 60000
  pauseWhenNoViewersAfterMs: 300000

cameras: []
```

---

## Delivery phases

Each phase ends with green CI and a commit.

**Phase 0: Scaffold**

- pnpm workspace, Biome (or ESLint + Prettier), tsconfig, vitest.
- Dockerfile, compose and CI.
- Config loader using zod, plus the example config.
- `/healthz` and a skeleton README.
- _Done when:_ `docker compose up` serves a placeholder page and the health check passes.

**Phase 1: Live data**

- Provider adapters, with fixtures and tests.
- Scheduler and rate limiting.
- Merging, classification and geofence.
- The WebSocket protocol.
- OurAirports loader and METAR.
- A debug page at `/debug/:icao` with a live table: hex, callsign, type, phase, altitude, speed, source, data age.
- _Done when:_
  - live aircraft show for both airports
  - provider health is visible
  - a 30-minute soak test (`scripts/soak.ts`) gets no 429 responses
  - with no viewers, polling stops

**Phase 2: 3D scene**

- Cesium viewer and airport routing.
- Photoreal mode, with automatic fallback.
- Aircraft layer with the generated models, interpolation, ground clamping and labels.
- Selection panel, view presets and Follow camera.
- _Done when:_
  - at KIND, taxiing aircraft sit on the taxiways (spot-check against the OSM layer)
  - aircraft don't jitter or jump during normal updates
  - wheels touch the runway on takeoff and landing
  - the 60 fps target is met with 150 simulated aircraft

**Phase 3: Schematic mode and polish**

- OSM layout loader and Schematic mode.
- Trails and phase colors.
- Aircraft list, METAR and active-runway panel.
- Keyboard shortcuts, mobile layout and attribution footer.
- **Replay/simulator mode** (`?replay=kind-busy`) so the UI can be built and shown without live traffic: record a real session with `scripts/record.ts` into a JSONL fixture.

**Phase 4: Cameras**

- Camera registry and players.
- Picture-in-picture, split and grid layouts.
- View cones and Match view.
- go2rtc profile.
- Admin page with discovery and the approval queue.

**Phase 5: Ship**

- Unraid template, GHCR workflow and Dependabot.
- README with real screenshots of the running app, captured with Playwright.
- `docs/RECEIVER.md` and `docs/ADDING_AN_AIRPORT.md`.
- Tag `v0.1.0`.

---

## When you finish each phase

Give me a short summary covering:

- what works
- what's stubbed
- what you changed from this prompt and why
- anything I need to do: tokens, hardware, DNS or Zoraxy setup
