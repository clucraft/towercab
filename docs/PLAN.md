# TowerCab build plan

Source of truth for scope is [BUILD_PROMPT.md](BUILD_PROMPT.md). Deviations from it are logged in [DECISIONS.md](DECISIONS.md).

## Architecture

```
            ┌────────────────────────── apps/server (Node 24, Fastify, ws) ──────────────────────────┐
 readsb ───▶│ providers/   one adapter per source, all return shared `Aircraft` observations          │
 adsb.lol ─▶│ scheduler/   per-airport poll loop, per-provider token bucket, backoff, viewer-driven   │
 airplanes ▶│ tracking/    merge by hex → dedupe TIS-B → geofence → classify → 10 min history         │
 adsb.fi ──▶│ reference/   OurAirports CSV, Overpass→GeoJSON, METAR, EGM96 geoid offset               │
 OpenSky ──▶│ ws/          /ws hub: subscribe → snapshot, then ≤1 Hz deltas, ping every 20 s           │
            │ routes/      /api/*, /healthz, /metrics, /admin/*, allowlisted camera proxy             │
            │ static       serves the built web app + SPA fallback                                    │
            └──────────────────────────────────────┬──────────────────────────────────────────────────┘
                                                   │ same-origin HTTP + WebSocket
            ┌──────────────────────────── apps/web (Vite, React, CesiumJS) ───────────────────────────┐
            │ ws/client     reconnecting client, server-clock estimate                                │
            │ scene/        SceneController (no Resium): base modes, AircraftLayer, labels, trails,   │
            │               ground sampling, view presets, follow camera, camera view cones           │
            │ ui/           top bar, side panel, selection card, camera players, admin page           │
            └─────────────────────────────────────────────────────────────────────────────────────────┘
                    packages/shared: zod schemas, WS messages, geo + altitude maths, aircraft type table
```

Core rule: browsers never talk to ADS-B providers. One upstream fetch per airport, fanned out over WebSocket.

### Data flow for one poll cycle

1. Scheduler ticks for an airport that has viewers (2 s), or is idling (60 s), or is paused (no ticks).
2. Each due provider is asked for `fetchArea(lat, lon, radiusNm)` if its token bucket and backoff allow it.
3. Observations go into the tracker: keyed by hex, freshest position wins (`fetchTime − seen_pos`), local receiver
   wins ties, and a position older than the one already published is dropped.
4. TIS-B/ADS-R shadows (`~` addresses) of a real ADS-B track are removed.
5. Geofence (radius + ceiling AGL), `onGround`, phase and the altitude estimate are computed.
6. The hub broadcasts a delta (rate limited to 1 Hz) to that airport's subscribers.

### Height pipeline (unit-tested in `packages/shared`)

- Airborne: `alt_geom` (WGS84 ellipsoid, per readsb README-json) → metres. Otherwise `alt_baro` corrected with the
  METAR altimeter → MSL → plus the EGM96 geoid undulation → ellipsoid height.
- On the ground: the client samples the terrain/3D tiles under the aircraft (aircraft excluded, in-memory cache only).
  Fallback: field elevation MSL + geoid undulation.
- The server computes the geoid undulation per airport with an EGM96 library and ships it in the airport payload.

## Directory layout

```
towercab/
  apps/server/
    src/
      index.ts                 process entry
      app.ts                   Fastify factory: routes, static files, ws upgrade
      config/                  zod schema, YAML loader, env overrides, hot reload
      providers/               AdsbProvider interface, readsb parser, v2 adapters, OpenSky, local readsb (HTTP/TCP)
      scheduler/               token bucket, backoff, airport poller, scheduler
      tracking/                merge, dedupe, geofence, classify, history, tracker
      reference/               ourairports, overpass + OSM→GeoJSON, metar, geoid, airport service
      cameras/                 registry, proxy allowlist, discovery (YouTube, Windy), approval queue (SQLite)
      ws/                      subscription hub
      routes/                  api, admin, debug, proxy, health, metrics
    test/
      fixtures/                trimmed real API responses
  apps/web/
    src/
      scene/                   SceneController, modes/, aircraft/, labels/, trails, ground, views, cameras
      ui/                      React components
      pages/                   AirportPage, DebugPage, AdminPage
      ws/                      WebSocket client
    public/models/             generated low-poly GLBs (credits in /ATTRIBUTION.md)
    e2e/                       Playwright smoke test
  packages/shared/
    src/                       schemas, messages, geo, altitude, type table lookup
    data/aircraft-types.json   dimensions by type; type-articles.json has the Wikipedia article of each
  config/config.example.yaml
  docker/                      Dockerfile, go2rtc example, receiver env example
  docker-compose.yml           core app + profiles `receiver`, `cameras`
  unraid/towercab.xml
  scripts/                     gen-models.ts, record.ts, soak.ts, screenshots.ts
  docs/                        this plan, decisions, receiver guide, adding an airport
  .github/                     CI, release, dependabot
```

## Phase checklist

### Phase 0: Scaffold

- [x] pnpm workspace, Biome, tsconfig, vitest
- [x] Config loader (zod, YAML, env overrides, copy example on first start, hot reload)
- [x] `/healthz`, placeholder page
- [x] Dockerfile (multi-stage, non-root, HEALTHCHECK), compose, CI workflow
- [x] Skeleton README, LICENSE, `.env.example`
- [x] Done when: `docker compose up` serves the placeholder and the health check passes

### Phase 1: Live data

- [x] Verify each API live; save trimmed fixtures
- [x] readsb/v2 parser + adsb.lol, airplanes.live, adsb.fi adapters
- [x] Local readsb adapter (HTTP, optional TCP 30047), OpenSky adapter (OAuth2, fallback only)
- [x] Token bucket, backoff with retry-after, viewer-driven scheduler
- [x] Merge, TIS-B dedupe, geofence, classification, 10 min history
- [x] OurAirports loader, EGM96 geoid, METAR
- [x] WebSocket protocol + hub, REST endpoints
- [x] `/debug/:icao` live table
- [x] `scripts/soak.ts`
- [x] Done when: live aircraft at both airports, provider health visible, 30 min soak with no 429, polling stops with no viewers

### Phase 2: 3D scene

- [x] Cesium viewer, static assets, airport routing
- [x] Photoreal (ion + direct Google key) with automatic fallback
- [x] `scripts/gen-models.ts` and the class models
- [x] AircraftLayer: interpolation buffer, extrapolate + fade, heading freeze, pitch, ground clamping
- [x] Label overlay with declutter, selection card, view presets, follow camera
- [x] Done when: aircraft sit on taxiways at KIND, no jitter, wheels on the runway, 60 fps with 150 simulated aircraft

### Phase 3: Schematic mode and polish

- [x] Overpass loader + OSM→GeoJSON, schematic layers
- [x] Trails, phase colours
- [x] Aircraft list, METAR + active runway hint, source health panel, outbound links
- [x] Keyboard shortcuts, mobile landscape layout, attribution footer
- [x] Replay mode (`?replay=…`) + `scripts/record.ts`
- [x] Done when: the app is usable with no token at all, and a recording plays back

### Phase 4: Cameras

- [x] Camera registry + players (YouTube, HLS, MJPEG, snapshot, iframe, go2rtc)
- [x] PiP, split and grid layouts
- [x] View cones, Match view, overlay mode
- [x] Allowlisted proxy, go2rtc compose profile
- [x] Admin page: discovery (YouTube, Windy), approval queue, pose editor
- [x] `docs/ADDING_A_CAMERA.md`
- [ ] Discovery checked against real YouTube and Windy results (needs API keys; see DECISIONS D-052)

### Phase 5: Ship

- [x] Unraid template, GHCR release workflow, Dependabot, gitleaks
- [x] Compose profile `receiver` (ultrafeeder, dump978)
- [x] README with real screenshots (Playwright, `pnpm screenshots`)
- [x] `docs/RECEIVER.md`, `docs/ADDING_AN_AIRPORT.md`, `ATTRIBUTION.md`
- [x] Tag `v0.1.0`

### After 0.1.0

- [x] The scene stopped with "This object was destroyed" when an aircraft left (D-068); a scene that fails for
      any reason is built again (D-069)
- [x] Photoreal on phones (D-070 to D-073)
- [x] A picture of the aircraft type when there is no photo of the aircraft (D-074, D-075)
- [x] Aircraft on the ground jumped 100 m up and back in Photoreal, and left spikes in their trails (D-076); a check
      that compares heights with what is drawn (D-077)
- [x] The sky follows the sun over the airport, with local time, sunrise and sunset in the panel (D-078, D-079); no
      more wall of rough tiles when the view turns (D-080)
- [x] Tried at KORD, KMDW, KFWA, KDEN, KDTW, KLAN, KDAY and WSSS (`ADDING_AN_AIRPORT.md`); vehicles are not aircraft (D-081), the FAA link
      is left out where it does not apply (D-082), Google's limit per minute is waited out (D-083)

### Not verified, for want of hardware, accounts or keys

Each is recorded in DECISIONS.md with what was checked instead.

- [ ] The Unraid template through the web UI's Add Container form (the rest was checked on Unraid 7.2.0,
      D-067), and Zoraxy (D-061)
- [ ] A local receiver with real hardware; the `receiver` compose profile (D-065)
- [ ] YouTube and Windy discovery against real search results (D-052)
- [ ] airplanes.live and OpenSky with credentials (D-011, D-016)
- [ ] Frame rate on integrated graphics (D-038), and on real phones (D-072)
- [ ] A `kind-busy` recording, and taxiway alignment at KIND with taxiing traffic (D-041, D-047)

## Per-phase gate

`pnpm lint && pnpm typecheck && pnpm test && docker build` must pass, PLAN.md gets ticked, then a conventional commit.
