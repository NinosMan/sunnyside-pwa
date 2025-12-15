const $ = (selector, root = document) => root.querySelector(selector);

const state = {
  lastSearch: null,
  beaches: [],
  analyzedCount: 0,
  inFlight: null,
  maps: {},
  currentOpenIndex: -1,
  displayCount: 0,
  analysisRunning: false,
  windAtSearch: null,
};

const ui = {
  form: $("#search-form"),
  cityInput: $("#cityInput"),
  searchBtn: $("#searchBtn"),
  gpsBtn: $("#gpsBtn"),
  loader: $("#loader"),
  status: $("#status"),
  topPick: $("#topPick"),
  results: $("#results"),
  radiusKm: $("#radiusKm"),
  analyzeMore: $("#analyze-more"),
  aboutBtn: $("#aboutBtn"),
  aboutModal: $("#aboutModal"),
  aboutClose: $("#aboutClose"),
};

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

const windCache = new Map();
const elevationCache = new Map();
const shelterCache = new Map();
const shorelineCache = new Map();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function lerp(a, b, t) {
  return a + (b - a) * clamp(t, 0, 1);
}

function getCachedValue(cache, key, ttlMs) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Number.isFinite(ttlMs) && Date.now() - hit.ts > ttlMs) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function setCachedValue(cache, key, value) {
  cache.set(key, { ts: Date.now(), value });
  return value;
}

function mergeAbortSignals(signals) {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener(
      "abort",
      () => {
        controller.abort(signal.reason);
      },
      { once: true },
    );
  }
  return controller.signal;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, { signal, timeoutMs, retries = 0, retryDelay = 1000, ...init } = {}) {
  const timeoutController = timeoutMs ? new AbortController() : null;
  const timeoutHandle = timeoutController
    ? setTimeout(() => timeoutController.abort(new Error("Request timed out.")), timeoutMs)
    : null;

  const mergedSignal = mergeAbortSignals([signal, timeoutController?.signal]);

  try {
    const res = await fetch(url, { ...init, signal: mergedSignal, headers: { ...init.headers } });
    if (!res.ok) {
      let detail = "";
      try {
        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const json = await res.json();
          detail = json?.message ? String(json.message) : JSON.stringify(json);
        } else {
          detail = (await res.text()).trim();
        }
      } catch {
        // no-op
      }
      const snippet = detail ? ` ${detail.slice(0, 240)}` : "";
      const error = new Error(`Request failed (${res.status}).${snippet}`);
      error.status = res.status;

      // Retry on rate limit errors (429) or server errors (5xx)
      if (retries > 0 && (res.status === 429 || res.status >= 500)) {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        await sleep(retryDelay);
        // Exponential backoff for next retry
        return fetchJson(url, {
          signal,
          timeoutMs,
          retries: retries - 1,
          retryDelay: retryDelay * 2,
          ...init
        });
      }

      throw error;
    }
    return await res.json();
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function setStatus(line, detail = "") {
  if (!ui.status) return;
  ui.status.replaceChildren();

  const lineText = line ?? "";
  const detailText = detail ?? "";

  if (lineText) {
    const el = document.createElement("div");
    el.textContent = lineText;
    ui.status.append(el);
  }

  if (detailText) {
    const el = document.createElement("div");
    el.className = "status-sub";
    el.textContent = detailText;
    ui.status.append(el);
  }
}

function resetMaps() {
  for (const map of Object.values(state.maps)) {
    try {
      map.remove();
    } catch {
      // no-op
    }
  }
  state.maps = {};
  state.currentOpenIndex = -1;
}

function setLoading(isLoading, { clearResults: shouldClear = false } = {}) {
  const busy = Boolean(isLoading);
  if (ui.loader) ui.loader.style.display = busy ? "block" : "none";

  for (const el of [
    ui.searchBtn,
    ui.gpsBtn,
    ui.cityInput,
    ui.radiusKm,
    ui.analyzeMore,
  ]) {
    if (el) el.disabled = busy;
  }

  if (busy && shouldClear) {
    resetMaps();
    if (ui.results) ui.results.replaceChildren();
    if (ui.topPick) {
      ui.topPick.hidden = true;
      ui.topPick.replaceChildren();
    }
  }
}

function formatKm(km) {
  if (!Number.isFinite(km)) return "";
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

function formatWindKmh(kmh) {
  if (!Number.isFinite(kmh)) return "";
  return `${Math.round(kmh)} km/h`;
}

function normalizeBearing(deg) {
  const x = ((deg % 360) + 360) % 360;
  return x;
}

function angleDiffDeg(a, b) {
  const d = Math.abs(normalizeBearing(a) - normalizeBearing(b)) % 360;
  return d > 180 ? 360 - d : d;
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

function destinationPoint(lat, lon, bearingDeg, distanceM) {
  const R = 6371e3;
  const theta = normalizeBearing(bearingDeg) * DEG2RAD;
  const delta = distanceM / R;

  const phi1 = lat * DEG2RAD;
  const lambda1 = lon * DEG2RAD;

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);

  const sinDelta = Math.sin(delta);
  const cosDelta = Math.cos(delta);

  const sinPhi2 = sinPhi1 * cosDelta + cosPhi1 * sinDelta * Math.cos(theta);
  const phi2 = Math.asin(clamp(sinPhi2, -1, 1));

  const y = Math.sin(theta) * sinDelta * cosPhi1;
  const x = cosDelta - sinPhi1 * Math.sin(phi2);
  const lambda2 = lambda1 + Math.atan2(y, x);

  const outLat = phi2 * RAD2DEG;
  let outLon = (lambda2 * RAD2DEG + 540) % 360 - 180;
  if (!Number.isFinite(outLon)) outLon = lon;
  return { lat: outLat, lon: outLon };
}

function degreesToCompass(deg) {
  if (!Number.isFinite(deg)) return "";
  const directions = [
    "N",
    "NNE",
    "NE",
    "ENE",
    "E",
    "ESE",
    "SE",
    "SSE",
    "S",
    "SSW",
    "SW",
    "WSW",
    "W",
    "WNW",
    "NW",
    "NNW",
  ];
  const i = Math.round(normalizeBearing(deg) / 22.5) % 16;
  return directions[i];
}

function clearResults() {
  resetMaps();
  if (ui.results) ui.results.replaceChildren();
}

function renderPlaceholder(text) {
  clearResults();
  if (!ui.results) return;
  const el = document.createElement("div");
  el.className = "empty";
  el.textContent = text;
  ui.results.append(el);
}

function distanceBlurb(distanceKm) {
  if (!Number.isFinite(distanceKm)) return "📍 Nearby";
  if (distanceKm < 2) return "🚶 Very close";
  if (distanceKm < 8) return "🚗 Short drive";
  if (distanceKm < 20) return "🚗 Drive";
  if (distanceKm < 50) return "🧭 Day trip";
  return "🧭 Far";
}

function shelterLabel(shelterReduction) {
  if (!Number.isFinite(shelterReduction)) return "—";
  if (shelterReduction >= 0.45) return "Very sheltered";
  if (shelterReduction >= 0.28) return "Sheltered";
  if (shelterReduction >= 0.14) return "Some shelter";
  return "Exposed";
}

function pickForScore(score) {
  if (!Number.isFinite(score)) return { label: "Checking…", color: "var(--warning)" };
  if (score >= 82) return { label: "Best bet", color: "var(--success)" };
  if (score >= 68) return { label: "Good", color: "var(--success)" };
  if (score >= 52) return { label: "OK", color: "var(--warning)" };
  return { label: "Skip", color: "var(--danger)" };
}

function renderBeaches(beaches, { showUnanalyzed = false } = {}) {
  clearResults();
  if (!beaches.length) {
    renderPlaceholder("No beaches found nearby.");
    return;
  }

  for (let idx = 0; idx < beaches.length; idx++) {
    const beach = beaches[idx];

    const card = document.createElement("div");
    card.className = "beach-card";
    card.id = `card-${idx}`;

    const summary = document.createElement("div");
    summary.className = "card-summary";

    const headerRow = document.createElement("div");
    headerRow.className = "header-row";

    const left = document.createElement("div");

    const nameEl = document.createElement("h2");
    nameEl.className = "beach-name";
    nameEl.textContent = beach.name;

    const distTag = document.createElement("span");
    distTag.className = "dist-tag";
    distTag.textContent = distanceBlurb(beach.distanceKm);

    left.append(nameEl, distTag);

    const badge = document.createElement("span");
    badge.className = "wind-badge";

    const score = beach.analysis?.score;
    const windLevel = beach.analysis?.windLevel;
    const pick = pickForScore(score);

    if (beach.analysis?.error) {
      badge.style.background = "var(--danger)";
      badge.textContent = "Can't check";
    } else if (Number.isFinite(score)) {
      badge.style.background = pick.color;
      badge.textContent = pick.label;
    } else {
      badge.style.background = "var(--warning)";
      badge.textContent = showUnanalyzed ? "Checking…" : "—";
    }

    headerRow.append(left, badge);

    const shelter = beach.analysis?.shelterReduction;
    const windDirDeg = beach.analysis?.windDirDeg;

    const chips = document.createElement("div");
    chips.className = "chip-row";

    const windChip = document.createElement("span");
    windChip.className = "chip";
    const windText = windLevel || (showUnanalyzed ? "Checking…" : "—");
    windChip.textContent = `🍃 ${windText}`;
    if (!windLevel) windChip.classList.add("chip-muted");

    const shelterChip = document.createElement("span");
    shelterChip.className = "chip";
    const shelterText = beach.analysis?.error ? "—" : shelterLabel(shelter);
    shelterChip.textContent = `🪨 ${shelterText}`;
    if (!beach.analysis || beach.analysis?.error) shelterChip.classList.add("chip-muted");

    chips.append(windChip, shelterChip);

    const expandHint = document.createElement("div");
    expandHint.className = "expand-hint";
    expandHint.textContent = "▼";

    summary.append(headerRow, chips);
    if (beach.analysis?.error) {
      const detail = document.createElement("div");
      detail.className = "card-detail";
      detail.textContent = "Couldn’t check conditions just now.";
      summary.append(detail);
    }
    summary.append(expandHint);

    const wrapper = document.createElement("div");
    wrapper.className = "map-wrapper";
    wrapper.id = `map-wrapper-${idx}`;

    const frame = document.createElement("div");
    frame.className = "map-frame";
    frame.id = `map-frame-${idx}`;

    const go = document.createElement("a");
    go.className = "go-btn";
    go.target = "_blank";
    go.rel = "noreferrer";
    go.href = `https://www.google.com/maps/search/?api=1&query=${beach.lat},${beach.lon}`;
    go.textContent = "Go in Maps";

    wrapper.append(frame, go);

    card.append(summary, wrapper);
    card.addEventListener("click", (e) => {
      const target = e.target;
      if (target instanceof Element && target.closest(".go-btn")) return;
      toggleCard(idx, beach.lat, beach.lon, windDirDeg);
    });

    ui.results.append(card);
  }
}

function toggleCard(index, lat, lon, windDirDeg) {
  if (state.currentOpenIndex === index) {
    closeCard(index);
    state.currentOpenIndex = -1;
    return;
  }
  if (state.currentOpenIndex !== -1) closeCard(state.currentOpenIndex);
  openCard(index, lat, lon, windDirDeg);
  state.currentOpenIndex = index;
}

function closeCard(index) {
  const wrapper = document.getElementById(`map-wrapper-${index}`);
  const card = document.getElementById(`card-${index}`);
  if (wrapper) wrapper.style.height = "0";
  if (card) card.classList.remove("expanded");
}

function openCard(index, lat, lon, windDirDeg) {
  const wrapper = document.getElementById(`map-wrapper-${index}`);
  const card = document.getElementById(`card-${index}`);
  if (!wrapper || !card) return;

  card.classList.add("expanded");
  wrapper.style.height = "350px";

  if (state.maps[index]) {
    try {
      state.maps[index].invalidateSize();
    } catch {
      // no-op
    }
    return;
  }

  const L = window.L;
  if (!L) return;

  setTimeout(() => {
    if (state.maps[index]) return;
    const map = L.map(`map-frame-${index}`, {
      zoomControl: false,
      attributionControl: false,
      scrollWheelZoom: false,
    }).setView([lat, lon], 14);

    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    ).addTo(map);

    const beachIcon = L.divIcon({
      html: '<div style="font-size:30px;">🏖️</div>',
      className: "dummy",
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });
    L.marker([lat, lon], { icon: beachIcon }).addTo(map);

    if (Number.isFinite(windDirDeg)) {
      const rot = windDirDeg + 180;
      const arrowHtml = `<div style="transform: rotate(${rot}deg); font-size: 50px; color: #FF6B6B; text-shadow: 2px 2px 0 #fff; width: 60px; height: 60px; text-align:center; line-height:60px;">⬇</div>`;
      const windIcon = L.divIcon({
        html: arrowHtml,
        className: "",
        iconSize: [60, 60],
        iconAnchor: [30, 30],
      });
      L.marker([lat, lon], { icon: windIcon, zIndexOffset: 100 }).addTo(map);
    }

    map.invalidateSize();
    state.maps[index] = map;
  }, 120);
}

function beachSortRank(beach) {
  const score = beach.analysis?.score;
  if (beach.analysis?.error) return { tier: 0, score: -Infinity };
  if (Number.isFinite(score)) return { tier: 2, score };
  return { tier: 1, score: -Infinity };
}

function getDisplayedBeaches() {
  const displayCount = Math.max(0, Math.min(state.displayCount, state.beaches.length));
  const slice = state.beaches.slice(0, displayCount);
  return slice.slice().sort((a, b) => {
    const ar = beachSortRank(a);
    const br = beachSortRank(b);
    if (ar.tier !== br.tier) return br.tier - ar.tier;
    if (ar.score !== br.score) return br.score - ar.score;
    return (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity);
  });
}

function getBestAnalyzedBeach() {
  const scored = state.beaches.filter(
    (b) => !b.analysis?.error && Number.isFinite(b.analysis?.score),
  );
  if (!scored.length) return null;
  return scored
    .slice()
    .sort((a, b) => {
      const s = (b.analysis?.score ?? -Infinity) - (a.analysis?.score ?? -Infinity);
      if (s) return s;
      return (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity);
    })[0];
}

function focusBeachById(id) {
  const indexInState = state.beaches.findIndex((b) => b.id === id);
  if (indexInState === -1) return;

  if (indexInState >= state.displayCount) {
    state.displayCount = Math.min(state.beaches.length, indexInState + 1);
  }

  renderCurrent();

  const list = getDisplayedBeaches();
  const idx = list.findIndex((b) => b.id === id);
  if (idx === -1) return;

  requestAnimationFrame(() => {
    const el = document.getElementById(`card-${idx}`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function updateTopPick() {
  if (!ui.topPick) return;
  const best = getBestAnalyzedBeach();
  if (!best) {
    ui.topPick.hidden = true;
    ui.topPick.replaceChildren();
    return;
  }

  ui.topPick.hidden = false;
  ui.topPick.replaceChildren();

  const card = document.createElement("div");
  card.className = "top-pick-card";
  card.addEventListener("click", (e) => {
    const target = e.target;
    if (target instanceof Element && target.closest("a")) return;
    focusBeachById(best.id);
  });

  const title = document.createElement("div");
  title.className = "top-pick-title";
  title.textContent = "Best right now";

  const name = document.createElement("div");
  name.className = "beach-name";
  name.textContent = best.name;

  const chips = document.createElement("div");
  chips.className = "chip-row";

  const pick = pickForScore(best.analysis?.score);
  const pickChip = document.createElement("span");
  pickChip.className = "chip";
  pickChip.textContent = `⭐ ${pick.label}`;

  const distChip = document.createElement("span");
  distChip.className = "chip";
  distChip.textContent = distanceBlurb(best.distanceKm);

  const windChip = document.createElement("span");
  windChip.className = "chip";
  windChip.textContent = `🍃 ${best.analysis?.windLevel ?? "—"}`;

  const shelterChip = document.createElement("span");
  shelterChip.className = "chip";
  shelterChip.textContent = `🪨 ${shelterLabel(best.analysis?.shelterReduction)}`;

  const mapsChip = document.createElement("a");
  mapsChip.className = "chip";
  mapsChip.href = `https://www.google.com/maps/search/?api=1&query=${best.lat},${best.lon}`;
  mapsChip.target = "_blank";
  mapsChip.rel = "noreferrer";
  mapsChip.textContent = "🗺️ Maps";

  chips.append(pickChip, distChip, windChip, shelterChip, mapsChip);

  card.append(title, name, chips);
  ui.topPick.append(card);
}

function renderCurrent() {
  const list = getDisplayedBeaches();
  renderBeaches(list, { showUnanalyzed: true });
  updateTopPick();
  if (ui.analyzeMore) ui.analyzeMore.hidden = state.displayCount >= state.beaches.length;
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register("sw.js");
    } catch {
      // no-op
    }
  });
}

function setAboutOpen(isOpen) {
  if (!ui.aboutModal) return;
  ui.aboutModal.hidden = !isOpen;
  document.documentElement.style.overflow = isOpen ? "hidden" : "";
  document.body.style.overflow = isOpen ? "hidden" : "";
}

function wireAboutModal() {
  if (ui.aboutBtn) {
    ui.aboutBtn.addEventListener("click", () => setAboutOpen(true));
  }
  if (ui.aboutClose) {
    ui.aboutClose.addEventListener("click", () => setAboutOpen(false));
  }
  if (ui.aboutModal) {
    ui.aboutModal.addEventListener("click", (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-close=\"true\"]")) setAboutOpen(false);
    });
  }
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!ui.aboutModal || ui.aboutModal.hidden) return;
    setAboutOpen(false);
  });
}

function loadSavedLocation() {
  try {
    const raw = localStorage.getItem("sunnyside.location");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Number.isFinite(parsed.lat) || !Number.isFinite(parsed.lon)) return null;
    return { lat: parsed.lat, lon: parsed.lon };
  } catch {
    // no-op
    return null;
  }
}

function saveLocation(lat, lon) {
  try {
    localStorage.setItem("sunnyside.location", JSON.stringify({ lat, lon }));
  } catch {
    // no-op
  }
}

async function getBrowserLocation() {
  if (!("geolocation" in navigator)) throw new Error("Geolocation not supported.");
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(new Error(err.message || "Unable to get location.")),
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 },
    );
  });
}

function computeShorelineAxisDeg(geometry) {
  if (!Array.isArray(geometry) || geometry.length < 3) return null;

  const meanLat = geometry.reduce((sum, p) => sum + p.lat, 0) / geometry.length;
  const meanLon = geometry.reduce((sum, p) => sum + p.lon, 0) / geometry.length;
  const cosLat = Math.cos(meanLat * DEG2RAD);
  const R = 6371000;

  const points = geometry.map((p) => ({
    x: (p.lon - meanLon) * DEG2RAD * R * cosLat,
    y: (p.lat - meanLat) * DEG2RAD * R,
  }));

  const mx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const my = points.reduce((sum, p) => sum + p.y, 0) / points.length;

  let covXX = 0;
  let covYY = 0;
  let covXY = 0;
  for (const p of points) {
    const dx = p.x - mx;
    const dy = p.y - my;
    covXX += dx * dx;
    covYY += dy * dy;
    covXY += dx * dy;
  }
  covXX /= points.length;
  covYY /= points.length;
  covXY /= points.length;

  if (!(covXX > 0 || covYY > 0)) return null;

  const theta = 0.5 * Math.atan2(2 * covXY, covXX - covYY);
  if (!Number.isFinite(theta)) return null;

  const bearing = normalizeBearing(90 - theta * RAD2DEG);
  const axis = bearing >= 180 ? bearing - 180 : bearing;
  return axis;
}

function crossShoreFactor(windFromDeg, shorelineAxisDeg) {
  if (!Number.isFinite(shorelineAxisDeg)) return 0.65;
  const diff = Math.min(
    angleDiffDeg(windFromDeg, shorelineAxisDeg),
    angleDiffDeg(windFromDeg, (shorelineAxisDeg + 180) % 360),
  );
  return Math.abs(Math.sin(diff * DEG2RAD));
}

async function estimateShorelineAxisFromElevation({ lat, lon, signal }) {
  const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const cached = getCachedValue(shorelineCache, cacheKey, 14 * 24 * 60_000);
  if (cached) return cached;

  const ringRadiusM = 350;
  const bearingsDeg = Array.from({ length: 12 }, (_, i) => i * 30);
  const points = [{ lat, lon }, ...bearingsDeg.map((b) => destinationPoint(lat, lon, b, ringRadiusM))];
  const elevations = await fetchElevations(points, { signal });
  const baseElevationM = elevations[0];

  const samples = [];
  for (let i = 0; i < bearingsDeg.length; i++) {
    const elevationM = elevations[i + 1];
    if (!Number.isFinite(elevationM) || !Number.isFinite(baseElevationM)) continue;
    samples.push({ bearingDeg: bearingsDeg[i], deltaM: elevationM - baseElevationM });
  }

  if (!samples.length) {
    return setCachedValue(shorelineCache, cacheKey, {
      shorelineAxisDeg: null,
      seaBearingDeg: null,
      contrastM: null,
    });
  }

  const minDelta = Math.min(...samples.map((s) => s.deltaM));
  const cutoff = minDelta + 2;
  let candidates = samples.filter((s) => s.deltaM <= cutoff);
  if (candidates.length < 2) {
    candidates = samples.slice().sort((a, b) => a.deltaM - b.deltaM).slice(0, 3);
  }

  let sx = 0;
  let sy = 0;
  for (const c of candidates) {
    const rad = c.bearingDeg * DEG2RAD;
    sx += Math.cos(rad);
    sy += Math.sin(rad);
  }
  if (!(sx || sy)) {
    return setCachedValue(shorelineCache, cacheKey, {
      shorelineAxisDeg: null,
      seaBearingDeg: null,
      contrastM: null,
    });
  }

  const seaBearingDeg = normalizeBearing(Math.atan2(sy, sx) * RAD2DEG);
  const sorted = samples.slice().sort((a, b) => a.deltaM - b.deltaM);
  const highAvg =
    sorted.length >= 3
      ? (sorted[sorted.length - 1].deltaM + sorted[sorted.length - 2].deltaM + sorted[sorted.length - 3].deltaM) / 3
      : sorted[sorted.length - 1].deltaM;
  const contrastM = highAvg - minDelta;

  const axis = normalizeBearing(seaBearingDeg + 90);
  const shorelineAxisDeg = contrastM >= 6 ? (axis >= 180 ? axis - 180 : axis) : null;

  return setCachedValue(shorelineCache, cacheKey, {
    shorelineAxisDeg,
    seaBearingDeg,
    contrastM,
  });
}

async function fetchWindAt({ lat, lon, signal }) {
  const windKey = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = getCachedValue(windCache, windKey, 12 * 60_000);
  if (cached) return cached;

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set(
    "current",
    "wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day,cloudcover",
  );
  url.searchParams.set("wind_speed_unit", "kmh");
  url.searchParams.set("timezone", "auto");

  const json = await fetchJson(url.toString(), { signal, timeoutMs: 15_000, retries: 2 });
  const current = json?.current;
  const windSpeedKmh = Number(current?.wind_speed_10m);
  const windDirDeg = Number(current?.wind_direction_10m);
  const windGustKmh = Number(current?.wind_gusts_10m);
  const cloudCoverPct = Number(current?.cloudcover);
  const isDay = current?.is_day === 1 || current?.is_day === true;
  const elevationM = Number(json?.elevation);
  if (!Number.isFinite(windSpeedKmh) || !Number.isFinite(windDirDeg)) {
    throw new Error("Weather data missing wind.");
  }
  return setCachedValue(windCache, windKey, {
    windSpeedKmh,
    windDirDeg: normalizeBearing(windDirDeg),
    windGustKmh: Number.isFinite(windGustKmh) ? windGustKmh : null,
    isDay,
    cloudCoverPct: Number.isFinite(cloudCoverPct) ? cloudCoverPct : null,
    elevationM: Number.isFinite(elevationM) ? elevationM : null,
    time: typeof current?.time === "string" ? current.time : null,
  });
}

async function fetchElevations(points, { signal }) {
  const out = new Array(points.length);
  const missing = [];
  const missingIndices = [];

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const key = `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
    const cached = elevationCache.get(key);
    if (Number.isFinite(cached)) {
      out[i] = cached;
      continue;
    }
    missing.push(p);
    missingIndices.push(i);
  }

  if (!missing.length) return out;

  const lats = missing.map((p) => p.lat.toFixed(5)).join(",");
  const lons = missing.map((p) => p.lon.toFixed(5)).join(",");
  const url = new URL("https://api.open-meteo.com/v1/elevation");
  url.searchParams.set("latitude", lats);
  url.searchParams.set("longitude", lons);

  try {
    const json = await fetchJson(url.toString(), { signal, timeoutMs: 12_000, retries: 2 });
    const elevation = json?.elevation;
    const arr = Array.isArray(elevation)
      ? elevation.map((x) => Number(x))
      : Number.isFinite(elevation)
        ? [Number(elevation)]
        : null;
    if (!arr || arr.length !== missing.length || arr.some((x) => !Number.isFinite(x))) {
      throw new Error("Elevation response mismatch.");
    }
    for (let i = 0; i < missing.length; i++) {
      const p = missing[i];
      const key = `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
      const value = arr[i];
      elevationCache.set(key, value);
      out[missingIndices[i]] = value;
    }
    return out;
  } catch (err) {
    // Fallback: fetch individually (some environments/proxies dislike comma-separated params).
    // Only fallback if not a rate limit error
    if (err?.status === 429) throw err;

    for (let i = 0; i < missing.length; i++) {
      const p = missing[i];
      const single = new URL("https://api.open-meteo.com/v1/elevation");
      single.searchParams.set("latitude", p.lat.toFixed(5));
      single.searchParams.set("longitude", p.lon.toFixed(5));
      const json = await fetchJson(single.toString(), { signal, timeoutMs: 10_000, retries: 2 });
      const elevation = Array.isArray(json?.elevation) ? json.elevation[0] : json?.elevation;
      const value = Number(elevation);
      if (!Number.isFinite(value)) throw new Error("Elevation data missing.");
      const key = `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
      elevationCache.set(key, value);
      out[missingIndices[i]] = value;
    }
    return out;
  }
}

async function estimateTerrainShelterAt({ lat, lon, windFromDeg, signal }) {
  if (!Number.isFinite(windFromDeg)) return { combinedIndex: 0, reduction: 0, baseElevationM: null };

  const directionBucket = Math.round(normalizeBearing(windFromDeg) / 10) * 10;
  const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)}|${directionBucket}`;
  const cached = getCachedValue(shelterCache, cacheKey, 45 * 60_000);
  if (cached) return cached;

  // Sample upwind terrain and convert the “blocking angle” into a shelter reduction.
  // This is a common engineering proxy: larger vertical angles (hill close + tall) imply stronger shelter.
  const distancesM = [400, 900, 1800, 3500, 6000, 8500];
  const rayOffsets = [0, -15, 15, -30, 30];

  const samples = [];
  for (const offset of rayOffsets) {
    for (const d of distancesM) {
      const bearing = normalizeBearing(windFromDeg + offset);
      samples.push({
        point: destinationPoint(lat, lon, bearing, d),
        distanceM: d,
        offsetDeg: offset,
      });
    }
  }

  const points = [{ lat, lon }, ...samples.map((s) => s.point)];
  const elevations = await fetchElevations(points, { signal });
  const baseElevationM = elevations[0];

  const maxAngleByOffset = new Map(rayOffsets.map((o) => [o, 0]));
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const elev = elevations[i + 1];
    const deltaH = elev - baseElevationM;
    if (!(deltaH > 8)) continue;
    const angle = Math.atan(deltaH / sample.distanceM);
    const prev = maxAngleByOffset.get(sample.offsetDeg) ?? 0;
    if (angle > prev) maxAngleByOffset.set(sample.offsetDeg, angle);
  }

  const angleScale = 0.08; // ~4.6°
  let combined = 0;
  for (const [offsetDeg, angleRad] of maxAngleByOffset.entries()) {
    if (!(angleRad > 0)) continue;
    const rayShelter = 1 - Math.exp(-angleRad / angleScale);
    const alignment = Math.cos(Math.abs(offsetDeg) * DEG2RAD);
    const s = clamp(rayShelter * alignment, 0, 1);
    combined = 1 - (1 - combined) * (1 - s);
  }

  const maxReduction = 0.7;
  const reduction = maxReduction * clamp(combined, 0, 1);
  return setCachedValue(shelterCache, cacheKey, {
    combinedIndex: combined,
    reduction,
    baseElevationM,
  });
}

function classifyWindLevel(feltWindKmh) {
  if (!Number.isFinite(feltWindKmh)) return "—";
  if (feltWindKmh < 10) return "Calm";
  if (feltWindKmh < 18) return "Light";
  if (feltWindKmh < 28) return "Moderate";
  if (feltWindKmh < 38) return "Breezy";
  if (feltWindKmh < 50) return "Windy";
  return "Very windy";
}

function windAtHeightKmh(windKmh, { fromHeightM = 10, toHeightM = 2, roughnessM = 0.03 } = {}) {
  if (!Number.isFinite(windKmh)) return null;
  if (!(fromHeightM > 0 && toHeightM > 0 && roughnessM > 0)) return windKmh;
  const num = Math.log(toHeightM / roughnessM);
  const den = Math.log(fromHeightM / roughnessM);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return windKmh;
  const ratio = num / den;
  return windKmh * ratio;
}

function toBeaufort(windKmh) {
  if (!Number.isFinite(windKmh) || windKmh < 0) return null;
  const v = windKmh / 3.6; // m/s
  const b = Math.pow(v / 0.836, 2 / 3);
  return clamp(b, 0, 12);
}

function sunbathingComfortFromWindMps(windMps) {
  // “Proven” baselines: Lawson/Davenport pedestrian wind comfort thresholds.
  // For lying/sitting at the beach, comfort drops sharply above ~4 m/s and is poor above ~8 m/s.
  if (!Number.isFinite(windMps) || windMps < 0) return 0.35;
  if (windMps <= 2) return 1;
  if (windMps <= 4) return lerp(1, 0.85, (windMps - 2) / 2);
  if (windMps <= 6) return lerp(0.85, 0.45, (windMps - 4) / 2);
  if (windMps <= 8) return lerp(0.45, 0.15, (windMps - 6) / 2);
  if (windMps <= 10) return lerp(0.15, 0, (windMps - 8) / 2);
  return 0;
}

function sunFactor(isDay, cloudCoverPct) {
  if (isDay === false) return 0.2;
  if (isDay === null || typeof isDay === "undefined") return 0.6;
  const cloud = Number.isFinite(cloudCoverPct) ? clamp(cloudCoverPct, 0, 100) : 50;
  // 0% clouds → 1, 50% → 0.7, 100% → 0.35
  const clearScore = 1 - cloud / 100;
  const scaled = 0.35 + clearScore * 0.65;
  return clamp(scaled, 0, 1);
}

function sunbathingComfortFromBeaufort(beaufort) {
  if (!Number.isFinite(beaufort)) return 0.35;
  // Tuned for “chill swim / sunbathe”: B~2-3 is ideal, B>=5 is usually not pleasant.
  const midpoint = 3.4;
  const slope = 0.7;
  return 1 / (1 + Math.exp((beaufort - midpoint) / slope));
}

function effectiveWindKmh({ windKmh, gustKmh }) {
  if (!Number.isFinite(windKmh)) return null;
  if (!Number.isFinite(gustKmh) || gustKmh <= windKmh) return windKmh;
  const gustWeight = 0.35;
  return windKmh + (gustKmh - windKmh) * gustWeight;
}

function computeScoreNow({ feltWindKmh, distanceKm, radiusKm }) {
  const windMps = Number.isFinite(feltWindKmh) ? feltWindKmh / 3.6 : null;
  const comfortWind = sunbathingComfortFromWindMps(windMps);
  const comfortSun = sunFactor(state.windAtSearch?.isDay, state.windAtSearch?.cloudCoverPct);
  const combinedComfort = clamp(comfortWind * 0.7 + comfortSun * 0.3, 0, 1);
  const distancePenalty = clamp((distanceKm ?? Infinity) / radiusKm, 0, 1) * 12;
  return clamp(combinedComfort * 100 - distancePenalty, 0, 100);
}

async function analyzeBeach(beach, { radiusKm, signal, fallbackWind }) {
  let shorelineAxisDeg = computeShorelineAxisDeg(beach.geometry);
  let windData = null;
  try {
    windData = await fetchWindAt({ lat: beach.lat, lon: beach.lon, signal });
  } catch (err) {
    if (fallbackWind) {
      windData = fallbackWind;
    } else if (state.lastSearch) {
      windData = await fetchWindAt({ lat: state.lastSearch.lat, lon: state.lastSearch.lon, signal });
    } else {
      throw err;
    }
  }

  let shorelineFromElevation = null;
  if (!Number.isFinite(shorelineAxisDeg)) {
    try {
      shorelineFromElevation = await estimateShorelineAxisFromElevation({
        lat: beach.lat,
        lon: beach.lon,
        signal,
      });
      if (Number.isFinite(shorelineFromElevation?.shorelineAxisDeg)) {
        shorelineAxisDeg = shorelineFromElevation.shorelineAxisDeg;
      }
    } catch {
      // Optional only.
      shorelineFromElevation = null;
    }
  }

  const exposure = crossShoreFactor(windData.windDirDeg, shorelineAxisDeg);

  let shelterReduction = 0;
  if (windData.windSpeedKmh >= 10) {
    const shelter = await estimateTerrainShelterAt({
      lat: beach.lat,
      lon: beach.lon,
      windFromDeg: windData.windDirDeg,
      signal,
    });
    shelterReduction = shelter.reduction;
  }

  // Convert 10m model wind to ~2m human-height wind via neutral log-law.
  const wind2m = windAtHeightKmh(windData.windSpeedKmh);
  const gust2m = windAtHeightKmh(windData.windGustKmh ?? null);

  const eff2m = effectiveWindKmh({ windKmh: wind2m, gustKmh: gust2m });
  const sheltered2m = Number.isFinite(eff2m) ? eff2m * (1 - shelterReduction) : null;

  // Cross-shore winds tend to feel harsher on the sand.
  const exposureFactor = 0.65 + 0.35 * exposure;
  const feltWindKmh = Number.isFinite(sheltered2m) ? sheltered2m * exposureFactor : null;

  const score = computeScoreNow({ feltWindKmh, distanceKm: beach.distanceKm, radiusKm });

  return {
    ...beach,
    analysis: {
      windSpeedKmh: windData.windSpeedKmh,
      windGustKmh: windData.windGustKmh,
      windDirDeg: windData.windDirDeg,
      time: windData.time,
      shorelineAxisDeg,
      seaBearingDeg: shorelineFromElevation?.seaBearingDeg ?? null,
      crossShore: exposure,
      shelterReduction,
      shelterReductionPct: shelterReduction * 100,
      wind2mKmh: wind2m,
      effectiveWind2mKmh: eff2m,
      shelteredWind2mKmh: sheltered2m,
      feltWindKmh,
      windLevel: classifyWindLevel(feltWindKmh),
      score,
    },
  };
}

async function mapWithConcurrency(items, concurrency, fn) {
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

function overpassQuery({ lat, lon, radiusMeters }) {
  return `
[out:json][timeout:25];
(
  nwr["natural"="beach"](around:${Math.round(radiusMeters)},${lat},${lon});
  nwr["tourism"="beach"](around:${Math.round(radiusMeters)},${lat},${lon});
  nwr["leisure"="beach_resort"](around:${Math.round(radiusMeters)},${lat},${lon});

  nwr["natural"="bay"](around:${Math.round(radiusMeters)},${lat},${lon});
  nwr["natural"="cove"](around:${Math.round(radiusMeters)},${lat},${lon});

  nwr["place"="locality"]["locality"="beach"](around:${Math.round(radiusMeters)},${lat},${lon});
  nwr["place"="locality"]["name"~"(beach|bay|cove|bight|plage|praia|playa)",i](around:${Math.round(radiusMeters)},${lat},${lon});
);
out center 800;
  `.trim();
}

function parseOverpassElements(elements) {
  const byId = new Map();
  for (const el of elements || []) {
    const id = `${el.type}/${el.id}`;
    const tags = el.tags || {};
    const name =
      tags.name ||
      tags["name:en"] ||
      tags["name:local"] ||
      tags.loc_name ||
      tags.short_name ||
      tags.official_name ||
      tags.alt_name ||
      null;

    const kind =
      tags.natural === "beach" || tags.tourism === "beach"
        ? "beach"
        : tags.natural === "bay"
          ? "bay"
          : tags.natural === "cove"
            ? "cove"
            : tags.place === "locality"
              ? "spot"
              : "spot";

    let lat = null;
    let lon = null;

    if (el.type === "node" && Number.isFinite(el.lat) && Number.isFinite(el.lon)) {
      lat = el.lat;
      lon = el.lon;
    } else if (el.center && Number.isFinite(el.center.lat) && Number.isFinite(el.center.lon)) {
      lat = el.center.lat;
      lon = el.center.lon;
    }

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const geometry =
      Array.isArray(el.geometry) && el.geometry.length >= 2
        ? el.geometry
            .map((p) => ({ lat: Number(p.lat), lon: Number(p.lon) }))
            .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
        : null;

    const existing = byId.get(id);
    const candidate = { id, name, kind, lat, lon, tags, geometry };

    if (!existing) {
      byId.set(id, candidate);
      continue;
    }
    if (!existing.name && candidate.name) {
      byId.set(id, candidate);
      continue;
    }
  }
  return Array.from(byId.values());
}

async function fetchBeachesNear({ lat, lon, radiusKm, signal }) {
  const radiusMeters = radiusKm * 1000;
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];
  const query = overpassQuery({ lat, lon, radiusMeters });

  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const body = new URLSearchParams({ data: query }).toString();
      let json = null;
      try {
        json = await fetchJson(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            Accept: "application/json",
          },
          body,
          signal,
          timeoutMs: 20_000,
          retries: 1,
        });
      } catch (err) {
        const url = new URL(endpoint);
        url.searchParams.set("data", query);
        json = await fetchJson(url.toString(), { signal, timeoutMs: 20_000, retries: 1 });
      }
      const parsed = parseOverpassElements(json.elements);
      return parsed;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("Overpass request failed.");
}

function isAbortError(err) {
  return err instanceof DOMException && err.name === "AbortError";
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function friendlySearchFailure(err) {
  const msg = errorMessage(err);
  if (/can't find that place/i.test(msg)) {
    return { line: "Hmm, can’t find that place.", detail: "Try a suburb, city, or landmark.", placeholder: "Try another place." };
  }
  if (/timed out/i.test(msg)) {
    return { line: "That took too long.", detail: "Try again in a moment.", placeholder: "Try again." };
  }
  if (/request failed \\(4\\d\\d\\)/i.test(msg) || /request failed \\(5\\d\\d\\)/i.test(msg)) {
    return { line: "Map services are having a moment.", detail: "Try again in a bit.", placeholder: "Try again soon." };
  }
  return { line: "Something went wrong.", detail: "Try again in a moment.", placeholder: "Try again." };
}

function friendlyGpsFailure(err) {
  const msg = errorMessage(err);
  if (/denied|permission/i.test(msg)) {
    return { line: "GPS is blocked.", detail: "Enable location, or search by place name.", placeholder: "Try searching instead." };
  }
  if (/timed out/i.test(msg)) {
    return { line: "GPS took too long.", detail: "Try again, or search by place.", placeholder: "Try searching instead." };
  }
  return { line: "Couldn’t use GPS.", detail: "Try searching by place name.", placeholder: "Try searching instead." };
}

async function geocodePlace(query, { signal }) {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "1");
  url.searchParams.set("lang", "en");

  const bias = state.lastSearch || loadSavedLocation();
  if (bias && Number.isFinite(bias.lat) && Number.isFinite(bias.lon)) {
    url.searchParams.set("lat", String(bias.lat));
    url.searchParams.set("lon", String(bias.lon));
  }

  const json = await fetchJson(url.toString(), { signal, timeoutMs: 15_000, retries: 2 });
  const feature = json?.features?.[0];
  if (!feature) throw new Error("Hmm, can't find that place.");

  const lat = Number(feature?.geometry?.coordinates?.[1]);
  const lon = Number(feature?.geometry?.coordinates?.[0]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("Bad location result.");

  const name = typeof feature?.properties?.name === "string" ? feature.properties.name : query;
  return { lat, lon, name };
}

function startNewSearch() {
  if (state.inFlight) state.inFlight.abort();
  state.inFlight = new AbortController();
  return state.inFlight;
}

async function runSearchAt({ lat, lon, label }) {
  const controller = state.inFlight;
  if (!controller) throw new Error("No active search.");
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("Bad coordinates.");

  const radiusKm = Number(ui.radiusKm?.value) || 25;
  const maxCandidates = 200;
  const initialDisplay = 24;

  saveLocation(lat, lon);
  state.lastSearch = { lat, lon, radiusKm, label };

  setStatus(`Scanning coast near ${label}...`);
  const beaches = await fetchBeachesNear({ lat, lon, radiusKm, signal: controller.signal });
  if (!beaches.length) {
    state.beaches = [];
    state.analyzedCount = 0;
    state.windAtSearch = null;
    state.displayCount = 0;
    if (ui.analyzeMore) ui.analyzeMore.hidden = true;
    if (ui.topPick) {
      ui.topPick.hidden = true;
      ui.topPick.replaceChildren();
    }
    renderPlaceholder("No beaches found nearby.");
    setStatus("No beaches found nearby.");
    return;
  }

  const origin = { lat, lon };
  const byDistance = beaches
    .map((b) => ({ ...b, distanceKm: haversineKm(origin, b) }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, maxCandidates);

  let secretIndex = 0;
  const withNames = byDistance.map((b) => {
    if (b.name) return b;
    secretIndex += 1;
    const label =
      b.kind === "bay"
        ? "Secret Bay"
        : b.kind === "cove"
          ? "Secret Cove"
          : b.kind === "beach"
            ? "Secret Beach"
            : "Secret Spot";
    return { ...b, name: `${label} ${secretIndex}` };
  });

  state.beaches = withNames;
  state.analyzedCount = 0;
  state.windAtSearch = null;
  state.displayCount = Math.min(initialDisplay, byDistance.length);

  renderCurrent();
  setStatus(
    `Found beaches near ${label}.`,
    byDistance.length <= 2 ? "Not seeing enough? Try “Explore”." : "Checking conditions for the first few…",
  );
}

async function analyzeNextBatch({ batchSize = 8 } = {}) {
  const search = state.lastSearch;
  if (!search) return;
  const remaining = state.beaches.slice(state.analyzedCount);
  if (!remaining.length) return;

  const batch = remaining.slice(0, Math.max(1, batchSize));

  setStatus(
    "Checking today's conditions…",
    "This can take a moment…",
  );

  const controller = state.inFlight;
  const analyzed = await mapWithConcurrency(batch, 2, async (beach) => {
    if (controller?.signal?.aborted) throw controller.signal.reason;
    setStatus("Checking today's conditions…", beach.name);
    try {
      return await analyzeBeach(beach, {
        radiusKm: search.radiusKm,
        signal: controller?.signal,
        fallbackWind: state.windAtSearch,
      });
    } catch (err) {
      // Check if it's a rate limit error
      const isRateLimit = err?.status === 429 || (err instanceof Error && /rate limit|too many requests/i.test(err.message));
      const errorMsg = isRateLimit
        ? "Rate limited - try again in a moment"
        : (err instanceof Error ? err.message : String(err));

      return {
        ...beach,
        analysis: { error: errorMsg },
      };
    }
  });

  // Merge analyzed back into state.
  const analyzedById = new Map(analyzed.map((b) => [b.id, b]));
  state.beaches = state.beaches.map((b) => analyzedById.get(b.id) ?? b);
  state.analyzedCount += batch.length;

  renderCurrent();

  setStatus(
    "Updated picks.",
    state.displayCount < state.beaches.length ? "Want more options? Tap "Show more beaches"." : "",
  );
}

async function ensureAnalysisUpTo(targetCount) {
  const controller = state.inFlight;
  if (!controller) return;
  if (controller.signal.aborted) return;
  if (state.analysisRunning) return;

  state.analysisRunning = true;
  try {
    if (!state.windAtSearch && state.lastSearch) {
      try {
        state.windAtSearch = await fetchWindAt({
          lat: state.lastSearch.lat,
          lon: state.lastSearch.lon,
          signal: controller.signal,
        });
      } catch (err) {
        // Optional fallback only; per-beach wind will still be attempted.
        state.windAtSearch = null;
      }
    }

    const capped = Math.max(0, Math.min(targetCount, state.beaches.length));
    while (!controller.signal.aborted && state.analyzedCount < capped) {
      await analyzeNextBatch({ batchSize: Math.min(8, capped - state.analyzedCount) });
    }
  } finally {
    state.analysisRunning = false;
  }
}

ui.analyzeMore.addEventListener("click", async () => {
  if (!state.lastSearch) return;
  if (state.inFlight?.signal?.aborted) return;
  const increment = 24;
  state.displayCount = Math.min(state.beaches.length, state.displayCount + increment);
  renderCurrent();

  const extra = 12;
  const target = Math.min(state.beaches.length, state.analyzedCount + extra);
  ensureAnalysisUpTo(target).catch((err) => {
    console.error("Analysis error:", err);
    const isRateLimit = err?.status === 429 || (err instanceof Error && /rate limit|too many requests/i.test(err.message));
    if (isRateLimit) {
      setStatus("Hit API rate limits.", "Wait a minute and try again.");
    } else {
      setStatus("Something went wrong.", "Try again in a moment.");
    }
  });
});

ui.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const query = ui.cityInput?.value?.trim() ?? "";
  if (!query) {
    setStatus("Type a place name first.");
    return;
  }

  const controller = startNewSearch();
  ui.analyzeMore.hidden = true;
  setLoading(true, { clearResults: true });
  setStatus("Looking at the map...");
  try {
    const geo = await geocodePlace(query, { signal: controller.signal });
    await runSearchAt({ lat: geo.lat, lon: geo.lon, label: geo.name });
    ensureAnalysisUpTo(Math.min(state.beaches.length, 18)).catch((err) => {
      console.error("Analysis error:", err);
      const isRateLimit = err?.status === 429 || (err instanceof Error && /rate limit|too many requests/i.test(err.message));
      if (isRateLimit) {
        setStatus("Hit API rate limits.", "Some beaches couldn't be checked. Wait a minute and try again.");
      }
    });
  } catch (err) {
    if (isAbortError(err)) {
      setStatus("Canceled.");
      return;
    }
    console.error(err);
    const friendly = friendlySearchFailure(err);
    setStatus(friendly.line, friendly.detail);
    renderPlaceholder(friendly.placeholder);
  } finally {
    setLoading(false);
  }
});

registerServiceWorker();
wireAboutModal();

ui.gpsBtn.addEventListener("click", async () => {
  const controller = startNewSearch();
  ui.analyzeMore.hidden = true;
  setLoading(true, { clearResults: true });
  setStatus("Checking GPS...");
  try {
    const loc = await getBrowserLocation();
    await runSearchAt({ lat: loc.lat, lon: loc.lon, label: "your spot" });
    ensureAnalysisUpTo(Math.min(state.beaches.length, 18)).catch((err) => {
      console.error("Analysis error:", err);
      const isRateLimit = err?.status === 429 || (err instanceof Error && /rate limit|too many requests/i.test(err.message));
      if (isRateLimit) {
        setStatus("Hit API rate limits.", "Some beaches couldn't be checked. Wait a minute and try again.");
      }
    });
  } catch (err) {
    if (isAbortError(err)) {
      setStatus("Canceled.");
      return;
    }
    console.error(err);
    const friendly = friendlyGpsFailure(err);
    setStatus(friendly.line, friendly.detail);
    renderPlaceholder(friendly.placeholder);
  } finally {
    setLoading(false);
  }
});

loadSavedLocation();
setStatus("Enter a place to begin.", "Tip: search a city, or tap “Find Near Me”.");
renderPlaceholder("No results yet.");
