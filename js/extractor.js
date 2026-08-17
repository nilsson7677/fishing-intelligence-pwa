// Regelbasierte Text-/Sprachextraktion — Port + Erweiterung von Sprint-1 extraction/extractor.py.
//
// Sprint-2-Neuerung (Abschnitt 12/42): InformationExtractionProvider-Abstraktion, damit ein
// spaeterer LLMExtractor die UI nicht anfassen muss. Aktuell nur RuleBasedExtractor implementiert
// (Abschnitt 11: NICHT ueberengineeren — kein LLM ohne Freigabe, siehe SPRINT2_REPORT.md).
//
// Sprint-2-Neuerung 2: classify() unterscheidet jetzt vier Ergebnistypen (Abschnitt 42):
//   "catch"            — eigener/direkt berichteter Fang
//   "trip_blank"        — eigener Trip ohne Fisch/Kontakt (Nullrunde/"kein Kontakt")
//   "hearsay_report"     — Hoerensagen (gehedged: "X meinte, dass...")
//   "direct_report"      — Fremdbericht ohne Hedge ("Peter hatte ... gefangen")
//   "observation"         — qualitative Gewaesserbeobachtung ohne Fangbezug
//
// Kernregel unveraendert (Abschnitt 10/40): vage Sprache wird NIE in falsche Praezision
// uebersetzt. "hinten an der Trave" bleibt ohne erfundenen Spot; "ordentliche"/"großer" bleiben
// qualitativ; "viele"/"keine Ahnung wie viele" werden NIE zu einer Zahl.

class FieldGuess {
  constructor(value = null, confidence = 0.0, precision = "unknown", note = "") {
    this.value = value; this.confidence = confidence; this.precision = precision; this.note = note;
  }
}

class InformationExtractionProvider {
  // eslint-disable-next-line no-unused-vars
  extract(rawText, referenceDate) { throw new Error("not implemented"); }
}

const APPROX_MARKERS = ["ungefaehr", "ungefähr", "so um die", "ca.", "etwa", "circa", "irgendwo", "irgendwelche", "irgendwelchen"];

function findMultiword(textLower, aliases) {
  const keys = Object.keys(aliases).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (textLower.includes(key)) return [aliases[key], key];
  }
  return [null, null];
}

// ---------------------------------------------------------------------------
// FUZZY ENTITY RESOLUTION (Voice Reliability Loop Runde 2, Abschnitt 5) — NUR als Rueckfallebene,
// wenn kein exakter Gazetteer-Treffer existiert. Bewusst vorsichtig: kein blindes Auto-Korrigieren,
// keine entfernten Treffer (Distanz-Schwelle skaliert mit Wortlaenge), reduzierte Confidence, und
// der Grund ("aehnelt X, Distanz Y") wird immer sichtbar mitgeliefert statt versteckt.
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[n];
}

function fuzzyDistanceThreshold(len) {
  if (len <= 9) return 1;   // kurze/mittlere Namen: nur 1 Tippfehler/Fehlhoerer erlaubt
  return 2;                 // laengere zusammengesetzte Namen: etwas mehr Toleranz
}

function findFuzzySpot(textLower) {
  const tokens = textLower.replace(/[.,;!?]/g, " ").split(/\s+/).filter(Boolean);
  const candidates = tokens.map((t) => ({ text: t, display: t }));
  for (let i = 0; i < tokens.length - 1; i++) {
    candidates.push({ text: `${tokens[i]}${tokens[i + 1]}`, display: `${tokens[i]} ${tokens[i + 1]}` });
  }
  let best = null;
  for (const [aliasName, pair] of Object.entries(GAZ.SPOT_ALIASES)) {
    const nameCompact = aliasName.replace(/\s+/g, "");
    if (nameCompact.length < 5) continue; // sehr kurze Spot-Namen nicht fuzzy vergleichen (Fehltrefferrisiko)
    const threshold = fuzzyDistanceThreshold(nameCompact.length);
    for (const cand of candidates) {
      if (cand.text.length < 4) continue;
      const dist = levenshtein(cand.text, nameCompact);
      // HINWEIS: dist===0 ist hier bewusst NICHT ausgeschlossen. Das passiert z.B. bei getrennt
      // gesprochenen/transkribierten Namen ("Blies Dorf" statt "Bliesdorf") — der Kandidat wird
      // ohne Leerzeichen verglichen und ist dann IDENTISCH mit dem bekannten Spot, obwohl der
      // Originaltext (mit Leerzeichen) von findMultiword() vorher zu Recht NICHT gefunden wurde.
      // Genau dieser Fall ist explizit als Fuzzy-Beispiel im Auftrag genannt (Confidence: mittel).
      if (dist > threshold) continue;
      if (!best || dist < best.distance) {
        best = { spotKey: pair[0], waterId: pair[1], name: aliasName, distance: dist, rawToken: cand.display };
      }
    }
  }
  return best;
}

function findNumberBefore(textLower, anchorWord, maxLookback = 3) {
  // Sucht rueckwaerts bis zu `maxLookback` Woerter vor dem Ankerwort nach einer Ziffer/einem
  // Zahlwort — NICHT nur das unmittelbar davorstehende Wort, weil dazwischen ein qualitatives
  // Adjektiv stehen kann ("drei ordentliche Zander", "zwei kleine Barsche"). Bricht ab, sobald
  // ein Satzzeichen ueberschritten wird, um nicht in den vorherigen Satz zu greifen.
  const idx = textLower.indexOf(anchorWord);
  if (idx === -1) return null;
  const before = textLower.slice(0, idx).trim();
  const lastClause = before.split(/[.,;!?]/).pop().trim();
  const tokens = lastClause.split(/\s+/).filter(Boolean);
  for (let i = 1; i <= Math.min(maxLookback, tokens.length); i++) {
    const tok = tokens[tokens.length - i];
    if (/^\d+$/.test(tok)) return parseInt(tok, 10);
    if (Object.prototype.hasOwnProperty.call(GAZ.GERMAN_NUMBER_WORDS, tok)) return GAZ.GERMAN_NUMBER_WORDS[tok];
  }
  return null;
}

function extractDate(textLower, referenceDate) {
  if (textLower.includes("heute")) {
    return new FieldGuess(isoDate(referenceDate), 0.95, "exact", "'heute' relativ zum Erfassungsdatum aufgeloest");
  }
  if (textLower.includes("gestern")) {
    const d = addDays(referenceDate, -1);
    return new FieldGuess(isoDate(d), 0.9, "exact",
      "'gestern' relativ zum Erfassungsdatum aufgeloest — der Kalendertag ist eindeutig, NICHT jedoch eine Uhrzeit.");
  }
  if (textLower.includes("letzte woche")) {
    const start = addDays(referenceDate, -10), end = addDays(referenceDate, -4);
    return new FieldGuess(null, 0.3, "approximate",
      `'letzte Woche' — kein exaktes Datum ableitbar, ungefaehrer Zeitraum ${isoDate(start)} bis ${isoDate(end)}, ` +
      `NICHT als exaktes Datum gespeichert (keine Scheingenauigkeit).`);
  }
  const m = textLower.match(/am (\d{1,2})\.?\s*([a-zä]+)/);
  if (m) {
    const dayNum = parseInt(m[1], 10);
    const monthNum = GAZ.MONTH_NAMES[m[2]];
    if (monthNum) {
      let year = referenceDate.getFullYear();
      let candidate = new Date(Date.UTC(year, monthNum - 1, dayNum));
      if (candidate > referenceDate) candidate = new Date(Date.UTC(year - 1, monthNum - 1, dayNum));
      return new FieldGuess(isoDate(candidate), 0.8, "exact",
        `Tag+Monat explizit genannt ('${m[0]}'); Jahr als naechstliegendes Jahr <= Erfassungsdatum angenommen ` +
        `(${candidate.getUTCFullYear()}) — Annahme dokumentiert, nicht verschwiegen.`);
    }
  }
  return new FieldGuess(null, 0.0, "unknown", "Kein Datumshinweis im Text gefunden");
}

function extractDayPart(textLower) {
  for (const [marker, part] of Object.entries(GAZ.DAYPART_MARKERS)) {
    if (textLower.includes(marker)) {
      return new FieldGuess(part, 0.8, "approximate", `Tageszeit aus Textmarker '${marker}' — KEINE exakte Uhrzeit abgeleitet`);
    }
  }
  return new FieldGuess("unknown", 0.0, "unknown", "Keine Tageszeit im Text erkennbar");
}

// Namensmuster: erlaubt auch Doppelnamen mit Bindestrich ("Kai-Uwe", "Hans-Peter") — vorher wurde
// bei "Kai-Uwe hatte..." faelschlich nur "Uwe" als Person erkannt (Voice Reliability Loop Runde 2,
// beim Root-Cause-Check von Testfall A/E aufgefallen).
const NAME_PATTERN = "[A-ZÄÖÜ][a-zäöüß]+(?:-[A-ZÄÖÜ][a-zäöüß]+)?";

function detectSourceAttribution(textLower, rawText) {
  // Hoerensagen (gehedged) hat Vorrang vor Direktbericht, falls beides zutrifft.
  const hasHearsayMarker = GAZ.HEARSAY_MARKERS.some((m) => textLower.includes(m));
  if (hasHearsayMarker) {
    const m = rawText.match(new RegExp(`(${NAME_PATTERN})\\s+(meinte|erzaehlte|erzählte)`));
    return { mode: "hearsay", person: m ? m[1] : null };
  }
  // Direktbericht: das Namensmuster wird NUR am Anfang eines Satzes/Teilsatzes akzeptiert. Grund:
  // im Deutschen ist JEDES Nomen grossgeschrieben ("Abend hat...", "Wetter hat..."), nicht nur
  // Eigennamen - ein reines Grossbuchstabe+Verb-Muster wuerde bei haeufigen Verben wie "hat" sonst
  // z.B. in "Gestern Abend hat Thomas ... gefangen" faelschlich "Abend" als Person erkennen. In der
  // Praxis steht der Name als Fangberichts-Subjekt praktisch immer am Satzanfang ("Peter hatte...",
  // "Kai-Uwe hat...").
  const clauses = rawText.split(/(?<=[.!?;])\s+/).map((c) => c.trim()).filter(Boolean);
  for (const clause of clauses) {
    for (const verb of GAZ.DIRECT_REPORT_VERBS) {
      const m = clause.match(new RegExp(`^(${NAME_PATTERN})\\s+${verb}\\b`));
      if (m) return { mode: "direct_report", person: m[1] };
    }
  }
  return { mode: "own", person: null };
}

function extractSpecies(textLower) {
  const [val, key] = findMultiword(textLower, GAZ.SPECIES_ALIASES);
  if (val) return new FieldGuess(val, 0.9, "exact", `Gazetteer-Treffer '${key}'`);
  return new FieldGuess(null, 0.0, "unknown", "Keine Zielart im Text erkannt");
}

function extractWaterAndSpot(textLower) {
  const [spotVal, spotKey] = findMultiword(textLower, GAZ.SPOT_ALIASES);
  if (spotVal) {
    const [spotId, waterId] = spotVal;
    return [
      new FieldGuess(waterId, 0.85, "exact", `Gewaesser aus Spot '${spotKey}' erschlossen`),
      new FieldGuess(spotId, 0.9, "exact", `Gazetteer-Treffer '${spotKey}'`),
    ];
  }
  const [waterVal, waterKey] = findMultiword(textLower, GAZ.WATER_ALIASES);
  if (waterVal) {
    return [
      new FieldGuess(waterVal, 0.85, "exact", `Gazetteer-Treffer '${waterKey}'`),
      new FieldGuess(null, 0.0, "unknown",
        /hinten|irgendwo|ungefaehr|ungefähr/.test(textLower)
          ? "Nur vage Ortsangabe im Text ('hinten an ...' o.ae.) — KEIN erfundener Spot/GPS-Punkt"
          : "Kein konkreter Spot-Name im Text, nur Gewaesser"),
    ];
  }

  // Kein exakter Treffer fuer Spot ODER Gewaesser — vorsichtiger Fuzzy-Versuch (Abschnitt 5).
  // Wird NIE automatisch als sicherer Wert uebernommen: reduzierte Confidence, "approximate"
  // statt "exact", und die Begruendung ist immer sichtbar (siehe unresolvedNotes in extract()).
  const fuzzy = findFuzzySpot(textLower);
  if (fuzzy) {
    const spotGuess = new FieldGuess(fuzzy.spotKey, 0.55, "approximate",
      `Fuzzy-Match: '${fuzzy.rawToken}' ähnelt bekanntem Spot '${fuzzy.name}' (Levenshtein-Distanz ${fuzzy.distance}) — Confidence: mittel, bitte prüfen/bestätigen.`);
    spotGuess.fuzzy = true; spotGuess.fuzzyRawToken = fuzzy.rawToken;
    const waterGuess = new FieldGuess(fuzzy.waterId, 0.5, "approximate",
      `Gewässer aus vermutetem Spot '${fuzzy.name}' erschlossen (Fuzzy-Match, unsicher).`);
    return [waterGuess, spotGuess];
  }

  return [new FieldGuess(null, 0.0, "unknown", "Kein Gewaesser erkannt"),
    new FieldGuess(null, 0.0, "unknown", "Kein Spot im Gazetteer gefunden")];
}

function extractFishCountAndBlank(textLower, speciesKey) {
  if (GAZ.BLANK_TRIP_MARKERS.some((m) => textLower.includes(m)) ||
      GAZ.CONTACT_BLANK_MARKERS.some((m) => textLower.includes(m))) {
    const marker = GAZ.BLANK_TRIP_MARKERS.find((m) => textLower.includes(m)) ||
      GAZ.CONTACT_BLANK_MARKERS.find((m) => textLower.includes(m));
    return {
      fishCount: new FieldGuess(0, 0.95, "exact", `'${marker}' = Nullrunde/kein Fischkontakt`),
      isBlank: new FieldGuess(true, 0.95, "exact", ""),
      contactCount: new FieldGuess(0, 0.9, "exact", ""),
    };
  }
  if (GAZ.UNKNOWN_QUANTITY_MARKERS.some((m) => textLower.includes(m))) {
    return {
      fishCount: new FieldGuess(null, 0.1, "unknown",
        "Explizit unbekannte Menge ('keine Ahnung wie viele') — NICHT geschaetzt"),
      isBlank: new FieldGuess(false, 0.5, "unknown", ""),
      contactCount: new FieldGuess(null, 0.0, "unknown", ""),
    };
  }
  for (const [marker, note] of Object.entries(GAZ.QUALITATIVE_QUANTITY_MARKERS)) {
    if (textLower.includes(marker)) {
      return {
        fishCount: new FieldGuess(null, 0.3, "approximate", `Qualitative Mengenangabe: ${note} — NICHT in eine Zahl uebersetzt`),
        isBlank: new FieldGuess(false, 0.6, "unknown", ""),
        contactCount: new FieldGuess(null, 0.0, "unknown", ""),
      };
    }
  }
  let count = null;
  if (speciesKey) {
    for (const [surface, root] of Object.entries(GAZ.SPECIES_ALIASES)) {
      if (root === speciesKey && textLower.includes(surface)) {
        count = findNumberBefore(textLower, surface);
        if (count !== null) break;
      }
    }
  }
  if (count === null && /\b(einen|eine|ein)\b/.test(textLower)) count = 1;
  if (count !== null) {
    return {
      fishCount: new FieldGuess(count, 0.85, "exact", "Zahlwort/Ziffer vor Zielart gefunden"),
      isBlank: new FieldGuess(count === 0, 0.85, "exact", ""),
      contactCount: new FieldGuess(null, 0.0, "unknown", ""),
    };
  }
  return {
    fishCount: new FieldGuess(null, 0.0, "unknown", "Keine Fangzahl im Text erkannt"),
    isBlank: new FieldGuess(null, 0.0, "unknown", ""),
    contactCount: new FieldGuess(null, 0.0, "unknown", ""),
  };
}

function extractLength(textLower) {
  const isApprox = APPROX_MARKERS.some((m) => textLower.includes(m));
  let m = textLower.match(/(?:ungefaehr|ungefähr|um die|ca\.?|etwa|circa)\s*(\d{2,3})\b/);
  if (!m) m = textLower.match(/\b(\d{2,3})\s*(?:cm|zentimeter)\b/);
  if (!m) {
    // "58er Meerforelle" -> 58 cm (gaengige Anglerkonvention) — ABER NUR, wenn das naechste Wort
    // eine Zielart ist. Sonst konfundiert dieses Muster mit Koedergroessen ("12er Gummis") und
    // wuerde eine falsche Fischlaenge erfinden (siehe Sprint-2-Testlauf, Fall 'Kalle').
    for (const bm of textLower.matchAll(/\b(\d{2,3})er\b/g)) {
      const after = textLower.slice(bm.index + bm[0].length).trimStart();
      const followedBySpecies = Object.keys(GAZ.SPECIES_ALIASES).some((sp) => after.startsWith(sp));
      const followedByLureWord = /^(gummis?|köder|koeder|jig|blinker|wobbler)/.test(after);
      if (followedBySpecies && !followedByLureWord) { m = bm; break; }
    }
  }
  if (m) {
    const val = parseFloat(m[1]);
    const prec = isApprox ? "approximate" : "exact";
    const note = isApprox
      ? "Näherungsangabe ('ungefähr'/'so um die') — NICHT als exakter Wert gespeichert"
      : /er\b/.test(m[0]) && !/cm|zentimeter/.test(m[0])
        ? "Umgangssprachliche '...er'-Groessenangabe (z.B. '58er') vor Zielart als cm interpretiert — gaengige Anglerkonvention, als Annahme dokumentiert"
        : "Explizite Zahl im Text";
    return new FieldGuess(val, isApprox ? 0.8 : 0.75, prec, note);
  }
  if (/gross(?:en|er|e)?\b|groß(?:en|er|e)?\b|ordentlich(?:e|en)?\b/.test(textLower)) {
    return new FieldGuess(null, 0.2, "unknown", "Nur qualitative Groessenangabe (z.B. 'groß'/'ordentlich') im Text — KEINE Zahl erfunden");
  }
  if (/klein(?:e|en)?\b/.test(textLower)) {
    return new FieldGuess(null, 0.2, "unknown", "Nur qualitative Groessenangabe ('klein') im Text — KEINE Zahl erfunden");
  }
  return new FieldGuess(null, 0.0, "unknown", "Keine Groessenangabe im Text");
}

function extractLure(textLower) {
  const [typeVal, typeKey] = findMultiword(textLower, GAZ.LURE_ALIASES);
  const [colorVal, colorKey] = findMultiword(textLower, GAZ.LURE_COLOR_ALIASES);
  const tg = typeVal ? new FieldGuess(typeVal, 0.9, "exact", `Gazetteer-Treffer '${typeKey}'`)
    : new FieldGuess(null, 0.0, "unknown", "Kein Koedertyp im Text");
  const cg = colorVal ? new FieldGuess(colorVal, 0.85, "exact", `Gazetteer-Treffer '${colorKey}'`)
    : new FieldGuess(null, 0.0, "unknown", "Keine Koederfarbe im Text");
  let sizeGuess = new FieldGuess(null, 0.0, "unknown", "Keine Koedergroesse im Text");
  const sm = textLower.match(/(\d{1,2})\s*er\s*(gummis?|köder|koeder)/);
  if (sm) sizeGuess = new FieldGuess(`${sm[1]}er`, 0.6, "approximate",
    "Umgangssprachliche Koedergroesse (z.B. '12er') — als Naeherung, nicht als exakte mm/cm-Groesse gespeichert");
  return [tg, cg, sizeGuess];
}

function extractDuration(textLower) {
  const m = textLower.match(/(\d+)\s*stunden?\b/);
  if (m) return new FieldGuess(parseInt(m[1], 10) * 60, 0.9, "exact", "Dauer explizit in Stunden genannt");
  return new FieldGuess(null, 0.0, "unknown", "Keine Dauerangabe im Text");
}

function extractDepth(textLower) {
  // Ziffer ODER deutsches Zahlwort ("acht Meter tief") — die Sprint-2-Sprachbeispiele nutzen
  // ausgesprochene Zahlwoerter, keine Ziffern (Voice-Transkript, keine Tastatureingabe).
  const numWordAlt = Object.keys(GAZ.GERMAN_NUMBER_WORDS).filter((w) => w !== "kein" && w !== "keine").join("|");
  const re = new RegExp(`(?:ungefaehr|ungefähr|ca\\.?|etwa|circa)?\\s*(\\d{1,2}|${numWordAlt})\\s*(?:meter|m)\\s*tief`);
  const m = textLower.match(re);
  if (m) {
    const val = /^\d+$/.test(m[1]) ? parseFloat(m[1]) : GAZ.GERMAN_NUMBER_WORDS[m[1]];
    if (val !== null && val !== undefined) {
      return new FieldGuess(val, 0.75, "approximate", "Tiefenangabe (meist naeherungsweise gemeint, daher approximate)");
    }
  }
  return new FieldGuess(null, 0.0, "unknown", "Keine Tiefenangabe im Text");
}

function classify(textLower, blankGuess) {
  if (GAZ.OBSERVATION_MARKERS.some((m) => textLower.includes(m)) &&
      !GAZ.SPECIES_ALIASES && false) { /* unreachable, placeholder to keep lint happy */ }
  const hasObservationMarker = GAZ.OBSERVATION_MARKERS.some((m) => textLower.includes(m));
  const hasCatchVerb = /gefangen|gefischt|kontakt/.test(textLower);
  if (hasObservationMarker && !hasCatchVerb) return "observation";
  if (blankGuess && blankGuess.value === true) return "trip_blank";
  return null; // wird von attribution ueberschrieben (own/hearsay/direct_report)
}

function isoDate(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { const r = new Date(d); r.setUTCDate(r.getUTCDate() + n); return r; }

class RuleBasedExtractor extends InformationExtractionProvider {
  extract(rawText, referenceDate) {
    const textLower = rawText.toLowerCase();
    const attribution = detectSourceAttribution(textLower, rawText);

    const species = extractSpecies(textLower);
    const [water, spot] = extractWaterAndSpot(textLower);
    const date = extractDate(textLower, referenceDate);
    const dayPart = extractDayPart(textLower);
    const { fishCount, isBlank, contactCount } = extractFishCountAndBlank(textLower, species.value);
    const length = extractLength(textLower);
    const [lureType, lureColor, lureSize] = extractLure(textLower);
    const duration = extractDuration(textLower);
    const depth = extractDepth(textLower);

    let recordType = classify(textLower, isBlank);
    if (recordType === null) {
      if (attribution.mode === "hearsay") recordType = "hearsay_report";
      else if (attribution.mode === "direct_report") recordType = "direct_report";
      else recordType = "catch";
    }

    const unresolvedNotes = [];
    if (!species.value && recordType !== "observation" && recordType !== "trip_blank") {
      unresolvedNotes.push("Keine Zielart erkannt — Feld bleibt leer statt geraten.");
    }
    if (!spot.value && !water.value) unresolvedNotes.push("Kein Ort erkannt.");
    if (spot.fuzzy) unresolvedNotes.push(`📍 ${spot.note}`);

    return {
      rawTranscript: rawText, recordType, sourceMode: attribution.mode, sourcePerson: attribution.person,
      species, water, spot, date, dayPart, fishCount, isBlankTrip: isBlank, contactCount,
      lengthCm: length, lureType, lureColor, lureSize, durationMinutes: duration, depthM: depth,
      unresolvedNotes,
    };
  }
}

function sourceQualityFor(draft) {
  switch (draft.recordType) {
    case "hearsay_report": return "D_hearsay";
    case "direct_report": return "C_direct_report";
    case "observation": return "B_own_manual"; // eigene Beobachtung
    default: return "B_own_manual"; // eigener nachtraeglicher Text-/Sprach-Eintrag
  }
}

function confirmCard(draft) {
  const parts = [];
  if (draft.fishCount.value !== null && draft.fishCount.value !== undefined) {
    parts.push(`${draft.fishCount.value}x ${draft.species.value || "?"}`);
  } else if (draft.species.value) {
    parts.push(draft.species.value);
  } else if (draft.recordType === "observation") {
    parts.push("Beobachtung");
  } else if (draft.recordType === "trip_blank") {
    parts.push("Nullrunde");
  }
  if (draft.spot.value) parts.push(`@ ${draft.spot.value}`);
  else if (draft.water.value) parts.push(`@ ${draft.water.value}`);
  const headline = parts.length ? parts.join(" ") : "Eintrag (unklar, bitte pruefen)";
  const lowConfFields = ["species", "water", "spot", "date", "fishCount", "lengthCm"]
    .filter((f) => draft[f].value !== null && draft[f].value !== undefined && draft[f].confidence < 0.6);
  return {
    headline, datum: draft.date.value, tageszeit: draft.dayPart.value,
    spot: draft.spot.value, water: draft.water.value, anzahl: draft.fishCount.value,
    recordType: draft.recordType,
    quelle: { hearsay_report: "Hörensagen", direct_report: "Direktbericht", observation: "Eigene Beobachtung" }[draft.recordType] || "Eigene Meldung",
    von: draft.sourcePerson,
    bitte_pruefen: lowConfFields,
    hinweis: [draft.date, draft.lengthCm, draft.spot].some((g) => g.precision === "approximate")
      ? "Vage Angaben wurden NICHT in falsche Praezision umgewandelt — siehe Detailfelder."
      : "",
  };
}

window.FIExtraction = {
  RuleBasedExtractor, InformationExtractionProvider, FieldGuess, sourceQualityFor, confirmCard, isoDate, addDays,
  // fuer die manuelle Korrektur (editDraft in app.js) und Tests wiederverwendbar — dieselbe Logik,
  // die auch die Spracherkennung nutzt, statt sie ein zweites Mal zu implementieren.
  extractWaterAndSpot, levenshtein,
};
