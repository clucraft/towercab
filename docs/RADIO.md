# The radio

The side panel has a radio: the station's name and frequency on a small display, a light that shows when it is on
the air, a signal meter, play and pause, station buttons when there is more than one, and the volume. `R` plays and
stops it. While it plays, a pill over the scene shows the station and stops it when clicked, also with the side
panel closed.

Stopping drops the connection rather than pausing it, so nothing is downloaded while the radio is off, and playing
again starts at what is being said now. Switching to another airport stops it.

TowerCab ships with no stations. An airport without one shows "No feed" and a link to its page on LiveATC.

## Stations

Stations belong to an airport in `config.yaml`:

```yaml
airports:
  - icao: KLAF
    audio:
      - name: Purdue Tower
        frequency: "118.300"
        url: "http://192.168.1.20:8000/klaf-twr.mp3"
        proxy: true
        attribution: My receiver at the field
      - name: Purdue Ground
        frequency: "121.700"
        url: "http://192.168.1.20:8000/klaf-gnd.mp3"
        proxy: true

proxy:
  allowlist: ["192.168.1.20:8000"]
```

| Field         | Required | Meaning                                                                                 |
| ------------- | -------- | --------------------------------------------------------------------------------------- |
| `name`        | yes      | What the display shows, up to 40 characters.                                            |
| `url`         | yes      | The stream, http or https. An Icecast or Shoutcast mount in MP3 works in every browser. |
| `frequency`   | no       | Shown on the display, followed by "MHz". TowerCab tunes nothing.                        |
| `proxy`       | no       | `true`: the server fetches the stream and passes it on. Default `false`.                |
| `attribution` | no       | A credit line under the radio, such as who runs the receiver.                           |
| `link`        | no       | Where the credit line links to.                                                         |

Up to eight stations per airport. The order in the file is the order of the station buttons.

### Through the server, or straight from the stream

Without `proxy`, every listener's browser fetches the stream from `url` itself. That works for a stream with a
public https address.

With `proxy: true`, the server fetches it and passes it on, as it does for cameras:

- a receiver on your own network can be heard from outside it, where nobody can reach `192.168.1.20`;
- a plain http stream can be played on an https site, where the browser would refuse it;
- the address, with any user name and password in it, stays on the server.

The stream's host has to be on `proxy.allowlist`, the same list the camera proxy uses; the browser only ever asks
for "station 0 of KLAF", never for an address. Each listener holds one connection to your receiver for as long as
the radio plays, and the server allows 24 at a time. Only audio is passed on: a page or anything else from that
address is refused.

The signal meter shows the sound's level for stations that come through the server. For one played straight from
another site the browser does not let the page look at the sound, and the meter shows a steady line instead.

## A receiver of your own

What you need is a USB radio stick that covers the VHF airband (118 to 137 MHz; the common RTL-SDR dongles do),
an antenna, and two pieces of free software:

1. [RTLSDR-Airband](https://github.com/rtl-airband/RTLSDR-Airband) receives AM voice channels and can send each one
   as an MP3 stream to an Icecast server. One dongle covers about 2.5 MHz, and several channels inside that range can
   be received at the same time. Its wiki has a page on
   [Icecast outputs](https://github.com/rtl-airband/RTLSDR-Airband/wiki/Configuring-Icecast-outputs); there is a
   Docker image, `ghcr.io/rtl-airband/rtlsdr-airband`.
2. [Icecast](https://www.icecast.org) is the server the streams go to and listeners fetch them from. Each channel
   gets its own mount point.

An output in RTLSDR-Airband's configuration looks like this (from its wiki; the values are placeholders):

```
outputs: (
  {
    type = "icecast";
    server = "icecast.server.example.org";
    port = 8080;
    mountpoint = "TWR.mp3";
    username = "source";
    password = "mypassword";
  }
);
```

The station's `url` in TowerCab is then `http://<icecast host>:<port>/<mount point>`, with `proxy: true` and that
host and port on the allowlist. None of this was tried with real hardware while TowerCab was written; the proxy is
tested against a stand-in stream.

Listening to aircraft radio is legal in many countries, not in all. LiveATC's FAQ, for one, explains why there are
no feeds from the United Kingdom. Check where you are, and whether passing it on to others is allowed there too.

## LiveATC

LiveATC.net relays volunteers' receivers near many airports, and TowerCab links to its page for each airport. It does not
play LiveATC's streams, because LiveATC's [terms of use](https://www.liveatc.net/legal/) (read on 2026-11-25) do not
allow that without them:

- the service is for personal, non-commercial use;
- 3.15: linking directly to their audio streams needs consulting LiveATC first, and then a prominent credit with a link
  to www.liveatc.net;
- 3.3: their service may not be made available over another network, which rules out passing a stream on through
  this server;
- every page of the site also says that their streams may not be used in third-party products.

If LiveATC gives you permission, add their stream as a station **without** `proxy`. TowerCab then adds the credit
"Audio from LiveATC.net" with a link to their site by itself, and refuses `proxy: true` for any address on
liveatc.net. Ask through their [contact form](https://www.liveatc.net/ct/contact.php).

Their FAQ says the audio usually arrives less than 20 seconds after it was spoken. The 3D scene is about 2.5 seconds
behind, so with LiveATC the voices come after the aircraft they are about. A receiver of your own is close to live.
