"""
Load sensor data from environmentaldata.org (ESDR) into Tiger Cloud (Postgres + TimescaleDB).

Setup (once):
    pip install requests "psycopg[binary]"
    export DATABASE_URL='postgres://tsdbadmin:PASSWORD@HOST:PORT/tsdb?sslmode=require'
        (Windows PowerShell:  $env:DATABASE_URL = '...')

Run:
    python load_esdr.py

Safe to re-run: it clears the same time window for the same sensors before reloading.
"""
import csv
import io
import os
import re

import psycopg
import requests

ESDR = "https://esdr.cmucreatelab.org/api/v1"

# Copied from your environmentaldata.org link ("feedId.channel")
CHANNELS = [
    "100036.humidity", "100036.pressure", "100036.temp_f",
    "100036.PM10_a", "100036.PM10_b",
    "122754.pressure",
    "123139.PM10", "123139.PM10_a", "123139.PM10_b", "123139.PM2_5",
]

# Time window from the link (UNIX seconds) -> roughly Jun 15 - Jun 24, 2026
FROM_TS = 1781509280
TO_TS = 1782264006

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
    channel  TEXT             NOT NULL,   -- e.g. PM2_5, PM10_a, temp_f
    value    DOUBLE PRECISION
);

-- Turn readings into a TimescaleDB hypertable (fast time-series queries)
SELECT create_hypertable('readings', by_range('time'), if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS readings_feed_channel_time
    ON readings (feed_id, channel, time DESC);
"""

# ESDR export headers look like "3.feed_100036.PM10_a"
HEADER_RE = re.compile(r"feed_(\d+)\.(.+)$")


def main():
    feed_ids = sorted({int(c.split(".")[0]) for c in CHANNELS})

    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute(SCHEMA)

        # 1) Sensor locations (name, lat, long) for each feed
        for fid in feed_ids:
            info = requests.get(
                f"{ESDR}/feeds/{fid}",
                params={"fields": "id,name,latitude,longitude"},
                timeout=60,
            ).json()["data"]
            cur.execute(
                """INSERT INTO sensors (feed_id, name, latitude, longitude)
                   VALUES (%s, %s, %s, %s)
                   ON CONFLICT (feed_id) DO UPDATE
                   SET name = EXCLUDED.name,
                       latitude = EXCLUDED.latitude,
                       longitude = EXCLUDED.longitude""",
                (info["id"], info["name"], info["latitude"], info["longitude"]),
            )
            print(f"sensor {fid}: {info['name']} ({info['latitude']}, {info['longitude']})")

        # 2) Download the readings as CSV (one column per feed.channel)
        resp = requests.get(
            f"{ESDR}/feeds/export/{','.join(CHANNELS)}",
            params={"from": FROM_TS, "to": TO_TS, "format": "csv", "timezone": "UTC"},
            timeout=600,
        )
        resp.raise_for_status()
        reader = csv.reader(io.StringIO(resp.text))
        header = next(reader)

        columns = []
        for h in header[1:]:
            m = HEADER_RE.search(h)
            columns.append((int(m.group(1)), m.group(2)))

        # 3) Clear this window so re-runs don't duplicate rows
        cur.execute(
            """DELETE FROM readings
               WHERE feed_id = ANY(%s)
                 AND time BETWEEN to_timestamp(%s) AND to_timestamp(%s)""",
            (feed_ids, FROM_TS, TO_TS),
        )

        # 4) Reshape wide -> long and bulk-load with COPY
        n = 0
        with cur.copy("COPY readings (time, feed_id, channel, value) FROM STDIN") as cp:
            for row in reader:
                t = row[0]
                for (fid, ch), v in zip(columns, row[1:]):
                    if v != "":
                        cp.write_row((t, fid, ch, float(v)))
                        n += 1

    print(f"Loaded {n:,} readings.")


if __name__ == "__main__":
    main()