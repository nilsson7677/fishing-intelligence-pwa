// Kontrollierte Vokabulare — 1:1-Port von Sprint-1 extraction/gazetteers.py nach JS, plus
// Sprint-2-Ergänzungen (Abschnitt 41/42: Kalle-Umgangssprache-Testfall, Fall B/E/F).
// Bewusst weiterhin klein/regelbasiert gehalten (Abschnitt 11: "nicht jetzt hunderte Regeln
// bauen") — Erweiterung nur für die tatsächlich vorgegebenen Testfälle, kein Overengineering.

const SPECIES_ALIASES = {
  zander: "zander", zaender: "zander",
  hecht: "hecht", hechte: "hecht",
  barsch: "barsch", baersche: "barsch", barsche: "barsch",
  meerforelle: "mefo", meerforellen: "mefo", mefo: "mefo", mefos: "mefo",
};

// ---------------------------------------------------------------------------
// FISHING DOMAIN VOCABULARY (Voice Reliability Loop Runde 6) — zentrale, erweiterbare Struktur fuer
// Anglersprache, statt ueber den Code verstreuter Sonderfaelle. Zwei getrennte Schichten pro Begriff:
//   1. ALIASES  (z.B. SPECIES_ALIASES oben): gesprochene/geschriebene Variante -> INTERNER SCHLUESSEL
//      ("mefo") — dieser Schluessel bleibt bewusst UNVERAENDERT und wird in DB/Filtern/Modell
//      ueberall verwendet (Abschnitt: STATE.species==="mefo", intelligence_report.species, etc.) —
//      ihn umzubenennen wuerde bestehende Filter/Speicherungen brechen.
//   2. CANONICAL_NAMES (hier neu): interner Schluessel -> huebscher ANZEIGENAME ("Meerforelle") —
//      NUR fuer die Darstellung in der Confirm Card genutzt, nie fuer Speicherung/Filterung.
// "Mefo/Mefos -> Meerforelle" ist der von Runde 6 geforderte erste Eintrag. Die Struktur ist bewusst
// so gebaut, dass weitere reale Anglerbegriffe spaeter einfach ergaenzt werden koennen, OHNE
// Extraktionslogik anfassen zu muessen, z.B. (noch NICHT in dieser Runde implementiert):
//   "Schneider" -> 0 Faenge (bereits als BLANK_TRIP_MARKERS unten vorhanden)
//   "Nachlaeufer" -> Kontakt/Beobachtung ohne Fang (noch offen, braucht eigenen recordType/Feld)
//   "Möre" -> Koederbezeichnung (bereits als LURE_ALIASES unten vorhanden)
// Weitere Begriffe werden iterativ aus der echten Nutzung ergaenzt (siehe Auftrag Runde 6), nicht
// vorab spekulativ ausgebaut.
const SPECIES_CANONICAL_NAMES = {
  zander: "Zander", hecht: "Hecht", barsch: "Barsch", mefo: "Meerforelle",
};

const WATER_ALIASES = {
  trave: "trave",
  "hemmelsdorfer see": "hemmelsdorfer_see", hemmelsdorfer: "hemmelsdorfer_see",
  stockssee: "stockssee",
  "luebecker bucht": "luebecker_bucht", "lübecker bucht": "luebecker_bucht",
  ostsee: "luebecker_bucht",
};

// ---------------------------------------------------------------------------
// FISHING DOMAIN VOCABULARY — Spot-Aliase (Voice Reliability Loop Runde 2, Abschnitt 3/4)
// ---------------------------------------------------------------------------
// Vorher: eine von Hand gepflegte SPOT_ALIASES-Liste, die nur 8 von 14 bekannten Spots aus dem
// Meerforellen-Modell abdeckte ("Bliesdorf" fehlte komplett - kein Einzelfall, sondern ein
// systematischer Rueckstand). Jetzt: SPOT_ALIASES wird aus FIMefoModel.SPOT_STATS abgeleitet -
// EINE zentrale Quelle statt zweier separat gepflegter Listen. Jeder neue/kalibrierte Spot taucht
// automatisch auch im Sprach-Vokabular auf, ohne dass jemand eine zweite Liste nachpflegen muss
// (Abschnitt 4: "wie skalieren wir bei kuenftigen Namen" — Antwort hier: gar nicht mehr manuell).
// Nur Spots OHNE Fangbuch-Kalibrierung (z.B. neue Trave-Spots wie Herrenwyk, n=0) bleiben als
// expliziter Zusatzeintrag noetig.

function toAsciiDe(s) {
  // 'ö' -> 'oe' usw. — deckt automatisch beide gaengigen Schreib-/Sprechweisen ab (Umlaut und
  // dessen Transliteration), ohne dass jede Variante von Hand eingetragen werden muss.
  return s.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
}

function buildSpotAliases() {
  const aliases = {
    // Spots, die (noch) nicht im kalibrierten Meerforellen-Modell stehen (z.B. neue Trave-Spots
    // ohne historische Fangbuch-Basis) - bewusst weiterhin manuell, da hier keine automatische
    // Quelle existiert.
    herrenwyk: ["herrenwyk", "trave"],
  };
  const stats = (window.FIMefoModel && window.FIMefoModel.SPOT_STATS) || {};
  for (const [spotKey, info] of Object.entries(stats)) {
    if (spotKey === "ostsee_allgemein") continue; // Sammel-Bucket, kein echter benannter Spot
    const nameLower = info.name.toLowerCase();
    aliases[nameLower] = [spotKey, "luebecker_bucht"];
    const ascii = toAsciiDe(nameLower);
    if (ascii !== nameLower) aliases[ascii] = [spotKey, "luebecker_bucht"];
  }
  return aliases;
}

// Spot -> [spot_id, water_id].
const SPOT_ALIASES = buildSpotAliases();

// SPOT_CANONICAL_NAMES: spot_id -> HUEBSCHER ANZEIGENAME ("bliesdorf" -> "Bliesdorf"). Vorher wurde
// das aus dem (kleingeschriebenen) Alias-Text abgeleitet, was in der Confirm Card/den Fuzzy-Match-
// Hinweisen faelschlich klein angezeigt wurde ("...ähnelt bekanntem Spot 'bliesdorf'" statt
// 'Bliesdorf'). Jetzt (Runde 6): Quelle ist der bereits korrekt grossgeschriebene `info.name` aus
// FIMefoModel.SPOT_STATS (dieselbe EINE Quelle wie schon SPOT_ALIASES, siehe buildSpotAliases oben)
// — plus die manuellen Spots (z.B. Herrenwyk), die nicht im Modell stehen.
const SPOT_CANONICAL_NAMES = (() => {
  const names = { herrenwyk: "Herrenwyk" };
  const stats = (window.FIMefoModel && window.FIMefoModel.SPOT_STATS) || {};
  for (const [spotKey, info] of Object.entries(stats)) {
    if (spotKey === "ostsee_allgemein") continue;
    names[spotKey] = info.name;
  }
  return names;
})();

// WATER_CANONICAL_NAMES: water_id -> huebscher Anzeigename, analog zu SPOT_CANONICAL_NAMES (fuer
// den Fall, dass nur ein Gewaesser ohne konkreten Spot erkannt wurde).
const WATER_CANONICAL_NAMES = {
  trave: "Trave", hemmelsdorfer_see: "Hemmelsdorfer See", stockssee: "Stockssee",
  luebecker_bucht: "Lübecker Bucht",
};

const LURE_ALIASES = {
  gummifisch: "Gummifisch", gummis: "Gummifisch", gummi: "Gummifisch",
  blinker: "Blinker", wobbler: "Wobbler", spinner: "Spinner", jig: "Jig", spoon: "Spoon",
  "möre": "Möre", "moere": "Möre",
};

const LURE_COLOR_ALIASES = {
  motoroil: "Motoroil", silber: "Silber", gruen: "Grün", "grün": "Grün", rot: "Rot",
  weiss: "Weiß", "weiß": "Weiß", gelb: "Gelb", schwarz: "Schwarz", firetiger: "Firetiger",
  dunkel: "Dunkel", dunkle: "Dunkel", dunklen: "Dunkel", hell: "Hell", helle: "Hell",
};

const GERMAN_NUMBER_WORDS = {
  null: 0, kein: 0, keine: 0, eins: 1, ein: 1, eine: 1, einen: 1,
  zwei: 2, drei: 3, vier: 4, fuenf: 5, "fünf": 5, sechs: 6, sieben: 7,
  acht: 8, neun: 9, zehn: 10,
};

// Angler-Jargon: "Schneider" = keine Fische = Nullrunde beim Fisch; "kein Kontakt" = auch keine
// Fischkontakte (noch "leerer" als Schneider) — beide Marker fuehren zu is_blank_trip.
const BLANK_TRIP_MARKERS = ["schneider"];
const CONTACT_BLANK_MARKERS = ["kein kontakt", "keine kontakte", "kein fischkontakt"];

// Unscharfe Mengenangaben — werden NIE in eine Zahl uebersetzt (Abschnitt 10/41).
const QUALITATIVE_QUANTITY_MARKERS = {
  viele: "viele (nicht quantifiziert)",
  einige: "einige (nicht quantifiziert)",
  mehrere: "mehrere (nicht quantifiziert)",
  "ein paar": "ein paar (nicht quantifiziert)",
};
const UNKNOWN_QUANTITY_MARKERS = ["keine ahnung wie viele", "weiss nicht wie viele", "weiß nicht wie viele"];

const MONTH_NAMES = {
  januar: 1, februar: 2, maerz: 3, "märz": 3, april: 4, mai: 5, juni: 6,
  juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
};

const DAYPART_MARKERS = {
  morgens: "morning", "morgen frueh": "morning", vormittag: "morning",
  mittags: "midday", nachmittags: "afternoon",
  abend: "evening", abends: "evening",
  nachts: "night", nacht: "night",
  daemmerung: "dusk", "dämmerung": "dusk",
  "kurz vor dunkel": "dusk", "vor dunkel": "dusk", "bei dunkelheit": "night",
};

// Beobachtungs-Marker (Sprint 2, Abschnitt 22/42, Fall F) — qualitative Wasser-/Gewaesserbeobachtung
// ohne Fangbezug. Fuehrt zur Klassifikation als "observation" statt "catch".
const OBSERVATION_MARKERS = [
  "wasser klar", "wasser total klar", "wasser truebe", "wasser trübe", "getruebt", "getrübt",
  "kleinfisch", "kraut", "algen", "blaualgen", "trübung", "truebung", "sichtweite",
];

// Hoerensagen-/Fremdbericht-Marker (Abschnitt 41/42): Hoerensagen (gehedged) vs. Direktbericht
// (nicht gehedged, aber trotzdem ueber eine dritte Person) sind bewusst unterschieden — siehe
// extractor.js classify().
const HEARSAY_MARKERS = ["meinte", "haette", "hätte", "soll", "sollen", "erzaehlte", "erzählte"];
// "hat" ergaenzt (Voice Reliability Loop Runde 2, Testfall A: "Kai-Uwe HAT gestern ... gefangen"
// ist im Alltag mindestens so gebraeuchlich wie "hatte") — siehe extractor.js
// detectSourceAttribution() fuer die Absicherung gegen Fehltreffer durch deutsche
// Grossschreibung (jedes Nomen ist grossgeschrieben, nicht nur Namen).
const DIRECT_REPORT_VERBS = ["hatte", "hat", "fing", "fangte"];

// ---------------------------------------------------------------------------
// USER VOCABULARY (Abschnitt 8/9) — persoenliche Korrekturen/Aliase, die der Nutzer bestaetigt
// oder eingegeben hat (z.B. "Blies Dorf" -> Spot 'bliesdorf'), werden hier zur Laufzeit UEBER die
// Basis-Vokabulare gelegt. Persistiert wird in IndexedDB (Store "user_vocabulary", siehe db.js) -
// diese Funktion mutiert nur die bereits im Speicher stehenden Alias-Tabellen, damit
// findMultiword() sie ab sofort ohne weitere Aenderung mitfindet (gleiche Objekt-Referenz).
// Bewusst noch KEINE automatische Lernlogik (kein Scoring/Bestaetigungszaehler) - nur "Nutzer hat
// explizit bestaetigt/korrigiert -> ab jetzt bekannt". Das ist laut Auftrag als MVP ausreichend.
function mergeUserVocabulary(entries) {
  for (const e of entries || []) {
    if (!e || !e.category || !e.alias_text) continue;
    const key = e.alias_text.toLowerCase().trim();
    if (!key) continue;
    if (e.category === "spot" && e.resolved_spot_id) {
      SPOT_ALIASES[key] = [e.resolved_spot_id, e.resolved_water_id || "luebecker_bucht"];
    } else if (e.category === "water" && e.resolved_water_id) {
      WATER_ALIASES[key] = e.resolved_water_id;
    } else if (e.category === "species" && e.resolved_value) {
      SPECIES_ALIASES[key] = e.resolved_value;
    } else if (e.category === "lure" && e.resolved_value) {
      LURE_ALIASES[key] = e.resolved_value;
    } else if (e.category === "lure_color" && e.resolved_value) {
      LURE_COLOR_ALIASES[key] = e.resolved_value;
    }
  }
}

window.GAZ = {
  SPECIES_ALIASES, SPECIES_CANONICAL_NAMES, WATER_ALIASES, WATER_CANONICAL_NAMES,
  SPOT_ALIASES, SPOT_CANONICAL_NAMES, LURE_ALIASES, LURE_COLOR_ALIASES,
  GERMAN_NUMBER_WORDS, BLANK_TRIP_MARKERS, CONTACT_BLANK_MARKERS,
  QUALITATIVE_QUANTITY_MARKERS, UNKNOWN_QUANTITY_MARKERS, MONTH_NAMES, DAYPART_MARKERS,
  OBSERVATION_MARKERS, HEARSAY_MARKERS, DIRECT_REPORT_VERBS, toAsciiDe, mergeUserVocabulary,
};
