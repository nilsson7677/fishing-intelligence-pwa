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
  const label = idx >= 65 ? "Gut" : idx >= 40 ? "Mittel" : "Schwach";
  return { score: Math.round(idx * 10) / 10, label, sFactor: s, tFactor: t,
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

window.FIMefoModel = { POPULATION_MEAN, SHRINKAGE_K, SPOT_STATS, sFactor, tFactor,
  basisFangchance, confidenceLabel, spotMatch, strategieHinweis };
