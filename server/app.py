"""
Guaruna — GPX database API (FastAPI + SQLite)

Endpoints (all under /api, proxied by nginx):
  GET    /api/routes?q=&page=1     -> paginated list (50/page) with search
  POST   /api/routes               -> upload (multipart: name, file=.gpx)
  DELETE /api/routes/{id}          -> moderation (requires X-Admin-Token)
  GET    /api/health               -> {"ok": true}

Uploaded files are stored under <repo>/routes/uploads/<uuid>.gpx, which nginx
serves statically at /routes/uploads/... The frontend opens them in the GPX
analyzer via /gpx-analyzer?gpx=<path> and offers a direct download.

Run (dev):   uvicorn server.app:app --reload --port 8001
Run (prod):  uvicorn server.app:app --host 127.0.0.1 --port 8001
"""
import math
import os
import re
import sqlite3
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

try:
    from defusedxml.ElementTree import fromstring as xml_fromstring
except Exception:  # fallback if defusedxml is missing (less safe)
    from xml.etree.ElementTree import fromstring as xml_fromstring

# ---- paths & config ----
BASE_DIR = Path(__file__).resolve().parent.parent          # repo root
STATIC_DIR = Path(os.environ.get("GUARUNA_STATIC", BASE_DIR / "public"))   # frontend served by the app
UPLOADS_DIR = Path(os.environ.get("GUARUNA_UPLOADS", STATIC_DIR / "routes" / "uploads"))
DB_PATH = Path(os.environ.get("GUARUNA_DB", BASE_DIR / "server" / "data" / "routes.db"))
ADMIN_TOKEN = os.environ.get("GUARUNA_ADMIN_TOKEN", "")     # empty disables delete
SERVE_STATIC = os.environ.get("GUARUNA_SERVE_STATIC", "1") == "1"  # serve static too (dev); harmless in prod (nginx only proxies /api)

PER_PAGE = 50
MAX_BYTES = 10 * 1024 * 1024         # 10 MB upload cap
MAX_NAME = 80
RATE_MAX = 10                        # uploads ...
RATE_WINDOW = 3600                   # ... per hour per IP

UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

SEED_ROUTES = [
    ("paris-seine-loop", "Seine & Tuileries Loop", "Paris, France", 5.0, 53),
    ("london-hyde-park", "Hyde Park Loop", "London, UK", 7.0, 32),
    ("nyc-central-park", "Central Park Loop", "New York, USA", 10.0, 130),
    ("amsterdam-vondel", "Vondelpark Round", "Amsterdam, NL", 4.0, 11),
    ("berlin-tiergarten", "Tiergarten Run", "Berlin, Germany", 6.0, 28),
    ("barcelona-beach", "Barceloneta Beachfront", "Barcelona, Spain", 8.0, 21),
]

_rate = {}  # ip -> [timestamps]


# ---- db ----
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = db()
    conn.execute(
        """CREATE TABLE IF NOT EXISTS routes (
            id            TEXT PRIMARY KEY,
            name          TEXT NOT NULL,
            location      TEXT,
            distance_km   REAL NOT NULL DEFAULT 0,
            elevation_gain INTEGER NOT NULL DEFAULT 0,
            path          TEXT NOT NULL,
            created_at    TEXT NOT NULL,
            is_seed       INTEGER NOT NULL DEFAULT 0,
            thumb         TEXT DEFAULT ''
        )"""
    )
    # migrate older databases that predate the thumbnail column
    cols = [r[1] for r in conn.execute("PRAGMA table_info(routes)")]
    if "thumb" not in cols:
        conn.execute("ALTER TABLE routes ADD COLUMN thumb TEXT DEFAULT ''")

    n = conn.execute("SELECT COUNT(*) AS c FROM routes").fetchone()["c"]
    if n == 0:
        ts = "2026-05-01T07:00:00+00:00"
        for rid, name, loc, km, gain in SEED_ROUTES:
            path = f"/routes/{rid}.gpx"
            conn.execute(
                "INSERT OR IGNORE INTO routes (id,name,location,distance_km,elevation_gain,path,created_at,is_seed,thumb)"
                " VALUES (?,?,?,?,?,?,?,1,?)",
                (rid, name, loc, km, gain, path, ts, read_thumb_for(path)),
            )

    # backfill thumbnails for any rows that don't have one yet
    for r in conn.execute("SELECT id, path FROM routes WHERE thumb IS NULL OR thumb=''").fetchall():
        t = read_thumb_for(r["path"])
        if t:
            conn.execute("UPDATE routes SET thumb=? WHERE id=?", (t, r["id"]))

    conn.commit()
    conn.close()


# ---- gpx parsing / metrics ----
def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def haversine(a, b):
    R = 6371000.0
    dlat = math.radians(b[0] - a[0])
    dlon = math.radians(b[1] - a[1])
    s = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(a[0])) * math.cos(math.radians(b[0])) * math.sin(dlon / 2) ** 2)
    return 2 * R * math.asin(min(1, math.sqrt(s)))


def _points(data: bytes):
    """Return list of (lat, lon, ele|None) or raise ValueError."""
    try:
        root = xml_fromstring(data)
    except Exception:
        raise ValueError("not valid XML")
    pts = []
    for el in root.iter():
        if _local(el.tag) in ("trkpt", "rtept"):
            try:
                lat = float(el.attrib["lat"])
                lon = float(el.attrib["lon"])
            except (KeyError, ValueError):
                continue
            ele = None
            for ch in el:
                if _local(ch.tag) == "ele":
                    try:
                        ele = float((ch.text or "").strip())
                    except ValueError:
                        ele = None
                    break
            pts.append((lat, lon, ele))
    if len(pts) < 2:
        raise ValueError("no track points")
    return pts


def _metrics(pts):
    total = 0.0
    for i in range(1, len(pts)):
        total += haversine(pts[i - 1], pts[i])
    gain = 0.0
    ref = None
    for _, _, e in pts:
        if e is None:
            continue
        if ref is None:
            ref = e
        elif e > ref + 2:
            gain += e - ref
            ref = e
        elif e < ref - 2:
            ref = e
    return round(total / 1000.0, 1), int(round(gain))


def _thumb(pts):
    """Normalized SVG path (0..100 box) of the route shape, for list thumbnails."""
    n = len(pts)
    if n < 2:
        return ""
    step = max(1, n // 48)
    s = pts[::step]
    if s[-1] != pts[-1]:
        s.append(pts[-1])
    mean_lat = sum(p[0] for p in s) / len(s)
    k = math.cos(math.radians(mean_lat)) or 1e-6
    xs = [p[1] * k for p in s]
    ys = [-p[0] for p in s]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    w = (maxx - minx) or 1e-9
    h = (maxy - miny) or 1e-9
    pad, box = 10.0, 100.0
    avail = box - 2 * pad
    scale = min(avail / w, avail / h)
    offx = pad + (avail - w * scale) / 2
    offy = pad + (avail - h * scale) / 2
    d = ""
    for i in range(len(s)):
        px = offx + (xs[i] - minx) * scale
        py = offy + (ys[i] - miny) * scale
        d += ("M" if i == 0 else "L") + ("%.1f %.1f " % (px, py))
    return d.strip()


def read_thumb_for(path: str) -> str:
    try:
        return _thumb(_points((STATIC_DIR / path.lstrip("/")).read_bytes()))
    except Exception:
        return ""


def parse_gpx(data: bytes):
    """Return (distance_km, elevation_gain, thumb) or raise ValueError."""
    pts = _points(data)
    km, gain = _metrics(pts)
    return km, gain, _thumb(pts)


def clean_name(raw: str) -> str:
    name = re.sub(r"\s+", " ", (raw or "").strip())
    name = "".join(ch for ch in name if ch == " " or not (ord(ch) < 32))
    return name[:MAX_NAME]


def client_ip(req: Request) -> str:
    xff = req.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return req.client.host if req.client else "?"


def rate_ok(ip: str) -> bool:
    now = time.time()
    hits = [t for t in _rate.get(ip, []) if now - t < RATE_WINDOW]
    if len(hits) >= RATE_MAX:
        _rate[ip] = hits
        return False
    hits.append(now)
    _rate[ip] = hits
    return True


def row_to_item(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"],
        "name": r["name"],
        "location": r["location"],
        "distance_km": r["distance_km"],
        "elevation_gain": r["elevation_gain"],
        "url": r["path"],
        "thumb": (r["thumb"] if "thumb" in r.keys() else "") or "",
        "created_at": r["created_at"],
    }


# ---- app ----
app = FastAPI(title="Guaruna GPX database")
init_db()


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/routes")
def list_routes(q: str = "", page: int = 1):
    page = max(1, page)
    like = f"%{q.strip()}%"
    conn = db()
    where = "WHERE name LIKE ? COLLATE NOCASE OR IFNULL(location,'') LIKE ? COLLATE NOCASE"
    total = conn.execute(f"SELECT COUNT(*) AS c FROM routes {where}", (like, like)).fetchone()["c"]
    rows = conn.execute(
        f"SELECT * FROM routes {where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?",
        (like, like, PER_PAGE, (page - 1) * PER_PAGE),
    ).fetchall()
    conn.close()
    pages = max(1, (total + PER_PAGE - 1) // PER_PAGE)
    return {"items": [row_to_item(r) for r in rows], "total": total,
            "page": page, "pages": pages, "per_page": PER_PAGE}


@app.post("/api/routes")
async def add_route(request: Request, name: str = Form(...), location: str = Form(""), file: UploadFile = File(...)):
    ip = client_ip(request)
    if not rate_ok(ip):
        raise HTTPException(status_code=429, detail="Too many uploads. Try again later.")

    name = clean_name(name)
    if not name:
        raise HTTPException(status_code=400, detail="A name is required.")
    if not (file.filename or "").lower().endswith(".gpx"):
        raise HTTPException(status_code=400, detail="Please upload a .gpx file.")

    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 10 MB).")
    try:
        distance_km, gain, thumb = parse_gpx(data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid GPX file: {e}.")

    rid = uuid.uuid4().hex
    fname = f"{rid}.gpx"
    (UPLOADS_DIR / fname).write_bytes(data)
    path = f"/routes/uploads/{fname}"
    created = datetime.now(timezone.utc).isoformat()

    conn = db()
    conn.execute(
        "INSERT INTO routes (id,name,location,distance_km,elevation_gain,path,created_at,is_seed,thumb)"
        " VALUES (?,?,?,?,?,?,?,0,?)",
        (rid, name, clean_name(location) or None, distance_km, gain, path, created, thumb),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM routes WHERE id=?", (rid,)).fetchone()
    conn.close()
    return JSONResponse(status_code=201, content=row_to_item(row))


@app.delete("/api/routes/{rid}")
def delete_route(rid: str, request: Request):
    if not ADMIN_TOKEN or request.headers.get("x-admin-token") != ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail="Forbidden.")
    conn = db()
    row = conn.execute("SELECT * FROM routes WHERE id=?", (rid,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Not found.")
    if not row["is_seed"] and row["path"].startswith("/routes/uploads/"):
        try:
            (STATIC_DIR / row["path"].lstrip("/")).unlink(missing_ok=True)
        except OSError:
            pass
    conn.execute("DELETE FROM routes WHERE id=?", (rid,))
    conn.commit()
    conn.close()
    return {"deleted": rid}


# Local dev convenience: serve the static site from the same origin so the
# frontend can reach /api without a separate proxy. Disabled in production
# (nginx serves static; only /api is proxied here).
if SERVE_STATIC:
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
