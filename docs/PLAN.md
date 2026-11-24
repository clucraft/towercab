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
    public/models/             generated low-poly GLBs + ATTRIBUTION.md
    e2e/                       Playwright smoke test
  packages/shared/
    src/                       schemas, messages, geo, altitude, type table lookup
    data/aircraft-types.json
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

- [ ] Overpass loader + OSM→GeoJSON, schematic layers
- [ ] Trails, phase colours
- [ ] Aircraft list, METAR + active runway hint, source health panel, outbound links
- [ ] Keyboard shortcuts, mobile landscape layout, attribution footer
- [ ] Replay mode (`?replay=…`) + `scripts/record.ts`

### Phase 4: Cameras

- [ ] Camera registry + players (YouTube, HLS, MJPEG, snapshot, iframe, go2rtc)
- [ ] PiP, split and grid layouts
- [ ] View cones, Match view, overlay mode
- [ ] Allowlisted proxy, go2rtc compose profile
- [ ] Admin page: discovery (YouTube, Windy), approval queue, pose editor

### Phase 5: Ship

- [ ] Unraid template, GHCR release workflow, Dependabot, gitleaks
- [ ] README with real screenshots (Playwright)
- [ ] `docs/RECEIVER.md`, `docs/ADDING_AN_AIRPORT.md`, `ATTRIBUTION.md`
- [ ] Tag `v0.1.0`

## Per-phase gate

`pnpm lint && pnpm typecheck && pnpm test && docker build` must pass, PLAN.md gets ticked, then a conventional commit.
