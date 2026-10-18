# Zephora

**Your air, at a glance.**

Zephora keeps track of the air in the places you care about. Save your cities and you get their live PM2.5 reading, a year of history, and an email when the air there turns unhealthy. You can also explore outdoor air sensors in any city on an interactive map.

It's built on real community sensor data from Carnegie Mellon's Environmental Sensor Data Repository, stored and summarized in **Tiger Cloud** (PostgreSQL + TimescaleDB), with an interface designed around published usability research.

*Built at Technica 2026.*

![Zephora: the Your cities view](design_documentation/after-tabs-cities-desktop.png)

---

## Contents

1. [Why air quality matters](#1-why-air-quality-matters)
2. [What Zephora does](#2-what-zephora-does)
3. [How Zephora fits each prize track](#3-how-zephora-fits-each-prize-track)
4. [The sensor data](#4-the-sensor-data)
5. [How we use Tiger Data](#5-how-we-use-tiger-data)
6. [UI/UX design](#6-uiux-design)
7. [Architecture](#7-architecture)
8. [Setup and running](#8-setup-and-running)
9. [API and project files](#9-api-and-project-files)
10. [Known limitations](#10-known-limitations)
11. [What we'd build next](#11-what-wed-build-next)
12. [Sources](#12-sources)
13. [AI inclusion disclosure](#13-ai-inclusion-disclosure)

---

## 1. Why air quality matters

**Air pollution is one of the world's biggest health risks, and you usually can't see it.**

- **It's the #2 risk factor for death worldwide.** Air pollution was linked to about **8.1 million deaths in 2021**, including about 709,000 children under 5. *(State of Global Air 2024) [[1]](#sources-health)*
- **Almost everyone breathes it.** In 2019, **99% of the world's population** lived where the World Health Organization's air quality guidelines were not met. Outdoor air pollution alone caused an estimated **4.2 million premature deaths**, mostly from heart disease and stroke (68%), lung disease (14%), respiratory infections (14%) and lung cancer (4%). *(WHO) [[2]](#sources-health)*
- **The particles are tiny enough to get inside your body.** PM2.5 means particles 2.5 micrometers or smaller, about 30 times thinner than a human hair. They can "get deep into your lungs and some may even get into your bloodstream," and they carry the greatest health risk of all particle sizes. They come from vehicles, power plants, factories and fires. *(US EPA) [[3]](#sources-health)*
- **It's a problem in the US too.** In 2026, **44% of Americans (152.3 million people)** live in places that get a failing grade for air pollution, and **76 million** live in counties that fail for year-round particle pollution. *(American Lung Association, State of the Air 2026) [[4]](#sources-health)*
- **It isn't shared equally.** People of color are 42.1% of the US population but 54.2% of people living in counties with at least one failing grade *[[4]](#sources-health)*. An EPA-funded study found that people of color face higher-than-average PM2.5 exposure from sources that cause 75% of total exposure, a gap that holds "for people at all income levels." *(Tessum et al. 2021, summarized by the EPA) [[5]](#sources-health)*
- **Standards are getting stricter because the science says lower is safer.** In 2024 the EPA lowered the annual PM2.5 standard to **9.0 µg/m³** and changed the Air Quality Index so that "Good" now ends at 9.0 instead of 12.0 *[[6]](#sources-health)*. The WHO's guideline is stricter still: 5 µg/m³ yearly and 15 µg/m³ over 24 hours *[[7]](#sources-health)*.
- **It can change fast, even here.** On June 8, 2023, smoke from Canadian wildfires pushed Washington, DC to a rare **Code Purple ("Very Unhealthy")**, with particle levels the highest since 2003. *(WTOP) [[8]](#sources-health)*

**Why that's the problem Zephora solves:** air quality changes by the hour and by the neighborhood, and the people most at risk (people with asthma or heart and lung conditions, kids, older adults) need to know *when* to change their plans. Government agencies already send air quality alerts by email, such as the EPA's EnviroFlash *[[9]](#sources-health)*. Zephora brings that idea to the dense networks of community sensors, for any city you follow.

---

## 2. What Zephora does

| Feature | What you get |
|---|---|
| **Live "right now" reading** | The page opens with the current PM2.5 for your first saved city (or Washington, DC on your first visit): the number, the EPA category, how many sensors it's based on, and how recent it is. |
| **Your cities** | Every saved city gets a card with its current category, a small sensor map, a one-year chart (daily average, the range across sensors, and EPA color bands), and an email-alert panel. |
| **Explore map** | Search about 1,546 cities (1,000 US cities and 546 large world cities, accent-insensitive, and old names like Bombay work). Each dot is a sensor colored by its 24-hour average; click one for its hourly chart. Drag the map and press **Search this area** to load anywhere. |
| **Automatic history** | When you save a city, the server downloads that city's past year in the background, and the chart fills in by itself. |
| **Email alerts** | Pick a level (Unhealthy for sensitive groups, Unhealthy, or Very unhealthy). You get **one** email when the city crosses it, not one every half hour, and every email has an unsubscribe link. |
| **"Powered by Tiger Data" stats** | Under the map: how fast the database answered, how much faster that was than scanning raw readings, how many readings were summarized, and how much compression saved. |
| **About page** | An interactive guide to what each air quality level means for your health, with both the AQI and the PM2.5 values. |

---

## 3. How Zephora fits each prize track

| Track | What to look at |
|---|---|
| **Sensors for Good** (STR) | Real community and government sensor data turned into personal protection: live readings, a year of history, and alerts timed for the people most at risk. See [§1](#1-why-air-quality-matters) and [§4](#4-the-sensor-data). |
| **Best Use of Tiger Data** (MLH) | Hypertables, two continuous aggregates in real-time mode, the columnstore with a compression policy, a second hypertable for history, and one SQL query that joins user subscriptions to time-series data to decide who gets an email. Speed and compression are measured live on the page. See [§5](#5-how-we-use-tiger-data). |
| **Best UI/UX** (Technica) | Every major design decision is tied to published research (Nielsen Norman Group, Apple, W3C), with official EPA colors, measured contrast ratios, and before/after screenshots. See [§6](#6-uiux-design). |

---

## 4. The sensor data

### Where it comes from

All readings come from the **Environmental Sensor Data Repository (ESDR)**, an open-source repository for time-series environmental data built by Carnegie Mellon University's CREATE Lab, and browsable at [environmentaldata.org](https://environmentaldata.org) *[[10]](#sources-data)*. ESDR's public API lets anyone list sensors in an area and export their readings, with no login.

Two kinds of sensors show up in our data:

| Sensor type | What it is | Example (Washington, DC) |
|---|---|---|
| **PurpleAir** | Low-cost laser particle sensors owned by residents, schools, churches and community groups. Dense coverage, readings every couple of minutes. | Most of the ~100 active DC sensors |
| **AirNow** | Government reference monitors run by the EPA with state and local agencies. Fewer, very accurate, hourly. | McMillan Reservoir, River Terrace, King Greenleaf Rec Center |

For example, our first Washington, DC load found **96 active sensors** and **367,209 readings in one week**.

### Which sensors we use

For any area, the server asks ESDR for every sensor inside a map rectangle and keeps one only if it:

1. **is outdoors** (indoor sensors measure someone's living room, not the neighborhood),
2. **has a PM2.5 channel**, and
3. **sent PM2.5 data recently** (the last 7 days for the map, the last 30 days for year-long history), checked on the PM2.5 channel itself rather than on the sensor as a whole.

It also skips two sensor types that environmentaldata.org's own map hides.

### How we turn readings into one number

1. **Per sensor:** the average of its readings over the last 24 hours. This matches how the EPA defines its daily PM2.5 categories.
2. **Per city:** the **median** of those sensor averages, within a box about 33 km tall around the city. We use the median rather than the mean, so one broken or badly placed sensor can't make a whole city look unhealthy. The email alerts use exactly the same rule, so the card and the alerts always agree.
3. **Category:** the EPA's PM2.5 breakpoints, as updated in May 2024 *[[6]](#sources-health)*:

| Category | AQI | PM2.5 (µg/m³, 24-hour) | EPA color |
|---|---|---|---|
| Good | 0–50 | 0.0–9.0 | `#00e400` |
| Moderate | 51–100 | 9.1–35.4 | `#ffff00` |
| Unhealthy for sensitive groups | 101–150 | 35.5–55.4 | `#ff7e00` |
| Unhealthy | 151–200 | 55.5–125.4 | `#ff0000` |
| Very unhealthy | 201–300 | 125.5–225.4 | `#8f3f97` |
| Hazardous | 301+ | 225.5+ | `#7e0023` |

**Alert safeguards:** a city must have **at least 2 reporting sensors** to trigger an alert. After an alert is sent, it only resets once the air drops below **90% of your threshold**, so readings hovering around the line don't send a burst of emails.

### Data quality: what to keep in mind

- **Uncorrected PurpleAir readings run high.** An EPA study of nearly 12,000 daily averages in 16 states found that uncorrected PurpleAir sensors **overestimate PM2.5 by roughly 40%**. A correction that uses relative humidity cuts the typical error from 8 to 3 µg/m³, and the EPA applies it on its AirNow Fire and Smoke Map *[[11]](#sources-data)*. **Zephora currently shows uncorrected values**, so its numbers can lean high, which is the cautious direction for health alerts. Applying the EPA correction is our top next step (see [§11](#11-what-wed-build-next)); the PurpleAir feeds in ESDR already report humidity.
- **Coverage is uneven.** Dense in many US cities, patchy elsewhere; some cities have no active sensors.
- **Duplicates and test units exist.** Near DC, for example: two "Aggie Manor" sensors, two "chez finn" sensors, a cluster of 12 sensors at almost one point near the University of Maryland, and a unit named `250test-out`. Using the median keeps these from skewing city numbers.
- **One sensor isn't your exact exposure.** Readings describe a location and time, not every person nearby.

---

## 5. How we use Tiger Data

All sensor data lives in **Tiger Cloud** (PostgreSQL + TimescaleDB). The browser never talks to the database; only the Flask server does.

### Features we use

| Tiger Data feature | What it does in Zephora |
|---|---|
| **Hypertable** (`readings`) | Every raw reading (time, sensor, channel, value). A hypertable is a Postgres table that's automatically split into time-based **chunks** (1 day each here), so a query only touches the days it needs *[[12]](#sources-tiger)*. |
| **Continuous aggregates** (`hourly_readings`, `daily_readings`) | Pre-computed hourly and daily average, min, max and count per sensor. Tiger refreshes them in the background, updating only the parts that changed *[[13]](#sources-tiger)*. The map, the hero card and the alerts all read from these instead of re-scanning raw readings. |
| **Real-time mode** (`materialized_only = false`) | Results combine the stored summaries **and** the newest raw readings that haven't been summarized yet, so nothing is stale *[[14]](#sources-tiger)*. |
| **Refresh policies** | Both aggregates refresh every hour for the last 3 days. After a bulk load, the server also refreshes the exact window it just loaded. |
| **Columnstore (hypercore) compression** | Chunks older than 2 days move to compressed columnar storage, grouped by sensor and channel (`segmentby feed_id, channel`) and ordered by time. Tiger documents 90–98% storage reduction for columnstore data *[[15]](#sources-tiger)*. |
| **Second hypertable** (`history_hourly`) | A year of hourly averages per sensor for saved cities (the 40 nearest sensors within 25 km), in 30-day chunks. It's insert-only (`ON CONFLICT DO NOTHING`), so it never has to rewrite compressed data. |
| **Relational + time-series in one query** | `alert_subscriptions` (a normal table of emails and thresholds) is joined to `hourly_readings` (a continuous aggregate) to compute each city's median PM2.5 and decide who gets an email. |

### The alert check, in SQL

Every 30 minutes the server runs one query that combines user data and sensor data:

```sql
-- City PM2.5 = median across nearby sensors of each sensor's 24-hour average
SELECT s.id, s.email, s.city_label, s.threshold,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY a.avg24) AS city_pm25,
       count(*) AS n_sensors
FROM alert_subscriptions s
JOIN LATERAL (
    SELECT h.feed_id, avg(h.avg_value) AS avg24
    FROM sensors se
    JOIN hourly_readings h ON h.feed_id = se.feed_id        -- continuous aggregate
    WHERE se.latitude  BETWEEN s.lat - 0.15 AND s.lat + 0.15
      AND se.longitude BETWEEN s.lon - 0.15 / cos(radians(s.lat))
                           AND s.lon + 0.15 / cos(radians(s.lat))
      AND h.channel = 'PM2_5' AND h.hour >= now() - interval '24 hours'
    GROUP BY h.feed_id
) a ON true
WHERE s.active
GROUP BY s.id;
```

### How we know it works

- **Accuracy check:** we compared the continuous aggregate's daily average with the same average computed from raw readings for a test day. Both gave **82.01 µg/m³**.
- **Live measurements on the page:** every map load times the same question against the continuous aggregate and against the raw `readings` table, and shows the query time and the speedup. Speedups are only claimed when the aggregate is at least 1.5× faster. Compression stats come from Tiger's `hypertable_columnstore_stats()`.
- **Safe to restart:** on startup the server creates any missing tables, aggregates and policies, and compresses chunks older than 2 days. Every step is safe to repeat.

---

## 6. UI/UX design

### Who it's for

Zephora's core job is to **keep track of the places you care about**. That gives us two kinds of visitors:

| | First-time visitor | Returning visitor |
|---|---|---|
| Main question | "Is the air OK where I am, and what is this?" | "How's the air in *my* cities today?" |
| Needs | Find a city, understand the colors, save it | See saved cities right away, no searching |
| How often | Once | Daily, or when an alert email arrives |

Many people in both groups have asthma, heart or lung conditions, or care for kids or older adults, the groups the EPA's "sensitive groups" category is about.

### Design principles

1. **Answer first, explore second.** The first screen answers "how's the air?" before asking anything of you.
2. **Returning users shouldn't redo work.** What you saved is what you see first.
3. **One color language for air quality.** The same color means the same thing everywhere: map, cards, charts, the About page and emails.
4. **Calm, not alarming.** Soft greens for the interface; strong colors are saved for the data, so they stand out when they matter.
5. **Never rely on color alone.** Every colored dot or badge also says its category in words.
6. **Show the work.** Data sources, sensor counts, freshness and database speed are visible, so people can judge how much to trust a number.

### Navigation: tabs instead of one long page

**The problem.** Our first layout was one long page: hero, then saved cities, then search, then the map. When we moved the map up to give new visitors a better first impression, the app's main feature, your saved cities, became the **last thing on the page**. A returning user would scroll past a map they didn't need, every time.

**What the research says.**

- **People mostly look at the top of the page.** In Nielsen Norman Group's 2018 eye-tracking study (120 participants), 57% of viewing time was on the first screenful and 74% on the first two; over 42% went to the top 20% of the page. Their advice: reserve the top for the most important content *[[16]](#sources-ux)*.
- **Tabs fit when content splits into clear groups that people don't need to compare side by side.** Use few tabs, short labels, at least two visual signals for the selected tab, and put the most-used content in the default tab *[[17]](#sources-ux)*.
- **Visible navigation gets used; hidden navigation doesn't.** In NN/g's desktop study, a menu hidden behind a hamburger icon was used by only 17% of people, against 42% on average and over 43% for visible navigation *[[18]](#sources-ux)*.
- **Most people stick with the default,** so the default view has to be the right one *[[19]](#sources-ux)*.
- **Tabs are for top-level sections.** Apple's guidelines: tab bars "navigate between top-level sections," should stay visible, use short labels, and preserve each section's state *[[20]](#sources-ux)*.
- **Empty sections should still help.** NN/g's three empty-state rules: show the status, teach what the feature is for, and give a direct way to start *[[21]](#sources-ux)*.
- **Comparable apps separate followed places from the map.** IQAir's AirVisual app keeps followed locations on its "My Air" page, apart from its world map *[[22]](#sources-ux)*.

**What we decided:** two tabs, **Your cities** and **Explore map**, right under the live reading.

| Rule | Why |
|---|---|
| **People with saved cities open on "Your cities"; new visitors open on "Explore map"** | Each group sees their most important content at the top, where most viewing time goes. New visitors have nothing saved yet. |
| **Your last tab is remembered;** `#cities` and `#explore` links open a specific tab | Respect people's choice, and let an email or demo link go straight to one view. |
| **"Your cities" is the first tab** | It's the app's purpose and the most-used view for anyone who comes back. |
| **Two tabs, one or two words each, with icons** | Few tabs and short labels. |
| **Selected tab: filled green *and* bold white text** | Two visual signals, not just a color change. |
| **Tabs stay visible while you scroll, and show how many cities you've saved** | You never lose your place, and you can see that saving worked. |
| **A helpful empty state:** what saving gives you, plus "Find a city on the map" and a one-click "Save Washington, DC" | Status, a learning cue, and a direct way to start. |
| **"Open on map" on a city card jumps to the map with that city loaded** | Moving between views is one click either way. |

**Why not one long page with a "jump to" link?** Returning users would still have to scroll past or skip the map. Tabs also fit here because nobody needs to compare the map and their city cards side by side, which is when NN/g says to avoid tabs.

### Other design decisions

| Decision | Why |
|---|---|
| **Live "Right now" card in the hero** | The tagline is "Your air, at a glance," but the original first screen showed no air data at all. |
| **Official EPA AQI colors** | People already recognize them from AirNow and weather apps. We use the exact colors for dots, swatches and bars. |
| **A darker text shade and a pale tint for each EPA color** | Bright yellow text on white is unreadable (about 1.1:1 contrast). Category words use a darker shade of the same hue on a pale tint, so they keep the EPA identity and stay readable. |
| **Both AQI and µg/m³ on the About page** | The map shows raw PM2.5 (µg/m³) while the AQI is a 0–500 index, so "Good = 0–9" and "Good = 0–50" looked contradictory. Every level now shows both. |
| **Search, map and stats as one panel; "Search this area" on the map** | Search is part of the map tool. The button only appears after you move the map, a pattern people know from Google Maps. |
| **"Powered by Tiger Data" stats strip** | Makes the database's speed and compression visible instead of hiding them in a closed dropdown. |
| **Shorter hero on phones** | The live reading and the tabs fit in the first screen of a phone. |
| **Plain-language error messages** | Opening the page without the server used to show "Unexpected token '<'"; it now says how to fix it. |
| **One shared stylesheet, the Inter font, line icons instead of emojis** | Both pages now look like one product, and icons render the same on every device. |
| **Axes and a caption on the year chart** | The original chart had no axes, so values and months couldn't be read. |

### Accessibility

Contrast ratios we measured, against the WCAG 2.2 minimum of **4.5:1** for normal text (3:1 for large text) *[[23]](#sources-ux)*:

| Text | Ratio |
|---|---|
| Muted text on the page background | 5.6 : 1 |
| Green buttons and links on white; white on green (selected tab) | 6.4 : 1 |
| Category badges (EPA text shade on its tint) | 5.7 – 8.8 : 1 |
| Dark icon on EPA yellow | 9.8 : 1 |

Also:

- **Color is never the only signal:** every dot tooltip, badge and chart tooltip names the category.
- **Tabs follow the WAI-ARIA tabs pattern** (`tablist`, `tab`, `tabpanel`), so screen readers announce them correctly, and arrow keys, Home and End move between them *[[24]](#sources-ux)*.
- **Map dots have a dark outline,** so yellow dots stay visible on a light map.
- **Animations turn off** for people who set "reduce motion".
- **No sideways scrolling on a 390 px phone screen;** the AQI scale on the About page becomes a 3×2 grid.

### Before and after

| Before | After |
|---|---|
| ![Home page before](design_documentation/before-index-desktop.png) | ![Your cities tab after](design_documentation/after-tabs-cities-desktop.png) |
| ![Phone before](design_documentation/before-index-phone.png) | ![Phone after](design_documentation/after-tabs-cities-phone.png) |
| ![About page before](design_documentation/before-about-desktop.png) | ![About page after](design_documentation/after-about-desktop.png) |

| Explore map tab | Empty "Your cities" | Search this area |
|---|---|---|
| ![Explore map tab](design_documentation/after-tabs-explore-desktop.png) | ![Empty state](design_documentation/after-tabs-empty-desktop.png) | ![Search this area button](design_documentation/after-search-area.png) |

*The "after" screenshots were taken offline with sample data, so the street-map tiles are blank. The live site shows the full map.*

### How to test it with real people

Ask 3 to 5 people, one at a time, without helping:

1. "What's the air like in Washington, DC right now?" — time it, and note whether they read the hero card or go to the map.
2. "Save Baltimore so you can check it later." — do they find the search and the save button?
3. Reload the page. "Check Baltimore again." — do they land on Your cities without hunting?
4. "Get an email if the air in Baltimore gets bad." — do they find the alerts panel?

Record how long each took and where people hesitated.

---

## 7. Architecture

```
          environmentaldata.org (CMU CREATE Lab ESDR API)
                              │  sensor lists + readings (CSV)
                              ▼
 Browser ──── /api/... ────▶ server.py (Flask) ────▶ Tiger Cloud (PostgreSQL + TimescaleDB)
 index.html, about.html       │  finds + loads sensors     • readings        (hypertable, columnstore)
 js/script.js                 │  background history         • hourly_readings (continuous aggregate)
 (Leaflet map, D3 charts)     │  alert checker, 30 min      • daily_readings  (continuous aggregate)
                              │                             • history_hourly  (hypertable)
                              ▼                             • sensors, alert_subscriptions (tables)
                       Resend ──▶ email alerts
```

- The browser never talks to the database. `DATABASE_URL` and the email API key stay on the server.
- A map request loads at most **150 sensors** in an area up to **3° across**, and only re-downloads a sensor if its data is more than **an hour** old.
- One city history download runs at a time, to protect both the shared database and ESDR.

---

## 8. Setup and running

You need **Python 3.10+** and a **Tiger Cloud** service.

```bash
pip install -r requirements.txt
```

Set these in the terminal where you run the server. **Never commit them.**

```bash
export DATABASE_URL='postgres://tsdbadmin:PASSWORD@HOST:PORT/tsdb?sslmode=require'
export RESEND_API_KEY='re_...'                 # optional: without it, emails print in the terminal
export PUBLIC_URL='http://localhost:5050'      # used in unsubscribe links
```

Run:

```bash
python server.py
```

Then open **http://localhost:5050**. On startup the server creates any missing tables, hypertables, aggregates and policies; a failing step prints "setup step skipped" and the server still starts.

To load a city's history by hand (saving a city does this automatically):

```bash
python load_city_history.py --city "Seattle, Washington" --load
```

### Troubleshooting

| Problem | Fix |
|---|---|
| **"The Zephora server isn't answering"** (or "Unexpected token '<'") | The page wasn't opened through Flask. Run `python server.py` and open `http://localhost:5050`. Double-clicking `index.html` or VS Code's Live Server can't reach the API. |
| **"tuple decompression limit exceeded"** | Reloads only replace the last 2 days for known sensors, to avoid compressed chunks. Check that `HOT_SECS` and the `SET timescaledb.max_tuples_decompressed_per_dml_transaction = 0` line are still in `load_feeds`. |
| **Chart says it's downloading history** | Wait a few minutes, or run the command above. |
| **Page looks out of date after an update** | Hard refresh (Cmd+Shift+R). |

---

## 9. API and project files

| Endpoint | Purpose |
|---|---|
| `GET /api/region?south&west&north&east` | Finds sensors in a box, loads stale ones, returns sensors, hourly readings and timing. `compare=0` skips the raw-table timing. |
| `GET /api/history?south&west&north&east` | A year of daily averages for a box. Starts a background download if the city has no history yet. |
| `GET /api/storage` | Table size and columnstore compression stats. |
| `POST /api/favorites` | Saves the browser's favorite cities to `data/saved_cities.json`. |
| `POST /api/alerts` | Creates or updates an email subscription. |
| `GET /api/alerts/unsubscribe?token=...` | Turns a subscription off. |

```
server.py                   Flask API, database setup, background loaders, alert checker
find_sensors.py             ESDR sensor discovery (find active outdoor sensors in a box)
load_city_history.py        Year-of-history loader (command line and server)
load_esdr.py                Original bulk loader (shared constants)
export_data.py              Exports data to JSON for a static backup demo
continuous_aggregates.sql   SQL reference for the aggregates
index.html                  Dashboard: hero, Your cities, Explore map
about.html                  About page: AQI guide and air quality basics
css/styles.css              Shared styles: green interface, EPA color tokens
js/script.js                Map, search, tabs, favorites, charts, alerts form
js/geographical_data.js     City lists for search
design_documentation/       Before/after screenshots
```

---

## 10. Known limitations

- **PurpleAir values are uncorrected** and can read high (see [§4](#data-quality-what-to-keep-in-mind)).
- **Sensor coverage varies,** and some cities have no active sensors.
- **Alerts need the server running.** The checker is a thread inside `server.py`.
- **Cities with fewer than 2 sensors never alert.**
- **Subscriptions aren't double opt-in.** Anyone can enter any address; every email has an unsubscribe link.
- **The "alerts on" label is stored in the browser,** so it doesn't know about unsubscribes done from an email link.
- **Compression only applies to chunks older than 2 days,** so a brand-new database shows no savings at first. With small data, the raw query can be as fast as the aggregate.
- **Times are stored in UTC.**
- **History downloads queue one at a time,** and their status resets if the server restarts.

---

## 11. What we'd build next

1. **Apply the EPA's PurpleAir correction** using each sensor's humidity reading, as the AirNow Fire and Smoke Map does *[[11]](#sources-data)*.
2. **Use the visitor's location** (with permission) for the hero instead of defaulting to Washington, DC.
3. **Run the 4-task user test** above and publish the results.
4. **Let people reorder their cities** and pick which one the hero shows.
5. **Double opt-in for alerts,** and keep the "alerts on" state on the server.
6. **Match the alert email design** to the site's EPA text shades and tints.
7. **A dark mode.**

---

## 12. Sources

<a id="sources-health"></a>
**Health and air quality**

1. Health Effects Institute. *State of Global Air 2024: air pollution is the #2 risk factor for death globally.* https://www.stateofglobalair.org/news-events/2024/new-state-global-air-report-finds-air-pollution-second-leading-risk-factor-death
2. World Health Organization. *Ambient (outdoor) air pollution* fact sheet. https://www.who.int/news-room/fact-sheets/detail/ambient-(outdoor)-air-quality-and-health
3. US EPA. *Particulate Matter (PM) Basics.* https://www.epa.gov/pm-pollution/particulate-matter-pm-basics
4. American Lung Association. *State of the Air 2026: Key Findings.* https://www.lung.org/research/sota/key-findings
5. US EPA. *Study Finds Exposure to Air Pollution Higher for People of Color Regardless of Region or Income* (Tessum et al., *Science Advances*, 2021). https://epa.gov/sciencematters/study-finds-exposure-air-pollution-higher-people-color-regardless-region-or-income
6. US EPA. *Final Updates to the Air Quality Index for Particulate Matter* (fact sheet, 2024). https://www.epa.gov/system/files/documents/2024-02/pm-naaqs-air-quality-index-fact-sheet.pdf
7. World Health Organization. *Types of pollutants* (2021 Air Quality Guideline values). https://www.who.int/teams/environment-climate-change-and-health/air-quality-and-health/health-impacts/types-of-pollutants
8. WTOP. *'Very unhealthy' air sweeps through DC area as impact of Canadian wildfires continues* (June 2023). https://wtop.com/local/2023/06/code-purple-very-unhealthy-air-sweeps-through-dc-area-as-impact-of-canadian-wildfires-continues/
9. AirNow (US EPA). *About EnviroFlash.* https://m.enviroflash.info/about.cfm

<a id="sources-data"></a>
**Sensor data**

10. Carnegie Mellon University CREATE Lab. *Environmental Sensor Data Repository (ESDR).* https://esdr.cmucreatelab.org and https://github.com/CMU-CREATE-Lab/esdr
11. Barkjohn, Gantt and Clements. *Development and application of a United States-wide correction for PM2.5 data collected with the PurpleAir sensor.* Atmospheric Measurement Techniques, 14, 4617–4637 (2021). https://amt.copernicus.org/articles/14/4617/2021/

<a id="sources-tiger"></a>
**Tiger Data**

12. Tiger Data. *Understand hypertables.* https://www.tigerdata.com/docs/use-timescale/latest/hypertables
13. Tiger Data. *Understand continuous aggregates.* https://www.tigerdata.com/docs/learn/continuous-aggregates
14. Tiger Data. *Real-time aggregates.* https://www.tigerdata.com/docs/learn/continuous-aggregates/real-time-aggregates
15. Tiger Data. *Understand hypercore* (columnstore). https://www.tigerdata.com/docs/learn/columnar-storage/understand-hypercore

<a id="sources-ux"></a>
**UI/UX and accessibility**

16. Nielsen Norman Group. *Scrolling and Attention* (2018). https://www.nngroup.com/articles/scrolling-and-attention/
17. Nielsen Norman Group. *Tabs, Used Right.* https://www.nngroup.com/articles/tabs-used-right/
18. Nielsen Norman Group. *Beyond the Hamburger: What Makes Navigation Discoverable on Desktops.* https://www.nngroup.com/articles/find-navigation-desktop-not-hamburger/
19. Nielsen Norman Group. *The Power of Defaults.* https://www.nngroup.com/articles/the-power-of-defaults/
20. Apple. *Human Interface Guidelines: Tab bars.* https://developer.apple.com/design/human-interface-guidelines/tab-bars
21. Nielsen Norman Group. *Designing Empty States in Complex Applications: 3 Guidelines.* https://www.nngroup.com/articles/empty-state-interface-design/
22. IQAir AirVisual. *How to add and remove your followed locations.* https://support.airvisual.com/en/articles/3376152-how-to-add-and-remove-your-followed-locations
23. W3C. *Understanding WCAG 2.2 Success Criterion 1.4.3: Contrast (Minimum).* https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
24. W3C. *WAI-ARIA Authoring Practices 1.2* (Tabs pattern). https://www.w3.org/TR/2021/NOTE-wai-aria-practices-1.2-20211129/

---

## 13. AI inclusion disclosure

We used **Claude** (Anthropic's AI assistant) during this hackathon. In the interest of transparency, here is what it helped with and what we did ourselves.

**What Claude helped with**

| Area | How Claude was used |
|---|---|
| **Setup and learning** | Explained how to set up Tiger Cloud, install `psql`, connect a shared database, and use Git, for a teammate new to PostgreSQL. |
| **Data pipeline** | Drafted `load_esdr.py`, `find_sensors.py` and `continuous_aggregates.sql`, and helped test them against our database. |
| **Front end (UI/UX pass)** | Drafted the redesign of `index.html`, `about.html`, `css/styles.css` and `js/script.js`: the shared green theme and EPA color tokens, the live "Right now" card, the Your cities / Explore map tabs, the empty state, the "Search this area" button, the Tiger Data stats strip, chart axes, and clearer error messages. |
| **Testing** | Checked the pages in a headless browser at laptop and phone widths using sample data, measured color contrast ratios, and captured the before/after screenshots. |
| **Research and writing** | Found and summarized the sources in [§12](#12-sources), and drafted this README from our original README and design notes. |

**What we did ourselves**

- Chose the problem, the dataset (environmentaldata.org / ESDR) and the tech stack.
- Made the product and design decisions: following saved cities as the core purpose, the green visual direction, the official EPA color scheme, and the idea of separating saved cities and the map into tabs.
- Built and ran the back end and database, and reviewed, tested and integrated all AI-suggested code in our own environment.
- Checked the sources and are responsible for every claim and line of code in this project.

*Teammates: add any other AI tools you used (for example, coding assistants used on `server.py`, `load_city_history.py` or the alert emails) so this disclosure covers the whole project.*