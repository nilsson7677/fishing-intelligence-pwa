// CHALLENGER_STATE_V1 — Regime-STATE-Modell fuer den Phase-5-Shadow-Pilot (GO-Freigabe
// 19.08.2026, siehe PHASE5_REGIME_STATE_SHADOW_PILOT_SPEC.md, Abschnitt 2 + 10).
//
// STRIKTE TRENNUNG VOM CHAMPION: Diese Datei liest/schreibt NICHTS in meerforelle-model.js und
// wird NIRGENDS in einer produktiven UI-View aufgerufen. Sie existiert ausschliesslich, damit
// shadow.js im Hintergrund einen Challenger-Score berechnen und protokollieren kann. Der Nutzer
// sieht davon nichts (siehe Abschnitt 5.3 der Spezifikation: "in KEINER produktiven UI-Ansicht").
//
// PROVENANCE (keine erfundenen Zahlen — Grundsatz "kein Threshold Mining" aus der Spezifikation):
//   1) regime_of(month, temp) ist eine woertliche Portierung der Python-Funktion aus
//      phase2/model_comparison.py (dort Zeile ~40-49) — dieselbe Definition, mit der der
//      historische Walk-Forward-Vergleich (Modell "D_regime_state", AUC 0,676/PR-AUC 0,739,
//      13 Folds 2007-2020, n_oos=618) gerechnet wurde. Keine neue Grenze wurde fuer den
//      Shadow-Pilot gezogen oder nachtraeglich optimiert.
//   2) Die Koeffizienten unten sind das Ergebnis EINES EINMALIGEN Fits (Spezifikation Abschnitt
//      2.3: "Einmaliges Fitting bei Pilotstart ... auf dem gesamten historischen Datensatz"),
//      nicht der 13 walk-forward-Folds selbst. Exakt dieselbe Modellierungsmethode wie im
//      Original-Skript: sklearn.linear_model.LogisticRegression(max_iter=1000, C=1.0), 7 one-hot-
//      kodierte Regime-Spalten (kein manueller Intercept-Term — sklearn fittet ihn separat),
//      trainiert auf sub = { Meerforelle, Datum bekannt, fang_ja bestimmbar, Wassertemperatur
//      vorhanden } aus phase2/canonical_dataset.json, n=739 (2002-2020).
//   3) Fit ausgefuehrt am 19.08.2026, Ergebnis validiert gegen die empirischen Fangquoten pro
//      Regime (Regularisierung zieht kleine Kategorien wie Spring_Feeding n=10 und Early_Summer
//      n=16 sichtbar Richtung Populationsmittel — erwartetes, korrektes Verhalten, keine
//      Ueberanpassung):
//        Regime                  n     empirisch   Modell-p
//        Autumn_Feeding          181   78,45 %      78,19 %
//        Early_Summer             16  100,00 %      90,81 %
//        LateSummer_Transition    19   94,74 %      88,32 %
//        Spring_Feeding           10   40,00 %      48,72 %
//        Spring_Warming          291   60,82 %      60,95 %
//        Summer_Heat              24   62,50 %      63,54 %
//        Winter_Stability        198   29,29 %      30,13 %
//   4) Versionierung (Spezifikation Abschnitt 10): JEDE Aenderung an regime_of(), an den
//      Koeffizienten oder an der Fit-Methode erzeugt zwingend CHALLENGER_STATE_V2 mit eigenem
//      Validierungslauf — kein stilles Update dieser Konstanten waehrend eines laufenden Piloten.

const CHALLENGER_STATE_V1_META = {
  version: "CHALLENGER_STATE_V1",
  fitted_at: "2026-08-19",
  fitted_on_n: 739,
  source_dataset: "phase2/canonical_dataset.json (Meerforelle, datiert, fang_ja bestimmbar, Wassertemperatur vorhanden)",
  method: "sklearn LogisticRegression(max_iter=1000, C=1.0), 7 one-hot Regime-Spalten, einmaliger Fit (kein Walk-Forward)",
  frozen: true, // Grundsatz: waehrend des Piloten nicht nachtrainieren (Spezifikation Abschnitt 2.3/10)
};

// Woertlich aus phase2/model_comparison.py::regime_of() — siehe Provenance-Kommentar oben.
function regimeOf(month, temp) {
  if (temp !== null && temp !== undefined && temp >= 17) return "Summer_Heat";
  if ([12, 1, 2].includes(month)) return "Winter_Stability";
  if ([3, 4].includes(month)) return "Spring_Warming";
  if (month === 5) return "Spring_Feeding";
  if ([6, 7].includes(month)) return "Early_Summer";
  if ([8, 9].includes(month)) return "LateSummer_Transition";
  if ([10, 11].includes(month)) return "Autumn_Feeding";
  return "Unknown";
}

// Aus dem einmaligen Fit (siehe Provenance oben) — sortierte Kategorienliste + Koeffizienten in
// EXAKT derselben Reihenfolge, wie sie sklearn (sorted(set(...)), alphabetisch) erzeugt hat.
const REGIME_CATEGORIES = ["Autumn_Feeding", "Early_Summer", "LateSummer_Transition",
  "Spring_Feeding", "Spring_Warming", "Summer_Heat", "Winter_Stability"];
const REGIME_INTERCEPT = 0.8136987651849482;
const REGIME_COEF = {
  Autumn_Feeding: 0.46336283865441086,
  Early_Summer: 1.476402633276515,
  LateSummer_Transition: 1.2095833895464863,
  Spring_Feeding: -0.8650939469301756,
  Spring_Warming: -0.3683812394768787,
  Summer_Heat: -0.2584582555670169,
  Winter_Stability: -1.6547998975909433,
};

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

// scoreChallengerState(month, temp) -> { regime, probability, score0to100, tier } | null
// Liefert null nur, wenn temp fehlt UND das Regime nicht ohnehin monats-eindeutig waere — analog
// zur Champion-Logik (tFactor(null) => Score nicht berechenbar), damit ein fehlender Wert NIE als
// erfundener Zustand maskiert wird.
function scoreChallengerState(month, temp) {
  if (month === null || month === undefined) return null;
  // Wie beim Champion (basisFangchance): ohne Wassertemperatur ist "Summer_Heat" nicht pruefbar
  // und der Score wird bewusst NICHT berechnet statt eine falsche Kategorie zu raten.
  if (temp === null || temp === undefined) return null;
  const regime = regimeOf(month, temp);
  if (regime === "Unknown" || !(regime in REGIME_COEF)) return null;
  const logit = REGIME_INTERCEPT + REGIME_COEF[regime];
  const probability = sigmoid(logit);
  const score0to100 = Math.round(probability * 1000) / 10;
  // Dieselben Tier-Grenzen wie der Champion (Spezifikation Abschnitt 7: "keine neue Tier-Grenze
  // optimieren") — bewusst FIMefoModel.labelForIndex wiederverwendet statt einer eigenen Kopie der
  // Schwellen 75/55/30, damit beide Modelle garantiert identisch geschnitten werden.
  const tier = (typeof window !== "undefined" && window.FIMefoModel) ? window.FIMefoModel.labelForIndex(score0to100) : null;
  return { regime, probability, score0to100, tier, model_version: CHALLENGER_STATE_V1_META.version };
}

if (typeof window !== "undefined") {
  window.FIChallengerState = {
    META: CHALLENGER_STATE_V1_META, REGIME_CATEGORIES, REGIME_INTERCEPT, REGIME_COEF,
    regimeOf, scoreChallengerState,
  };
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { CHALLENGER_STATE_V1_META, REGIME_CATEGORIES, REGIME_INTERCEPT, REGIME_COEF, regimeOf, scoreChallengerState };
}
