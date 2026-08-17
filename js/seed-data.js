// Referenzdaten-Seeding — Port von Sprint-1 seed_data.py. Laeuft beim ersten App-Start
// (IndexedDB leer) einmalig, siehe app.js:ensureSeeded().

async function seedIfEmpty() {
  const existing = await FIDB.getAll("species");
  if (existing.length) return false;

  const species = [
    { species_id: "mefo", name_de: "Meerforelle", name_latin: "Salmo trutta trutta", has_calibrated_model: true },
    { species_id: "zander", name_de: "Zander", name_latin: "Sander lucioperca", has_calibrated_model: false },
    { species_id: "hecht", name_de: "Hecht", name_latin: "Esox lucius", has_calibrated_model: false },
    { species_id: "barsch", name_de: "Barsch", name_latin: "Perca fluviatilis", has_calibrated_model: false },
  ];
  for (const s of species) await FIDB.put("species", s);

  const waters = [
    { water_id: "luebecker_bucht", name_de: "Lübecker Bucht", water_type: "ostsee_kueste", enrichment_profile_id: "luebecker_bucht_v1" },
    { water_id: "trave", name_de: "Trave", water_type: "fluss", enrichment_profile_id: "trave_v1" },
    { water_id: "hemmelsdorfer_see", name_de: "Hemmelsdorfer See", water_type: "see", enrichment_profile_id: "hemmelsdorfer_see_v1" },
    { water_id: "stockssee", name_de: "Stockssee", water_type: "see", enrichment_profile_id: "stockssee_v1" },
  ];
  for (const w of waters) await FIDB.put("water", w);

  for (const [spotKey, st] of Object.entries(FIMefoModel.SPOT_STATS)) {
    await FIDB.put("spot", {
      spot_id: spotKey, name: st.name, water_id: "luebecker_bucht", zone: null,
      gps_precision: "unknown", fangbuch_n: st.n,
      structure_notes: "Aus historischem Fangbuch (Phase 2.5 Shrinkage-Tabelle).",
    });
  }
  await FIDB.put("spot", {
    spot_id: "herrenwyk", name: "Herrenwyk", water_id: "trave", zone: null,
    gps_precision: "unknown", fangbuch_n: 0, structure_notes: "Neuer Spot ohne historische Fangbuch-Daten.",
  });

  return true;
}

window.FISeed = { seedIfEmpty };
