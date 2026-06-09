"""
Guaruna — GPX database API (FastAPI + SQLite)

Catalog (public, anonymous):
  GET    /api/routes            -> paginated list + spatial/zone search + filters + sort
  GET    /api/routes/random     -> one random route matching optional filters ("surprise me")
  GET    /api/routes/{id}        -> one route with full-resolution polyline + elevation profile
  POST   /api/routes            -> upload (multipart: name, file=.gpx, optional location, activity_type)
  DELETE /api/routes/{id}        -> moderation (requires X-Admin-Token); cascades the route's photos

Community photos & info (public, no accounts — add open & rate-limited, delete admin-only):
  GET    /api/routes/{id}/photos -> photos attached to a route (each with a pseudo + note)
  POST   /api/routes/{id}/photos -> add a photo (multipart: pseudo, note, file=image; resized, EXIF/GPS stripped)
  DELETE /api/photos/{id}        -> delete a photo (admin)
  GET    /api/health            -> {"ok": true}

Uploaded GPX live under <repo>/public/routes/uploads/<uuid>.gpx and photos under
.../uploads/photos/<uuid>.jpg, served statically. The frontend opens a route in the
GPX analyzer via /gpx-analyzer?gpx=<path> and offers a direct download.

Run (dev):   uvicorn server.app:app --reload --port 8001
Run (prod):  uvicorn server.app:app --host 127.0.0.1 --port 8001
"""
import io
import json
import math
import os
import re
import sqlite3
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

try:
    from defusedxml.ElementTree import fromstring as xml_fromstring
except Exception:  # fallback if defusedxml is missing (less safe)
    from xml.etree.ElementTree import fromstring as xml_fromstring

try:
    from PIL import Image, ImageOps
    _PIL_OK = True
except Exception:  # photos degrade gracefully if Pillow is unavailable
    _PIL_OK = False

# ---- paths & config ----
BASE_DIR = Path(__file__).resolve().parent.parent          # repo root
STATIC_DIR = Path(os.environ.get("GUARUNA_STATIC", BASE_DIR / "public"))   # frontend served by the app
UPLOADS_DIR = Path(os.environ.get("GUARUNA_UPLOADS", STATIC_DIR / "routes" / "uploads"))
PHOTOS_DIR = Path(os.environ.get("GUARUNA_PHOTOS", UPLOADS_DIR / "photos"))
DB_PATH = Path(os.environ.get("GUARUNA_DB", BASE_DIR / "server" / "data" / "routes.db"))
ADMIN_TOKEN = os.environ.get("GUARUNA_ADMIN_TOKEN", "")     # empty disables write/delete
SERVE_STATIC = os.environ.get("GUARUNA_SERVE_STATIC", "1") == "1"  # serve static too (dev); harmless in prod (nginx only proxies /api)

PER_PAGE = 50
MAP_MARKER_CAP = 500                 # light=1 viewport queries return up to this many
MAX_BYTES = 10 * 1024 * 1024         # 10 MB GPX upload cap
MAX_NAME = 80
MAX_NOTE = 600
MAX_PSEUDO = 40
RATE_MAX = 10                        # uploads ...
RATE_WINDOW = 3600                   # ... per hour per IP

MAX_PHOTO_BYTES = 8 * 1024 * 1024    # 8 MB per image
MAX_PHOTOS_PER_ROUTE = 30
PHOTO_RATE_MAX = 30                  # photos per hour per IP
PHOTO_MAX_DIM = 1600                 # px, longest side of the stored image
THUMB_MAX_DIM = 480                  # px, longest side of the gallery thumbnail
JPEG_QUALITY = 82

ALLOWED_TYPES = {"run", "trail", "bike", "hike", "walk", "other"}

UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

SEED_ROUTES = [
    ("paris-seine-loop", "Seine & Tuileries Loop", "Paris, France", 5.0, 53),
    ("london-hyde-park", "Hyde Park Loop", "London, UK", 7.0, 32),
    ("nyc-central-park", "Central Park Loop", "New York, USA", 10.0, 130),
    ("amsterdam-vondel", "Vondelpark Round", "Amsterdam, NL", 4.0, 11),
    ("berlin-tiergarten", "Tiergarten Run", "Berlin, Germany", 6.0, 28),
    ("barcelona-beach", "Barceloneta Beachfront", "Barcelona, Spain", 8.0, 21),
]

_rate = {}  # key -> [timestamps]


# ---- db ----
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = db()
    conn.execute(
        """CREATE TABLE IF NOT EXISTS routes (
            id             TEXT PRIMARY KEY,
            name           TEXT NOT NULL,
            location       TEXT,
            distance_km    REAL NOT NULL DEFAULT 0,
            elevation_gain INTEGER NOT NULL DEFAULT 0,
            path           TEXT NOT NULL,
            created_at     TEXT NOT NULL,
            is_seed        INTEGER NOT NULL DEFAULT 0,
            thumb          TEXT DEFAULT '',
            min_lat        REAL,
            min_lon        REAL,
            max_lat        REAL,
            max_lon        REAL,
            center_lat     REAL,
            center_lon     REAL,
            elevation_loss INTEGER NOT NULL DEFAULT 0,
            duration_s     INTEGER,
            activity_type  TEXT NOT NULL DEFAULT 'other',
            difficulty     INTEGER NOT NULL DEFAULT 1,
            point_count    INTEGER NOT NULL DEFAULT 0,
            polyline       TEXT DEFAULT ''
        )"""
    )

    # additive migration for databases that predate the spatial/metadata columns
    cols = {r[1] for r in conn.execute("PRAGMA table_info(routes)")}
    add_cols = [
        ("thumb", "TEXT DEFAULT ''"),
        ("min_lat", "REAL"), ("min_lon", "REAL"), ("max_lat", "REAL"), ("max_lon", "REAL"),
        ("center_lat", "REAL"), ("center_lon", "REAL"),
        ("elevation_loss", "INTEGER NOT NULL DEFAULT 0"),
        ("duration_s", "INTEGER"),
        ("activity_type", "TEXT NOT NULL DEFAULT 'other'"),
        ("difficulty", "INTEGER NOT NULL DEFAULT 1"),
        ("point_count", "INTEGER NOT NULL DEFAULT 0"),
        ("polyline", "TEXT DEFAULT ''"),
    ]
    for name, decl in add_cols:
        if name not in cols:
            conn.execute(f"ALTER TABLE routes ADD COLUMN {name} {decl}")

    # The personal "journal" model was dropped in favour of community photos.
    conn.execute("DROP TABLE IF EXISTS outings")
    # photos: migrate the old (outing_id) shape -> the new (route_id, pseudo, note) one.
    pcols = {r[1] for r in conn.execute("PRAGMA table_info(photos)")}
    if pcols and "route_id" not in pcols:
        conn.execute("DROP TABLE photos")
    conn.execute(
        """CREATE TABLE IF NOT EXISTS photos (
            id         TEXT PRIMARY KEY,
            route_id   TEXT NOT NULL,
            pseudo     TEXT,
            note       TEXT,
            path       TEXT NOT NULL,
            thumb_path TEXT NOT NULL,
            created_at TEXT NOT NULL
        )"""
    )

    for stmt in (
        "CREATE INDEX IF NOT EXISTS idx_routes_bbox ON routes (min_lat,max_lat,min_lon,max_lon)",
        "CREATE INDEX IF NOT EXISTS idx_routes_center ON routes (center_lat,center_lon)",
        "CREATE INDEX IF NOT EXISTS idx_routes_created ON routes (created_at)",
        "CREATE INDEX IF NOT EXISTS idx_routes_dist ON routes (distance_km)",
        "CREATE INDEX IF NOT EXISTS idx_routes_type ON routes (activity_type)",
        "CREATE INDEX IF NOT EXISTS idx_photos_route ON photos (route_id)",
    ):
        conn.execute(stmt)

    # seed an empty catalog from the GPX files shipped in public/routes
    n = conn.execute("SELECT COUNT(*) AS c FROM routes").fetchone()["c"]
    if n == 0:
        ts = "2026-05-01T07:00:00+00:00"
        for rid, name, loc, km, gain in SEED_ROUTES:
            path = f"/routes/{rid}.gpx"
            meta = enrich_for(path)
            if meta:
                conn.execute(
                    """INSERT OR IGNORE INTO routes
                       (id,name,location,distance_km,elevation_gain,path,created_at,is_seed,thumb,
                        min_lat,min_lon,max_lat,max_lon,center_lat,center_lon,
                        elevation_loss,duration_s,activity_type,difficulty,point_count,polyline)
                       VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (rid, name, loc, meta["distance_km"], meta["elevation_gain"], path, ts, meta["thumb"],
                     meta["min_lat"], meta["min_lon"], meta["max_lat"], meta["max_lon"],
                     meta["center_lat"], meta["center_lon"], meta["elevation_loss"], meta["duration_s"],
                     "run", meta["difficulty"], meta["point_count"], meta["polyline"]),
                )
            else:
                conn.execute(
                    "INSERT OR IGNORE INTO routes (id,name,location,distance_km,elevation_gain,path,created_at,is_seed)"
                    " VALUES (?,?,?,?,?,?,?,1)",
                    (rid, name, loc, km, gain, path, ts),
                )

    # backfill geometry/metrics for rows that predate the new columns
    stale = conn.execute(
        "SELECT id, path FROM routes WHERE polyline IS NULL OR polyline='' OR center_lat IS NULL"
    ).fetchall()
    for r in stale:
        meta = enrich_for(r["path"])
        if not meta:
            continue
        conn.execute(
            """UPDATE routes SET min_lat=?,min_lon=?,max_lat=?,max_lon=?,center_lat=?,center_lon=?,
               elevation_loss=?,duration_s=?,point_count=?,polyline=?,difficulty=?,
               thumb=COALESCE(NULLIF(thumb,''),?) WHERE id=?""",
            (meta["min_lat"], meta["min_lon"], meta["max_lat"], meta["max_lon"],
             meta["center_lat"], meta["center_lon"], meta["elevation_loss"], meta["duration_s"],
             meta["point_count"], meta["polyline"], meta["difficulty"], meta["thumb"], r["id"]),
        )

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


def _parse_time(text):
    if not text:
        return None
    s = text.strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s).timestamp()
    except Exception:
        return None


def _points(data: bytes):
    """Return list of (lat, lon, ele|None, t|None) or raise ValueError. t = epoch seconds."""
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
            t = None
            for ch in el:
                lt = _local(ch.tag)
                if lt == "ele":
                    try:
                        ele = float((ch.text or "").strip())
                    except ValueError:
                        ele = None
                elif lt == "time":
                    t = _parse_time(ch.text)
            pts.append((lat, lon, ele, t))
    if len(pts) < 2:
        raise ValueError("no track points")
    return pts


def _metrics(pts):
    total = 0.0
    for i in range(1, len(pts)):
        total += haversine(pts[i - 1], pts[i])
    gain = 0.0
    ref = None
    for p in pts:
        e = p[2]
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


def _elev_loss(pts):
    loss = 0.0
    ref = None
    for p in pts:
        e = p[2]
        if e is None:
            continue
        if ref is None:
            ref = e
        elif e < ref - 2:
            loss += ref - e
            ref = e
        elif e > ref + 2:
            ref = e
    return int(round(loss))


def _duration_s(pts):
    ts = [p[3] for p in pts if len(p) > 3 and p[3] is not None]
    if len(ts) < 2:
        return None
    d = int(round(max(ts) - min(ts)))
    return d if d > 0 else None


def _bbox_center(pts):
    lats = [p[0] for p in pts]
    lons = [p[1] for p in pts]
    mnla, mxla = min(lats), max(lats)
    mnlo, mxlo = min(lons), max(lons)
    return (round(mnla, 6), round(mnlo, 6), round(mxla, 6), round(mxlo, 6),
            round((mnla + mxla) / 2, 6), round((mnlo + mxlo) / 2, 6))


def _downsample(pts, target):
    n = len(pts)
    step = max(1, n // max(1, target))
    s = pts[::step]
    if s[-1] is not pts[-1]:
        s = s + [pts[-1]]
    return s


def _polyline(pts, target=64):
    """Geographic [lat, lon] polyline for the map (distinct from the normalized _thumb)."""
    return [[round(p[0], 6), round(p[1], 6)] for p in _downsample(pts, target)]


def _difficulty(distance_km, gain_m):
    score = distance_km / 5.0 + gain_m / 150.0
    return max(1, min(5, int(score) + 1))


def _activity_type(distance_km, duration_s):
    if duration_s and duration_s > 0:
        kmh = distance_km / (duration_s / 3600.0)
        if kmh >= 15:
            return "bike"
        if kmh >= 7:
            return "run"
        return "walk"
    return "other"


def _thumb(pts):
    """Normalized SVG path (0..100 box) of the route shape, for list thumbnails."""
    n = len(pts)
    if n < 2:
        return ""
    s = _downsample(pts, 48)
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


def enrich_points(pts):
    """All derived metadata from parsed points. Pure; no IO."""
    km, gain = _metrics(pts)
    mnla, mnlo, mxla, mxlo, clat, clon = _bbox_center(pts)
    dur = _duration_s(pts)
    return {
        "distance_km": km, "elevation_gain": gain, "elevation_loss": _elev_loss(pts),
        "min_lat": mnla, "min_lon": mnlo, "max_lat": mxla, "max_lon": mxlo,
        "center_lat": clat, "center_lon": clon, "duration_s": dur,
        "point_count": len(pts), "polyline": json.dumps(_polyline(pts), separators=(",", ":")),
        "difficulty": _difficulty(km, gain), "thumb": _thumb(pts),
        "activity_guess": _activity_type(km, dur),
    }


def enrich_for(path):
    """Resolve a stored path to bytes and enrich; {} on any failure (seeds/backfill)."""
    try:
        return enrich_points(_points((STATIC_DIR / path.lstrip("/")).read_bytes()))
    except Exception:
        return {}


def full_polyline_for(path, target=256):
    try:
        pts = _points((STATIC_DIR / path.lstrip("/")).read_bytes())
        return [[round(p[0], 6), round(p[1], 6)] for p in _downsample(pts, target)]
    except Exception:
        return []


def elevation_profile(path, target=240):
    """[[dist_km, ele_m], ...] sampled along the track (cumulative distance over the full set)."""
    try:
        pts = _points((STATIC_DIR / path.lstrip("/")).read_bytes())
    except Exception:
        return []
    n = len(pts)
    cum = [0.0] * n
    for i in range(1, n):
        cum[i] = cum[i - 1] + haversine(pts[i - 1], pts[i])
    step = max(1, n // max(1, target))
    out = []
    for i in range(0, n, step):
        if pts[i][2] is not None:
            out.append([round(cum[i] / 1000.0, 3), round(pts[i][2], 1)])
    if pts[-1][2] is not None:
        last = [round(cum[-1] / 1000.0, 3), round(pts[-1][2], 1)]
        if not out or out[-1] != last:
            out.append(last)
    return out


# ---- images ----
def _process_image(data: bytes):
    """Return (jpeg_bytes, thumb_jpeg_bytes). Re-encodes from scratch, so EXIF (incl. GPS) is dropped."""
    im = Image.open(io.BytesIO(data))
    im = ImageOps.exif_transpose(im)          # bake in orientation before stripping EXIF
    im = im.convert("RGB")
    big = im.copy()
    big.thumbnail((PHOTO_MAX_DIM, PHOTO_MAX_DIM))
    th = im.copy()
    th.thumbnail((THUMB_MAX_DIM, THUMB_MAX_DIM))
    b1 = io.BytesIO()
    big.save(b1, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    b2 = io.BytesIO()
    th.save(b2, format="JPEG", quality=80, optimize=True)
    return b1.getvalue(), b2.getvalue()


# ---- helpers ----
def clean_name(raw: str) -> str:
    name = re.sub(r"\s+", " ", (raw or "").strip())
    name = "".join(ch for ch in name if ch == " " or not (ord(ch) < 32))
    return name[:MAX_NAME]


def clean_note(raw: str) -> str:
    s = (raw or "").strip()
    s = "".join(ch for ch in s if ch in ("\n", "\t") or not (ord(ch) < 32))
    return s[:MAX_NOTE]


def clean_pseudo(raw: str) -> str:
    s = re.sub(r"\s+", " ", (raw or "").strip())
    s = "".join(ch for ch in s if ch == " " or not (ord(ch) < 32))
    return s[:MAX_PSEUDO] or "Anonyme"


def client_ip(req: Request) -> str:
    xff = req.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return req.client.host if req.client else "?"


def rate_ok(key: str, limit: int = RATE_MAX, window: int = RATE_WINDOW) -> bool:
    now = time.time()
    hits = [t for t in _rate.get(key, []) if now - t < window]
    if len(hits) >= limit:
        _rate[key] = hits
        return False
    hits.append(now)
    _rate[key] = hits
    return True


def require_admin(request: Request):
    if not ADMIN_TOKEN or request.headers.get("x-admin-token") != ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail="Forbidden.")


def _g(r: sqlite3.Row, key, default=None):
    return r[key] if key in r.keys() else default


def row_to_item(r: sqlite3.Row, light: bool = False) -> dict:
    item = {
        "id": r["id"],
        "name": r["name"],
        "location": r["location"],
        "distance_km": r["distance_km"],
        "elevation_gain": r["elevation_gain"],
        "elevation_loss": _g(r, "elevation_loss", 0) or 0,
        "duration_s": _g(r, "duration_s"),
        "activity_type": _g(r, "activity_type", "other") or "other",
        "difficulty": _g(r, "difficulty", 1) or 1,
        "point_count": _g(r, "point_count", 0) or 0,
        "photo_count": _g(r, "photo_count", 0) or 0,
        "center": ([_g(r, "center_lat"), _g(r, "center_lon")] if _g(r, "center_lat") is not None else None),
        "bbox": ([_g(r, "min_lat"), _g(r, "min_lon"), _g(r, "max_lat"), _g(r, "max_lon")]
                 if _g(r, "min_lat") is not None else None),
        "url": r["path"],
        "created_at": r["created_at"],
    }
    if not light:
        item["thumb"] = _g(r, "thumb", "") or ""
        pl = _g(r, "polyline", "") or ""
        try:
            item["polyline"] = json.loads(pl) if pl else []
        except Exception:
            item["polyline"] = []
    return item


def photo_item(p: sqlite3.Row) -> dict:
    return {
        "id": p["id"],
        "route_id": p["route_id"],
        "url": p["path"],
        "thumb": p["thumb_path"],
        "pseudo": p["pseudo"] or "Anonyme",
        "note": p["note"] or "",
        "created_at": p["created_at"],
    }


def _delete_photos_of(conn, rid: str):
    for p in conn.execute("SELECT * FROM photos WHERE route_id=?", (rid,)).fetchall():
        for pth in (p["path"], p["thumb_path"]):
            try:
                (STATIC_DIR / pth.lstrip("/")).unlink(missing_ok=True)
            except OSError:
                pass
    conn.execute("DELETE FROM photos WHERE route_id=?", (rid,))


PHOTO_COUNT_SQL = "(SELECT COUNT(*) FROM photos WHERE photos.route_id = routes.id) AS photo_count"


# ---- app ----
app = FastAPI(title="Guaruna GPX database")
init_db()


@app.get("/api/health")
def health():
    return {"ok": True}


# ---- catalog ----
@app.get("/api/routes")
def list_routes(
    q: str = "",
    page: int = 1,
    minLat: Optional[float] = None,
    minLon: Optional[float] = None,
    maxLat: Optional[float] = None,
    maxLon: Optional[float] = None,
    near: str = "",
    radius_km: float = 25.0,
    dist_min: Optional[float] = None,
    dist_max: Optional[float] = None,
    elev_min: Optional[int] = None,
    elev_max: Optional[int] = None,
    type: str = "",
    difficulty_min: Optional[int] = None,
    difficulty_max: Optional[int] = None,
    sort: str = "newest",
    light: int = 0,
):
    page = max(1, page)
    like = f"%{q.strip()}%"
    clauses = ["(name LIKE ? COLLATE NOCASE OR IFNULL(location,'') LIKE ? COLLATE NOCASE)"]
    params = [like, like]

    # zone search — bounding-box intersection (all four edges required together)
    if None not in (minLat, minLon, maxLat, maxLon):
        clauses.append("min_lat<=? AND max_lat>=? AND min_lon<=? AND max_lon>=?")
        params += [maxLat, minLat, maxLon, minLon]

    near_pt = None
    if near:
        try:
            la, lo = near.split(",")
            near_pt = (float(la), float(lo))
        except Exception:
            near_pt = None
    radius = radius_km if (radius_km and radius_km > 0) else 25.0
    if near_pt is not None:
        dlat = radius / 111.0
        dlon = radius / (111.0 * max(0.01, math.cos(math.radians(near_pt[0]))))
        clauses.append("center_lat BETWEEN ? AND ? AND center_lon BETWEEN ? AND ?")
        params += [near_pt[0] - dlat, near_pt[0] + dlat, near_pt[1] - dlon, near_pt[1] + dlon]

    if dist_min is not None:
        clauses.append("distance_km>=?"); params.append(dist_min)
    if dist_max is not None:
        clauses.append("distance_km<=?"); params.append(dist_max)
    if elev_min is not None:
        clauses.append("elevation_gain>=?"); params.append(elev_min)
    if elev_max is not None:
        clauses.append("elevation_gain<=?"); params.append(elev_max)
    if type in ALLOWED_TYPES:
        clauses.append("activity_type=?"); params.append(type)
    if difficulty_min is not None:
        clauses.append("difficulty>=?"); params.append(difficulty_min)
    if difficulty_max is not None:
        clauses.append("difficulty<=?"); params.append(difficulty_max)

    where = "WHERE " + " AND ".join(clauses)
    cap = MAP_MARKER_CAP if light else PER_PAGE
    conn = db()

    # proximity sort: prefilter in SQL, then exact great-circle sort in Python
    if sort == "nearest" and near_pt is not None:
        rows = conn.execute(f"SELECT *, {PHOTO_COUNT_SQL} FROM routes {where}", params).fetchall()
        scored = []
        for r in rows:
            if r["center_lat"] is None:
                continue
            d = haversine(near_pt, (r["center_lat"], r["center_lon"])) / 1000.0
            if d <= radius:
                scored.append((d, r))
        conn.close()
        scored.sort(key=lambda x: x[0])
        total = len(scored)
        start = (page - 1) * cap
        items = []
        for d, r in scored[start:start + cap]:
            it = row_to_item(r, light=bool(light))
            it["distance_from_km"] = round(d, 1)
            items.append(it)
        pages = max(1, (total + cap - 1) // cap)
        return {"items": items, "total": total, "page": page, "pages": pages, "per_page": cap}

    order_map = {
        "newest": "created_at DESC, rowid DESC",
        "oldest": "created_at ASC, rowid ASC",
        "longest": "distance_km DESC",
        "shortest": "distance_km ASC",
        "climb": "elevation_gain DESC",
    }
    order = order_map.get(sort, order_map["newest"])
    total = conn.execute(f"SELECT COUNT(*) AS c FROM routes {where}", params).fetchone()["c"]
    rows = conn.execute(
        f"SELECT *, {PHOTO_COUNT_SQL} FROM routes {where} ORDER BY {order} LIMIT ? OFFSET ?",
        params + [cap, (page - 1) * cap],
    ).fetchall()
    conn.close()
    pages = max(1, (total + cap - 1) // cap)
    return {"items": [row_to_item(r, light=bool(light)) for r in rows], "total": total,
            "page": page, "pages": pages, "per_page": cap}


@app.get("/api/routes/random")
def random_route(
    type: str = "",
    dist_min: Optional[float] = None,
    dist_max: Optional[float] = None,
    elev_min: Optional[int] = None,
    elev_max: Optional[int] = None,
):
    clauses = ["1=1"]
    params = []
    if type in ALLOWED_TYPES:
        clauses.append("activity_type=?"); params.append(type)
    if dist_min is not None:
        clauses.append("distance_km>=?"); params.append(dist_min)
    if dist_max is not None:
        clauses.append("distance_km<=?"); params.append(dist_max)
    if elev_min is not None:
        clauses.append("elevation_gain>=?"); params.append(elev_min)
    if elev_max is not None:
        clauses.append("elevation_gain<=?"); params.append(elev_max)
    where = "WHERE " + " AND ".join(clauses)
    conn = db()
    row = conn.execute(f"SELECT *, {PHOTO_COUNT_SQL} FROM routes {where} ORDER BY RANDOM() LIMIT 1", params).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="No routes match.")
    item = row_to_item(row)
    item["polyline_full"] = full_polyline_for(row["path"])
    return item


@app.get("/api/routes/{rid}")
def get_route(rid: str):
    conn = db()
    row = conn.execute(f"SELECT *, {PHOTO_COUNT_SQL} FROM routes WHERE id=?", (rid,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Not found.")
    item = row_to_item(row)
    item["polyline_full"] = full_polyline_for(row["path"])
    item["profile"] = elevation_profile(row["path"])
    return item


@app.get("/api/routes/{rid}/photos")
def route_photos(rid: str):
    conn = db()
    rows = conn.execute(
        "SELECT * FROM photos WHERE route_id=? ORDER BY created_at DESC", (rid,)
    ).fetchall()
    conn.close()
    return {"items": [photo_item(p) for p in rows]}


@app.post("/api/routes/{rid}/photos")
async def add_photo(rid: str, request: Request, pseudo: str = Form(""), note: str = Form(""), file: UploadFile = File(...)):
    if not _PIL_OK:
        raise HTTPException(status_code=503, detail="Image processing unavailable.")
    ip = client_ip(request)
    if not rate_ok("photo:" + ip, PHOTO_RATE_MAX, RATE_WINDOW):
        raise HTTPException(status_code=429, detail="Too many uploads. Try again later.")
    conn = db()
    if not conn.execute("SELECT id FROM routes WHERE id=?", (rid,)).fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Route not found.")
    cnt = conn.execute("SELECT COUNT(*) AS c FROM photos WHERE route_id=?", (rid,)).fetchone()["c"]
    if cnt >= MAX_PHOTOS_PER_ROUTE:
        conn.close()
        raise HTTPException(status_code=400, detail=f"Max {MAX_PHOTOS_PER_ROUTE} photos per route.")
    data = await file.read()
    if len(data) > MAX_PHOTO_BYTES:
        conn.close()
        raise HTTPException(status_code=413, detail="Image too large (max 8 MB).")
    try:
        big, thumb = _process_image(data)
    except Exception:
        conn.close()
        raise HTTPException(status_code=400, detail="Invalid image file.")

    pid = uuid.uuid4().hex
    (PHOTOS_DIR / f"{pid}.jpg").write_bytes(big)
    (PHOTOS_DIR / f"{pid}_t.jpg").write_bytes(thumb)
    created = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT INTO photos (id,route_id,pseudo,note,path,thumb_path,created_at) VALUES (?,?,?,?,?,?,?)",
        (pid, rid, clean_pseudo(pseudo), clean_note(note),
         f"/routes/uploads/photos/{pid}.jpg", f"/routes/uploads/photos/{pid}_t.jpg", created),
    )
    conn.commit()
    p = conn.execute("SELECT * FROM photos WHERE id=?", (pid,)).fetchone()
    conn.close()
    return JSONResponse(status_code=201, content=photo_item(p))


@app.post("/api/routes")
async def add_route(
    request: Request,
    name: str = Form(...),
    location: str = Form(""),
    activity_type: str = Form(""),
    file: UploadFile = File(...),
):
    ip = client_ip(request)
    if not rate_ok("up:" + ip):
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
        meta = enrich_points(_points(data))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid GPX file: {e}.")

    atype = activity_type if activity_type in ALLOWED_TYPES else meta["activity_guess"]
    rid = uuid.uuid4().hex
    fname = f"{rid}.gpx"
    (UPLOADS_DIR / fname).write_bytes(data)
    path = f"/routes/uploads/{fname}"
    created = datetime.now(timezone.utc).isoformat()

    conn = db()
    conn.execute(
        """INSERT INTO routes
           (id,name,location,distance_km,elevation_gain,path,created_at,is_seed,thumb,
            min_lat,min_lon,max_lat,max_lon,center_lat,center_lon,
            elevation_loss,duration_s,activity_type,difficulty,point_count,polyline)
           VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (rid, name, clean_name(location) or None, meta["distance_km"], meta["elevation_gain"], path, created,
         meta["thumb"], meta["min_lat"], meta["min_lon"], meta["max_lat"], meta["max_lon"],
         meta["center_lat"], meta["center_lon"], meta["elevation_loss"], meta["duration_s"],
         atype, meta["difficulty"], meta["point_count"], meta["polyline"]),
    )
    conn.commit()
    row = conn.execute(f"SELECT *, {PHOTO_COUNT_SQL} FROM routes WHERE id=?", (rid,)).fetchone()
    conn.close()
    return JSONResponse(status_code=201, content=row_to_item(row))


@app.delete("/api/routes/{rid}")
def delete_route(rid: str, request: Request):
    require_admin(request)
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
    _delete_photos_of(conn, rid)
    conn.execute("DELETE FROM routes WHERE id=?", (rid,))
    conn.commit()
    conn.close()
    return {"deleted": rid}


@app.delete("/api/photos/{pid}")
def delete_photo(pid: str, request: Request):
    require_admin(request)
    conn = db()
    p = conn.execute("SELECT * FROM photos WHERE id=?", (pid,)).fetchone()
    if not p:
        conn.close()
        raise HTTPException(status_code=404, detail="Not found.")
    for pth in (p["path"], p["thumb_path"]):
        try:
            (STATIC_DIR / pth.lstrip("/")).unlink(missing_ok=True)
        except OSError:
            pass
    conn.execute("DELETE FROM photos WHERE id=?", (pid,))
    conn.commit()
    conn.close()
    return {"deleted": pid}


# Local dev convenience: serve the static site from the same origin so the
# frontend can reach /api without a separate proxy. Disabled in production
# (nginx serves static; only /api is proxied here).
if SERVE_STATIC:
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
