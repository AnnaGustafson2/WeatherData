// PM2.5 color bands: US EPA breakpoints (µg/m³, 24-hour average) and the official EPA AQI colors.
// `color` is the official fill; `key` matches the [data-band] styles in styles.css,
// which also define a darker text shade and a pale background for each band.
const BANDS = [
  { key: "good", max: 9, color: "#00e400", label: "Good", range: "0–9", aqi: "0–50" },
  { key: "moderate", max: 35.4, color: "#ffff00", label: "Moderate", range: "9–35", aqi: "51–100" },
  {
    key: "usg",
    max: 55.4,
    color: "#ff7e00",
    label: "Unhealthy for sensitive groups",
    range: "35–55",
    aqi: "101–150",
  },
  { key: "unhealthy", max: 125.4, color: "#ff0000", label: "Unhealthy", range: "55–125", aqi: "151–200" },
  { key: "very", max: 225.4, color: "#8f3f97", label: "Very unhealthy", range: "125–225", aqi: "201–300" },
  { key: "hazardous", max: Infinity, color: "#7e0023", label: "Hazardous", range: "225+", aqi: "301+" },
];
const NO_DATA = "#9aa39d";
const bandFor = (v) => BANDS.find((b) => v <= b.max);
const HOUR = 3600 * 1000;

// Small inline icons (same rounded-stroke style as the wind logo)
const ICONS = {
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/></svg>',
};

// A colored chip like "● Moderate" (color is never the only signal: the word is always there)
function aqiChip(value, text) {
  const chip = document.createElement("span");
  chip.className = "aqi-chip";
  if (value == null) {
    chip.textContent = text || "No recent data";
    return chip;
  }
  const b = bandFor(value);
  chip.dataset.band = b.key;
  chip.textContent = text || b.label;
  return chip;
}

// Fetch JSON from our Flask API. If we get a web page back instead (the page was opened
// without server.py, e.g. by double-clicking index.html or with VS Code Live Server),
// say how to fix it instead of showing "Unexpected token '<'".
async function fetchJSON(url, options) {
  let resp;
  try {
    resp = await fetch(url, options);
  } catch (err) {
    throw new Error("can't reach the Zephora server. Is python server.py running?");
  }
  const type = resp.headers.get("content-type") || "";
  if (!type.includes("application/json")) {
    throw new Error(
      resp.status === 404 || type.includes("text/html")
        ? "the Zephora server isn't answering. Run python server.py and open http://localhost:5050"
        : `unexpected reply from the server (${resp.status})`,
    );
  }
  const body = await resp.json();
  if (!resp.ok) throw new Error(body.error || `server error ${resp.status}`);
  return body;
}

// "Washington, District of Columbia" reads better as "Washington, DC"
const shortLabel = (label) => label.replace(", District of Columbia", ", DC");
// Title for the hero card ("Right now in …")
const heroLabel = (label) => (label === "this map view" ? "The area on your map" : shortLabel(label));

// Median is what the email alerts use too, so one broken sensor can't skew a city.
function median(values) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const saveFavoriteBtn = document.getElementById("saveFavorite");
const favoritesList = document.getElementById("favorites");
const FAVORITES_KEY = "airQualityFavoriteCities";

let selectedPlace = null;

const statusEl = document.getElementById("status");
const placeInput = document.getElementById("place");
const suggest = document.getElementById("suggest");
const loadBtn = document.getElementById("loadView");
const setStatus = (msg, isError) => {
  statusEl.textContent = msg;
  statusEl.className = isError ? "error" : "";
};

const map = L.map("map").setView([38.9, -77.03], 11);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const legend = L.control({ position: "bottomright" });
legend.onAdd = () => {
  const div = L.DomUtil.create("div", "legend");
  div.innerHTML =
    "<strong>Air quality (PM2.5)</strong>" +
    '<span class="legend-sub">24-hour average, µg/m³</span>' +
    BANDS.map(
      (b) =>
        `<div class="legend-row"><i style="background:${b.color}"></i><span>${b.range}</span><span>${b.label}</span></div>`,
    ).join("") +
    `<div class="legend-row"><i style="background:${NO_DATA}"></i><span>–</span><span>No recent data</span></div>`;
  return div;
};
legend.addTo(map);

// "Search this area" appears only after the person moves the map themselves.
let movingByCode = false;
let mapTarget = null; // last area the map was asked to show
function moveMapTo(bounds) {
  mapTarget = bounds;
  movingByCode = true;
  map.fitBounds(bounds);
  // fitBounds may not fire moveend if nothing changes, so clear the flag either way
  setTimeout(() => (movingByCode = false), 600);
}
map.on("moveend", () => {
  if (!movingByCode) loadBtn.hidden = false;
});

// ---- City search with autocomplete (top ~1000 US cities + ~550 big cities worldwide; [name, lat, lon, population, alsoKnownAs?]) ----
const norm = (s) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase(); // "São" -> "sao"
const PLACES = [];
for (const groups of [CITIES, WORLD])
  for (const [group, list] of Object.entries(groups))
    for (const [name, lat, lon, pop, alt] of list)
      PLACES.push({
        name,
        lat,
        lon,
        pop,
        alt,
        label: `${name}, ${group}`,
        key: norm(`${name}, ${group}`),
        altKey: alt ? norm(alt) : "",
      });

// Best matches first: label starts with the text, then a word starts with it, then anywhere.
// Within the same tier, bigger cities come first. Old names (Bombay, Saigon…) match too.

let alertUid = 0;
const ALERTS_KEY = "airQualityAlertSubs";
const ALERT_LEVELS = [
  {
    value: 35.5,
    label: "Unhealthy for sensitive groups (35.5+)",
    help: "A good choice if you have asthma or heart or lung conditions, or care for children or older adults.",
  },
  {
    value: 55.5,
    label: "Unhealthy (55.5+)",
    help: "Air that can affect everyone. Fewer emails, only for worse days.",
  },
  {
    value: 125.5,
    label: "Very unhealthy (125.5+)",
    help: "Rare. Only for serious events like heavy wildfire smoke.",
  },
];

function getAlertSubs() {
  try {
    return JSON.parse(localStorage.getItem(ALERTS_KEY)) || {};
  } catch (err) {
    return {};
  }
}
function setAlertSub(key, sub) {
  try {
    const all = getAlertSubs();
    all[key] = sub;
    localStorage.setItem(ALERTS_KEY, JSON.stringify(all));
  } catch (err) {
    /* remembering is optional */
  }
}

function alertControls(favorite) {
  const uid = ++alertUid;
  const key = `${favorite.lat},${favorite.lon}`;

  const details = document.createElement("details");
  details.className = "favorite-alerts";
  details.innerHTML = `
        <summary>
            <span class="alerts-icon" aria-hidden="true">${ICONS.bell}</span>
            <span class="alerts-summary">
                <strong>Email alerts</strong>
                <span class="alerts-subtitle"></span>
            </span>
            <span class="alerts-toggle" aria-hidden="true">+</span>
        </summary>
        <div class="alerts-content">
            <p class="alerts-description"></p>
            <form class="alert-form">
                <div class="alert-field">
                    <label for="alert-email-${uid}">Email address</label>
                    <input id="alert-email-${uid}" type="email" name="email"
                           autocomplete="email" placeholder="you@example.com" required>
                </div>
                <div class="alert-field">
                    <label for="alert-level-${uid}">Alert me when the air is</label>
                    <select id="alert-level-${uid}" name="level"></select>
                    <p class="field-help"></p>
                </div>
                <button class="alert-submit" type="submit">Turn on email alerts</button>
                <p class="alert-status" role="status"></p>
            </form>
        </div>`;

  const $ = (sel) => details.querySelector(sel);
  const form = $(".alert-form"),
    email = $("input"),
    level = $("select");
  const help = $(".field-help"),
    status = $(".alert-status");
  const submit = $(".alert-submit"),
    subtitle = $(".alerts-subtitle");
  const levelLabel = (v) =>
    (ALERT_LEVELS.find((l) => l.value === Number(v)) || {}).label;

  $(".alerts-description").textContent =
    `We check ${favorite.label} every 30 minutes and email you once when it reaches your level. ` +
    `You can unsubscribe from any email.`;

  for (const l of ALERT_LEVELS) level.add(new Option(l.label, l.value));
  const saved = getAlertSubs()[key];
  level.value = saved ? saved.threshold : 55.5;
  email.value = saved
    ? saved.email
    : localStorage.getItem("airQualityAlertEmail") || "";

  const refresh = () => {
    help.textContent = (
      ALERT_LEVELS.find((l) => l.value === Number(level.value)) || {}
    ).help;
    const on = !!getAlertSubs()[key];
    details.classList.toggle("is-on", on);
    const s = getAlertSubs()[key];
    subtitle.textContent = on
      ? `On: emails ${s.email} at ${levelLabel(s.threshold)}`
      : "Get an email when the air here becomes unhealthy";
    submit.textContent = on ? "Update alert" : "Turn on email alerts";
  };
  level.addEventListener("change", refresh);
  refresh();

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    submit.disabled = true;
    status.className = "alert-status";
    status.textContent = "Saving…";
    try {
      await fetchJSON("/api/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.value,
          label: favorite.label,
          lat: favorite.lat,
          lon: favorite.lon,
          threshold: Number(level.value),
        }),
      });
      const addr = email.value.trim();
      localStorage.setItem("airQualityAlertEmail", addr);
      setAlertSub(key, { email: addr, threshold: Number(level.value) });
      status.className = "alert-status success";
      status.textContent =
        "Alerts are on. Check your inbox for a confirmation.";
      refresh();
    } catch (err) {
      status.textContent = "Couldn't save: " + err.message;
    } finally {
      submit.disabled = false;
    }
  });

  return details;
}

function getFavorites() {
  try {
    return JSON.parse(localStorage.getItem(FAVORITES_KEY)) || [];
  } catch (err) {
    return [];
  }
}

function saveFavorites(favorites) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));

    // Sync the saved cities with the Flask server.
    fetch("/api/favorites", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ favorites }),
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.json();
      })
      .then((data) => {
        console.log(`Synced ${data.count} favorite cities.`);
      })
      .catch((err) => {
        console.error("Could not sync favorite cities:", err);
      });

    return true;
  } catch (err) {
    setStatus("Couldn't save favorites in this browser.", true);
    return false;
  }
}

function isFavorite(p) {
  return getFavorites().some(
    (f) => f.label === p.label && f.lat === p.lat && f.lon === p.lon,
  );
}

function updateSaveButton() {
  if (!selectedPlace) {
    saveFavoriteBtn.disabled = true;
    saveFavoriteBtn.textContent = "☆ Save to your cities";
    saveFavoriteBtn.title = "Search for a city first, then save it";
    return;
  }

  if (isFavorite(selectedPlace)) {
    saveFavoriteBtn.disabled = true;
    saveFavoriteBtn.textContent = "★ Saved";
    saveFavoriteBtn.title = `${selectedPlace.label} is already in your cities`;
  } else {
    saveFavoriteBtn.disabled = false;
    saveFavoriteBtn.textContent = `☆ Save ${shortLabel(selectedPlace.label).split(",")[0]}`;
    saveFavoriteBtn.title = `Add ${selectedPlace.label} to your cities`;
  }
}

// Small maps on the city cards, so they can be resized when their tab becomes visible
let cityMaps = [];
function fitCityMap({ map: m, bounds }) {
  if (!m.getContainer().offsetWidth) return; // hidden tab: try again when it opens
  m.invalidateSize();
  m.setMinZoom(0);
  m.fitBounds(bounds);
  m.setMinZoom(m.getZoom()); // can't zoom out past the city
}

function renderFavorites() {
  for (const { map: m } of cityMaps) m.remove();
  cityMaps = [];
  favoritesList.replaceChildren();

  const favorites = getFavorites();
  updateCitiesCount(favorites.length);
  document.getElementById("emptyCities").hidden = favorites.length > 0;
  favoritesList.hidden = favorites.length === 0;

  for (const favorite of favorites) {
    const card = document.createElement("article");
    card.className = "favorite-card";

    const head = document.createElement("div");
    head.className = "favorite-head";
    const heading = document.createElement("h3");
    heading.textContent = shortLabel(favorite.label);
    const headChip = aqiChip(null, "Loading…");
    head.append(heading, headChip);

    const content = document.createElement("div");
    content.className = "favorite-content";

    const mapElement = document.createElement("div");
    mapElement.className = "favorite-map";

    const chartElement = document.createElement("div");
    chartElement.className = "favorite-chart";

    content.append(mapElement, chartElement);
    drawFavoriteChart(chartElement, favorite);

    const actions = document.createElement("div");
    actions.className = "favorite-actions";

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.textContent = "Open on map";
    openButton.onclick = () => {
      selectTab("explore");
      choose(favorite);
    };

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "remove-city";
    removeButton.textContent = "Remove";
    removeButton.setAttribute("aria-label", `Remove ${favorite.label}`);
    removeButton.onclick = () => {
      const updated = getFavorites().filter(
        (f) =>
          !(
            f.label === favorite.label &&
            f.lat === favorite.lat &&
            f.lon === favorite.lon
          ),
      );

      if (saveFavorites(updated)) {
        renderFavorites();
        updateSaveButton();
      }
    };

    actions.append(openButton, removeButton);
    card.append(head, content, actions, alertControls(favorite));
    favoritesList.append(card);

    const dLat = 0.15;
    const dLon = 0.15 / Math.cos((favorite.lat * Math.PI) / 180);
    const s = favorite.lat - dLat;
    const n = favorite.lat + dLat;
    const w = favorite.lon - dLon;
    const e = favorite.lon + dLon;

    // Lock the map to this city's box so you can't pan or zoom away from it.
    const cityBounds = L.latLngBounds([s, w], [n, e]);

    const cityMap = L.map(mapElement, {
      maxBounds: cityBounds.pad(0.1), // a little breathing room at the edges
      maxBoundsViscosity: 1.0, // solid edge, no bouncing
    });

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(cityMap);

    const cityLayer = L.featureGroup().addTo(cityMap);

    // Leaflet needs the map's real size before it can fit the box. If the
    // "Your cities" tab is hidden right now, this runs again when it opens.
    const entry = { map: cityMap, bounds: cityBounds };
    cityMaps.push(entry);
    fitCityMap(entry);

    async function loadFavoriteData() {
      const bounds = [s, w, n, e].map((v) => v.toFixed(3));
      const cacheKey = "region:" + bounds.join(",");

      try {
        let data = getCachedData(cacheKey);

        if (!data) {
          const q = new URLSearchParams({
            south: s,
            west: w,
            north: n,
            east: e,
            compare: "0",
          });

          data = await fetchJSON("/api/region?" + q);

          setCachedData(cacheKey, data);
        }

        const summary = show(data, favorite.label, cityLayer, false);
        const chip = aqiChip(
          summary.median,
          summary.median == null ? undefined : `${summary.median.toFixed(1)} · ${bandFor(summary.median).label}`,
        );
        headChip.replaceWith(chip);
      } catch (err) {
        console.error("Could not load favorite city " + favorite.label, err);

        const error = document.createElement("p");
        error.textContent = "Could not load sensor data.";
        error.style.padding = "0.75rem";
        card.append(error);
      }
    }

    loadFavoriteData();
  }

  // Add City card appears after all saved cities
  const addCard = document.createElement("button");
  addCard.type = "button";
  addCard.className = "add-city-card";

  addCard.innerHTML = `
    <span class="add-city-icon">${ICONS.plus}</span>
    <strong>Add a city</strong>
    <span>Search for it on the map, then save it</span>
  `;

  addCard.onclick = () => goFindCity();

  favoritesList.append(addCard);

  updateSaveButton();
}

// Sync existing favorites with the server when the page opens.
fetch("/api/favorites", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ favorites: getFavorites() }),
})
  .then((response) => {
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
  })
  .then((data) => {
    console.log(`Synced ${data.count} favorite cities on startup.`);
  })
  .catch((err) => {
    console.error("Could not sync favorite cities on startup:", err);
  });

function search(text) {
  const q = norm(text.trim());
  if (!q) return [];
  const scored = [];
  for (const p of PLACES) {
    const i = p.key.indexOf(q);
    let tier;
    if (i >= 0) tier = i === 0 ? 0 : p.key[i - 1] === " " ? 1 : 2;
    else if (p.altKey.includes(q)) tier = 1;
    else continue;
    scored.push([tier, p]);
  }
  scored.sort((x, y) => x[0] - y[0] || y[1].pop - x[1].pop);
  return scored.slice(0, 8).map((x) => x[1]);
}

let matches = [],
  active = -1;

function render() {
  matches = search(placeInput.value);
  active = matches.length ? 0 : -1;
  suggest.innerHTML = "";
  const q = placeInput.value.trim();
  matches.forEach((p, i) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    if (i === active) li.className = "active";
    const nq = norm(q),
      at = norm(p.label).indexOf(nq);
    if (at < 0) li.textContent = p.alt ? `${p.label} (${p.alt})` : p.label;
    else
      li.append(
        p.label.slice(0, at),
        Object.assign(document.createElement("b"), {
          textContent: p.label.slice(at, at + nq.length),
        }),
        p.label.slice(at + nq.length),
      );
    li.onmousedown = (ev) => {
      ev.preventDefault();
      choose(p);
    }; // mousedown, so the input doesn't blur first
    suggest.append(li);
  });
  suggest.hidden = !matches.length;
  placeInput.setAttribute("aria-expanded", String(!suggest.hidden));
}

function highlight(i) {
  active = (i + matches.length) % matches.length;
  [...suggest.children].forEach((li, j) =>
    li.classList.toggle("active", j === active),
  );
  suggest.children[active].scrollIntoView({ block: "nearest" });
}

function choose(p) {
  selectedPlace = p;
  updateSaveButton();

  placeInput.value = p.label;
  suggest.hidden = true;
  placeInput.setAttribute("aria-expanded", "false");
  const dLat = 0.15,
    dLon = 0.15 / Math.cos((p.lat * Math.PI) / 180);
  const s = p.lat - dLat,
    n = p.lat + dLat,
    w = p.lon - dLon,
    e = p.lon + dLon;
  moveMapTo([
    [s, w],
    [n, e],
  ]);
  loadArea(s, w, n, e, p.label);
}

saveFavoriteBtn.onclick = () => {
  if (!selectedPlace || isFavorite(selectedPlace)) return;

  const favorites = getFavorites();
  favorites.push({
    label: selectedPlace.label,
    lat: selectedPlace.lat,
    lon: selectedPlace.lon,
  });

  if (saveFavorites(favorites)) {
    renderFavorites();
    updateSaveButton();
    setStatus(
      `${shortLabel(selectedPlace.label)} saved. It's now in Your cities, with a year of history and alerts.`,
    );
  }
};

renderFavorites();

placeInput.addEventListener("input", () => {
  selectedPlace = null;
  updateSaveButton();
  render();
});
placeInput.addEventListener("focus", () => {
  if (placeInput.value.trim()) render();
});
placeInput.addEventListener("blur", () => {
  suggest.hidden = true;
});
placeInput.addEventListener("keydown", (ev) => {
  if (suggest.hidden && ev.key === "ArrowDown") {
    render();
    return;
  }
  if (suggest.hidden || !matches.length) return;
  if (ev.key === "ArrowDown") {
    ev.preventDefault();
    highlight(active + 1);
  } else if (ev.key === "ArrowUp") {
    ev.preventDefault();
    highlight(active - 1);
  } else if (ev.key === "Enter") {
    ev.preventDefault();
    choose(matches[active]);
  } else if (ev.key === "Escape") {
    suggest.hidden = true;
  }
});

loadBtn.onclick = () => {
  const b = map.getBounds();
  placeInput.value = "";
  selectedPlace = null;
  updateSaveButton();
  loadArea(
    b.getSouth(),
    b.getWest(),
    b.getNorth(),
    b.getEast(),
    "this map view",
  );
};

// ---- Ask the server for the sensors + readings in an area ----
let layer = L.featureGroup().addTo(map);
let requestId = 0; // ignore stale responses if the user switches quickly

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCachedData(key) {
  try {
    const cached = localStorage.getItem(key);
    if (!cached) return null;

    const entry = JSON.parse(cached);

    if (Date.now() - entry.timestamp > CACHE_TTL) {
      localStorage.removeItem(key);
      return null;
    }

    return entry.data;
  } catch (err) {
    return null;
  }
}

function setCachedData(key, data) {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        timestamp: Date.now(),
        data: data,
      }),
    );
  } catch (err) {
    // Caching is optional; the map should still work without it.
    console.warn("Could not cache map data:", err);
  }
}

async function loadArea(s, w, n, e, label) {
  const myId = ++requestId;
  loadBtn.disabled = placeInput.disabled = true;
  loadBtn.textContent = "Searching…";
  setNowLoading(label);

  // Round bounds so tiny coordinate differences don't create separate cache entries.
  const bounds = [s, w, n, e].map((v) => v.toFixed(3));
  const cacheKey = "region:" + bounds.join(",");
  const cached = getCachedData(cacheKey);

  try {
    if (cached) {
      setStatus(`Loading cached data for ${label}…`);
      if (myId !== requestId) return;

      show(cached, label);
      setStatus(`Showing cached data for ${label}.`);
      return;
    }

    setStatus(
      `Loading ${shortLabel(label)}… the first time an area is loaded this can take a minute.`,
    );

    // compare=1 also times the raw-table query, for the Tiger Data stats under the map
    const q = new URLSearchParams({
      south: s,
      west: w,
      north: n,
      east: e,
      compare: "1",
    });

    const d = await fetchJSON("/api/region?" + q);
    if (myId !== requestId) return;

    setCachedData(cacheKey, d);
    show(d, label);
  } catch (err) {
    if (myId === requestId) {
      setStatus("Couldn't load " + shortLabel(label) + ": " + err.message, true);
      setNowError(label);
    }
    console.error(err);
  } finally {
    if (myId === requestId) {
      loadBtn.disabled = placeInput.disabled = false;
      loadBtn.textContent = "↻ Search this area";
      loadBtn.hidden = true;
    }
  }
}

// ---- The live "right now" card in the hero ----
const nowCard = document.getElementById("nowCard");
const nowPlace = document.getElementById("nowPlace");
const nowValue = document.getElementById("nowValue");
const nowMeta = document.getElementById("nowMeta");

function setNowLoading(label) {
  nowCard.classList.add("is-loading");
  delete nowCard.dataset.band;
  nowPlace.textContent = heroLabel(label);
  nowValue.textContent = "–";
  const chip = aqiChip(null, "Checking sensors…");
  chip.id = "nowBand";
  document.getElementById("nowBand").replaceWith(chip);
  nowMeta.textContent = "Fetching the latest readings from nearby outdoor sensors.";
}

function setNowError(label) {
  nowCard.classList.remove("is-loading");
  nowPlace.textContent = heroLabel(label);
  nowMeta.textContent = "We couldn't reach the sensors just now. Try again in a moment.";
}

function setNow(summary, label) {
  nowCard.classList.remove("is-loading");
  nowPlace.textContent = heroLabel(label);
  const chip = aqiChip(summary.median);
  chip.id = "nowBand";
  document.getElementById("nowBand").replaceWith(chip);

  if (summary.median == null) {
    delete nowCard.dataset.band;
    nowValue.textContent = "–";
    nowMeta.textContent = "No outdoor sensors here reported in the last 24 hours.";
    return;
  }
  nowCard.dataset.band = bandFor(summary.median).key;
  nowValue.textContent = summary.median.toFixed(1);
  const mins = Math.max(0, Math.round((Date.now() - summary.latest) / 60000));
  const ago = mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
  nowMeta.textContent =
    `Median 24-hour average of ${summary.reporting} sensor${summary.reporting === 1 ? "" : "s"}. ` +
    `Latest reading ${ago}.`;
}

function show(d, label, targetLayer = layer, updateUI = true) {
  if (updateUI) window.airData = d;
  targetLayer.clearLayers();

  // Group hourly readings by sensor; the "last 24 h" ends at the newest reading
  const byFeed = new Map();
  let latest = 0;
  for (const r of d.hourly) {
    const t = new Date(r.time).getTime();
    if (t > latest) latest = t;
    if (!byFeed.has(r.feed_id)) byFeed.set(r.feed_id, []);
    byFeed.get(r.feed_id).push({ t, v: r.avg });
  }
  const cutoff = latest - 24 * HOUR;
  const averages = [];

  for (const s of d.sensors) {
    const rows = byFeed.get(s.feed_id) || [];
    const lastDay = rows.filter((r) => r.t > cutoff);
    const avg = lastDay.length
      ? lastDay.reduce((a, r) => a + r.v, 0) / lastDay.length
      : null;
    if (avg !== null) averages.push(avg);
    L.circleMarker([s.latitude, s.longitude], {
      radius: 7,
      weight: 1.5,
      color: "rgba(20, 40, 28, 0.55)", // dark outline keeps yellow dots visible on the map
      fillOpacity: 0.95,
      fillColor: avg === null ? NO_DATA : bandFor(avg).color,
    })
      .bindPopup(() => popupFor(s, rows, avg), { minWidth: 320, maxWidth: 360 })
      .bindTooltip(
        avg === null
          ? `${s.name}: no recent data`
          : `${s.name}: ${avg.toFixed(1)} µg/m³ · ${bandFor(avg).label}`,
      )
      .addTo(targetLayer);
  }

  const summary = { median: median(averages), reporting: averages.length, latest };

  let msg = d.sensors.length
    ? `${d.sensors.length} sensors in ${shortLabel(label)}, colored by their 24-hour average up to ` +
      `${new Date(latest).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.`
    : `No active outdoor PM2.5 sensors found in ${shortLabel(label)}. Try a bigger area.`;
  if (d.truncated)
    msg += ` Showing the first ${d.sensors.length} of ${d.total_found}; zoom in to see the rest.`;
  if (updateUI) {
    setStatus(msg);
    setNow(summary, label);
    showStats(d.perf);
  }
  return summary;
}

// ---- "Powered by Tiger Data" stats under the map ----
// Query speed (continuous aggregate vs raw table) from /api/region, storage from /api/storage.
let lastPerf = null;

function fmtCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "k";
  return String(n);
}

async function showStats(perf) {
  if (perf) lastPerf = perf;
  const p = lastPerf;
  let s = null;
  try {
    s = await (await fetch("/api/storage")).json();
  } catch (err) {
    /* storage numbers are optional */
  }

  const stats = [];
  if (p) {
    stats.push([`${p.agg_ms} ms`, "to answer this map from an hourly continuous aggregate"]);
    if (p.raw_ms != null && p.raw_ms >= p.agg_ms * 1.5)
      stats.push([`${(p.raw_ms / p.agg_ms).toFixed(1)}× faster`, `than scanning raw readings (${p.raw_ms} ms)`]);
    stats.push([
      `${fmtCount(p.raw_rows)} → ${fmtCount(p.hourly_rows)}`,
      "raw readings rolled up into hourly rows",
    ]);
  }
  if (s && s.compressed_chunks > 0 && s.before_bytes && s.after_bytes) {
    const pct = Math.round((1 - s.after_bytes / s.before_bytes) * 100);
    stats.push([`${pct}% smaller`, "older data, thanks to Tiger's columnstore compression"]);
  } else if (s && s.rows > 0) {
    stats.push([fmtCount(s.rows), "sensor readings stored in a TimescaleDB hypertable"]);
  }
  if (!stats.length) return;

  const grid = document.getElementById("statsGrid");
  grid.replaceChildren();
  for (const [value, label] of stats) {
    const box = document.createElement("div");
    box.className = "stat";
    const dd = document.createElement("dd");
    dd.textContent = value;
    const dt = document.createElement("dt");
    dt.textContent = label;
    box.append(dt, dd); // CSS shows the value (dd) above its label (dt)
    grid.append(box);
  }
  document.getElementById("statsNote").textContent =
    (p && p.loaded_sensors ? `Just downloaded ${p.loaded_sensors} new sensors in ${p.load_secs} s. ` : "") +
    "Hypertables store every reading; continuous aggregates keep hourly and daily summaries up to date, " +
    "so charts load without recounting millions of rows.";
  document.getElementById("stats").hidden = false;
}

function popupFor(s, rows, avg) {
  const div = document.createElement("div");
  div.className = "popup";
  const h = document.createElement("h2");
  h.textContent = s.name;
  const chip = aqiChip(
    avg,
    avg === null ? "No readings in the last 24 hours" : `${avg.toFixed(1)} µg/m³ · ${bandFor(avg).label}`,
  );
  const p = document.createElement("p");
  p.textContent = rows.length ? "24-hour average above. Hourly readings this week:" : "";
  div.append(h, chip, p);
  if (rows.length) div.insertAdjacentHTML("beforeend", chartSVG(rows));
  return div;
}

function chartSVG(rows) {
  const W = 340,
    H = 190,
    m = { l: 34, r: 8, t: 8, b: 22 };
  const x0 = rows[0].t,
    x1 = rows[rows.length - 1].t;
  const y1 = Math.max(...rows.map((r) => r.v), 12);
  const X = (t) => m.l + ((t - x0) / (x1 - x0 || 1)) * (W - m.l - m.r);
  const Y = (v) => H - m.b - (v / y1) * (H - m.t - m.b);
  const day = (t) =>
    new Date(t).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  const grid = [0, 0.5, 1]
    .map((f) => f * y1)
    .map(
      (v) =>
        `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/>` +
        `<text x="${m.l - 4}" y="${Y(v) + 3}" text-anchor="end">${v.toFixed(0)}</text>`,
    )
    .join("");
  const pts = rows
    .map((r) => `${X(r.t).toFixed(1)},${Y(r.v).toFixed(1)}`)
    .join(" ");
  return (
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Hourly PM2.5 over time">` +
    grid +
    `<polyline class="line" points="${pts}"/>` +
    `<text x="${m.l}" y="${H - 6}">${day(x0)}</text>` +
    `<text x="${W - m.r}" y="${H - 6}" text-anchor="end">${day(x1)}</text>` +
    `<text x="${m.l + 4}" y="${m.t + 8}">µg/m³</text></svg>`
  );
}

let chartId = 0;

async function drawFavoriteChart(chartElement, favorite) {
  chartElement.textContent = "Loading past year…";

  // Same box as the card's map, so the chart and the dots cover the same area.
  const dLat = 0.15;
  const dLon = 0.15 / Math.cos((favorite.lat * Math.PI) / 180);
  const q = new URLSearchParams({
    south: favorite.lat - dLat,
    west: favorite.lon - dLon,
    north: favorite.lat + dLat,
    east: favorite.lon + dLon,
  });

  let days, status;
  try {
    const body = await fetchJSON("/api/history?" + q);
    days = body.days;
    status = body.status;
  } catch (err) {
    chartElement.textContent = "Could not load history: " + err.message;
    return;
  }

  if (!days.length) {
    if (status === "loading") {
      chartElement.textContent =
        "Downloading the past year of history for this city. This takes a few minutes…";
      setTimeout(() => {
        if (chartElement.isConnected) drawFavoriteChart(chartElement, favorite);
      }, 15000);
    } else if (status === "done") {
      chartElement.textContent =
        "No sensors with a year of history were found near this city.";
    } else {
      chartElement.textContent = "Could not load history: " + status;
    }
    return;
  }

  const data = days.map((d) => ({
    day: new Date(d.day + "T00:00:00Z"),
    avg: d.avg,
    min: d.min,
    max: d.max,
    sensors: d.sensors,
  }));

  const width = 420,
    height = 240; // fixed viewBox; CSS scales it to the card
  const margin = { top: 28, right: 12, bottom: 26, left: 32 };
  const id = "clip" + ++chartId;

  // Scale to the daily averages so one faulty sensor spike can't flatten the line.
  const yMax = Math.max(d3.max(data, (d) => d.avg) * 1.15, 12);

  const x = d3
    .scaleUtc()
    .domain(d3.extent(data, (d) => d.day))
    .range([margin.left, width - margin.right]);
  const y = d3
    .scaleLinear()
    .domain([0, yMax])
    .nice()
    .range([height - margin.bottom, margin.top]);

  chartElement.replaceChildren();
  const svg = d3
    .select(chartElement)
    .append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", "100%")
    .attr("role", "img")
    .attr(
      "aria-label",
      `Daily average PM2.5 for ${favorite.label} over the past year`,
    );
  const tooltip = d3
    .select(chartElement)
    .append("div")
    .attr("class", "history-tooltip")
    .attr("role", "tooltip")
    .style("display", "none");

  svg
    .append("clipPath")
    .attr("id", id)
    .append("rect")
    .attr("x", margin.left)
    .attr("y", margin.top)
    .attr("width", width - margin.left - margin.right)
    .attr("height", height - margin.top - margin.bottom);

  const plot = svg.append("g").attr("clip-path", `url(#${id})`);

  // EPA color bands in the background
  let lower = 0;
  for (const b of BANDS) {
    if (lower >= y.domain()[1]) break;
    const upper = Math.min(b.max, y.domain()[1]);
    plot
      .append("rect")
      .attr("x", margin.left)
      .attr("width", width - margin.left - margin.right)
      .attr("y", y(upper))
      .attr("height", y(lower) - y(upper))
      .attr("fill", b.color)
      .attr("opacity", 0.15)
      .append("title")
      .text(`${b.label} (${b.range})`);
    lower = b.max;
  }

  // Axes: months along the bottom, µg/m³ on the left
  svg
    .append("g")
    .attr("class", "axis")
    .attr("transform", `translate(0,${height - margin.bottom})`)
    .call(d3.axisBottom(x).ticks(5).tickFormat(d3.utcFormat("%b")).tickSizeOuter(0));
  svg
    .append("g")
    .attr("class", "axis")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(4).tickSizeOuter(0))
    .call((g) => g.select(".domain").remove());
  svg
    .append("text")
    .attr("class", "chart-caption")
    .attr("x", margin.left)
    .attr("y", 15)
    .text("Daily average PM2.5 (µg/m³), past year");

  // Min-to-max range across sensors (clipped if a sensor spikes)
  plot
    .append("path")
    .datum(data)
    .attr("fill", "#246b4a")
    .attr("opacity", 0.18)
    .attr(
      "d",
      d3
        .area()
        .x((d) => x(d.day))
        .y0((d) => y(d.min))
        .y1((d) => y(d.max)),
    );

  // Daily average line
  plot
    .append("path")
    .datum(data)
    .attr("fill", "none")
    .attr("stroke", "#246b4a")
    .attr("stroke-width", 2)
    .attr(
      "d",
      d3
        .line()
        .x((d) => x(d.day))
        .y((d) => y(d.avg)),
    );

  // Hover targets and custom tooltip
  plot
    .selectAll(".hover-point")
    .data(data)
    .join("circle")
    .attr("class", "hover-point")
    .attr("cx", (d) => x(d.day))
    .attr("cy", (d) => y(d.avg))
    .attr("r", 8)
    .attr("fill", "transparent")
    .style("pointer-events", "all")
    .on("pointerenter", function (event, d) {
      d3.select(this)
        .attr("fill", "#246b4a")
        .attr("fill-opacity", 0.2)
        .attr("stroke", "#246b4a")
        .attr("stroke-width", 1.5);

      tooltip.style("display", "block");
    })
    .on("pointermove", function (event, d) {
      const [px, py] = d3.pointer(event, chartElement);

      tooltip
        .style(
          "left",
          `${Math.max(4, Math.min(px + 12, chartElement.clientWidth - 194))}px`,
        )
        .style("top", `${Math.max(4, py - 12)}px`)
        .text(
          `${d3.utcFormat("%b %d, %Y")(d.day)}\n` +
            `Average: ${d.avg.toFixed(1)} µg/m³ (${bandFor(d.avg).label})\n` +
            `Range: ${d.min.toFixed(1)}–${d.max.toFixed(1)} µg/m³\n` +
            `${d.sensors} sensor${d.sensors === 1 ? "" : "s"}`,
        );
    })
    .on("pointerleave", function () {
      d3.select(this)
        .attr("fill", "transparent")
        .attr("fill-opacity", null)
        .attr("stroke", null)
        .attr("stroke-width", null);

      tooltip.style("display", "none");
    });
}

// ---- Tabs: "Your cities" and "Explore map" ----
// Returning users (with saved cities) land on their cities; first-time users land on the map.
// The last tab you picked is remembered, and #cities / #explore in the URL also work.
const TAB_KEY = "zephoraTab";
const TABS = {
  cities: { tab: document.getElementById("tab-cities"), panel: document.getElementById("panel-cities") },
  explore: { tab: document.getElementById("tab-explore"), panel: document.getElementById("panel-explore") },
};

function updateCitiesCount(n) {
  const badge = document.getElementById("citiesCount");
  badge.textContent = n;
  badge.hidden = n === 0;
  badge.setAttribute("aria-label", `${n} saved`);
}

function selectTab(name, { focusTab = false, remember = true } = {}) {
  for (const [key, { tab, panel }] of Object.entries(TABS)) {
    const on = key === name;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    panel.hidden = !on;
  }
  if (focusTab) TABS[name].tab.focus();
  if (remember) {
    try {
      localStorage.setItem(TAB_KEY, name);
    } catch (err) {
      /* remembering is optional */
    }
  }
  if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);

  // Leaflet maps measure their size when created; re-measure now that the panel is visible.
  if (name === "explore") {
    movingByCode = true; // resizing isn't the person moving the map
    map.invalidateSize();
    if (mapTarget) moveMapTo(mapTarget);
    else setTimeout(() => (movingByCode = false), 600);
  } else {
    cityMaps.forEach(fitCityMap);
  }
}

for (const [key, { tab }] of Object.entries(TABS)) {
  tab.addEventListener("click", () => selectTab(key));
  // Arrow keys move between tabs (standard tabs keyboard pattern)
  tab.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowRight" || ev.key === "ArrowLeft" || ev.key === "Home" || ev.key === "End") {
      ev.preventDefault();
      const names = Object.keys(TABS);
      let i = names.indexOf(key);
      if (ev.key === "ArrowRight") i = (i + 1) % names.length;
      else if (ev.key === "ArrowLeft") i = (i - 1 + names.length) % names.length;
      else i = ev.key === "Home" ? 0 : names.length - 1;
      selectTab(names[i], { focusTab: true });
    }
  });
}
window.addEventListener("hashchange", () => {
  const name = location.hash.slice(1);
  if (TABS[name]) selectTab(name);
});

function goFindCity() {
  selectTab("explore");
  placeInput.focus();
  placeInput.select();
}

function initialTab() {
  const fromHash = location.hash.slice(1);
  if (TABS[fromHash]) return fromHash;
  let saved = null;
  try {
    saved = localStorage.getItem(TAB_KEY);
  } catch (err) {
    /* ignore */
  }
  if (TABS[saved]) return saved;
  return getFavorites().length ? "cities" : "explore";
}

// Empty state: a direct way to start
const DC_PLACE = PLACES.find((p) => p.label === "Washington, District of Columbia") || {
  label: "Washington, District of Columbia",
  lat: 38.907,
  lon: -77.037,
};
document.getElementById("emptyFind").onclick = goFindCity;
document.getElementById("emptyQuickAdd").onclick = () => {
  if (!isFavorite(DC_PLACE)) {
    saveFavorites([...getFavorites(), { label: DC_PLACE.label, lat: DC_PLACE.lat, lon: DC_PLACE.lon }]);
  }
  renderFavorites();
  updateSaveButton();
  cityMaps.forEach(fitCityMap);
};

selectTab(initialTab(), { remember: false });

// The hero and the map open on your first saved city (or Washington, DC for new visitors),
// so the page answers "how's the air?" the moment it loads.
const firstFavorite = getFavorites()[0];
choose(firstFavorite ? { ...firstFavorite } : DC_PLACE);