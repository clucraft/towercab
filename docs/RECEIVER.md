# Your own receiver

The public ADS-B services TowerCab uses are fed by volunteers' receivers. Those are rarely close enough to an
airport to hear aircraft on the ground, so with public data alone a taxiing aircraft often shows up only as it
lifts off. The dependable way to see the ramp and the taxiways is a receiver of your own with a clear view of
the field.

TowerCab reads any receiver that serves readsb's `aircraft.json`: readsb with tar1090, the
[ultrafeeder](https://github.com/sdr-enthusiasts/docker-adsb-ultrafeeder) container, and most ready-made feeder
images. When the local receiver and a public source both report an aircraft, the fresher position is used, and
your receiver wins a tie.

**This has not been tried with real hardware during development.** The reader is tested against real
`aircraft.json` data from the public services, which use the same format, and the compose profile below
follows the sdr-enthusiasts documentation as read in November 2026. If something here is wrong, please open an
issue.

## What you need

- An RTL-SDR USB dongle and an antenna for 1090 MHz, placed where it can see the airport. Height and a clear
  line of sight matter more than anything else; a window facing the field beats a better antenna in a basement.
- In the United States, optionally a second dongle and antenna for 978 MHz (UAT), which many light aircraft
  below 18,000 ft use instead of 1090 MHz. At a training airport that can be a large share of the traffic.
- A machine near the antenna to plug the dongle into: the one that runs TowerCab, or any other on your network.

## If you already run a receiver

Point TowerCab at its `aircraft.json`. In `config.yaml`:

```yaml
providers:
  readsb:
    enabled: true
    priority: 0
    url: "http://192.168.1.60:8080/data/aircraft.json" # your tar1090 or ultrafeeder address
```

Open that address in a browser first: it should show a JSON document with an `aircraft` list.

For lower latency, readsb can also push every position as it is received (its JSON position output, port 30047
in ultrafeeder). TowerCab then reads that instead of asking for the file:

```yaml
providers:
  readsb:
    enabled: true
    url: "http://192.168.1.60:8080/data/aircraft.json"
    stream: { host: 192.168.1.60, port: 30047 }
```

The public sources can stay enabled alongside; they fill in what your antenna cannot see.

## Starting one with the compose file

The compose file has an optional `receiver` profile with ultrafeeder (1090 MHz) and dump978 (978 MHz):

```sh
cp docker/receiver.env.example receiver.env   # then fill it in
docker compose --env-file .env --env-file receiver.env --profile receiver up -d
```

With a single dongle, start only ultrafeeder and leave `ULTRAFEEDER_CONFIG` empty in `receiver.env`:

```sh
docker compose --env-file .env --env-file receiver.env --profile receiver up -d ultrafeeder
```

`receiver.env` holds:

| Setting                         | Meaning                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `FEEDER_LAT`, `FEEDER_LONG`     | Where the antenna is, in decimal degrees                                                |
| `FEEDER_ALT_M`                  | Antenna height above sea level, metres                                                  |
| `ADSB_SDR_SERIAL`               | Serial number of the 1090 MHz dongle; may stay empty when only one dongle is plugged in |
| `UAT_SDR_SERIAL`                | Serial number of the 978 MHz dongle                                                     |
| `ADSB_SDR_GAIN`, `UAT_SDR_GAIN` | Gain; the defaults let the software choose                                              |
| `ULTRAFEEDER_CONFIG`            | `adsb,dump978,30978,uat_in` to take UAT data from dump978; empty without it             |
| `ULTRAFEEDER_PORT`              | Host port for ultrafeeder's own map (default 8080)                                      |

The file says where your antenna is, so it is in `.gitignore`.

Then switch the source on in TowerCab's `config.yaml`. Inside the compose network ultrafeeder is reachable by
name, and the default address already points at it:

```yaml
providers:
  readsb: { enabled: true, priority: 0 }
  # same as: url: "http://ultrafeeder/data/aircraft.json"
  # optional: stream: { host: ultrafeeder, port: 30047 }
```

### Two dongles

With two dongles each container has to be told which one is its own, by serial number. Many dongles ship with
the same serial; the RTL-SDR tools include `rtl_eeprom` for writing a new one. The sdr-enthusiasts
documentation walks through it.

### Is it working?

- ultrafeeder's own map is at `http://<host>:8080`. Aircraft there means the dongle and antenna work.
- In TowerCab, the side panel's **Data sources** section lists "Local receiver" with the time of its last
  answer, and `/debug/KLAF` shows which source each aircraft's position came from.

### Feeding

ultrafeeder can also feed the sharing networks, which is what keeps the public services alive. The profile
here configures none of that: it only receives. To feed, add the networks to `ULTRAFEEDER_CONFIG` as the
ultrafeeder documentation describes. The networks TowerCab reads from (adsb.fi, adsb.lol, airplanes.live) all
welcome feeders.

## Unraid

Run ultrafeeder as its own container with the USB dongle passed through, on the same Docker network as
TowerCab, and set `providers.readsb.url` to its address. The settings are the same as in the table above; the
sdr-enthusiasts README lists every one.
