"""
Find active sensors in an area on environmentaldata.org (ESDR).

It asks ESDR for every sensor inside a map rectangle, then keeps only the
ones that:
  - sent data in the last N days (same rule as the map's "recent only" filter)
  - have the measurement you want (default: PM2_5)
  - are outdoors

Usage:
    python find_sensors.py SOUTH WEST NORTH EAST
    python find_sensors.py SOUTH WEST NORTH EAST --days 7 --channel PM2_5

Example (Houston, Texas):
    python find_sensors.py 29.5 -95.8 30.1 -95.0

How to get the 4 numbers: in Google Maps, right-click the bottom-left corner
of your area -> the first number is SOUTH, the second is WEST.
Right-click the top-right corner -> NORTH, EAST.

It prints a FEED_IDS list to paste into load_esdr.py, and saves the full
list to sensors_found.csv.
"""
import argparse
import csv
import time

import requests

ESDR = "https://esdr.cmucreatelab.org/api/v1"
PAGE_SIZE = 1000
SKIP_PRODUCTS = {100, 125}   # the map hides these sensor types too
FIELDS = "id,name,productId,exposure,latitude,longitude,maxTimeSecs,channelBounds"


def fetch_area(south, west, north, east):
    """Download every sensor inside the rectangle, page by page."""
    where = (f"latitude>={south},latitude<={north},"
             f"longitude>={west},longitude<={east}")
    rows, offset = [], 0
    while True:
        resp = requests.get(
            f"{ESDR}/feeds",
            params={"whereAnd": where, "fields": FIELDS,
                    "offset": offset, "limit": PAGE_SIZE},
            timeout=120,
        )
        resp.raise_for_status()
        data = resp.json()["data"]
        rows += data["rows"]
        print(f"  downloaded {len(rows):,} of {data['totalCount']:,} sensors in the area")
        offset += PAGE_SIZE
        if offset >= data["totalCount"] or not data["rows"]:
            return rows
        time.sleep(0.5)   # be polite to the server


def keep(feed, channel, cutoff):
    """Return True if this sensor is active, outdoors and has the channel."""
    if feed.get("productId") in SKIP_PRODUCTS:
        return False
    if feed.get("exposure") != "outdoor":
        return False
    channels = ((feed.get("channelBounds") or {}).get("channels") or {})
    if channel not in channels:
        return False
    # Use the channel's own last time, so we know THAT measurement is live
    last = channels[channel].get("maxTimeSecs") or 0
    return float(last) >= cutoff


def main():
    p = argparse.ArgumentParser(description="Find active sensors in an area.")
    p.add_argument("south", type=float)
    p.add_argument("west", type=float)
    p.add_argument("north", type=float)
    p.add_argument("east", type=float)
    p.add_argument("--days", type=int, default=30,
                   help="must have sent data in the last N days (default 30)")
    p.add_argument("--channel", default="PM2_5",
                   help="measurement the sensor must have (default PM2_5)")
    a = p.parse_args()

    if a.south >= a.north or a.west >= a.east:
        p.error("check the order: SOUTH WEST NORTH EAST "
                "(south < north and west < east)")

    print(f"Searching lat {a.south}..{a.north}, long {a.west}..{a.east}")
    feeds = fetch_area(a.south, a.west, a.north, a.east)

    cutoff = time.time() - a.days * 86400
    found = [f for f in feeds if keep(f, a.channel, cutoff)]
    found.sort(key=lambda f: f["name"])

    print(f"\n{len(found)} active outdoor sensor(s) with {a.channel} "
          f"in the last {a.days} days:\n")
    for f in found:
        print(f"  {f['id']:>8}  {f['name']}  ({f['latitude']}, {f['longitude']})")

    with open("sensors_found.csv", "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["feed_id", "name", "product_id", "latitude", "longitude"])
        for f in found:
            w.writerow([f["id"], f["name"], f["productId"], f["latitude"], f["longitude"]])

    if found:
        ids = ", ".join(str(f["id"]) for f in found)
        print(f"\nPaste this into load_esdr.py:\n\nFEED_IDS = [{ids}]\n")
        print("(Full list saved to sensors_found.csv)")
    else:
        print("\nNothing found. Try a bigger area, more --days, or another --channel.")


if __name__ == "__main__":
    main()