# Zephora

Zephora is an air-quality explorer. It maps outdoor PM2.5 sensors for any city, keeps a year of history for your saved cities, and emails you when the air in one of them turns unhealthy.

All sensor data lives in Tiger Cloud (Postgres + TimescaleDB), and the interesting work is done in plain SQL.

## Features

- **Live sensor map.** Search a city (about 1,000 US cities and 546 large cities worldwide, with accent-insensitive matching and old names like Bombay) or press "Load current map view". Each dot is a sensor, colored by its 24-hour average PM2.5 using EPA bands. Click a dot for an hourly chart.
- **Your cities.** Save favorites. Each card has a small map and a one-year line chart (daily average, min-to-max band across sensors, EPA bands in the background, hover tooltip with date, category, range and sensor count).
- **Automatic history.** Add a city and the server downloads its past year in the background. The chart shows "Downloading..." and fills in by itself.
- **Email alerts.** Each city card has a collapsible alerts panel. Pick an email and a level (Unhealthy for sensitive groups, Unhealthy, Very unhealthy). You get one email when the city crosses it, and every email has an unsubscribe link.
- **Performance and storage readout.** Under "Data and performance details", the page shows how fast the continuous aggregate answered compared with the raw table, and how much the columnstore saved.

## How it uses Tiger Data

| Feature | What it does here |
| --- | --- |
| **Hypertable** (`readings`) | Raw sensor readings, chunked by day. |
| **Columnstore** | Chunks older than 2 days are compressed (`segmentby feed_id, channel`, `orderby time DESC`). |
| **Continuous aggregates** (`hourly_readings`, `daily_readings`) | Pre-computed hourly and daily averages. The map reads from these. Real-time mode is on, so the newest readings are included. |
| **Second hypertable** (`history_hourly`) | A year of hourly averages per sensor for saved cities. Loaded with `ON CONFLICT DO NOTHING`, never deleted from, so it never touches compressed data. |
| **Relational + time-series in one query** | `alert_subscriptions` (a normal table) is joined to `hourly_readings` (a continuous aggregate) to compute each city's current PM2.5 and decide who gets an email. |

A city's PM2.5 for alerts is the **median** across sensors of each sensor's 24-hour average, so one broken sensor can't trigger a false alarm.

## Architecture

```
ESDR API (environmentaldata.org)
        |
        v
server.py (Flask) ---> Tiger Cloud (hypertables, aggregates, columnstore)
        |                      |
        |                      +--> alert checker (every 30 min) --> Resend --> email
        v
index.html + js/script.js (Leaflet map, D3 charts)
```

The browser never talks to the database. `DATABASE_URL` and the email API key stay on the server.

## Setup

You need Python 3.10+ and a Tiger Cloud service.

```bash
pip install -r requirements.txt
```

`requirements.txt` should include at least: `flask`, `psycopg[binary]`, `psycopg[pool]`, `requests`, `flask-compress` and `resend`. Remove any you did not add to the code.

Set environment variables in the terminal where you run the server. **Never commit them.**

```bash
export DATABASE_URL='postgres://tsdbadmin:PASSWORD@HOST:PORT/tsdb?sslmode=require'
export RESEND_API_KEY='re_...'          # check the exact name in server.py
export PUBLIC_URL='http://localhost:5050'   # used for unsubscribe links
```

If the email variables are not set, the server prints alert emails to the terminal instead of sending them (if you kept that dry-run behavior in `send_email`).

## Run

```bash
python server.py
```

Open http://localhost:5050. Opening `index.html` directly will not work, because the page calls the server's API.

On startup the server creates any missing tables, hypertables and aggregates, and compresses old chunks. Setup steps are safe to repeat; a failing step prints "setup step skipped" and the server still starts.

## Loading history by hand

Saving a city loads its history automatically. To load one from the command line:

```bash
python load_city_history.py --city "Seattle, Washington" --load
```

Without `--load` the script only lists the sensors it finds. It takes the 40 nearest sensors within 25 km and stores hourly averages. Re-running is safe.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/region?south&west&north&east` | Finds sensors in a box (max 3 degrees across), loads stale ones, returns sensors, hourly readings and timing. Add `compare=0` to skip the raw-table timing. |
| `GET /api/history?south&west&north&east` | One year of daily averages for a box. Starts a background download if the city has no history yet. |
| `POST /api/favorites` | Saves the browser's favorite cities to `data/saved_cities.json`. |
| `POST /api/alerts` | Creates or updates an email subscription. |
| `GET /api/alerts/unsubscribe?token=...` | Turns a subscription off. |
| `GET /api/storage` | Table size and columnstore compression stats. |

## Project files

```
server.py               Flask API, database setup, background loaders, alert checker
load_esdr.py            Original bulk loader (shared constants; do not run casually)
find_sensors.py         ESDR sensor discovery (fetch_area, keep)
load_city_history.py    Year-of-history loader (CLI and server)
continuous_aggregates.sql   SQL reference for the aggregates
index.html              Page layout
css/styles.css          Styles
js/script.js            Map, search, favorites, charts, alerts form
js/geographical_data.js City lists for search
data/saved_cities.json  Favorites synced from the browser
```

## Known limitations

- **Sensor coverage varies.** Outside the US it is patchy, and some cities have no active sensors.
- **Alerts need the server running.** The checker is a thread inside `server.py`. If the server stops, alerts stop.
- **Subscriptions are not double opt-in.** Anyone can enter any address. Each email has an unsubscribe link.
- **Alert state in the browser is local.** The "On" label on a card comes from localStorage and does not know about unsubscribes done through an email link.
- **Cities with fewer than 2 sensors never alert** (`MIN_SENSORS`).
- **Compression only applies to chunks older than 2 days**, so a fresh database shows no savings at first. With small data, the raw query can be as fast as the aggregate, and the page only claims a speedup when it is at least 1.5x.
- **Times are UTC.**
- **Downloads queue.** One city downloads at a time to protect the shared database and ESDR. Job status is kept in memory and resets on restart.
- **Duplicate or test units** exist in the data (for example near Washington, DC).

## Troubleshooting

- **"tuple decompression limit exceeded."** Reloads only replace the last 2 days for known sensors so they avoid compressed chunks, and the limit is also raised for the loading connection. If it returns, check that `HOT_SECS` and the `SET timescaledb.max_tuples_decompressed_per_dml_transaction = 0` line are still in `load_feeds`.
- **Chart says "No history loaded yet."** Wait for the background download, or run the command above.
- **Page looks stale after an update.** Hard refresh (Cmd+Shift+R).

## Data

Sensor data comes from the Environmental Sensor Data Repository (ESDR) at environmentaldata.org, run by the CMU CREATE Lab. PM2.5 categories follow US EPA breakpoints.