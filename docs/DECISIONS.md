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

## 3D scene

### D-032 Google Map Tiles policy, re-checked (Verified)

Read on 2026-11-24 (<https://developers.google.com/maps/documentation/tile/policies>). What it means here:

- No pre-fetching, caching or storing of tiles beyond what the HTTP cache headers allow, and no content
  derived from them. TowerCab never proxies or saves tiles; the browser talks to Google or Cesium ion directly.
  Surface heights read from the tiles to stand aircraft on them are kept in memory for the session and never
  written or sent anywhere.
- Overlaying non-Google data is allowed, with its attribution kept separate from Google's. Even so, the
  prompt's rule is kept: the OpenStreetMap layout is drawn in Schematic only. Photoreal shows our own
  aircraft, labels and trails over the tiles.
- The Google Maps logo and data attribution must stay visible. They are shown by Cesium's credit display
  inside the 3D view (`showCreditsOnScreen: true`); the app's own credits are in a separate footer below it.

### D-033 How Photoreal is reached, and when it gives up

With `GOOGLE_MAPS_API_KEY` the tiles come straight from the Map Tiles API; otherwise through Cesium ion
(`createGooglePhotorealistic3DTileset`, signature checked in CesiumJS 1.147). The scene falls back to
Schematic with a notice when: the tileset cannot be created; a tile request is refused (401, 403) or over
quota (429); twelve tiles fail within 20 s; or no tiles have arrived after 25 s of rendering. That last
timer counts rendered frames only, so a tab left in the background does not trip it.

### D-034 Surface heights: read from loaded tiles, not `sampleHeightMostDetailed` (Deviation)

The prompt suggests `sampleHeightMostDetailed` or `clampToHeight`. Measured with 60 aircraft on the ground at
KIND, `sampleHeightMostDetailed` managed about 13 points a second and held the frame rate at 9 fps while it
worked; ground aircraft were still waiting for their height after 40 s. Photoreal therefore uses
`Cesium3DTileset.getHeight` (with `enableCollision`), which reads the tiles that are loaded: synchronous,
about a millisecond a point, and it puts an aircraft on the surface exactly as it is drawn. (It does not: since
D-076 the tiles are read directly, and the grid keeps the best reading.) Details:

- heights are kept on a 10 m grid for 20 s, then read again, so aircraft follow the tiles as they refine;
- at most three reads per frame, shared round-robin between aircraft;
- the value used is the median of the cell and its four diagonal neighbours, which ignores the lump left
  where an aircraft stood when the photogrammetry was captured, without dropping through a bridge;
- a value more than 120 m from field elevation is discarded (coarse far-away tiles can be that wrong);
- while a new cell is being read, an aircraft keeps the height it last stood on.

Schematic with terrain uses `sampleTerrainMostDetailed` in batches with the same grid. The aircraft
themselves are never part of a sample.

### D-035 Flat Schematic measures heights from the field

With no ion token there is no terrain, and the globe surface is the ellipsoid. Everything is then drawn
relative to field elevation: the ground is at zero and an aircraft at 1,000 ft above the field is 305 m up.
Switching base map moves the camera by the difference, so the view does not jump.

### D-036 Labels are drawn on a 2D canvas over the scene

Not Cesium labels. A canvas of our own allows real overlap avoidance (greedy placement over eight slots
around each aircraft, most important first, each label keeping last frame's slot when it can), leader lines,
and later the same labels over a webcam picture.

### D-037 Aircraft models

`scripts/gen-models.ts` generates one low-poly glTF per class with gltf-transform: 14 classes, 84 to 616
triangles each. Every model is exactly one wingspan wide and stands on Y = 0, so scaling by the real wingspan
draws it at real size with its wheels on the ground. Scale is uniform; a stretched variant (A321 against
A319) has the right span and a slightly wrong length. There is no minimum pixel size: aircraft are their real
size at any distance, and the label marker is what makes a distant one findable.

### D-038 Frame rate, measured

KIND, 150 simulated aircraft, 1600 x 900, Chromium with the GPU on (`pnpm probe`), on the development
machine (RTX 5090, 16-core CPU; well above "mid-range", so the throttled figures matter more):

| Case          | Schematic                                          | Photoreal                     |
| ------------- | -------------------------------------------------- | ----------------------------- |
| As is         | 60 fps (display cap), 0.9 ms of our code per frame | 60 fps, 3.3 ms                |
| CPU slowed 2x | not measured                                       | 50 fps before the fixes below |
| CPU slowed 4x | 47 fps                                             | 17 fps                        |

The GPU cannot be slowed the same way, so integrated graphics are not covered by these numbers; Photoreal on
integrated graphics is the case to check on real hardware. Two things found on the way:

- Cesium builds a dynamic environment map per model. With 150 moving models that cost more than the rest of
  the frame together (4x CPU: 27 to 47 fps in Schematic, 7 to 17 in Photoreal). It is switched off; a fixed
  directional light is used instead.
- Per-frame work is spread out: surface reads are rationed, trails rebuild five times a second.

### D-039 Tower positions come from the FAA Digital Obstacle File (Verified)

OpenStreetMap has no control tower mapped at KLAF or KIND. The FAA DOF dated 2026-11-22 lists both as
`CTRL TWR`: KIND 18-002631 at 39°42'31.20"N 086°18'16.05"W, 348 ft AGL; KLAF 18-023128 at 40°24'53.14"N
086°55'59.87"W, 84 ft AGL (accuracy code 1A: within 20 ft horizontally, 3 ft vertically). The example config
carries them with an eye height a little below the top of the structure, marked approximate.

### D-040 The scene runs 2.5 s behind, on a slewed clock

The prompt says about 2 s. With a 2 s poll plus up to a second of upstream latency, 2.5 s keeps the scene
interpolating rather than dead-reckoning almost all the time; `client.renderDelayMs` changes it. The estimate
of the server's clock is slewed at 2% rather than applied at once: a 20 ms correction applied in one frame
moves an aircraft on final by more than a metre.

### D-041 Simulated traffic and measured acceptance checks

`?sim=150` replaces the live feed with deterministic simulated traffic (circuits to every runway end, taxiing,
parked). `pnpm verify:scene` then measures what Phase 2 promises, frame by frame in a real browser: no jumps,
no backward steps, no heading snaps, ground aircraft within 0.5 m of the surface, and a landing aircraft on
the surface 1.5 s after touchdown. It passes in both base maps with simulated traffic and with live traffic
at both airports. Taxiway alignment was spot-checked with live data: at KLAF 173 of 173 ground positions from
six aircraft were on mapped taxiway or apron.

## Polish and replay

### D-042 The runway hint is a guess from the wind, and says so

The side panel ranks runway ends by headwind component from the METAR and names the best one, with its
headwind and crosswind. With calm or variable wind it names none. It does not look at which runway traffic is
actually using, and the wording says it is a guess: the tower decides, not the wind.

### D-043 How the aircraft list is grouped

Six groups in the order a tower would care about them: Departing (takeoff roll and climbing out), Arriving
(final and landing roll), Pattern, Taxiing, Parked, Passing through. The prompt lists the phases but not the
grouping; rolls are folded into their direction so the list does not reshuffle for the few seconds a roll lasts.

### D-044 Small screens

At 900 px wide or 520 px high and below (a phone held sideways), the side panel starts closed and opens over
the scene instead of beside it, the top bar and the footer become single rows that scroll sideways, the
selection card moves to the left without its photo, and the badges move to the bottom. Portrait phones work
but are not the target.

### D-045 Imagery credits are named in the footer as well

Cesium draws the Google and Cesium ion credits inside the 3D view, as their terms require. The footer repeats
the imagery providers by name next to the data credits so everything used is listed in one place.

### D-046 adsb.lol has a short-term limit that is not published (Verified, Deviation)

The docs and the `x-ratelimit-*` headers describe only the daily quota (500 requests without a key). On
2026-11-24 adsb.lol also answered HTTP 429 after nine requests two seconds apart, and again after about 80
requests in ten minutes at seven seconds apart, both times with more than half the daily quota left; a minute
later it answered normally. How that limit is counted is not known. The built-in interval is therefore 10 s,
as a cautious default rather than a known-safe figure, and config may lower it to 3 s at most. In normal use
this hardly matters: adsb.fi is the primary source, adsb.lol is asked on every third cycle at most, and the
quota pacing spreads its 500 requests so that they are minutes apart.

### D-047 Replay: what ships, and what is yours to record

`?replay=<name>` plays `/replays/<name>.jsonl`: the same messages the WebSocket would carry, shifted to the
present and looped. `pnpm record` makes them, either from a running server's feed or (`--direct`) from one
source through the server's own tracker.

- The recording that ships (`klaf-pattern`) was made from adsb.lol only, because its data is ODbL and may be
  redistributed with attribution. adsb.fi's terms allow personal, non-commercial use, not redistribution, so
  nothing recorded from it is committed. Recordings made from a server's mixed feed are written to
  `.local/data/replays/` (or `/data/replays/` on a deployed server), which git ignores.
- It asks every 7 s because of D-046, so positions are 7 s apart, and a recording of more than a few minutes
  may be cut short by adsb.lol (the recorder stops at the first refusal and keeps what it has). The file
  states its spacing (`intervalMs`), and playback then draws `intervalMs + 1.5 s` behind instead of the usual
  2.5 s, so aircraft still move between known positions rather than being guessed ahead.
- `klaf-pattern` is 3 min 45 s at KLAF on 2026-11-24: six aircraft, one of them flying the pattern, landing
  and taxiing in. `pnpm verify:scene --airport KLAF --replay klaf-pattern --seconds 215` checks it frame by
  frame like the simulated traffic.
- Sparse data showed one flaw: the drawn "on the ground" state changed halfway between the last report in the
  air and the first on the ground, while the aircraft was still metres up. It now changes at touchdown (and at
  lift-off): an aircraft is on the ground only between two reports that both say so.
- The prompt asks for `kind-busy` as well. A busy period at KIND is the overnight FedEx push; it was not
  recorded during the build. `pnpm record --airport KIND --minutes 10 --out kind-busy` records it from your
  own server when the time is right.

### D-048 Secret scanning in CI runs gitleaks directly

`gitleaks-action` scans `first-commit^..last-commit` on a push, which fails on the very first push of a
repository (the first commit has no parent). CI downloads a pinned gitleaks release, checks it against the
checksum published with that release, and scans the whole history instead.

## Cameras

### D-049 A registry with two sources, and one place that decides what viewers are told

Cameras come from `cameras:` in the config file and from the discovery queue once approved (SQLite). The
registry merges them and is the only code that builds what `/api/cameras/:icao` returns. A viewer's browser
gets a camera's own address only when it is meant to load it directly; a proxied camera is known to it only as
`/proxy/camera/<id>`, and a camera that cannot play (no go2rtc address, no Windy key, a source that does not
fit its kind) arrives with the reason instead of an address. The config loader refuses the same mistakes up
front, so they are found when the file is edited rather than when someone opens the camera.

### D-050 The proxy cannot be used as an open proxy (Verified by tests)

The prompt's rule, made concrete in `cameras/proxy.ts` and `routes/cameras.ts`:

- only `GET`; only http and https; only cameras marked `proxy: true`, addressed by id;
- only hosts on `proxy.allowlist` (`host`, `host:port`, `*.domain.tld`, or an address), re-checked on every
  redirect, at most three of them;
- a host name on the list may not resolve to a private, loopback or link-local address unless
  `proxy.allowPrivateAddresses` is set. The check runs inside the connection's own DNS lookup, so a name
  cannot be re-pointed between check and use. A camera on the home network is allowed by listing its address;
- a browser never supplies an address. Things an HLS playlist refers to are fetched through
  `/proxy/camera/<id>/r?u=…&s=…`, where `u` is an address the server itself wrote into that camera's playlist
  and `s` is an HMAC over camera id and address with a key made at start-up;
- nothing of the viewer's request goes to the camera except a well-formed byte range, and nothing of the
  camera's headers comes back except content type, length and range. A snapshot must be an image, an MJPEG
  stream must be `multipart/x-mixed-replace`, a playlist must start with `#EXTM3U`, a segment must be media;
- refusals tell the viewer nothing about hosts or addresses; the detail goes to the server log.

Tested against real HTTP servers on the loopback interface (`cameraProxy.test.ts`, `cameraRoutes.test.ts`) and,
by hand, against go2rtc and an ffmpeg HLS stream.

### D-051 YouTube: video ids only; the channel "live" embed is not offered (Deviation, Verified)

The prompt allows "a live video ID or a channel's live embed". The player is the documented IFrame Player API
(`https://www.youtube.com/iframe_api`, `new YT.Player`, `mute()` then `playVideo()` on ready, `onError` codes
2, 5, 100, 101, 150, 153). A real 24/7 airport stream played through it on 2026-11-24.

The channel form (`https://www.youtube.com/embed/live_stream?channel=<id>`) is not in Google's player
parameter documentation. Tried the same day with two channels that were live, one with several streams and one
with a single stream, it showed "This video is unavailable" both times while those channels' videos played by
id. So a `youtube` source must be a video id or a video's address; the config loader recognises a channel and
says what to use instead. The cost: a stream that restarts gets a new id and the entry has to be updated (or
discovery run again). Resolving a channel's current live video through the Data API would fix that and is left
for later.

### D-052 YouTube and Windy discovery follow the documentation; real results were never seen (Unverified)

No API keys were available, so:

- Verified live: the endpoints exist and answer without a key and with a made-up key exactly as saved in
  `test/fixtures/youtube-error-*.json` and `windy-error-*.json`. The YouTube Data API reads the key from the
  `X-Goog-Api-Key` header (a made-up key in the header gets "API key not valid", no key gets "Permission
  denied"), so the key is sent there and never appears in an address or a log line. Windy names its header in
  its own error message: `x-windy-api-key`.
- Not verified: the shape of successful responses. The parsers are written from the documentation
  (`search.list` with `part=snippet`, `type=video`, `eventType=live`, `location`, `locationRadius`, `q`; Windy
  `GET /webcams/api/v3/webcams?nearby=lat,lon,km&include=images,location,urls` and `/webcams/{id}`), take only
  the fields they need, and are tested against hand-written fixtures kept apart in `test/fixtures/documented/`.

Differences from the prompt, from the documentation as read on 2026-11-24:

- `search.list` is now documented with its own allowance of 100 calls a day at one unit each, not 100 units
  per call. A search for one airport is four calls.
- Windy's documentation says a free-tier image address expires after 10 minutes; its pricing page says 15.
  The server asks for a fresh one once its copy is 8 minutes old.

Windy's terms shaped the design: the picture is loaded by the browser from the address Windy issued (the
server answers `/api/cameras/<id>/image` with a redirect to it, and does not pass the picture through),
it is never drawn larger than it is, it links to the webcam's page, and Windy is credited.

### D-053 Discovery runs when asked, not on a timer (Deviation)

The prompt says to run discovery "at most every 6 hours per airport and cache the results". It runs when an
admin presses the button, and the same search is not sent again inside `discovery.intervalHours`; in between,
the stored results are what the page shows. A timer would spend a small daily allowance on results nobody is
waiting to review. After a failed search the next try is allowed after ten minutes.

### D-054 The camera queue is SQLite through better-sqlite3 12, not 13

`/data/towercab.db` holds the queue, the poses set on the admin page and the time of each search. Version
12.11.1 is pinned because it installs a prebuilt binary for Node 24 on every platform involved (Windows x64,
Linux x64, Alpine x64 and arm64 were checked in its release); version 13 compiles from source on every install
and needs a C++ toolchain, which the development machine does not have. If the database cannot be opened the
server says so and runs on: cameras from the config file still work.

### D-055 The admin API

Off unless `ADMIN_TOKEN` is set: without it every `/admin/api/*` path answers with the same 404 as a path that
never existed. With it, each request carries the token as a bearer token (so there is no cookie for another
site to ride on), compared in constant time; ten wrong tokens from one address lock that address out for ten
minutes. The page keeps the token in the tab's session storage. A pose saved on the page for a camera from the
config file is stored in the database and takes precedence over the file until it is removed on the page; the
page says so.

### D-056 go2rtc is reached only through TowerCab

go2rtc's API can rewrite its configuration and start programs, and its README warns about exposing it. The
compose profile does not publish its port. TowerCab passes on two things: go2rtc's own player script
(`video-rtc.js`, `video-stream.js`, so the player always matches the go2rtc that is running), and the stream
WebSocket `/api/ws?src=<name>` for a name that belongs to an enabled `webrtc` camera; `dst` (publishing) is
never passed on. Everything is same-origin, so it works behind Zoraxy and over https. Checked with go2rtc
1.9.15 and a synthetic stream: video arrives over the WebSocket (MSE); direct WebRTC needs `webrtc.candidates`
set in go2rtc, because inside a container it cannot know the host's address.

go2rtc's own HLS output was a poor test source: on a cold start its first segments could not be parsed by
hls.js, and its playlist holds one second. The HLS player was tested against an ffmpeg stream instead, and
gained a watchdog that restarts a stream after ten seconds without progress.

### D-057 View cones, Match view, overlay

A camera with a pose is drawn as a 450 m view cone. Match view gives the 3D camera the pose and the camera's
horizontal field of view. In overlay mode the picture sits between the 3D canvas and the label canvas, fitted
whole into the view; the 3D field of view is widened when the view is wider than the picture so the two line
up, and the mouse is locked out so they stay lined up. A picture whose shape is not known (YouTube, framed
pages) is taken as 16:9. Lens distortion is not modelled, so labels drift towards the edges of a wide-angle
picture. The pose editor on the admin page: click the ground to place the camera, drag one handle for
direction and one for field of view, sliders for tilt and height.

### D-058 Shutting down does not wait for open connections

Someone watching an MJPEG camera holds a connection open for as long as they watch. The server now closes all
connections on shutdown (`forceCloseConnections`), so `docker stop` is not held up until the kill time-out.

## Shipping

### D-059 The receiver images are not pinned

`ghcr.io/sdr-enthusiasts/docker-adsb-ultrafeeder` and `docker-dump978` are used at `latest`, against the rule
to pin dependencies: the project's own documentation and compose examples use the rolling tag. They are
optional companions in a compose profile, not part of TowerCab's image. Everything in the profile (image
names, the USB device rules, the environment variables, `adsb,dump978,30978,uat_in`) is taken from their
READMEs as read on 2026-11-24.

### D-060 Screenshots show Schematic only

`pnpm screenshots` captures the README pictures from a running server with Playwright. They are taken in
Schematic mode with the shipped recording, so they hold only open data. Photoreal is left out because Google's
3D tiles may be displayed but not stored, and the aircraft photo in the details card is blanked because it
belongs to its photographer. The camera picture shows a go2rtc test pattern: there is no real camera to show.

### D-061 The Unraid template and the reverse proxy were written, not tried (Unverified)

`unraid/towercab.xml` follows the template guide at selfhosters.net and two current templates (element names,
`Config` attributes, `[IP]:[PORT:8790]`). It has not been loaded on an Unraid server. The folder for user
templates could only be found in a summary of the Unraid forum's Docker FAQ, not in Unraid's documentation,
and the README says so. Zoraxy was not available either: its README states that WebSockets are proxied
automatically, and nothing in TowerCab needs more than that.

### D-062 The server starts even when it cannot write to its folders

Docker creates a missing host folder as root, and the container runs as an ordinary user, so a first
`docker run -v /some/new/folder:/config` used to end with "permission denied". Now an unwritable config folder
means the built-in example config (and the file is picked up as soon as it appears), and an unwritable data
folder means a temporary one. Both say so in the log, with the user id to give access to. Checked in a
container with root-owned bind mounts, with `--user 99:100`, and with a read-only config mount.

### D-063 Release workflow

Every push to main builds amd64 and arm64 and pushes `latest` and `sha-<commit>` to
`ghcr.io/clucraft/towercab`; a `v*.*.*` tag adds the version and `major.minor`. arm64 is built under QEMU,
which is slow but needs no second runner. GitHub creates a new package as private: making it public, so that
Unraid can pull it without a login, is a one-time step for the repository owner.

### D-064 View cones appear with the cameras, not all the time (Deviation)

The prompt has cameras with a pose "appear as see-through view cones in the scene". Drawn permanently, a few
cones 450 m long cover a small airfield. A camera is always marked by a dot that opens it when clicked; the
cones and names are drawn while the cameras are open, and on the admin page.

### D-065 The local receiver path has never seen a receiver (Unverified)

The readsb reader is tested against real `aircraft.json` documents from the public services, which use the
same format. Its reader for readsb's position stream (port 30047) is tested only with a line written by hand
from readsb's documentation. No RTL-SDR was available, so neither a real ultrafeeder nor the `receiver`
compose profile has been run. docs/RECEIVER.md says this at the top.

### D-066 Weather for several viewers at once

Found while taking the screenshots: when several browsers opened an airport in the same moment, the first
request fetched the METAR and the others were told there was none. They now wait for the same fetch.

### D-067 Deployed on Unraid 7.2.0; what that confirmed (Verified)

First deployment, on an Unraid 7.2.0 server over SSH. Read from that server's own Docker manager
(`/usr/local/emhttp/plugins/dynamix.docker.manager/include`):

- user templates live in `/boot/config/plugins/dockerMan/templates-user` (`DockerClient.php`), named
  `my-<name>.xml`. This settles the open point in D-061;
- for a path that does not exist yet, the Docker manager makes the folder and gives it to user 99, group 100
  (`Helpers.php`: `mkdir`, `chown 99`, `chgrp 100`). Folders made that way on the server were mode 0755, so
  the image's default user (1000) could not have written to them. The template therefore sets
  `--user 99:100` under Extra Parameters; the image runs as any user (checked: config copied, database
  created, no warnings);
- every container it creates gets `--pids-limit 2048`, the variables `TZ`, `HOST_OS`, `HOST_HOSTNAME`,
  `HOST_CONTAINERNAME`, and the labels `net.unraid.docker.managed`, `.webui` and `.icon`.

The container was created with those same parameters and the template's values, and the template was placed
in the templates folder. Afterwards the Docker manager's own lookup returned that template for the container,
the health check passed, and a browser on another machine showed live traffic at KIND in Photoreal at 60 fps.
Not done: creating the container by clicking through Add Container in the web UI, and the reverse proxy.

### D-068 Trails shared a material, and the scene stopped when an aircraft left (Fix)

Reported from use: "An error occurred while rendering. This object was destroyed." Trails of one phase of flight
shared one Cesium `Material`. Removing a line from a `PolylineCollection` destroys its material
(`Polyline.prototype._destroy` in Cesium 1.147), so the first aircraft to leave took away the material of every
other trail in its phase, and of every later one. Each line now has a material of its own; Cesium groups lines by
colour, so they are still drawn together. A unit test and a browser test were seen to fail on the old code.

### D-069 A scene that fails is built again

Cesium stops for good after an error while drawing, and cannot recover from a lost graphics context, which on a
phone mostly means that memory ran out. Its error panel is switched off. Instead the page builds a new scene with
the same view, base map and selection, while the traffic feed carries on. If it was Photoreal that lost the
context, or failed twice, the new scene is in Schematic. After three new scenes in two minutes the page gives up,
says so, and offers to reload.

### D-070 Production builds leave out Cesium's debug checks

Cesium's sources check the arguments of every matrix and vector function inside `//>>includeStart('debug')`
blocks, which its own release build strips. Imported as ES modules they were all still there (5,476 blocks). A
small Vite plugin removes them when building, the same way. With the processor slowed six times, Schematic went
from 52 to 59 frames a second. Development and unit tests keep the checks.

### D-071 What made Photoreal slow on phones

Measured with `pnpm profile:phone --software --slowdown 4`: a phone-sized touch screen in Chromium, the processor
slowed four times and drawing done in software, so that the cost of drawing shows. 0.1.0 ran at 13 to 15 frames a
second. The time went into three things:

- Reading heights from the tiles. In WebGL 2 Cesium does this by reading vertex buffers back from the graphics
  processor, which first has to finish everything queued: 36 to 43 ms of every frame. `enableCollision` did it
  whenever the view moved; our own surface probes did it all the time. Collision is now off and the camera is kept
  above ground by the probes, which remember their answers and may take a fixed share of the time (12 percent, 6 on a
  phone) however slow they are.
- Walking the tree of tiles every frame. While the view is still and everything has arrived, the answer cannot
  change, so the last one is kept (`debugFreezeFrame`, a public property in spite of its name). Frozen tiles are not
  marked as in use, so this is only done while the cache has room; otherwise Cesium would unload what is on screen.
- Antialiasing and order-independent transparency: extra full-screen passes.

Also found: the cache limits for Google's tiles are 1.5 GB plus 1 GB by default, and an environment map was
computed for tiles that are unlit.

### D-072 Quality profiles, and a governor (Unverified on real phones)

`lite` for a touch screen, 4 GB of memory or less, or two threads or fewer; `high` otherwise; `?quality=` decides
for both. Lite draws at about 30 frames a second with a 160 MB tile cache. A governor steps the detail down while
the scene is slow and never back up, except that lite tries a sharper picture once, when it has run well for ten
seconds, and keeps it only if it still does. Frames drawn while tiles arrive count half.

On the stand-in: loading 13 to 30 frames a second, settled 15 to 31 (the limit), turning 14 to 31; time spent
waiting for the graphics processor 36 to 43 ms a frame down to under 2; tile memory 154 MB to 54. No real phone was
available; the stand-in says where the time goes, not what a given phone will reach.

### D-073 `skipLevelOfDetail` for Google's tiles

From the KLAF tower the ground in front of the camera stayed a blur: a tile 1.5 km across that never refined
although all eight of its children were there. Cesium's default traversal refines a tile only when every
descendant with content has loaded, and counts an empty tile that is out of view and fine enough already as not
loaded. (Its source says so, and makes an exception for vector tilesets only.) The other traversal has no such rule. It
shows the airfield sharply from the tower and loads half as many tiles (157 instead of 330). No artefacts were
seen in the tower, overhead, orbit and runway 10 views. There was one, in the heights of aircraft: D-076.

### D-074 A picture of the type when there is none of the aircraft

Many light aircraft have no photo on planespotters.net: of the three KLAF aircraft in the test data, one has. The
next best thing is a picture of the type. Wikidata was the obvious source and has no property for ICAO type designators (checked
on 2026-11-24), and Wikipedia's own list of designators leaves out light aircraft. So the table from designator to
article (`type-articles.json`, 476 designators) is written by hand, and `pnpm check:types` checks every row: the
designator against ICAO Doc 8643 (`doc8643.icao.int`), the article against Wikipedia (exists, not a disambiguation
page, has a free lead image), and the two names against each other. The first run caught four designators that
were remembered wrongly.

Only the article's title is in the repository. The picture's address, author and licence are asked for when needed
(Wikipedia's `pageimages`, then Commons' `imageinfo`), so they stay right when a file is replaced or Wikimedia
moves its thumbnails, which now come from thumb.wikimedia.org. Nothing is shown without a licence, the
caption says that it is not this aircraft, and the file's page is linked.

### D-075 Manners towards Wikimedia

From its published rules, read on 2026-11-24: one request at a time, answers cached (seven days, one day for "none"),
a User-Agent that says who is asking, a standard thumbnail width (500), hotlinking allowed with the credit the
licence asks for. While testing with an anonymous client the API answered 429 after some twenty requests in a few minutes; the
server treats that as "ask again in ten minutes", not as "there is no picture". planespotters.net's API page refuses
to be read by a program (403), so its other endpoints were left alone.

### D-076 Aircraft on the ground jumped 100 m up and back (Fix)

Reported with a picture on 2026-11-25: spikes in the trails of two aircraft taxiing at KLAF, and the aircraft going
up and down. The data was fine; the server had both on the ground, without a height, throughout. The browser looks
the height up in Google's tiles, and that went wrong in three steps:

- Several tiles can cover a point at once: while finer ones arrive, and with `skipLevelOfDetail` (D-073) also
  afterwards. Cesium draws the finest, but `Cesium3DTileset.getHeight` answers with the first it meets in the order
  of their bounding spheres, which is the roughest. A tile of 2055 m has its surface 103 m above KLAF's taxiways.
- The limit of 120 m against field elevation lets 103 m through.
- Trails used what had been read when the aircraft passed and never read it again, so the aircraft came down and the
  spike stayed.

It was there in 0.1.0, and D-073 made it about three times as frequent: with the same camera moves 9.4 percent of readings
were more than 40 m off instead of 3.4. In the tower view at KLAF, freshly opened, it also put aircraft 3.4 m (median)
above the taxiway.

Now the finest tile at the point is read; tiles rougher than 150 m are not read at all; a rough reading never
replaces a fine one, and is read again every second while anything is loading. The points of a trail are looked up
with what the aircraft leave over, take the median of five in a row (the roof of a hangar beside the taxiway), and
where nothing is known that of the nearest point instead of the official elevation. Measured while zooming and
changing views: aircraft parked at KLAF moved up and down by as much as 118 m, all 16 of them by more than 40, and now
by 1.2 m at most; at KIND 8.8 m, now 2.7. No slower on the stand-in for a phone (31 frames a second, 1.2 instead of 1.7 ms
a frame spent reading).

This uses two things of Cesium that are not public, the list of tiles in use and looking for a point in one. The version is
pinned, and a test fails if an upgrade takes them away.

### D-077 `pnpm verify:surface` compares heights with the depth buffer

`verify:scene` compared aircraft with the scene's own lookup and passed all along while the lookup was wrong. The
new check compares the lookup with what is on screen: along the runways, in three views, it asks the depth buffer what
is drawn at a pixel and the lookup how high that point is; then it moves the camera about and watches for readings that
stray. It agrees to a centimetre at KLAF and KIND. Two traps on the way there: `pickPosition` remembers its answers by the
text of the position it is given, which is the same for every plain object; and with antialiasing the depth of a
pixel can be that of something at its edge.
