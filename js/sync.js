// Cloud-Backup-Sync — PHASE 6B (Automatic Cloud Backup, 26.08.2026).
// Siehe PHASE6B_CLOUD_BACKUP_VORBEREITUNG.md fuer die vollstaendige Architektur.
//
// KERNPRINZIP "LOCAL FIRST" (Auftrag Abschnitt 1, verbindlich): dieses Modul wird ausschliesslich
// NACH einem bereits erfolgreichen lokalen FIDB.put(...) aufgerufen (siehe app.js/shadow.js/
// enrichment.js). JEDER Fehler hier — fehlendes SDK, fehlendes Login, kein Netz, Supabase down,
// RLS-Ablehnung — bleibt LOKAL VOLLSTAENDIG FOLGENLOS: der aufrufende Code (Trip/Fang/Nullrunde/
// Voice/GPS/Shadow) hat seine Arbeit zu diesem Zeitpunkt bereits erledigt und wartet nie auf dieses
// Modul. Kein Fehler hier darf jemals als Fehler beim Nutzer ankommen, ausser explizit im Cloud-
// Status-Bereich (Insights), niemals als blockierender Toast auf einer Erfassungs-Aktion.
//
// SDK-Ladung bewusst NICHT ueber ein blockierendes <script>-Tag in index.html, sondern dynamisch
// (siehe loadSupabaseSdk() unten) — ein nicht erreichbares CDN darf niemals den App-Start verzoegern
// oder verhindern (Local First gilt auch fuer den Ladevorgang selbst, nicht nur fuer spaetere
// Aufrufe). Der Service Worker cacht dieses Skript (sync.js) als Teil der lokalen App-Shell wie
// jedes andere js/*.js — die tatsaechliche Supabase-SDK-Datei kommt bewusst vom CDN und wird NICHT
// gecacht, weil sie ohnehin nur mit Netz sinnvoll ist (siehe sw.js-Kommentar).

const SUPABASE_URL = "https://vqqqemrodbjsypvxxhry.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_xeRdY-Cd2gtDn9mluNHkgA_F_GXNAd"; // publishable/anon Key -- durch RLS abgesichert, bewusst oeffentlich im Client, siehe Begleitdokument Abschnitt 5. NIEMALS den service_role Key hier eintragen.
const SUPABASE_SDK_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js";

// Store->Tabellenname ist 1:1 identisch (siehe supabase_setup.sql). Nur diese 8 Stores werden
// cloud-gesichert (Auftrag Abschnitt 6/7) — active_trip_state/species/water/spot/enrichment_queue
// bewusst NICHT (siehe Begleitdokument Abschnitt 3a: ephemer bzw. reproduzierbar).
const CLOUD_STORES = [
  "fishing_session", "catch_event", "intelligence_report", "observation",
  "environmental_snapshot", "user_vocabulary", "shadow_evaluation", "trip_track",
];

// environmental_snapshot: die ~40 verschachtelten Provider-Wert-Felder werden serverseitig in
// EINER jsonb-Spalte "payload" gebuendelt (siehe supabase_setup.sql-Kommentar) — alles, was NICHT
// in dieser Liste steht, wandert automatisch in payload.
const ENV_SNAPSHOT_RELATIONAL_FIELDS = [
  "snapshot_id", "linked_entity_type", "linked_entity_id", "water_id",
  "target_date", "target_day_part", "target_time_precision", "aggregation_method",
  "status", "data_quality", "created_at", "updated_at",
];

let _client = null;
let _sdkLoadPromise = null;

// TIMEOUT bewusst vorhanden (nicht nur onerror): ein blockiertes/haengendes CDN (Firewall, die die
// Verbindung offen laesst statt sie sauber abzulehnen) darf NIE dazu fuehren, dass ein Nutzer laenger
// als ein paar Sekunden auf eine Cloud-Aktion wartet — Local First gilt auch fuer die Ladezeit
// selbst, nicht nur fuer das Ergebnis.
const SDK_LOAD_TIMEOUT_MS = 6000;

function _loadScriptOnce(src) {
  const attempt = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-fi-dynamic="${src}"]`);
    if (existing) { existing.addEventListener("load", () => resolve(true)); existing.addEventListener("error", () => reject(new Error("SDK-Skript konnte nicht geladen werden."))); return; }
    const s = document.createElement("script");
    s.src = src; s.async = true; s.dataset.fiDynamic = src;
    s.onload = () => resolve(true);
    s.onerror = () => reject(new Error("SDK-Skript konnte nicht geladen werden (Netz/CDN nicht erreichbar)."));
    document.head.appendChild(s);
  });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("SDK-Ladezeit überschritten (Netz zu langsam/blockiert).")), SDK_LOAD_TIMEOUT_MS));
  return Promise.race([attempt, timeout]);
}

// Wird NIE awaited von einem aufrufenden Erfassungs-Flow — nur intern von getClient()/init genutzt.
// Bei Fehlschlag bleibt _client dauerhaft null fuer diese Seitenladung; ein spaeterer online-Event
// stoesst einen neuen Versuch an (siehe unten "online"-Listener-Hilfsfunktion attemptLoadOnOnline()).
function loadSupabaseSdk() {
  if (window.supabase && window.supabase.createClient) return Promise.resolve(true);
  if (_sdkLoadPromise) return _sdkLoadPromise;
  _sdkLoadPromise = _loadScriptOnce(SUPABASE_SDK_URL).catch((e) => { _sdkLoadPromise = null; throw e; });
  return _sdkLoadPromise;
}

function getClient() {
  if (_client) return _client;
  if (typeof window === "undefined" || !window.supabase || !window.supabase.createClient) return null;
  try {
    _client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  } catch (e) { _client = null; }
  return _client;
}

// Erlaubt Tests, einen Fake-Client zu injizieren, ohne echtes Netz/echtes SDK zu brauchen — das ist
// die Grundlage dafuer, Queue/Retry/Idempotenz/Local-First deterministisch zu testen (siehe
// test/phase6b_cloud_backup_test.js). _reset() gibt Tests zusaetzlich einen sauberen Ausgangspunkt.
function _setClientForTesting(client) { _client = client; }
function _reset() { _client = null; _sdkLoadPromise = null; }

async function getSession() {
  const client = getClient();
  if (!client) return null;
  try {
    const { data, error } = await client.auth.getSession();
    if (error) return null;
    return (data && data.session) || null;
  } catch (e) { return null; }
}

async function isLoggedIn() { return (await getSession()) !== null; }

async function signInWithMagicLink(email) {
  if (!getClient()) await loadSupabaseSdk().catch(() => {}); // SDK-Ladeversuch ueberspringen, wenn schon ein Client vorhanden ist (z.B. injizierter Test-Client)
  const client = getClient();
  if (!client) return { ok: false, error: "Cloud-Sicherung ist gerade nicht verfügbar (SDK nicht geladen, evtl. kein Netz). Alle lokalen Funktionen funktionieren trotzdem uneingeschränkt weiter." };
  try {
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin + window.location.pathname },
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
}

async function signOut() {
  const client = getClient();
  if (!client) return;
  try { await client.auth.signOut(); } catch (e) { /* lokal folgenlos */ }
}

function onAuthStateChange(cb) {
  const client = getClient();
  if (!client || !client.auth || !client.auth.onAuthStateChange) return () => {};
  const { data } = client.auth.onAuthStateChange(() => cb());
  return () => { try { data.subscription.unsubscribe(); } catch (e) {} };
}

// ---------------------------------------------------------------------------
// SYNC QUEUE — rein lokaler IndexedDB-Store "sync_queue" (db.js, DB_VERSION 4->5, additiv).
// queue_key = `${store}:${recordId}` (deterministisch) -> ein Datensatz, der mehrfach veraendert
// wird (z.B. fishing_session: Start -> Enrichment-Patch -> Trip-Ende), erzeugt durch upsert nur
// EINEN pending-Eintrag, kein linear wachsendes Duplikat-Problem (anders als bei enrichment_queue,
// das eine Suche braucht — hier reicht die deterministische ID).
// ---------------------------------------------------------------------------
async function enqueue(store, recordId) {
  if (!CLOUD_STORES.includes(store) || !recordId) return; // stiller No-Op bei falscher Nutzung
  try {
    await FIDB.put("sync_queue", {
      queue_key: `${store}:${recordId}`,
      store, record_id: recordId,
      enqueued_at: FIDB.nowIso(),
      attempts: 0, last_error: null, last_attempt_at: null,
      // op fehlt bewusst (=> impliziter Default "upsert", siehe flushQueue()). Ein enqueue() nach
      // einem vorherigen Tombstone-Eintrag (siehe enqueueTombstone() unten) fuer denselben queue_key
      // ueberschreibt diesen Eintrag hier bewusst wieder zu einem normalen Upload zurueck — genau
      // richtig, falls ein Datensatz mit derselben ID erneut angelegt/veraendert wird.
    });
  } catch (e) {
    // Darf NIEMALS die aufrufende Erfassungs-Aktion beeintraechtigen (LOCAL FIRST).
    console.warn("Cloud-Sync-Queue: Eintrag konnte nicht angelegt werden (lokal folgenlos):", e);
  }
}

// v29 (Auftrag Abschnitt 10 — CLOUD DELETE POLICY / Tombstones): wird von der lokalen
// Testdaten-Bereinigung (app.js deleteFishingSessionCascade) VOR dem eigentlichen lokalen Loeschen
// aufgerufen, fuer jeden betroffenen CLOUD_STORES-Datensatz. Ersetzt einen evtl. vorhandenen
// normalen Queue-Eintrag fuer dieselbe ID durch einen Tombstone-Eintrag (op:"delete") — beim
// naechsten flushQueue()-Lauf wird dadurch NICHT der (dann bereits lokal geloeschte) Inhalt
// hochgeladen, sondern stattdessen ein minimaler deleted_at-Marker auf die Cloud-Zeile geschrieben
// (siehe flushQueue() unten). Physisches Loeschen der Cloud-Zeile passiert bewusst NICHT (Auftrag
// Abschnitt 10: "Do NOT implement destructive cloud deletion casually" + die Cloud-Tabellen haben
// ohnehin keine DELETE-RLS-Policy, siehe supabase_setup.sql/supabase_migration_v29.sql).
async function enqueueTombstone(store, recordId) {
  if (!CLOUD_STORES.includes(store) || !recordId) return;
  try {
    await FIDB.put("sync_queue", {
      queue_key: `${store}:${recordId}`,
      store, record_id: recordId,
      op: "delete",
      enqueued_at: FIDB.nowIso(),
      attempts: 0, last_error: null, last_attempt_at: null,
    });
  } catch (e) {
    console.warn("Cloud-Sync-Queue: Tombstone-Eintrag konnte nicht angelegt werden (lokal folgenlos):", e);
  }
}

// Komfortfunktion fuer eine ganze Loesch-Kaskade (mehrere Stores/IDs auf einmal, siehe
// deleteFishingSessionCascade() in app.js). Ignoriert Eintraege, deren Store nicht cloud-gesichert
// ist (z.B. enrichment_queue) — analog zum bestehenden Filter auf FISync.CLOUD_STORES dort.
async function enqueueTombstones(deletions) {
  for (const d of deletions || []) {
    if (CLOUD_STORES.includes(d.store)) await enqueueTombstone(d.store, d.key);
  }
}

function _deviceId() {
  try {
    let id = localStorage.getItem("fi_device_id");
    if (!id) {
      id = "dev_" + Array.from(crypto.getRandomValues(new Uint8Array(6))).map((b) => b.toString(16).padStart(2, "0")).join("");
      localStorage.setItem("fi_device_id", id);
    }
    return id;
  } catch (e) { return null; }
}

function buildCloudPayload(store, record, userId) {
  const meta = { user_id: userId, device_id: _deviceId(), synced_at: FIDB.nowIso() };
  if (store === "environmental_snapshot") {
    const relational = {}; const payload = {};
    for (const [k, v] of Object.entries(record)) {
      if (ENV_SNAPSHOT_RELATIONAL_FIELDS.includes(k)) relational[k] = v; else payload[k] = v;
    }
    return { ...relational, payload, ...meta };
  }
  return { ...record, ...meta };
}

function _primaryKeyOf(store) { return FIDB.STORES[store]; } // gleiche keyPath-Namen wie in Postgres (siehe supabase_setup.sql)

let _flushing = false; // verhindert ueberlappende parallele Laeufe (z.B. online-Event + App-Start gleichzeitig)

// Retry-Auslöser (Auftrag Abschnitt 12, "kein aggressives Polling"): App-Start, online-Event, nach
// neuen relevanten Datensaetzen (enqueue() legt nur an, flushQueue() muss separat aufgerufen
// werden), optional manueller Button in Insights. KEIN Intervall-Timer.
async function flushQueue() {
  if (_flushing) return { attempted: 0, done: 0, stillPending: 0, reason: "already_running" };
  if (typeof navigator !== "undefined" && navigator.onLine === false) return { attempted: 0, done: 0, stillPending: 0, reason: "offline" };
  if (!getClient()) await loadSupabaseSdk().catch(() => {}); // SDK-Ladeversuch ueberspringen, wenn schon ein Client vorhanden ist (z.B. injizierter Test-Client)
  const client = getClient();
  if (!client) return { attempted: 0, done: 0, stillPending: 0, reason: "sdk_unavailable" };
  const session = await getSession();
  if (!session) return { attempted: 0, done: 0, stillPending: 0, reason: "not_authenticated" };

  _flushing = true;
  try {
    const pending = await FIDB.getAll("sync_queue");
    let done = 0, stillPending = 0;
    for (const q of pending) {
      try {
        let payload;
        if (q.op === "delete") {
          // v29 Tombstone-Eintrag (siehe enqueueTombstone() oben): der lokale Datensatz ist bereits
          // geloescht, es gibt nichts mehr zu lesen — stattdessen ein minimaler deleted_at-Marker.
          // upsert() statt update(), weil der Datensatz u.U. NIE zuvor erfolgreich synchronisiert
          // wurde (z.B. sofort nach dem Anlegen wieder geloescht) — dann legt dies eine reine
          // Tombstone-Zeile neu an, was durch die bestehende INSERT-RLS-Policy gedeckt ist.
          payload = { [_primaryKeyOf(q.store)]: q.record_id, user_id: session.user.id, device_id: _deviceId(), deleted_at: FIDB.nowIso(), synced_at: FIDB.nowIso() };
        } else {
          const record = await FIDB.get(q.store, q.record_id);
          if (!record) { await FIDB.del("sync_queue", q.queue_key); continue; } // lokal geloescht ohne Tombstone (aeltere Logik/Edge-Case) -> verwaister Queue-Eintrag, aufraeumen
          payload = buildCloudPayload(q.store, record, session.user.id);
        }
        const { error } = await client.from(q.store).upsert(payload, { onConflict: _primaryKeyOf(q.store) });
        if (error) throw error;
        await FIDB.del("sync_queue", q.queue_key);
        done++;
      } catch (e) {
        stillPending++;
        q.attempts = (q.attempts || 0) + 1;
        q.last_error = (e && e.message) ? e.message : String(e);
        q.last_attempt_at = FIDB.nowIso();
        try { await FIDB.put("sync_queue", q); } catch (e2) { /* lokal folgenlos */ }
      }
    }
    try { localStorage.setItem("fi_last_sync_attempt_at", FIDB.nowIso()); } catch (e) {}
    if (done > 0) { try { localStorage.setItem("fi_last_cloud_sync_at", FIDB.nowIso()); } catch (e) {} }
    return { attempted: pending.length, done, stillPending };
  } finally {
    _flushing = false;
  }
}

function _lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function _lsSet(key, val) { try { localStorage.setItem(key, val); } catch (e) {} }
function _lsGetJson(key) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
function _lsSetJson(key, obj) { try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) {} }

// ---------------------------------------------------------------------------
// STATUS — fuer die Insights-Kachel (Auftrag Abschnitt 14/6). Rein lesend, kein Seiteneffekt.
// ---------------------------------------------------------------------------
async function getStatus() {
  const pending = await FIDB.getAll("sync_queue").catch(() => []);
  const loggedIn = await isLoggedIn();
  const lastSyncAt = _lsGet("fi_last_cloud_sync_at");
  const lastSyncAttemptAt = _lsGet("fi_last_sync_attempt_at");
  const lastVerificationAt = _lsGet("fi_last_cloud_verification_at");
  const lastVerificationAttemptAt = _lsGet("fi_last_cloud_verification_attempt_at");
  const lastVerificationResult = _lsGetJson("fi_last_cloud_verification_result");
  const lastRestoreResult = _lsGetJson("fi_last_cloud_restore_result");
  const sdkAvailable = getClient() !== null || (typeof window !== "undefined" && !!window.supabase);
  return {
    loggedIn, sdkAvailable, pendingCount: pending.length, lastSyncAt, lastSyncAttemptAt,
    lastVerificationAt, lastVerificationAttemptAt, lastVerificationResult, lastRestoreResult,
    verificationDue: isVerificationDue(),
    online: typeof navigator !== "undefined" ? navigator.onLine : true,
  };
}

// ---------------------------------------------------------------------------
// v29 — TAEGLICHE BACKUP-VERIFIZIERUNG (Auftrag Abschnitt 5).
//
// "Verifiziert" bedeutet hier bewusst MEHR als "eine HTTP-Anfrage kam mit 200 zurueck": nach einem
// erfolgreichen Leerlaufen der Warteschlange (flushQueue(), stillPending === 0) wird fuer JEDEN
// CLOUD_STORES-Store zusaetzlich per Server-seitigem COUNT (PostgREST "count: exact, head: true" —
// liefert NUR die Anzahl ueber den Content-Range-Header zurueck, KEINE Zeilen, also bewusst
// leichtgewichtig statt eines vollen Downloads) geprueft, ob die Cloud-Seite mindestens so viele
// nicht-getombstonte Zeilen enthaelt wie lokal vorhanden sind. Eine leere Warteschlange OHNE diesen
// Zaehlervergleich waere kein ausreichender Nachweis — ein Upsert kann clientseitig als "erfolgreich"
// (kein Fehler) zurueckkommen, obwohl serverseitig z.B. durch eine RLS-Regel oder eine fehlende Spalte
// (siehe Root-Cause-Befund im v29-Bericht) tatsaechlich nichts geschrieben wurde. Ein Cloud-Zaehler,
// der KLEINER ist als der lokale, ist das eindeutige Signal dafuer und laesst die Verifizierung
// fehlschlagen, auch wenn flushQueue() selbst keinen Fehler gemeldet hat.
//
// Absichtlich NICHT geprueft: dass der Cloud-Zaehler nicht GROESSER als der lokale ist — ein anderes
// Geraet desselben Nutzers kann legitim zusaetzliche Zeilen beigetragen haben, das ist erwuenscht,
// kein Fehlerzustand.
const VERIFICATION_MAX_AGE_MS = 24 * 3600 * 1000;

function isVerificationDue(maxAgeMs = VERIFICATION_MAX_AGE_MS) {
  const last = _lsGet("fi_last_cloud_verification_at");
  if (!last) return true;
  const t = new Date(last).getTime();
  if (Number.isNaN(t)) return true;
  return (Date.now() - t) > maxAgeMs;
}

// Reiner Zaehl-Request (kein Datendownload) — wird sowohl von verifyCloudCompleteness() als auch
// von fetchCloudSummary() (Restore-Vorschau, Auftrag Abschnitt 8) genutzt. `.is("deleted_at", null)`
// blendet Tombstones konsequent aus (Auftrag Abschnitt 10) — sowohl fuer die Verifizierung als auch
// fuer die Restore-Vorschau soll ein absichtlich lokal geloeschter Testdatensatz nicht mitzaehlen.
async function _remoteCount(client, store) {
  try {
    const { count, error } = await client.from(store).select("*", { count: "exact", head: true }).is("deleted_at", null);
    if (error) return { ok: false, error: error.message || String(error) };
    return { ok: true, count: count ?? 0 };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  }
}

async function verifyCloudCompleteness() {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return { ok: false, reason: "offline" };
  if (!getClient()) await loadSupabaseSdk().catch(() => {});
  const client = getClient();
  if (!client) return { ok: false, reason: "sdk_unavailable" };
  const session = await getSession();
  if (!session) return { ok: false, reason: "not_authenticated" };

  _lsSet("fi_last_cloud_verification_attempt_at", FIDB.nowIso());

  // Erst die Warteschlange leeren — eine Verifizierung gegen eine bekanntermassen noch nicht
  // hochgeladene Warteschlange waere sinnlos (sie wuerde immer als unvollstaendig erscheinen).
  const flush = await flushQueue();
  if (flush.stillPending > 0) {
    const result = { ok: false, reason: "pending_after_flush", stillPending: flush.stillPending };
    _lsSetJson("fi_last_cloud_verification_result", result);
    return result;
  }

  const perStore = {};
  let allOk = true;
  for (const store of CLOUD_STORES) {
    const localCount = (await FIDB.getAll(store).catch(() => [])).length;
    const remote = await _remoteCount(client, store);
    if (!remote.ok) { allOk = false; perStore[store] = { localCount, remoteCount: null, ok: false, error: remote.error }; continue; }
    const ok = remote.count >= localCount;
    if (!ok) allOk = false;
    perStore[store] = { localCount, remoteCount: remote.count, ok };
  }

  const result = { ok: allOk, checkedAt: FIDB.nowIso(), perStore };
  _lsSetJson("fi_last_cloud_verification_result", result);
  if (allOk) _lsSet("fi_last_cloud_verification_at", FIDB.nowIso()); // NUR bei Erfolg — ein fehlgeschlagener Lauf darf den "gesichert"-Zeitstempel nicht verlaengern.
  return result;
}

// Orchestrierung fuer die Ausfuehrungsgelegenheiten aus Auftrag Abschnitt 5 (App-Start, Vordergrund,
// online-Event). Greift NUR, wenn tatsaechlich >24h seit der letzten ERFOLGREICHEN Verifizierung
// vergangen sind (isVerificationDue()) — kein Intervall-Timer, kein aggressives Polling. Wird nie
// awaited von einem Erfassungs-Flow, rein informativ/hintergrundseitig.
async function runDailyVerificationIfDue() {
  if (!isVerificationDue()) return { ran: false, reason: "not_due" };
  if (typeof navigator !== "undefined" && navigator.onLine === false) return { ran: false, reason: "offline" };
  if (!(await isLoggedIn())) return { ran: false, reason: "not_authenticated" };
  const result = await verifyCloudCompleteness();
  return { ran: true, result };
}

// ---------------------------------------------------------------------------
// v29 — CLOUD -> LOCAL RESTORE (Auftrag Abschnitt 7/8/9/10).
//
// KONFLIKTPOLITIK (bewusst einfach und einheitlich ueber alle 8 Stores, siehe v29-Bericht Abschnitt
// "Konfliktpolitik" fuer die vollstaendige Herleitung): existiert lokal bereits ein Datensatz mit
// derselben ID, wird er NIE durch die Cloud-Version ueberschrieben — unabhaengig davon, ob ein
// updated_at-Vergleich rechnerisch moeglich waere. Nur echte "cloud-only"-IDs (keine lokale
// Entsprechung) werden geschrieben. Das ist deterministisch, verletzt nie "preserve data rather than
// destructively choosing one" und ist in der Praxis fuer den Hauptfall (leere/verlorene lokale DB)
// vollstaendig wirksam, weil dort JEDE Cloud-ID cloud-only ist. Getombstonte Cloud-Zeilen
// (deleted_at gesetzt) werden schon beim Laden ausgefiltert (siehe fetchCloudRestoreData()) und
// daher nie wiederhergestellt — das loest Auftrag Abschnitt 10 (kein Wiederauftauchen absichtlich
// lokal geloeschter Testdaten).
// ---------------------------------------------------------------------------

// Leichtgewichtige Vorschau (nur Zaehlwerte, Auftrag Abschnitt 8 "Cloud-Sicherung gefunden") — nutzt
// denselben Zaehl-Mechanismus wie die Verifizierung, laedt bewusst KEINE vollen Datensaetze.
async function fetchCloudSummary() {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return { ok: false, reason: "offline" };
  if (!getClient()) await loadSupabaseSdk().catch(() => {});
  const client = getClient();
  if (!client) return { ok: false, reason: "sdk_unavailable" };
  const session = await getSession();
  if (!session) return { ok: false, reason: "not_authenticated" };
  const perStore = {};
  for (const store of CLOUD_STORES) {
    const remote = await _remoteCount(client, store);
    perStore[store] = remote.ok ? remote.count : null;
  }
  return { ok: true, perStore };
}

// Voller Download (nur beim tatsaechlichen Restore-Vorgang, NIE fuer die Vorschau) — pro Store ein
// select("*"), Tombstones werden serverseitig herausgefiltert.
async function fetchCloudRestoreData() {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return { ok: false, reason: "offline" };
  if (!getClient()) await loadSupabaseSdk().catch(() => {});
  const client = getClient();
  if (!client) return { ok: false, reason: "sdk_unavailable" };
  const session = await getSession();
  if (!session) return { ok: false, reason: "not_authenticated" };
  const byStore = {};
  for (const store of CLOUD_STORES) {
    try {
      const { data, error } = await client.from(store).select("*").is("deleted_at", null);
      if (error) return { ok: false, reason: "fetch_error", store, error: error.message || String(error) };
      byStore[store] = data || [];
    } catch (e) {
      return { ok: false, reason: "fetch_error", store, error: (e && e.message) ? e.message : String(e) };
    }
  }
  return { ok: true, byStore };
}

// environmental_snapshot kam relational+payload-aufgeteilt aus der Cloud zurueck (siehe
// buildCloudPayload()) — fuer den lokalen IndexedDB-Store muss das wieder zu einem flachen Objekt
// zusammengefuehrt werden (Umkehrung der Aufteilung).
function _cloudRowToLocalRecord(store, row) {
  if (store !== "environmental_snapshot") return row;
  const { payload, user_id, device_id, synced_at, deleted_at, ...relational } = row;
  return { ...relational, ...(payload || {}) };
}

// Reine, netzwerkfreie Funktion — daher deterministisch unit-testbar (siehe Testsuite). Nimmt bereits
// geladene lokale + Cloud-Datensaetze pro Store entgegen und liefert einen Plan, OHNE etwas zu
// schreiben (Auftrag Abschnitt 8: "vor Restore Vorschau, dann explizite Bestaetigung").
function computeCloudRestorePlan(localByStore, cloudByStore) {
  const byStore = {}; let totalNew = 0, totalKeptLocal = 0;
  for (const store of CLOUD_STORES) {
    const keyPath = FIDB.STORES[store];
    const localRecords = localByStore[store] || [];
    const cloudRows = cloudByStore[store] || [];
    const localIds = new Set(localRecords.map((r) => r[keyPath]));
    const toRestore = [], keptLocal = [];
    for (const row of cloudRows) {
      const id = row[keyPath];
      if (localIds.has(id)) keptLocal.push(id);
      else toRestore.push(_cloudRowToLocalRecord(store, row));
    }
    byStore[store] = { toRestore, keptLocalCount: keptLocal.length, cloudTotal: cloudRows.length, localTotal: localRecords.length };
    totalNew += toRestore.length; totalKeptLocal += keptLocal.length;
  }
  return { byStore, totalNew, totalKeptLocal };
}

// Schreibt AUSSCHLIESSLICH die "toRestore"-Datensaetze aus dem Plan — ruft bewusst NIE enqueue()
// auf (Auftrag Abschnitt 9: "restore darf keinen Sync-Loop erzeugen"): ein wiederhergestellter
// Datensatz KOMMT aus der Cloud, ist dort also per Definition bereits vorhanden, ein erneutes
// Hochladen waere sinnlos und wuerde nur unnoetig Warteschlangen-Eintraege erzeugen.
async function executeCloudRestore(plan) {
  let written = 0;
  const perStore = {};
  for (const [store, entry] of Object.entries(plan.byStore || {})) {
    let n = 0;
    for (const record of entry.toRestore) { await FIDB.put(store, record); n++; }
    perStore[store] = n; written += n;
  }
  const result = { restoredAt: FIDB.nowIso(), written, perStore };
  _lsSetJson("fi_last_cloud_restore_result", result);
  return result;
}

// ---------------------------------------------------------------------------
// v29 — DIAGNOSTICS (Auftrag Abschnitt 14, nur unter ?hidebug=1). Rein lesend. Gibt bewusst NIE
// SUPABASE_URL/SUPABASE_ANON_KEY zurueck (auch wenn der Anon-Key laut Begleitdokument oeffentlich
// sicher ist, Auftrag Abschnitt 14: "Never expose credentials/secrets" — hier daher konservativ nur
// ein Boolean statt der Werte selbst).
// ---------------------------------------------------------------------------
async function getDiagnostics() {
  const status = await getStatus();
  const localCounts = {};
  for (const store of CLOUD_STORES) localCounts[store] = (await FIDB.getAll(store).catch(() => [])).length;
  const pendingByStore = {};
  for (const q of await FIDB.getAll("sync_queue").catch(() => [])) {
    pendingByStore[q.store] = pendingByStore[q.store] || { upserts: 0, deletes: 0 };
    if (q.op === "delete") pendingByStore[q.store].deletes++; else pendingByStore[q.store].upserts++;
  }
  return {
    ...status,
    cloudConfigured: !!SUPABASE_URL && !!SUPABASE_ANON_KEY,
    localCounts,
    pendingByStore,
    verificationDue: isVerificationDue(),
  };
}

// Beim Modul-Laden einmal versuchen, das SDK zu laden (fire-and-forget, blockiert nichts). Schlaegt
// das fehl (offline beim ersten Laden), versucht der bestehende "online"-Listener in app.js beim
// naechsten flushQueue()-Aufruf automatisch erneut (loadSupabaseSdk() wird dort erneut aufgerufen).
if (typeof window !== "undefined") {
  loadSupabaseSdk().catch(() => { /* still, Local First — kein Fehler-Toast fuer einen SDK-Ladefehler */ });
}

window.FISync = {
  CLOUD_STORES, enqueue, enqueueTombstone, enqueueTombstones, flushQueue, getStatus, getSession, isLoggedIn,
  signInWithMagicLink, signOut, onAuthStateChange, loadSupabaseSdk,
  isVerificationDue, verifyCloudCompleteness, runDailyVerificationIfDue,
  fetchCloudSummary, fetchCloudRestoreData, computeCloudRestorePlan, executeCloudRestore,
  getDiagnostics,
  _setClientForTesting, _reset, buildCloudPayload,
};
