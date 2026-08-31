// IndexedDB-Schicht — clientseitiger Port von Sprint-1 db.py/schema.sql.
// Vier Kern-Entitaeten bleiben getrennt (Abschnitt 4, unveraendert aus Sprint 1):
// fishing_session, catch_event, intelligence_report, environmental_snapshot.
// Neu in Sprint 2: enrichment_queue als eigener Store fuer den Retry-Mechanismus,
// intelligence_report traegt zusaetzlich einen inbox_status fuer die Intelligence Inbox (Prio 3).

const DB_NAME = "fishintel_db";
// v2 (Voice Reliability Loop Runde 2, Abschnitt 8): neuer Store "user_vocabulary" fuer
// persoenliche Sprach-/Ortsnamen-Korrekturen des Nutzers.
// v3 (Phase 5 — Regime-STATE Shadow Pilot, GO-Freigabe 19.08.2026): neuer Store
// "shadow_evaluation" fuer den rein im Hintergrund laufenden Vergleich Champion vs.
// CHALLENGER_STATE_V1 (siehe pwa/js/shadow.js). REIN ADDITIV: kein bestehender Store, Index
// oder Feld wird veraendert oder entfernt. Der Champion (meerforelle-model.js) bleibt die
// einzige Logik, die in der UI sichtbar ist — shadow_evaluation wird in keiner View gelesen.
// v4 (Phase 6A — Data Safety Quick Fix, 22.08.2026): zwei neue Stores, REIN ADDITIV, kein
// bestehender Store/Index/Feld veraendert:
//   "active_trip_state" — haelt den minimalen Zustand eines LAUFENDEN Trips (Singleton,
//     state_id immer "current"), damit ein App-Reload waehrend eines Trips nicht stillschweigend
//     den Trip-Kontext verliert. Bewusst GETRENNT von fishing_session, damit ein noch nicht
//     abgeschlossener Trip nie in Inbox/Statistik/Champion-Eingaben auftaucht.
//   "trip_track" — die vollstaendige GPS-Route eines Trips (ein Dokument pro session_id), vorher
//     nur im fluechtigen STATE-Objekt gehalten und bei jedem Reload verloren (Phase-6-Audit-Fund).
// v5 (Phase 6B — Automatic Cloud Backup, 26.08.2026): EIN neuer Store, REIN ADDITIV, kein
// bestehender Store/Index/Feld veraendert:
//   "sync_queue" — rein lokale, ephemere Warteschlange fuer das Cloud-Backup (Supabase). Ein
//     Eintrag pro noch nicht erfolgreich hochgeladenem Datensatz (queue_key = "<store>:<id>",
//     deterministisch -> mehrfaches Aendern desselben Datensatzes erzeugt nie mehrere Eintraege).
//     Analog zum bewaehrten "enrichment_queue"-Retry-Muster aus Sprint 2, siehe js/sync.js. Wird in
//     KEINER View direkt gerendert und beeinflusst keine bestehende Store/Logik.
// v6 (Phase HI-1 — Sea Trout Hourly Intelligence Data Foundation, 30.08.2026): EIN neuer Store,
// REIN ADDITIV, kein bestehender Store/Index/Feld veraendert:
//   "hourly_shadow_snapshot" — eingefrorene HourlyEnvironment+HourlyFeatures-Momentaufnahmen der
//     experimentellen, produktiv NICHT sichtbaren Hourly-Intelligence-Schattenschicht (siehe
//     js/hourly-intelligence.js, docs/HOURLY_INTELLIGENCE_SHADOW.md). Absichtlich UNVERAENDERLICH:
//     jeder neue Forecast-Lauf legt einen NEUEN Eintrag an (eigene id, nie ueberschrieben), damit
//     spaeter rekonstruierbar bleibt, was die App zum jeweiligen Prognosezeitpunkt tatsaechlich
//     wusste (Auftrag Abschnitt 14). Beeinflusst NICHT Champion-Score/-Tier und wird in KEINER
//     produktiven View gerendert (HOURLY_INTELLIGENCE_MODE = "SHADOW").
const DB_VERSION = 6;

const STORES = {
  species: "species_id",
  water: "water_id",
  spot: "spot_id",
  fishing_session: "session_id",
  catch_event: "catch_id",
  intelligence_report: "report_id",
  observation: "observation_id",
  environmental_snapshot: "snapshot_id",
  enrichment_queue: "queue_id",
  user_vocabulary: "vocab_id",
  shadow_evaluation: "shadow_id",
  active_trip_state: "state_id",
  trip_track: "session_id",
  sync_queue: "queue_key",
  hourly_shadow_snapshot: "id",
};

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      for (const [name, keyPath] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath });
          if (name === "fishing_session" || name === "catch_event") {
            store.createIndex("by_date", "date", { unique: false });
            store.createIndex("by_water", "water_id", { unique: false });
          }
          if (name === "intelligence_report") {
            store.createIndex("by_inbox_status", "inbox_status", { unique: false });
            store.createIndex("by_created", "created_at", { unique: false });
          }
          if (name === "enrichment_queue") {
            store.createIndex("by_status", "status", { unique: false });
          }
          if (name === "environmental_snapshot") {
            store.createIndex("by_linked", "linked_entity_id", { unique: false });
          }
          if (name === "user_vocabulary") {
            store.createIndex("by_category", "category", { unique: false });
          }
          if (name === "shadow_evaluation") {
            store.createIndex("by_linked", "linked_entity_id", { unique: false });
            store.createIndex("by_model_version", "model_version", { unique: false });
            store.createIndex("by_created", "timestamp_created", { unique: false });
          }
          if (name === "sync_queue") {
            store.createIndex("by_store", "store", { unique: false });
          }
          if (name === "hourly_shadow_snapshot") {
            store.createIndex("by_location", "locationId", { unique: false });
            store.createIndex("by_target_timestamp", "targetTimestamp", { unique: false });
            store.createIndex("by_generated_at", "generatedAt", { unique: false });
          }
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

async function put(storeName, obj) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(obj);
    tx.oncomplete = () => resolve(obj);
    tx.onerror = () => reject(tx.error);
  });
}

async function get(storeName, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function getAll(storeName, indexName = null, query = null) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const source = indexName ? tx.objectStore(storeName).index(indexName) : tx.objectStore(storeName);
    const req = query !== null ? source.getAll(query) : source.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function del(storeName, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function clearAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(Object.keys(STORES), "readwrite");
    for (const name of Object.keys(STORES)) tx.objectStore(name).clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

function newId(prefix) {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${rand}`;
}

function nowIso() {
  return new Date().toISOString();
}

window.FIDB = { openDb, put, get, getAll, del, clearAll, newId, nowIso, STORES, DB_VERSION };
