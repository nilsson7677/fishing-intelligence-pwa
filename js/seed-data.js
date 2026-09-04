// Referenzdaten-Seeding — Port von Sprint-1 seed_data.py. seedIfEmpty() laeuft beim allerersten
// App-Start (IndexedDB komplett leer) einmalig, siehe app.js:init().
//
// MULTI-WATER UX FOLGEFIX Runde 4 (Android-Realtest 22.08.2026): seedIfEmpty() allein greift nur,
// wenn der "species"-Store komplett leer ist — auf einem Geraet, das die App schon VOR einer
// spaeteren Erweiterung der Referenzdaten (z.B. weitere Kuestenspots in FIMefoModel.SPOT_STATS)
// installiert hatte, wuerde der einmal geseedete, aeltere Datenstand fuer immer bestehen bleiben,
// da IndexedDB-Objectstores bei einem Versions-Upgrade (siehe db.js) NIE geleert/neu befuellt
// werden, nur neue Stores angelegt. Um genau diese denkbare Ursache fuer "Spot-Liste auf dem
// Geraet unerwartet leer/anders als erwartet" auszuschliessen (bzw. zu heilen, falls doch so),
// ergaenzt reconcileReferenceData() eine IDEMPOTENTE, additive Abgleich-Funktion: sie schreibt bei
// JEDEM App-Start alle kanonischen species/water/spot-Eintraege aus genau denselben, bereits
// vorhandenen Listen (keine neuen Spots erfunden) per put() (Upsert) erneut — bestehende, identische
// Eintraege werden dabei nur ueberschrieben (kein Datenverlust, reine Referenztabellen ohne
// Nutzer-Bearbeitung), fehlende Eintraege werden ergaenzt. fishing_session/catch_event/etc.
// (echte Nutzerdaten) werden hier NICHT beruehrt.

// v28 29-SPOT PRODUCT COVERAGE (Auftrag Teil B, Abschnitt 11-16, 04.09.2026): stabile ID-Strategie
// fuer die autoritative 29-Spot-Liste (spot-intelligence-data.js, HI-2C.1) gegenueber den
// bestehenden, seit Sprint 1 unveraenderten spot_id-Werten aus FIMefoModel.SPOT_STATS (Abschnitt 13:
// "keine fragile Laufzeit-Normalisierung, keine stillen Merges, bestehende IDs duerfen nicht
// brechen"). WICHTIGER, per Scan bestaetigter Befund: die 29-Spot-Liste enthaelt drei IDs
// (bliesdorf/groemitz/dahmeshoeved), die als reine Strings IDENTISCH mit bereits bestehenden
// SPOT_STATS-spot_id-Werten sind — ein direktes put() unter dem bloßen Schluessel wuerde den
// bestehenden, historisch referenzierten Spot in der productiven "spot"-Tabelle STILL UEBERSCHREIBEN
// (genau der in Abschnitt 13 verbotene "stille Merge"). Deshalb bekommt JEDER der 29 Master-Spots
// hier einen eigenen, garantiert kollisionsfreien Namespace-Praefix ("m29-" + der Original-Schluessel
// aus spot-intelligence-data.js) statt eines fallweisen Misch-Schemas — einheitlich, trivial testbar
// (Praefix abschneiden = Original-ID), und beliebig erweiterbar ohne kuenftige Kollisionsrisiken.
// Alle 14 SPOT_STATS-IDs + "herrenwyk" bleiben zu 100% unveraendert (keine bestehende historische
// Referenz aus fishing_session/catch_event/... bricht). Der neue "spot_layer"/"access_modes"/
// "source_spot_intelligence_id"-Feldsatz ist REIN ADDITIV auf dem bereits bestehenden spot-Schema.
const SPOT_LAYER_LEGACY_STATS = "legacy_spot_stats";
const SPOT_LAYER_LEGACY_TRAVE = "legacy_trave";
const SPOT_LAYER_MASTER29 = "hi2c1_master29";
const MASTER29_SPOT_ID_PREFIX = "m29-";

function master29Spots() {
  const data = window.FISpotIntelligenceData;
  if (!data || !data.SPOT_INTELLIGENCE_SPOTS) return []; // defensiv: Datei nicht geladen -> additive Erweiterung faellt einfach weg, kein Fehler
  return Object.entries(data.SPOT_INTELLIGENCE_SPOTS).map(([key, s]) => ({
    spot_id: MASTER29_SPOT_ID_PREFIX + key,
    name: s.name, water_id: "luebecker_bucht", zone: null, gps_precision: "unknown",
    // v28 Abschnitt 15 (geklaerte Produktentscheidung): KEIN geerbter SPOT_STATS-Wert, auch nicht
    // fuer Unterspots eines bereits bekannten Bereichs (z.B. Sierksdorf 1./2. Riff) — fangbuch_n
    // bleibt bewusst null (nicht 0 — "0" waere eine erfundene Aussage "0 Faenge", "null" heisst
    // ehrlich "keine eigene historische Datenbasis fuer DIESEN Punkt").
    fangbuch_n: null,
    structure_notes: "Autoritative 29-Spot-Liste (HI-2C.1) — keine eigenen historischen Fangbuch-Daten (Auftrag v28 Abschnitt 15).",
    access_modes: Array.isArray(s.accessModes) ? s.accessModes.slice() : null,
    spot_layer: SPOT_LAYER_MASTER29,
    source_spot_intelligence_id: key,
  }));
}

function referenceRecords() {
  // PHASE 6 TEIL A (Konsolidierungsfix, Master Audit Abschnitt B/O #5): name_de_plural ergaenzt,
  // damit das Trip-Ende ("Wie viele X gefangen?") die tatsaechliche Zielart statt eines hartkodierten
  // "Meerforellen" anzeigt. REIN ADDITIV (neues Feld auf bereits vorhandenen Arten-Eintraegen) —
  // keine neue Art erfunden, keine bestehende Art veraendert/entfernt.
  const species = [
    { species_id: "mefo", name_de: "Meerforelle", name_de_plural: "Meerforellen", name_latin: "Salmo trutta trutta", has_calibrated_model: true },
    { species_id: "zander", name_de: "Zander", name_de_plural: "Zander", name_latin: "Sander lucioperca", has_calibrated_model: false },
    { species_id: "hecht", name_de: "Hecht", name_de_plural: "Hechte", name_latin: "Esox lucius", has_calibrated_model: false },
    { species_id: "barsch", name_de: "Barsch", name_de_plural: "Barsche", name_latin: "Perca fluviatilis", has_calibrated_model: false },
  ];
  const waters = [
    { water_id: "luebecker_bucht", name_de: "Lübecker Bucht", water_type: "ostsee_kueste", enrichment_profile_id: "luebecker_bucht_v1" },
    { water_id: "trave", name_de: "Trave", water_type: "fluss", enrichment_profile_id: "trave_v1" },
    { water_id: "hemmelsdorfer_see", name_de: "Hemmelsdorfer See", water_type: "see", enrichment_profile_id: "hemmelsdorfer_see_v1" },
    { water_id: "stockssee", name_de: "Stockssee", water_type: "see", enrichment_profile_id: "stockssee_v1" },
  ];
  const spots = [];
  for (const [spotKey, st] of Object.entries(FIMefoModel.SPOT_STATS)) {
    spots.push({
      spot_id: spotKey, name: st.name, water_id: "luebecker_bucht", zone: null,
      gps_precision: "unknown", fangbuch_n: st.n,
      structure_notes: "Aus historischem Fangbuch (Phase 2.5 Shrinkage-Tabelle).",
      spot_layer: SPOT_LAYER_LEGACY_STATS, access_modes: null, // access_modes fuer Legacy-Spots unbekannt — nicht erfunden (Auftrag Abschnitt 16)
    });
  }
  spots.push({
    spot_id: "herrenwyk", name: "Herrenwyk", water_id: "trave", zone: null,
    gps_precision: "unknown", fangbuch_n: 0, structure_notes: "Neuer Spot ohne historische Fangbuch-Daten.",
    spot_layer: SPOT_LAYER_LEGACY_TRAVE, access_modes: null,
  });
  // v28 29-SPOT PRODUCT COVERAGE (Auftrag Teil B, Abschnitt 12): alle 29 autoritativen HI-2C.1-Spots
  // additiv ergaenzen (siehe master29Spots() oben) — rein additiv, keine der obigen 15 Legacy-Eintraege
  // wird ersetzt/veraendert (garantiert kollisionsfrei durch den "m29-"-Praefix).
  spots.push(...master29Spots());
  return { species, waters, spots };
}

async function seedIfEmpty() {
  const existing = await FIDB.getAll("species");
  if (existing.length) return false;
  const { species, waters, spots } = referenceRecords();
  for (const s of species) await FIDB.put("species", s);
  for (const w of waters) await FIDB.put("water", w);
  for (const sp of spots) await FIDB.put("spot", sp);
  return true;
}

// Laeuft bei JEDEM App-Start (nicht nur bei komplett leerer DB) und gleicht species/water/spot
// gegen den aktuellen Code-Stand ab. Reiner Upsert bereits vorhandener Referenzdaten — erfindet
// nichts Neues, nutzt exakt dieselben Listen wie seedIfEmpty(). Gibt zurueck, wie viele Eintraege
// je Store VORHER gefehlt haben (zur Diagnose/optionalen Nutzerinfo), damit ein stiller Drift
// zwischen einem alten, einmal geseedeten Geraetestand und dem aktuellen Code-Stand nicht mehr
// unbemerkt bestehen bleibt.
async function reconcileReferenceData() {
  const { species, waters, spots } = referenceRecords();
  const [existingSpecies, existingWaters, existingSpots] = await Promise.all([
    FIDB.getAll("species"), FIDB.getAll("water"), FIDB.getAll("spot"),
  ]);
  const existingSpeciesIds = new Set(existingSpecies.map((s) => s.species_id));
  const existingWaterIds = new Set(existingWaters.map((w) => w.water_id));
  const existingSpotIds = new Set(existingSpots.map((sp) => sp.spot_id));

  let addedSpecies = 0, addedWaters = 0, addedSpots = 0;
  for (const s of species) { if (!existingSpeciesIds.has(s.species_id)) addedSpecies++; await FIDB.put("species", s); }
  for (const w of waters) { if (!existingWaterIds.has(w.water_id)) addedWaters++; await FIDB.put("water", w); }
  for (const sp of spots) { if (!existingSpotIds.has(sp.spot_id)) addedSpots++; await FIDB.put("spot", sp); }

  return { addedSpecies, addedWaters, addedSpots, total: addedSpecies + addedWaters + addedSpots };
}

window.FISeed = {
  seedIfEmpty, reconcileReferenceData, referenceRecords,
  // v28 (Auftrag Teil B, Abschnitt 13 "explizit und testbar"): ID-Strategie-Bausteine oeffentlich,
  // damit ein Test die Kollisionsfreiheit/Praefix-Konvention direkt pruefen kann statt sie zu erraten.
  master29Spots, MASTER29_SPOT_ID_PREFIX,
  SPOT_LAYER_LEGACY_STATS, SPOT_LAYER_LEGACY_TRAVE, SPOT_LAYER_MASTER29,
};
