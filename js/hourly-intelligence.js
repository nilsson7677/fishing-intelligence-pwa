// Sea Trout Hourly Intelligence — Data Foundation & Shadow Infrastructure (Phase HI-1, 30.08.2026).
// Siehe docs/HOURLY_INTELLIGENCE_SHADOW.md fuer die vollstaendige Dokumentation (Zweck, Architektur,
// Datenmodell, Hypothesen, Guardrails, Data Gaps).
//
// ZWECK (Datenbasis fuer eine spaetere Engine, die beantworten soll: WANN sind die 2-3
// interessantesten Stunden eines Tages, WELCHE Spots passen dazu): diese Datei baut NUR die
// Datengrundlage (Forecast/Observation -> HourlyEnvironment -> HourlyFeatures -> Shadow-
// Persistenz). Es gibt in HI-1 KEINEN Opportunity-Score, KEIN Fenster-Ranking, KEINE Spot-
// Empfehlung und KEINE einzige neue numerische Fanggewichtung.
//
// ABSOLUTE GUARDRAILS (Auftrag Abschnitt 0) — technisch durchgesetzt ueber die vier Konstanten
// unten, NICHT nur per Kommentar:
//   HOURLY_INTELLIGENCE_MODE = "SHADOW"   -> nichts hier laeuft produktiv/sichtbar
//   ALLOW_CHAMPION_MUTATION  = false      -> diese Datei importiert/veraendert meerforelle-model.js
//                                            an KEINER Stelle
//   ALLOW_PRODUCTION_SCORING = false      -> es existiert keine Funktion, die einen Score/ein Tier/
//                                            eine Fangchance zurueckgibt (nur rohe/abgeleitete
//                                            Umweltfeatures)
//   ALLOW_AUTOMATIC_PROMOTION = false     -> Shadow-Snapshots werden nirgends automatisch in eine
//                                            produktive Anzeige oder Entscheidung uebernommen
// Jede Funktion, die diese Guardrails verletzen wuerde, wirft bewusst einen Fehler statt still
// produktiv zu werden (siehe buildAndPersistHourlyShadowSnapshot()).
//
// BESTEHENDE INFRASTRUKTUR WIEDERVERWENDET (Auftrag Abschnitt 1/21 — keine zweite Wahrheit):
//   - FIAstro (astro.js): Sonnenauf-/-untergang + NEU additiv Sonnenhoehe (solarElevationDeg)
//   - FIRegistry (registry.js): Enrichment-Profile + Referenzkoordinaten pro Gewaesser
//   - FIProviders (providers.js): OpenMeteoProvider (Wetter/Wind/Druck, NEU additiv m/s-Wind),
//     OpenMeteoMarineProvider (Wassertemp/Trend, NEU additiv Wellen), PegelonlineProvider
//     (Pegelstand/Zeitreihe/Trend — bestehende Methoden UNVERAENDERT genutzt), das eingefrorene
//     analyzeWaterLevelPhase() (NUR lesend aufgerufen, siehe buildHourlyFeatures())
//   - FIDB (db.js): neuer Store "hourly_shadow_snapshot" (v6, rein additiv)

// ---------------------------------------------------------------------------
// GUARDRAILS + ZENTRALE KONFIGURATION
// ---------------------------------------------------------------------------

const HOURLY_INTELLIGENCE_MODE = "SHADOW";
const ALLOW_CHAMPION_MUTATION = false;
const ALLOW_PRODUCTION_SCORING = false;
const ALLOW_AUTOMATIC_PROMOTION = false;
const HI_ENGINE_VERSION = "HI-1-2026-08-30";

// Look-ahead-Vermeidung fuer Live-Pegeldaten: identische Schwelle/Prinzip wie das bestehende
// enrichment.js (dort WL_MAX_DATA_AGE_MIN-Nachbarkommentar "Zieldatum zu weit von der Erfassungszeit
// entfernt") — Pegelonline liefert AUSSCHLIESSLICH die aktuelle Live-Zeitreihe, keine Vorhersage.
// Eigener, gleich benannter Wert hier (kein Reexport moeglich, da in enrichment.js modul-intern).
const HI_NEAR_NOW_WINDOW_MIN = 90;

// Light-Phase-Grenzen (Grad Sonnenhoehe). -0.833° ist EXAKT dieselbe Schwelle, die astro.js fuer
// "sunrise_set" verwendet (Refraktion + scheinbarer Sonnenradius) — Tag/Daemmerung-Grenze deckt
// sich damit per Definition mit dem berechneten Sonnenauf-/-untergang. -6.0° ist die astronomisch
// uebliche Grenze der "civil twilight" (buergerliche Daemmerung), ebenfalls bereits in astro.js als
// "civil"-Schwelle verwendet. Beide Werte sind also NICHT neu erfunden, sondern 1:1 aus der
// bestehenden astro.js-Konvention uebernommen (siehe sunEventsJulian()).
const LIGHT_PHASE_HORIZON_DEG = -0.833;
const LIGHT_PHASE_CIVIL_TWILIGHT_DEG = -6.0;

// Thermal-Regime-Bins — AUSDRUECKLICH technische Analyse-Bins, KEINE bewiesene Fanggrenze (Auftrag
// Abschnitt 6). Die 17°C-Grenze ist NICHT neu erfunden, sondern identisch mit der bereits
// bestehenden, dokumentierten "Summer_Heat"-Schwelle in challenger-state.js::regimeOf() (Provenance
// dort: phase2/model_comparison.py) — hier nur als beschreibendes Bin wiederverwendet, OHNE jede
// Punktzahl-Zuordnung. Die uebrigen Grenzen (8°C, 14°C) orientieren sich an den bereits bestehenden,
// validierten tFactor()-Stuetzstellen in meerforelle-model.js (dort 8/12/14/16/20 als Kurvenknicke),
// gerundet auf drei grobe, gut kommunizierbare Bins — ebenfalls keine neu erfundenen Zahlen.
const THERMAL_REGIME_BOUNDARIES_C = { cold_max: 8, moderate_max: 14, warm_max: 17 };

const HI_CONFIG = {
  MODE: HOURLY_INTELLIGENCE_MODE,
  ALLOW_CHAMPION_MUTATION, ALLOW_PRODUCTION_SCORING, ALLOW_AUTOMATIC_PROMOTION,
  ENGINE_VERSION: HI_ENGINE_VERSION,
  FORECAST_MAX_HORIZON_HOURS: 120, // Auftrag Abschnitt 15 — Architektur vorbereiten, keine Confidence-Formel
  NEAR_NOW_WINDOW_MIN: HI_NEAR_NOW_WINDOW_MIN,
  LIGHT_PHASE_HORIZON_DEG, LIGHT_PHASE_CIVIL_TWILIGHT_DEG,
  THERMAL_REGIME_BOUNDARIES_C,
};

function _assertShadowGuardrails() {
  if (HOURLY_INTELLIGENCE_MODE !== "SHADOW" || ALLOW_CHAMPION_MUTATION || ALLOW_PRODUCTION_SCORING || ALLOW_AUTOMATIC_PROMOTION) {
    throw new Error("Hourly-Intelligence-Guardrail verletzt — Abbruch (siehe Auftrag Abschnitt 0).");
  }
}

// ---------------------------------------------------------------------------
// SOLAR FEATURES + LIGHT PHASE (Auftrag Abschnitt 4/5)
// ---------------------------------------------------------------------------

// Grenzen exakt dokumentiert (Auftrag Abschnitt 5, "Dokumentiere exakt, wie die Grenzen definiert
// werden"):
//   elevation >= -0.833°                          -> "day"
//   -6.0° <= elevation < -0.833°, VOR Sonnenmittag -> "dawn"
//   -6.0° <= elevation < -0.833°, NACH Sonnenmittag -> "dusk"
//   elevation < -6.0°                              -> "night"
// lightPhase beschreibt AUSSCHLIESSLICH die Umweltbedingung (Auftrag: keine biologische Wertung,
// dawn/dusk sind nicht "automatisch besser"). Die rohe solarElevationDeg wird IMMER zusaetzlich
// gespeichert, damit eine spaetere Engine nicht von dieser diskreten Kategorie abhaengig ist.
function classifyLightPhase(elevationDeg, isBeforeSolarTransit) {
  if (elevationDeg === null || elevationDeg === undefined) return "night";
  if (elevationDeg >= LIGHT_PHASE_HORIZON_DEG) return "day";
  if (elevationDeg < LIGHT_PHASE_CIVIL_TWILIGHT_DEG) return "night";
  return isBeforeSolarTransit ? "dawn" : "dusk";
}

// computeSolarFeatures(lat, lon, dt) -> { solarElevationDeg, minutesFromSunrise, minutesToSunset,
//   lightPhase, sunriseIso, sunsetIso }
// Rein astronomisch aus UTC-Zeitpunkt + Lat/Lon (siehe astro.js-Kommentar: zeitzonen-/DST-
// unabhaengig). minutesFromSunrise/minutesToSunset beziehen sich auf den Sonnenauf-/-untergang DES
// UTC-KALENDERTAGS von dt (kein Vor-/Zurueckblaettern auf den naechsten Tag) — ein negativer Wert
// bedeutet "noch nicht erreicht", ein grosser positiver Wert spaet in der Nacht ist erwartbar und
// korrekt (siehe HOURLY_INTELLIGENCE_SHADOW.md).
function computeSolarFeatures(lat, lon, dt) {
  if (lat === null || lat === undefined || lon === null || lon === undefined) {
    return { solarElevationDeg: null, minutesFromSunrise: null, minutesToSunset: null, lightPhase: "night", sunriseIso: null, sunsetIso: null };
  }
  const elevation = FIAstro.solarElevationDeg(lat, lon, dt);
  const midnightUtc = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
  const astroProvider = new FIAstro.NOAAAstroProvider();
  const sun = astroProvider.getSunEvents(lat, lon, midnightUtc);
  const sunriseIso = sun.sunrise && sun.sunrise.ok ? sun.sunrise.measured_at : null;
  const sunsetIso = sun.sunset && sun.sunset.ok ? sun.sunset.measured_at : null;
  const minutesFromSunrise = sunriseIso ? Math.round((dt.getTime() - Date.parse(sunriseIso)) / 60000) : null;
  const minutesToSunset = sunsetIso ? Math.round((Date.parse(sunsetIso) - dt.getTime()) / 60000) : null;

  const transit = FIAstro.solarTransitUtc(lat, lon, midnightUtc);
  const isBeforeSolarTransit = transit ? dt.getTime() < transit.getTime() : dt.getUTCHours() < 12;
  const lightPhase = classifyLightPhase(elevation, isBeforeSolarTransit);

  return {
    solarElevationDeg: Math.round(elevation * 100) / 100,
    minutesFromSunrise, minutesToSunset, lightPhase, sunriseIso, sunsetIso,
  };
}

// ---------------------------------------------------------------------------
// THERMAL FEATURES (Auftrag Abschnitt 6)
// ---------------------------------------------------------------------------

function classifyThermalRegime(waterTempC) {
  if (waterTempC === null || waterTempC === undefined) return "unknown";
  if (waterTempC < THERMAL_REGIME_BOUNDARIES_C.cold_max) return "cold";
  if (waterTempC < THERMAL_REGIME_BOUNDARIES_C.moderate_max) return "moderate";
  if (waterTempC < THERMAL_REGIME_BOUNDARIES_C.warm_max) return "warm";
  return "very_warm";
}

// ---------------------------------------------------------------------------
// WIND — SPOT-RELATIVE FEATURES (Auftrag Abschnitt 9). Reine Vektor-Geometrie, KEINE Fangbewertung.
// Spot-Orientierungsdaten existieren im aktuellen Datenmodell noch NICHT (siehe seed-data.js/spot-
// Store: kein Orientierungsfeld) — die Funktion ist deshalb bewusst bereits generisch/aufrufbar,
// liefert aber ohne spotOrientationDeg konsequent null zurueck (siehe HOURLY_INTELLIGENCE_SHADOW.md,
// Data Gaps "Spot Orientation").
// ---------------------------------------------------------------------------

function computeWindShoreFeatures(windDirDeg, windSpeedMs, spotOrientationDeg) {
  if ([windDirDeg, windSpeedMs, spotOrientationDeg].some((v) => v === null || v === undefined)) return null;
  let rel = Math.abs(windDirDeg - spotOrientationDeg) % 360;
  if (rel > 180) rel = 360 - rel;
  const relRad = (rel * Math.PI) / 180;
  const onshoreSigned = windSpeedMs * Math.cos(relRad); // >0 auflandig, <0 ablandig
  const alongShore = windSpeedMs * Math.sin(relRad);
  return {
    relativeWindAngleDeg: Math.round(rel * 10) / 10,
    crossShoreComponent: Math.round(onshoreSigned * 100) / 100,
    alongShoreComponent: Math.round(alongShore * 100) / 100,
    onshoreStrength: Math.round(Math.max(0, onshoreSigned) * 100) / 100,
    offshoreStrength: Math.round(Math.max(0, -onshoreSigned) * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// HOURLY ENVIRONMENT (Auftrag Abschnitt 3) — Forecast/Observation -> ein Datensatz pro Zielstunde.
// Fehlende Provider-Werte werden NIE geschaetzt/imputiert, sondern bleiben null (Auftrag 16).
// ---------------------------------------------------------------------------

async function buildHourlyEnvironment(waterId, targetTimestampIso, opts = {}) {
  const profile = FIRegistry.getProfile(waterId);
  const [lat, lon] = FIRegistry.WATER_REFERENCE_POINTS[waterId] || [null, null];
  const targetDt = new Date(targetTimestampIso);
  const nowMs = Date.now();
  const isNearNow = Math.abs(nowMs - targetDt.getTime()) <= HI_NEAR_NOW_WINDOW_MIN * 60000;

  const env = {
    timestamp: targetDt.toISOString(),
    locationId: waterId,
    solarElevationDeg: null, minutesFromSunrise: null, minutesToSunset: null, lightPhase: "night",
    waterTempC: null, airTempC: null,
    cloudCoverPct: null, precipitationMm: null,
    windSpeedMs: null, windGustMs: null, windDirectionDeg: null,
    waveHeightM: null, waveDirectionDeg: null, wavePeriodSec: null,
    pressureHpa: null,
    waterLevelCm: null,
    forecastGeneratedAt: opts.forecastGeneratedAt || FIDB.nowIso(),
    forecastHorizonHours: (typeof opts.forecastHorizonHours === "number")
      ? opts.forecastHorizonHours : Math.round((targetDt.getTime() - nowMs) / 3600000),
    source: "none",
  };

  if (lat === null || lat === undefined) return env; // kein Referenzpunkt fuer dieses Gewaesser -> nichts erfinden

  Object.assign(env, computeSolarFeatures(lat, lon, targetDt));

  const sources = [];
  if (profile.weatherProvider) {
    const hourly = await profile.weatherProvider.getHourly(lat, lon, targetDt);
    env.airTempC = hourly.air_temp_c?.ok ? hourly.air_temp_c.value : null;
    env.cloudCoverPct = hourly.cloud_cover_pct?.ok ? hourly.cloud_cover_pct.value : null;
    env.precipitationMm = hourly.precipitation_mm?.ok ? hourly.precipitation_mm.value : null;
    env.pressureHpa = hourly.pressure_hpa?.ok ? hourly.pressure_hpa.value : null;
    env.windDirectionDeg = hourly.wind_dir_deg?.ok ? hourly.wind_dir_deg.value : null;
    if (hourly.air_temp_c?.ok) sources.push(profile.weatherProvider.name);

    if (typeof profile.weatherProvider.getHourlyWindMs === "function") {
      const windMs = await profile.weatherProvider.getHourlyWindMs(lat, lon, targetDt);
      env.windSpeedMs = windMs.ok ? windMs.windSpeedMs : null;
      env.windGustMs = windMs.ok ? windMs.windGustMs : null;
    }
  }

  if (profile.waterTempProvider) {
    const wt = await profile.waterTempProvider.getWaterTemp(lat, lon, targetDt);
    env.waterTempC = wt.ok ? wt.value : null;
    if (wt.ok) sources.push(profile.waterTempProvider.name);

    // Wellen: nur wo der Marine-Provider tatsaechlich verwendet wird (Ostseekueste) — Binnengewaesser
    // haben in diesem Projekt keine Wellendatenquelle (dokumentierte Luecke, kein Simulieren).
    if (typeof profile.waterTempProvider.getWaveData === "function") {
      const waves = await profile.waterTempProvider.getWaveData(lat, lon, targetDt);
      env.waveHeightM = waves.ok ? waves.waveHeightM : null;
      env.waveDirectionDeg = waves.ok ? waves.waveDirectionDeg : null;
      env.wavePeriodSec = waves.ok ? waves.wavePeriodSec : null;
    }
  }

  // Wasserstand: Pegelonline liefert AUSSCHLIESSLICH Live-/juengste Messwerte, keine Vorhersage —
  // nur fuer jetzt-nahe Zielstunden ueberhaupt einen Wert setzen (identisches Prinzip wie
  // enrichment.js "waterlevel_phase_status" bei zu weit entferntem targetDt).
  if (profile.waterLevelProvider && profile.waterLevelStationId && isNearNow) {
    const lvl = await profile.waterLevelProvider.getLevel(profile.waterLevelStationId, targetDt);
    env.waterLevelCm = lvl.ok ? lvl.value : null;
    if (lvl.ok) sources.push(profile.waterLevelProvider.name);
  }

  env.source = sources.length ? sources.join("+") : "none";
  return env;
}

// ---------------------------------------------------------------------------
// HOURLY FEATURES (Auftrag Abschnitt 7/8/11) — abgeleitete Groessen aus HourlyEnvironment + Trend-
// Abrufen. Ruft AUSSCHLIESSLICH bestehende, unveraenderte Provider-Funktionen auf (siehe Kommentare
// unten) — das eingefrorene Wasserstandsmodell (analyzeWaterLevelPhase) wird nur LESEND aufgerufen.
// ---------------------------------------------------------------------------

async function buildHourlyFeatures(waterId, environment) {
  const profile = FIRegistry.getProfile(waterId);
  const [lat, lon] = FIRegistry.WATER_REFERENCE_POINTS[waterId] || [null, null];
  const targetDt = new Date(environment.timestamp);
  const nowMs = Date.now();
  const isNearNow = Math.abs(nowMs - targetDt.getTime()) <= HI_NEAR_NOW_WINDOW_MIN * 60000;

  const features = {
    timestamp: environment.timestamp,
    thermalRegime: classifyThermalRegime(environment.waterTempC),
    lightPhase: environment.lightPhase,
    solarElevationDeg: environment.solarElevationDeg,
    pressureChange3h: null, pressureChange6h: null,
    waterLevelChange1h: null, waterLevelChange3h: null, waterLevelRateCmH: null,
    timeSinceWaterLevelExtremeMin: null,
    // Auftrag Abschnitt 7: "Wenn dafuer in HI-1 keine robuste Definition sinnvoll moeglich ist, darf
    // das Feld zunaechst null bleiben. Keine willkuerliche Formel erfinden." — HI-1 bleibt bei null.
    effectiveLightProxy: null,
  };

  if (lat === null || lat === undefined) return features;

  if (profile.weatherProvider && typeof profile.weatherProvider.getPressureTrend === "function") {
    const pTrend = await profile.weatherProvider.getPressureTrend(lat, lon, targetDt, [3, 6]);
    features.pressureChange3h = pTrend[3]?.ok ? pTrend[3].value : null;
    features.pressureChange6h = pTrend[6]?.ok ? pTrend[6].value : null;
  }

  if (profile.waterLevelProvider && profile.waterLevelStationId && isNearNow) {
    // getTrendMultiWindow() ist die bestehende, generische Funktion aus providers.js (bisher mit
    // [6,12,24] aufgerufen) — hier NUR mit einem anderen hoursBackList-Parameter ([1,3]) erneut
    // aufgerufen, KEINE Code-Aenderung an providers.js noetig/erfolgt.
    const deltas = await profile.waterLevelProvider.getTrendMultiWindow(profile.waterLevelStationId, targetDt, [1, 3]);
    features.waterLevelChange1h = deltas[1]?.ok ? deltas[1].value : null;
    features.waterLevelChange3h = deltas[3]?.ok ? deltas[3].value : null;

    try {
      const seriesRes = await profile.waterLevelProvider.getLevelSeries(profile.waterLevelStationId);
      if (seriesRes.ok) {
        // NUR LESENDER Aufruf des bestehenden, eingefrorenen Wasserstandsmodells (Guardrail
        // Abschnitt 0: "Wasserstandsmodell" bleibt unveraendert) — liefert Rate + ggf. den juengsten
        // lokalen Hochstand (Maximum). Ein lokales MINIMUM erkennt dieses Modell nicht; eine neue
        // Parallel-Erkennung dafuer wurde in HI-1 bewusst NICHT gebaut (siehe Data Gaps in
        // HOURLY_INTELLIGENCE_SHADOW.md) — "falls robust bestimmbar" (Auftrag Abschnitt 8) ist fuer
        // Minima mit der bestehenden Infrastruktur nicht gegeben, also ehrlich null statt geraten.
        const phase = FIProviders.analyzeWaterLevelPhase(seriesRes.raw, targetDt.getTime());
        if (phase.ok) {
          features.waterLevelRateCmH = phase.rateCmPerHour;
          if (phase.peakTime) features.timeSinceWaterLevelExtremeMin = phase.minutesSincePeak;
        }
      }
    } catch (e) {
      // Nebenrechnung darf HI-1 nie zum Abbruch bringen (Local-First-Prinzip, siehe enrichment.js).
    }
  }

  return features;
}

// ---------------------------------------------------------------------------
// SHADOW HYPOTHESIS REGISTRY (Auftrag Abschnitt 13) — transparent, erweiterbar, KEINE automatische
// Bewertung in HI-1.
// ---------------------------------------------------------------------------

const SHADOW_HYPOTHESES = [
  { id: "H1", title: "Warm Water × Low Solar",
    description: "Bei warmem Wasser ist die relative Fangchance bei niedriger Sonnenhoehe bzw. nachts hoeher als bei hoher Sonnenhoehe.",
    status: "shadow", version: "1", createdAt: "2026-08-30" },
  { id: "H2", title: "Solar Position > Clock Time",
    description: "Solar elevation bzw. Zeit relativ zu Sunrise/Sunset erklaert zeitliche Unterschiede besser als feste Uhrzeiten.",
    status: "shadow", version: "1", createdAt: "2026-08-30" },
  { id: "H3", title: "Summer Deep/Current Exception",
    description: "Bei warmem Wasser wird ein moeglicher Tagesnachteil an Spots mit schnellem Zugang zu tieferem Wasser bzw. hoher Stroemungsdynamik abgeschwaecht.",
    status: "shadow", version: "1", createdAt: "2026-08-30" },
  { id: "H4", title: "Spot-relative Wind/Wave Exposure",
    description: "Spot-relative Wind-/Wellenexposition erklaert Unterschiede besser als absolute Windrichtung.",
    status: "shadow", version: "1", createdAt: "2026-08-30" },
  { id: "H5", title: "Water-Level Null Hypothesis",
    description: "Wasserstandstrend bzw. Zeit seit einem lokalen Extrem liefert nach Kontrolle von Wind, Wellen, Tageszeit und Spot nur geringe zusaetzliche Vorhersagekraft.",
    status: "shadow", version: "1", createdAt: "2026-08-30" },
];

// Kopie zurueckgeben, damit ein Aufrufer das eingefrorene Register nicht versehentlich mutiert.
function getShadowHypotheses() { return SHADOW_HYPOTHESES.map((h) => ({ ...h })); }

// ---------------------------------------------------------------------------
// SHADOW SNAPSHOT (Auftrag Abschnitt 14) — persistiert environment+features EINGEFROREN. Spaetere
// Forecast-Updates ueberschreiben NIE einen bestehenden Snapshot (immer neue id via FIDB.newId).
// ---------------------------------------------------------------------------

async function buildAndPersistHourlyShadowSnapshot(waterId, targetTimestampIso, opts = {}) {
  _assertShadowGuardrails();
  const environment = await buildHourlyEnvironment(waterId, targetTimestampIso, opts);
  const features = await buildHourlyFeatures(waterId, environment);
  const snapshot = {
    id: FIDB.newId("hisnap"),
    generatedAt: FIDB.nowIso(),
    targetTimestamp: environment.timestamp,
    locationId: waterId,
    environment, features,
    engineVersion: HI_ENGINE_VERSION,
    mode: "shadow",
  };
  try {
    await FIDB.put("hourly_shadow_snapshot", snapshot);
  } catch (e) {
    // Local-First/Fail-safe-Prinzip dieser Codebasis: ein Shadow-Persistenzfehler darf NIE die
    // produktive App-Nutzung beeintraechtigen (siehe shadow.js/sync.js fuer dasselbe Muster).
    console.warn("Hourly-Shadow-Snapshot konnte nicht gespeichert werden (produktive Daten unberuehrt):", e);
  }
  return snapshot;
}

if (typeof window !== "undefined") {
  window.FIHourlyIntelligence = {
    HI_CONFIG,
    HOURLY_INTELLIGENCE_MODE, ALLOW_CHAMPION_MUTATION, ALLOW_PRODUCTION_SCORING, ALLOW_AUTOMATIC_PROMOTION,
    HI_ENGINE_VERSION,
    classifyLightPhase, classifyThermalRegime, computeSolarFeatures, computeWindShoreFeatures,
    buildHourlyEnvironment, buildHourlyFeatures, buildAndPersistHourlyShadowSnapshot,
    getShadowHypotheses,
  };
}
