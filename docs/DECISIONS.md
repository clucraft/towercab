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
