# DC Air Quality Hackathon Project

We pull air quality sensor data for **Washington, DC** from [environmentaldata.org](https://environmentaldata.org) (CMU's ESDR repository) into a shared **Tiger Cloud** database (Postgres + TimescaleDB), summarize it with SQL, and show it on a webpage.

```
environmentaldata.org  →  find_sensors.py / load_esdr.py  →  Tiger Cloud database  →  API  →  webpage
   (the data source)          (run on a laptop)               (shared by the team)
```

## The data is already loaded

Everyone shares **one** database in the cloud. You do **not** need to run anything to see the data. Ask a teammate for the connection string; it is shared privately and never committed here.

## Files

| File | What it does |
|---|---|
| `find_sensors.py` | Finds active sensors inside a map rectangle and prints their IDs |
| `load_esdr.py` | Downloads readings for those sensors and loads them into the database |
| `continuous_aggregates.sql` | Creates the daily and hourly summary tables (run once) |
| `requirements.txt` | Python packages the scripts need |

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
   ```

3. Save the connection string for this terminal window (repeat in each new window):
   ```bash
   export DATABASE_URL='PASTE_CONNECTION_STRING_HERE'
   ```

4. Connect:
   ```bash
   psql "$DATABASE_URL"
   ```
   Inside psql, `\dt` lists tables and `\q` quits. The prompt `tsdb=>` means you're inside the database: type SQL there, not terminal commands.

## Tables

| Table | One row per | Columns |
|---|---|---|
| `sensors` | sensor | `feed_id`, `name`, `latitude`, `longitude` |
| `readings` | raw reading (about every 2 min) | `time`, `feed_id`, `channel`, `value` |
| `daily_readings` | sensor, channel, day | `day`, `feed_id`, `channel`, `avg_value`, `min_value`, `max_value`, `n_readings` |
| `hourly_readings` | sensor, channel, hour | `hour`, `feed_id`, `channel`, `avg_value`, `min_value`, `max_value`, `n_readings` |

`readings` is a TimescaleDB **hypertable**. `daily_readings` and `hourly_readings` are **continuous aggregates**: summary tables Tiger Data keeps up to date, so the webpage reads small summaries instead of millions of raw rows.

Currently loaded: **104 DC-area sensors**, **PM2.5**, **last 7 days** at load time. This includes 5 government AirNow monitors (`5319`, `26205`, `2615`, `2614`, `172361`).

## Example queries

Daily PM2.5 per sensor with locations (for the map):
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

## Changing or refreshing the data

1. Find sensors in an area (numbers are `SOUTH WEST NORTH EAST`; get them by right-clicking corners in Google Maps):
   ```bash
   python find_sensors.py 38.79 -77.12 39.00 -76.91
   ```
   Options: `--days 7` (active in the last week), `--channel PM10`.

2. Paste the printed `FEED_IDS = [...]` into `load_esdr.py`. You can also change `WANTED_CHANNELS` (e.g. add `"temp_f"`, `"humidity"`) and `DAYS` there. More channels and days means more rows and a slower load.

3. Load:
   ```bash
   python load_esdr.py
   ```
   It prints **OK** or **SKIP** (with the reason) for each sensor, loads the data, and refreshes the summary tables. Re-running is safe: it replaces data in the time window instead of duplicating it.

To start over with an empty database (deletes all loaded data, check with the team first), run in psql:
```sql
TRUNCATE readings, sensors;
```

## Data notes

- **Clusters:** 12 "MIAEH" sensors sit at nearly the same spot near the University of Maryland, and 6 "CheverlyAQM" sensors are close together. Averages across all sensors can be skewed toward those areas.
- **Possible duplicates / test units:** "Aggie Manor" (184150, 207654), "chez finn" (185313, 207665), and `250test-out` (203362).
- **Times** are stored in UTC. Use `AT TIME ZONE 'America/New_York'` for local time.

## Never commit the connection string

It contains the database password. Share it privately, and keep it in your terminal (`export`) or a `.env` file, which `.gitignore` already excludes.