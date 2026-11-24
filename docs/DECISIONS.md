# Decisions and deviations

Running log. Each entry says what was decided, and why. Entries marked **Deviation** differ from
[BUILD_PROMPT.md](BUILD_PROMPT.md); entries marked **Verified** record a check against a live API or its docs.

## Process

### D-001 Build prompt stored without the token (Deviation)

The prompt was pasted into the session with a Cesium ion token on its third line. It is saved as
`docs/BUILD_PROMPT.md` with that line removed; the token lives only in the gitignored `.env`.
Reason: rule 5, keep secrets out of git. The repo is going to be public.

### D-002 `docker build` runs through WSL on the dev machine

Docker is not installed on Windows here, but Docker 29 with buildx and compose is available in WSL Ubuntu.
All image builds and `docker compose` checks during development run there against the same working tree.

## Tooling

### D-003 Current toolchain, pinned exactly

Versions were read from the npm registry on 2026-11-24 and pinned without ranges: TypeScript 7.0, Vite 8,
Vitest 5, Biome 2.6, Fastify 5, React 19, Zod 4, CesiumJS 1.147. `@types/node` is held at the 24.x line to
match the Node 24 LTS runtime. Dependabot proposes upgrades from there.

### D-004 Biome instead of ESLint + Prettier

The prompt allows either. Biome is one dependency and one config for both linting and formatting.

### D-005 Shared package is consumed as TypeScript source

`packages/shared` exports its `src/` directly. Vite bundles it into the web app; the server bundle (tsup)
inlines it. No separate build step or watch process for the shared package, and no stale `dist`.

### D-006 `docker-compose.yml` lives at the repo root (Deviation)

The prompt's layout puts compose files under `docker/`. The core compose file sits at the root so that
`docker compose up` works from a fresh clone with no `-f`. `docker/` keeps the Dockerfile and sidecar examples.

## Server

### D-007 `ws` attached to Fastify's HTTP server directly

The hub owns a `WebSocketServer({ noServer: true })` and handles `upgrade` for `/ws` only. No plugin layer
between Fastify and `ws`; one fewer dependency.

### D-008 Application-level ping in addition to protocol pings

Browsers answer protocol pings invisibly, so the page cannot tell a silent connection from a dead one.
The server sends `{type:"ping"}` every 20 s; the client reconnects when nothing arrives for 45 s.

## Client

### D-009 Own interpolation buffer, not `SampledPositionProperty`

The prompt allows either. A small buffer gives direct control over the three rules that matter: render
behind real time, dead-reckon for at most 10 s then fade, and never move an aircraft backwards. It is plain
TypeScript with unit tests and no Cesium dependency.

## Data sources (checked live on 2026-11-24)

Rule 3 of the prompt: where the prompt and the live service disagree, the live service wins. Fixtures of every
response are in `apps/server/test/fixtures/`.

### D-010 adsb.lol has a daily quota, so it is not the primary source (Deviation, Verified)

The prompt lists adsb.lol first with "no key needed". Still true, but its API docs and response headers
(`x-ratelimit-limit: 500, 500;w=86400`) now say **500 requests per day per IP** without a key. At a 2 s poll
that is 17 minutes. So:

- adsb.lol is priority 2, and TowerCab paces it: the remaining quota is spread over a 2 hour horizon
  (14 s between requests at first, longer as the balance shrinks) and the last 5 requests are never spent.
- A new optional variable, `ADSBLOL_API_KEY`, is sent as `x-api-key`. Free keys raise the limit
  (1,000/day by request, 7,200/day for feeders). The real limit is read from the response headers.
- Over quota the service answers 429 with `Retry-After`, which the backoff honours.

### D-011 airplanes.live is off by default (Deviation, Verified)

`GET https://api.airplanes.live/v2/point/…` answered **403**: "Please contact us at contact@airplanes.live.
Your email MUST include any links, a description of the project…". Their terms of use (updated 2025-08-10)
forbid automated access without permission, and the old API guide page is gone (API docs are now at
<https://airplanes.live/api-docs/>, licence "proprietary"). The adapter is kept, because the response format
is the same `ac[]` envelope, but the provider is disabled until the operator has asked for access. If access
comes with a header, `providers.airplaneslive.headers` carries it. No live fixture exists for a successful
answer; the 403 body is saved instead.

### D-012 adsb.fi is the default primary source, on its v3 endpoint (Deviation, Verified)

The prompt's URL (`/api/v2/lat/…/lon/…/dist/…`) still answers but is deprecated and returns a different
envelope (`aircraft[]`, `now` in seconds). The documented endpoint is `/api/v3/lat/{lat}/lon/{lon}/dist/{nm}`,
which returns the common `ac[]` envelope. adsb.fi allows 1 request per second with no daily quota, so it is
the only keyless source that can carry a 2 s poll. The token bucket is set to one request per 1.1 s.
adsb.fi counts 400/401/403/404/429 answers towards a temporary IP ban, so those back off for a long time
(an hour after a refusal, ten minutes after a bad request).

### D-013 One parser for every readsb-format source (Verified)

Confirmed with the fixtures: adsb.lol v2, adsb.fi v3 and airplanes.live v2 share `{ ac: [...], now: <ms> }`;
readsb's own `aircraft.json` and adsb.fi's legacy endpoint use `{ aircraft: [...], now: <s> }`. Per-aircraft
fields are identical. The parser accepts both envelopes and both time units.

### D-014 Which sources are asked in a poll cycle

The prompt does not say whether sources are queried together or one at a time. Chosen to give a fresh answer
every cycle without leaning on free community services harder than needed:

- the local receiver, every cycle;
- the first public source by priority that has a token: this cycle's primary. A poll that is up to 40% of
  the interval early waits for its token instead of being skipped;
- every `polling.secondaryEveryN`-th cycle (default 3), the other public sources too, to fill coverage gaps;
- OpenSky only when no other enabled source is usable.

With two airports watched at once they share adsb.fi's budget, so each gets a poll about every 2.2 s.

### D-015 Position time comes from the service's own clock (Deviation)

The prompt defines freshness as "fetch time minus `seen_pos`". Responses are cached upstream and take time to
arrive, so the response's own `now` is the better reference, and it keeps timestamps comparable between
sources. It is used only while it lies within 10 s before our receive time; otherwise our receive time is used.

### D-016 OpenSky: anonymous or OAuth2, fallback only (Verified)

Token URL and flow as documented (`grant_type=client_credentials`, 30 minute tokens, retry once on 401).
`/api/states/all` with a bounding box also works anonymously (400 credits a day; 4,000 with an account), so
the adapter runs without credentials too. It stays off by default and is only asked when every other source
is failing. Data resolution is 10 s anonymous, 5 s authenticated.

### D-017 Every upstream request carries an identifying User-Agent (Verified)

Overpass answered 406 and planespotters.net 403 ("Generic library User-Agent strings are not accepted") to
default agents. All requests send `TowerCab/<version> (+https://github.com/clucraft/towercab)`; `userAgent`
in config overrides it.

### D-018 Overpass is often at capacity (Verified)

The public instance repeatedly answered 502 "server is currently at capacity… retry using exponential
backoff", and says the endpoint is meant for human-operated tools. TowerCab asks once per airport per week,
retries after 10, 30 and 90 s, then leaves it alone for an hour, and always serves the cached copy.
`overpassUrl` in config points it at another instance.

### D-019 Reference values (Verified)

From OurAirports: KLAF 40.412875, -86.939363, 606 ft; KIND 39.7173, -86.294403, 797 ft. The prompt's rough
values were right. Runways: KLAF 05/23 and 10/28; KIND 05L/23R, 05R/23L and 14/32.
OpenStreetMap has **no control tower mapped at KLAF**, so `tower` stays null there until a position is set
in config.

### D-020 Outbound links

LiveATC (`/search/?icao=`) and FlightAware (`/live/airport/`) deep links were checked. The FAA has no stable
per-airport diagram URL (the path changes every 28-day cycle), so the diagram link is the FAA search page
unless `links.diagram` is set for the airport.

## Altitude and classification

### D-021 `alt_geom` is an ellipsoid height (Verified)

readsb's README-json: "geometric (GNSS / INS) altitude in feet referenced to the WGS84 ellipsoid". It is
converted to metres and used as is. Only barometric altitudes and field elevations go through the geoid.

### D-022 The geoid offset is about -34 m, not -33 m (Verified)

`egm96-universal` gives -34.32 m at KLAF and -34.12 m at KIND. It is computed per airport on the server
and sent to the browser; nothing is hardcoded.

### D-023 Barometric altitudes are also corrected for temperature (Deviation)

The prompt asks for the METAR altimeter correction. On the cold day the fixtures were captured, that alone
left aircraft without `alt_geom` up to 71 m too high at 8,000 ft (52 m for a FedEx 767 at 4,400 ft AGL).
Applying the standard 4 ft per 1,000 ft per degree correction with the METAR temperature brings every
aircraft in the fixtures within 20 m of its own GNSS altitude. Near the ground the correction is close to zero.

### D-024 Altimeter setting without a METAR

When the METAR is unavailable, the median `nav_qnh` reported by the aircraft themselves is used.

### D-025 Ground detection thresholds

`onGround` is true when `alt_baro` is the string `"ground"`; or ground speed is under 40 kt and the altitude
is within 150 ft of field elevation; or the position is over a runway and within 50 ft of field elevation at
any speed. The third rule is what keeps a light aircraft on the surface during its take-off and landing
roll: most never send `"ground"`. Constants and reasons are in `tracking/classify.ts`.

### D-026 An eighth phase, `transit` (Deviation)

The prompt lists seven phases. Traffic crossing the area in level flight is none of them, so it is labelled
`transit` instead of being forced into `arriving` or `departing`.

### D-027 When an aircraft stops being shown

The prompt says to keep an aircraft for 30 s after its last update. Aggregators keep listing an aircraft for
up to 60 s after its last position, so "update" needs defining:

- nothing heard about it for 30 s: removed;
- moving, and its position is more than 30 s old: no longer shown, even if a source still lists it;
- standing still on the ground: shown for as long as a source lists it. Surface positions arrive rarely with
  weak reception, and a parked aircraft has not moved.

While polling slowly (no viewers) these limits stretch with the interval.

### D-028 ADS-B is not displaced by TIS-B or MLAT for the same address

A less accurate position type may only replace a better one once the better one is 10 s old.

## Server, continued

### D-029 `/metrics` is written by hand

A dozen gauges and counters in the Prometheus text format; no metrics library.

### D-030 Aircraft photos are looked up by the server

`/api/photos/:hex` asks planespotters.net with the identifying User-Agent and caches the answer in memory.
The browser loads the thumbnail from planespotters' own CDN, shows the photographer's name and links to the
photo page, as their API requires.

### D-031 SQLite arrives with the camera queue

Phase 1 needs no database: OurAirports and OSM are cached as plain files, as the prompt specifies.
`better-sqlite3` is added in Phase 4 with the discovery queue.
