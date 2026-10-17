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

import psycopg
import requests
from flask import Flask, jsonify, request, send_from_directory

from find_sensors import fetch_area, keep          # find sensors in a rectangle
from load_esdr import ESDR, SCHEMA, HEADER_RE, BATCH_SIZE

CHANNEL = "PM2_5"
DAYS = 7
MAX_SPAN = 3.0          # biggest area (degrees across) one request may cover
MAX_SENSORS = 150       # most sensors loaded per request
FRESH_SECS = 3600       # reload a sensor if its data is older than this

HERE = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=None)
load_lock = threading.Lock()    # one download at a time


def db():
    return psycopg.connect(os.environ["DATABASE_URL"])


def setup_db():
    with db() as conn:
        conn.execute(SCHEMA)
        conn.execute("ALTER TABLE sensors ADD COLUMN IF NOT EXISTS loaded_at TIMESTAMPTZ")


def load_feeds(conn, feeds, from_ts, to_ts):
    """Download these feeds from ESDR and replace their rows in the window."""
    ids = [f["id"] for f in feeds]
    with conn.cursor() as cur:
        for f in feeds:
            cur.execute(
                """INSERT INTO sensors (feed_id, name, latitude, longitude, loaded_at)
                   VALUES (%s, %s, %s, %s, now())
                   ON CONFLICT (feed_id) DO UPDATE
                   SET name = EXCLUDED.name, latitude = EXCLUDED.latitude,
                       longitude = EXCLUDED.longitude, loaded_at = now()""",
                (f["id"], f["name"], f["latitude"], f["longitude"]),
            )
        cur.execute(
            """DELETE FROM readings WHERE feed_id = ANY(%s)
               AND time BETWEEN to_timestamp(%s) AND to_timestamp(%s)""",
            (ids, from_ts, to_ts),
        )
        pairs = [f"{i}.{CHANNEL}" for i in ids]
        for i in range(0, len(pairs), BATCH_SIZE):
            batch = pairs[i:i + BATCH_SIZE]
            resp = requests.get(
                f"{ESDR}/feeds/export/{','.join(batch)}",
                params={"from": from_ts, "to": to_ts, "format": "csv", "timezone": "UTC"},
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

        with db() as conn:
            fresh = {r[0] for r in conn.execute(
                """SELECT feed_id FROM sensors WHERE feed_id = ANY(%s)
                   AND loaded_at > now() - make_interval(secs => %s)""",
                (ids, FRESH_SECS)).fetchall()}
            stale = [f for f in feeds if f["id"] not in fresh]
            if stale:
                with load_lock:
                    load_feeds(conn, stale, from_ts, to_ts)

            sensors = conn.execute(
                "SELECT feed_id, name, latitude, longitude FROM sensors "
                "WHERE feed_id = ANY(%s) ORDER BY name", (ids,)).fetchall()
            hourly = conn.execute(
                """SELECT time_bucket('1 hour', time) AS h, feed_id, avg(value)
                   FROM readings
                   WHERE channel = %s AND feed_id = ANY(%s) AND time >= to_timestamp(%s)
                   GROUP BY h, feed_id ORDER BY h, feed_id""",
                (CHANNEL, ids, from_ts)).fetchall()
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
    )


@app.get("/")
def index():
    return send_from_directory(HERE, "index.html")


@app.get("/regions.json")
def regions_file():
    return send_from_directory(HERE, "regions.json")


@app.get("/css/<path:name>")
def css(name):
    return send_from_directory(os.path.join(HERE, "css"), name)


if __name__ == "__main__":
    setup_db()
    app.run(port=5000, threaded=True)