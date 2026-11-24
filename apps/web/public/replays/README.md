# Recordings

Traffic recordings for replay mode (`/KLAF?replay=klaf-pattern`). One JSON object per line: a `meta` line, then
the same messages the live WebSocket feed carries.

| File                 | What                                                                                   | Source and licence                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `klaf-pattern.jsonl` | 3 min 45 s at Purdue University Airport on 2026-11-24: pattern work, a landing, taxiing | Positions © [adsb.lol](https://adsb.lol) contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) |

Only recordings whose source allows redistribution are kept here. Make your own with `pnpm record`; those go to
`/data/replays/` (or `.local/data/replays/` in development), which is not part of the repository.
