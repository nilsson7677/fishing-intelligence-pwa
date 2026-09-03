// WHAT Intelligence — Köder-/Fliegen-Empfehlung (Fishing Intelligence v1 — Product Finish Sprint,
// Abschnitt 11-14, 03.09.2026). Erstmals produktsichtbar gemacht, ABER: reine INTELLIGENCE/
// RECOMMENDATION-Schicht mit SPOT_INTELLIGENCE_SCORING_IMPACT-analogem WHAT_SCORING_IMPACT = "none"
// — diese Datei liest/verändert an KEINER Stelle Champion (meerforelle-model.js), Challenger
// (challenger-state.js), HI-2B (hourly-window-intelligence.js) oder HI-2C (where-spot-intelligence.js)
// und wird von KEINEM dieser Module gelesen (Guardrail, siehe Auftrag Abschnitt 2 "ABSOLUTE MODEL
// SCOPE LOCK": "keine neuen Fangboni ... keine 'Product Finish'-Heuristik, die insgeheim eine neue
// Fangregel ist").
//
// QUELLE (Auftrag Abschnitt 1/11: "ausschliesslich bereits dokumentierte Evidenz, KEINE neue
// Web-Recherche"): claude/sea_trout_lure_fly_intelligence_kb_v1.md ("Sea Trout Lure & Fly
// Intelligence Knowledge Base v1.0", External Lure Evidence Layer, Regeln LURE-001 bis LURE-021 +
// die CONDITION x LURE LOGIC-Hypothesenraeume + der MYTH-STATUS-Abschnitt) und
// claude/lure_intelligence_personal_calibration.md (Personal-Kalibrierungs-Phase 2). Die zweite
// Datei liefert explizit KEINE zusaetzliche produktive Regel — ihr zentraler methodischer Befund
// ("Odds einer dokumentierten Koederangabe nach einem erfolgreichen Trip ~7.8x hoeher, 95%-CI
// 5.5-11.2 — starke Success-Bias") ist der Grund, warum diese Datei AUSSCHLIESSLICH die externe
// KB (LURE-001..021) fuer Empfehlungen nutzt und an KEINER Stelle historische
// fishing_session/catch_event-Koederfelder liest (Auftrag Abschnitt 11: "explizit KEINE
// persoenlichen historischen Koederregeln als belegte Regel behandeln").
//
// Die Regeln unten sind eine 1:1-Kodierung der bereits dokumentierten KB-Aussagen (siehe
// evidenceRef/kbStatus je Regel) — es wird HIER keine neue Schwelle/Effektgroesse erfunden, die
// nicht bereits in der KB als Hypothesenraum/Regel benannt ist. Wo die KB selbst nur
// "PARTIALLY_SUPPORTED"/"INSUFFICIENT_EVIDENCE"/"OVERSIMPLIFIED" sagt, formuliert diese Datei
// bewusst vorsichtig/breit (Auftrag Abschnitt 14: "keine falsche Praezision").

const WHAT_ENGINE_VERSION = "WHAT-1-2026-09-03";
const WHAT_KB_VERSION = "sea-trout-lure-fly-kb-v1";
const WHAT_SCORING_IMPACT = "none"; // strukturell: kein Aufrufer aus Champion/Challenger/HI-2B/HI-2C

// Thermal-Regime/Light-Phase werden NICHT neu erfunden, sondern (falls der Aufrufer Rohwerte statt
// bereits klassifizierter Werte uebergibt) ueber die bereits bestehenden, unveraenderten HI-1-
// Klassifikatoren bezogen (window.FIHourlyIntelligence.classifyThermalRegime/classifyLightPhase) —
// dieselben Bins, die HI-2B bereits fuer WANN nutzt, keine zweite parallele Grenzziehung.
function _thermalRegimeFrom(ctx) {
  if (ctx.thermalRegime) return ctx.thermalRegime;
  if (window.FIHourlyIntelligence && typeof ctx.waterTempC === "number") {
    return window.FIHourlyIntelligence.classifyThermalRegime(ctx.waterTempC);
  }
  return "unknown";
}

function _lightPhaseFrom(ctx) {
  if (ctx.lightPhase) return ctx.lightPhase;
  if (window.FIHourlyIntelligence && typeof ctx.solarElevationDeg === "number") {
    return window.FIHourlyIntelligence.classifyLightPhase(ctx.solarElevationDeg, !!ctx.isBeforeSolarTransit);
  }
  return "unknown";
}

// Wolkenbedeckung wird NUR als grobe, rein beschreibende Bucket-Einteilung genutzt (KB kennt keine
// numerische Schwelle, siehe LURE-007/CONDITION-Tabelle "Overcast") — analog zu den bereits
// bestehenden, dokumentiert-groben Bins in dieser Codebasis (z.B. LABEL_TIERS in
// meerforelle-model.js). KEIN Einfluss auf Champion/Fangindex.
function _cloudBucketFrom(ctx) {
  if (ctx.cloudBucket) return ctx.cloudBucket;
  if (typeof ctx.cloudCoverPct !== "number") return "unknown";
  if (ctx.cloudCoverPct < 30) return "sonnig_klar";
  if (ctx.cloudCoverPct < 70) return "wechselhaft";
  return "bedeckt";
}

function normalizeContext(rawCtx) {
  const ctx = rawCtx || {};
  return {
    thermalRegime: _thermalRegimeFrom(ctx),
    lightPhase: _lightPhaseFrom(ctx),
    cloudBucket: _cloudBucketFrom(ctx),
  };
}

// ---------------------------------------------------------------------------
// A) KOEDERTYP (Funktionsprofil, siehe LURE-021 "Functional Lure Portfolio Beats Colour
// Collection": drei bewusst unterschiedliche Funktionsprofile A/Natural Search Bait,
// B/High-Contrast Option, C/Crustacean-Subtle Fly).
// ---------------------------------------------------------------------------
function _pickKoedertyp(ctx) {
  // Dusk/Night -> High-Contrast-Silhouette (LURE-003 "Dark Silhouette in Low Light", PARTIALLY_
  // SUPPORTED — ausdruecklich NICHT als "Schwarz faengt nachts immer besser" formuliert, siehe KB).
  if (ctx.lightPhase === "night" || ctx.lightPhase === "dusk") {
    return {
      text: "Dunkle, kontrastreiche Silhouette (High-Contrast-Profil)",
      lureType: "high_contrast_silhouette",
      evidenceRefs: ["LURE-003", "LURE-021"],
      evidenceGrade: "C", kbStatus: "PARTIALLY_SUPPORTED",
      note: "Bei wenig Licht kann eine dunkle Silhouette den Kontrast gegen Restlicht/Himmel erhöhen — " +
        "keine belastbare Regel, dass Schwarz grundsätzlich besser fängt.",
    };
  }
  // Standardfall: natürliches Such-Profil (LURE-004/LURE-012/LURE-021 Profil A) — der in der KB am
  // breitesten getragene Ausgangspunkt ("Fish availability/depth -> ... -> Presentation").
  return {
    text: "Natürliches Such-Profil (schlankes Fisch-/Sandaalprofil)",
    lureType: "natural_search_bait",
    evidenceRefs: ["LURE-004", "LURE-012", "LURE-021"],
    evidenceGrade: "C", kbStatus: "PARTIALLY_SUPPORTED",
    note: "Natürliche Beuteform als Ausgangspunkt — Position/Tiefe bleibt vor Feinoptimierung wichtiger (LURE-001).",
  };
}

// Alternative (LURE-018 Crustacean/Fly) wird IMMER als zweite, gleichwertige Option genannt, NICHT
// bedingungsabhängig gerankt (der App fehlt eine Wassertrübungs-/Beutekontext-Messung, siehe
// Auftrag Abschnitt 14: "fehlende Eingaben -> vorsichtigere Formulierung statt neuer Regel").
function _alternative() {
  return {
    text: "Alternative: transluzente Garnelen-/Crustacean-Fliege",
    lureType: "crustacean_fly",
    evidenceRefs: ["LURE-018", "LURE-021"],
    evidenceGrade: "C", kbStatus: "SUPPORTED_EXTERNAL",
    note: "Funktional andere Präsentation als ein Fisch-/Sandaalimitat — als gleichwertige Option, nicht als Rangfolge.",
  };
}

// ---------------------------------------------------------------------------
// B) FARBE/MUSTER — bewusst vorsichtig formuliert, da die KB fast jede klassische Farbregel nur als
// PARTIALLY_SUPPORTED oder INSUFFICIENT_EVIDENCE fuehrt (siehe KB-Abschnitt "MYTH STATUS"). Diese
// Funktion gibt NIE eine einzelne "Marken-/Wunschfarbe" als sichere Empfehlung aus.
// ---------------------------------------------------------------------------
function _pickFarbeMuster(ctx) {
  if (ctx.lightPhase === "night" || ctx.lightPhase === "dusk") {
    return {
      text: "Dunkle bis kontrastreiche Muster",
      evidenceRefs: ["LURE-003"], evidenceGrade: "C", kbStatus: "PARTIALLY_SUPPORTED",
      note: "Kontrast gegen das Restlicht wichtiger als ein bestimmter Farbname.",
    };
  }
  if (ctx.cloudBucket === "bedeckt") {
    // LURE-007: "Kupfer bei bedeckt" ist explizit INSUFFICIENT_EVIDENCE — hier bewusst KEINE
    // Kupfer-Empfehlung, sondern die breitere, KB-konforme Formulierung.
    return {
      text: "Natürliche bis gedeckte Muster ausprobieren",
      evidenceRefs: ["LURE-007", "LURE-004"], evidenceGrade: "D", kbStatus: "INSUFFICIENT_EVIDENCE",
      note: "Für „Kupfer/Gold bei bedecktem Himmel“ gibt es laut KB keine ausreichend belastbare Evidenz — " +
        "keine bestimmte Farbe wird deshalb hier als überlegen genannt.",
    };
  }
  if (ctx.cloudBucket === "sonnig_klar") {
    // LURE-006: "Silber bei Sonne" ist PARTIALLY_SUPPORTED, nicht bewiesen — Formulierung bleibt breit.
    return {
      text: "Natürliche, eher helle/reflektierende Muster (z.B. silbrig) als plausible Grundwahl",
      evidenceRefs: ["LURE-006", "LURE-004"], evidenceGrade: "C", kbStatus: "PARTIALLY_SUPPORTED",
      note: "„Sonne = Silber“ ist nur teilweise gestützt — Wassertrübung/Einfallswinkel/Tiefe spielen laut KB ebenfalls eine Rolle (hier nicht gemessen).",
    };
  }
  if (ctx.thermalRegime === "cold") {
    // LURE-008: Pink/Orange im Kaltwasser ist PARTIALLY_SUPPORTED/PRACTICAL — als Option, nicht als Gesetz.
    return {
      text: "Natürliche Muster, alternativ Attraktorfarben (z.B. Pink/Orange) als verbreitete Kaltwasser-Option",
      evidenceRefs: ["LURE-008", "LURE-004"], evidenceGrade: "C", kbStatus: "PARTIALLY_SUPPORTED",
      note: "Kaltwasser-Attraktorfarben sind praktisch verbreitet, aber laut KB nicht nachweislich überlegen.",
    };
  }
  return {
    text: "Natürliche bis gedeckte Muster",
    evidenceRefs: ["LURE-004", "LURE-010"], evidenceGrade: "D", kbStatus: "PARTIALLY_SUPPORTED",
    note: "Ohne genauere Bedingungsangaben bleibt eine breite, natürliche Musterwahl die konservativste Option.",
  };
}

// ---------------------------------------------------------------------------
// C) PRÄSENTATION (Führungsgeschwindigkeit/Aktion) — LURE-015 warnt AUSDRÜCKLICH vor der zu groben
// Regel "cold = slow / warm = fast" ("OVERSIMPLIFIED" laut Myth Status). Diese Funktion vermeidet
// deshalb absolute Formulierungen und schlägt IMMER eine Spanne/Variation statt einer festen Regel vor.
// ---------------------------------------------------------------------------
function _pickPraesentation(ctx) {
  if (ctx.thermalRegime === "very_warm") {
    return {
      text: "Zügige bis schnelle Führung, kurze Spin-Stops",
      evidenceRefs: ["LURE-016", "LURE-015"], evidenceGrade: "C", kbStatus: "PARTIALLY_SUPPORTED",
      note: "Schnelle Sommerführung ist plausibel und praktisch häufig bestätigt, aber laut KB kontextabhängig, keine feste Regel.",
    };
  }
  if (ctx.thermalRegime === "cold") {
    return {
      text: "Gemächliche bis mittlere Führung, Tempo variieren",
      evidenceRefs: ["LURE-015"], evidenceGrade: "D", kbStatus: "PARTIALLY_SUPPORTED",
      note: "„Kaltes Wasser = immer langsam“ ist laut KB zu grob (OVERSIMPLIFIED) — deshalb hier bewusst eine Spanne statt einer festen Regel.",
    };
  }
  return {
    text: "Mittlere Führung, ggf. mit kurzen Stop-and-Go-Phasen",
    evidenceRefs: ["LURE-015", "LURE-014"], evidenceGrade: "D", kbStatus: "PARTIALLY_SUPPORTED",
    note: "Führungsgeschwindigkeit ist eine eigenständige Variable — ohne weitere Anhaltspunkte bleibt eine mittlere, variable Führung die konservativste Wahl.",
  };
}

// ---------------------------------------------------------------------------
// ORCHESTRATOR — rein synchron/pure, KEIN Netzwerkzugriff, KEIN State, deterministisch (Auftrag
// Abschnitt 33: "gleiche Eingaben -> gleiche Ausgabe"). rawCtx darf UNVOLLSTAENDIG sein — fehlende
// Felder fuehren zu "unknown"-Bins und damit zu den bewusst am breitesten formulierten Zweigen oben
// (NIE zu einem Crash, NIE zu einer erfundenen Praezision).
// ---------------------------------------------------------------------------
function buildLureRecommendation(rawCtx) {
  const ctx = normalizeContext(rawCtx);
  const koedertyp = _pickKoedertyp(ctx);
  const farbeMuster = _pickFarbeMuster(ctx);
  const praesentation = _pickPraesentation(ctx);
  const alternative = _alternative();

  const missingInputs = [];
  if (ctx.thermalRegime === "unknown") missingInputs.push("waterTempC/thermalRegime");
  if (ctx.lightPhase === "unknown") missingInputs.push("solarElevationDeg/lightPhase");
  if (ctx.cloudBucket === "unknown") missingInputs.push("cloudCoverPct");

  // Confidence bleibt bewusst NIE "hoch" — die gesamte KB ist eine externe, persönlich (noch) nicht
  // kalibrierte Evidenzschicht (siehe lure_intelligence_personal_calibration.md: keine Regel ist
  // CONFIRMED_PERSONAL). "mittel" nur, wenn mindestens Thermal-Regime UND Lichtphase bekannt sind.
  const confidence = missingInputs.length >= 2 ? "niedrig" : (missingInputs.length === 1 ? "niedrig" : "mittel");

  return {
    engineVersion: WHAT_ENGINE_VERSION, kbVersion: WHAT_KB_VERSION, scoringImpact: WHAT_SCORING_IMPACT,
    mode: "recommendation", // KEIN "shadow" — dies ist bewusst produktsichtbar (Auftrag Abschnitt 11), aber ohne Score
    inputsUsed: { thermalRegime: ctx.thermalRegime, lightPhase: ctx.lightPhase, cloudBucket: ctx.cloudBucket },
    missingInputs, confidence,
    koedertyp, farbeMuster, praesentation, alternative,
  };
}

if (typeof window !== "undefined") {
  window.FIWhatIntelligence = {
    WHAT_ENGINE_VERSION, WHAT_KB_VERSION, WHAT_SCORING_IMPACT,
    normalizeContext, buildLureRecommendation,
    // Test-Hooks (reine Funktionen, analog zu FIHourlyWindowIntelligence/FIWhereIntelligence)
    _thermalRegimeFrom, _lightPhaseFrom, _cloudBucketFrom,
  };
}
