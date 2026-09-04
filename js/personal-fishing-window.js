// Personal Fishing Window — reine Produkt-/Nutzer-Constraint-Schicht UEBER HI-2B (Phase v28 Data
// Integrity + 29-Spot Coverage + Personal Fishing Window, Auftrag Teil C, Abschnitt 17-23,
// 04.09.2026).
//
// MODEL LOCK (Abschnitt 17): HI-2B selbst (hourly-window-intelligence.js: rawOpportunity,
// WHEN_THERMAL_SOLAR_WEIGHT, lowSolarProxy, Normalisierung, Confidence, Fenster-Kandidaten-
// Algorithmus) wird von dieser Datei an KEINER Stelle veraendert, neu implementiert oder erneut
// aufgerufen mit anderen Parametern — diese Datei liest AUSSCHLIESSLICH die bereits oeffentlichen
// "Test-Hook"-Funktionen aus window.FIHourlyWindowIntelligence (siehe deren Export am Dateiende von
// hourly-window-intelligence.js: buildWindowCandidates, deduplicateOverlapping) und wendet danach
// einen reinen Anzeige-/Auswahl-Filter an. HI-2B bewertet weiterhin INTERN alle 24 Stunden eines
// Tages (Abschnitt 17) — nur die PRODUKTIV EMPFOHLENE Anzeige wird auf den erlaubten Tageskorridor
// eingeschraenkt.
//
// KEINE RENORMALISIERUNG (Abschnitt 21, geklaerte Produktentscheidung): dayMin/dayMax fuer die
// relativeOpportunity-Skala kommen HIER IMMER aus dem VOLLEN 24h-Tag (dayResult.dailyDiagnostics aus
// buildDailyWindowRanking(), unveraendert von HI-2B geliefert) — werden an KEINER Stelle dieser Datei
// aus der auf den Korridor eingeschraenkten Teilmenge neu berechnet. Das beste erlaubte Fenster kann
// dadurch einen niedrigeren relativen Wert haben als das interne Nacht-Optimum des Tages — das ist
// beabsichtigt (Abschnitt 21), nicht neu berechnet/verschoben.

// Abschnitt 18: zentrale Konfiguration statt verstreuter Magic Numbers. Bewusst noch keine
// Settings-UI (Abschnitt 18) — ein einziger, klar benannter Ort fuer eine spaetere Einstellbarkeit.
const FISHING_WINDOW_PREFERENCE = {
  sunriseOffsetMinutes: -60,
  sunsetOffsetMinutes: 60,
};

// Abschnitt 19: erlaubter Tageskorridor aus bereits vorhandener Astro-Logik (astro.js/FIAstro,
// dieselbe Quelle wie duskWindowFromSunEvents()/die Trip-/Enrichment-Sonnenzeiten in app.js) — KEIN
// zusaetzlicher externer Request. sunEvents ist das direkte Rueckgabeobjekt von
// FIAstro.NOAAAstroProvider().getSunEvents(lat, lon, dateUtcMidnight) ({sunrise:{measured_at,...},
// sunset:{measured_at,...}, ...}).
function computeAllowedCorridor(sunEvents) {
  if (!sunEvents || !sunEvents.sunrise || !sunEvents.sunset) return null;
  const sunriseIso = sunEvents.sunrise.measured_at;
  const sunsetIso = sunEvents.sunset.measured_at;
  if (!sunriseIso || !sunsetIso) return null;
  const sunrise = new Date(sunriseIso);
  const sunset = new Date(sunsetIso);
  if (isNaN(sunrise.getTime()) || isNaN(sunset.getTime())) return null;
  return {
    sunrise, sunset,
    allowedStart: new Date(sunrise.getTime() + FISHING_WINDOW_PREFERENCE.sunriseOffsetMinutes * 60000),
    allowedEnd: new Date(sunset.getTime() + FISHING_WINDOW_PREFERENCE.sunsetOffsetMinutes * 60000),
  };
}

// dayResult.hours (aus HI-2B buildDailyWindowRanking()) hat die Form
// {timestamp, solarElevationDeg, waterTempC, lightPhase, opportunity:{...}} — buildWindowCandidates()
// (HI-2B, unveraendert) erwartet dagegen {environment:{timestamp}, opportunity:{rawOpportunity,...}}.
// Reine, verlustfreie Umformung (Adapter) — keine Werte werden veraendert, nur umgehaengt.
function _toCandidateEntries(hoursOut) {
  return (hoursOut || []).map((h) => ({ environment: { timestamp: h.timestamp }, opportunity: h.opportunity }));
}

function _hourInCorridor(entry, allowedStart, allowedEnd) {
  const t = new Date(entry.environment.timestamp).getTime();
  return t >= allowedStart.getTime() && t < allowedEnd.getTime();
}

// Abschnitt 20: bestes ERLAUBTES Fenster fuer EINEN Tag — Prioritaet zuerst 3h, sonst 2h, sonst
// ehrlicher Fallback ("kein zuverlaessig empfehlbares Fenster"), AUSDRUECKLICH NICHT einfach ein
// 00:00-03:00-Fenster kappen: Kandidaten werden von vornherein NUR aus den innerhalb des Korridors
// liegenden Stunden gebaut (buildWindowCandidates bekommt ausschliesslich die vorgefilterte
// Teilmenge), zusaetzlich wird jeder Kandidat defensiv nochmal auf
// windowStart >= allowedStart UND windowEnd <= allowedEnd geprueft (Abschnitt 20, woertliche
// Bedingung). dayResult ist EIN Element aus
// window.FIHourlyWindowIntelligence.buildHourlyWindowRankingSeries(...).days bzw.
// runWhenShadowAnalysis(...).days (unveraendertes HI-2B-Ergebnis).
function computeAllowedWindowForDay(dayResult, allowedStart, allowedEnd) {
  const HI2B = window.FIHourlyWindowIntelligence;
  if (!HI2B) return { status: "engine_unavailable", allowedWindow: null, durationHours: null };
  if (!dayResult || !allowedStart || !allowedEnd) return { status: "no_corridor", allowedWindow: null, durationHours: null };

  const entries = _toCandidateEntries(dayResult.hours);
  const corridorEntries = entries.filter((e) => _hourInCorridor(e, allowedStart, allowedEnd));
  if (!corridorEntries.length) return { status: "no_corridor_hours", allowedWindow: null, durationHours: null };

  const diag = dayResult.dailyDiagnostics || {};
  const dayMin = diag.dayMin != null ? diag.dayMin : null;
  const dayMax = diag.dayMax != null ? diag.dayMax : null;

  for (const durationHours of [3, 2]) {
    const candidates = HI2B.buildWindowCandidates(corridorEntries, durationHours, dayMin, dayMax, dayResult.localDate)
      .filter((c) => new Date(c.startTimestamp).getTime() >= allowedStart.getTime() &&
        (new Date(c.endTimestamp).getTime() + 3600000) <= allowedEnd.getTime());
    if (candidates.length) {
      const selected = HI2B.deduplicateOverlapping(candidates, 1);
      if (selected[0]) return { status: "ok", allowedWindow: selected[0], durationHours };
    }
  }
  return { status: "no_valid_window", allowedWindow: null, durationHours: null };
}

// Bequemlichkeitsfunktion: kombiniert Abschnitt 19+20 fuer EINEN Tag, inkl. sauberer Diagnose-Objekte
// fuer die ?hidebug=1-Transparenzanzeige (Abschnitt 22/23: RAW HI-2B-Fenster, erlaubter Korridor,
// produktiv empfohlenes Fenster nebeneinander).
function buildPersonalWindowForDay(dayResult, sunEvents) {
  const corridor = computeAllowedCorridor(sunEvents);
  if (!corridor) {
    return { status: "corridor_unavailable", corridor: null, rawBestWindow: dayResult ? dayResult.bestWindow : null, allowedResult: { status: "no_corridor", allowedWindow: null, durationHours: null } };
  }
  const allowedResult = computeAllowedWindowForDay(dayResult, corridor.allowedStart, corridor.allowedEnd);
  return { status: allowedResult.status, corridor, rawBestWindow: dayResult ? dayResult.bestWindow : null, allowedResult };
}

if (typeof window !== "undefined") {
  window.FIPersonalWindow = {
    FISHING_WINDOW_PREFERENCE,
    computeAllowedCorridor,
    computeAllowedWindowForDay,
    buildPersonalWindowForDay,
    _toCandidateEntries, // Test-Hook
  };
}
