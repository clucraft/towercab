# TowerCab

Live aircraft around an airport in a 3D scene, like the view from the tower cab, in a browser.

> **Not for navigation or operational use.**

_Screenshots are added with the first release._

## Status

Working: live traffic from public sources or your own receiver, the 3D scene in two base maps (Photoreal and
Schematic), views, labels, trails, the side panel (aircraft list, weather, source health), replay, and live
cameras with an admin page. Still to come: the Unraid template and published images. See [docs/PLAN.md](docs/PLAN.md) for the phase
checklist and [docs/DECISIONS.md](docs/DECISIONS.md) for the decision log.

## Quick start

```sh
docker compose up -d --build
```

Then open <http://localhost:8790>. The health check is at `/healthz`.

On first start the server copies [config/config.example.yaml](config/config.example.yaml) to
`/config/config.yaml`. Edit that file to add airports or sources; changes are picked up while the server runs.

## Using it

`/` lists the configured airports; `/KLAF` opens one.

| Key      | Does                                           |
| -------- | ---------------------------------------------- |
| `1`      | Tower view                                     |
| `2`      | Overhead view                                  |
| `3`      | Next runway end (press again for the next one) |
| `4`      | Orbit the field                                |
| `5`, `F` | Follow the selected aircraft                   |
| `C`      | Open or close the cameras                      |
| `S`      | Switch between Photoreal and Schematic         |
| `Esc`    | Clear the selection                            |

Add these to an airport URL:

| Parameter              | Does                                                                        |
| ---------------------- | --------------------------------------------------------------------------- |
| `?mode=schematic`      | Start in the Schematic base map (needs no token). `photoreal` is the other. |
| `?view=overhead`       | Start in a view: `tower`, `overhead`, `orbit` or a runway end.              |
| `?replay=klaf-pattern` | Play a recording instead of live traffic.                                   |
| `?sim=150`             | Show that many simulated aircraft instead of live traffic.                  |
| `?fps`                 | Show the frame rate.                                                        |

`/debug/KLAF` shows the same traffic as a table with source health, and `/metrics` has Prometheus metrics.

### Cameras

TowerCab ships with no cameras: add the streams you have checked yourself. A camera can be a YouTube live
video, an HLS or MJPEG stream, a picture that reloads, a page in a frame, or your own RTSP camera through
[go2rtc](https://github.com/AlexxIT/go2rtc). It shows in a window over the 3D view, beside it, in a grid, or,
once you have told TowerCab where the camera stands, as an overlay with the aircraft labels drawn over the
picture. The `/admin` page (set `ADMIN_TOKEN`) places cameras in the scene with the mouse and can search
YouTube and Windy for cameras near an airport; nothing it finds is shown until you approve it.

[docs/ADDING_A_CAMERA.md](docs/ADDING_A_CAMERA.md) has the details.

### Replay

`/KLAF?replay=klaf-pattern` plays a few minutes of real traffic at KLAF, recorded from adsb.lol (ODbL), in a
loop. It needs no data source and no token in Schematic mode, so it is the quickest way to see the app work.

To make your own recording from a running server:

```sh
pnpm record --airport KIND --minutes 10 --out kind-busy
```

The file lands in `.local/data/replays/`; on a deployed server put it in `/data/replays/` and open
`/KIND?replay=kind-busy`. Recordings made this way contain whatever sources your server used, so check their
terms before sharing one.

## Development

Requires Node 24 and pnpm 10.

```sh
pnpm install
pnpm dev        # server on :8790, web app on :5173 (proxying /api and /ws to the server)
pnpm check      # lint, typecheck, tests
pnpm build
pnpm test:e2e   # Playwright smoke test against the built app
```

Tools for checking the scene in a real browser: `pnpm probe` (frame rate, screenshots), `pnpm verify:scene`
(no jumps, no backward steps, wheels on the ground) and `pnpm soak` (30 minutes against the live sources,
fails on any rate-limit answer).

In development the server keeps its config and data in a gitignored `.local/` folder at the repo root.
Set `CONFIG_DIR` and `DATA_DIR` to use other folders.

## Environment variables

Every variable is optional. See [.env.example](.env.example).

| Variable                                     | Purpose                                                           |
| -------------------------------------------- | ----------------------------------------------------------------- |
| `PORT`                                       | Port the server listens on. Default `8790`.                       |
| `PUBLIC_URL`                                 | Public URL when behind a reverse proxy.                           |
| `TZ`                                         | Time zone for logs.                                               |
| `LOG_LEVEL`                                  | `trace`, `debug`, `info`, `warn` or `error`. Default `info`.      |
| `CESIUM_ION_TOKEN`                           | Cesium ion token for photorealistic tiles and terrain.            |
| `GOOGLE_MAPS_API_KEY`                        | Google Map Tiles API key, as an alternative to ion.               |
| `ADSBLOL_API_KEY`                            | adsb.lol API key. Without one adsb.lol allows 500 requests a day. |
| `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET` | OpenSky OAuth2 client credentials (fallback source).              |
| `YOUTUBE_API_KEY`, `WINDY_API_KEY`           | Camera discovery on the admin page; Windy webcam pictures.        |
| `ADMIN_TOKEN`                                | Enables `/admin`. Admin routes do not exist when unset.           |

## Data sources

The server fetches traffic once per airport and fans it out to browsers over WebSocket; browsers never call
these services. Limits below were checked in November 2026 and are enforced by the server.

| Source                                             | Default            | Limit                                     | Terms                                                  |
| -------------------------------------------------- | ------------------ | ----------------------------------------- | ------------------------------------------------------ |
| Your own receiver (readsb / tar1090 / ultrafeeder) | off                | none                                      | yours                                                  |
| [adsb.fi](https://adsb.fi)                         | on, preferred      | 1 request per second                      | personal, non-commercial use; credit and link required |
| [adsb.lol](https://adsb.lol)                       | on                 | 500 requests a day without a key (1)      | ODbL; attribution required                             |
| [airplanes.live](https://airplanes.live)           | off                | by agreement                              | ask `contact@airplanes.live` for access first          |
| [OpenSky Network](https://opensky-network.org)     | off, fallback only | 400 credits a day (4,000 with an account) | research and non-commercial use                        |

(1) adsb.lol also refuses bursts well inside that allowance, so the server asks it at most every 10 seconds.

Airport and runway data come from [OurAirports](https://ourairports.com/data/) (public domain), the airport
layout from [OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL), weather from
[aviationweather.gov](https://aviationweather.gov), aircraft photos from
[planespotters.net](https://www.planespotters.net).

## License

Code: [MIT](LICENSE). Third-party data and models keep their own licenses.
