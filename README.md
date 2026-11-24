# TowerCab

Live aircraft around an airport in a 3D scene, like the view from the tower cab, in a browser.

> **Not for navigation or operational use.**

_Screenshot placeholder: real captures are added once the 3D scene exists._

## Status

Early build. See [docs/PLAN.md](docs/PLAN.md) for the phase checklist and [docs/DECISIONS.md](docs/DECISIONS.md)
for the decision log.

## Quick start

```sh
docker compose up -d --build
```

Then open <http://localhost:8790>. The health check is at `/healthz`.

On first start the server copies [config/config.example.yaml](config/config.example.yaml) to
`/config/config.yaml`. Edit that file to add airports or sources; changes are picked up while the server runs.

## Development

Requires Node 24 and pnpm 10.

```sh
pnpm install
pnpm dev        # server on :8790, web app on :5173 (proxying /api and /ws to the server)
pnpm check      # lint, typecheck, tests
pnpm build
```

In development the server keeps its config and data in a gitignored `.local/` folder at the repo root.
Set `CONFIG_DIR` and `DATA_DIR` to use other folders.

## Environment variables

Every variable is optional. See [.env.example](.env.example).

| Variable                                     | Purpose                                                      |
| -------------------------------------------- | ------------------------------------------------------------ |
| `PORT`                                       | Port the server listens on. Default `8790`.                  |
| `PUBLIC_URL`                                 | Public URL when behind a reverse proxy.                      |
| `TZ`                                         | Time zone for logs.                                          |
| `LOG_LEVEL`                                  | `trace`, `debug`, `info`, `warn` or `error`. Default `info`. |
| `CESIUM_ION_TOKEN`                           | Cesium ion token for photorealistic tiles and terrain.       |
| `GOOGLE_MAPS_API_KEY`                        | Google Map Tiles API key, as an alternative to ion.          |
| `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET` | OpenSky OAuth2 client credentials (fallback source).         |
| `YOUTUBE_API_KEY`, `WINDY_API_KEY`           | Camera discovery (admin only).                               |
| `ADMIN_TOKEN`                                | Enables `/admin`. Admin routes are off when unset.           |

## License

Code: [MIT](LICENSE). Third-party data and models keep their own licenses.
