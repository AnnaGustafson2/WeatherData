"""
Load sensor data from environmentaldata.org (ESDR) into Tiger Cloud (Postgres + TimescaleDB).

Setup (once):
    pip install -r requirements.txt
    export DATABASE_URL='postgres://tsdbadmin:PASSWORD@HOST:PORT/tsdb?sslmode=require'

Run:
    python load_esdr.py

To add sensors: put their feed IDs in FEED_IDS below and run again.
Safe to re-run: it replaces data in the time window instead of duplicating it.
"""
import csv
import io
import os
import re
import time
from datetime import datetime, timezone

import psycopg
import requests

ESDR = "https://esdr.cmucreatelab.org/api/v1"

# ---------------------------------------------------------------
# 1) WHICH SENSORS: feed IDs from environmentaldata.org
#    (the number before the dot in the URL, e.g. 123139.PM2_5 -> 123139)
#
#    Easiest way to get them: python find_sensors.py SOUTH WEST NORTH EAST
#
#    Washington, DC: active outdoor sensors with PM2_5, found with
#    python find_sensors.py 38.79 -77.12 39.00 -76.91
#    Includes 5 government AirNow monitors: 5319, 26205, 2615, 2614, 172361
# ---------------------------------------------------------------
FEED_IDS = [
    145026, 102802, 103843, 145027, 188235, 140464, 203362, 205610, 186092,
    186017, 170096, 173657, 184150, 207654, 186006, 100104, 187596, 204866,
    187749, 172361, 173948, 185443, 187154, 198661, 133288, 199496, 169022,
    106767, 106240, 106774, 185313, 186599, 114933, 186012, 160403, 185209,
    5319, 144785, 187616, 159220, 152371, 203872, 205379, 187617, 186632,
    187160, 187748, 149655, 185215, 184466, 206458, 190720, 194931, 190069,
    192538, 177501, 26205, 193219, 206461, 170880, 170879, 153615, 170881,
    207456, 207457, 153616, 153776, 153680, 153677, 153689, 153690, 153679,
    185157, 177492, 2615, 185492, 157894, 194518, 185493, 101120, 203885,
    186604, 122708, 203249, 153852, 168231, 156502, 153390, 2614, 167401,
    173427, 186015, 187292, 192726, 204285, 168236, 155648, 186013, 191078,
    168457, 187597, 114757, 187161, 207665,
]

# ---------------------------------------------------------------
# 2) WHICH MEASUREMENTS: loaded only if the sensor has them
#    Add "temp_f", "humidity" or "PM10" later if you want them
#    (more channels = more rows = slower load).
# ---------------------------------------------------------------
WANTED_CHANNELS = ["PM2_5"]

# ---------------------------------------------------------------
# 3) WHICH DATES: the last N days (set DAYS = None to use FROM_TS/TO_TS)
# ---------------------------------------------------------------
DAYS = 7
FROM_TS = 1781509280   # used only if DAYS is None (Jun 15, 2026)
TO_TS = 1782264006     # used only if DAYS is None (Jun 24, 2026)

# How many feed.channel pairs to ask for in one download (keeps URLs short)
BATCH_SIZE = 20

SCHEMA = """
CREATE TABLE IF NOT EXISTS sensors (
    feed_id   INT PRIMARY KEY,
    name      TEXT,
    latitude  DOUBLE PRECISION,
    longitude DOUBLE PRECISION
);

CREATE TABLE IF NOT EXISTS readings (
    time     TIMESTAMPTZ      NOT NULL,
    feed_id  INT              NOT NULL REFERENCES sensors(feed_id),
    channel  TEXT             NOT NULL,   -- e.g. PM2_5, PM10, temp_f
    value    DOUBLE PRECISION
);

-- Turn readings into a TimescaleDB hypertable (fast time-series queries)
SELECT create_hypertable('readings', by_range('time'), if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS readings_feed_channel_time
    ON readings (feed_id, channel, time DESC);
"""

# ESDR export headers look like "3.feed_100036.PM10_a"
HEADER_RE = re.compile(r"feed_(\d+)\.(.+)$")


def time_window():
    if DAYS is None:
        return FROM_TS, TO_TS
    now = int(time.time())
    return now - DAYS * 86400, now


def get_feed(fid):
    resp = requests.get(
        f"{ESDR}/feeds/{fid}",
        params={"fields": "id,name,latitude,longitude,lastUpload,channelBounds"},
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()["data"]


def to_unix(iso):
    if not iso or iso.startswith("0000"):
        return 0
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def main():
    from_ts, to_ts = time_window()
    fmt = lambda t: datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d")
    print(f"Time window: {fmt(from_ts)} to {fmt(to_ts)} (UTC)\n")

    # --- Check each sensor: is it alive in this window, and which channels does it have?
    sensors, pairs = [], []
    for fid in FEED_IDS:
        info = get_feed(fid)
        last = to_unix(info.get("lastUpload"))
        has = set((info.get("channelBounds") or {}).get("channels", {}))
        chans = [c for c in WANTED_CHANNELS if c in has]

        if last < from_ts:
            print(f"SKIP  {fid} {info['name']}: last upload {info.get('lastUpload')} is before the window")
            continue
        if not chans:
            print(f"SKIP  {fid} {info['name']}: has none of {WANTED_CHANNELS}")
            continue

        print(f"OK    {fid} {info['name']} ({info['latitude']}, {info['longitude']}): {', '.join(chans)}")
        sensors.append(info)
        pairs += [f"{fid}.{c}" for c in chans]

    if not sensors:
        print("\nNo active sensors to load. Add working feed IDs to FEED_IDS.")
        return

    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute(SCHEMA)

        for info in sensors:
            cur.execute(
                """INSERT INTO sensors (feed_id, name, latitude, longitude)
                   VALUES (%s, %s, %s, %s)
                   ON CONFLICT (feed_id) DO UPDATE
                   SET name = EXCLUDED.name,
                       latitude = EXCLUDED.latitude,
                       longitude = EXCLUDED.longitude""",
                (info["id"], info["name"], info["latitude"], info["longitude"]),
            )

        # Clear this window for these sensors so re-runs don't duplicate rows
        cur.execute(
            """DELETE FROM readings
               WHERE feed_id = ANY(%s)
                 AND time BETWEEN to_timestamp(%s) AND to_timestamp(%s)""",
            ([s["id"] for s in sensors], from_ts, to_ts),
        )

        # Download in batches, reshape wide -> long, bulk-load with COPY
        n = 0
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

            columns = []
            for h in header[1:]:
                m = HEADER_RE.search(h)
                columns.append((int(m.group(1)), m.group(2)))

            with cur.copy("COPY readings (time, feed_id, channel, value) FROM STDIN") as cp:
                for row in reader:
                    t = row[0]
                    for (fid, ch), v in zip(columns, row[1:]):
                        if v != "":
                            cp.write_row((t, fid, ch, float(v)))
                            n += 1
            print(f"  downloaded batch {i // BATCH_SIZE + 1}: {len(batch)} channels")

    print(f"\nLoaded {n:,} readings from {len(sensors)} sensor(s).")

    # Update the continuous aggregates ("cheat sheets"), if they exist.
    # CALL refresh_... can't run inside a transaction, hence autocommit.
    with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True) as conn:
        for view in ("daily_readings", "hourly_readings"):
            exists = conn.execute("SELECT to_regclass(%s)", (view,)).fetchone()[0]
            if exists:
                conn.execute(f"CALL refresh_continuous_aggregate('{view}', NULL, NULL)")
                print(f"Refreshed {view}.")


if __name__ == "__main__":
    main()