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

const WATER_ALIASES = {
  trave: "trave",
  "hemmelsdorfer see": "hemmelsdorfer_see", hemmelsdorfer: "hemmelsdorfer_see",
  stockssee: "stockssee",
  "luebecker bucht": "luebecker_bucht", "lübecker bucht": "luebecker_bucht",
  ostsee: "luebecker_bucht",
};

// Spot -> [spot_id, water_id]
const SPOT_ALIASES = {
  herrenwyk: ["herrenwyk", "trave"],
  sierksdorf: ["sierksdorf", "luebecker_bucht"],
  pelzerhaken: ["pelzerhaken", "luebecker_bucht"],
  groemitz: ["groemitz", "luebecker_bucht"], "grömitz": ["groemitz", "luebecker_bucht"],
  suessau: ["suessau", "luebecker_bucht"], "süssau": ["suessau", "luebecker_bucht"],
  weissenhaus: ["weissenhaus", "luebecker_bucht"], "weißenhaus": ["weissenhaus", "luebecker_bucht"],
  brodten: ["brodten", "luebecker_bucht"],
  "brodtner ufer": ["brodtner_ufer", "luebecker_bucht"],
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
const DIRECT_REPORT_VERBS = ["hatte", "fing", "fangte"];

window.GAZ = {
  SPECIES_ALIASES, WATER_ALIASES, SPOT_ALIASES, LURE_ALIASES, LURE_COLOR_ALIASES,
  GERMAN_NUMBER_WORDS, BLANK_TRIP_MARKERS, CONTACT_BLANK_MARKERS,
  QUALITATIVE_QUANTITY_MARKERS, UNKNOWN_QUANTITY_MARKERS, MONTH_NAMES, DAYPART_MARKERS,
  OBSERVATION_MARKERS, HEARSAY_MARKERS, DIRECT_REPORT_VERBS,
};
