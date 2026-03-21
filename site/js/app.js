(function () {
    "use strict";

    const FUEL_LABELS = {
        regular: "Regular",
        premium: "Premium",
        diesel: "Diésel",
    };

    // ── EmailJS config (fill in after creating your EmailJS account) ──
    const EMAILJS_PUBLIC_KEY = "8-pwo-5vZLYhfJjn2";
    const EMAILJS_SERVICE_ID = "service_3jm6a2o";
    const EMAILJS_TEMPLATE_ID = "template_xr2hzvi";

    // Zoom thresholds for the crossfade
    const FADE_START = 7;
    const FADE_END   = 9;

    let map, darkTiles, roadTiles;
    let geoLayer, stationLayer;
    let pricesData, geojsonData, stationsData;
    let eidToIso = {};
    let activeFuel = "regular";
    let activeTier = null;
    let nationalAvg = null;
    let nationalMin = null;
    let nationalMax = null;
    let stateRankings = {};

    // ── Init ─────────────────────────────────────────────────────
    async function init() {
        map = L.map("map", {
            center: [23.6, -102.5],
            zoom: 5,
            minZoom: 4,
            maxZoom: 18,
            zoomControl: false,
            preferCanvas: true,
        });

        L.control.zoom({ position: "topright" }).addTo(map);

        darkTiles = L.tileLayer(
            "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
            { subdomains: "abcd", maxZoom: 20 }
        ).addTo(map);

        roadTiles = L.tileLayer(
            "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
            {
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
                subdomains: "abcd",
                maxZoom: 20,
                opacity: 0,
            }
        ).addTo(map);

        const [geoRes, priceRes, stationRes] = await Promise.all([
            fetch("data/mexico_states.geojson"),
            fetch("data/prices.json"),
            fetch("data/stations.json"),
        ]);

        geojsonData = await geoRes.json();
        pricesData = await priceRes.json();
        stationsData = await stationRes.json();

        for (const [iso, s] of Object.entries(pricesData.states)) {
            eidToIso[s.entidad_id] = iso;
        }

        document.getElementById("dataDate").textContent =
            formatDate(pricesData.date);

        setupFuelSelector();
        setupPriceFilter();
        setupSearch();
        setupMobileSidebar();
        renderMap();
        buildStationLayer();
        applyZoomState();
        map.on("zoomend", applyZoomState);
        map.on("moveend", updateStatsForZoom);
        map.on("click", closeStationCard);

        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    const ll = [pos.coords.latitude, pos.coords.longitude];
                    map.flyTo(ll, 14, { duration: 1.5 });
                    const icon = L.divIcon({
                        html: '<span style="font-size:28px">🚘</span>',
                        className: "",
                        iconSize: [28, 28],
                        iconAnchor: [14, 28],
                    });
                    L.marker(ll, { icon }).addTo(map);
                },
                () => {},
                { timeout: 5000 }
            );
        }
    }

    // ── Zoom-based layer transitions ─────────────────────────────
    function applyZoomState() {
        const z = map.getZoom();
        const t = clamp01((z - FADE_START) / (FADE_END - FADE_START));

        roadTiles.setOpacity(t);
        darkTiles.setOpacity(1 - t);

        if (geoLayer) {
            if (t >= 1) {
                if (map.hasLayer(geoLayer)) map.removeLayer(geoLayer);
                hideTooltip();
            } else {
                if (!map.hasLayer(geoLayer)) map.addLayer(geoLayer);
                updateChoroplethOpacity(t);
            }
        }
        updateStationVisibility(z);
        updateStatsForZoom();
    }

    function updateChoroplethOpacity(t) {
        if (!geoLayer) return;
        const fillOp = 0.85 * (1 - t);
        const strokeOp = Math.max(0.3, 1 - t);
        geoLayer.eachLayer((layer) => {
            const iso = layer.feature.properties.id;
            const state = pricesData.states[iso];
            const fuelData = state?.[activeFuel];
            layer.setStyle({
                fillOpacity: fillOp,
                opacity: strokeOp,
                fillColor: fuelData ? priceToColor(fuelData.avg) : "#1D2D44",
            });
        });
    }

    function updateStationVisibility(z) {
        if (!stationLayer) return;
        if (z >= FADE_START) {
            if (!map.hasLayer(stationLayer)) map.addLayer(stationLayer);
        } else {
            if (map.hasLayer(stationLayer)) map.removeLayer(stationLayer);
        }
    }

    // ── State choropleth ─────────────────────────────────────────
    function renderMap() {
        computeNationalAvg();
        updateStatsForZoom();
        updateRanking();

        if (geoLayer) map.removeLayer(geoLayer);

        geoLayer = L.geoJSON(geojsonData, {
            style: styleFeature,
            onEachFeature: bindFeatureEvents,
        }).addTo(map);

        if (stationLayer) rebuildStationLayer();
    }

    function styleFeature(feature) {
        const iso = feature.properties.id;
        const state = pricesData.states[iso];
        const fuelData = state?.[activeFuel];

        return {
            fillColor: fuelData ? priceToColor(fuelData.avg) : "#1D2D44",
            weight: 1.5,
            color: "#0D1321",
            fillOpacity: 0.85,
        };
    }

    function bindFeatureEvents(feature, layer) {
        layer.on({
            mouseover: highlightFeature,
            mouseout: resetHighlight,
            mousemove: moveTooltip,
        });
    }

    function highlightFeature(e) {
        if (map.getZoom() >= FADE_END) { hideTooltip(); return; }
        const layer = e.target;
        layer.setStyle({ weight: 2.5, color: "#2b9348", fillOpacity: 0.95 });
        layer.bringToFront();
        showStateTooltip(e);
    }

    function resetHighlight(e) {
        geoLayer.resetStyle(e.target);
        applyZoomState();
        hideTooltip();
    }

    // ── Station markers ──────────────────────────────────────────
    function classifyStation(price, stateAvg) {
        if (price == null || stateAvg == null) return "avg";
        const diff = (price - stateAvg) / stateAvg;
        if (diff < -0.01) return "cheap";
        if (diff >  0.01) return "expensive";
        return "avg";
    }

    const TIER_COLORS = { cheap: "#2b9348", avg: "#ee9b00", expensive: "#c1121f" };

    function buildStationLayer() {
        stationLayer = L.layerGroup();

        for (const s of stationsData) {
            const price = s[activeFuel];
            if (price == null) continue;

            const iso = eidToIso[s.eid];
            const stateAvg = iso ? pricesData.states[iso]?.[activeFuel]?.avg : null;
            const tier = classifyStation(price, stateAvg);

            const marker = L.circleMarker([s.lat, s.lon], {
                radius: 5,
                fillColor: TIER_COLORS[tier],
                fillOpacity: 0.9,
                color: "#0D1321",
                weight: 1,
                bubblingMouseEvents: false,
            });

            marker._stationData = s;
            marker._tier = tier;
            marker.on("mouseover", showStationTooltip);
            marker.on("mouseout", hideTooltip);
            marker.on("mousemove", moveTooltip);
            marker.on("click", openStationCard);

            stationLayer.addLayer(marker);
        }

        updateStationVisibility(map.getZoom());
        applyTierFilter();
    }

    function rebuildStationLayer() {
        const wasVisible = map.hasLayer(stationLayer);
        if (wasVisible) map.removeLayer(stationLayer);
        buildStationLayer();
        if (wasVisible) map.addLayer(stationLayer);
    }

    // ── Tooltips ─────────────────────────────────────────────────
    function showStateTooltip(e) {
        const iso = e.target.feature.properties.id;
        const state = pricesData.states[iso];
        if (!state) return;

        const tip = document.getElementById("tooltip");
        const fuelData = state[activeFuel];

        let html = `<div class="tooltip-title">${state.name}</div>`;

        if (fuelData) {
            html += `<div class="tooltip-highlight">$${fuelData.avg.toFixed(2)} MXN</div>`;
            if (stateRankings[iso]) {
                html += tooltipRow("Ranking", `#${stateRankings[iso]} Más Caro`);
            }
            html += tooltipRow("Mínimo", `$${fuelData.min.toFixed(2)}`);
            html += tooltipRow("Máximo", `$${fuelData.max.toFixed(2)}`);
            html += tooltipRow("Estaciones", fuelData.stations.toLocaleString());
        } else {
            html += `<div style="color:#748CAB;font-size:12px">Sin datos</div>`;
        }

        tip.innerHTML = html;
        tip.classList.add("visible");
    }

    function showStationTooltip(e) {
        const s = e.target._stationData;
        if (!s) return;

        const iso = eidToIso[s.eid];
        const stateAvg = iso ? pricesData.states[iso] : null;

        const tip = document.getElementById("tooltip");
        tip.innerHTML = `<div class="station-pill">`
            + pillCell(s.regular, "Regular", stateAvg?.regular?.avg)
            + pillCell(s.premium, "Premium", stateAvg?.premium?.avg)
            + pillCell(s.diesel,  "Diésel",  stateAvg?.diesel?.avg)
            + `</div>`;
        tip.classList.add("visible", "station-mode");
    }

    function pillCell(price, label, stateAvg) {
        const val = price != null ? price.toFixed(2) : "—";
        const ind = price != null ? avgIndicator(price, stateAvg) : { symbol: "", color: "#748CAB" };
        return `<div class="pill-cell">`
            + `<span class="pill-price">${val}<span class="pill-arrow" style="color:${ind.color}">${ind.symbol}</span></span>`
            + `<span class="pill-label">${label}</span>`
            + `</div>`;
    }

    function avgIndicator(price, avg) {
        if (avg == null) return { symbol: "", color: "#748CAB" };
        const diff = (price - avg) / avg;
        if (diff < -0.01) return { symbol: "↓", color: "#2b9348" };
        if (diff >  0.01) return { symbol: "↑", color: "#c1121f" };
        return { symbol: "—", color: "#ee9b00" };
    }

    function moveTooltip(e) {
        const tip = document.getElementById("tooltip");
        const x = e.originalEvent.clientX;
        const y = e.originalEvent.clientY;
        const pad = 16;

        let left = x + pad;
        let top = y + pad;

        if (left + 240 > window.innerWidth) left = x - 240 - pad;
        if (top + 160 > window.innerHeight) top = y - 160 - pad;

        tip.style.left = left + "px";
        tip.style.top = top + "px";
    }

    function hideTooltip() {
        const tip = document.getElementById("tooltip");
        tip.classList.remove("visible", "station-mode");
    }

    function tooltipRow(label, value) {
        return `<div class="tooltip-row"><span class="tooltip-label">${label}</span><span class="tooltip-value">${value}</span></div>`;
    }

    // ── Station detail card ────────────────────────────────────────
    function openStationCard(e) {
        L.DomEvent.stopPropagation(e);
        const s = e.target._stationData;
        if (!s) return;

        hideTooltip();

        const iso = eidToIso[s.eid];
        const stateAvg = iso ? pricesData.states[iso] : null;

        const card = document.getElementById("stationCard");
        const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}`;

        card.innerHTML = `
            <button class="card-close" id="cardClose">&times;</button>
            <div class="card-header">
                <div class="card-name">${titleCase(s.name)}</div>
                <div class="card-code">${s.code || ""}</div>
            </div>
            <div class="station-pill">
                ${pillCell(s.regular, "Regular", stateAvg?.regular?.avg)}
                ${pillCell(s.premium, "Premium", stateAvg?.premium?.avg)}
                ${pillCell(s.diesel,  "Diésel",  stateAvg?.diesel?.avg)}
            </div>
            <div class="card-actions">
                <a class="card-btn card-btn-primary" href="${mapsUrl}" target="_blank" rel="noopener">Direcciones 🏎️</a>
                <button class="card-btn card-btn-report" id="btnReportar">Reportar ⚠️</button>
                <button class="card-btn card-btn-disabled card-btn-emoji" disabled>👍🏻</button>
                <button class="card-btn card-btn-disabled card-btn-emoji" disabled>👎🏻</button>
            </div>
        `;

        card.classList.add("visible");

        document.getElementById("cardClose").addEventListener("click", closeStationCard);
        document.getElementById("btnReportar").addEventListener("click", () => {
            openReportModal(s, mapsUrl);
        });
    }

    function closeStationCard() {
        document.getElementById("stationCard").classList.remove("visible");
    }

    // ── Color scale ──────────────────────────────────────────────
    function computeNationalAvg() {
        let sum = 0, count = 0;
        let lo = Infinity, hi = -Infinity;
        for (const s of Object.values(pricesData.states)) {
            const d = s[activeFuel];
            if (d) {
                sum += d.avg;
                count++;
                if (d.avg < lo) lo = d.avg;
                if (d.avg > hi) hi = d.avg;
            }
        }
        nationalAvg = count > 0 ? sum / count : null;
        nationalMin = count > 0 ? lo : null;
        nationalMax = count > 0 ? hi : null;
    }

    function hexToRgb(hex) {
        const n = parseInt(hex.slice(1), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    function rgbToHex(r, g, b) {
        return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
    }

    function lerpColor(hex1, hex2, t) {
        const [r1, g1, b1] = hexToRgb(hex1);
        const [r2, g2, b2] = hexToRgb(hex2);
        return rgbToHex(
            Math.round(r1 + (r2 - r1) * t),
            Math.round(g1 + (g2 - g1) * t),
            Math.round(b1 + (b2 - b1) * t)
        );
    }

    function priceToColor(price) {
        if (nationalMin == null || nationalMax == null || nationalMin === nationalMax) return "#1D2D44";
        const t = clamp01((price - nationalMin) / (nationalMax - nationalMin));
        if (t <= 0.5) return lerpColor("#2b9348", "#ee9b00", t / 0.5);
        return lerpColor("#ee9b00", "#c1121f", (t - 0.5) / 0.5);
    }

    // ── Zoom-aware stats (national vs state) ─────────────────────
    const STATE_ZOOM_THRESHOLD = 9;

    function updateStatsForZoom() {
        const z = map.getZoom();
        const label = document.getElementById("statsLabel");

        if (z < STATE_ZOOM_THRESHOLD) {
            label.textContent = "Resumen nacional";
            updateNationalStats();
            return;
        }

        const center = map.getCenter();
        const iso = detectStateAtPoint(center);

        if (!iso || !pricesData.states[iso]) {
            label.textContent = "Resumen nacional";
            updateNationalStats();
            return;
        }

        const stateData = pricesData.states[iso];
        label.textContent = `Resumen estatal \u2014 ${stateData.name}`;

        const d = stateData[activeFuel];
        if (!d) {
            ["statAvg", "statMin", "statMax", "statStations"].forEach(
                id => (document.getElementById(id).textContent = "--")
            );
            return;
        }

        document.getElementById("statAvg").textContent = `$${d.avg.toFixed(2)}`;
        document.getElementById("statMin").textContent = `$${d.min.toFixed(2)}`;
        document.getElementById("statMax").textContent = `$${d.max.toFixed(2)}`;
        document.getElementById("statStations").textContent = d.stations.toLocaleString();
    }

    function detectStateAtPoint(latlng) {
        if (!geojsonData) return null;
        const pt = [latlng.lng, latlng.lat];

        for (const feature of geojsonData.features) {
            const geom = feature.geometry;
            let polygons;

            if (geom.type === "Polygon") {
                polygons = [geom.coordinates];
            } else if (geom.type === "MultiPolygon") {
                polygons = geom.coordinates;
            } else {
                continue;
            }

            for (const polygon of polygons) {
                if (pointInPolygon(pt, polygon[0])) {
                    return feature.properties.id;
                }
            }
        }
        return null;
    }

    function pointInPolygon(pt, ring) {
        let inside = false;
        const x = pt[0], y = pt[1];

        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0], yi = ring[i][1];
            const xj = ring[j][0], yj = ring[j][1];

            if ((yi > y) !== (yj > y) &&
                x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
                inside = !inside;
            }
        }
        return inside;
    }

    // ── National stats ───────────────────────────────────────────
    function updateNationalStats() {
        let allPrices = [];
        let totalStations = 0;

        for (const s of Object.values(pricesData.states)) {
            const d = s[activeFuel];
            if (d) {
                allPrices.push(d.avg);
                totalStations += d.stations;
            }
        }

        if (allPrices.length === 0) {
            ["statAvg", "statMin", "statMax", "statStations"].forEach(
                id => (document.getElementById(id).textContent = "--")
            );
            return;
        }

        const avg = allPrices.reduce((a, b) => a + b, 0) / allPrices.length;
        document.getElementById("statAvg").textContent = `$${avg.toFixed(2)}`;
        document.getElementById("statMin").textContent = `$${Math.min(...allPrices).toFixed(2)}`;
        document.getElementById("statMax").textContent = `$${Math.max(...allPrices).toFixed(2)}`;
        document.getElementById("statStations").textContent = totalStations.toLocaleString();
    }

    // ── Ranking ──────────────────────────────────────────────────
    function updateRanking() {
        const list = document.getElementById("rankingList");
        const entries = [];

        for (const [iso, s] of Object.entries(pricesData.states)) {
            const d = s[activeFuel];
            if (d) entries.push({ iso, name: s.name, avg: d.avg });
        }

        entries.sort((a, b) => a.avg - b.avg);

        stateRankings = {};
        const total = entries.length;
        entries.forEach((e, i) => {
            stateRankings[e.iso] = total - i;
        });

        list.innerHTML = entries
            .map(
                (e, i) => `
            <div class="ranking-item" data-iso="${e.iso}">
                <span class="ranking-rank">${i + 1}</span>
                <span class="ranking-color" style="background:${priceToColor(e.avg)}"></span>
                <span class="ranking-name">${e.name}</span>
                <span class="ranking-price">$${e.avg.toFixed(2)}</span>
            </div>`
            )
            .join("");

        list.querySelectorAll(".ranking-item").forEach((el) => {
            el.addEventListener("mouseenter", () => {
                const iso = el.dataset.iso;
                geoLayer.eachLayer((layer) => {
                    if (layer.feature.properties.id === iso) {
                        layer.setStyle({ weight: 2.5, color: "#2b9348", fillOpacity: 0.95 });
                        layer.bringToFront();
                    }
                });
            });
            el.addEventListener("mouseleave", () => {
                geoLayer.eachLayer((layer) => {
                    geoLayer.resetStyle(layer);
                });
                applyZoomState();
            });
            el.addEventListener("click", () => {
                const iso = el.dataset.iso;
                geoLayer.eachLayer((layer) => {
                    if (layer.feature.properties.id === iso) {
                        map.fitBounds(layer.getBounds(), { padding: [40, 40] });
                    }
                });
            });
        });
    }

    // ── Fuel selector ────────────────────────────────────────────
    function setupFuelSelector() {
        document.querySelectorAll(".fuel-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                document.querySelectorAll(".fuel-btn").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                activeFuel = btn.dataset.fuel;
                renderMap();
            });
        });
    }

    // ── Price tier filter ────────────────────────────────────────
    function setupPriceFilter() {
        document.querySelectorAll(".tier-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                const tier = btn.dataset.tier;
                if (activeTier === tier) {
                    activeTier = null;
                    document.querySelectorAll(".tier-btn").forEach(b => b.classList.add("active"));
                } else {
                    activeTier = tier;
                    document.querySelectorAll(".tier-btn").forEach(b => b.classList.remove("active"));
                    btn.classList.add("active");
                }
                applyTierFilter();
            });
        });
    }

    function applyTierFilter() {
        if (!stationLayer) return;
        stationLayer.eachLayer((marker) => {
            if (activeTier === null || marker._tier === activeTier) {
                marker.setStyle({ fillOpacity: 0.9, opacity: 1 });
            } else {
                marker.setStyle({ fillOpacity: 0, opacity: 0 });
            }
        });
    }

    // ── Address search ──────────────────────────────────────────
    let searchTimer = null;
    let collapseTimer = null;
    const DEBUG_KEYWORD = "gaspard";

    function collapseSearch() {
        document.getElementById("searchBar").classList.add("collapsed");
    }

    function expandSearch() {
        clearTimeout(collapseTimer);
        const bar = document.getElementById("searchBar");
        bar.classList.remove("collapsed");
        setTimeout(() => document.getElementById("searchInput").focus(), 260);
    }

    function scheduleCollapse() {
        clearTimeout(collapseTimer);
        collapseTimer = setTimeout(collapseSearch, 3000);
    }

    function setupSearch() {
        const input = document.getElementById("searchInput");
        const results = document.getElementById("searchResults");
        const toggle = document.getElementById("searchToggle");

        scheduleCollapse();

        toggle.addEventListener("click", expandSearch);

        input.addEventListener("focus", () => {
            clearTimeout(collapseTimer);
        });

        input.addEventListener("blur", () => {
            if (input.value.trim() === "") {
                scheduleCollapse();
            }
        });

        input.addEventListener("input", () => {
            clearTimeout(searchTimer);
            clearTimeout(collapseTimer);
            const q = input.value.trim();

            if (q.toLowerCase() === DEBUG_KEYWORD) {
                results.classList.remove("visible");
                toggleDebugPanel();
                input.value = "";
                return;
            }

            if (q.length < 3) {
                results.classList.remove("visible");
                return;
            }
            searchTimer = setTimeout(() => searchNominatim(q), 400);
        });

        input.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                results.classList.remove("visible");
                input.blur();
            }
        });

        document.addEventListener("click", (e) => {
            if (!document.getElementById("searchBar").contains(e.target)) {
                results.classList.remove("visible");
            }
        });
    }

    async function searchNominatim(query) {
        const results = document.getElementById("searchResults");
        const url = `https://nominatim.openstreetmap.org/search?format=json&countrycodes=mx&limit=5&q=${encodeURIComponent(query)}`;

        try {
            const res = await fetch(url, {
                headers: { "Accept-Language": "es" },
            });
            const data = await res.json();

            if (data.length === 0) {
                results.innerHTML = `<div class="search-no-results">Sin resultados</div>`;
                results.classList.add("visible");
                return;
            }

            results.innerHTML = data
                .map((r) => `<div class="search-result-item" data-lat="${r.lat}" data-lon="${r.lon}">${r.display_name}</div>`)
                .join("");

            results.classList.add("visible");

            results.querySelectorAll(".search-result-item").forEach((el) => {
                el.addEventListener("click", () => {
                    const lat = parseFloat(el.dataset.lat);
                    const lon = parseFloat(el.dataset.lon);
                    map.flyTo([lat, lon], 14, { duration: 1.5 });
                    document.getElementById("searchInput").value = el.textContent;
                    results.classList.remove("visible");
                });
            });
        } catch {
            results.innerHTML = `<div class="search-no-results">Error de búsqueda</div>`;
            results.classList.add("visible");
        }
    }

    // ── Debug panel ─────────────────────────────────────────────
    let debugActive = false;

    function toggleDebugPanel() {
        const panel = document.getElementById("debugPanel");
        debugActive = !debugActive;

        if (debugActive) {
            panel.classList.add("visible");
            updateDebugInfo();
            map.on("zoomend moveend", updateDebugInfo);
            document.getElementById("debugClose").addEventListener("click", () => {
                debugActive = false;
                panel.classList.remove("visible");
                map.off("zoomend moveend", updateDebugInfo);
            });
        } else {
            panel.classList.remove("visible");
            map.off("zoomend moveend", updateDebugInfo);
        }
    }

    function updateDebugInfo() {
        const z = map.getZoom();
        const center = map.getCenter();
        const bounds = map.getBounds();
        const ne = bounds.getNorthEast();
        const sw = bounds.getSouthWest();

        const diagonalKm = haversineKm(sw.lat, sw.lng, ne.lat, ne.lng);
        const radiusKm = diagonalKm / 2;

        document.getElementById("debugZoom").textContent = z.toFixed(1);
        document.getElementById("debugRadius").textContent = `~${radiusKm.toFixed(1)} km`;
        document.getElementById("debugCenter").textContent =
            `${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}`;
    }

    function haversineKm(lat1, lon1, lat2, lon2) {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2
            + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
            * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // ── Mobile sidebar auto-hide ──────────────────────────────────
    let sidebarTimer = null;

    function isMobile() {
        return window.matchMedia("(max-width: 768px)").matches;
    }

    function hideMobileSidebar() {
        document.getElementById("sidebar").classList.add("mobile-hidden");
    }

    function showMobileSidebar() {
        clearTimeout(sidebarTimer);
        document.getElementById("sidebar").classList.remove("mobile-hidden");
        sidebarTimer = setTimeout(hideMobileSidebar, 3000);
    }

    function scheduleSidebarHide() {
        clearTimeout(sidebarTimer);
        sidebarTimer = setTimeout(hideMobileSidebar, 3000);
    }

    function setupMobileSidebar() {
        if (!isMobile()) return;

        scheduleSidebarHide();

        document.getElementById("sidebarTab").addEventListener("click", showMobileSidebar);

        const sidebar = document.getElementById("sidebar");
        sidebar.addEventListener("touchstart", () => {
            clearTimeout(sidebarTimer);
        });
        sidebar.addEventListener("touchend", () => {
            scheduleSidebarHide();
        });

        map.on("click", () => {
            if (isMobile() && !sidebar.classList.contains("mobile-hidden")) {
                hideMobileSidebar();
            }
        });
    }

    // ── Helpers ──────────────────────────────────────────────────
    function formatDate(dateStr) {
        const [y, m, d] = dateStr.split("-");
        const months = [
            "enero","febrero","marzo","abril","mayo","junio",
            "julio","agosto","septiembre","octubre","noviembre","diciembre",
        ];
        const month = months[parseInt(m) - 1];
        const cap = month.charAt(0).toUpperCase() + month.slice(1);
        return `Última actualización de precios ${parseInt(d)} de ${cap} ${y}`;
    }

    function clamp01(v) { return Math.max(0, Math.min(1, v)); }

    function titleCase(str) {
        return str
            .toLowerCase()
            .replace(/(?:^|\s|[-(])\S/g, (c) => c.toUpperCase());
    }

    // ── Report modal ────────────────────────────────────────────
    let reportPhotos = [];
    let reportStation = null;
    let reportMapsUrl = "";

    function openReportModal(station, mapsUrl) {
        reportStation = station;
        reportMapsUrl = mapsUrl;
        reportPhotos = [];

        const info = document.getElementById("reportStationInfo");
        const addr = station.addr || "";
        const state = station.state || "";
        const fullAddr = [addr, state].filter(Boolean).join(", ");

        info.innerHTML =
            `<strong>${titleCase(station.name)}</strong><br>`
            + `Número: ${station.code || "—"}<br>`
            + `Dirección: ${fullAddr || "—"}<br>`
            + `Estado: ${state || "—"}`;

        document.getElementById("reportPreview").innerHTML = "";
        document.getElementById("reportDescription").value = "";
        document.getElementById("charCount").textContent = "0";
        document.getElementById("photoError").textContent = "";
        document.getElementById("descError").textContent = "";
        document.getElementById("reportStatus").textContent = "";
        document.getElementById("reportStatus").className = "report-status";
        document.getElementById("reportSubmit").disabled = false;

        const charCounter = document.querySelector(".report-char-count");
        charCounter.classList.remove("valid");

        document.getElementById("reportOverlay").classList.add("visible");

        setupReportListeners();
    }

    function closeReportModal() {
        document.getElementById("reportOverlay").classList.remove("visible");
        reportPhotos = [];
        reportStation = null;
    }

    function setupReportListeners() {
        const closeBtn = document.getElementById("reportClose");
        const overlay = document.getElementById("reportOverlay");
        const fileInput = document.getElementById("reportPhoto");
        const textarea = document.getElementById("reportDescription");
        const submitBtn = document.getElementById("reportSubmit");

        closeBtn.onclick = closeReportModal;
        overlay.onclick = (e) => {
            if (e.target === overlay) closeReportModal();
        };

        fileInput.value = "";
        fileInput.onchange = handlePhotoSelect;
        textarea.oninput = handleDescriptionInput;
        submitBtn.onclick = submitReport;
    }

    function handlePhotoSelect(e) {
        const files = Array.from(e.target.files);
        document.getElementById("photoError").textContent = "";

        for (const file of files) {
            if (!file.type.startsWith("image/")) continue;

            const reader = new FileReader();
            reader.onload = (ev) => {
                reportPhotos.push({ dataUrl: ev.target.result, file });
                renderPhotoPreviews();
            };
            reader.readAsDataURL(file);
        }
    }

    function renderPhotoPreviews() {
        const container = document.getElementById("reportPreview");
        container.innerHTML = "";

        reportPhotos.forEach((photo, idx) => {
            const thumb = document.createElement("div");
            thumb.className = "report-preview-thumb";
            thumb.innerHTML =
                `<img src="${photo.dataUrl}" alt="Foto ${idx + 1}">`
                + `<button class="report-preview-remove" data-idx="${idx}">&times;</button>`;
            container.appendChild(thumb);
        });

        container.querySelectorAll(".report-preview-remove").forEach((btn) => {
            btn.addEventListener("click", (ev) => {
                ev.preventDefault();
                const idx = parseInt(btn.dataset.idx, 10);
                reportPhotos.splice(idx, 1);
                renderPhotoPreviews();
            });
        });
    }

    function handleDescriptionInput() {
        const textarea = document.getElementById("reportDescription");
        const count = textarea.value.length;
        const counter = document.getElementById("charCount");
        const wrapper = document.querySelector(".report-char-count");

        counter.textContent = count;
        if (count >= 50) {
            wrapper.classList.add("valid");
        } else {
            wrapper.classList.remove("valid");
        }
        document.getElementById("descError").textContent = "";
    }

    function compressImage(dataUrl, maxWidth, quality) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                let w = img.width;
                let h = img.height;

                if (w > maxWidth) {
                    h = Math.round(h * (maxWidth / w));
                    w = maxWidth;
                }

                const canvas = document.createElement("canvas");
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext("2d");
                ctx.drawImage(img, 0, 0, w, h);

                resolve(canvas.toDataURL("image/jpeg", quality));
            };
            img.src = dataUrl;
        });
    }

    function formatReportDateTime() {
        const now = new Date();
        const day = now.getDate();
        const months = [
            "enero","febrero","marzo","abril","mayo","junio",
            "julio","agosto","septiembre","octubre","noviembre","diciembre",
        ];
        const month = months[now.getMonth()];
        const year = now.getFullYear();
        const hours = now.getHours().toString().padStart(2, "0");
        const mins = now.getMinutes().toString().padStart(2, "0");

        return `${day} de ${month} ${year}, ${hours}:${mins} hrs`;
    }

    async function submitReport() {
        const description = document.getElementById("reportDescription").value;
        const submitBtn = document.getElementById("reportSubmit");
        const status = document.getElementById("reportStatus");
        let valid = true;

        if (reportPhotos.length === 0) {
            document.getElementById("photoError").textContent =
                "Se requiere al menos 1 foto de la bomba.";
            valid = false;
        }
        if (description.length < 50) {
            document.getElementById("descError").textContent =
                `La descripción debe tener al menos 50 caracteres (faltan ${50 - description.length}).`;
            valid = false;
        }

        if (!valid) return;

        submitBtn.disabled = true;
        status.textContent = "Enviando reporte...";
        status.className = "report-status";

        try {
            const compressed = await compressImage(
                reportPhotos[0].dataUrl, 640, 0.6
            );

            const station = reportStation;
            const addr = station.addr || "";
            const state = station.state || "";
            const fullAddr = [addr, state].filter(Boolean).join(", ");

            const templateParams = {
                station_code: station.code || "—",
                station_name: titleCase(station.name),
                station_address: fullAddr || "—",
                station_state: state || "—",
                maps_url: reportMapsUrl,
                report_datetime: formatReportDateTime(),
                description: description,
                photo: compressed,
            };

            await emailjs.send(
                EMAILJS_SERVICE_ID,
                EMAILJS_TEMPLATE_ID,
                templateParams,
                EMAILJS_PUBLIC_KEY
            );

            status.textContent = "Reporte enviado correctamente.";
            status.className = "report-status success";

            setTimeout(closeReportModal, 2000);

        } catch (err) {
            console.error("EmailJS error:", err);
            status.textContent = "Error al enviar el reporte. Intenta de nuevo.";
            status.className = "report-status error";
            submitBtn.disabled = false;
        }
    }

    // ── Boot ─────────────────────────────────────────────────────
    init();
})();
