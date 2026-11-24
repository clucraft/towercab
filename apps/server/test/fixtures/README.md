# Test fixtures

Real responses captured on 2026-11-24, trimmed only where noted. They exist so the parsers are tested against
what the services actually send. Do not hand-edit them; re-capture instead.

| File | Source | Licence / terms |
|---|---|---|
| `adsblol-v2-kind.json`, `adsblol-v2-klaf.json` | `https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{nm}` and `/v2/point/{lat}/{lon}/{nm}` | adsb.lol, ODbL 1.0 |
| `adsbfi-v3-kind.json`, `adsbfi-v3-klaf.json` | `https://opendata.adsb.fi/api/v3/lat/{lat}/lon/{lon}/dist/{nm}` | adsb.fi open data, personal non-commercial use, <https://adsb.fi> |
| `adsbfi-v2-legacy-kind.json` | `https://opendata.adsb.fi/api/v2/lat/…` (deprecated; different envelope: `aircraft[]`, `now` in seconds) | adsb.fi open data |
| `airplaneslive-403.json` | `https://api.airplanes.live/v2/point/…` without prior approval: HTTP 403 | airplanes.live |
| `opensky-states-kind.json` | `https://opensky-network.org/api/states/all?lamin=…` (anonymous) | The OpenSky Network, <https://opensky-network.org> |
| `metar-klaf-kind.json` | `https://aviationweather.gov/api/data/metar?ids=KLAF,KIND&format=json` | NOAA/NWS, public domain |
| `ourairports-airports.csv`, `ourairports-runways.csv` | <https://davidmegginson.github.io/ourairports-data/>, header plus the rows for KLAF, KIND, KORD and one heliport | OurAirports, public domain |
| `overpass-klaf.json` | Overpass API query for the KLAF aerodrome (see `src/reference/overpass.ts`) | © OpenStreetMap contributors, ODbL 1.0 |
| `planespotters-a0d5d6.json` | `https://api.planespotters.net/pub/photos/hex/a0d5d6` | planespotters.net; photo © the named photographer |
| `youtube-error-no-key.json`, `youtube-error-invalid-key.json` | `https://www.googleapis.com/youtube/v3/search` without a key (HTTP 403), and with a made-up key in the `X-Goog-Api-Key` header (HTTP 400) | Google |
| `windy-error-no-key.json`, `windy-error-invalid-key.json` | `https://api.windy.com/webcams/api/v3/webcams?nearby=…` without the `x-windy-api-key` header (HTTP 403), and with a made-up key (HTTP 401) | Windy |

`documented/` holds two fixtures that are *not* captures; see the README there.
