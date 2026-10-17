# Air Quality Hackathon Project

We load air sensor data from [environmentaldata.org](https://environmentaldata.org) into a shared Tiger Cloud database (Postgres + TimescaleDB), query it with SQL, and show the results on a webpage.

## The data is already loaded

Everyone shares **one** database in the cloud. You do **not** need to run the loader to see the data. Ask a teammate for the connection string (sent privately, never committed here).

## Setup (Mac)

1. Install the database client:
   ```bash
   brew install libpq
   echo 'export PATH="/opt/homebrew/opt/libpq/bin:$PATH"' >> ~/.zshrc
   source ~/.zshrc
   psql --version
   ```

2. Connect to the shared database:
   ```bash
   psql 'PASTE_CONNECTION_STRING_HERE'
   ```
   Inside psql:
   - `\dt` lists the tables (you should see `sensors` and `readings`)
   - `\q` quits

## Tables

- **sensors**: `feed_id`, `name`, `latitude`, `longitude`
- **readings**: `time`, `feed_id`, `channel` (e.g. `PM2_5`, `PM10`, `temp_f`), `value`

## Example query: air quality by day and location

```sql
SELECT time_bucket('1 day', r.time) AS day,
       s.name, s.latitude, s.longitude,
       r.channel,
       round(avg(r.value)::numeric, 1) AS avg_value
FROM readings r
JOIN sensors s USING (feed_id)
WHERE r.channel IN ('PM2_5', 'PM10', 'PM10_a', 'PM10_b')
GROUP BY day, s.name, s.latitude, s.longitude, r.channel
ORDER BY day, s.name;
```

## Loading more data (only if needed)

Edit `CHANNELS`, `FROM_TS` and `TO_TS` at the top of `load_esdr.py`, then:

```bash
pip install -r requirements.txt
export DATABASE_URL='PASTE_CONNECTION_STRING_HERE'
python load_esdr.py
```

Re-running is safe: it replaces data in that time window instead of duplicating it.

## Never commit the connection string

It contains the database password. Share it privately, and keep it in your terminal (`export`) or a `.env` file, which `.gitignore` already excludes.