# Adding an airport

An airport is one entry in `config.yaml`. Only its ICAO code is required:

```yaml
airports:
  - icao: KLAF
  - icao: KIND
  - icao: KORD # new
```

Save the file; the server notices within a few seconds and the airport appears in the switcher. No restart.

For each airport the server looks up the reference point, field elevation, name, city and runways in
[OurAirports](https://ourairports.com/data/) (downloaded once and refreshed weekly) and fetches the runway,
taxiway, apron and building outlines from OpenStreetMap through the Overpass API (once per airport, kept for a
week). The public Overpass servers are often busy; the server retries, and the page picks the layout up when it
arrives. Until then Schematic shows the runways from OurAirports only.

The code must be the one OurAirports knows the airport by (`KORD`, not `ORD`): its identifier, ICAO code or GPS
code, three or four letters or digits.

## Everything an entry can hold

```yaml
airports:
  - icao: KLAF
    # How much traffic to show.
    radiusNm: 6 # around the reference point (default 6, at most 40)
    ceilingFtAgl: 5000 # above field elevation (default 5000)

    # Which view the page opens with: tower | overhead | orbit | rwy-<designator>, e.g. rwy-10
    defaultView: tower

    # The control tower, for the Tower cab view.
    tower: { lat: 40.414761, lon: -86.933297, heightM: 23, approximate: true }

    # Override what OurAirports says. Rarely needed.
    name: Purdue University Airport
    city: West Lafayette
    # lat, lon, elevationFt: the reference point and field elevation

    # For the clock, sunrise and sunset in the side panel. Found from the position when left out.
    timezone: America/Indiana/Indianapolis

    # Override the links in the side panel (liveatc, diagram, flightaware).
    links:
      liveatc: "https://www.liveatc.net/search/?icao=KLAF"
```

### Radius and ceiling

The point of the scene is the traffic at the field: the pattern, arrivals, departures and the ground. A radius
of 6 to 10 NM and a ceiling of 5,000 to 8,000 ft keeps it to that. A larger area means more aircraft to draw
and, with the public data sources, nothing gained on the ground.

### The tower

The Tower cab view needs to know where the tower is. In order of preference the server uses:

1. `tower` in the config entry;
2. a tower mapped in OpenStreetMap inside the airport (`aeroway=control_tower`, `building=control_tower`, or
   `man_made=tower` with `tower:type=airport_control`), when there is one;
3. nothing: the Tower cab button is then switched off for that airport, with a note saying why.

To add one by hand you need a position and an eye height. For US airports the FAA's Digital Obstacle File
lists control towers with surveyed positions and heights; that is where the values for KLAF and KIND in the
example config come from. `heightM` is the height of the controllers' eyes above the ground, a little below
the top of the structure. Mark it `approximate: true` unless you surveyed it.

### The time zone

The clock, sunrise and sunset in the side panel are in the airport's time zone, found from its position with a small
table that can be wrong close to the border between two zones: of 32 US airports checked, many of them picked for being
near one, KTEL was an hour out. If yours is, put its `timezone` in, by its
[IANA name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones). The sky does not depend on it.

### Ground traffic

Public ADS-B services see little on the ground: their receivers are rarely close enough to an airport to hear
aircraft on the taxiways. If aircraft appear only once airborne, that is why, and the answer is
[your own receiver](RECEIVER.md) near the field.

## Removing an airport

Delete its entry. Browsers looking at it are told the airport is no longer available. The files cached for it
under `/data` can be left; they are small.
