
"""
Find active outdoor PM2.5 sensors near saved cities.

Reads data/saved_cities.json and prints the sensors found
near each city. Does not modify the database.
"""
import csv
import io
import psycopg
import requests

from load_esdr import ESDR, HEADER_RE, BATCH_SIZE

MAX_PER_CITY = 40
HISTORY_DAYS = 365
CHUNK_DAYS = 30        # download one month at a time to keep responses small

HISTORY_SCHEMA = """
CREATE TABLE IF NOT EXISTS history_hourly (
    hour       TIMESTAMPTZ NOT NULL,
    feed_id    INT NOT NULL REFERENCES sensors(feed_id),
    avg_value  DOUBLE PRECISION,
    n_readings INT
);
SELECT create_hypertable('history_hourly', by_range('hour',
       INTERVAL '30 days'), if_not_exists => TRUE);
CREATE UNIQUE INDEX IF NOT EXISTS history_hourly_uq
    ON history_hourly (feed_id, hour);
"""

import json
import math
import os
import time
import argparse

from find_sensors import fetch_area, keep

HERE = os.path.dirname(os.path.abspath(__file__))
CITIES_FILE = os.path.join(HERE, "data", "saved_cities.json")

CHANNEL = "PM2_5"
DAYS = 30
RADIUS_KM = 25


def city_bounds(lat, lon, radius_km):
    """Return a bounding rectangle around a city."""
    lat_delta = radius_km / 111
    lon_delta = radius_km / (111 * max(abs(math.cos(math.radians(lat))), 0.01))

    return (
        max(-90, lat - lat_delta),
        max(-180, lon - lon_delta),
        min(90, lat + lat_delta),
        min(180, lon + lon_delta),
    )

def nearest(feeds, lat, lon, n):
    return sorted(feeds, key=lambda f: (f["latitude"] - lat) ** 2 + (f["longitude"] - lon) ** 2)[:n]


def download_hourly(ids, start_ts, end_ts):
    """Download raw readings and collapse them to hourly averages in memory."""
    totals = {}                                    # (feed_id, hour) -> [sum, count]
    pairs = [f"{i}.{CHANNEL}" for i in ids]
    for i in range(0, len(pairs), BATCH_SIZE):
        batch = pairs[i:i + BATCH_SIZE]
        t = start_ts
        while t < end_ts:
            t2 = min(t + CHUNK_DAYS * 86400, end_ts)
            resp = requests.get(
                f"{ESDR}/feeds/export/{','.join(batch)}",
                params={"from": t, "to": t2, "format": "csv", "timezone": "UTC"},
                timeout=600)
            resp.raise_for_status()
            reader = csv.reader(io.StringIO(resp.text))
            header = next(reader, None)
            if header:
                cols = []
                for h in header[1:]:
                    m = HEADER_RE.search(h)
                    cols.append(int(m.group(1)) if m else None)
                for row in reader:
                    hour = row[0][:13].replace("T", " ") + ":00:00+00"
                    for fid, v in zip(cols, row[1:]):
                        if fid and v != "":
                            acc = totals.setdefault((fid, hour), [0.0, 0])
                            acc[0] += float(v)
                            acc[1] += 1
            print(f"    batch {i // BATCH_SIZE + 1}, up to {time.strftime('%Y-%m-%d', time.gmtime(t2))}")
            t = t2
    return totals


def save_history(feeds, totals):
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute(HISTORY_SCHEMA)
        for f in feeds:     # loaded_at stays NULL so the live map still treats them as new
            cur.execute(
                """INSERT INTO sensors (feed_id, name, latitude, longitude)
                   VALUES (%s, %s, %s, %s) ON CONFLICT (feed_id) DO NOTHING""",
                (f["id"], f["name"], f["latitude"], f["longitude"]))
        cur.executemany(
            """INSERT INTO history_hourly (hour, feed_id, avg_value, n_readings)
               VALUES (%s, %s, %s, %s) ON CONFLICT (feed_id, hour) DO NOTHING""",
            [(hour, fid, s / n, n) for (fid, hour), (s, n) in totals.items()])
    print(f"  saved {len(totals):,} hourly rows")

def load_city(lat, lon):
    """Find sensors near a point, download a year of hourly data, save it. Returns rows saved."""
    south, west, north, east = city_bounds(lat, lon, RADIUS_KM)
    cutoff = time.time() - DAYS * 86400
    found = [f for f in fetch_area(south, west, north, east) if keep(f, CHANNEL, cutoff)]
    if not found:
        return 0
    chosen = nearest(found, lat, lon, MAX_PER_CITY)
    now = int(time.time())
    totals = download_hourly([f["id"] for f in chosen], now - HISTORY_DAYS * 86400, now)
    save_history(chosen, totals)
    return len(totals)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--city",
        help="Only process the saved city with this label"
    )
    parser.add_argument(
        "--load",
        action="store_true",
        help="Download a year of hourly history into Tiger Cloud"
    )
    args = parser.parse_args()

    if not os.path.exists(CITIES_FILE):
        print(f"Saved cities file not found: {CITIES_FILE}")
        return

    # Load saved cities first.
    with open(CITIES_FILE, encoding="utf-8") as f:
        cities = json.load(f)

    # Optionally filter to one city.
    if args.city:
        cities = [
            city for city in cities
            if city["label"].lower() == args.city.lower()
        ]

        if not cities:
            print(f"No saved city found with label: {args.city}")
            return

    if not cities:
        print("No saved cities found.")
        return

    cutoff = time.time() - DAYS * 86400
    all_feeds = {}

    for city in cities:
        label = city["label"]
        lat = float(city["lat"])
        lon = float(city["lon"])

        south, west, north, east = city_bounds(lat, lon, RADIUS_KM)

        print(f"\nSearching near {label} ({lat}, {lon})...")
        feeds = fetch_area(south, west, north, east)
        found = [feed for feed in feeds if keep(feed, CHANNEL, cutoff)]

        print(f"Found {len(found)} active outdoor PM2.5 sensor(s).")

        for feed in found:
            all_feeds[feed["id"]] = feed
            print(f"  {feed['id']}: {feed['name']}")

        if args.load and found:
            chosen = nearest(found, lat, lon, MAX_PER_CITY)
            now = int(time.time())
            print(f"  Loading {HISTORY_DAYS} days for the {len(chosen)} nearest sensors...")
            totals = download_hourly([f["id"] for f in chosen], now - HISTORY_DAYS * 86400, now)
            save_history(chosen, totals)

    print(f"\nCity search complete: {len(all_feeds)} unique sensors found.")

if __name__ == "__main__":
    main()
