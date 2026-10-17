// PM2.5 color bands (US EPA AQI breakpoints, µg/m³)
    const BANDS = [
        { max: 9,        color: "#00e400", label: "Good",                           range: "0–9" },
        { max: 35.4,     color: "#ffff00", label: "Moderate",                       range: "9–35" },
        { max: 55.4,     color: "#ff7e00", label: "Unhealthy for sensitive groups", range: "35–55" },
        { max: 125.4,    color: "#ff0000", label: "Unhealthy",                      range: "55–125" },
        { max: 225.4,    color: "#8f3f97", label: "Very unhealthy",                 range: "125–225" },
        { max: Infinity, color: "#7e0023", label: "Hazardous",                      range: "225+" },
    ];
    const NO_DATA = "#999999";
    const bandFor = v => BANDS.find(b => v <= b.max);
    const HOUR = 3600 * 1000;

    const saveFavoriteBtn = document.getElementById("saveFavorite");
    const favoritesList = document.getElementById("favorites");
    const FAVORITES_KEY = "airQualityFavoriteCities";

    let selectedPlace = null;

    const statusEl = document.getElementById("status");
    const placeInput = document.getElementById("place");
    const suggest = document.getElementById("suggest");
    const loadBtn = document.getElementById("loadView");
    const setStatus = (msg, isError) => { statusEl.textContent = msg; statusEl.className = isError ? "error" : ""; };

    const map = L.map("map").setView([38.9, -77.03], 11);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    const legend = L.control({ position: "bottomright" });
    legend.onAdd = () => {
        const div = L.DomUtil.create("div", "legend");
        div.innerHTML = "<strong>PM2.5, 24 h average (µg/m³)</strong><br>" +
            BANDS.map(b => `<i style="background:${b.color}"></i>${b.range} ${b.label}`).join("<br>") +
            `<br><i style="background:${NO_DATA}"></i>No data in last 24 h`;
        return div;
    };
    legend.addTo(map);

    // ---- City search with autocomplete (top ~1000 US cities + ~550 big cities worldwide; [name, lat, lon, population, alsoKnownAs?]) ----
    const norm = s => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();   // "São" -> "sao"
    const PLACES = [];
    for (const groups of [CITIES, WORLD])
        for (const [group, list] of Object.entries(groups))
            for (const [name, lat, lon, pop, alt] of list)
                PLACES.push({ name, lat, lon, pop, alt, label: `${name}, ${group}`,
                              key: norm(`${name}, ${group}`), altKey: alt ? norm(alt) : "" });

    // Best matches first: label starts with the text, then a word starts with it, then anywhere.
    // Within the same tier, bigger cities come first. Old names (Bombay, Saigon…) match too.
    
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
            return true;
        } catch (err) {
            setStatus("Couldn't save favorites in this browser.", true);
            return false;
        }
    }

    function isFavorite(p) {
        return getFavorites().some(f =>
            f.label === p.label && f.lat === p.lat && f.lon === p.lon
        );
    }

    function updateSaveButton() {
        if (!selectedPlace) {
            saveFavoriteBtn.disabled = true;
            saveFavoriteBtn.textContent = "☆ Save favorite";
            return;
        }

        if (isFavorite(selectedPlace)) {
            saveFavoriteBtn.disabled = true;
            saveFavoriteBtn.textContent = "★ Already saved";
        } else {
            saveFavoriteBtn.disabled = false;
            saveFavoriteBtn.textContent = "☆ Save favorite";
        }
    }

    function renderFavorites() {
        favoritesList.replaceChildren();

        const favorites = getFavorites();

        if (favorites.length === 0) {
            const li = document.createElement("li");
            li.textContent = "No favorite cities yet.";
            favoritesList.append(li);
            return;
        }

        for (const favorite of favorites) {
            const li = document.createElement("li");

            const cityBtn = document.createElement("button");
            cityBtn.type = "button";
            cityBtn.textContent = favorite.label;
            cityBtn.onclick = () => choose(favorite);

            const removeBtn = document.createElement("button");
            removeBtn.type = "button";
            removeBtn.textContent = "×";
            removeBtn.setAttribute("aria-label", "Remove " + favorite.label);
            removeBtn.onclick = () => {
                const updated = getFavorites().filter(f =>
                    !(f.label === favorite.label &&
                    f.lat === favorite.lat &&
                    f.lon === favorite.lon)
                );

                if (saveFavorites(updated)) {
                    renderFavorites();
                    updateSaveButton();
                }
            };

            li.append(cityBtn, removeBtn);
            favoritesList.append(li);
        }
    }

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
        return scored.slice(0, 8).map(x => x[1]);
    }

    let matches = [], active = -1;

    function render() {
        matches = search(placeInput.value);
        active = matches.length ? 0 : -1;
        suggest.innerHTML = "";
        const q = placeInput.value.trim();
        matches.forEach((p, i) => {
            const li = document.createElement("li");
            li.setAttribute("role", "option");
            if (i === active) li.className = "active";
            const nq = norm(q), at = norm(p.label).indexOf(nq);
            if (at < 0) li.textContent = p.alt ? `${p.label} (${p.alt})` : p.label;
            else li.append(p.label.slice(0, at),
                           Object.assign(document.createElement("b"), { textContent: p.label.slice(at, at + nq.length) }),
                           p.label.slice(at + nq.length));
            li.onmousedown = ev => { ev.preventDefault(); choose(p); };   // mousedown, so the input doesn't blur first
            suggest.append(li);
        });
        suggest.hidden = !matches.length;
        placeInput.setAttribute("aria-expanded", String(!suggest.hidden));
    }

    function highlight(i) {
        active = (i + matches.length) % matches.length;
        [...suggest.children].forEach((li, j) => li.classList.toggle("active", j === active));
        suggest.children[active].scrollIntoView({ block: "nearest" });
    }

    function choose(p) {
        selectedPlace = p;
        updateSaveButton();

        placeInput.value = p.label;
        suggest.hidden = true;
        placeInput.setAttribute("aria-expanded", "false");
        const dLat = 0.15, dLon = 0.15 / Math.cos(p.lat * Math.PI / 180);
        const s = p.lat - dLat, n = p.lat + dLat, w = p.lon - dLon, e = p.lon + dLon;
        map.fitBounds([[s, w], [n, e]]);
        loadArea(s, w, n, e, p.label);
    }


    saveFavoriteBtn.onclick = () => {
        if (!selectedPlace || isFavorite(selectedPlace)) return;

        const favorites = getFavorites();
        favorites.push({
            label: selectedPlace.label,
            lat: selectedPlace.lat,
            lon: selectedPlace.lon
        });

        if (saveFavorites(favorites)) {
            renderFavorites();
            updateSaveButton();
            setStatus(selectedPlace.label + " saved to favorites.");
        }
    };

    renderFavorites();

    placeInput.addEventListener("input", () => {
        selectedPlace = null;
        updateSaveButton();
        render();
    });
    placeInput.addEventListener("focus", () => { if (placeInput.value.trim()) render(); });
    placeInput.addEventListener("blur", () => { suggest.hidden = true; });
    placeInput.addEventListener("keydown", ev => {
        if (suggest.hidden && ev.key === "ArrowDown") { render(); return; }
        if (suggest.hidden || !matches.length) return;
        if (ev.key === "ArrowDown") { ev.preventDefault(); highlight(active + 1); }
        else if (ev.key === "ArrowUp") { ev.preventDefault(); highlight(active - 1); }
        else if (ev.key === "Enter") { ev.preventDefault(); choose(matches[active]); }
        else if (ev.key === "Escape") { suggest.hidden = true; }
    });

    loadBtn.onclick = () => {
        const b = map.getBounds();
        placeInput.value = "";
        loadArea(b.getSouth(), b.getWest(), b.getNorth(), b.getEast(), "this map view");
    };

    // ---- Ask the server for the sensors + readings in an area ----
    let layer = L.featureGroup().addTo(map);
    let requestId = 0;   // ignore stale responses if the user switches quickly

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
            localStorage.setItem(key, JSON.stringify({
                timestamp: Date.now(),
                data: data
            }));
        } catch (err) {
            // Caching is optional; the map should still work without it.
            console.warn("Could not cache map data:", err);
        }
    }
    
    async function loadArea(s, w, n, e, label) {
        const myId = ++requestId;
        loadBtn.disabled = placeInput.disabled = true;

        // Round bounds so tiny coordinate differences don't create separate cache entries.
        const bounds = [s, w, n, e].map(v => v.toFixed(3));
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

            setStatus(`Loading ${label}… the first time an area is loaded this can take a minute.`);

            const q = new URLSearchParams({
                south: s,
                west: w,
                north: n,
                east: e,
                compare: "0"
            });

            const resp = await fetch("/api/region?" + q);
            const d = await resp.json();

            if (!resp.ok) throw new Error(d.error || resp.status);
            if (myId !== requestId) return;

            setCachedData(cacheKey, d);
            show(d, label);
        } catch (err) {
            if (myId === requestId) {
                setStatus("Couldn't load " + label + ": " + err.message, true);
            }
            console.error(err);
        } finally {
            if (myId === requestId) {
                loadBtn.disabled = placeInput.disabled = false;
            }
        }
    }

    function show(d, label) {
        window.airData = d;
        layer.clearLayers();

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

        for (const s of d.sensors) {
            const rows = byFeed.get(s.feed_id) || [];
            const lastDay = rows.filter(r => r.t > cutoff);
            const avg = lastDay.length ? lastDay.reduce((a, r) => a + r.v, 0) / lastDay.length : null;
            L.circleMarker([s.latitude, s.longitude], {
                radius: 8, weight: 1.5, color: "#222", fillOpacity: 0.9,
                fillColor: avg === null ? NO_DATA : bandFor(avg).color,
            })
                .bindPopup(() => popupFor(s, rows, avg), { minWidth: 320, maxWidth: 360 })
                .bindTooltip(avg === null ? s.name : `${s.name}: ${avg.toFixed(1)}`)
                .addTo(layer);
        }

        let msg = d.sensors.length
            ? `${d.sensors.length} sensors in ${label}. Each dot is the average of the 24 hours ending ` +
              `${new Date(latest).toLocaleString()}. Click a dot for its history.`
            : `No active outdoor PM2.5 sensors found in ${label}. Try a bigger area.`;
        if (d.truncated) msg += ` Showing the first ${d.sensors.length} of ${d.total_found}; zoom in to see the rest.`;
        setStatus(msg);
        showPerf(d.perf);
        refreshStorage();
    }

    // Timing of the chart query: pre-computed continuous aggregate vs the raw table
    function showPerf(p) {
        const el = document.getElementById("perf");
        if (!p) { el.hidden = true; return; }
        let t = `Chart data served in ${p.agg_ms} ms from the hourly continuous aggregate ` +
                `(${p.raw_rows.toLocaleString()} raw readings rolled up into ${p.hourly_rows.toLocaleString()} hourly rows).`;
        if (p.raw_ms != null) {
            t += ` The same query on the raw table took ${p.raw_ms} ms`;
            t += p.raw_ms >= p.agg_ms * 1.5 ? ` (${(p.raw_ms / p.agg_ms).toFixed(1)}× slower).` : ".";
        }
        if (p.loaded_sensors) t += ` Downloaded ${p.loaded_sensors} new sensors in ${p.load_secs} s.`;
        el.textContent = t;
        el.hidden = false;
    }

    // How big the readings table is, and how much of it Tiger's columnstore has compressed
    async function refreshStorage() {
        const el = document.getElementById("storage");
        try {
            const s = await (await fetch("/api/storage")).json();
            const mb = b => (b / 1048576).toFixed(1) + " MB";
            let t = "Database: " + (s.rows > 0 ? `about ${s.rows.toLocaleString()} readings, ` : "") +
                    (s.total_bytes != null ? `${mb(s.total_bytes)} on disk. ` : "");
            if (s.compressed_chunks > 0 && s.before_bytes && s.after_bytes)
                t += `${s.compressed_chunks} of ${s.total_chunks} chunks are in the columnstore: ` +
                     `${mb(s.before_bytes)} → ${mb(s.after_bytes)} (${(s.before_bytes / s.after_bytes).toFixed(1)}× smaller).`;
            else
                t += "No chunks are in the columnstore yet. Chunks compress once they are 2 days old.";
            el.textContent = t;
            el.hidden = false;
        } catch (err) { el.hidden = true; }
    }
    refreshStorage();

    function popupFor(s, rows, avg) {
        const div = document.createElement("div");
        div.className = "popup";
        const h = document.createElement("h2");
        h.textContent = s.name;
        const p = document.createElement("p");
        p.textContent = avg === null
            ? "No readings in the last 24 hours."
            : `Last 24 h average: ${avg.toFixed(1)} µg/m³ (${bandFor(avg).label})`;
        div.append(h, p);
        if (rows.length) div.insertAdjacentHTML("beforeend", chartSVG(rows));
        return div;
    }

    function chartSVG(rows) {
        const W = 340, H = 190, m = { l: 34, r: 8, t: 8, b: 22 };
        const x0 = rows[0].t, x1 = rows[rows.length - 1].t;
        const y1 = Math.max(...rows.map(r => r.v), 12);
        const X = t => m.l + (t - x0) / (x1 - x0 || 1) * (W - m.l - m.r);
        const Y = v => H - m.b - v / y1 * (H - m.t - m.b);
        const day = t => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
        const grid = [0, 0.5, 1].map(f => f * y1).map(v =>
            `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/>` +
            `<text x="${m.l - 4}" y="${Y(v) + 3}" text-anchor="end">${v.toFixed(0)}</text>`).join("");
        const pts = rows.map(r => `${X(r.t).toFixed(1)},${Y(r.v).toFixed(1)}`).join(" ");
        return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Hourly PM2.5 over time">` +
            grid + `<polyline class="line" points="${pts}"/>` +
            `<text x="${m.l}" y="${H - 6}">${day(x0)}</text>` +
            `<text x="${W - m.r}" y="${H - 6}" text-anchor="end">${day(x1)}</text>` +
            `<text x="${m.l + 4}" y="${m.t + 8}">µg/m³</text></svg>`;
    }