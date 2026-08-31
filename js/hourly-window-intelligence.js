// Sea Trout WHEN Shadow Engine — Hourly Opportunity & 2-3h Window Ranking (Phase HI-2B, 31.08.2026).
// Baut auf dem live-verifizierten HI-2A.1-Stand auf (build phase-hi2a1-marine-hotfix-v21-2026-08-31,
// siehe HOURLY_INTELLIGENCE_SHADOW.md, PHASE_HI2A1_MARINE_HOTFIX_IMPLEMENTATION_REPORT.md). Erstmals
// entsteht hier eine WHEN-Logik ("welche 2-3 Stunden eines Tages erscheinen relativ interessanter?")
// — weiterhin STRIKT SHADOW: keine produktive Fangprognose, keine absolute Fangwahrscheinlichkeit,
// keine WHERE-/Spot-Empfehlung (siehe Auftrag HI-2B Abschnitt 0/4).
//
// EIGENE DATEI (statt Erweiterung von hourly-intelligence.js): reine additive Konsumenten-Schicht
// ueber buildHourlyForecastSeries() — importiert/veraendert hourly-intelligence.js, providers.js,
// astro.js, meerforelle-model.js, challenger-state.js an KEINER Stelle (Guardrail Abschnitt 0).
// Wiederverwendet ausdruecklich bestehende Konstanten statt neue zu erfinden (siehe unten:
// LIGHT_PHASE_HORIZON_DEG/LIGHT_PHASE_CIVIL_TWILIGHT_DEG aus FIHourlyIntelligence.HI_CONFIG, H1/H2
// aus getShadowHypotheses()).
//
// ===========================================================================
// A. REPOSITORY & RESEARCH AUDIT (Auftrag Abschnitt 1) — Kurzfassung, volle Fassung im
//    HI-2B-Abschlussbericht Abschnitt A/B. Hier nur die Konsequenz fuer diese Datei:
// ===========================================================================
// A. Technisch vorhandene Variablen (HourlyEnvironment/HourlyFeatures, siehe hourly-intelligence.js):
//    solarElevationDeg, minutesFromSunrise/ToSunset, lightPhase, waterTempC, thermalRegime, airTempC,
//    cloudCoverPct, precipitationMm, windSpeedMs/windGustMs/windDirectionDeg, waveHeightM/
//    waveDirectionDeg/wavePeriodSec, pressureHpa, pressureChange3h/6h, waterLevelCm,
//    waterLevelChange1h/3h, waterLevelRateCmH, timeSinceWaterLevelExtremeMin, forecastHorizonHours.
// B. Ausreichende fachliche Evidenz fuer WHEN (siehe Projekt-KB sea_trout_intelligence_kb_v1.md,
//    Kristensen et al. 2018 DST-Telemetrie: klares Tag/Nacht-Tiefenmuster, ABER temperaturabhaengig
//    — oberhalb ~17 Grad C weichen mehrere Fische vom normalen Rhythmus ab; KB formuliert dies
//    explizit als Interaktion "Licht veraendert den Wert desselben Habitats... sehr warmes Wasser
//    kann dieses Muster ueberschreiben"): solarElevationDeg (kontinuierlich, H2) UND thermalRegime/
//    waterTempC als Interaktionskontext (H1). lightPhase nur als Label/Reason-Code, NICHT als
//    primaere Rechengroesse (Auftrag Abschnitt 8: kontinuierliche Elevation statt diskreter Sprung).
// C. Gehoeren primaer zu WHERE (Auftrag Abschnitt 2/12, hier NICHT gewichtet): windDirectionDeg/
//    windSpeedMs, waveDirectionDeg/waveHeightM/wavePeriodSec, alle spot-relativen Wind-/
//    Wellenfeatures (H4), depthAccessClass/currentExposureClass (H3 — existieren im Datenmodell noch
//    nicht, koennen also technisch ohnehin nicht gewichtet werden).
// D. Derzeit nur Validation-/Research-Variablen (Auftrag Abschnitt 10/11/13, H5): pressureHpa/
//    pressureChange3h/6h (persoenlicher Fangbuch-Backtest: p=0.11, kein signifikanter Effekt, Richtung
//    sogar gegen die Regen-Folklore, siehe fangindex_backtest_zusammenfassung.md), precipitationMm
//    (keine within-day-Evidenz gefunden), waterLevelCm/-Change1h/3h/-RateCmH/
//    timeSinceWaterLevelExtremeMin (STI-010 "30-60 Min nach Hochwasser" explizit
//    INSUFFICIENT_EVIDENCE, persoenliche Daten r=0.045/p=0.29 — kein Effekt), cloudCoverPct
//    (fachlich plausibel, aber schwaechere Evidenz als Solarposition — nur als
//    Score-neutrale Diagnose gespeichert, siehe Abschnitt 9 unten, KEINE Sensitivity-Variante B
//    gebaut, weil nicht einmal eine RICHTUNG belegt ist, nur eine vage Plausibilitaet).
// E. Duerfen in HI-2B DESHALB NICHT gewichtet werden: alle unter C und D genannten Variablen — sie
//    fliessen an KEINER Stelle dieser Datei in rawOpportunity/relativeOpportunity ein (verifiziert
//    per Test: components enthaelt AUSSCHLIESSLICH solar/thermalContext/solarThermalInteraction).
//
// Mathematische Kernidee (Auftrag Abschnitt 6/7/8, "so klein wie moeglich", keine additive
// Bastel-Formel, keine erfundene exakte Effektgroesse):
//
//   lowSolarProxy(elevationDeg) = kontinuierliche, monotone Sigmoid-Transformation von
//     solarElevationDeg, zentriert auf den MITTELPUNKT der bereits bestehenden Light-Phase-Grenzen
//     (-0.833 Grad / -6.0 Grad aus astro.js/hourly-intelligence.js, NICHT neu erfunden) -> Werte nahe
//     0 bei Tageslicht, nahe 1 bei Nacht, glatter Uebergang OHNE Sprung exakt an den beiden
//     Referenzgrenzen (Auftrag Abschnitt 8 explizit gefordert).
//
//   rawOpportunity = WHEN_BASE_OPPORTUNITY + WHEN_THERMAL_SOLAR_WEIGHT[thermalRegime] * lowSolarProxy
//
//   Die Gewichte je Regime sind explizit EXPERIMENTAL (siehe WHEN_THERMAL_SOLAR_WEIGHT unten) — die
//   vorhandene Evidenz belegt nur eine MONOTONE ORDNUNG (cold <= moderate < warm < very_warm), KEINE
//   exakte Effektgroesse. Fuer cold/moderate ist das Gewicht bewusst sehr klein/null (KB: "kein
//   automatischer Morgenbonus" ausserhalb der Waermeregime) -> an kalten/maessigen Tagen ist die
//   Tageszeit-Differenzierung strukturell fast flach (kein pauschaler Dawn/Dusk-Hype, siehe Test C).
//   Tageslicht-Stunden bekommen NIE einen Abzug unter die Baseline (lowSolarProxy >= 0, Gewicht >= 0)
//   -> ein Wintermittag wird NIE automatisch abgestraft (Test D), er ist bestenfalls "neutral".
// ===========================================================================

const WHEN_ENGINE_VERSION = "HI-2B-2026-08-31";
const WHEN_HYPOTHESIS_VERSION = "when-hypothesis-v1-2026-08-31";

// EXPERIMENTAL — siehe Herleitung oben. Monoton steigend cold -> very_warm, exakte Zahlen sind
// Platzhalter fuer eine spaetere Prospective-Validation-Kalibration, KEINE kalibrierten Effektgroessen.
const WHEN_THERMAL_SOLAR_WEIGHT = { cold: 0.0, moderate: 0.12, warm: 0.5, very_warm: 0.85 };
const WHEN_BASE_OPPORTUNITY = 0.5;

// Schwelle fuer die Reason-Code-Klassifikation "Low Solar" — bewusst der Sigmoid-Mittelpunkt selbst
// (s=0.5 bei elevation = Mittelpunkt von -0.833/-6.0 Grad), keine zusaetzliche freie Zahl.
const WHEN_LOW_SOLAR_THRESHOLD = 0.5;

// Daily-Contrast-Schwellen (Auftrag Abschnitt 24) — EXPERIMENTAL, aber selbst-konsistent an der
// Gewichts-Skala oben verankert: cold (Gewicht 0) faellt IMMER unter "low", moderate (0.12) liegt an
// der low/medium-Grenze, warm/very_warm (0.5/0.85) liegen sicher in "high".
const WHEN_DAILY_CONTRAST_LOW_MAX = 0.05;
const WHEN_DAILY_CONTRAST_MEDIUM_MAX = 0.25;

// Floor fuer die pro-Tag-Normalisierung (Auftrag Abschnitt 24, "very flat days"): verhindert, dass
// eine winzige rohe Spannweite optisch auf 0..100 aufgeblasen wird — der Nenner der Min-Max-Skalierung
// wird nie kleiner als dieser Wert, auch wenn die tatsaechliche Tagesspannweite kleiner ist.
const WHEN_RELATIVE_OPPORTUNITY_FLOOR = 0.2;

// Confidence-Horizont-Stufen (Auftrag Abschnitt 17/18) — wiederverwenden dieselben 24h/72h-
// Referenzpunkte, die im HI-2A-Debug-Panel bereits als Beispielstunden benutzt werden (kein neu
// erfundenes Zahlenpaar, siehe app.js "erste, ~+24h, ~+72h, letzte"). Confidence beschreibt
// AUSSCHLIESSLICH Daten-/Forecast-Vertrauen (Distanz zum Erstellungszeitpunkt), NIE die Hoehe von
// rawOpportunity/relativeOpportunity — beide werden strikt getrennt berechnet (Test: Section 34).
const WHEN_CONFIDENCE_HORIZON_HIGH_MAX_H = 24;
const WHEN_CONFIDENCE_HORIZON_MEDIUM_MAX_H = 72;

const WHEN_CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

// ---------------------------------------------------------------------------
// SOLAR-TRANSFORMATION (Auftrag Abschnitt 8)
// ---------------------------------------------------------------------------

function _lowSolarProxy(elevationDeg) {
  const cfg = window.FIHourlyIntelligence.HI_CONFIG;
  const center = (cfg.LIGHT_PHASE_HORIZON_DEG + cfg.LIGHT_PHASE_CIVIL_TWILIGHT_DEG) / 2;
  const scale = (cfg.LIGHT_PHASE_HORIZON_DEG - cfg.LIGHT_PHASE_CIVIL_TWILIGHT_DEG) / 4;
  return 1 / (1 + Math.exp((elevationDeg - center) / scale));
}

function _confidenceForHorizon(horizonHours) {
  if (horizonHours === null || horizonHours === undefined) return "low";
  if (horizonHours <= WHEN_CONFIDENCE_HORIZON_HIGH_MAX_H) return "high";
  if (horizonHours <= WHEN_CONFIDENCE_HORIZON_MEDIUM_MAX_H) return "medium";
  return "low";
}

function _worstConfidence(list) {
  return list.reduce((worst, c) => (WHEN_CONFIDENCE_RANK[c] < WHEN_CONFIDENCE_RANK[worst] ? c : worst), "high");
}

// ---------------------------------------------------------------------------
// EXPLAINABILITY (Auftrag Abschnitt 15) — Reason Codes aus der tatsaechlich implementierten Logik
// abgeleitet, keine Marketingtexte.
// ---------------------------------------------------------------------------

function _reasonsFor(regime, s) {
  const low = s >= WHEN_LOW_SOLAR_THRESHOLD;
  const reasons = [];
  if (regime === "cold") reasons.push("COLD_SOLAR_WEAK_EFFECT");
  else if (regime === "moderate") reasons.push("MODERATE_SOLAR_NEUTRAL");
  else if (regime === "warm") reasons.push(low ? "WARM_LOW_SOLAR" : "WARM_HIGH_SOLAR");
  else if (regime === "very_warm") reasons.push(low ? "VERY_WARM_LOW_SOLAR" : "VERY_WARM_HIGH_SOLAR");
  if ((regime === "warm" || regime === "very_warm") && low) reasons.push("H1_ACTIVE");
  return reasons;
}

function _debugNote(regime, reasons) {
  if (reasons.includes("H1_ACTIVE")) {
    return `${regime === "very_warm" ? "Sehr warmes" : "Warmes"} Wasser; niedrige Sonnenhöhe erhöht die relative zeitliche Opportunity unter H1 (Shadow-Hypothese, keine bewiesene Fangregel).`;
  }
  if (regime === "cold") return "Kaltes Wasser; kaum Differenzierung nach Sonnenhöhe in diesem Regime (Shadow-Hypothese).";
  if (regime === "moderate") return "Mäßige Wassertemperatur; geringe Differenzierung nach Sonnenhöhe (Shadow-Hypothese).";
  return "Tageslicht-nahe Bedingungen; in diesem Wassertemperatur-Regime aktuell kein erhöhter Low-Solar-Effekt modelliert (Shadow-Hypothese).";
}

function _evidenceText() {
  const hyps = (window.FIHourlyIntelligence && window.FIHourlyIntelligence.getShadowHypotheses)
    ? window.FIHourlyIntelligence.getShadowHypotheses() : [];
  const h1 = hyps.find((h) => h.id === "H1"), h2 = hyps.find((h) => h.id === "H2");
  const part = (h) => (h ? `${h.id} (${h.title}, Status: ${h.status})` : null);
  return [part(h1), part(h2)].filter(Boolean).join(" + ") || "H1/H2 (shadow)";
}

// ---------------------------------------------------------------------------
// HOURLY OPPORTUNITY (Auftrag Abschnitt 14/16/17) — rein synchron/pure: konsumiert bereits geladene
// HourlyEnvironment/HourlyFeatures-Paare (aus buildHourlyForecastSeries().hours), macht KEINEN
// eigenen Netzwerkaufruf. relativeOpportunity bleibt hier bewusst NULL — sie ist erst nach der
// Tagesgruppierung (siehe buildDailyWindowRanking()) sinnvoll definierbar (Auftrag Abschnitt 5:
// "pro Tag normalisiert").
// ---------------------------------------------------------------------------

function _computeHourOpportunity(environment, features) {
  const timestamp = environment.timestamp;
  const horizonHours = environment.forecastHorizonHours;
  const elevation = environment.solarElevationDeg;
  const regime = features ? features.thermalRegime : null;

  if (elevation === null || elevation === undefined) {
    return {
      timestamp, rawOpportunity: null, relativeOpportunity: null,
      components: { solar: { elevationDeg: null, lowSolarProxy: null },
        thermalContext: { regime: regime || "unknown", weight: null }, solarThermalInteraction: null },
      evidence: _evidenceText(), confidence: "low", reasons: ["MISSING_SOLAR"],
      debugNote: "Sonnenhöhe fehlt — Opportunity nicht belastbar berechenbar (kein Default).",
      mode: "shadow",
    };
  }
  if (!regime || regime === "unknown") {
    return {
      timestamp, rawOpportunity: null, relativeOpportunity: null,
      components: { solar: { elevationDeg: elevation, lowSolarProxy: Math.round(_lowSolarProxy(elevation) * 1000) / 1000 },
        thermalContext: { regime: "unknown", weight: null }, solarThermalInteraction: null },
      evidence: _evidenceText(), confidence: "low", reasons: ["MISSING_WATER_TEMP"],
      debugNote: "Wassertemperatur fehlt — Opportunity nicht belastbar berechenbar (kein Default).",
      mode: "shadow",
    };
  }

  const s = _lowSolarProxy(elevation);
  const weight = WHEN_THERMAL_SOLAR_WEIGHT[regime];
  const interaction = Math.round(weight * s * 10000) / 10000;
  const raw = Math.round((WHEN_BASE_OPPORTUNITY + interaction) * 10000) / 10000;
  const reasons = _reasonsFor(regime, s);

  return {
    timestamp, rawOpportunity: raw, relativeOpportunity: null,
    components: {
      solar: { elevationDeg: elevation, lowSolarProxy: Math.round(s * 1000) / 1000 },
      thermalContext: { regime, weight },
      solarThermalInteraction: interaction,
    },
    evidence: _evidenceText(),
    confidence: _confidenceForHorizon(horizonHours),
    reasons,
    debugNote: _debugNote(regime, reasons),
    mode: "shadow",
  };
}

// hours: [{environment, features}, ...] — z.B. direkt aus buildHourlyForecastSeries().hours, oder
// synthetisch fuer Tests. Reine Funktion, KEIN Netzwerkzugriff, KEIN State.
function buildHourlyOpportunitySeries(hours) {
  if (!Array.isArray(hours)) return [];
  return hours.map((h) => _computeHourOpportunity(h.environment, h.features || {}));
}

// ---------------------------------------------------------------------------
// TAGESGRUPPIERUNG (Auftrag Abschnitt 19) — lokal Europe/Berlin, DST-sicher via Intl (keine manuelle
// Offset-Arithmetik -> kein Risiko einer doppelten/verlorenen Stunde). Sonnenberechnung selbst bleibt
// unangetastet UTC-basiert (hourly-intelligence.js/astro.js) — hier wird NUR die Darstellung/
// Gruppierung lokalisiert.
// ---------------------------------------------------------------------------

const _berlinDateFormatter = (typeof Intl !== "undefined")
  ? new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" })
  : null;

function _localDateKeyBerlin(dt) {
  if (_berlinDateFormatter) return _berlinDateFormatter.format(dt); // "YYYY-MM-DD"
  // Fallback (im Browser praktisch nie noetig): grobe Naeherung, NICHT DST-exakt.
  return new Date(dt.getTime() + 3600000).toISOString().slice(0, 10);
}

// Gruppiert die bereits berechnete Opportunity-Serie 1:1 nach lokalem Kalendertag. Da
// buildHourlyForecastSeries() lueckenlos EINE Stunde nach der anderen liefert (Abschnitt 4 der
// HI-2A-Doku, exaktes Timestamp-Matching) UND die Map-Insertion-Order chronologisch ist, ist jede
// Tagesgruppe automatisch eine zusammenhaengende, chronologisch sortierte Teilfolge — auch an einem
// DST-Umstellungstag (23 bzw. 25 Eintraege statt 24), OHNE Sonderfallbehandlung.
function groupOpportunityByLocalDate(forecastSeries, opportunitySeries) {
  const groups = new Map();
  forecastSeries.hours.forEach((h, i) => {
    const localDate = _localDateKeyBerlin(new Date(h.environment.timestamp));
    if (!groups.has(localDate)) groups.set(localDate, []);
    groups.get(localDate).push({ environment: h.environment, features: h.features, opportunity: opportunitySeries[i] });
  });
  return [...groups.entries()].map(([localDate, entries]) => ({ localDate, entries }));
}

// ---------------------------------------------------------------------------
// DAILY CONTRAST + RELATIVE NORMALISIERUNG (Auftrag Abschnitt 5/24)
// ---------------------------------------------------------------------------

function computeDailyContrast(entries) {
  const validRaw = entries.map((e) => e.opportunity.rawOpportunity).filter((v) => v !== null);
  if (!validRaw.length) {
    return { dailyContrast: "unknown", dayRawRange: null, dayMin: null, dayMax: null,
      validHourCount: 0, totalHourCount: entries.length };
  }
  const dayMin = Math.min(...validRaw), dayMax = Math.max(...validRaw);
  const range = Math.round((dayMax - dayMin) * 10000) / 10000;
  let dailyContrast;
  if (range < WHEN_DAILY_CONTRAST_LOW_MAX) dailyContrast = "low";
  else if (range < WHEN_DAILY_CONTRAST_MEDIUM_MAX) dailyContrast = "medium";
  else dailyContrast = "high";
  return { dailyContrast, dayRawRange: range, dayMin, dayMax, validHourCount: validRaw.length, totalHourCount: entries.length };
}

// Min-Max-Normalisierung auf 0..100, ABER mit festem Floor-Nenner (Auftrag Abschnitt 24): eine
// winzige Tagesspannweite wird NICHT kuenstlich auf die volle 0..100-Skala gestreckt. Bei normalem/
// hohem Kontrast (Spannweite >= Floor) verhaelt sich das identisch zu reinem Min-Max (bester Wert
// des Tages = 100, schlechtester = 0).
function _relativeFromRaw(raw, dayMin, dayMax) {
  if (raw === null || dayMin === null || dayMax === null) return null;
  const range = Math.max(dayMax - dayMin, WHEN_RELATIVE_OPPORTUNITY_FLOOR);
  const rel = ((raw - dayMin) / range) * 100;
  return Math.round(Math.max(0, Math.min(100, rel)) * 10) / 10;
}

// ---------------------------------------------------------------------------
// WINDOW BUILDER (Auftrag Abschnitt 20/21/22) — 2h/3h zusammenhaengende Fenster, robuste
// Aggregation (Mittelwert statt max(hour), Auftrag Abschnitt 21: "kein willkuerliches Peak-Chasing"),
// Overlap-Deduplizierung via einfacher, dokumentierter Non-Maximum-Suppression (Auftrag Abschnitt 22).
// ---------------------------------------------------------------------------

// Nur zusammenhaengende Fenster OHNE fehlende Kernstunde (Auftrag Abschnitt 20: "Keine Fenster mit
// fehlenden Kernstunden als vollwertig behandeln") — ein Fenster mit auch nur einer null-Opportunity-
// Stunde wird NICHT als Kandidat erzeugt (kein degradiertes/teilweises Fenster).
function buildWindowCandidates(entries, durationHours, dayMin, dayMax, localDate) {
  const candidates = [];
  for (let i = 0; i + durationHours <= entries.length; i++) {
    const slice = entries.slice(i, i + durationHours);
    if (slice.some((e) => e.opportunity.rawOpportunity === null)) continue;
    const raws = slice.map((e) => e.opportunity.rawOpportunity);
    // Aggregation = arithmetisches Mittel (dokumentierte Wahl, siehe Auftrag Abschnitt 21): bei 2-3
    // Werten praktisch aequivalent zum Median, aber einfacher/transparenter zu erklaeren; max(hour)
    // ist ausdruecklich verboten (kein Peak-Chasing).
    const windowRaw = Math.round((raws.reduce((a, b) => a + b, 0) / raws.length) * 10000) / 10000;
    const windowRel = _relativeFromRaw(windowRaw, dayMin, dayMax);
    const confidence = _worstConfidence(slice.map((e) => e.opportunity.confidence));
    const reasons = [...new Set(slice.flatMap((e) => e.opportunity.reasons))];
    reasons.push(`CONTIGUOUS_${durationHours}H`);
    candidates.push({
      localDate,
      startTimestamp: slice[0].environment.timestamp,
      endTimestamp: slice[slice.length - 1].environment.timestamp,
      durationHours,
      windowRawOpportunity: windowRaw,
      windowRelativeOpportunity: windowRel,
      confidence,
      hourCount: slice.length,
      reasons,
      mode: "shadow",
    });
  }
  return candidates;
}

function _windowsOverlap(a, b) {
  const aStart = Date.parse(a.startTimestamp), aEnd = Date.parse(a.endTimestamp) + 3600000;
  const bStart = Date.parse(b.startTimestamp), bEnd = Date.parse(b.endTimestamp) + 3600000;
  return aStart < bEnd && bStart < aEnd;
}

// Einfache, dokumentierte Auswahlregel (Auftrag Abschnitt 22): sortiere nach windowRawOpportunity
// absteigend, nimm greedy jedes Fenster, das mit KEINEM bereits ausgewaehlten (hoeher gerankten)
// Fenster stundenweise ueberlappt. Liefert bis zu maxSelected nicht-ueberlappende Kandidaten
// (bestWindow + Alternativen) statt drei fast identischer Fenster.
function deduplicateOverlapping(candidates, maxSelected = 3) {
  const sorted = [...candidates].sort((a, b) => b.windowRawOpportunity - a.windowRawOpportunity);
  const selected = [];
  for (const c of sorted) {
    if (selected.some((s) => _windowsOverlap(s, c))) continue;
    selected.push(c);
    if (selected.length >= maxSelected) break;
  }
  return selected;
}

// ---------------------------------------------------------------------------
// DAILY RANKING (Auftrag Abschnitt 23/24/25) — Ranking gilt AUSSCHLIESSLICH innerhalb des jeweiligen
// lokalen Tages, es existiert an KEINER Stelle eine Cross-Day-Vergleichsfunktion (Auftrag Abschnitt
// 37: "noch nicht Ziel von HI-2B").
// ---------------------------------------------------------------------------

function buildDailyWindowRanking(localDate, entries) {
  const contrastInfo = computeDailyContrast(entries);
  // relativeOpportunity wird JETZT (nach Tagesgruppierung) auf den Kopien der Stunden-Objekte gesetzt
  // — die urspruenglichen Objekte aus buildHourlyOpportunitySeries() werden nicht mutiert.
  const hoursOut = entries.map((e) => ({
    timestamp: e.environment.timestamp,
    solarElevationDeg: e.environment.solarElevationDeg,
    waterTempC: e.environment.waterTempC,
    lightPhase: e.environment.lightPhase,
    opportunity: { ...e.opportunity, relativeOpportunity: _relativeFromRaw(e.opportunity.rawOpportunity, contrastInfo.dayMin, contrastInfo.dayMax) },
  }));

  const cand3h = buildWindowCandidates(entries, 3, contrastInfo.dayMin, contrastInfo.dayMax, localDate);
  const cand2h = buildWindowCandidates(entries, 2, contrastInfo.dayMin, contrastInfo.dayMax, localDate);
  const sel3h = deduplicateOverlapping(cand3h);
  const sel2h = deduplicateOverlapping(cand2h);

  const lowContrast = contrastInfo.dailyContrast === "low";
  const tag = (w) => {
    if (!w) return null;
    if (!lowContrast) return w;
    return { ...w, reasons: [...new Set([...w.reasons, "LOW_DAILY_CONTRAST"])] };
  };

  const windows3h = { candidateCount: cand3h.length, bestWindow: tag(sel3h[0] || null), alternativeWindows: sel3h.slice(1).map(tag) };
  const windows2h = { candidateCount: cand2h.length, bestWindow: tag(sel2h[0] || null), alternativeWindows: sel2h.slice(1).map(tag) };

  const diagReasons = [];
  if (lowContrast) diagReasons.push("LOW_DAILY_CONTRAST");
  if (cand3h.length === 0 && cand2h.length === 0) diagReasons.push("NO_VALID_WINDOW");

  return {
    localDate,
    // "Bevorzugt zunaechst: 3-Stunden-Fenster" (Auftrag Abschnitt 20) -> bestWindow/alternativeWindows
    // auf Top-Level sind die 3h-Ergebnisse; 2h-Fenster bleiben parallel unter windows2h verfuegbar.
    bestWindow: windows3h.bestWindow,
    alternativeWindows: windows3h.alternativeWindows,
    dailyDiagnostics: { ...contrastInfo, reasons: diagReasons },
    windows3h, windows2h,
    hours: hoursOut,
  };
}

function buildHourlyWindowRankingSeries(forecastSeries) {
  const opportunitySeries = buildHourlyOpportunitySeries(forecastSeries.hours);
  const groups = groupOpportunityByLocalDate(forecastSeries, opportunitySeries);
  const days = groups.map((g) => buildDailyWindowRanking(g.localDate, g.entries));
  return { engineVersion: WHEN_ENGINE_VERSION, hypothesisVersion: WHEN_HYPOTHESIS_VERSION, locationId: forecastSeries.locationId, days, mode: "shadow" };
}

// ---------------------------------------------------------------------------
// ORCHESTRATOR (einziger Aufrufer mit Netzwerkzugriff — ruft die bereits bestehende, unveraenderte
// buildHourlyForecastSeries() aus hourly-intelligence.js auf, siehe Guardrail-Kommentar oben).
// ---------------------------------------------------------------------------

async function runWhenShadowAnalysis(waterId, opts = {}) {
  const series = await window.FIHourlyIntelligence.buildHourlyForecastSeries(waterId, opts);
  const ranking = buildHourlyWindowRankingSeries(series);
  return {
    ...ranking,
    forecastMetadata: {
      generatedAt: series.generatedAt, startTimestamp: series.startTimestamp, horizonHours: series.horizonHours,
      waterTempSourceStatus: series.waterTempSourceStatus, waterTempModel: series.waterTempModel,
      waveSourceStatus: series.waveSourceStatus, waveModel: series.waveModel,
      requestLog: series.requestLog,
    },
  };
}

// ---------------------------------------------------------------------------
// SHADOW PERSISTENCE (Auftrag Abschnitt 26/27) — minimales, UNVERAENDERLICHES Prediction-Artefakt
// pro lokalem Tag mit validem bestWindow. KEINE vollstaendige 121h-Rohserie wird persistiert
// (Begruendung siehe HI-2B-Abschlussbericht Abschnitt J, identisches Prinzip wie die
// Persistenz-Entscheidung aus HI-2A Abschnitt 19: kleinstmoegliches sinnvolles Datenvolumen, solange
// keine spaetere Phase diese Daten tatsaechlich konsumiert).
// ---------------------------------------------------------------------------

function _assertWhenGuardrails() {
  const cfg = window.FIHourlyIntelligence && window.FIHourlyIntelligence.HI_CONFIG;
  if (!cfg || cfg.MODE !== "SHADOW" || cfg.ALLOW_CHAMPION_MUTATION || cfg.ALLOW_PRODUCTION_SCORING || cfg.ALLOW_AUTOMATIC_PROMOTION) {
    throw new Error("WHEN-Intelligence-Guardrail verletzt — Abbruch (siehe Auftrag HI-2B Abschnitt 0).");
  }
}

function buildHourlyWindowShadowPrediction(dayResult, locationId, forecastMetadata) {
  return {
    id: window.FIDB.newId("hiwin"),
    generatedAt: window.FIDB.nowIso(),
    localDate: dayResult.localDate,
    locationId,
    engineVersion: WHEN_ENGINE_VERSION,
    hypothesisVersion: WHEN_HYPOTHESIS_VERSION,
    bestWindow: dayResult.bestWindow,
    alternatives: dayResult.alternativeWindows,
    dailyContrast: dayResult.dailyDiagnostics.dailyContrast,
    forecastMetadata,
    mode: "shadow",
  };
}

// Jeder Aufruf erzeugt fuer JEDEN Tag mit validem bestWindow einen NEUEN Eintrag (eigene id via
// FIDB.newId) — ein spaeterer Forecast-Lauf ueberschreibt NIE eine bestehende Prediction (identisches
// Unveraenderlichkeits-Prinzip wie buildAndPersistHourlyShadowSnapshot() in hourly-intelligence.js).
async function persistHourlyWindowShadowPredictions(waterId, opts = {}) {
  _assertWhenGuardrails();
  const result = await runWhenShadowAnalysis(waterId, opts);
  const persisted = [];
  for (const day of result.days) {
    if (!day.bestWindow) continue;
    const rec = buildHourlyWindowShadowPrediction(day, result.locationId, result.forecastMetadata);
    try {
      await window.FIDB.put("hourly_window_shadow_prediction", rec);
      persisted.push(rec);
    } catch (e) {
      console.warn("HI-2B Window-Shadow-Prediction konnte nicht gespeichert werden (produktive Daten unberührt):", e);
    }
  }
  return persisted;
}

if (typeof window !== "undefined") {
  window.FIHourlyWindowIntelligence = {
    WHEN_ENGINE_VERSION, WHEN_HYPOTHESIS_VERSION,
    WHEN_THERMAL_SOLAR_WEIGHT, WHEN_BASE_OPPORTUNITY, WHEN_LOW_SOLAR_THRESHOLD,
    WHEN_DAILY_CONTRAST_LOW_MAX, WHEN_DAILY_CONTRAST_MEDIUM_MAX, WHEN_RELATIVE_OPPORTUNITY_FLOOR,
    WHEN_CONFIDENCE_HORIZON_HIGH_MAX_H, WHEN_CONFIDENCE_HORIZON_MEDIUM_MAX_H,
    // Test-Hooks (analog zu FIProviders._isOutsideKnownCoverage — reine Funktionen direkt testbar)
    _lowSolarProxy, _localDateKeyBerlin,
    buildHourlyOpportunitySeries,
    groupOpportunityByLocalDate,
    computeDailyContrast,
    buildWindowCandidates,
    deduplicateOverlapping,
    buildDailyWindowRanking,
    buildHourlyWindowRankingSeries,
    runWhenShadowAnalysis,
    buildHourlyWindowShadowPrediction,
    persistHourlyWindowShadowPredictions,
  };
}
