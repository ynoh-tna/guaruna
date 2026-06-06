# Guaruna

**Free, open-source running tools that run entirely in your browser.** No account, no ads, nothing uploaded. Plus a small, self-hostable GPX route database.

Live at [guaruna.com](https://guaruna.com).

---

## Tools

- **GPX viewer** — drop a `.gpx` to see your route on a real map (Leaflet + OpenStreetMap), with distance, elevation, pace, an elevation profile and per-km splits.
- **GPX editor** — trim, split or merge tracks by dragging handles on the map and the elevation profile.
- **GPX converter** — convert GPX to GeoJSON, CSV, KML or TCX.
- **GPX cleaner** — simplify and shrink a GPX (Ramer-Douglas-Peucker), remove pauses, smooth elevation.
- **Race planner** — goal pace and km-by-km splits.
- **Race predictor** — predict times across distances (Riegel's formula).
- **Heart-rate zones** — 5 training zones via %HRmax or Karvonen.
- **Pace converter** — pace to speed, both ways.
- **GPX database** — a small community library of routes (FastAPI + SQLite): browse, search, download, or add your own.

The tools are plain HTML/CSS/vanilla JS and parse your GPX **in the browser** — nothing is uploaded. The only server-side part is the GPX database API.

---

## Self-host with Docker (recommended)

```bash
git clone https://github.com/ynoh-tna/guaruna.git
cd guaruna
docker compose up -d
```

Open <http://localhost:8123>. A single container serves both the tools and the GPX database API. The SQLite database and uploaded routes persist in `./data` and `./uploads`.

To enable route moderation (delete buttons), set a secret in `docker-compose.yml`:

```yaml
environment:
  GUARUNA_ADMIN_TOKEN: "a-long-random-secret"
```

Then open `/gpx-database?admin=a-long-random-secret` to get delete buttons.

---

## Run locally without Docker

```bash
python -m venv server/.venv
server/.venv/bin/pip install -r server/requirements.txt   # Windows: server\.venv\Scripts\pip
server/.venv/bin/uvicorn server.app:app --port 8123
# open http://localhost:8123
```

In dev, uvicorn serves the static site too, so `/api` is same-origin.

---

## Configuration (environment variables)

| Variable               | Default                 | Purpose                                                                         |
| ---------------------- | ----------------------- | ------------------------------------------------------------------------------- |
| `GUARUNA_ADMIN_TOKEN`  | empty                   | Enables route deletion. Empty disables it.                                      |
| `GUARUNA_SERVE_STATIC` | `1`                     | Serve the static site from the app. Set `0` if a separate web server serves it. |
| `GUARUNA_DB`           | `server/data/routes.db` | SQLite database path.                                                           |
| `GUARUNA_UPLOADS`      | `routes/uploads`        | Uploaded GPX directory.                                                         |

---

## GPX database API

Under `/api`:

| Method | Path                                                           | Purpose                                           |
| ------ | -------------------------------------------------------------- | ------------------------------------------------- |
| GET    | `/api/routes?q=&page=1`                                        | Paginated list (50/page), search by name/location |
| POST   | `/api/routes` (multipart: `name`, `file`, optional `location`) | Upload a route                                    |
| DELETE | `/api/routes/{id}` (header `X-Admin-Token`)                    | Moderation                                        |
| GET    | `/api/health`                                                  | Health check                                      |

Uploads are validated server-side: `.gpx` extension, ≤ 10 MB, must parse to ≥ 2 track points (via `defusedxml`). Distance and elevation gain are computed on the server. Six seed routes are inserted into an empty database on first start.

---

## Production behind nginx (optional)

A reference config lives in `nginx/guaruna.conf` (TLS, `/api` proxy, rate limiting, caching, gpx mime type). Use it if you prefer to run uvicorn behind nginx rather than exposing the container directly.

---

## Project structure

```
guaruna/
├── public/                   # frontend, served as the web root
│   ├── index.html, *.html    # the tools, one page each
│   ├── tools.js              # tool logic + GPX parser + Leaflet map
│   ├── database.js           # GPX database UI
│   ├── script.js             # header, nav, year, email
│   ├── styles.css
│   ├── vendor/leaflet/       # self-hosted Leaflet
│   └── routes/               # seed routes + uploads/ (gitignored)
├── server/                   # FastAPI + SQLite API
├── nginx/                    # optional reference config
├── Dockerfile
├── docker-compose.yml
├── README.md
└── LICENSE
```

---

## License

MIT — see [LICENSE](LICENSE). Free to use, modify, self-host and redistribute.

## Contributing

Issues and pull requests are welcome. The frontend is plain HTML/CSS/JavaScript with **no build step** — edit a file and refresh. The only dynamic part is the GPX database API under `server/` (FastAPI + SQLite). Nothing in the tools talks to a server: every GPX is parsed in your browser.
