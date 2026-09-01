// Sea Trout WHERE Shadow Engine — Dynamic Spot Suitability & Top-3 (Phase HI-2C, 31.08.2026).
// Baut auf dem live-verifizierten HI-2B-Stand auf (build phase-hi2b-when-shadow-v22-2026-08-31,
// siehe HOURLY_INTELLIGENCE_SHADOW.md, PHASE_HI2B_WHEN_SHADOW_IMPLEMENTATION_REPORT.md). Beantwortet
// AUSSCHLIESSLICH: "Wenn ich im von HI-2B empfohlenen Zeitfenster vom Ufer fische, welche Spots
// passen unter den prognostizierten Bedingungen relativ am besten?" — weiterhin STRIKT SHADOW: keine
// produktive Fangwahrscheinlichkeit, kein produktives Spot-Ranking, kein Zugriff auf historische
// SPOT_STATS-Fangquoten (Auftrag HI-2C Abschnitt 30/31).
//
// EIGENE DATEI (wie hourly-window-intelligence.js fuer HI-2B): reine additive Konsumenten-Schicht.
// Veraendert hourly-intelligence.js, hourly-window-intelligence.js, providers.js, astro.js,
// meerforelle-model.js, challenger-state.js an KEINER Stelle — nur LESENDE Aufrufe bereits
// vorhandener, unveraenderter Funktionen (Guardrail Abschnitt 2).
//
// ===========================================================================
// A. REPOSITORY & RESEARCH AUDIT (Auftrag Abschnitt 4) — Kurzfassung, volle Fassung im
//    HI-2C-Abschlussbericht Abschnitt A-C. Hier nur die Konsequenz fuer diese Datei:
// ===========================================================================
// A. Spot-Metadaten: SPOT_GEO_METADATA (hourly-intelligence.js, HI-2A) — 13 Spots aus SPOT_STATS,
//    9 davon mit latitude/longitude/shoreOrientationDeg + getrennter Provenance fuer Position/
//    Orientierung ("hoch"/"mittel"/"niedrig"), 4 Spots (wiek/klinikum/seeburgbruecke/hafeneinfahrt)
//    komplett ohne Koordinate (Namensambiguitaet), pelzerhaken MIT Koordinate aber OHNE Orientierung
//    (zweiseitige Landzunge, siehe hourly-intelligence.js-Kommentar). Macht 5 von 13 Spots fuer
//    JEDE geometrische Berechnung strukturell unrankable (siehe Abschnitt J unten).
// B. Physikalische Forecastgroessen: windSpeedMs/windGustMs/windDirectionDeg (open_meteo, Batch,
//    EIN Gitterpunkt pro Gewaesser), waveHeightM/waveDirectionDeg/wavePeriodSec (open_meteo_marine,
//    ecmwf_wam, seit HI-2A.1 getrennter Request, ebenfalls EIN Gitterpunkt). WICHTIGE KONSEQUENZ
//    (nicht im Auftrag explizit benannt, aber direkt aus der HI-2A/HI-2A.1-Architektur folgend):
//    windSpeedMs/waveHeightM/wavePeriodSec sind fuer ALLE Spots eines Gewaessers INNERHALB DESSELBEN
//    Fensters IDENTISCH (ein einziger Referenzpunkt pro Gewaesser, siehe
//    FIRegistry.WATER_REFERENCE_POINTS) — sie koennen deshalb Spots strukturell NICHT
//    unterscheiden. NUR die GEOMETRIE (Windrichtung/Wellenrichtung relativ zur jeweiligen
//    shoreOrientationDeg) unterscheidet sich pro Spot. Diese Erkenntnis ist zentral fuer das
//    Modelldesign unten (Abschnitt D/E) — sie ist der WHERE-Analogon zu Auftrag Abschnitt 32
//    ("WHEN ist innerhalb eines Fensters fuer alle Spots gleich") und wird hier auf JEDES
//    nicht-geometrische Forecastfeld ausgeweitet.
// C. Biologisch gestuetzte Aussagen (Projekt-KB, sea_trout_intelligence_kb_v1.md/Evidence Ledger
//    in phase4_status_gap_review_v2.md, Gesamtbericht 3.3/3.4, phase2_5_wind_spot_exposition.md):
//    - STI-007 "Windrichtung allein unbrauchbar" — VALIDATED_EXTERNAL, Grade A/hoch: rohe
//      Kompassrichtung ("Ostwind schlecht") ist unbrauchbar, motiviert ueberhaupt erst die
//      spot-relative Berechnung.
//    - Gesamtbericht 3.3 (Windfaktor): Windstaerke-Sweetspot ca. 2-4 Bft bei auf-/schraeg-auflandig,
//      Windstille-Nachteil (Grade B, DE/DK/SE-Konsens) — bezieht sich auf WINDSTAERKE, nicht auf
//      Spot-Unterscheidung (siehe Punkt B: Windstaerke ist pro Fenster gewaesserweit identisch).
//    - Gesamtbericht 3.4 (Truebungsfaktor): leichte/moderate Truebung bzw. Wellenschlag wirkt
//      "aktivierend" (Nahrung aufgewirbelt, Fisch unvorsichtiger) — Grade B (Mechanismus) / C-D
//      (quantitative Kalibrierung fehlt), mehrfach bestaetigt (BLINKER/Fishing-King/Anglerboard,
//      Grade C).
//    - STI-002/STI-013 "Summer Thermal Refuge Shift"/"Tiefenmuster x Temperatur" — VALIDATED_EXTERNAL
//      Grade A, stuetzt H3 MECHANISTISCH, aber persoenlich NOT_TESTABLE_WITH_CURRENT_DATA (keine
//      Tiefendaten im Fangbuch) UND im aktuellen Spot-Datenmodell existiert keine Tiefe/
//      Stroemungsklasse (siehe Abschnitt D unten, H3 bleibt unresolved).
// D. Angelheuristik/unbewiesene Hypothese (NICHT verwendbar als Score):
//    - PHASE 2.5 (`phase2_5_wind_spot_exposition.md`, 16.08.2026) — ZENTRALER NEGATIVBEFUND: eine
//      BERECHNETE Wind-Exposure-Variable (Windrichtung relativ zur Kuestennormalen, exakt dieselbe
//      Geometrie wie hier verfuegbar) lieferte im eigenen 18-Jahre-Fangbuch-Backtest in JEDER
//      getesteten Granularitaet (stetig/3-Kategorien/5-Kategorien) einen Out-of-Sample-AUC von
//      0,42-0,43 — UNTER Zufallsniveau. Der personenkontrollierte Test der rohen onshore/offshore-
//      Klassifikation (MASTER_CONTEXT_CHATGPT_HANDOVER.md) bestaetigt das: onshore 54,9% (n=122) vs.
//      offshore 50,2% (n=285), p=0,44 — kein Signal. Das bereits bestehende `strategieHinweis()` in
//      meerforelle-model.js dokumentiert dieselbe Einschaetzung explizit im Code ("EXPERIMENTELL,
//      kein eigenstaendiger, statistisch abgesicherter Score-Faktor, siehe Phase 2.5").
//    - Konsequenz (siehe Abschnitt E/Mathematical Definition unten): WIND-Geometrie wird in
//      `physicalFeatures` vollstaendig transparent berechnet (fachliche Challenge, Auftrag
//      Abschnitt 48), aber NICHT in `biologicalRules`/`rawSuitability` gescort — die spezifischste,
//      methodisch am besten passende verfuegbare Evidenz (derselbe Berechnungsansatz, dasselbe
//      Fangbuch) hat genau diesen Ansatz bereits negativ getestet. Eine erneute Verwendung ohne
//      neue Evidenz waere "Threshold Mining" ohne Beleg.
// E. Duerfen deshalb NICHT gewichtet werden: Windrichtung/-exposition (siehe D), absolute
//    Windrichtung, Windstaerke als Spot-Differenzierer (siehe B — gewaesserweit identisch),
//    Wellenhoehe/-energie als eigenstaendiger Score ohne belegte Schwelle (keine erfundene
//    Zahlengrenze, Auftrag Abschnitt 17), depthAccessClass/currentExposureClass (existieren nicht,
//    Auftrag Abschnitt 19/20), historische SPOT_STATS-Fangquoten (Auftrag Abschnitt 30/31,
//    technischer Guardrail: diese Datei liest SPOT_STATS nur fuer die Spot-ID-LISTE, nie fuer
//    `rohquote`/`shrunk`/`n`).
//
// Mathematische Kernidee (Auftrag Abschnitt 6/14/24, "so klein wie moeglich", keine additive
// Punktesuppe): GENAU EINE experimentelle biologische Regel, binaer/ordinal (kein erfundener
// Schwellenwert bei der Wellenhoehe, siehe Abschnitt D oben):
//
//   rawSuitability = WHERE_BASE_SUITABILITY + (waveOnshoreComponent > 0 ? WHERE_WAVE_ONSHORE_WEIGHT : 0)
//
// waveOnshoreComponent wird durch die BEREITS VORHANDENE, unveraenderte
// FIHourlyIntelligence.computeWaveShoreFeatures() geliefert (Auftrag Abschnitt 10: "nutze
// vorhandene pure geometry helpers") — kein neuer Geometrie-Code, keine neue Schwelle: das Feld ist
// bereits auf >=0 geklemmt (0 bei ablandig), sodass "onshore vs. nicht-onshore" eine reine
// Vorzeichenfrage ohne erfundene Magnitude-Schwelle ist. Windgeometrie wird identisch berechnet und
// vollstaendig in physicalFeatures gezeigt, fliesst aber NICHT in rawSuitability ein (siehe D/E).
// ===========================================================================

const WHERE_ENGINE_VERSION = "HI-2C-2026-08-31";
const WHERE_HYPOTHESIS_VERSION = "where-hypothesis-v1-2026-08-31";
const WHERE_INTELLIGENCE_MODE = "SHADOW";
const ALLOW_PRODUCTION_SPOT_RANKING_MUTATION = false;

// Scope (Auftrag Abschnitt 3) — HI-2C gilt zunaechst NUR fuer diese exakte Kombination.
const WHERE_SUPPORTED_SPECIES = "mefo";
const WHERE_SUPPORTED_WATER = "luebecker_bucht";
const WHERE_SUPPORTED_FISHING_MODE = "shore";

// EXPERIMENTAL — siehe Herleitung oben (Abschnitt D). Einzige aktive biologische Regel, bewusst
// klein gehalten (kleiner als HI-2B's H1-Gewichte fuer warm/very_warm, da die Evidenzlage hier
// schwaecher ist: Grade C/D statt A-Telemetrie, UND nicht personal getestet statt widerlegt).
const WHERE_BASE_SUITABILITY = 0.5;
const WHERE_WAVE_ONSHORE_WEIGHT = 0.15;

// Floor fuer die Fenster-relative Normalisierung (Auftrag Abschnitt 26, identisches Prinzip wie
// HI-2B Abschnitt 24): verhindert, dass eine winzige Spot-Spannweite optisch auf 0..100
// aufgeblasen wird.
const WHERE_RELATIVE_SUITABILITY_FLOOR = 0.15;

// Spot-Contrast-Schwellen — kalibriert auf die Skala von WHERE_WAVE_ONSHORE_WEIGHT (0.15): mit
// GENAU EINER binaeren Regel ist die maximale erreichbare Rohspannweite exakt 0.15 (manche Spots
// onshore, manche nicht) — "high" ist mit dem aktuellen Modell strukturell kaum erreichbar, was
// ehrlich die begrenzte Differenzierungskraft der Engine widerspiegelt (siehe Known Limitations).
const WHERE_SPOT_CONTRAST_LOW_MAX = 0.05;
const WHERE_SPOT_CONTRAST_MEDIUM_MAX = 0.20;

const WHERE_CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

function _assertWhereGuardrails() {
  const hiCfg = window.FIHourlyIntelligence && window.FIHourlyIntelligence.HI_CONFIG;
  if (!hiCfg || hiCfg.MODE !== "SHADOW" || hiCfg.ALLOW_CHAMPION_MUTATION || hiCfg.ALLOW_PRODUCTION_SCORING || hiCfg.ALLOW_AUTOMATIC_PROMOTION) {
    throw new Error("WHERE-Intelligence-Guardrail verletzt (HI-Basis) — Abbruch (siehe Auftrag HI-2C Abschnitt 2).");
  }
  if (WHERE_INTELLIGENCE_MODE !== "SHADOW" || ALLOW_PRODUCTION_SPOT_RANKING_MUTATION) {
    throw new Error("WHERE-Intelligence-Guardrail verletzt (WHERE) — Abbruch (siehe Auftrag HI-2C Abschnitt 2).");
  }
}

// ---------------------------------------------------------------------------
// SCOPE-PRUEFUNG (Auftrag Abschnitt 3) — mefo x luebecker_bucht x shore, sonst "unsupported".
// Bewusst eine reine, synchrone Pruef-Funktion (kein Netzwerkzugriff), damit der Aufrufer VOR
// jedem Forecast-Request weiss, ob HI-2C ueberhaupt zustaendig ist.
// ---------------------------------------------------------------------------

function checkWhereScope(speciesId, waterId, fishingMode) {
  const reasons = [];
  if (speciesId !== WHERE_SUPPORTED_SPECIES) reasons.push(`species '${speciesId}' nicht unterstuetzt (nur '${WHERE_SUPPORTED_SPECIES}')`);
  if (waterId !== WHERE_SUPPORTED_WATER) reasons.push(`water '${waterId}' nicht unterstuetzt (nur '${WHERE_SUPPORTED_WATER}')`);
  if (fishingMode !== WHERE_SUPPORTED_FISHING_MODE) reasons.push(`mode '${fishingMode}' nicht unterstuetzt (nur '${WHERE_SUPPORTED_FISHING_MODE}', z.B. 'boat' liefert bewusst keine Ufer-Top-3)`);
  return reasons.length ? { supported: false, status: "not_applicable", reasons } : { supported: true, status: "applicable", reasons: [] };
}

// ---------------------------------------------------------------------------
// WINDOW AGGREGATION (Auftrag Abschnitt 9) — robuste Fenster-Features statt Einzelstunden-Peak.
// Zirkulaere Statistik fuer Richtungen (KEIN arithmetisches Mittel — 359 Grad + 1 Grad darf NICHT
// 180 Grad ergeben) via der bereits vorhandenen, unveraenderten FIProviders.circularMeanDeg().
// ---------------------------------------------------------------------------

function _median(values) {
  const v = values.filter((x) => x !== null && x !== undefined).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
function _mean(values) {
  const v = values.filter((x) => x !== null && x !== undefined);
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}
function _maxOrNull(values) {
  const v = values.filter((x) => x !== null && x !== undefined);
  return v.length ? Math.max(...v) : null;
}
function _round(v, decimals) {
  if (v === null || v === undefined) return null;
  const f = Math.pow(10, decimals);
  return Math.round(v * f) / f;
}

// hoursSubset: [{environment, features}, ...] — bereits auf ein Fenster gefilterte Teilmenge von
// buildHourlyForecastSeries().hours (siehe _hoursInWindow() unten). Rein synchron, kein
// Netzwerkzugriff. Fehlende Einzelwerte (Luecke in der Mitte, teilweise fehlende Wellen-Daten)
// werden VOR der Aggregation herausgefiltert, kein Erfinden ueber die vorhandenen Punkte hinaus.
function aggregateWindowConditions(hoursSubset) {
  const envs = hoursSubset.map((h) => h.environment);
  const windSpeeds = envs.map((e) => e.windSpeedMs);
  const windGusts = envs.map((e) => e.windGustMs);
  const windDirs = envs.map((e) => e.windDirectionDeg).filter((d) => d !== null && d !== undefined);
  const waveHeights = envs.map((e) => e.waveHeightM);
  const wavePeriods = envs.map((e) => e.wavePeriodSec);
  const waveDirs = envs.map((e) => e.waveDirectionDeg).filter((d) => d !== null && d !== undefined);
  const waterTemps = envs.map((e) => e.waterTempC);

  const windSpeedMsMedian = _median(windSpeeds);
  const waveHeightMMedian = _median(waveHeights);
  const wavePeriodSecMedian = _median(wavePeriods);

  return {
    hourCount: hoursSubset.length,
    windSpeedMsMedian, windSpeedMsMean: _round(_mean(windSpeeds), 2),
    windGustMsMax: _maxOrNull(windGusts),
    windDirectionDegCircularMean: windDirs.length ? _round(FIProviders.circularMeanDeg(windDirs), 1) : null,
    windMissingHours: windSpeeds.filter((v) => v === null || v === undefined).length,
    waveHeightMMedian: _round(waveHeightMMedian, 2),
    wavePeriodSecMedian: _round(wavePeriodSecMedian, 2),
    waveDirectionDegCircularMean: waveDirs.length ? _round(FIProviders.circularMeanDeg(waveDirs), 1) : null,
    waveMissingHours: waveHeights.filter((v) => v === null || v === undefined).length,
    waterTempCMedian: _round(_median(waterTemps), 2), // Kontext, siehe Auftrag Abschnitt 8 — NICHT erneut als Spot-Punkt
    waveEnergyProxy: (waveHeightMMedian !== null && wavePeriodSecMedian !== null)
      ? _round(waveHeightMMedian * waveHeightMMedian * wavePeriodSecMedian, 3) : null, // dimensionsloser Proxy, siehe Auftrag Abschnitt 16 — KEINE Fangwahrscheinlichkeit, fliesst NICHT in rawSuitability ein (kein belegter Schwellenwert, siehe Abschnitt D oben)
  };
}

// Waehlt aus einer bereits geladenen buildHourlyForecastSeries().hours-Liste genau die Stunden
// innerhalb [window.startTimestamp, window.endTimestamp] (beide inklusive — HI-2B's endTimestamp
// ist der Zeitstempel der LETZTEN Fensterstunde, siehe hourly-window-intelligence.js).
function _hoursInWindow(seriesHours, windowObj) {
  if (!windowObj) return [];
  const startMs = Date.parse(windowObj.startTimestamp), endMs = Date.parse(windowObj.endTimestamp);
  return seriesHours.filter((h) => {
    const t = Date.parse(h.environment.timestamp);
    return t >= startMs && t <= endMs;
  });
}

// ---------------------------------------------------------------------------
// PER-SPOT SUITABILITY (Auftrag Abschnitt 21/22/23) — reine Funktion, konsumiert bereits
// aggregierte Fensterbedingungen + Spot-Geometrie aus dem unveraenderten HI-2A-Register.
// ---------------------------------------------------------------------------

function _confidenceFromOrientation(orientationConfidence) {
  if (orientationConfidence === "hoch") return "high";
  if (orientationConfidence === "mittel") return "medium";
  if (orientationConfidence === "niedrig") return "low";
  return "low";
}
function _worstConfidence(list) {
  const valid = list.filter(Boolean);
  if (!valid.length) return "low";
  return valid.reduce((worst, c) => (WHERE_CONFIDENCE_RANK[c] < WHERE_CONFIDENCE_RANK[worst] ? c : worst), "high");
}

// Auftrag Abschnitt 22 — Feldnamen-Hinweis: der Auftrag benennt "windCrossshoreComponent"/
// "waveCrossshoreComponent", die bereits vorhandene HI-2A-Geometrie (hourly-intelligence.js)
// nennt dieselbe Groesse (Komponente PARALLEL zur Kueste) "alongShoreComponent"/
// "alongshoreWaveComponent" (ozeanografisch ueblichere Konvention: cross-shore = senkrecht/
// onshore-offshore-Achse, along-shore = parallel). Um HI-2A NICHT zu veraendern (Guardrail) und
// trotzdem exakt die im Auftrag benannten Felder zu liefern, wird hier bewusst 1:1 gemappt:
// windOnshoreComponent/waveOnshoreComponent = die vorhandene onshore/offshore-Achse (>=0-geklemmt),
// windCrossshoreComponent/waveCrossshoreComponent = die vorhandene parallele Komponente. Siehe
// HI-2C-Abschlussbericht Abschnitt G fuer die vollstaendige Erlaeuterung.
function _computeSpotSuitability(spotId, wc, windowId) {
  const geo = window.FIHourlyIntelligence.getSpotGeoMetadata(spotId);
  const base = { spotId, windowId, mode: "shadow" };

  if (!geo || geo.shoreOrientationDeg === null || geo.shoreOrientationDeg === undefined) {
    return {
      ...base, rankable: false, rawSuitability: null, relativeSuitability: null, confidence: "low",
      physicalFeatures: { shoreOrientationDeg: null, windDirectionDeg: wc.windDirectionDegCircularMean,
        windRelativeAngleDeg: null, windOnshoreComponent: null, windCrossshoreComponent: null,
        waveDirectionDeg: wc.waveDirectionDegCircularMean, waveRelativeAngleDeg: null,
        waveOnshoreComponent: null, waveCrossshoreComponent: null,
        waveHeightM: wc.waveHeightMMedian, wavePeriodSec: wc.wavePeriodSecMedian, windSpeedMs: wc.windSpeedMsMedian },
      biologicalRules: [], reasonCodes: ["UNKNOWN_ORIENTATION"], missingData: ["shoreOrientationDeg"],
      provenance: { orientationSource: geo ? geo.orientationSource : null, orientationConfidence: geo ? geo.orientationConfidence : null },
    };
  }

  const shoreOrientationDeg = geo.shoreOrientationDeg;
  const wind = (wc.windDirectionDegCircularMean !== null && wc.windSpeedMsMedian !== null)
    ? window.FIHourlyIntelligence.computeWindShoreFeatures(wc.windDirectionDegCircularMean, wc.windSpeedMsMedian, shoreOrientationDeg) : null;
  const wave = (wc.waveDirectionDegCircularMean !== null && wc.waveHeightMMedian !== null)
    ? window.FIHourlyIntelligence.computeWaveShoreFeatures(wc.waveDirectionDegCircularMean, wc.waveHeightMMedian, shoreOrientationDeg) : null;

  const missingData = [];
  if (!wind) missingData.push("windDirectionDeg/windSpeedMs");
  if (!wave) missingData.push("waveDirectionDeg/waveHeightM");

  const physicalFeatures = {
    shoreOrientationDeg,
    windDirectionDeg: wc.windDirectionDegCircularMean,
    windRelativeAngleDeg: wind ? wind.relativeWindAngleDeg : null,
    windOnshoreComponent: wind ? wind.onshoreStrength : null,
    windCrossshoreComponent: wind ? wind.alongShoreComponent : null,
    waveDirectionDeg: wc.waveDirectionDegCircularMean,
    waveRelativeAngleDeg: wave ? wave.relativeWaveAngleDeg : null,
    waveOnshoreComponent: wave ? wave.onshoreWaveComponent : null,
    waveCrossshoreComponent: wave ? wave.alongshoreWaveComponent : null,
    waveHeightM: wc.waveHeightMMedian, wavePeriodSec: wc.wavePeriodSecMedian, windSpeedMs: wc.windSpeedMsMedian,
  };

  if (!wind && !wave) {
    return { ...base, rankable: false, rawSuitability: null, relativeSuitability: null, confidence: "low",
      physicalFeatures, biologicalRules: [], reasonCodes: ["MISSING_WINDOW_CONDITIONS"], missingData,
      provenance: { orientationSource: geo.orientationSource, orientationConfidence: geo.orientationConfidence } };
  }

  // GENAU EINE experimentelle biologische Regel (siehe Herleitung oben, Abschnitt D) — bewusst kein
  // Wind-Regel-Pendant (Phase 2.5: berechnete Wind-Exposure lieferte OOS AUC 0,42-0,43, unter
  // Zufallsniveau, identischer Berechnungsansatz).
  const biologicalRules = [];
  let interaction = 0;
  const reasonCodes = [];
  if (wave && wave.onshoreWaveComponent > 0) {
    interaction = WHERE_WAVE_ONSHORE_WEIGHT;
    biologicalRules.push({
      ruleId: "WAVE_ONSHORE_ACTIVATION", hypothesisId: "H4",
      evidenceReference: "Gesamtbericht 3.4 Truebungsfaktor (Grade B Mechanismus / C-D quantitativ); " +
        "BLINKER/Fishing-King/Anglerboard (Grade C, mehrfach bestaetigt: Wellenschlag aktivierend, Nahrung aufgewirbelt); " +
        "NICHT personal getestet (keine historischen Wellendaten im 18-Jahre-Fangbuch, Status analog NOT_TESTABLE_WITH_CURRENT_DATA).",
      effectDirection: "positive_small_ordinal_when_onshore", experimental: true,
    });
    reasonCodes.push("WAVE_ONSHORE_ACTIVATION_EXPERIMENTAL");
  } else if (wave) {
    reasonCodes.push("WAVE_NOT_ONSHORE");
  } else {
    reasonCodes.push("NO_WAVE_DATA");
  }
  // Immer gesetzt (auch wenn kein Wave-Rule feuert) — macht explizit sichtbar, DASS Windgeometrie
  // berechnet, aber bewusst nicht gescort wird (Auftrag Abschnitt 48: "fachlich challengen").
  reasonCodes.push("WIND_GEOMETRY_SHOWN_NOT_SCORED");

  const rawSuitability = _round(WHERE_BASE_SUITABILITY + interaction, 4);

  const forecastConfidence = wc.windowConfidence || "low"; // aus HI-2B-Fenster (Horizont-basiert), siehe buildWhereForWindow()
  const geometryConfidence = _confidenceFromOrientation(geo.orientationConfidence);
  const evidenceConfidence = biologicalRules.length ? "low" : "medium"; // Grade C/D bei aktiver Regel, sonst kein spekulativer Einfluss
  const dataCompleteness = (wind && wave) ? "high" : (wind || wave) ? "medium" : "low";
  const confidence = _worstConfidence([forecastConfidence, geometryConfidence, evidenceConfidence, dataCompleteness]);

  return {
    ...base, rankable: true, rawSuitability, relativeSuitability: null, // relativeSuitability erst nach Fenster-Normalisierung gesetzt (siehe buildSpotSuitabilityForWindow)
    confidence, physicalFeatures, biologicalRules, reasonCodes, missingData,
    confidenceBreakdown: { forecastConfidence, geometryConfidence, evidenceConfidence, dataCompleteness },
    provenance: { orientationSource: geo.orientationSource, orientationConfidence: geo.orientationConfidence },
  };
}

// spotIds: Liste bekannter Spot-IDs (siehe runWhereShadowAnalysis() — aus SPOT_STATS-Keys ohne
// "ostsee_allgemein" abgeleitet, NUR die IDs, NIE rohquote/shrunk/n gelesen, Guardrail Abschnitt 31).
// wc: Ergebnis von aggregateWindowConditions() PLUS windowConfidence (siehe buildWhereForWindow()).
// Liefert das vollstaendige, Fenster-normalisierte Array (Auftrag Abschnitt 21-Form je Spot,
// relativeSuitability + LOW_SPOT_CONTRAST-Tag bereits gesetzt).
function buildSpotSuitabilityForWindow(wc, spotIds, windowId) {
  const raw = spotIds.map((id) => _computeSpotSuitability(id, wc, windowId));
  const rankable = raw.filter((r) => r.rankable);
  if (!rankable.length) return raw;

  const raws = rankable.map((r) => r.rawSuitability);
  const rawMin = Math.min(...raws), rawMax = Math.max(...raws);
  const range = _round(rawMax - rawMin, 4);
  const spotContrast = range < WHERE_SPOT_CONTRAST_LOW_MAX ? "low" : range < WHERE_SPOT_CONTRAST_MEDIUM_MAX ? "medium" : "high";
  const denom = Math.max(rawMax - rawMin, WHERE_RELATIVE_SUITABILITY_FLOOR);

  return raw.map((r) => {
    if (!r.rankable) return r;
    const rel = _round(Math.max(0, Math.min(100, ((r.rawSuitability - rawMin) / denom) * 100)), 1);
    const reasonCodes = spotContrast === "low" ? [...new Set([...r.reasonCodes, "LOW_SPOT_CONTRAST"])] : r.reasonCodes;
    return { ...r, relativeSuitability: rel, reasonCodes };
  });
}

// ---------------------------------------------------------------------------
// TOP-3 (Auftrag Abschnitt 27) — deterministisch (KEINE Zufallsreihenfolge bei Gleichstand,
// Auftrag Abschnitt 43): sortiert nach rawSuitability absteigend, Gleichstand nach spotId
// alphabetisch. Nur rankbare Spots, keine kuenstliche Auffuellung.
// ---------------------------------------------------------------------------

function buildTop3ForWindow(spotResults, windowId) {
  const rankable = spotResults.filter((r) => r.rankable);
  const unrankableSpots = spotResults.filter((r) => !r.rankable)
    .map((r) => ({ spotId: r.spotId, reasonCodes: r.reasonCodes, missingData: r.missingData }));
  const sorted = [...rankable].sort((a, b) => (b.rawSuitability - a.rawSuitability) || (a.spotId < b.spotId ? -1 : a.spotId > b.spotId ? 1 : 0));
  const topSpots = sorted.slice(0, 3);
  let spotContrast = "unknown";
  if (rankable.length) {
    const raws = rankable.map((r) => r.rawSuitability);
    const range = _round(Math.max(...raws) - Math.min(...raws), 4);
    spotContrast = range < WHERE_SPOT_CONTRAST_LOW_MAX ? "low" : range < WHERE_SPOT_CONTRAST_MEDIUM_MAX ? "medium" : "high";
  }
  return {
    windowId, topSpots, unrankableSpots, spotContrast,
    diagnostics: {
      rankableCount: rankable.length, totalCount: spotResults.length,
      h3Status: "unresolved_due_to_missing_spot_metadata", // Auftrag Abschnitt 20 — valides Ergebnis, keine Ersatzheuristik
      mode: "shadow",
    },
  };
}

// ---------------------------------------------------------------------------
// WHEN x WHERE FUER EIN EINZELNES FENSTER (Auftrag Abschnitt 8/32/33) — nimmt ein beliebiges
// HI-2B-Fenster (bestWindow ODER ein alternatives Fenster) + die bereits geladene Forecast-Serie.
// Verwendet NUR die Bedingungen WAEHREND dieses Fensters — HI-2B's Opportunity wird an KEINER
// Stelle in die Suitability multipliziert (Auftrag Abschnitt 32: WHEN bestimmt die Zeit, WHERE die
// relative Spotpassung, saubere Trennung).
// ---------------------------------------------------------------------------

function buildWhereForWindow(seriesHours, windowObj, spotIds) {
  if (!windowObj) return null;
  const hoursSubset = _hoursInWindow(seriesHours, windowObj);
  const wc = aggregateWindowConditions(hoursSubset);
  wc.windowConfidence = windowObj.confidence || null; // aus HI-2B (Forecast-Horizont-basiert, Auftrag Abschnitt 28.A)
  const windowId = `${windowObj.startTimestamp}_${windowObj.durationHours}h`;
  const suitability = buildSpotSuitabilityForWindow(wc, spotIds, windowId);
  const top3 = buildTop3ForWindow(suitability, windowId);
  return {
    windowId, startTimestamp: windowObj.startTimestamp, endTimestamp: windowObj.endTimestamp,
    durationHours: windowObj.durationHours, windowConditions: wc,
    suitability, top3, mode: "shadow",
  };
}

// ---------------------------------------------------------------------------
// ORCHESTRATOR (Auftrag Abschnitt 8) — EIN Forecast-Fetch (buildHourlyForecastSeries, HI-2A.1,
// unveraendert), dann die bereits vorhandene, REINE HI-2B-Rankingfunktion
// (buildHourlyWindowRankingSeries) OHNE zweiten Netzwerk-Request wiederverwendet — kein doppeltes
// Laden derselben Daten (runWhenShadowAnalysis() wuerde intern erneut fetchen, wird deshalb hier
// bewusst NICHT aufgerufen).
// ---------------------------------------------------------------------------

function _luebeckerBuchtSpotIds() {
  // NUR die IDs — SPOT_STATS.rohquote/shrunk/n werden an KEINER Stelle in dieser Datei gelesen
  // (Guardrail Auftrag Abschnitt 30/31, technisch: kein Zugriff auf diese Felder im gesamten File).
  const stats = window.FIMefoModel ? window.FIMefoModel.SPOT_STATS : {};
  return Object.keys(stats).filter((k) => k !== "ostsee_allgemein");
}

async function runWhereShadowAnalysis(waterId, speciesId, fishingMode, opts = {}) {
  const scope = checkWhereScope(speciesId, waterId, fishingMode);
  if (!scope.supported) return { supported: false, status: scope.status, reasons: scope.reasons, mode: "shadow" };

  _assertWhereGuardrails();
  const series = await window.FIHourlyIntelligence.buildHourlyForecastSeries(waterId, opts);
  const whenRanking = window.FIHourlyWindowIntelligence.buildHourlyWindowRankingSeries(series);
  const spotIds = _luebeckerBuchtSpotIds();
  const includeAlternatives = !!opts.includeAlternativeWindows; // Auftrag Abschnitt 33 — optional, standardmaessig aus

  const days = whenRanking.days.map((day) => {
    const bestWhere = day.bestWindow ? buildWhereForWindow(series.hours, day.bestWindow, spotIds) : null;
    const alternativeWhere = includeAlternatives
      ? day.alternativeWindows.map((w) => buildWhereForWindow(series.hours, w, spotIds)) : [];
    return { localDate: day.localDate, whenBestWindow: day.bestWindow, bestWhere, alternativeWhere, dailyContrast: day.dailyDiagnostics.dailyContrast };
  });

  return {
    supported: true, status: "applicable", mode: "shadow",
    engineVersion: WHERE_ENGINE_VERSION, hypothesisVersion: WHERE_HYPOTHESIS_VERSION,
    whenEngineVersion: whenRanking.engineVersion, whenHypothesisVersion: whenRanking.hypothesisVersion,
    locationId: waterId, speciesId, fishingMode,
    days,
    forecastMetadata: {
      generatedAt: series.generatedAt, startTimestamp: series.startTimestamp, horizonHours: series.horizonHours,
      waterTempSourceStatus: series.waterTempSourceStatus, waterTempModel: series.waterTempModel,
      waveSourceStatus: series.waveSourceStatus, waveModel: series.waveModel, requestLog: series.requestLog,
    },
  };
}

// ---------------------------------------------------------------------------
// SHADOW PERSISTENCE (Auftrag Abschnitt 34) — minimales, UNVERAENDERLICHES Artefakt pro Fenster mit
// mindestens einem rankbaren Spot. KEINE vollstaendige Forecast-Rohserie persistiert (identisches
// Prinzip wie HI-2B Abschnitt 26/29).
// ---------------------------------------------------------------------------

function buildWhereShadowPrediction(dayResult, speciesId, waterId, fishingMode, whenEngineVersion, forecastMetadata) {
  if (!dayResult.bestWhere) return null;
  return {
    id: window.FIDB.newId("where"),
    generatedAt: window.FIDB.nowIso(),
    speciesId, waterId, fishingMode,
    localDate: dayResult.localDate,
    windowId: dayResult.bestWhere.windowId,
    whenEngineVersion, whereEngineVersion: WHERE_ENGINE_VERSION, whereHypothesisVersion: WHERE_HYPOTHESIS_VERSION,
    topSpots: dayResult.bestWhere.top3.topSpots,
    unrankableSpots: dayResult.bestWhere.top3.unrankableSpots,
    spotContrast: dayResult.bestWhere.top3.spotContrast,
    forecastMetadata,
    mode: "shadow",
  };
}

// Jeder Aufruf erzeugt fuer JEDEN Tag mit einem validen bestWhere-Ergebnis einen NEUEN Eintrag
// (eigene id via FIDB.newId) — ein spaeterer Lauf ueberschreibt NIE eine bestehende Prediction
// (identisches Unveraenderlichkeits-Prinzip wie HI-2B/HI-1).
async function persistWhereShadowPredictions(waterId, speciesId, fishingMode, opts = {}) {
  const scope = checkWhereScope(speciesId, waterId, fishingMode);
  if (!scope.supported) return { supported: false, status: scope.status, reasons: scope.reasons, persisted: [] };
  _assertWhereGuardrails();
  const result = await runWhereShadowAnalysis(waterId, speciesId, fishingMode, opts);
  const persisted = [];
  for (const day of result.days) {
    const rec = buildWhereShadowPrediction(day, speciesId, waterId, fishingMode, result.whenEngineVersion, result.forecastMetadata);
    if (!rec) continue;
    try {
      await window.FIDB.put("where_spot_shadow_prediction", rec);
      persisted.push(rec);
    } catch (e) {
      console.warn("HI-2C Where-Shadow-Prediction konnte nicht gespeichert werden (produktive Daten unberührt):", e);
    }
  }
  return { supported: true, status: "applicable", persisted };
}

if (typeof window !== "undefined") {
  window.FIWhereIntelligence = {
    WHERE_ENGINE_VERSION, WHERE_HYPOTHESIS_VERSION, WHERE_INTELLIGENCE_MODE,
    WHERE_SUPPORTED_SPECIES, WHERE_SUPPORTED_WATER, WHERE_SUPPORTED_FISHING_MODE,
    WHERE_BASE_SUITABILITY, WHERE_WAVE_ONSHORE_WEIGHT, WHERE_RELATIVE_SUITABILITY_FLOOR,
    WHERE_SPOT_CONTRAST_LOW_MAX, WHERE_SPOT_CONTRAST_MEDIUM_MAX,
    // Test-Hooks (reine Funktionen, analog zu FIHourlyWindowIntelligence)
    checkWhereScope, aggregateWindowConditions, buildSpotSuitabilityForWindow, buildTop3ForWindow,
    buildWhereForWindow,
    runWhereShadowAnalysis, buildWhereShadowPrediction, persistWhereShadowPredictions,
  };
}
