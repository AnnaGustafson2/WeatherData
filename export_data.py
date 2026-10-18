"""
Pull air quality data out of Tiger Cloud (Postgres + TimescaleDB) and save it
as a JSON file your webpage can load.

Why a file? A browser can't (and shouldn't) connect to your database directly:
that would put your DATABASE_URL password in your public page. Instead, this
script runs on your computer, reads the data, and writes data/air_quality.json.
The page loads that file.

Run (after load_esdr.py):
    export DATABASE_URL='postgres://tsdbadmin:PASSWORD@HOST:PORT/tsdb?sslmode=require'
    python export_data.py

Options:
    python export_data.py --days 7 --out data/air_quality.json

Needs the continuous aggregates from continuous_aggregates.sql
(daily_readings and hourly_readings).
"""
import argparse
import json
import os
from datetime import datetime, timezone

import psycopg


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--days", type=int, default=365, help="how many days back to export")
    p.add_argument("--channel", default="PM2_5")
    p.add_argument("--out", default="data/air_quality.json")
    a = p.parse_args()

    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        sensors = conn.execute(
            "SELECT feed_id, name, latitude, longitude FROM sensors ORDER BY name"
        ).fetchall()

        coverage = conn.execute(
            """
            SELECT
                MIN(day),
                MAX(day),
                COUNT(*),
                COUNT(DISTINCT feed_id)
            FROM daily_readings
            WHERE channel = %s
            """,
            (a.channel,),
        ).fetchone()

        print(
            "Daily data coverage:",
            f"earliest={coverage[0]}",
            f"latest={coverage[1]}",
            f"rows={coverage[2]}",
            f"sensors={coverage[3]}",
        )

        daily = conn.execute(
            """SELECT day, feed_id, avg_value, min_value, max_value
               FROM daily_readings
               WHERE channel = %s AND day >= now() - make_interval(days => %s)
               ORDER BY day, feed_id""",
            (a.channel, a.days),
        ).fetchall()

        hourly = conn.execute(
            """SELECT hour, feed_id, avg_value
               FROM hourly_readings
               WHERE channel = %s AND hour >= now() - make_interval(days => %s)
               ORDER BY hour, feed_id""",
            (a.channel, a.days),
        ).fetchall()

    r1 = lambda v: None if v is None else round(v, 1)
    iso = lambda t: t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    out = {
        "generated_at": iso(datetime.now(timezone.utc)),
        "channel": a.channel,
        "sensors": [
            {"feed_id": f, "name": n, "latitude": la, "longitude": lo}
            for f, n, la, lo in sensors
        ],
        # one row per sensor per day
        "daily": [
            {"day": iso(d), "feed_id": f, "avg": r1(av), "min": r1(mn), "max": r1(mx)}
            for d, f, av, mn, mx in daily
        ],
        # one row per sensor per hour
        "hourly": [
            {"time": iso(h), "feed_id": f, "avg": r1(av)} for h, f, av in hourly
        ],
    }

    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    with open(a.out, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))

    print(f"Wrote {a.out}: {len(out['sensors'])} sensors, "
          f"{len(out['daily'])} daily rows, {len(out['hourly'])} hourly rows.")


if __name__ == "__main__":
    main()