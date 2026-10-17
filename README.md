# Air Quality Map: Hackathon Project

An interactive map of outdoor air quality (PM2.5) for **any city**. Type a city, and the app pulls live sensor data from [environmentaldata.org](https://environmentaldata.org) (CMU's ESDR repository), stores it in **Tiger Cloud** (Postgres + TimescaleDB), summarizes it with SQL, and draws each sensor as a colored dot. Click a dot to see its hourly history.

```
environmentaldata.org ──► server.py (Flask API) ──► Tiger Cloud database
   (sensor data)            │  loads sensors on demand      (hypertable, continuous aggregates,
                            │                                columnstore compression)
                            ▼
                  index.html (Leaflet map)  ◄── /api/region, /api/storage
```

The database password stays on the server and never reaches the browser.

## What the page does

- **City search with autocomplete.** Start typing and pick a city. About 1,000 US cities plus about 550 big cities worldwide (population over 1 million) are built in. Search ignores accents ("sao pa" finds São Paulo), understands old names ("bombay", "bangalore", "saigon"), and ranks bigger cities first.
- **Any other place.** Pan and zoom the map, then press **Load current map view**.
- **Colored dots.** Each dot is a sensor, colored by its average PM2.5 over the last 24 hours using the US EPA bands: green (0–9 µg/m³), yellow (9–35), orange (35–55), red (55–125), purple (125–225), maroon (225+). Gray means no data in the last 24 hours.
- **Click a dot** for a line chart of that sensor's hourly PM2.5 over the loaded window (7 days).
- **Live Tiger Data stats.** Under the map controls the page shows how long the chart query took (continuous aggregate vs the raw table) and how big the database is and how much the columnstore has compressed.

"Last 24 hours" is measured back from the newest reading in the data, not from the current clock time.

## How Tiger Data is used

| Tiger Data feature | Where we use it |
|---|---|
| **Hypertable** | `readings` is partitioned by time, loaded in bulk with `COPY` |
| **Standard SQL** | `time_bucket`, joins between `sensors` and `readings`, no special query language |
| **Continuous aggregates** | `hourly_readings` and `daily_readings`. The page reads these small pre-computed summaries instead of aggregating raw rows on every request |
| **Real-time aggregation** | The aggregates are set to `materialized_only = false`, so they also include readings newer than the last refresh |
| **Refresh policies + manual refresh** | Policies refresh the last 3 days every hour; the server also refreshes the window right after it loads new sensors |
| **Columnstore compression** | `readings` is segmented by `feed_id, channel` and ordered by `time DESC`. A policy compresses chunks older than 2 days, and the server converts any existing old chunks at startup |
| **Relational + time-series together** | Sensor metadata (`sensors`) lives beside the high-frequency `readings` in one database |
| **Visible performance** | Each response times the aggregate query and the same query on raw `readings`; `/api/storage` reports compression with `hypertable_columnstore_stats()` |

Honest notes: with only a few hundred thousand rows, the raw query can be as fast as the aggregate. The page prints the real numbers either way. Compression only applies to chunks older than 2 days, so the storage line says "No chunks are in the columnstore yet" until data ages. For a clean demo, run `TRUNCATE readings;`, restart the server, and let data accumulate.

## Files

| File | What it does |
|---|---|
| `server.py` | Flask server. Creates the aggregates and compression policy at startup, loads sensors for a requested area on demand, serves the page and the API |
| `index.html` | The map page (Leaflet, city search, popups with charts, timing and storage lines) |
| `find_sensors.py` | Finds active sensors inside a map rectangle (used by `server.py`, and runnable on its own) |
| `load_esdr.py` | Downloads readings for a list of feed IDs and loads them (used by `server.py`, and runnable on its own for the DC seed data) |
| `continuous_aggregates.sql` | Creates the daily and hourly aggregates by hand. Optional now, because `server.py` creates them at startup |
| `export_data.py` | Optional: writes `data/air_quality.json` for a static page. The current `index.html` does not use it |
| `regions.json` | Preset DC quadrants. Optional: the page no longer reads it, though `server.py` still serves it |
| `requirements.txt` | Python packages: `psycopg[binary]`, `requests`, `flask` (add `flask` if it's missing) |

## Setup (Mac)

1. Install the database client:
   ```bash
   brew install libpq
   echo 'export PATH="/opt/homebrew/opt/libpq/bin:$PATH"' >> ~/.zshrc
   source ~/.zshrc
   psql --version
   ```

2. Install the Python packages:
   ```bash
   pip install -r requirements.txt
   pip install flask        # only if flask isn't in requirements.txt yet
   ```

3. Save the connection string for this terminal window (repeat in each new window). Ask a teammate for it; it is shared privately and never committed here:
   ```bash
   export DATABASE_URL='PASTE_CONNECTION_STRING_HERE'
   ```

4. Optional: connect with psql. `\dt` lists tables and `\q` quits. The prompt `tsdb=>` means you're inside the database: type SQL there, not terminal commands.
   ```bash
   psql "$DATABASE_URL"
   ```

## Run the app

Keep `server.py`, `find_sensors.py`, `load_esdr.py` and `index.html` in the same folder.

```bash
export DATABASE_URL='...'
python server.py
```

Open **http://localhost:5000**. Do not double-click `index.html` or use `python -m http.server`: the page needs the server's API.

Watch the startup output. Each database setup step is safe to repeat. If your Tiger version doesn't support one, it prints `setup step skipped` with the error and the server still starts.

The first time a city is loaded it can take up to a minute while the server downloads that area from ESDR. After that, its sensors are reused from the database for an hour.

## Limits (top of `server.py`)

| Setting | Value | Meaning |
|---|---|---|
| `CHANNEL` | `PM2_5` | The measurement shown |
| `DAYS` | 7 | History loaded per sensor |
| `MAX_SPAN` | 3 degrees | Biggest area one request may cover |
| `MAX_SENSORS` | 150 | Most sensors loaded per request (the page tells you when it cuts the list) |
| `FRESH_SECS` | 3600 | A sensor is reloaded if its data is older than this |

A city search loads a box about 20 miles across, centered on the city (change `0.15` in the `choose` function in `index.html`).

## API

| Endpoint | Returns |
|---|---|
| `GET /api/region?south=&west=&north=&east=` | Sensors and hourly readings for the area, plus a `perf` block (aggregate query time, raw query time, row counts, sensors downloaded). Add `&compare=0` to skip the raw-table timing |
| `GET /api/storage` | Row estimate, table size, and columnstore compression stats |
| `GET /` | `index.html` |

## Tables

| Table | One row per | Columns |
|---|---|---|
| `sensors` | sensor | `feed_id`, `name`, `latitude`, `longitude`, `loaded_at` |
| `readings` | raw reading (about every 2 min) | `time`, `feed_id`, `channel`, `value` |
| `daily_readings` | sensor, channel, day | `day`, `feed_id`, `channel`, `avg_value`, `min_value`, `max_value`, `n_readings` |
| `hourly_readings` | sensor, channel, hour | `hour`, `feed_id`, `channel`, `avg_value`, `min_value`, `max_value`, `n_readings` |

`readings` is a TimescaleDB **hypertable** with the columnstore enabled. `daily_readings` and `hourly_readings` are **continuous aggregates** that Tiger Data keeps up to date.

The original seed data is **104 DC-area sensors** (PM2.5, 7 days), including 5 government AirNow monitors (`5319`, `26205`, `2615`, `2614`, `172361`). Other cities are added the first time someone searches for them.

## Example queries

Daily PM2.5 per sensor with locations:
```sql
SELECT d.day, s.name, s.latitude, s.longitude,
       round(d.avg_value::numeric, 1) AS pm25
FROM daily_readings d
JOIN sensors s USING (feed_id)
WHERE d.channel = 'PM2_5'
ORDER BY d.day, s.name;
```

Average PM2.5 by hour of the day (when is the air worst?):
```sql
SELECT extract(hour FROM hour AT TIME ZONE 'America/New_York') AS hour_of_day,
       round(avg(avg_value)::numeric, 1) AS pm25
FROM hourly_readings
WHERE channel = 'PM2_5'
GROUP BY hour_of_day
ORDER BY hour_of_day;
```

How much has the columnstore saved?
```sql
SELECT total_chunks, number_compressed_chunks,
       pg_size_pretty(before_compression_total_bytes) AS before,
       pg_size_pretty(after_compression_total_bytes)  AS after
FROM hypertable_columnstore_stats('readings');
```

## Seeding or refreshing data by hand (optional)

The server loads areas on demand, but you can still seed a region in advance:

1. Find sensors (numbers are `SOUTH WEST NORTH EAST`; get them by right-clicking corners in Google Maps):
   ```bash
   python find_sensors.py 38.79 -77.12 39.00 -76.91
   ```
   Options: `--days 7` (active in the last week), `--channel PM10`.

2. Paste the printed `FEED_IDS = [...]` into `load_esdr.py`. You can also change `WANTED_CHANNELS` and `DAYS` there. More channels and days means more rows and a slower load.

3. Load:
   ```bash
   python load_esdr.py
   ```
   It prints **OK** or **SKIP** (with the reason) for each sensor, loads the data, and refreshes the summary tables. Re-running is safe: it replaces data in the time window instead of duplicating it.

To start over with an empty database (deletes all loaded data, check with the team first), run in psql:
```sql
TRUNCATE readings, sensors;
```

## Customizing

- **Colors and thresholds:** the `BANDS` array at the top of the script in `index.html`.
- **Compression timing and chunk size:** `SETUP_STEPS` in `server.py` (`after => INTERVAL '2 days'`, 1-day chunks).
- **More measurements:** change `CHANNEL` in `server.py`. The color bands are for PM2.5, so adjust them for other channels.

## Troubleshooting

| Problem | Fix |
|---|---|
| `KeyError: 'DATABASE_URL'` | Run the `export DATABASE_URL=...` line in this terminal window |
| Page says it couldn't load a region | Open it at http://localhost:5000 with `python server.py` running |
| "Area too big" | Zoom in until the map is under 3 degrees across |
| "No active outdoor PM2.5 sensors found" | Common outside the US, where coverage is patchy. Zoom out and press **Load current map view** |
| `setup step skipped ...` at startup | That feature isn't available on your Tiger version. The server still runs; paste the error to a teammate |
| `404` for `css/styles.css` in the browser console | Harmless. Create an empty `css/styles.css` or remove the `<link>` line |
| Storage line says no chunks are compressed | Chunks compress once they are 2 days old. See the demo tip under "How Tiger Data is used" |

## Data notes

- **Clusters:** 12 "MIAEH" sensors sit at nearly the same spot near the University of Maryland, and 6 "CheverlyAQM" sensors are close together. Averages across all sensors can be skewed toward those areas.
- **Possible duplicates / test units:** "Aggie Manor" (184150, 207654), "chez finn" (185313, 207665), and `250test-out` (203362).
- **Government monitors:** the AirNow monitors are US-only.
- **Times** are stored in UTC. Use `AT TIME ZONE 'America/New_York'` for local time.
- **Hourly values** are averages of the raw readings in each hour; the dot color averages those hourly values over 24 hours.

## Ideas for next steps

- A saved-cities table with alert thresholds, to show relational data beside the metric stream.
- Richer time-series analytics in the page, such as "worst hour of the day" or a comparison with the previous day.
- A time slider that scrubs the dots through the loaded week.
- Marking the AirNow monitors differently, since they are more accurate than low-cost sensors.
