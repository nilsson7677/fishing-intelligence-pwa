// Sea Trout Hourly Intelligence — Data Foundation & Shadow Infrastructure (Phase HI-1, 30.08.2026).
// ERWEITERT in Phase HI-2A (31.08.2026, "Forecast Time Series & Spot Foundation"): effiziente
// 120h-Batch-Forecast-Zeitreihe (buildHourlyForecastSeries), Spot-Geodatenmodell mit Provenance
// (SPOT_GEO_METADATA/getSpotGeoMetadata), spot-relative Wind-/Wellen-Features
// (computeSpotRelativeWind/computeSpotRelativeWave), Wave-Provider-Fix (siehe providers.js
// OM_MARINE_WAVE_MODEL-Kommentar). Alles weiterhin SHADOW ONLY, siehe Guardrails unten — HI-2A
// aendert an den HI-1-Guardrails nichts, ergaenzt nur additiv.
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
// SHORE ORIENTATION — EXAKTE DEFINITION (Auftrag HI-2A Abschnitt 8, verbindlich fuer JEDE
// spot-relative Berechnung in dieser Datei):
//
//   shoreOrientationDeg = Richtung des SEEWAERTS gerichteten Normalvektors der Kuestenlinie an
//   diesem Spot (die Richtung, in die man vom Ufer aus aufs offene Wasser blickt).
//   0° = Nord, 90° = Ost, 180° = Sued, 270° = West.
//
//   windDirDeg/waveDirectionDeg folgen — wie bei Open-Meteo dokumentiert und bereits in HI-1 fuer
//   Wind verwendet — der meteorologisch/ozeanografischen "FROM"-Konvention: der Wert gibt an, AUS
//   WELCHER Richtung Wind/Welle KOMMEN (0°=von Norden, 90°=von Osten), nicht wohin sie ziehen.
//
//   Damit gilt geometrisch eindeutig: rel = 0° (Wind/Welle kommt exakt aus der Richtung, in die
//   die Kueste schaut) => ONSHORE (voll auflandig, trifft direkt auf den Strand). rel = 180°
//   (Wind/Welle kommt von hinten, vom Land her) => OFFSHORE (voll ablandig). rel = 90°/270° =>
//   ALONGSHORE (parallel zur Kuestenlinie, weder auf- noch ablandig).
//
// SPOT-RELATIVE FEATURES (Auftrag Abschnitt 9/10). Reine Vektor-Geometrie, KEINE Fangbewertung.
// Dieselbe Formel gilt fuer Wind UND Wellen (beide "from"-Konvention, siehe Provider-Audit) — ein
// gemeinsamer, interner Helper vermeidet Code-Duplizierung. computeWindShoreFeatures() ist
// GEGENUEBER HI-1 UNVERAENDERT in Signatur/Rueckgabewert (reiner interner Refactor, durch die
// bestehenden HI-1-Tests abgesichert).
// ---------------------------------------------------------------------------

function _shoreRelativeComponents(fromDeg, magnitude, spotOrientationDeg) {
  if ([fromDeg, magnitude, spotOrientationDeg].some((v) => v === null || v === undefined)) return null;
  let rel = Math.abs(fromDeg - spotOrientationDeg) % 360;
  if (rel > 180) rel = 360 - rel;
  const relRad = (rel * Math.PI) / 180;
  const onshoreSigned = magnitude * Math.cos(relRad); // >0 auflandig, <0 ablandig
  const alongShore = magnitude * Math.sin(relRad);
  return {
    relativeAngleDeg: Math.round(rel * 10) / 10,
    crossShoreComponent: Math.round(onshoreSigned * 100) / 100,
    alongShoreComponent: Math.round(alongShore * 100) / 100,
    onshoreStrength: Math.round(Math.max(0, onshoreSigned) * 100) / 100,
    offshoreStrength: Math.round(Math.max(0, -onshoreSigned) * 100) / 100,
  };
}

function computeWindShoreFeatures(windDirDeg, windSpeedMs, spotOrientationDeg) {
  const r = _shoreRelativeComponents(windDirDeg, windSpeedMs, spotOrientationDeg);
  if (!r) return null;
  return {
    relativeWindAngleDeg: r.relativeAngleDeg,
    crossShoreComponent: r.crossShoreComponent,
    alongShoreComponent: r.alongShoreComponent,
    onshoreStrength: r.onshoreStrength,
    offshoreStrength: r.offshoreStrength,
  };
}

// NEU HI-2A (Auftrag Abschnitt 10): analoge Funktion fuer Wellen, gleiche Geometrie/Konvention wie
// Wind (siehe Definition oben). Feldnamen exakt wie im Auftrag benannt (relativeWaveAngleDeg,
// onshoreWaveComponent, alongshoreWaveComponent) — bewusst NUR die drei angeforderten Felder,
// keine erfundene Zusatzbewertung.
function computeWaveShoreFeatures(waveDirectionDeg, waveHeightM, spotOrientationDeg) {
  const r = _shoreRelativeComponents(waveDirectionDeg, waveHeightM, spotOrientationDeg);
  if (!r) return null;
  return {
    relativeWaveAngleDeg: r.relativeAngleDeg,
    onshoreWaveComponent: r.onshoreStrength,
    alongshoreWaveComponent: Math.abs(r.alongShoreComponent),
  };
}

// ---------------------------------------------------------------------------
// SPOT GEO MODEL (Auftrag Abschnitt 6/7) — additives Geodatenmodell fuer die bestehenden
// Meerforellen-Spots der Luebecker Bucht (SPOT_STATS in meerforelle-model.js, UNVERAENDERT,
// Spot-IDs/-Namen hier nicht angefasst). Recherchiert per WebSearch/WebFetch am 31.08.2026
// (vollstaendige Quellenliste inkl. Praezisions-/Ambiguitaets-Notizen: siehe
// HOURLY_INTELLIGENCE_SHADOW.md "Spot Geo Model" bzw. Claude-Projekt-Doc
// "spot_geodaten_kuestenausrichtung_v1.md"). PROVENANCE-PFLICHT (Auftrag Abschnitt 7): jeder
// Eintrag traegt geoSource/geoSourceUrl/geoConfidence sowie orientationSource/
// orientationConfidence GETRENNT (ein Spot kann lokalisierbar, aber orientierungsmaessig unklar
// sein, oder umgekehrt). "ostsee_allgemein" (kein konkreter Ort, siehe meerforelle-model.js) und
// "herrenwyk" (Trave, nicht Luebecker Bucht) sind bewusst NICHT Teil dieses Modells.
//
// VIER Spots konnten trotz Recherche NICHT eindeutig identifiziert werden (Namensmehrdeutigkeit
// bzw. keine bestaetigende Quelle) — hier bewusst mit lat/lon = null statt einer geratenen
// Koordinate hinterlegt (Auftrag: "Keine Werte raten"): "wiek" (kein Einzelort auf Fehmarn unter
// diesem Namen auffindbar, nur ein niederdeutscher Gattungsbegriff fuer "Bucht"), "seeburgbruecke"
// (keine Quelle bestaetigt diesen Namen als Ort/Bauwerk), "klinikum" (zwei Kandidaten — Curschmann-
// Klinik Timmendorfer Strand vs. Ostseeklinik Groemitz — keiner zweifelsfrei mit dem Fangbuch-
// Namen verknuepfbar), "hafeneinfahrt" (Neustadt i.H. wahrscheinlichster Kandidat, Travemuende
// nicht ausgeschlossen). Fuer diese vier wird empfohlen, vor einem produktiven Einsatz mit der
// Person Ruecksprache zu halten, die die Original-Fangbuch-Eintraege erfasst hat.
//
// shoreOrientationDeg = null bei "pelzerhaken": eine Landzunge mit zwei unterschiedlich
// exponierten Strandseiten (Aussenseite vs. Neustaedter Bucht) — ein einzelner Skalarwert waere
// hier fachlich irrefuehrend, nicht nur unsicher (siehe Definition oben: die Funktion setzt EINE
// Kuestennormale voraus).
const HI_SPOT_GEO_METADATA_VERSION = "hi2a-spot-geo-v1-2026-08-31";
const SPOT_GEO_METADATA = {
  pelzerhaken: {
    latitude: 54.0905, longitude: 10.8595,
    geoSource: "Mapcarta (OSM-basiert), Ortskern-/Landzungen-Naeherung", geoSourceUrl: "https://mapcarta.com/18055650", geoConfidence: "mittel",
    shoreOrientationDeg: null,
    orientationSource: null, orientationConfidence: null,
    orientationNote: "Landzunge mit zwei Strandseiten unterschiedlicher Exposition (Aussenseite ~30-60°, Innenseite/Neustaedter Bucht ~SE-S) — kein robuster Einzelwert, siehe Data Gap.",
    metadataVersion: HI_SPOT_GEO_METADATA_VERSION,
  },
  groemitz: {
    latitude: 54.1441, longitude: 10.9589,
    geoSource: "Mapcarta (OSM-basiert), Ortskern-Naeherung", geoSourceUrl: "https://mapcarta.com/Gr%C3%B6mitz", geoConfidence: "mittel",
    shoreOrientationDeg: 105,
    orientationSource: "Geometrische Kuestenlinien-Naeherung aus Nachbarort-Kette (nicht vermessen)", orientationConfidence: "mittel",
    metadataVersion: HI_SPOT_GEO_METADATA_VERSION,
  },
  suessau: {
    latitude: 54.2735, longitude: 11.0576,
    geoSource: "Mapcarta (OSM-basiert), Gemeinde Heringsdorf/Ostholstein", geoSourceUrl: "https://mapcarta.com/17994788", geoConfidence: "niedrig",
    shoreOrientationDeg: 55,
    orientationSource: "Geometrische Kuestenlinien-Naeherung (Kueste hier stark gekruemmt, nahe Grossenbroder Bucht)", orientationConfidence: "niedrig",
    orientationNote: "Liegt ~16km NNE von Groemitz (deutlich weiter als urspruenglich angenommen) — Ortszuordnung ueber Nachbarort Rosenfelde bestaetigt, aber insgesamt geringere Konfidenz.",
    metadataVersion: HI_SPOT_GEO_METADATA_VERSION,
  },
  wiek: {
    latitude: null, longitude: null, geoSource: null, geoSourceUrl: null, geoConfidence: null,
    shoreOrientationDeg: null, orientationSource: null, orientationConfidence: null,
    orientationNote: "Kein Einzelort namens 'Wiek' auf Fehmarn identifiziert (nur Gattungsbegriff fuer Bucht, mehrere Kandidatenbuchten) — keine Koordinate geraten.",
    metadataVersion: HI_SPOT_GEO_METADATA_VERSION,
  },
  weissenhaus: {
    latitude: 54.3010, longitude: 10.7658,
    geoSource: "Mapcarta + Wikipedia 'Weißenhäuser Strand' (gegengeprueft)", geoSourceUrl: "https://de.wikipedia.org/wiki/Wei%C3%9Fenh%C3%A4user_Strand", geoConfidence: "mittel",
    shoreOrientationDeg: 15,
    orientationSource: "Bekannte Lage an der nordoffenen Hohwachter Bucht", orientationConfidence: "mittel",
    metadataVersion: HI_SPOT_GEO_METADATA_VERSION,
  },
  bliesdorf: {
    latitude: 54.1321, longitude: 10.9047,
    geoSource: "Mapcarta (OSM-basiert), Dorfkern-Naeherung", geoSourceUrl: "https://mapcarta.com/18241178", geoConfidence: "mittel",
    shoreOrientationDeg: 105,
    orientationSource: "Geometrische Kuestenlinien-Naeherung aus Nachbarort-Kette (nicht vermessen)", orientationConfidence: "mittel",
    metadataVersion: HI_SPOT_GEO_METADATA_VERSION,
  },
  sierksdorf: {
    latitude: 54.0668, longitude: 10.7695,
    geoSource: "Mapcarta (OSM-basiert), Dorfkern-Naeherung", geoSourceUrl: "https://mapcarta.com/25449004", geoConfidence: "mittel",
    shoreOrientationDeg: 85,
    orientationSource: "Bekannte Ostausrichtung dieses Kuestenabschnitts Richtung Luebeck", orientationConfidence: "mittel",
    metadataVersion: HI_SPOT_GEO_METADATA_VERSION,
  },
  klinikum: {
    latitude: null, longitude: null, geoSource: null, geoSourceUrl: null, geoConfidence: null,
    shoreOrientationDeg: null, orientationSource: null, orientationConfidence: null,
    orientationNote: "Zwei Kandidaten (Curschmann-Klinik Timmendorfer Strand favorisiert, Ostseeklinik Groemitz liegt nachweislich landeinwaerts) — keiner zweifelsfrei mit dem Fangbuch-Namen 'Klinikum' verknuepfbar, keine Koordinate geraten.",
    metadataVersion: HI_SPOT_GEO_METADATA_VERSION,
  },
  dahmeshoeved: {
    latitude: 54.2014, longitude: 11.0909,
    geoSource: "BoatView Leuchtturm-Datenbank, gegengeprueft mit Wikipedia 'Leuchtturm Dahmeshöved' (Distanz zu Dahme)", geoSourceUrl: "https://www.boatview.io/de/poi/3636/dahmeshoeved", geoConfidence: "mittel",
    shoreOrientationDeg: 68,
    orientationSource: "Geometrische Naeherung — Landzunge/Steilkueste mit Riff, komplexe Form", orientationConfidence: "niedrig",
    metadataVersion: HI_SPOT_GEO_METADATA_VERSION,
  },
  seeburgbruecke: {
    latitude: null, longitude: null, geoSource: null, geoSourceUrl: null, geoConfidence: null,
    shoreOrientationDeg: null, orientationSource: null, orientationConfidence: null,
    orientationNote: "Keine Quelle bestaetigt 'Seeburgbrücke' als Ort/Bauwerk. Interner Hinweis (phase2_5_wind_spot_exposition.md) auf 'Neustaedter Bucht/Seeburg' als Zone, aber kein Kartenbeleg — keine Koordinate geraten.",
    metadataVersion: HI_SPOT_GEO_METADATA_VERSION,
  },
  hafeneinfahrt: {
    latitude: null, longitude: null, geoSource: null, geoSourceUrl: null, geoConfidence: null,
    shoreOrientationDeg: null, orientationSource: null, orientationConfidence: null,
    orientationNote: "Neustadt i.H. wahrscheinlichster Kandidat (einziger Hafen der Neustaedter Bucht, dort auch als Mefo-Spot dokumentiert), Travemuende nicht ausgeschlossen — nicht zweifelsfrei, keine Koordinate geraten.",
    metadataVersion: HI_SPOT_GEO_METADATA_VERSION,
  },
  brodten: {
    latitude: 53.9880, longitude: 10.8619,
    geoSource: "Mapcarta (OSM-basiert), Dorfkern-Naeherung", geoSourceUrl: "https://mapcarta.com/18233492", geoConfidence: "mittel",
    shoreOrientationDeg: 15,
    orientationSource: "Gleicher Kuestenabschnitt wie Brodtener Ufer (Dorf liegt hinter einem Teilstueck des Kliffs)", orientationConfidence: "mittel",
    metadataVersion: HI_SPOT_GEO_METADATA_VERSION,
  },
  brodtner_ufer: {
    latitude: 53.982, longitude: 10.881,
    geoSource: "Wikipedia 'Brodtener Ufer' (explizite Koordinate)", geoSourceUrl: "https://de.wikipedia.org/wiki/Brodtener_Ufer", geoConfidence: "mittel",
    shoreOrientationDeg: 15,
    orientationSource: "Direkt aus Quelle abgeleitet (Ausdehnung Niendorf-Travemuende, Nordausrichtung des Kliffs)", orientationConfidence: "mittel",
    metadataVersion: HI_SPOT_GEO_METADATA_VERSION,
  },
};

// Kopie zurueckgeben (Register nicht von aussen mutierbar, gleiches Prinzip wie
// getShadowHypotheses()). Unbekannte spotId -> null (kein Fantasie-Fallback).
function getSpotGeoMetadata(spotId) {
  const entry = SPOT_GEO_METADATA[spotId];
  return entry ? { ...entry } : null;
}

// Bequemlichkeits-Wrapper: Spot-ID statt rohem Orientierungswinkel. Liefert null, wenn der Spot
// unbekannt ist ODER keine (ausreichend sichere) shoreOrientationDeg hinterlegt ist — niemals eine
// Bewertung, nur die Geometrie (siehe computeWindShoreFeatures/computeWaveShoreFeatures oben).
function computeSpotRelativeWind(spotId, windDirDeg, windSpeedMs) {
  const geo = getSpotGeoMetadata(spotId);
  if (!geo) return null;
  return computeWindShoreFeatures(windDirDeg, windSpeedMs, geo.shoreOrientationDeg);
}
function computeSpotRelativeWave(spotId, waveDirectionDeg, waveHeightM) {
  const geo = getSpotGeoMetadata(spotId);
  if (!geo) return null;
  return computeWaveShoreFeatures(waveDirectionDeg, waveHeightM, geo.shoreOrientationDeg);
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
// HI-2A — 120H BATCH FORECAST SERIES (Auftrag Abschnitt 3/16): buildHourlyEnvironment()/
// buildHourlyFeatures() oben sind fuer EINE Zielstunde ausgelegt (HI-1). Fuer einen ganzen
// Forecast-Horizont waere ein Aufruf pro Stunde 120×N HTTP-Requests — stattdessen wird HIER
// GENAU EIN Wetter-Request + EIN Marine-Request (nur Kuestenprofile) + EIN Pegel-Request (nur
// jetzt-nahe Stunden) fuer den GESAMTEN Horizont geladen, und jede Stunde danach LOKAL (ohne
// weiteren Netzwerkaufruf) aus den geladenen Arrays mit STRIKTEM Timestamp-Matching
// (_exactHourIndex — kein "naechstgelegener Wert", um stille Off-by-one-Fehler auszuschliessen)
// zusammengesetzt. Nutzt dieselben additiven Provider-Methoden wie oben (getHourlyRangeRaw/
// getMarineRangeRaw) und dieselben reinen Formeln (computeSolarFeatures/classifyThermalRegime/
// analyzeWaterLevelPhase, NUR LESEND) wie buildHourlyEnvironment/-Features — keine zweite Logik.
// ---------------------------------------------------------------------------

const HI_PRESSURE_LOOKBACK_H = 6; // fuer lokale pressureChange3h/6h-Berechnung ohne Extra-Request
const HI_WATERLEVEL_MATCH_TOLERANCE_MIN = 30; // wie nah ein Pegel-Rohmesswert an einer Zielstunde liegen darf

function _floorToHourUtc(dt) {
  return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), dt.getUTCHours(), 0, 0, 0));
}

// Striktes Timestamp-Matching (Auftrag Abschnitt 4): anders als das bestehende, tolerante
// nearestIndex() (providers.js, fuer Einzelstunden-Abfragen mit garantiertem Treffer) braucht der
// Batch-Mapper einen EXAKTEN Treffer pro Zielstunde. Open-Meteo liefert bei timezone=UTC exakt
// stuendliche Zeitpunkte — ein fehlender exakter Treffer wird NICHT still auf die naechstgelegene
// Stunde "verschmiert", sondern bleibt ein fehlender Wert (kein Off-by-one-Fehler).
function _exactHourIndex(timesMs, targetMs) {
  if (!Array.isArray(timesMs)) return -1;
  return timesMs.indexOf(targetMs);
}

function _fieldAt(arr, idx) {
  if (!Array.isArray(arr) || idx < 0 || idx >= arr.length) return null;
  const v = arr[idx];
  return (v === null || v === undefined) ? null : v;
}

// Naechster Pegel-Rohmesswert zu einem Zielzeitpunkt, mit Toleranzfenster (kein Erfinden ueber die
// Toleranz hinaus) — dieselbe "nearest, aber nicht zu weit weg"-Logik wie das bestehende
// getLevel()/getTrendMultiWindow() in providers.js, hier lokal auf die bereits geladene
// Batch-Rohserie angewandt (kein zusaetzlicher Request pro Stunde).
function _nearestWaterLevelValue(points, targetMs, toleranceMin) {
  if (!points.length) return null;
  let best = points[0], bestDiff = Math.abs(points[0].t - targetMs);
  for (const p of points) { const d = Math.abs(p.t - targetMs); if (d < bestDiff) { best = p; bestDiff = d; } }
  return bestDiff <= toleranceMin * 60000 ? best.v : null;
}

function _mapForecastHour(waterId, lat, lon, targetDt, generatedAt, weatherRange, marineRange, waterLevelPoints) {
  const nowMs = Date.now();
  const targetMs = targetDt.getTime();
  const isNearNow = Math.abs(nowMs - targetMs) <= HI_NEAR_NOW_WINDOW_MIN * 60000;
  const sources = [];

  const environment = {
    timestamp: targetDt.toISOString(), locationId: waterId,
    solarElevationDeg: null, minutesFromSunrise: null, minutesToSunset: null, lightPhase: "night",
    waterTempC: null, airTempC: null,
    cloudCoverPct: null, precipitationMm: null,
    windSpeedMs: null, windGustMs: null, windDirectionDeg: null,
    waveHeightM: null, waveDirectionDeg: null, wavePeriodSec: null,
    pressureHpa: null,
    waterLevelCm: null,
    forecastGeneratedAt: generatedAt,
    forecastHorizonHours: Math.round((targetMs - nowMs) / 3600000),
    source: "none",
  };
  Object.assign(environment, computeSolarFeatures(lat, lon, targetDt));

  let wIdx = -1;
  if (weatherRange && weatherRange.ok) {
    wIdx = _exactHourIndex(weatherRange.times, targetMs);
    if (wIdx >= 0) {
      environment.airTempC = _fieldAt(weatherRange.airTempC, wIdx);
      environment.windSpeedMs = _fieldAt(weatherRange.windSpeedMs, wIdx);
      environment.windGustMs = _fieldAt(weatherRange.windGustMs, wIdx);
      environment.windDirectionDeg = _fieldAt(weatherRange.windDirDeg, wIdx);
      environment.precipitationMm = _fieldAt(weatherRange.precipitationMm, wIdx);
      environment.cloudCoverPct = _fieldAt(weatherRange.cloudCoverPct, wIdx);
      environment.pressureHpa = _fieldAt(weatherRange.pressureHpa, wIdx);
      if (environment.airTempC !== null) sources.push(FIRegistry.getProfile(waterId).weatherProvider.name + "_batch");
    }
  }

  let mIdx = -1;
  if (marineRange && marineRange.ok) {
    mIdx = _exactHourIndex(marineRange.times, targetMs);
    if (mIdx >= 0) {
      environment.waterTempC = _fieldAt(marineRange.waterTempC, mIdx);
      environment.waveHeightM = _fieldAt(marineRange.waveHeightM, mIdx);
      environment.waveDirectionDeg = _fieldAt(marineRange.waveDirectionDeg, mIdx);
      environment.wavePeriodSec = _fieldAt(marineRange.wavePeriodSec, mIdx);
      if (environment.waterTempC !== null) sources.push("open_meteo_marine_batch");
    }
  }

  const features = {
    timestamp: environment.timestamp,
    thermalRegime: null, // unten nach Wasserstand-Block final aus environment.waterTempC gesetzt
    lightPhase: environment.lightPhase, solarElevationDeg: environment.solarElevationDeg,
    pressureChange3h: null, pressureChange6h: null,
    waterLevelChange1h: null, waterLevelChange3h: null, waterLevelRateCmH: null,
    timeSinceWaterLevelExtremeMin: null,
    effectiveLightProxy: null,
  };

  if (weatherRange && weatherRange.ok && wIdx >= 0) {
    for (const [key, hoursBack] of [["pressureChange3h", 3], ["pressureChange6h", 6]]) {
      const pastIdx = _exactHourIndex(weatherRange.times, targetMs - hoursBack * 3600000);
      const cur = _fieldAt(weatherRange.pressureHpa, wIdx), past = _fieldAt(weatherRange.pressureHpa, pastIdx);
      if (cur !== null && past !== null) features[key] = Math.round((cur - past) * 10) / 10;
    }
  }

  // Wasserstand: NUR jetzt-nah (identisches Look-ahead-Vermeidungsprinzip wie HI-1/enrichment.js —
  // Pegelonline liefert ausschliesslich Live-Messwerte, keine Vorhersage). Nutzt die EINE bereits
  // geladene Rohserie fuer alle jetzt-nahen Stunden im Batch, kein Extra-Request pro Stunde.
  if (waterLevelPoints && waterLevelPoints.length && isNearNow) {
    try {
      const cur = _nearestWaterLevelValue(waterLevelPoints, targetMs, HI_WATERLEVEL_MATCH_TOLERANCE_MIN);
      if (cur !== null) { environment.waterLevelCm = Math.round(cur * 10) / 10; sources.push("pegelonline_wsv_batch"); }
      for (const [key, hoursBack] of [["waterLevelChange1h", 1], ["waterLevelChange3h", 3]]) {
        const past = _nearestWaterLevelValue(waterLevelPoints, targetMs - hoursBack * 3600000, HI_WATERLEVEL_MATCH_TOLERANCE_MIN);
        if (cur !== null && past !== null) features[key] = Math.round((cur - past) * 10) / 10;
      }
      // NUR LESENDER Aufruf des bestehenden, eingefrorenen Wasserstandsmodells (Guardrail Abschnitt
      // 0), identisch zu buildHourlyFeatures() oben — kein Minimum-Detektor (siehe Data Gap).
      const rawForPhase = waterLevelPoints.map((p) => ({ timestamp: new Date(p.t).toISOString(), value: String(p.v) }));
      const phase = FIProviders.analyzeWaterLevelPhase(rawForPhase, targetMs);
      if (phase.ok) {
        features.waterLevelRateCmH = phase.rateCmPerHour;
        if (phase.peakTime) features.timeSinceWaterLevelExtremeMin = phase.minutesSincePeak;
      }
    } catch (e) {
      // Nebenrechnung darf den Batch nie zum Abbruch bringen (Local-First-Prinzip).
    }
  }

  environment.source = sources.length ? sources.join("+") : "none";
  features.thermalRegime = classifyThermalRegime(environment.waterTempC);
  return { environment, features };
}

// buildHourlyForecastSeries(waterId, opts) -> { generatedAt, locationId, startTimestamp,
//   horizonHours, hours: [{environment, features}, ...], requestLog, waveSourceStatus }
// opts.horizonHours (default 120, gedeckelt auf HI_CONFIG.FORECAST_MAX_HORIZON_HOURS),
// opts.startTimestampIso (default: aktuelle volle Stunde UTC).
async function buildHourlyForecastSeries(waterId, opts = {}) {
  const horizonHours = Math.max(0, Math.min(HI_CONFIG.FORECAST_MAX_HORIZON_HOURS,
    (typeof opts.horizonHours === "number") ? opts.horizonHours : 120));
  const startHour = opts.startTimestampIso ? _floorToHourUtc(new Date(opts.startTimestampIso)) : _floorToHourUtc(new Date());
  const generatedAt = FIDB.nowIso();
  const profile = FIRegistry.getProfile(waterId);
  const [lat, lon] = FIRegistry.WATER_REFERENCE_POINTS[waterId] || [null, null];

  const requestLog = [];
  const result = { generatedAt, locationId: waterId, startTimestamp: startHour.toISOString(),
    horizonHours, hours: [], requestLog, waveSourceStatus: "request_failed" };
  if (lat === null || lat === undefined) return result; // kein Referenzpunkt -> nichts erfinden

  const rangeStart = new Date(startHour.getTime() - HI_PRESSURE_LOOKBACK_H * 3600000);
  const rangeEnd = new Date(startHour.getTime() + horizonHours * 3600000);

  let weatherRange = null, marineRange = null, waterLevelPoints = null;

  if (profile.weatherProvider && typeof profile.weatherProvider.getHourlyRangeRaw === "function") {
    weatherRange = await profile.weatherProvider.getHourlyRangeRaw(lat, lon, rangeStart, rangeEnd);
    requestLog.push({ provider: profile.weatherProvider.name, kind: "weather_range", ok: !!weatherRange.ok });
  }
  if (profile.waterTempProvider && typeof profile.waterTempProvider.getMarineRangeRaw === "function") {
    marineRange = await profile.waterTempProvider.getMarineRangeRaw(lat, lon, rangeStart, rangeEnd);
    requestLog.push({ provider: profile.waterTempProvider.name, kind: "marine_range", ok: !!marineRange.ok });
    result.waveSourceStatus = marineRange.waveSourceStatus || (marineRange.ok ? "provider_null" : "request_failed");
  }
  if (profile.waterLevelProvider && profile.waterLevelStationId) {
    const lvlSeriesRes = await profile.waterLevelProvider.getLevelSeries(profile.waterLevelStationId);
    requestLog.push({ provider: profile.waterLevelProvider.name, kind: "waterlevel_series", ok: !!lvlSeriesRes.ok });
    if (lvlSeriesRes.ok) {
      try {
        waterLevelPoints = lvlSeriesRes.raw
          .map((m) => ({ t: Date.parse(m.timestamp), v: parseFloat(m.value) }))
          .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
      } catch (e) { waterLevelPoints = null; }
    }
  }

  for (let h = 0; h <= horizonHours; h++) {
    const targetDt = new Date(startHour.getTime() + h * 3600000);
    result.hours.push(_mapForecastHour(waterId, lat, lon, targetDt, generatedAt, weatherRange, marineRange, waterLevelPoints));
  }
  return result;
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
    // HI-2A additions
    computeWaveShoreFeatures,
    HI_SPOT_GEO_METADATA_VERSION,
    getSpotGeoMetadata, computeSpotRelativeWind, computeSpotRelativeWave,
    buildHourlyForecastSeries,
  };
}
