// Meerforellen-Fangchance-Modell 2.0 — Port von Sprint-1 meerforelle_model.py, unveraendert in
// der Logik (Abschnitt 39: bestehende Meerforellenlogik integrieren, Panels nicht verschmelzen).

const POPULATION_MEAN = 0.5431578947368421;
const SHRINKAGE_K = 15;

const SPOT_STATS = {
  pelzerhaken: { name: "Pelzerhaken", rohquote: 0.9615, n: 26, shrunk: 0.8085 },
  groemitz: { name: "Grömitz", rohquote: 0.9286, n: 28, shrunk: 0.7941 },
  ostsee_allgemein: { name: "Ostsee (allgemein)", rohquote: 0.7742, n: 217, shrunk: 0.7593 },
  suessau: { name: "Süssau", rohquote: 0.6897, n: 29, shrunk: 0.6397 },
  wiek: { name: "Wiek", rohquote: 0.75, n: 12, shrunk: 0.6351 },
  weissenhaus: { name: "Weißenhaus", rohquote: 0.5701, n: 107, shrunk: 0.5668 },
  bliesdorf: { name: "Bliesdorf", rohquote: 0.575, n: 40, shrunk: 0.5663 },
  sierksdorf: { name: "Sierksdorf", rohquote: 0.5029, n: 175, shrunk: 0.506 },
  klinikum: { name: "Klinikum", rohquote: 0.3846, n: 13, shrunk: 0.4695 },
  dahmeshoeved: { name: "Dahmeshöved", rohquote: 0.2727, n: 11, shrunk: 0.4287 },
  seeburgbruecke: { name: "Seeburgbrücke", rohquote: 0.3333, n: 21, shrunk: 0.4208 },
  hafeneinfahrt: { name: "Hafeneinfahrt", rohquote: 0.25, n: 12, shrunk: 0.4129 },
  brodten: { name: "Brodten", rohquote: 0.2571, n: 35, shrunk: 0.3429 },
  brodtner_ufer: { name: "Brodtner Ufer", rohquote: 0.2439, n: 41, shrunk: 0.3241 },
};

function sFactor(month) {
  if ([4, 5, 9, 10, 11].includes(month)) return 1.0;
  if ([3, 12].includes(month)) return 0.7;
  if ([1, 2].includes(month)) return 0.5;
  if ([6, 7, 8].includes(month)) return 0.4;
  return 0.5;
}

function tFactor(temp) {
  if (temp === null || temp === undefined) return null;
  if (temp < 2) return 0.05;
  if (temp < 4) return 0.05 + ((temp - 2) / 2) * 0.25;
  if (temp < 8) return 0.3 + ((temp - 4) / 4) * 0.4;
  if (temp < 12) return 0.7 + ((temp - 8) / 4) * 0.3;
  if (temp < 14) return 1.0;
  if (temp < 16) return 1.0 - ((temp - 14) / 2) * 0.3;
  if (temp < 20) return 0.7 - ((temp - 16) / 4) * 0.4;
  return 0.2;
}

function basisFangchance(month, wassertemp) {
  const s = sFactor(month), t = tFactor(wassertemp);
  if (t === null) return { score: null, label: "Unbekannt", sFactor: s, tFactor: null,
    hinweis: "Keine Wassertemperatur verfuegbar — Fangchance kann nicht berechnet werden." };
  const idx = 100.0 * Math.max(s, 1e-6) ** 0.5 * Math.max(t, 1e-6) ** 0.5;
  const rounded = Math.round(idx * 10) / 10;
  return { score: rounded, label: labelForIndex(rounded), sFactor: s, tFactor: t,
    hinweis: "Basis = Saison × Temperatur (validiert, AUC 0,674 OOS). Wind/Exposition fliessen NICHT in diese Zahl ein." };
}

function confidenceLabel(n) {
  if (n < 10) return "zu wenig Daten";
  if (n < 15) return "niedrig(<15)";
  if (n < 30) return "mittel(15-30)";
  if (n < 60) return "gut(30-60)";
  return "hoch(>60)";
}

function spotMatch(spotKey) {
  if (!spotKey || !SPOT_STATS[spotKey]) {
    return { spotKey, spotName: spotKey || "unbekannt", shrunkRate: null, n: 0, confidenceLabel: "zu wenig Daten",
      hinweis: "Kein historischer Fangbuch-Bezug fuer diesen Spot (n<10 oder unbekannt) — wird gesammelt, aber (noch) nicht fuer eine Aussage genutzt." };
  }
  const st = SPOT_STATS[spotKey];
  return { spotKey, spotName: st.name, shrunkRate: st.shrunk, n: st.n, confidenceLabel: confidenceLabel(st.n),
    hinweis: `Shrinkage-korrigierte historische Fangquote ${(st.shrunk * 100).toFixed(0)}% ` +
      `(roh ${(st.rohquote * 100).toFixed(0)}% bei n=${st.n}, Richtung Gesamtmittel ${(POPULATION_MEAN * 100).toFixed(1)}% gezogen, k=${SHRINKAGE_K}).` };
}

function strategieHinweis(windDirDeg, windBft, onshoreDeg) {
  if (windDirDeg === null || windDirDeg === undefined || windBft === null || windBft === undefined) {
    return "Windangaben unvollstaendig — keine Strategie-Einschaetzung moeglich.";
  }
  const parts = [];
  if (windBft >= 6) parts.push(`Wind ${windBft.toFixed ? windBft.toFixed(0) : windBft} Bft — Sicherheitshinweis: kritisch pruefen, ob Angeln vom Ufer/Boot sicher moeglich ist.`);
  else if (windBft >= 4) parts.push(`Wind ${windBft} Bft — spuerbar, ggf. schwerere Koeder/kurze Wuerfe einplanen.`);
  else parts.push(`Wind ${windBft} Bft — moderat.`);
  if (onshoreDeg !== null && onshoreDeg !== undefined) {
    let diff = Math.abs(windDirDeg - onshoreDeg) % 360;
    diff = diff > 180 ? 360 - diff : diff;
    if (diff <= 30) parts.push("auflandig an diesem Spot — historisch tendenziell foerderlich, EXPERIMENTELL (kein eigenstaendiger, statistisch abgesicherter Score-Faktor, siehe Phase 2.5).");
    else if (diff >= 150) parts.push("ablandig an diesem Spot — Wasser ggf. klarer/ruhiger, aber ohne robusten Fangchance-Zusammenhang in den Daten.");
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// SPRINT 3 — Opportunity Hero (UX Gate, siehe docs/SPRINT3_UX_CONCEPT_COPILOT.md und
// docs/SPRINT3_UX_GATE_FINALIZATION.md). Drei rein additive Bausteine zur bestehenden,
// UNVERAENDERTEN Fangchance-Logik oben:
//   1) ein 4-stufiges Label (Schwach/Mäßig/Gut/Sehr gut) statt bisher 3 Stufen — der numerische
//      Index wird auf dem Startscreen laut Auftrag entfernt/versteckt, das Label muss daher allein
//      differenziert genug sein.
//   2) eine ECHTE, dynamische Spot-Rangliste (rankSpots) statt des bisherigen hartcodierten
//      "Pelzerhaken" — ausdruecklich NUR auf Basis der HISTORISCHEN Spot-Staerke (shrunk-Rate),
//      OHNE jede Tages-/Wetterabhaengigkeit: eine Spot×Wetter-Interaktion ist nicht durch Daten
//      gestuetzt (Phase 2.5: additives Modell, ueber Tagestypen hinweg stabile Rangfolge, Exposure-
//      Variablen bleiben OOS unter Zufallsniveau) und darf laut Auftrag NICHT suggeriert werden.
//      Das ist "Historical Spot Strength", NICHT "Current Spot Suitability" — die Rangfolge aendert
//      sich bewusst NICHT von Tag zu Tag.
//   3) eine dreistufige Confidence (hoch/mittel/niedrig), die NIE in den Index eingerechnet wird,
//      sondern separat aus Umweltdatenqualitaet UND Spot-Stichprobengroesse kombiniert wird
//      (konservatives Minimum — eine Gesamteinschaetzung darf nie sicherer wirken als ihr
//      unsicherstes Einzelsignal).
// ---------------------------------------------------------------------------

const LABEL_TIERS = [
  { min: 75, label: "Sehr gut" },
  { min: 55, label: "Gut" },
  { min: 30, label: "Mäßig" },
  { min: -Infinity, label: "Schwach" },
];
const LABEL_RANK = { "Schwach": 0, "Mäßig": 1, "Gut": 2, "Sehr gut": 3 };

// Schwellen sind eine bewusste, im UX-Gate dokumentierte Setzung, KEINE neue statistische
// Herleitung — bei AUC 0,674 (Out-of-Sample) waere eine feinere Abstufung als vier grobe
// Kategorien ohnehin false precision.
function labelForIndex(idx) {
  if (idx === null || idx === undefined) return "Unbekannt";
  return LABEL_TIERS.find((t) => idx >= t.min).label;
}
function labelRank(label) { return label in LABEL_RANK ? LABEL_RANK[label] : -1; }
function labelChipClass(label) {
  if (label === "Sehr gut" || label === "Gut") return "chip-green";
  if (label === "Mäßig") return "chip-yellow";
  if (label === "Schwach") return "chip-red";
  return "chip";
}

// Dreistufige Confidence (Hoch/Mittel/Niedrig). Kollabiert die bestehende 5-stufige spot-n-Bucket-
// Funktion (confidenceLabel oben, unveraendert und weiterhin fuer Detailtexte genutzt) auf 3 Stufen
// und kombiniert konservativ (Minimum) mit der Umweltdatenqualitaet.
const CONF_RANK = { hoch: 2, mittel: 1, niedrig: 0 };
function spotConfidenceTier(n) {
  if (n === null || n === undefined || n < 15) return "niedrig";
  if (n < 60) return "mittel";
  return "hoch";
}
function combineConfidenceTier(a, b) {
  if (!a) return b || "niedrig";
  if (!b) return a;
  return (CONF_RANK[a] ?? 0) <= (CONF_RANK[b] ?? 0) ? a : b;
}
// Vereinfachte, dokumentierte Heuristik fuer die Vorhersage-Unsicherheit ueber den Horizont: Open-
// Meteo liefert keine eigene Guetenangabe pro Vorhersagewert. Statt das vorzutaeuschen, wird die
// Umwelt-Confidence mit zunehmendem Horizont konservativ GEDECKELT (nicht neu gemessen): Tag 0
// behaelt die tatsaechliche Fetch-Qualitaet, Tag 1-2 hoechstens "mittel", Tag 3-4 hoechstens
// "niedrig" — das ist auch der Grund, warum der "Noch besser"-Hinweis (siehe pickNochBesser)
// praktisch nur fuer nahe Tage ausloesen kann, nicht fuer Tag 4/5.
function forecastEnvTier(dayOffset, actualEnvTier) {
  if (dayOffset <= 0) return actualEnvTier || "niedrig";
  const cap = dayOffset <= 2 ? "mittel" : "niedrig";
  return combineConfidenceTier(actualEnvTier || "hoch", cap);
}

// Dynamische Spot-Rangliste — ersetzt das bisherige hartcodierte "Top Spot: Pelzerhaken" komplett.
// Sortiert NUR nach der shrinkage-korrigierten historischen Fangquote (shrunk). Spots mit n<10
// (kein belastbarer Fangbuch-Bezug) werden ausgeschlossen, ebenso "ostsee_allgemein" (kein
// konkreter, waehlbarer Spot).
function rankSpots(limit = null) {
  const ranked = Object.entries(SPOT_STATS)
    .filter(([key, st]) => key !== "ostsee_allgemein" && st.n >= 10)
    .map(([key, st]) => ({ spotKey: key, name: st.name, shrunkRate: st.shrunk, n: st.n,
      confidenceTier: spotConfidenceTier(st.n) }))
    .sort((a, b) => b.shrunkRate - a.shrunkRate);
  return limit ? ranked.slice(0, limit) : ranked;
}

// "Warum?" — ausschliesslich aus real vorhandenen Signalen (Saison, Wassertemperatur, historische
// Spot-Staerke). Reagiert auf den TATSAECHLICHEN Zustand (auch negativ formuliert, z.B. schwache
// Saison), suggeriert aber NIE eine tagesspezifische Spot-Bedingungs-Interaktion (siehe rankSpots).
// Hinweis: gazetteers.js exportiert bereits ein GAZ.MONTH_NAMES (Objekt fuer Voice-Parsing) im
// selben globalen Script-Scope. Hier bewusst ein eigener, umbenannter Bezeichner (Array, 1-indiziert
// fuer direkten Monats-Lookup), um die Doppel-Deklaration/den SyntaxError zu vermeiden.
const MEFO_MONTH_NAMES = ["", "Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August",
  "September", "Oktober", "November", "Dezember"];
function buildWarumReasons(month, wassertemp, tFactorVal, topSpot) {
  const reasons = [];
  const sVal = sFactor(month);
  if (sVal >= 1.0) reasons.push({ ok: true, text: `Saison aktuell stark (${MEFO_MONTH_NAMES[month]})` });
  else if (sVal >= 0.7) reasons.push({ ok: true, text: `Saison aktuell solide (${MEFO_MONTH_NAMES[month]})` });
  else reasons.push({ ok: false, text: `Saison aktuell eher schwach (${MEFO_MONTH_NAMES[month]})` });

  if (wassertemp === null || wassertemp === undefined || tFactorVal === null) {
    reasons.push({ ok: false, text: "Keine aktuelle Wassertemperatur verfügbar" });
  } else if (tFactorVal >= 0.85) {
    reasons.push({ ok: true, text: `Wassertemperatur im optimalen Bereich (${wassertemp.toFixed(1)} °C)` });
  } else if (tFactorVal >= 0.5) {
    reasons.push({ ok: true, text: `Wassertemperatur im brauchbaren Bereich (${wassertemp.toFixed(1)} °C)` });
  } else {
    reasons.push({ ok: false, text: `Wassertemperatur außerhalb des optimalen Bereichs (${wassertemp.toFixed(1)} °C)` });
  }

  if (topSpot) {
    reasons.push({ ok: true, text: `${topSpot.name} historisch überdurchschnittlich ` +
      `(${Math.round(topSpot.shrunkRate * 100)} %, n=${topSpot.n})` });
  }
  return reasons;
}

// "Noch besser"-Regel (Sprint-3-UX-Gate, Punkt 1) — dokumentiert, nachvollziehbar, konservativ:
//   1) Betrachtet werden nur Tage NACH heute im uebergebenen Fenster (3-5 Tage).
//   2) Ein Tag ist Kandidat, wenn sein Label eine echte Stufe besser ist als das heutige
//      (labelRank(tag) - labelRank(heute) >= 1) UND sein Index mindestens 15 Punkte ueber dem
//      heutigen liegt (verhindert, dass ein Tag nur knapp ueber einer Label-Grenze "besser" wirkt).
//   3) Ein Kandidat wird NUR gezeigt, wenn seine eigene Confidence mindestens "mittel" ist (keine
//      Umplanung auf Basis einer unsicheren Fernprognose — s. forecastEnvTier).
//   4) Unter den verbleibenden Kandidaten gewinnt der mit dem hoechsten Index.
//   5) Erfuellt kein Tag alle Kriterien, wird KEIN Hinweis gezeigt.
function pickNochBesser(todayEntry, futureDays) {
  const MIN_LABEL_STEPS = 1, MIN_IDX_DELTA = 15;
  if (!todayEntry || todayEntry.index === null) return null;
  const candidates = futureDays.filter((d) =>
    d.index !== null &&
    (labelRank(d.label) - labelRank(todayEntry.label)) >= MIN_LABEL_STEPS &&
    (d.index - todayEntry.index) >= MIN_IDX_DELTA &&
    d.confidenceTier !== "niedrig");
  if (!candidates.length) return null;
  return candidates.reduce((best, d) => (d.index > best.index ? d : best), candidates[0]);
}

window.FIMefoModel = { POPULATION_MEAN, SHRINKAGE_K, SPOT_STATS, sFactor, tFactor,
  basisFangchance, confidenceLabel, spotMatch, strategieHinweis,
  labelForIndex, labelRank, labelChipClass, spotConfidenceTier, combineConfidenceTier,
  forecastEnvTier, rankSpots, buildWarumReasons, pickNochBesser };
