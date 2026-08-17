// Provider-Schicht — Port von Sprint-1 providers/*.py nach JS, PLUS Sprint-2-Erweiterungen:
// Windhistorie 6/12/24/48h (Abschnitt 15), Trendfelder (Abschnitt 16), Open-Meteo Flood API fuer
// Trave-Abfluss (Abschnitt 19, siehe docs/BINNENGEWAESSER_RESEARCH.md).
//
// WICHTIG (Abschnitt 17, "Provider-Problem aus Sprint 1 loesen", Option A gewaehlt): dieser Code
// laeuft NICHT mehr in der Cowork-Sandbox (die hatte keinen Internetzugang aus Python/Bash),
// sondern im Browser des Nutzer-Handys — dort ist `fetch()` normaler Netzwerkzugriff mit echtem
// Internet. Dieselben produktionskorrekten Endpunkte wie in Sprint 1, jetzt im richtigen
// Ausfuehrungskontext. Schlaegt ein Aufruf trotzdem fehl (kein Empfang, Anbieter down), bleibt
// das Verhalten aus Sprint 1 erhalten: echter Fehler, kein Fake-Wert, Snapshot wird trotzdem
// gespeichert (siehe enrichment.js).

const OM_ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const OM_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const OM_MARINE_URL = "https://marine-api.open-meteo.com/v1/marine";
const OM_FLOOD_URL = "https://flood-api.open-meteo.com/v1/flood";
const PEGEL_BASE = "https://www.pegelonline.wsv.de/webservices/rest-api/v2";

function bft(kmh) {
  const thresholds = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
  for (let i = 0; i < thresholds.length; i++) if (kmh < thresholds[i]) return i;
  return 12;
}

async function fetchJson(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}`, url };
    const data = await resp.json();
    return { ok: true, data, url };
  } catch (e) {
    return { ok: false, error: `${e.name}: ${e.message}`, url };
  } finally {
    clearTimeout(t);
  }
}

function nearestIndex(times, targetMs) {
  let bestI = 0, bestDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const diff = Math.abs(times[i] - targetMs);
    if (diff < bestDiff) { bestDiff = diff; bestI = i; }
  }
  return bestI;
}

function circularMeanDeg(degs) {
  let sinSum = 0, cosSum = 0;
  for (const d of degs) { sinSum += Math.sin((d * Math.PI) / 180); cosSum += Math.cos((d * Math.PI) / 180); }
  return ((Math.atan2(sinSum, cosSum) * 180) / Math.PI + 360) % 360;
}

function circularDiffDeg(a, b) {
  let diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

const HOURLY_FIELDS = ["temperature_2m", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m",
  "precipitation", "cloud_cover", "pressure_msl"];

class OpenMeteoProvider {
  constructor() { this.name = "open_meteo"; }

  _urlFor(dt) {
    const isHistorical = (Date.now() - dt.getTime()) / 86400000 > 5;
    return isHistorical ? OM_ARCHIVE_URL : OM_FORECAST_URL;
  }

  async getHourly(lat, lon, dt) {
    const url = this._urlFor(dt);
    const dateStr = dt.toISOString().slice(0, 10);
    const qs = `latitude=${lat}&longitude=${lon}&hourly=${HOURLY_FIELDS.join(",")}` +
      `&start_date=${dateStr}&end_date=${dateStr}&timezone=UTC`;
    const res = await fetchJson(`${url}?${qs}`);
    const fields = ["air_temp_c", "wind_speed_bft", "wind_dir_deg", "wind_gust_bft",
      "precipitation_mm", "cloud_cover_pct", "pressure_hpa"];
    if (!res.ok) {
      const out = {};
      for (const f of fields) out[f] = { ok: false, error: res.error, station_or_gridpoint: url };
      return out;
    }
    try {
      const times = res.data.hourly.time.map((t) => Date.parse(t + "Z"));
      const idx = nearestIndex(times, dt.getTime());
      const gp = `open-meteo Gitterpunkt lat=${lat},lon=${lon}`;
      const at = res.data.hourly.time[idx];
      return {
        air_temp_c: { ok: true, value: res.data.hourly.temperature_2m[idx], unit: "°C", station_or_gridpoint: gp, measured_at: at, origin: "modeled", quality: "mittel" },
        wind_speed_bft: { ok: true, value: bft(res.data.hourly.wind_speed_10m[idx]), unit: "Bft", station_or_gridpoint: gp, measured_at: at, origin: "modeled", quality: "mittel" },
        wind_dir_deg: { ok: true, value: res.data.hourly.wind_direction_10m[idx], unit: "deg", station_or_gridpoint: gp, measured_at: at, origin: "modeled", quality: "mittel" },
        wind_gust_bft: { ok: true, value: bft(res.data.hourly.wind_gusts_10m[idx]), unit: "Bft", station_or_gridpoint: gp, measured_at: at, origin: "modeled", quality: "mittel" },
        precipitation_mm: { ok: true, value: res.data.hourly.precipitation[idx], unit: "mm", station_or_gridpoint: gp, measured_at: at, origin: "modeled", quality: "mittel" },
        cloud_cover_pct: { ok: true, value: res.data.hourly.cloud_cover[idx], unit: "%", station_or_gridpoint: gp, measured_at: at, origin: "modeled", quality: "mittel" },
        pressure_hpa: { ok: true, value: res.data.hourly.pressure_msl[idx], unit: "hPa", station_or_gridpoint: gp, measured_at: at, origin: "modeled", quality: "mittel" },
      };
    } catch (e) {
      const out = {};
      for (const f of fields) out[f] = { ok: false, error: `Parse-Fehler: ${e.message}` };
      return out;
    }
  }

  // Windhistorie (Abschnitt 15): mittlere Richtung/Staerke ueber `hours` vor endDt, VEKTORIELL
  // gemittelt (nicht arithmetisch — 350°/10° sonst faelschlich 180° Mittel).
  async getWindowMean(lat, lon, endDt, hours) {
    const startDt = new Date(endDt.getTime() - hours * 3600000);
    const url = this._urlFor(endDt);
    const qs = `latitude=${lat}&longitude=${lon}&hourly=wind_speed_10m,wind_direction_10m` +
      `&start_date=${startDt.toISOString().slice(0, 10)}&end_date=${endDt.toISOString().slice(0, 10)}&timezone=UTC`;
    const res = await fetchJson(`${url}?${qs}`);
    if (!res.ok) return { wind_speed_mean: { ok: false, error: res.error }, wind_dir_mean: { ok: false, error: res.error } };
    try {
      const times = res.data.hourly.time.map((t) => Date.parse(t + "Z"));
      const speeds = res.data.hourly.wind_speed_10m, dirs = res.data.hourly.wind_direction_10m;
      const sel = [];
      for (let i = 0; i < times.length; i++) if (times[i] >= startDt.getTime() && times[i] <= endDt.getTime()) sel.push(i);
      const gp = `open-meteo Gitterpunkt lat=${lat},lon=${lon}, Fenster ${hours}h`;
      if (!sel.length) return { wind_speed_mean: { ok: false, error: "keine Werte im Fenster" }, wind_dir_mean: { ok: false, error: "keine Werte im Fenster" } };
      const meanSpeed = sel.reduce((s, i) => s + speeds[i], 0) / sel.length;
      const meanDir = circularMeanDeg(sel.map((i) => dirs[i]));
      return {
        wind_speed_mean: { ok: true, value: bft(meanSpeed), unit: "Bft", station_or_gridpoint: gp, measured_at: endDt.toISOString(), origin: "modeled", quality: "mittel" },
        wind_dir_mean: { ok: true, value: Math.round(meanDir), unit: "deg", station_or_gridpoint: gp, measured_at: endDt.toISOString(), origin: "modeled", quality: "mittel" },
        _series: { times: sel.map((i) => times[i]), dirs: sel.map((i) => dirs[i]), speeds: sel.map((i) => speeds[i]) },
      };
    } catch (e) {
      return { wind_speed_mean: { ok: false, error: `Parse-Fehler: ${e.message}` }, wind_dir_mean: { ok: false, error: `Parse-Fehler: ${e.message}` } };
    }
  }

  // Windwechsel-Erkennung (Abschnitt 15): groesster Sprung der Stundenrichtung innerhalb 48h.
  async getWindShift(lat, lon, endDt, hours = 48, thresholdDeg = 45) {
    const wm = await this.getWindowMean(lat, lon, endDt, hours);
    if (!wm._series || wm._series.dirs.length < 2) {
      return { ok: false, error: "zu wenig Datenpunkte fuer Windwechsel-Erkennung" };
    }
    const { times, dirs } = wm._series;
    let maxJump = 0, maxIdx = -1;
    for (let i = 1; i < dirs.length; i++) {
      const diff = circularDiffDeg(dirs[i], dirs[i - 1]);
      if (diff > maxJump) { maxJump = diff; maxIdx = i; }
    }
    if (maxIdx === -1 || maxJump < thresholdDeg) {
      return { ok: true, value: false, unit: "bool", origin: "modeled", quality: "mittel",
        extra: { max_jump_deg: Math.round(maxJump) } };
    }
    return { ok: true, value: true, unit: "bool", measured_at: new Date(times[maxIdx]).toISOString(),
      origin: "modeled", quality: "mittel", extra: { max_jump_deg: Math.round(maxJump) } };
  }

  // Trendfelder Luftdruck (Abschnitt 16): Delta zum aktuellen Wert fuer mehrere Fenster.
  async getPressureTrend(lat, lon, endDt, hoursBackList = [3, 6, 12]) {
    const maxH = Math.max(...hoursBackList);
    const startDt = new Date(endDt.getTime() - maxH * 3600000);
    const url = this._urlFor(endDt);
    const qs = `latitude=${lat}&longitude=${lon}&hourly=pressure_msl` +
      `&start_date=${startDt.toISOString().slice(0, 10)}&end_date=${endDt.toISOString().slice(0, 10)}&timezone=UTC`;
    const res = await fetchJson(`${url}?${qs}`);
    const out = {};
    if (!res.ok) { for (const h of hoursBackList) out[h] = { ok: false, error: res.error }; return out; }
    try {
      const times = res.data.hourly.time.map((t) => Date.parse(t + "Z"));
      const vals = res.data.hourly.pressure_msl;
      const curIdx = nearestIndex(times, endDt.getTime());
      const curVal = vals[curIdx];
      for (const h of hoursBackList) {
        const idx = nearestIndex(times, endDt.getTime() - h * 3600000);
        out[h] = { ok: true, value: Math.round((curVal - vals[idx]) * 10) / 10, unit: "hPa",
          origin: "modeled", quality: "mittel", measured_at: endDt.toISOString() };
      }
    } catch (e) {
      for (const h of hoursBackList) out[h] = { ok: false, error: `Parse-Fehler: ${e.message}` };
    }
    return out;
  }
}

class OpenMeteoMarineProvider {
  constructor() { this.name = "open_meteo_marine"; }

  async getWaterTemp(lat, lon, dt) {
    const dateStr = dt.toISOString().slice(0, 10);
    const qs = `latitude=${lat}&longitude=${lon}&hourly=sea_surface_temperature&start_date=${dateStr}&end_date=${dateStr}&timezone=UTC`;
    const res = await fetchJson(`${OM_MARINE_URL}?${qs}`);
    if (!res.ok) return { ok: false, error: res.error, station_or_gridpoint: `${OM_MARINE_URL}?${qs}` };
    try {
      const times = res.data.hourly.time.map((t) => Date.parse(t + "Z"));
      const idx = nearestIndex(times, dt.getTime());
      return { ok: true, value: res.data.hourly.sea_surface_temperature[idx], unit: "°C",
        station_or_gridpoint: `open-meteo-marine Gitterpunkt lat=${lat},lon=${lon}`,
        measured_at: res.data.hourly.time[idx], origin: "modeled", quality: "mittel" };
    } catch (e) {
      return { ok: false, error: `Parse-Fehler: ${e.message}` };
    }
  }

  // Trend (Abschnitt 16): Delta zu 24/48/72h zuvor.
  async getWaterTempTrend(lat, lon, endDt, hoursBackList = [24, 48, 72]) {
    const maxH = Math.max(...hoursBackList);
    const startDt = new Date(endDt.getTime() - maxH * 3600000);
    const qs = `latitude=${lat}&longitude=${lon}&hourly=sea_surface_temperature` +
      `&start_date=${startDt.toISOString().slice(0, 10)}&end_date=${endDt.toISOString().slice(0, 10)}&timezone=UTC`;
    const res = await fetchJson(`${OM_MARINE_URL}?${qs}`);
    const out = {};
    if (!res.ok) { for (const h of hoursBackList) out[h] = { ok: false, error: res.error }; return out; }
    try {
      const times = res.data.hourly.time.map((t) => Date.parse(t + "Z"));
      const vals = res.data.hourly.sea_surface_temperature;
      const curIdx = nearestIndex(times, endDt.getTime());
      for (const h of hoursBackList) {
        const idx = nearestIndex(times, endDt.getTime() - h * 3600000);
        out[h] = { ok: true, value: Math.round((vals[curIdx] - vals[idx]) * 10) / 10, unit: "°C", origin: "modeled", quality: "mittel" };
      }
    } catch (e) {
      for (const h of hoursBackList) out[h] = { ok: false, error: `Parse-Fehler: ${e.message}` };
    }
    return out;
  }
}

// Kein automatisierter Wassertemperatur-Provider fuer Binnengewaesser (Trave, Hemmelsdorfer See,
// Stockssee) — recherchiert und begruendet dokumentiert, siehe docs/BINNENGEWAESSER_RESEARCH.md.
// Bewusst NICHT die diversen kommerziellen Aggregator-Seiten genutzt (Methodik nicht
// nachvollziehbar) — "nicht irgendeine Temperaturquelle verwenden, nur damit das Feld gefuellt ist".
class NoWaterTempProvider {
  constructor() { this.name = "kein_wassertemperatur_provider_fuer_binnengewaesser"; }
  async getWaterTemp() {
    return { ok: false, error: "Kein belastbarer automatisierter Wassertemperatur-Provider fuer " +
      "dieses Gewaesser gefunden (siehe docs/BINNENGEWAESSER_RESEARCH.md — Pegelonline fuehrt an " +
      "der Trave keine WT-Zeitreihe, SH-Badegewaesserportal liefert keine API/keine Ganzjahresdaten " +
      "fuer Hemmelsdorfer See/Stockssee). Bewusst NICHT durch eine unklare Drittquelle ersetzt." };
  }
  async getWaterTempTrend() { return {}; }
}

// Pegelstand (WSV Pegelonline). Zwei Trave-Stationen recherchiert (Abschnitt 19, Sprint-2-Fund):
// Travemuende (Muendungsbereich) und Luebeck-Bauhof (naeher an Herrenwyk/Stadtgebiet).
const PEGEL_STATIONS = {
  trave_travemuende: "c7383149-1f77-430d-8bef-c5667be3846b",
  trave_luebeck_bauhof: "f4f9f7fb-eeff-46dc-9727-04d8aa56240a",
};

class PegelonlineProvider {
  constructor() { this.name = "pegelonline_wsv"; }

  async _fetchMeasurements(stationUuid, windowIso = "P2D") {
    const url = `${PEGEL_BASE}/stations/${stationUuid}/W/measurements.json?start=${windowIso}`;
    return fetchJson(url);
  }

  async getLevel(stationId, dt) {
    const uuid = PEGEL_STATIONS[stationId];
    if (!uuid) return { ok: false, error: `Keine Pegel-Station fuer '${stationId}' bekannt (z.B. stehendes Gewaesser ohne WSV-Pegel)` };
    const res = await this._fetchMeasurements(uuid);
    if (!res.ok) return { ok: false, error: res.error, station_or_gridpoint: stationId };
    try {
      let best = null, bestDiff = Infinity;
      for (const m of res.data) {
        const diff = Math.abs(Date.parse(m.timestamp) - dt.getTime());
        if (diff < bestDiff) { bestDiff = diff; best = m; }
      }
      return { ok: true, value: parseFloat(best.value), unit: "cm", station_or_gridpoint: `Pegel ${stationId}`,
        measured_at: best.timestamp, origin: "measured", quality: "hoch" };
    } catch (e) {
      return { ok: false, error: `Parse-Fehler: ${e.message}` };
    }
  }

  // Trend (Abschnitt 16): Delta zu 6/12/24h zuvor, aus derselben 2-Tage-Zeitreihe berechnet
  // (kein zusaetzlicher API-Aufruf noetig).
  async getTrendMultiWindow(stationId, dt, hoursBackList = [6, 12, 24]) {
    const uuid = PEGEL_STATIONS[stationId];
    const out = {};
    if (!uuid) { for (const h of hoursBackList) out[h] = { ok: false, error: `Keine Pegel-Station fuer '${stationId}'` }; return out; }
    const res = await this._fetchMeasurements(uuid);
    if (!res.ok) { for (const h of hoursBackList) out[h] = { ok: false, error: res.error }; return out; }
    try {
      const series = res.data.map((m) => ({ t: Date.parse(m.timestamp), v: parseFloat(m.value) }));
      const nearest = (targetMs) => series.reduce((best, p) => Math.abs(p.t - targetMs) < Math.abs(best.t - targetMs) ? p : best, series[0]);
      const cur = nearest(dt.getTime());
      for (const h of hoursBackList) {
        const past = nearest(dt.getTime() - h * 3600000);
        const delta = cur.v - past.v;
        out[h] = { ok: true, value: Math.round(delta * 10) / 10, unit: "cm",
          origin: "measured", quality: "mittel", measured_at: new Date(cur.t).toISOString(),
          extra: { trend_label: delta > 1 ? "steigend" : delta < -1 ? "fallend" : "stabil" } };
      }
    } catch (e) {
      for (const h of hoursBackList) out[h] = { ok: false, error: `Parse-Fehler: ${e.message}` };
    }
    return out;
  }
}

// NEU in Sprint 2 (Abschnitt 19): Open-Meteo Flood API (GloFAS) — Abfluss fuer die Trave.
// Modellwert (kein Messwert), 5km-Raster, taeglich, kostenlos, kein Key. Siehe
// docs/BINNENGEWAESSER_RESEARCH.md fuer die Recherche/Bewertung.
class OpenMeteoFloodProvider {
  constructor() { this.name = "open_meteo_flood_glofas"; }

  async getDischarge(lat, lon, dt) {
    const dateStr = dt.toISOString().slice(0, 10);
    const qs = `latitude=${lat}&longitude=${lon}&daily=river_discharge&start_date=${dateStr}&end_date=${dateStr}`;
    const res = await fetchJson(`${OM_FLOOD_URL}?${qs}`);
    if (!res.ok) return { ok: false, error: res.error, station_or_gridpoint: `${OM_FLOOD_URL}?${qs}` };
    try {
      const val = res.data.daily.river_discharge[0];
      return { ok: val !== null && val !== undefined, value: val, unit: "m³/s",
        station_or_gridpoint: `GloFAS-Raster lat=${lat},lon=${lon}`, measured_at: res.data.daily.time[0],
        origin: "modeled", quality: "niedrig",
        error: (val === null || val === undefined) ? "Kein Abfluss-Modellwert fuer diesen Gitterpunkt/Tag" : null };
    } catch (e) {
      return { ok: false, error: `Parse-Fehler: ${e.message}` };
    }
  }
}

window.FIProviders = {
  OpenMeteoProvider, OpenMeteoMarineProvider, NoWaterTempProvider, PegelonlineProvider,
  OpenMeteoFloodProvider, PEGEL_STATIONS, bft,
};
