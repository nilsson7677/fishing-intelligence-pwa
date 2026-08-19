// Shadow-Evaluation-Orchestrator — Phase 5 (Regime-STATE Shadow Pilot, GO-Freigabe 19.08.2026).
// Berechnet bei jedem outcome-relevanten Ereignis (Trip-Ende, Fang erfassen, Voice/Text-
// Intelligence-Meldung) PARALLEL zum sichtbaren Champion einen CHALLENGER_STATE_V1-Score und
// protokolliert beide zusammen mit passiv geloggtem Umweltkontext im neuen, rein additiven Store
// "shadow_evaluation" (siehe PHASE5_REGIME_STATE_SHADOW_PILOT_SPEC.md, Abschnitt 5).
//
// KERNPRINZIP (siehe Spezifikation, STOP-Regel der GO-Freigabe): Diese Datei liest den Champion
// NUR LESEND ueber die bestehende, unveraenderte FIMefoModel.basisFangchance()-Funktion — sie
// aendert an meerforelle-model.js nichts. Sie wird von KEINER View gerendert und von KEINEM
// Button aufgerufen; sie laeuft ausschliesslich als Hintergrund-Nebeneffekt der bestehenden
// Speichervorgaenge (siehe app.js: renderCatchForm, endTrip, enrichReportInBackground).
//
// SCOPE-GUARD: CHALLENGER_STATE_V1 wurde ausschliesslich auf dem Meerforellen-Fangbuch der
// Lübecker Bucht gefittet (siehe challenger-state.js, Provenance-Kommentar). Ein Shadow-Eintrag
// wird daher NUR fuer species === "mefo" && water_id === "luebecker_bucht" angelegt — fuer alle
// anderen Arten/Gewaesser waere der Challenger-Score eine unbelegte Uebertragung (kein
// Threshold Mining / keine ungeprüfte Generalisierung, siehe Auftrag).

function _monthFromIso(dateIso) {
  if (!dateIso) return null;
  const parts = dateIso.split("-");
  const m = parseInt(parts[1], 10);
  return Number.isFinite(m) ? m : null;
}

function _snapVal(snap, field) {
  return snap && snap[field] && "value" in snap[field] ? snap[field].value : null;
}

// recordShadowEvaluation(opts) -> Promise<object|null>
// opts:
//   linkedEntityType: "fishing_session" | "catch_event" | "intelligence_report"
//   linkedEntityId:   string
//   species:          string (nur "mefo" fuehrt zu einem Eintrag)
//   waterId:          string (nur "luebecker_bucht" fuehrt zu einem Eintrag)
//   snapshot:         der environmental_snapshot-Datensatz (bereits gespeichert, mit snapshot_id)
//   dateIso:          Zieldatum (YYYY-MM-DD) fuer die Monatsermittlung
//   spotKey, shoreOrBoat, sessionDurationMinutes: optionale Stratifizierungs-/Kontextfelder
//   outcomeKnown: bool, fangJa: bool|null, catchCountMefo: number|null
async function recordShadowEvaluation(opts) {
  try {
    if (!opts || opts.species !== "mefo" || opts.waterId !== "luebecker_bucht") return null;
    if (!opts.snapshot) return null;
    if (typeof window === "undefined" || !window.FIMefoModel || !window.FIChallengerState || !window.FIDB) return null;

    const month = _monthFromIso(opts.dateIso);
    const temp = _snapVal(opts.snapshot, "water_temp_c");

    const championRes = (month !== null) ? window.FIMefoModel.basisFangchance(month, temp) : null;
    const challengerRes = (month !== null) ? window.FIChallengerState.scoreChallengerState(month, temp) : null;

    const championConfTier = window.FIMefoModel.spotConfidenceTier
      ? window.FIMefoModel.combineConfidenceTier(
          (opts.snapshot.data_quality === "hoch") ? "hoch" : (opts.snapshot.data_quality === "mittel" ? "mittel" : "niedrig"),
          "niedrig")
      : null;

    const entry = {
      shadow_id: window.FIDB.newId("shadow"),
      model_version: window.FIChallengerState.META.version,
      linked_entity_type: opts.linkedEntityType || null,
      linked_entity_id: opts.linkedEntityId || null,
      environmental_snapshot_id: opts.snapshot.snapshot_id || null,
      timestamp_created: window.FIDB.nowIso(),

      // Champion (unveraendert produktiv, hier NUR mitgeloggt fuer den Vergleich)
      champion_score: championRes ? championRes.score : null,
      champion_tier: championRes ? championRes.label : null,
      champion_confidence_tier: championConfTier,

      // Challenger A
      challenger_state: challengerRes ? challengerRes.regime : null,
      challenger_score: challengerRes ? challengerRes.probability : null,
      challenger_tier: challengerRes ? challengerRes.tier : null,

      // Passiv geloggter Kontext (siehe Spezifikation Abschnitt 3 "Feature Contract") — KEIN
      // Score-Einfluss, weder beim Champion noch bei Challenger A.
      water_temp_c: temp,
      delta_sst_24h: _snapVal(opts.snapshot, "water_temp_trend_24h"),
      delta_sst_48h: _snapVal(opts.snapshot, "water_temp_trend_48h"),
      delta_sst_72h: _snapVal(opts.snapshot, "water_temp_trend_72h"),
      waterlevel_cm: _snapVal(opts.snapshot, "water_level_cm"),
      waterlevel_phase: opts.snapshot.waterlevel_phase ?? null,
      waterlevel_rate_cm_h: opts.snapshot.waterlevel_rate_cm_h ?? null,
      waterlevel_minutes_since_peak: opts.snapshot.waterlevel_minutes_since_peak ?? null,
      waterlevel_peak_time: opts.snapshot.waterlevel_peak_time ?? null,
      waterlevel_confidence: opts.snapshot.waterlevel_confidence ?? null,
      waterlevel_phase_status: opts.snapshot.waterlevel_phase_status ?? null,
      wind_dir_deg: _snapVal(opts.snapshot, "wind_dir_deg"),
      wind_speed_bft: _snapVal(opts.snapshot, "wind_speed_bft"),
      wind_dir_mean_6h: _snapVal(opts.snapshot, "wind_dir_mean_6h"),
      wind_dir_mean_12h: _snapVal(opts.snapshot, "wind_dir_mean_12h"),
      wind_dir_mean_24h: _snapVal(opts.snapshot, "wind_dir_mean_24h"),
      wind_dir_mean_48h: _snapVal(opts.snapshot, "wind_dir_mean_48h"),
      wind_speed_mean_6h: _snapVal(opts.snapshot, "wind_speed_mean_6h"),
      wind_speed_mean_12h: _snapVal(opts.snapshot, "wind_speed_mean_12h"),
      wind_speed_mean_24h: _snapVal(opts.snapshot, "wind_speed_mean_24h"),
      wind_speed_mean_48h: _snapVal(opts.snapshot, "wind_speed_mean_48h"),
      wind_shift_detected_48h: _snapVal(opts.snapshot, "wind_shift_detected"),
      pressure_trend_3h: _snapVal(opts.snapshot, "pressure_trend_3h"),
      pressure_trend_6h: _snapVal(opts.snapshot, "pressure_trend_6h"),
      pressure_trend_12h: _snapVal(opts.snapshot, "pressure_trend_12h"),

      // Missing-Data-/Confidence-Flags (Nutzer soll nicht zum Datenpfleger werden — vollstaendig
      // aus dem ohnehin gespeicherten Snapshot abgeleitet, keine Zusatzeingabe noetig)
      snapshot_status: opts.snapshot.status || null,
      snapshot_data_quality: opts.snapshot.data_quality || null,
      score_computable: !!(championRes && championRes.score !== null),

      // Kontext fuer Stratifizierung (Spezifikation Abschnitt 6.3/7) — NICHT Modellinput
      spot_key: opts.spotKey || null,
      shore_or_boat: opts.shoreOrBoat || null,
      session_duration_minutes: (typeof opts.sessionDurationMinutes === "number") ? opts.sessionDurationMinutes : null,

      // Outcome (Spezifikation Abschnitt 6 — Primary Outcome: binaeres Session-Outcome)
      outcome_known: !!opts.outcomeKnown,
      fang_ja: opts.outcomeKnown ? !!opts.fangJa : null,
      catch_count_mefo: opts.outcomeKnown ? (typeof opts.catchCountMefo === "number" ? opts.catchCountMefo : null) : null,
    };

    await window.FIDB.put("shadow_evaluation", entry);
    return entry;
  } catch (e) {
    // Shadow-Logging darf NIE die produktive Fang-/Trip-Erfassung gefaehrden (gleiches Prinzip wie
    // enrichment.js: ein Nebeneffekt-Fehler fuehrt nie zu Datenverlust an der eigentlichen Meldung).
    console.warn("Shadow-Evaluation konnte nicht gespeichert werden (Champion/produktive Daten unberührt):", e);
    return null;
  }
}

if (typeof window !== "undefined") {
  window.FIShadow = { recordShadowEvaluation };
}
