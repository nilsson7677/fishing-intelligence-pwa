// Environmental-Enrichment-Orchestrator — Port + Erweiterung von Sprint-1 enrichment.py.
// 7-Schritt-Pipeline unveraendert (Ort -> Zeitfenster -> Quellen -> Abrufen -> Qualitaet pruefen
// -> speichern -> Fehler dokumentieren). NEU in Sprint 2: Windhistorie 6/12/24/48h + Windwechsel
// (Abschnitt 15), Trendfelder Wassertemp/Pegel/Druck (Abschnitt 16), Retry-Queue in IndexedDB
// (Abschnitt 35), Discharge fuer Trave.
//
// Kernprinzip unveraendert (Abschnitt 19/34): ein nicht erreichbarer Provider fuehrt NIE zu
// Datenverlust an der eigentlichen Fangmeldung — der Snapshot wird IMMER gespeichert, auch bei
// status=FAILED, und landet dann in enrichment_queue fuer spaeteren Retry.

const DAYPART_HOUR_WINDOW = {
  dawn: [4, 7], morning: [7, 11], midday: [11, 14], afternoon: [14, 18],
  evening: [18, 21], dusk: [19, 22], night: [22, 4], unknown: [0, 24],
};

function targetDatetime(targetDateIso, dayPart, timePrecision, startTime) {
  const [y, m, d] = targetDateIso.split("-").map(Number);
  if (timePrecision === "exact" && startTime) {
    const [hh, mm] = startTime.split(":").map(Number);
    return { dt: new Date(Date.UTC(y, m - 1, d, hh, mm)), aggregationMethod: "none" };
  }
  const [lo, hi] = DAYPART_HOUR_WINDOW[dayPart] || DAYPART_HOUR_WINDOW.unknown;
  const midHour = hi >= lo ? Math.floor((lo + hi) / 2) : Math.floor(((lo + hi + 24) / 2)) % 24;
  return { dt: new Date(Date.UTC(y, m - 1, d, midHour, 0)), aggregationMethod: "window_midpoint" };
}

function pv(res, providerName) {
  if (!res) return null;
  return {
    value: res.ok ? res.value : null, unit: res.unit || "", provider: providerName,
    station_or_gridpoint: res.station_or_gridpoint || "", fetched_at: new Date().toISOString(),
    measured_at: res.measured_at || "", distance_km: res.distance_km ?? null,
    origin: res.ok ? (res.origin || "unknown") : "unknown",
    quality: res.ok ? (res.quality || "niedrig") : "niedrig",
    extra: res.extra || null,
  };
}

async function enrich(waterId, targetDateIso, dayPart = "unknown", timePrecision = "unknown",
  startTime = null, linkedEntityType = "session", linkedEntityId = "") {
  const profile = FIRegistry.getProfile(waterId);
  const [refLat, refLon] = FIRegistry.WATER_REFERENCE_POINTS[waterId] || [null, null];
  const { dt: targetDt, aggregationMethod } = targetDatetime(targetDateIso, dayPart, timePrecision, startTime);

  const snapshot = {
    snapshot_id: FIDB.newId("env"), linked_entity_type: linkedEntityType, linked_entity_id: linkedEntityId,
    water_id: waterId, target_date: targetDateIso, target_day_part: dayPart,
    target_time_precision: timePrecision, aggregation_method: aggregationMethod,
    created_at: FIDB.nowIso(), updated_at: FIDB.nowIso(),
  };
  const errors = [];
  let anyOk = false, anyFail = false;
  const note = (ok, err) => { if (ok) anyOk = true; else { anyFail = true; if (err) errors.push(err); } };

  // --- Wetter (Momentwert) ---
  if (refLat !== null && profile.weatherProvider) {
    const hourly = await profile.weatherProvider.getHourly(refLat, refLon, targetDt);
    const map = { air_temp_c: "air_temp_c", wind_dir_deg: "wind_dir_deg", wind_speed_bft: "wind_speed_bft",
      wind_gust_bft: "wind_gust_bft", precipitation_mm: "precipitation_mm",
      cloud_cover_pct: "cloud_cover_pct", pressure_hpa: "pressure_hpa" };
    for (const [snapField, resKey] of Object.entries(map)) {
      const res = hourly[resKey];
      snapshot[snapField] = pv(res, profile.weatherProvider.name);
      note(res?.ok, res?.ok ? null : { provider: profile.weatherProvider.name, field: snapField, error: res?.error });
    }

    // Windhistorie (Abschnitt 15): 6/12/24/48h, vektoriell gemittelt
    for (const h of [6, 12, 24, 48]) {
      const wm = await profile.weatherProvider.getWindowMean(refLat, refLon, targetDt, h);
      snapshot[`wind_speed_mean_${h}h`] = pv(wm.wind_speed_mean, profile.weatherProvider.name);
      snapshot[`wind_dir_mean_${h}h`] = pv(wm.wind_dir_mean, profile.weatherProvider.name);
      note(wm.wind_speed_mean?.ok, wm.wind_speed_mean?.ok ? null :
        { provider: profile.weatherProvider.name, field: `wind_speed_mean_${h}h`, error: wm.wind_speed_mean?.error });
    }
    // Windwechsel (Abschnitt 15): groessere Richtungsaenderung + Zeitpunkt, 48h-Fenster
    const shift = await profile.weatherProvider.getWindShift(refLat, refLon, targetDt, 48, 45);
    snapshot.wind_shift_detected = pv(shift, profile.weatherProvider.name);
    if (shift.ok && shift.value) snapshot.wind_shift_time = pv({ ok: true, value: null, measured_at: shift.measured_at, origin: "modeled", quality: "mittel" }, profile.weatherProvider.name);
    note(shift.ok, shift.ok ? null : { provider: profile.weatherProvider.name, field: "wind_shift_detected", error: shift.error });

    // Trend Luftdruck (Abschnitt 16): 3/6/12h
    const pTrend = await profile.weatherProvider.getPressureTrend(refLat, refLon, targetDt, [3, 6, 12]);
    for (const h of [3, 6, 12]) {
      snapshot[`pressure_trend_${h}h`] = pv(pTrend[h], profile.weatherProvider.name);
      note(pTrend[h]?.ok, pTrend[h]?.ok ? null : { provider: profile.weatherProvider.name, field: `pressure_trend_${h}h`, error: pTrend[h]?.error });
    }
  } else {
    errors.push({ provider: "-", field: "weather", error: "Kein Wetter-Provider/keine Koordinate" });
    anyFail = true;
  }

  // --- Pegelstand + Trend ---
  if (profile.waterLevelProvider && profile.waterLevelStationId) {
    const lvl = await profile.waterLevelProvider.getLevel(profile.waterLevelStationId, targetDt);
    snapshot.water_level_cm = pv(lvl, profile.waterLevelProvider.name);
    note(lvl.ok, lvl.ok ? null : { provider: profile.waterLevelProvider.name, field: "water_level_cm", error: lvl.error });
    const trends = await profile.waterLevelProvider.getTrendMultiWindow(profile.waterLevelStationId, targetDt, [6, 12, 24]);
    for (const h of [6, 12, 24]) {
      snapshot[`water_level_trend_${h}h`] = pv(trends[h], profile.waterLevelProvider.name);
      if (h === 6 && trends[h]?.ok) snapshot.water_level_trend = pv(trends[h], profile.waterLevelProvider.name);
      note(trends[h]?.ok, trends[h]?.ok ? null : { provider: profile.waterLevelProvider.name, field: `water_level_trend_${h}h`, error: trends[h]?.error });
    }
  } else {
    errors.push({ provider: "-", field: "water_level_cm", error: `Kein Pegel-Provider fuer Gewaesser '${waterId}' (dokumentierte Luecke)` });
  }

  // --- Abfluss (Trave, Sprint-2-Fund) ---
  if (profile.dischargeProvider && refLat !== null) {
    const disc = await profile.dischargeProvider.getDischarge(refLat, refLon, targetDt);
    snapshot.discharge_m3s = pv(disc, profile.dischargeProvider.name);
    note(disc.ok, disc.ok ? null : { provider: profile.dischargeProvider.name, field: "discharge_m3s", error: disc.error });
  }

  // --- Wassertemperatur + Trend ---
  if (profile.waterTempProvider && refLat !== null) {
    const wt = await profile.waterTempProvider.getWaterTemp(refLat, refLon, targetDt);
    snapshot.water_temp_c = pv(wt, profile.waterTempProvider.name);
    note(wt.ok, wt.ok ? null : { provider: profile.waterTempProvider.name, field: "water_temp_c", error: wt.error });
    if (profile.waterTempProvider.getWaterTempTrend) {
      const wtTrend = await profile.waterTempProvider.getWaterTempTrend(refLat, refLon, targetDt, [24, 48, 72]);
      for (const h of [24, 48, 72]) {
        if (wtTrend[h]) {
          snapshot[`water_temp_trend_${h}h`] = pv(wtTrend[h], profile.waterTempProvider.name);
          note(wtTrend[h].ok, wtTrend[h].ok ? null : { provider: profile.waterTempProvider.name, field: `water_temp_trend_${h}h`, error: wtTrend[h].error });
        }
      }
    }
  }

  // --- Astronomie (immer offline, kein Ausfallrisiko) ---
  if (profile.astroProvider && refLat !== null) {
    const sun = profile.astroProvider.getSunEvents(refLat, refLon, targetDt);
    for (const key of ["sunrise", "sunset", "civil_twilight_begin", "civil_twilight_end", "day_length_hours"]) {
      const res = sun[key];
      if (res) { snapshot[key] = pv(res, profile.astroProvider.name); note(res.ok); }
    }
  }

  // --- Status/Qualitaet ---
  if (anyOk && !anyFail) { snapshot.status = "complete"; snapshot.data_quality = aggregationMethod === "none" ? "hoch" : "mittel"; }
  else if (anyOk && anyFail) { snapshot.status = "partial"; snapshot.data_quality = "mittel"; }
  else { snapshot.status = "failed"; snapshot.data_quality = "niedrig"; }
  snapshot.provider_errors = errors;
  snapshot.updated_at = FIDB.nowIso();

  await FIDB.put("environmental_snapshot", snapshot);

  if (snapshot.status !== "complete") await enqueueRetry(snapshot.snapshot_id);
  return snapshot;
}

async function enqueueRetry(snapshotId) {
  const existing = (await FIDB.getAll("enrichment_queue")).find((q) => q.snapshot_id === snapshotId && q.status === "pending");
  if (existing) return existing; // kein Duplikat anlegen
  const q = {
    queue_id: FIDB.newId("enrq"), snapshot_id: snapshotId, status: "pending", attempts: 1,
    last_attempt_at: FIDB.nowIso(),
    next_retry_at: new Date(Date.now() + 3600000).toISOString(),
    last_error: "Initialer Versuch unvollstaendig/fehlgeschlagen",
  };
  await FIDB.put("enrichment_queue", q);
  return q;
}

// Retry-Ausfuehrung (Abschnitt 35): bei App-Start und bei Wiederherstellung der Verbindung
// aufgerufen (siehe app.js) — NICHT aggressiv gepollt, kein Timer-Polling im Hintergrund.
async function retryPendingQueue() {
  if (!navigator.onLine) return { attempted: 0, reason: "offline" };
  const pending = (await FIDB.getAll("enrichment_queue")).filter((q) => q.status === "pending");
  let done = 0, stillPending = 0;
  for (const q of pending) {
    const snap = await FIDB.get("environmental_snapshot", q.snapshot_id);
    if (!snap) { await FIDB.del("enrichment_queue", q.queue_id); continue; }
    const newSnap = await enrich(snap.water_id, snap.target_date, snap.target_day_part,
      snap.target_time_precision, null, snap.linked_entity_type, snap.linked_entity_id);
    if (newSnap.status === "complete") {
      q.status = "done"; done++;
    } else {
      stillPending++;
    }
    q.attempts += 1; q.last_attempt_at = FIDB.nowIso();
    q.next_retry_at = new Date(Date.now() + 3600000).toISOString();
    q.last_error = newSnap.provider_errors?.map((e) => e.error).join("; ") || null;
    await FIDB.put("enrichment_queue", q);
  }
  return { attempted: pending.length, done, stillPending };
}

window.FIEnrichment = { enrich, enqueueRetry, retryPendingQueue, targetDatetime };
