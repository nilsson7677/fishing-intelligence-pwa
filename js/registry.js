// Enrichment-Profile pro Gewaesser — Port von Sprint-1 providers/registry.py, plus
// discharge_provider (Trave, Sprint-2-Fund) und explizit dokumentierte Wassertemperatur-Luecke
// nach der Sprint-2-Recherche (docs/BINNENGEWAESSER_RESEARCH.md).

const _astro = new FIAstro.NOAAAstroProvider();
const _weather = new FIProviders.OpenMeteoProvider();
const _pegel = new FIProviders.PegelonlineProvider();
const _marineWatertemp = new FIProviders.OpenMeteoMarineProvider();
const _noWatertemp = new FIProviders.NoWaterTempProvider();
const _flood = new FIProviders.OpenMeteoFloodProvider();

const PROFILES = {
  luebecker_bucht: {
    profile_id: "luebecker_bucht_v1", water_id: "luebecker_bucht", label: "Lübecker Bucht (Ostseeküste)",
    weatherProvider: _weather, waterLevelProvider: _pegel, waterLevelStationId: "trave_travemuende",
    waterTempProvider: _marineWatertemp, astroProvider: _astro, dischargeProvider: null,
    notes: "Reifstes Profil (Phase 1/2/2.5-Modell, Sprint-1-Meerforellenmodell 2.0).",
  },
  trave: {
    profile_id: "trave_v1", water_id: "trave", label: "Trave (Fluss)",
    weatherProvider: _weather, waterLevelProvider: _pegel, waterLevelStationId: "trave_travemuende",
    // Sprint-2-Fund: 'trave_luebeck_bauhof' liegt naeher an Herrenwyk/Stadtgebiet — als
    // Alternativ-Station hinterlegt, siehe docs/BINNENGEWAESSER_RESEARCH.md. Noch NICHT
    // automatisch nach Spot-Naehe ausgewaehlt (Sprint-3-Kandidat, keine ungeprüfte Zuordnung raten).
    waterLevelStationIdAlt: "trave_luebeck_bauhof",
    waterTempProvider: _noWatertemp, astroProvider: _astro, dischargeProvider: _flood,
    notes: "Pegel ueber WSV/Pegelonline verfuegbar (2 Stationen). Abfluss neu ueber Open-Meteo " +
      "Flood API (GloFAS, modelliert). Wassertemperatur weiterhin OHNE automatisierten Provider " +
      "— recherchiert und bestaetigt keine belastbare Quelle gefunden (Sprint 2).",
  },
  hemmelsdorfer_see: {
    profile_id: "hemmelsdorfer_see_v1", water_id: "hemmelsdorfer_see", label: "Hemmelsdorfer See (See)",
    weatherProvider: _weather, waterLevelProvider: null, waterLevelStationId: null,
    waterTempProvider: _noWatertemp, astroProvider: _astro, dischargeProvider: null,
    notes: "Kein Pegel-Provider, kein Wassertemperatur-Provider — beide Luecken recherchiert und " +
      "begruendet dokumentiert (docs/BINNENGEWAESSER_RESEARCH.md), nicht durch unklare Drittquellen ersetzt.",
  },
  stockssee: {
    profile_id: "stockssee_v1", water_id: "stockssee", label: "Stockssee (See)",
    weatherProvider: _weather, waterLevelProvider: null, waterLevelStationId: null,
    waterTempProvider: _noWatertemp, astroProvider: _astro, dischargeProvider: null,
    notes: "Gleiche Datenlage wie Hemmelsdorfer See.",
  },
};

function getProfile(waterId) {
  const p = PROFILES[waterId];
  if (!p) throw new Error(`Kein Enrichment-Profil fuer Gewaesser '${waterId}' definiert.`);
  return p;
}

const WATER_REFERENCE_POINTS = {
  luebecker_bucht: [54.15, 10.78], trave: [53.95, 10.75],
  hemmelsdorfer_see: [53.95, 10.72], stockssee: [54.15, 10.42],
};

window.FIRegistry = { PROFILES, getProfile, WATER_REFERENCE_POINTS };
