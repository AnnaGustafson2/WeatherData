"""
Small web server for the air quality page. Works for ANY region in the world.

When the page asks for a map area, this server:
  1. asks ESDR which active outdoor PM2_5 sensors are in that area
  2. loads any sensors that aren't in Tiger Cloud yet (or are older than 1 hour)
  3. returns their hourly readings from Tiger Cloud as JSON

Setup (once):
    pip install flask "psycopg[binary]" requests
    Keep this file in the same folder as find_sensors.py and load_esdr.py.

Run:
    export DATABASE_URL='postgres://tsdbadmin:PASSWORD@HOST:PORT/tsdb?sslmode=require'
    python server.py
    then open http://localhost:5000

The database password stays on this server and never reaches the browser.
"""
import csv
import io
import os
import threading
import time
import json

import psycopg
import requests
from flask import Flask, jsonify, request, send_from_directory

from find_sensors import fetch_area, keep          # find sensors in a rectangle
from load_esdr import ESDR, SCHEMA, HEADER_RE, BATCH_SIZE
from load_city_history import load_city

CHANNEL = "PM2_5"
DAYS = 7
MAX_SPAN = 3.0          # biggest area (degrees across) one request may cover
MAX_SENSORS = 150       # most sensors loaded per request
FRESH_SECS = 3600       # reload a sensor if its data is older than this

HERE = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=None)

from flask_compress import Compress
Compress(app)

load_lock = threading.Lock()    # one download at a time

from psycopg_pool import ConnectionPool

pool = ConnectionPool(os.environ["DATABASE_URL"], min_size=2, max_size=10,
                      open=False, check=ConnectionPool.check_connection)

def db():
    return pool.connection()

# One-time database setup. Every step is safe to repeat. They run one at a time
# (outside a transaction, which Tiger Data requires for aggregates) and a failing
# step only prints a warning, so the server still starts.
SETUP_STEPS = [
    # Smaller chunks (1 day) so data becomes old enough to compress sooner. New chunks only.
    "SELECT set_chunk_time_interval('readings', INTERVAL '1 day')",
    # Columnstore (Tiger's compression): group by the columns we filter on.
    """ALTER TABLE readings SET (timescaledb.enable_columnstore = true,
                                timescaledb.segmentby = 'feed_id, channel',
                                timescaledb.orderby = 'time DESC')""",
    "CALL add_columnstore_policy('readings', after => INTERVAL '2 days', if_not_exists => true)",
    # Continuous aggregates: same as continuous_aggregates.sql.
    """CREATE MATERIALIZED VIEW IF NOT EXISTS hourly_readings
       WITH (timescaledb.continuous) AS
       SELECT time_bucket('1 hour', time) AS hour, feed_id, channel,
              avg(value) AS avg_value, min(value) AS min_value,
              max(value) AS max_value, count(*) AS n_readings
       FROM readings GROUP BY hour, feed_id, channel""",
    """CREATE MATERIALIZED VIEW IF NOT EXISTS daily_readings
       WITH (timescaledb.continuous) AS
       SELECT time_bucket('1 day', time) AS day, feed_id, channel,
              avg(value) AS avg_value, min(value) AS min_value,
              max(value) AS max_value, count(*) AS n_readings
       FROM readings GROUP BY day, feed_id, channel""",
    # Real-time mode: results also include readings newer than the last refresh.
    "ALTER MATERIALIZED VIEW hourly_readings SET (timescaledb.materialized_only = false)",
    "ALTER MATERIALIZED VIEW daily_readings SET (timescaledb.materialized_only = false)",
    """SELECT add_continuous_aggregate_policy('hourly_readings',
           start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour',
           schedule_interval => INTERVAL '1 hour', if_not_exists => TRUE)""",
    """SELECT add_continuous_aggregate_policy('daily_readings',
           start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour',
           schedule_interval => INTERVAL '1 hour', if_not_exists => TRUE)""",
]

# What the page reads: pre-computed hourly rows, versus the raw table (for the timing comparison).
AGG_QUERY = """SELECT hour, feed_id, avg_value FROM hourly_readings
               WHERE channel = %s AND feed_id = ANY(%s) AND hour >= to_timestamp(%s)
               ORDER BY hour, feed_id"""
RAW_QUERY = """SELECT time_bucket('1 hour', time) AS h, feed_id, avg(value) FROM readings
               WHERE channel = %s AND feed_id = ANY(%s) AND time >= to_timestamp(%s)
               GROUP BY h, feed_id ORDER BY h, feed_id"""
COUNT_QUERY = """SELECT count(*) FROM readings
                 WHERE channel = %s AND feed_id = ANY(%s) AND time >= to_timestamp(%s)"""


def setup_db():
    pool.open()
    with db() as conn:
        conn.execute(SCHEMA)
        conn.execute("ALTER TABLE sensors ADD COLUMN IF NOT EXISTS loaded_at TIMESTAMPTZ")
    with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True) as conn:
        for sql in SETUP_STEPS:
            try:
                conn.execute(sql)
            except Exception as exc:
                print(f"setup step skipped ({sql.split(chr(10))[0][:60]}...): {exc}")
        convert_old_chunks(conn)


def convert_old_chunks(conn):
    """Compress existing chunks older than 2 days now, instead of waiting for the policy job."""
    try:
        chunks = [r[0] for r in conn.execute(
            "SELECT c::text FROM show_chunks('readings', older_than => INTERVAL '2 days') AS c").fetchall()]
    except Exception as exc:
        print(f"could not list chunks: {exc}")
        return
    done = 0
    for c in chunks:
        try:
            conn.execute("CALL convert_to_columnstore(%s::regclass)", (c,))
            done += 1
        except Exception as exc:
            print(f"  could not convert {c}: {exc}")
    print(f"columnstore: converted {done} of {len(chunks)} older chunks")


def refresh_aggregates(from_ts, to_ts):
    """Rebuild the aggregates for the window we just reloaded (can't run inside a transaction)."""
    try:
        with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True) as conn:
            for view in ("hourly_readings", "daily_readings"):
                conn.execute(
                    f"CALL refresh_continuous_aggregate('{view}', "
                    "to_timestamp(%s)::timestamptz, to_timestamp(%s)::timestamptz)",
                    (from_ts - 86400, to_ts + 3600))
    except Exception as exc:
        app.logger.warning("aggregate refresh failed: %s", exc)


HOT_SECS = 2 * 86400    # chunks newer than this are not compressed yet


def load_feeds(conn, feeds, from_ts, to_ts):
    """Download these feeds from ESDR and replace their rows.

    Sensors we've loaded before only get their recent (uncompressed) days replaced.
    Brand-new sensors get the full window, which has nothing to delete.
    """
    ids = [f["id"] for f in feeds]
    # Start of the UTC day that is 2 days back = start of the first uncompressed 1-day chunk.
    hot_from = max(from_ts, (to_ts - HOT_SECS) // 86400 * 86400)

    with conn.cursor() as cur:
        # Safety net in case an old, still-compressed chunk gets touched.
        cur.execute("SET timescaledb.max_tuples_decompressed_per_dml_transaction = 0")

        cur.execute(
            "SELECT feed_id FROM sensors WHERE feed_id = ANY(%s) AND loaded_at IS NOT NULL",
            (ids,))
        known = {r[0] for r in cur.fetchall()}

        for f in feeds:
            cur.execute(
                """INSERT INTO sensors (feed_id, name, latitude, longitude, loaded_at)
                   VALUES (%s, %s, %s, %s, now())
                   ON CONFLICT (feed_id) DO UPDATE
                   SET name = EXCLUDED.name, latitude = EXCLUDED.latitude,
                       longitude = EXCLUDED.longitude, loaded_at = now()""",
                (f["id"], f["name"], f["latitude"], f["longitude"]))

        known_ids = [i for i in ids if i in known]
        new_ids = [i for i in ids if i not in known]
        for group, start in ((new_ids, from_ts), (known_ids, hot_from)):
            if group:
                _replace_and_download(cur, group, start, to_ts)


def _replace_and_download(cur, ids, start_ts, to_ts):
    cur.execute(
        """DELETE FROM readings
           WHERE feed_id = ANY(%s) AND time >= to_timestamp(%s)""",
        (ids, start_ts))
    pairs = [f"{i}.{CHANNEL}" for i in ids]
    for i in range(0, len(pairs), BATCH_SIZE):
        batch = pairs[i:i + BATCH_SIZE]
        resp = requests.get(
            f"{ESDR}/feeds/export/{','.join(batch)}",
            params={"from": start_ts, "to": to_ts, "format": "csv", "timezone": "UTC"},
            timeout=600,
        )
        resp.raise_for_status()
        reader = csv.reader(io.StringIO(resp.text))
        header = next(reader, None)
        if not header:
            continue
        cols = []
        for h in header[1:]:
            m = HEADER_RE.search(h)
            cols.append((int(m.group(1)), m.group(2)) if m else None)
        with cur.copy("COPY readings (time, feed_id, channel, value) FROM STDIN") as cp:
            for row in reader:
                for col, v in zip(cols, row[1:]):
                    if col and v != "":
                        cp.write_row((row[0], col[0], col[1], float(v)))

area_cache = {}      # rounded box -> (timestamp, feeds)
AREA_TTL = 900

def cached_area(s, w, n, e):
    key = tuple(round(v, 3) for v in (s, w, n, e))
    hit = area_cache.get(key)
    if hit and time.time() - hit[0] < AREA_TTL:
        return hit[1]
    feeds = cached_area(s, w, n, e)
    area_cache[key] = (time.time(), feeds)
    return feeds

@app.get("/api/region")
def region():
    try:
        s, w, n, e = (float(request.args[k]) for k in ("south", "west", "north", "east"))
    except (KeyError, ValueError):
        return jsonify(error="Need south, west, north and east."), 400
    if s >= n or w >= e:
        return jsonify(error="Invalid area."), 400
    if n - s > MAX_SPAN or e - w > MAX_SPAN:
        return jsonify(error=f"Area too big. Zoom in until it is under {MAX_SPAN:.0f} degrees across."), 400

    to_ts = int(time.time())
    from_ts = to_ts - DAYS * 86400

    try:
        found = [f for f in fetch_area(s, w, n, e) if keep(f, CHANNEL, from_ts)]
        total = len(found)
        feeds = found[:MAX_SENSORS]
        ids = [f["id"] for f in feeds]

        t_load = time.perf_counter()
        with db() as conn:
            fresh = {r[0] for r in conn.execute(
                """SELECT feed_id FROM sensors WHERE feed_id = ANY(%s)
                   AND loaded_at > now() - make_interval(secs => %s)""",
                (ids, FRESH_SECS)).fetchall()}
            stale = [f for f in feeds if f["id"] not in fresh]
            if stale:
                with load_lock:
                    load_feeds(conn, stale, from_ts, to_ts)
        if stale:
            refresh_aggregates(from_ts, to_ts)      # keep the continuous aggregates current
        load_secs = round(time.perf_counter() - t_load, 1)

        with db() as conn:
            sensors = conn.execute(
                "SELECT feed_id, name, latitude, longitude FROM sensors "
                "WHERE feed_id = ANY(%s) ORDER BY name", (ids,)).fetchall()

            t0 = time.perf_counter()
            hourly = conn.execute(AGG_QUERY, (CHANNEL, ids, from_ts)).fetchall()
            agg_ms = round((time.perf_counter() - t0) * 1000, 1)

            raw_ms = None                           # same answer from the raw table, for comparison
            if request.args.get("compare", "1") == "1":
                t0 = time.perf_counter()
                conn.execute(RAW_QUERY, (CHANNEL, ids, from_ts)).fetchall()
                raw_ms = round((time.perf_counter() - t0) * 1000, 1)
            raw_rows = conn.execute(COUNT_QUERY, (CHANNEL, ids, from_ts)).fetchone()[0]
    except Exception as exc:
        app.logger.exception("region request failed")
        return jsonify(error=f"Server error: {exc}"), 500

    return jsonify(
        channel=CHANNEL,
        total_found=total,
        truncated=total > MAX_SENSORS,
        sensors=[{"feed_id": f, "name": nm, "latitude": la, "longitude": lo}
                 for f, nm, la, lo in sensors],
        hourly=[{"time": h.strftime("%Y-%m-%dT%H:%M:%SZ"), "feed_id": f, "avg": round(v, 1)}
                for h, f, v in hourly if v is not None],
        perf=dict(agg_ms=agg_ms, raw_ms=raw_ms, raw_rows=raw_rows, hourly_rows=len(hourly),
                  loaded_sensors=len(stale), load_secs=load_secs),
    )


@app.post("/api/favorites")
def sync_favorites():
    """Save the browser's favorite cities on the server."""
    data = request.get_json(silent=True) or {}
    favorites = data.get("favorites")

    if not isinstance(favorites, list):
        return jsonify(error="Expected a favorites list."), 400

    cleaned = []

    for favorite in favorites:
        if not isinstance(favorite, dict):
            return jsonify(error="Invalid favorite entry."), 400

        label = favorite.get("label")
        lat = favorite.get("lat")
        lon = favorite.get("lon")

        if not isinstance(label, str) or not label.strip():
            return jsonify(error="Each favorite needs a label."), 400

        try:
            lat = float(lat)
            lon = float(lon)
        except (TypeError, ValueError):
            return jsonify(error="Invalid city coordinates."), 400

        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            return jsonify(error="Coordinates are out of range."), 400

        cleaned.append({
            "label": label.strip(),
            "lat": lat,
            "lon": lon
        })

    os.makedirs(os.path.join(HERE, "data"), exist_ok=True)
    with open(os.path.join(HERE, "data", "saved_cities.json"), "w") as f:
        json.dump(cleaned, f, indent=2)

    return jsonify(success=True, count=len(cleaned))

@app.get("/api/storage")
def storage():
    """Table size and how much of it is in the columnstore (Tiger's compression)."""
    def one(conn, sql):
        try:
            return conn.execute(sql).fetchone()
        except Exception:
            return None

    with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True) as conn:
        stats = one(conn, """SELECT number_compressed_chunks, before_compression_total_bytes,
                                    after_compression_total_bytes
                             FROM hypertable_columnstore_stats('readings')""")
        chunks = one(conn, "SELECT count(*) FROM show_chunks('readings')")
        size = one(conn, "SELECT hypertable_size('readings')")
        rows = one(conn, "SELECT approximate_row_count('readings')")
    return jsonify(
        rows=rows[0] if rows else None,
        total_bytes=size[0] if size else None,
        total_chunks=chunks[0] if chunks else None,
        compressed_chunks=(stats[0] or 0) if stats else 0,
        before_bytes=stats[1] if stats else None,
        after_bytes=stats[2] if stats else None,
    )


@app.get("/")
def index():
    return send_from_directory(HERE, "index.html")


@app.get("/regions.json")
def regions_file():
    return send_from_directory(HERE, "regions.json")

@app.get("/data/<path:name>")
def data_file(name):
    return send_from_directory(os.path.join(HERE, "data"), name)

@app.get("/css/<path:name>")
def css(name):
    return send_from_directory(os.path.join(HERE, "css"), name)

@app.get("/js/<path:name>")
def js(name):
    return send_from_directory(os.path.join(HERE, "js"), name)

history_jobs = {}                 # "lat,lon" -> "loading" | "done" | "error: ..."
history_lock = threading.Lock()   # one city downloads at a time; others wait in line
jobs_lock = threading.Lock()


def start_history_load(lat, lon):
    key = f"{lat:.2f},{lon:.2f}"
    with jobs_lock:
        if key in history_jobs:           # already running, finished, or failed
            return history_jobs[key]
        history_jobs[key] = "loading"

    def run():
        try:
            with history_lock:
                load_city(lat, lon)
            history_jobs[key] = "done"
        except Exception as exc:
            app.logger.exception("history load failed")
            history_jobs[key] = f"error: {exc}"

    threading.Thread(target=run, daemon=True).start()
    return "loading"

@app.get("/api/history")
def history():
    try:
        s, w, n, e = (float(request.args[k]) for k in ("south", "west", "north", "east"))
    except (KeyError, ValueError):
        return jsonify(error="Need south, west, north and east."), 400
    try:
        with db() as conn:
            rows = conn.execute(
                """SELECT time_bucket('1 day', h.hour) AS day,
                          avg(h.avg_value), min(h.avg_value), max(h.avg_value),
                          count(DISTINCT h.feed_id)
                   FROM history_hourly h JOIN sensors s USING (feed_id)
                   WHERE s.latitude BETWEEN %s AND %s AND s.longitude BETWEEN %s AND %s
                     AND h.hour >= now() - interval '365 days'
                   GROUP BY day ORDER BY day""", (s, n, w, e)).fetchall()
    except Exception as exc:
        app.logger.exception("history request failed")
        return jsonify(error=f"Server error: {exc}"), 500
    if not rows:
        status = start_history_load((s + n) / 2, (w + e) / 2)
        return jsonify(days=[], status=status)
    return jsonify(status="ready", days=[{"day": d.strftime("%Y-%m-%d"), "avg": round(a, 1),
                          "min": round(lo, 1), "max": round(hi, 1), "sensors": c}
                         for d, a, lo, hi, c in rows])
    resp.headers["Cache-Control"] = "private, max-age=3600"
    return resp

@app.get("/about.html")
def about():
    return send_from_directory(HERE, "about.html")

if __name__ == "__main__":
    setup_db()
    app.run(port=5050, threaded=True)