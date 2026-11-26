# Adding a camera

TowerCab ships with no cameras. There is no dependable list of public live streams for an airport, and a
guessed address is worse than none, so every camera is one you add yourself: in `config.yaml`, or by approving
something the discovery helper found.

A camera shows up behind the **Cameras** button (key `C`) on its airport's page: in a window over the 3D view,
beside it, in a grid with the airport's other cameras, or, when you have told TowerCab where the camera stands,
laid over the 3D view with the aircraft labels drawn on top.

Only add streams you are allowed to show. A public page is not automatically a licence to embed its video.

## A camera entry

```yaml
cameras:
  - id: ramp # letters, digits, "-" and "_"
    airport: KLAF # one of your configured airports
    name: Ramp, looking north
    kind: youtube # see the table below
    source: "VIDEO_ID"
    attribution: Example Flying Club # shown under the picture
    link: "https://example.org/webcam" # where the credit links to
    enabled: true
```

The file is re-read while the server runs. An entry that does not make sense is refused with a message in the
log, and the previous configuration stays in force.

| `kind`     | `source`                                              | Notes                                                                                                          |
| ---------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `youtube`  | The video id of the live stream, or its address       | Played with YouTube's own player. See [YouTube](#youtube).                                                     |
| `hls`      | Address of an `.m3u8` playlist                        | Needs the stream's server to allow other sites to load it, or `proxy: true`.                                   |
| `mjpeg`    | Address of a Motion JPEG stream                       | Typical for older IP cameras. Usually needs `proxy: true` when TowerCab is served over https.                  |
| `snapshot` | Address of a picture, or `windy:<webcam id>`          | Reloaded every `refreshSeconds` (default 30).                                                                  |
| `iframe`   | Address of a page                                     | Last resort: shows the whole page in a frame. Sites that forbid framing get an "Open in new tab" link instead. |
| `webrtc`   | Name of a stream in [go2rtc](#your-own-camera-go2rtc) | For your own RTSP camera.                                                                                      |

## YouTube

Use the id of the live video: the part after `v=` in its address, or just paste the address.

```yaml
- {
    id: spotters,
    airport: KIND,
    name: Spotters,
    kind: youtube,
    source: "https://www.youtube.com/watch?v=VIDEO_ID",
  }
```

Two things to know:

- **A stream's id changes when the stream is restarted.** A "24/7" stream that goes down and comes back has a
  new id, and the old one then says the video is unavailable. Update the entry, or run discovery again.
- **A channel cannot be used in place of a video.** YouTube has an address that is meant to show whatever a
  channel is streaming now (`embed/live_stream?channel=…`), but it is not in Google's documentation and it
  failed for both channels it was tried with in November 2026, so TowerCab does not accept channel ids.

If the owner has switched off embedding, the player says so and offers the link to YouTube instead.

## When to use `proxy: true`

A browser may only load an HLS playlist from another site if that site says so (CORS headers), and a page
served over https may not load pictures or video from a plain http address. Many cameras fail one or both.
For those, let the TowerCab server fetch the stream:

```yaml
proxy:
  allowlist:
    - cams.example.org # that host, on port 443 (https) or 80 (http)
    - 192.168.1.20:8080 # a camera on your own network, by address and port

cameras:
  - {
      id: gate,
      airport: KLAF,
      name: Gate,
      kind: mjpeg,
      source: "http://192.168.1.20:8080/video",
      proxy: true,
    }
```

The proxy is deliberately narrow:

- It serves only cameras marked `proxy: true`, by their id. A browser cannot hand it an address.
- It fetches only from hosts on `proxy.allowlist`, and checks every redirect against the list again.
- A host _name_ on the list may not resolve to an address on a private network, so that an outside site
  cannot point its name at a device in your home. A camera on your own network is listed by its address.
  (`proxy.allowPrivateAddresses: true` lifts this if you use local names.)
- An HLS stream usually loads its segments from other hosts (a CDN); list those too, for example
  `"*.cdn.example.org"`. The server log names any host it refused.
- A camera address with a user name and password in it is accepted only with `proxy: true`, so the password
  never reaches a browser.

Proxied video uses your server's bandwidth for every viewer. Prefer a direct stream where one works.

## Your own camera (go2rtc)

For an RTSP camera, TowerCab works with [go2rtc](https://github.com/AlexxIT/go2rtc), which the compose file
includes as an optional service:

```sh
mkdir go2rtc
cp docker/go2rtc.example.yaml go2rtc/go2rtc.yaml   # then add your camera under `streams:`
docker compose --profile cameras up -d
```

`go2rtc/go2rtc.yaml` holds your camera's address and password; the folder is in `.gitignore`.

```yaml
# go2rtc/go2rtc.yaml
streams:
  ramp: rtsp://user:password@192.168.1.50:554/stream1
```

```yaml
# TowerCab config.yaml
go2rtc:
  url: "http://go2rtc:1984"
cameras:
  - { id: ramp, airport: KLAF, name: Ramp, kind: webrtc, source: ramp }
```

go2rtc's own web interface can change its configuration and run programs, so the compose file does not
publish it, and TowerCab passes on only two things from it: its player script, and the stream of a camera
that is listed in TowerCab's config. Viewers reach the stream through TowerCab's own address, so it works
behind your reverse proxy and over https with no extra hostnames.

For the lowest latency, browsers on your network can connect to go2rtc directly (WebRTC, port 8555, which the
compose file publishes): set `webrtc.candidates` in `go2rtc.yaml` to your server's address, as the example file
shows. Without it, or from outside your network, the video travels through TowerCab instead.

On Unraid, run go2rtc as a container of its own on the same Docker network as TowerCab, and point
`go2rtc.url` at it.

## Where the camera is: poses

Tell TowerCab where a camera stands and where it points, and three things appear:

- a see-through **view cone** in the 3D scene (click it to open the camera);
- **Match view**, which puts the 3D camera in the same place, looking the same way;
- **Overlay**, which draws the camera's picture over the 3D view with the aircraft labels on top, and a
  slider for how much of the picture shows.

```yaml
pose:
  lat: 40.4148
  lon: -86.9333
  heightM: 12 # lens height above the ground
  headingDeg: 230 # compass direction of the middle of the picture
  pitchDeg: -4 # 0 is level, negative looks down
  hfovDeg: 55 # how wide the picture is, in degrees
```

Typing these is tedious; the admin page does it with the mouse (next section). How well the overlay lines up
depends on how well the pose matches reality. A wide-angle lens bends straight lines, which the 3D view does
not imitate, so expect labels to drift towards the edges of such a picture.

## The admin page

`/admin` exists only when the server has an admin token:

```sh
ADMIN_TOKEN=a-long-random-string
```

Without one, the page says that admin is off and every admin address answers as if it did not exist. With
one, the page asks for it and sends it with each request. Ten wrong tokens from one address lock that address
out for ten minutes. Put TowerCab behind https before using this over the internet.

On the page you can:

- **Set a pose.** Choose "Set pose" on a camera, click on the ground where the camera stands, drag the yellow
  handle to turn it and the blue handle to set how much it sees, fine-tune with the sliders, check with "Look
  through it", and save. For a camera from `config.yaml` the saved pose takes the place of the one in the file
  until you remove it on the page.
- **Search for cameras** (discovery), and decide about what was found.

## Discovery

Off by default. To use it:

```yaml
discovery:
  enabled: true
```

and set `YOUTUBE_API_KEY` and/or `WINDY_API_KEY`:

- **YouTube Data API v3.** Create an API key in the Google Cloud console with the YouTube Data API enabled.
  TowerCab asks for live videos located within `youtubeRadiusKm` of the airport, and for three keyword
  searches (`"KLAF live"`, `"<city> airport live"`, `"plane spotting <city>"`): four calls per search.
  Google's documentation gave `search.list` an allowance of 100 calls a day when this was written.
- **Windy Webcams API v3.** A free key from api.windy.com. TowerCab asks for webcams within `windyRadiusKm`.
  Most are stills that update every few minutes. On the free tier a picture's address stops working about
  ten minutes after it was issued, so the server fetches a fresh one when a viewer needs it. Windy's terms
  are followed: the picture is loaded from Windy's own address, never enlarged, links to the webcam's page
  on Windy, and "Windy.com" is credited in the footer.

A search runs only when you press the button, and at most once per `intervalHours` (6 by default) per airport;
in between, the last results are kept. Everything found lands in a queue. **Nothing in the queue is shown to
viewers until you approve it**, and a camera you reject stays rejected when it is found again.

The keys travel in request headers, not in addresses, and are never sent to a browser.

These two integrations were written from the providers' documentation and checked against their real error
responses, but not against real search results, because no keys were available during development. If a
search fails or finds less than it should, the server log has the provider's answer; please open an issue.

## ATC audio

The radio in the side panel plays stations you configure, such as a receiver of your own; it links to the
airport's page on LiveATC and does not play or re-stream LiveATC's audio. [RADIO.md](RADIO.md) has the details.
