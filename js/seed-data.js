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

function referenceRecords() {
  const species = [
    { species_id: "mefo", name_de: "Meerforelle", name_latin: "Salmo trutta trutta", has_calibrated_model: true },
    { species_id: "zander", name_de: "Zander", name_latin: "Sander lucioperca", has_calibrated_model: false },
    { species_id: "hecht", name_de: "Hecht", name_latin: "Esox lucius", has_calibrated_model: false },
    { species_id: "barsch", name_de: "Barsch", name_latin: "Perca fluviatilis", has_calibrated_model: false },
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
    });
  }
  spots.push({
    spot_id: "herrenwyk", name: "Herrenwyk", water_id: "trave", zone: null,
    gps_precision: "unknown", fangbuch_n: 0, structure_notes: "Neuer Spot ohne historische Fangbuch-Daten.",
  });
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

window.FISeed = { seedIfEmpty, reconcileReferenceData, referenceRecords };
