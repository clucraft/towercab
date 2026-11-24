# Fixtures written from documentation

Unlike everything one folder up, the files here are **not captured responses**. They were written by hand from
the providers' documentation as read on 2026-11-24, because no API key was available to capture real ones.
Every id, name and address in them is made up (`example.test`, `AAAAAAAAAAA`).

| File                  | Follows                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `youtube-search.json` | YouTube Data API v3 `search.list` response (`youtube#searchListResponse`, `youtube#searchResult`) |
| `windy-webcams.json`  | Windy Webcams API v3 `GET /webcams/api/v3/webcams` response (`total`, `webcams[]`)                |

Replace them with captured responses once a key exists, and move them up a folder. The parsers that read them
(`src/cameras/discovery.ts`) take only the fields they need, so a field the documentation got wrong shows up
as a missing camera, not as a crash. The error responses one folder up (`youtube-error-*.json`,
`windy-error-*.json`) are real.
