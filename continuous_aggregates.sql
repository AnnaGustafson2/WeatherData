-- Continuous aggregates for the air quality project.
-- Run once:  psql "$DATABASE_URL" -f continuous_aggregates.sql

-- 1) DAILY cheat sheet: one row per sensor, per channel, per day.
--    Use it for the map ("how dusty was each place on June 18?")
--    and day-by-day bar charts.
CREATE MATERIALIZED VIEW IF NOT EXISTS daily_readings
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 day', time) AS day,
       feed_id,
       channel,
       avg(value)  AS avg_value,
       min(value)  AS min_value,
       max(value)  AS max_value,
       count(*)    AS n_readings
FROM readings
GROUP BY day, feed_id, channel;

-- 2) HOURLY cheat sheet: same idea, one row per hour.
--    Use it for line charts and "what time of day is the air worst?"
CREATE MATERIALIZED VIEW IF NOT EXISTS hourly_readings
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', time) AS hour,
       feed_id,
       channel,
       avg(value)  AS avg_value,
       min(value)  AS min_value,
       max(value)  AS max_value,
       count(*)    AS n_readings
FROM readings
GROUP BY hour, feed_id, channel;

-- 3) Keep them up to date automatically for NEW data (last 3 days),
--    refreshed every hour. Older data is handled by the manual refresh
--    at the end of load_esdr.py.
SELECT add_continuous_aggregate_policy('daily_readings',
    start_offset      => INTERVAL '3 days',
    end_offset        => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists     => TRUE);

SELECT add_continuous_aggregate_policy('hourly_readings',
    start_offset      => INTERVAL '3 days',
    end_offset        => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists     => TRUE);

-- ---------------------------------------------------------------
-- Example queries for the webpage
-- ---------------------------------------------------------------

-- Map: average PM2.5 per sensor on each day, with locations
-- SELECT d.day, s.name, s.latitude, s.longitude,
--        round(d.avg_value::numeric, 1) AS pm25
-- FROM daily_readings d
-- JOIN sensors s USING (feed_id)
-- WHERE d.channel = 'PM2_5'
-- ORDER BY d.day, s.name;

-- Line chart: hourly PM2.5 for one sensor
-- SELECT hour, round(avg_value::numeric, 1) AS pm25
-- FROM hourly_readings
-- WHERE feed_id = 123139 AND channel = 'PM2_5'
-- ORDER BY hour;

-- "Worst time of day": average PM2.5 by hour of the day (0-23)
-- SELECT extract(hour FROM hour) AS hour_of_day,
--        round(avg(avg_value)::numeric, 1) AS pm25
-- FROM hourly_readings
-- WHERE channel = 'PM2_5'
-- GROUP BY hour_of_day
-- ORDER BY hour_of_day;