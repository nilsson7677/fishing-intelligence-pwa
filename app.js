// Haupt-App: Router, State, View-Rendering, Voice-Workflow, Intelligence Inbox, Trip/GPS.
// Bewusst ein einziges Modul ohne Framework/Build-Schritt (Abschnitt 4/46: "working software",
// keine zusaetzliche Komplexitaet, die auf dem Handy getestet werden muesste, ohne Mehrwert).

// VOICE RELIABILITY LOOP Runde 4 — "Bitte zuerst instrumentieren": ueber den URL-Parameter
// ?voicedebug=1 wird ein Rohdaten-Log JEDES onresult-Ereignisses (seq/resultIndex/resultsCount/
// Index+isFinal+Transcript je Result/Instanz-ID/Zeitstempel) sichtbar in der UI eingeblendet - NUR
// im Testmodus, damit ein Geraetetest ohne angeschlossenes Devtools/USB-Debugging trotzdem exakt
// dokumentieren kann, was Android tatsaechlich liefert (z.B. per Screenshot/Abtippen). Ausserhalb
// dieses Flags aendert sich am normalen Nutzererlebnis nichts.
const VOICE_DEBUG = new URLSearchParams(window.location.search).has("voicedebug");

// PHASE HI-1 (Sea Trout Hourly Intelligence — Data Foundation & Shadow Infrastructure, 30.08.2026):
// analog zu VOICE_DEBUG/?tripdebug=1 — nur hinter diesem Flag erscheint ein kleines, rein
// diagnostisches Debug-Panel in Insights, das EINMALIG auf Knopfdruck einen HourlyEnvironment/
// HourlyFeatures-Snapshot berechnet und als Rohdaten (JSON) anzeigt. Auftrag Abschnitt 19: "keine
// grosse neue Benutzeroberflaeche", nur eine kleine Developer-Ausgabe. Zeigt NIE einen Score/eine
// Empfehlung — HOURLY_INTELLIGENCE_MODE bleibt SHADOW (siehe js/hourly-intelligence.js).
// ERWEITERT in HI-2A (31.08.2026, Auftrag Abschnitt 15): ein zweiter Button unter demselben Flag
// loest EINEN 120h-Batch-Forecast (buildHourlyForecastSeries) aus und zeigt eine Coverage-Uebersicht
// je Feld + 4 Beispielstunden als Rohdaten. Weiterhin AUSDRUECKLICH KEINE "beste Stunde"/kein
// Fenster-Ranking/keine Top-3-Spots/kein Score — reine Diagnose.
const HI_DEBUG = new URLSearchParams(window.location.search).has("hidebug");

// PHASE 5 FOLGEFIX (Android-Realtest 22.08.2026, Runde 2-4): Build-Kennung + Diagnosezeile im
// Trip-Screen, damit ein Geraetetest zweifelsfrei per Screenshot belegen kann, WELCHER Code-Stand
// tatsaechlich laeuft und ob build/Daten/Rendering die Ursache sind. Runde 2 hatte das noch hinter
// ?tripdebug=1 versteckt (analog zum VOICE_DEBUG-Muster) — auf einer als Home-Screen-App
// INSTALLIERTEN PWA gibt es aber i.d.R. keine editierbare Adresszeile, der Parameter war dort quasi
// nie erreichbar. Seit Runde 4 daher IMMER sichtbar (siehe renderTripScreen()). Bei jeder
// inhaltlichen Aenderung an renderTripScreen() MUSS dieser String zusammen mit sw.js CACHE_NAME
// angehoben werden.
const APP_BUILD = "fishing-intelligence-v1-reliable-cloud-backup-v29.1-2026-09-04";

// v29.1 (Auftrag "VERSION LABEL MICRO-HOTFIX", reines UI-Hotfix): das dezente, dauerhaft sichtbare
// Versions-Label auf dem Co-Pilot-Hauptbildschirm (siehe viewCoPilot()) wird aus APP_BUILD
// ABGELEITET statt separat gepflegt zu werden — einzige Quelle der Wahrheit, wie vom Auftrag
// gefordert ("derive/display the version from a single source of truth"). Kuenftige Releases muessen
// nur noch APP_BUILD (und, wie bisher, sw.js CACHE_NAME) anheben; das sichtbare Label folgt
// automatisch. Erwartetes Suffix-Muster: "...-v<major>[.<minor>]-<YYYY-MM-DD>" (z.B. "v29", "v29.1").
// Fallback auf den vollen APP_BUILD-String, falls das Muster einmal nicht passt, damit nie ein
// leeres/fehlerhaftes Label entsteht — der volle APP_BUILD bleibt ohnehin unveraendert in den
// Debug-Diagnostics (?hidebug=1) sichtbar.
function deriveVersionLabel(build) {
  const m = /-v(\d+(?:\.\d+)?)-\d{4}-\d{2}-\d{2}$/.exec(build);
  return m ? `v${m[1]}` : build;
}
const APP_VERSION_LABEL = deriveVersionLabel(APP_BUILD);

const STATE = {
  view: "copilot",
  species: "mefo",
  water: "luebecker_bucht",
  // finalizing: true zwischen "Nutzer hat STOP gedrueckt" und "volles Transkript ist da"
  // (Voice Reliability Loop) - verhindert, dass waehrend dieser kurzen async-Luecke eine neue
  // Aufnahme gestartet wird und die noch ausstehende Extraktion der vorigen Session ueberschreibt.
  voice: { provider: null, listening: false, finalizing: false, interim: "", draft: null, debugLog: [] },
  trip: { active: false, session: null, gpsMode: "off", watchId: null, track: [] },
  renderToken: 0,
  // PHASE 6A (Data Safety Quick Fix, 22.08.2026): beim Start gefundener, noch nicht abgeschlossener
  // Trip aus active_trip_state — solange gesetzt, zeigt der Router die Recovery-Ansicht statt der
  // normalen View (siehe renderView()/renderTripRecoveryScreen()).
  pendingRecovery: null,
};

const ROOT = () => document.getElementById("view-root");

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  await FIDB.openDb();
  const seeded = await FISeed.seedIfEmpty();
  if (seeded) UI.toast("Referenzdaten geladen (Arten/Gewässer/Spots).", "success");
  // MULTI-WATER UX FOLGEFIX Runde 4 (Android-Realtest 22.08.2026): laeuft zusaetzlich zu
  // seedIfEmpty() bei JEDEM Start und ergaenzt fehlende species/water/spot-Eintraege gegen den
  // aktuellen Code-Stand — heilt einen moeglichen stillen Drift, falls dieses Geraet die App schon
  // vor einer spaeteren Erweiterung der Referenzdaten installiert hatte (IndexedDB-Objectstores
  // werden bei einem Versions-Upgrade nie geleert/neu befuellt, siehe seed-data.js). Reiner Upsert
  // bereits vorhandener Referenzdaten, keine neuen Spots erfunden, keine Nutzerdaten beruehrt.
  try {
    const reconciled = await FISeed.reconcileReferenceData();
    if (reconciled.total > 0) {
      console.warn("Referenzdaten-Abgleich hat fehlende Eintraege ergaenzt:", reconciled);
      UI.toast(`Referenzdaten aktualisiert (${reconciled.total} ergänzt).`, "success");
    }
  } catch (e) { console.warn("Referenzdaten-Abgleich fehlgeschlagen:", e); }

  // USER VOCABULARY (Voice Reliability Loop Runde 2, Abschnitt 8): persoenliche Korrekturen aus
  // vorherigen Sitzungen VOR der ersten Extraktion in die Gazetteer-Tabellen einmischen, damit
  // z.B. eine einmal bestaetigte Fuzzy-Korrektur ("Blies Dorf" -> Bliesdorf) ab sofort als
  // exakter Treffer erkannt wird, nicht erneut nur als unsichere Vermutung.
  try {
    const userVocab = await FIDB.getAll("user_vocabulary");
    if (userVocab.length) GAZ.mergeUserVocabulary(userVocab);
  } catch (e) { console.warn("User-Vokabular konnte nicht geladen werden:", e); }

  // PHASE 6A (Data Safety Quick Fix, 22.08.2026): data_origin auf bereits vorhandenen
  // Datensaetzen nachtraeglich ergaenzen (idempotent, additiv — siehe migrateDataOriginIfNeeded()).
  try {
    const migratedCount = await migrateDataOriginIfNeeded();
    if (migratedCount > 0) console.warn(`data_origin nachtraeglich ergaenzt: ${migratedCount} Datensatz/-saetze.`);
  } catch (e) { console.warn("data_origin-Migration fehlgeschlagen:", e); }

  // PHASE 6A: pruefen, ob beim letzten Schliessen der App noch ein Trip lief (active_trip_state) —
  // falls ja, NICHT stillschweigend verwerfen oder automatisch fortsetzen, sondern dem Nutzer eine
  // klare Recovery-Option zeigen (renderTripRecoveryScreen(), ueber STATE.pendingRecovery im Router).
  try {
    const activeTrip = await FIDB.get("active_trip_state", "current");
    if (activeTrip) STATE.pendingRecovery = activeTrip;
  } catch (e) { console.warn("Aktiver-Trip-Check fehlgeschlagen:", e); }

  if ("serviceWorker" in navigator) {
    // RUNDE 7 — Real-Device-Regression: { updateViaCache: "none" } sorgt dafuer, dass sw.js SELBST
    // (das Registrierungs-Skript) NICHT dem normalen HTTP-Cache unterliegt, wenn der Browser
    // periodisch auf ein neues Service-Worker-Skript prueft (Spezifikations-Default waere sonst
    // "imports" - NUR importierte Skripte waeren vom Cache ausgenommen, sw.js selbst nicht). Ohne
    // dieses Flag kann ein Hosting-/CDN-Cache (z.B. GitHub Pages) dazu fuehren, dass der Browser auf
    // absehbare Zeit eine VERALTETE sw.js-Fassung fuer den Update-Check erhaelt und damit nie merkt,
    // dass CACHE_NAME sich geaendert hat - das Geraet bleibt dann auf einem alten App-Shell-Stand
    // haengen, obwohl ein neuer Build deployt wurde. Zusaetzlich wird direkt nach der Registrierung
    // einmal explizit update() aufgerufen, um den Update-Check sofort anzustossen statt auf den
    // naechsten (vom Browser terminierten) automatischen Check zu warten.
    try {
      const reg = await navigator.serviceWorker.register("sw.js", { updateViaCache: "none" });
      reg.update().catch(() => {});
    } catch (e) { console.warn("SW-Registrierung fehlgeschlagen:", e); }
  }

  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => { STATE.view = btn.dataset.view; renderView(); });
  });

  window.addEventListener("online", () => {
    updateOfflineBadge();
    FIEnrichment.retryPendingQueue().then((r) => { if (r.done) UI.toast(`${r.done} Umweltdaten-Snapshot(s) nachtraeglich ergaenzt.`, "success"); });
    // PHASE 6B (Cloud Backup): bei Wiederherstellung der Verbindung erneut synchronisieren
    // (Auftrag Abschnitt 12) — kein Toast bei Erfolg/Misserfolg noetig, siehe Cloud-Status-Kachel
    // in Insights (Abschnitt 14); ein Fehler hier ist niemals ein Nutzer-sichtbarer Fehler.
    if (window.FISync) FISync.flushQueue().then((r) => { if (STATE.view === "insights") renderView(); }).then(() => triggerDailyCloudVerificationIfDue()).catch(() => {});
  });
  window.addEventListener("offline", updateOfflineBadge);
  updateOfflineBadge();

  // v29 (Auftrag Abschnitt 5 — Ausfuehrungsgelegenheit "Vordergrund"): document.visibilitychange
  // feuert u.a. beim Zurueckwechseln aus dem Hintergrund/anderen Tabs auf einem Handy (PWA erneut
  // sichtbar). Greift wie flushQueue() nur, wenn tatsaechlich >24h seit der letzten erfolgreichen
  // Verifizierung vergangen sind (siehe FISync.isVerificationDue()) — kein Polling, kein Intervall.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") triggerDailyCloudVerificationIfDue();
  });

  if (navigator.onLine) {
    FIEnrichment.retryPendingQueue().then((r) => { if (r.done) UI.toast(`${r.done} Umweltdaten-Snapshot(s) nachtraeglich ergaenzt.`, "success"); });
    // PHASE 6B (Cloud Backup): stiller Sync-Versuch bei App-Start (Auftrag Abschnitt 12) — greift
    // nur, wenn SDK geladen, Netz vorhanden UND Nutzer eingeloggt ist; sonst folgenloser No-Op.
    if (window.FISync) FISync.flushQueue().then(() => { if (STATE.view === "insights") renderView(); }).then(() => triggerDailyCloudVerificationIfDue()).catch(() => {});
  }

  renderView();
}

// v29 (Auftrag Abschnitt 5): duenner Wrapper um FISync.runDailyVerificationIfDue() fuer die drei
// Ausfuehrungsgelegenheiten (App-Start, online, Vordergrund) — niemals awaited vom aufrufenden Flow,
// aktualisiert nur bei sichtbarem Effekt die Insights-Ansicht (falls der Nutzer gerade dort ist).
function triggerDailyCloudVerificationIfDue() {
  if (!window.FISync) return;
  FISync.runDailyVerificationIfDue().then((r) => {
    if (r && r.ran && STATE.view === "insights") renderView();
  }).catch(() => { /* rein hintergrundseitig, niemals nutzersichtbar als Fehler (Local First) */ });
}

function updateOfflineBadge() {
  const badge = document.getElementById("offline-badge");
  const offline = !navigator.onLine;
  badge.classList.toggle("hidden", !offline);
  document.body.classList.toggle("is-offline", offline);
}

function todayUtcMidnight() {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

function currentDayPartNow() {
  const h = new Date().getHours();
  if (h >= 4 && h < 6) return "dawn";
  if (h >= 6 && h < 11) return "morning";
  if (h >= 11 && h < 14) return "midday";
  if (h >= 14 && h < 18) return "afternoon";
  if (h >= 18 && h < 20) return "evening";
  if (h >= 20 && h < 22) return "dusk";
  return "night";
}

// PHASE 6A (Data Safety Quick Fix, 22.08.2026): backfillt das neue Feld data_origin auf bereits
// vorhandenen fishing_session/catch_event/intelligence_report-Datensaetzen, die vor dieser Aenderung
// angelegt wurden. Reine additive Ein-Feld-Ergaenzung, IDEMPOTENT (ueberspringt Datensaetze, die das
// Feld schon haben) — kein bestehendes Feld wird veraendert, kein Datensatz geloescht/neu erzeugt.
// Regel: JEDE bisherige App-Nutzung war ausschliesslich Nils' eigene Eingabe (eine Kontaktmeldung war
// vor Phase 6A kein eigenes, im Datenmodell unterscheidbares Konzept) — daher ist "prospective_app_own"
// fuer fishing_session/catch_event immer korrekt. Fuer intelligence_report wird zusaetzlich der
// bereits vorhandene source_type ausgewertet: hearsay/direct_report (Fremdbericht ueber einen
// Kontakt) wird rueckwirkend korrekt als external_contact_report eingeordnet, nicht pauschal als
// eigene Meldung. Siehe PHASE6A_DATA_SAFETY_IMPLEMENTATION_REPORT.md, Abschnitt "Data-Origin-Migration".
async function migrateDataOriginIfNeeded() {
  let migrated = 0;
  try {
    const sessions = await FIDB.getAll("fishing_session");
    for (const s of sessions) {
      if (!s.data_origin) { s.data_origin = "prospective_app_own"; await FIDB.put("fishing_session", s); migrated++; }
    }
    const catches = await FIDB.getAll("catch_event");
    for (const c of catches) {
      if (!c.data_origin) { c.data_origin = "prospective_app_own"; await FIDB.put("catch_event", c); migrated++; }
    }
    const reports = await FIDB.getAll("intelligence_report");
    for (const r of reports) {
      if (!r.data_origin) {
        r.data_origin = (r.source_type === "hearsay" || r.source_type === "direct_report") ? "external_contact_report" : "prospective_app_own";
        await FIDB.put("intelligence_report", r); migrated++;
      }
    }
  } catch (e) { console.warn("data_origin-Migration teilweise fehlgeschlagen:", e); }
  return migrated;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
async function renderView() {
  // Token-Guard gegen Render-Races: jede View baut ihren Inhalt ASYNCHRON (mehrere awaits fuer
  // IndexedDB-Zugriffe) in einem DETACHED Container. Erst wenn dieser Aufruf noch der aktuellste
  // ist (Nutzer hat nicht zwischenzeitlich weiternavigiert), wird #view-root ersetzt — sonst wuerde
  // ein spaeter aufgeloester, veralteter Render-Vorgang Inhalte der falschen View in die aktuell
  // sichtbare View injizieren (auf einem echten Handy bei schnellem Tab-Wechsel real reproduzierbar).
  STATE.renderToken += 1;
  const token = STATE.renderToken;
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === STATE.view));
  const renderers = { copilot: viewCoPilot, angeln: viewAngeln, intelligence: viewIntelligence, gewaesser: viewGewaesser, insights: viewInsights };
  // PHASE 6A: solange ein wiederherstellbarer, noch nicht abgeschlossener Trip aussteht, zeigt der
  // Router IMMER die Recovery-Ansicht statt der normal angeforderten View — der Nutzer entscheidet
  // dort explizit (fortsetzen/verwerfen), bevor die App normal weiterbenutzt wird.
  const content = STATE.pendingRecovery ? await renderTripRecoveryScreen() : await renderers[STATE.view]();
  if (token !== STATE.renderToken) return; // veraltet — eine neuere Navigation hat bereits stattgefunden
  const root = ROOT();
  root.innerHTML = "";
  root.appendChild(content);
}

// ---------------------------------------------------------------------------
// VIEW: Co-Pilot
// ---------------------------------------------------------------------------
async function viewCoPilot() {
  const root = UI.el("div", {});
  // v29.1 (Micro-Hotfix): permanent sichtbares, bewusst dezentes Versions-Label — "near the top",
  // vor der Kontext-Pille/Hero-Karte, damit es der primaeren "Lohnt es sich?"-Hierarchie (Hero-Card
  // weiter unten) nicht die Aufmerksamkeit streitig macht. Kein Debug-Modus noetig (anders als das
  // bestehende ?hidebug=1-Diagnostics-Panel, das den vollen APP_BUILD zeigt). Reine Anzeige, keine
  // Logik-/Datenwirkung.
  root.appendChild(UI.el("div", { class: "app-version-tag" }, `Fishing Intelligence · ${APP_VERSION_LABEL}`));
  const speciesList = await FIDB.getAll("species");
  const waterList = await FIDB.getAll("water");

  // SPRINT 3 (UX Gate): die zwei grossen Dropdown-Panels werden zu einer kompakten Pille mit
  // Refresh-Icon zusammengefasst — Platz above the fold gehoert jetzt der Hero-Karte, nicht der
  // Kontextauswahl. Funktional unveraendert (echte <select>-Elemente, gleiche onchange-Logik).
  const speciesSelect = UI.el("select", { onchange: (e) => { STATE.species = e.target.value; renderView(); } },
    speciesList.map((s) => UI.el("option", { value: s.species_id, ...(s.species_id === STATE.species ? { selected: "selected" } : {}) }, `${speciesEmoji(s.species_id)} ${s.name_de}`)));
  const waterSelect = UI.el("select", { onchange: (e) => { STATE.water = e.target.value; renderView(); } },
    waterList.map((w) => UI.el("option", { value: w.water_id, ...(w.water_id === STATE.water ? { selected: "selected" } : {}) }, w.name_de)));
  const refreshBtn = UI.el("button", { class: "ctx-refresh", title: "Umweltdaten jetzt aktualisieren", onclick: async (ev) => {
    ev.target.textContent = "…"; ev.target.disabled = true;
    try {
      await FIEnrichment.enrich(STATE.water, isoToday(), currentDayPartNow(), "approximate", null, "session", "copilot_live");
      UI.toast("Umweltdaten aktualisiert.", "success");
    } catch (e) { UI.toast("Aktualisierung fehlgeschlagen: " + e.message, "error"); }
    renderView();
  } }, "⟳");
  root.appendChild(UI.el("div", { class: "ctx-row" }, [
    UI.el("div", { class: "ctx-pill" }, [speciesSelect, UI.el("span", { class: "ctx-sep" }, "·"), waterSelect]),
    refreshBtn,
  ]));

  const calibrated = STATE.species === "mefo" && STATE.water === "luebecker_bucht";
  if (calibrated) {
    root.appendChild(await buildMefoCopilotPanels());
  } else {
    root.appendChild(await buildUncalibratedPanel());
  }
  return root;
}

function speciesEmoji(id) { return { mefo: "🐟", zander: "🐠", hecht: "🐊", barsch: "🐟" }[id] || "🐟"; }

const WEEKDAY_SHORT = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const WEEKDAY_LONG = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
function weekdayShort(d) { return WEEKDAY_SHORT[d.getUTCDay()]; }
function weekdayLong(d) { return WEEKDAY_LONG[d.getUTCDay()]; }
function fmtTime(d) { return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }); }
// SPRINT 3.1 (Punkt 5, "Scheinpraezision reduzieren"): das Daemmerungsfenster ist astronomisch
// hergeleitet, nicht fangbuch-validiert — auf 5 Minuten gerundet, um keine Minutenpraezision
// vorzutaeuschen, die es fachlich nicht gibt. Die exakten Werte bleiben in "Details & Rohdaten"
// erhalten (siehe dort).
function fmtApproxTime(d) {
  const stepMs = 5 * 60000;
  const rounded = new Date(Math.round(d.getTime() / stepMs) * stepMs);
  return fmtTime(rounded);
}

// SPRINT 3 — "bestes Zeitfenster" als konkretes Fenster statt zweier Einzelzeiten: 60 Minuten vor
// Sonnenuntergang bis 60 Minuten nach Ende der buergerlichen Daemmerung. Keine neue Behauptung —
// dieselbe Daemmerungs-Praemisse wie das bisherige "Zeitfenster (Daemmerung)"-Panel, nur jetzt als
// Zeitspanne statt als zwei Rohzeiten dargestellt.
function duskWindowFromSunEvents(sun) {
  if (!sun?.sunset?.measured_at || !sun?.civil_twilight_end?.measured_at) return null;
  const sunset = new Date(sun.sunset.measured_at);
  const twilightEnd = new Date(sun.civil_twilight_end.measured_at);
  return { start: new Date(sunset.getTime() - 60 * 60000), end: new Date(twilightEnd.getTime() + 60 * 60000) };
}

// SPRINT 3 — Auto-Refresh: "Ich hab jetzt Bock" darf nicht an einem manuellen Tap haengen. Beim
// Oeffnen wird automatisch aktualisiert, wenn der letzte Snapshot fehlt oder aelter als 2h ist. Der
// manuelle Refresh (Icon-Button oben, Button in den Details) bleibt zusaetzlich verfuegbar. Offline
// wird der ggf. aeltere vorhandene Snapshot verwendet, kein Fake-Fetch-Versuch (Kernprinzip
// unveraendert, siehe enrichment.js).
async function ensureFreshSnapshot(waterId, dayPart, maxAgeMs = 2 * 3600 * 1000) {
  let snap = await latestSnapshotForWater(waterId);
  const stale = !snap || (Date.now() - new Date(snap.updated_at).getTime()) > maxAgeMs;
  if (stale && navigator.onLine) {
    try {
      snap = await FIEnrichment.enrich(waterId, isoToday(), dayPart, "approximate", null, "session", "copilot_live");
    } catch (e) { /* vorhandenen (ggf. aelteren) Snapshot behalten, kein Datenverlust */ }
  }
  return snap;
}

// SPRINT 3 — In-Memory-Cache fuer den 3-5-Tage-Wassertemperatur-Ausblick: reine Anzeige-Hilfswerte
// fuer den Startscreen (keine Fangmeldung), daher bewusst KEIN neuer IndexedDB-Store dafuer.
let _forecastCache = null; // { waterId, dateIso, fetchedAt, result }
async function ensureForecastDaily(waterId, lat, lon, startDt, days, maxAgeMs = 2 * 3600 * 1000) {
  const dateIso = startDt.toISOString().slice(0, 10);
  if (_forecastCache && _forecastCache.waterId === waterId && _forecastCache.dateIso === dateIso &&
    (Date.now() - _forecastCache.fetchedAt) < maxAgeMs) {
    return _forecastCache.result;
  }
  if (!navigator.onLine) return _forecastCache?.result || { ok: false, error: "offline", days: [] };
  const marine = new FIProviders.OpenMeteoMarineProvider();
  const result = await marine.getWaterTempForecastDaily(lat, lon, startDt, days);
  _forecastCache = { waterId, dateIso, fetchedAt: Date.now(), result };
  return result;
}

// SPRINT 3.1 — Wasserstandsphase (MUST). Live-Abruf der vollen Pegel-Rohzeitreihe ("jetzt", nicht
// auf einen Meldungs-Zieldatum aggregiert — siehe Kommentar bei PegelonlineProvider.getLevelSeries
// in providers.js), analog zu ensureForecastDaily() als kurzlebiger In-Memory-Cache (kein neuer
// IndexedDB-Store, reiner Anzeige-Hilfswert). Liefert IMMER ein FIProviders.analyzeWaterLevelPhase-
// Ergebnisobjekt zurueck (ok:false mit reason, wenn kein Provider/keine Station/offline/zu wenig
// Daten) — nie eine erfundene Phase.
let _waterLevelCache = null; // { waterId, fetchedAt, result }
async function ensureWaterLevelPhase(waterId, maxAgeMs = 20 * 60 * 1000) {
  if (_waterLevelCache && _waterLevelCache.waterId === waterId && (Date.now() - _waterLevelCache.fetchedAt) < maxAgeMs) {
    return _waterLevelCache.result;
  }
  const profile = FIRegistry.getProfile(waterId);
  if (!profile.waterLevelProvider || !profile.waterLevelStationId) {
    return { ok: false, reason: `Kein Pegel-Provider fuer Gewässer '${waterId}' hinterlegt` };
  }
  if (!navigator.onLine) {
    return _waterLevelCache?.result || { ok: false, reason: "Offline — keine aktuelle Pegel-Zeitreihe abrufbar" };
  }
  const seriesRes = await profile.waterLevelProvider.getLevelSeries(profile.waterLevelStationId);
  const result = seriesRes.ok
    ? FIProviders.analyzeWaterLevelPhase(seriesRes.raw, Date.now())
    : { ok: false, reason: seriesRes.error || "Pegel-Abruf fehlgeschlagen" };
  _waterLevelCache = { waterId, fetchedAt: Date.now(), result };
  return result;
}

function confLabelDe(tier) { return { hoch: "Hoch", mittel: "Mittel", niedrig: "Niedrig" }[tier] || "Niedrig"; }
function tierColor(label) {
  const cls = FIMefoModel.labelChipClass(label);
  return cls === "chip-green" ? "var(--accent-green)" : cls === "chip-yellow" ? "var(--accent-yellow)" :
    cls === "chip-red" ? "var(--accent-red)" : "var(--text-dim2)";
}

function spotDisplayName(spotId) {
  return (FIMefoModel.SPOT_STATS[spotId] && FIMefoModel.SPOT_STATS[spotId].name) || spotId;
}
function whenConfEnToDe(c) { return { high: "hoch", medium: "mittel", low: "niedrig" }[c] || "niedrig"; }

const _berlinDateFmt = (typeof Intl !== "undefined")
  ? new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" })
  : null;
function localDateKeyBerlin(d) { return _berlinDateFmt ? _berlinDateFmt.format(d) : d.toISOString().slice(0, 10); }

// PRODUCT FINISH SPRINT (Auftrag Abschnitt 29, "keine doppelten Provider-Requests/mehrfachen
// 120h-Forecasts/wiederholten WHERE-Laeufe"): EIN gecachter Aufruf von
// FIWhereIntelligence.runWhereShadowAnalysis() liefert sowohl WANN (HI-2B, ueber
// day.whenBestWindow) als auch WO (HI-2C, ueber day.bestWhere.top3) aus GENAU EINEM
// HI-2A.1-Batch-Forecast — kein zweiter runWhenShadowAnalysis()-Aufruf noetig (der wuerde intern
// erneut fetchen). Scope ist bewusst fest "shore" (Auftrag Abschnitt 10: HI-2C ist fachlich nur fuer
// Ufer validiert; ein Boot-Modus-Toggle existiert im Co-Pilot aktuell nicht — siehe Details-Hinweis
// weiter unten fuer die ehrliche Boot-Einordnung). Bei fehlendem Netz/Fehlern wird NIE geworfen,
// sondern ein ehrliches supported:false zurueckgegeben (Auftrag Abschnitt 30, "nie einen Wert erfinden").
let _whereWhenCache = null; // { waterId, fetchedAt, result }
async function ensureWhereWhenAnalysis(waterId, maxAgeMs = 2 * 3600 * 1000) {
  if (_whereWhenCache && _whereWhenCache.waterId === waterId && (Date.now() - _whereWhenCache.fetchedAt) < maxAgeMs) {
    return _whereWhenCache.result;
  }
  if (!navigator.onLine) return _whereWhenCache?.result || { supported: false, status: "offline", reasons: ["offline"] };
  let result;
  try {
    result = await FIWhereIntelligence.runWhereShadowAnalysis(waterId, "mefo", "shore", {});
  } catch (e) {
    result = { supported: false, status: "error", reasons: [e.message] };
  }
  _whereWhenCache = { waterId, fetchedAt: Date.now(), result };
  return result;
}

// v28 PERSONAL FISHING WINDOW (Auftrag Teil C, Abschnitt 17-23, 04.09.2026): eigener, gecachter
// Aufruf von FIHourlyWindowIntelligence.runWhenShadowAnalysis() — bewusst GETRENNT vom obigen
// WHERE-Cache, weil runWhereShadowAnalysis() (HI-2C, Model-Scope-Locked) nur day.whenBestWindow
// (das EINE, unbeschraenkte HI-2B-Bestfenster) nach aussen gibt, nicht aber die fuer den
// Korridor-Filter benoetigten vollstaendigen Stunden-/dayMin/dayMax-Rohdaten (day.hours/
// day.dailyDiagnostics) — dafuer muesste where-spot-intelligence.js selbst veraendert werden, was
// Model Scope Lock Teil D verbietet. Ein zweiter Aufruf derselben Art existiert bereits (unveraendert)
// im bestehenden HI-2B-Debug-Panel weiter unten — dieselbe Funktion, hier nur zusaetzlich mit
// 2h-Cache produktiv nutzbar gemacht. HI-2B selbst (hourly-window-intelligence.js) wird dadurch NICHT
// veraendert, nur ein weiteres Mal mit denselben Parametern aufgerufen.
let _personalWindowCache = null; // { waterId, fetchedAt, result }
async function ensurePersonalWindowAnalysis(waterId, maxAgeMs = 2 * 3600 * 1000) {
  if (_personalWindowCache && _personalWindowCache.waterId === waterId && (Date.now() - _personalWindowCache.fetchedAt) < maxAgeMs) {
    return _personalWindowCache.result;
  }
  if (!window.FIHourlyWindowIntelligence || !navigator.onLine) {
    return _personalWindowCache?.result || { supported: false, status: "offline_or_unavailable", days: [] };
  }
  let result;
  try {
    const raw = await FIHourlyWindowIntelligence.runWhenShadowAnalysis(waterId, { horizonHours: 120 });
    result = { supported: true, ...raw };
  } catch (e) {
    result = { supported: false, status: "error", reasons: [e.message], days: [] };
  }
  _personalWindowCache = { waterId, fetchedAt: Date.now(), result };
  return result;
}

// v28 (Auftrag Teil C, Abschnitt 19): erlaubter Sonnenkorridor + bestes erlaubtes Fenster fuer EINEN
// lokalen Tag, aus dem bereits geladenen HI-2B-Tagesergebnis (dayResult, aus
// ensurePersonalWindowAnalysis().days) + Sonnenauf-/-untergang genau dieses Tages (dieselbe
// Astro-Quelle wie der 5-Tage-Ausblick, siehe buildMefoCopilotPanels). Reine Orchestration —
// die eigentliche Filterlogik lebt vollstaendig in personal-fishing-window.js.
function buildPersonalWindowForLocalDate(personalDays, localDate, refLat, refLon, astro) {
  const dayResult = (personalDays || []).find((d) => d.localDate === localDate) || null;
  if (!dayResult || !window.FIPersonalWindow) {
    return { status: "unavailable", corridor: null, rawBestWindow: dayResult ? dayResult.bestWindow : null, allowedResult: { status: "unavailable", allowedWindow: null, durationHours: null }, dailyContrast: dayResult ? dayResult.dailyDiagnostics?.dailyContrast : null };
  }
  const dUtcMidnight = new Date(localDate + "T00:00:00Z"); // Abschnitt 19: Naeherung Berlin-Kalendertag ~ UTC-Kalendertag, identisches Muster wie beim bestehenden 5-Tage-Ausblick (astro.getSunEvents ist DST-agnostisch, siehe astro.js)
  const sunEvents = astro.getSunEvents(refLat, refLon, dUtcMidnight);
  const personal = window.FIPersonalWindow.buildPersonalWindowForDay(dayResult, sunEvents);
  return { ...personal, dailyContrast: dayResult.dailyDiagnostics?.dailyContrast || null };
}

// "Wann?" (persoenliches, korridorgefiltertes Fenster) — Abschnitt 20: ehrlicher Fallback-Text, wenn
// innerhalb des erlaubten Korridors kein Fenster berechenbar ist, statt stillschweigend ein
// Nachtfenster zu zeigen oder einfach zu kappen.
function buildPersonalWhenPresentation(personalWindowResult) {
  if (!personalWindowResult || personalWindowResult.status === "corridor_unavailable" || personalWindowResult.status === "unavailable") {
    return { text: "Persönliches Zeitfenster derzeit nicht berechenbar (Sonnendaten/Prognose unvollständig).", contrastNote: null, confidenceLabel: null };
  }
  const ar = personalWindowResult.allowedResult;
  if (!ar || ar.status !== "ok" || !ar.allowedWindow) {
    return { text: "Kein zuverlässig empfehlbares Zeitfenster innerhalb des persönlichen Tageskorridors (Sonnenaufgang −1h bis Sonnenuntergang +1h).", contrastNote: null, confidenceLabel: null };
  }
  const w = ar.allowedWindow;
  const start = new Date(w.startTimestamp);
  const displayEnd = new Date(new Date(w.endTimestamp).getTime() + 3600000);
  return {
    text: `Bestes Zeitfenster (${ar.durationHours}h, innerhalb deines Tageskorridors) · ca. ${fmtApproxTime(start)}–${fmtApproxTime(displayEnd)}`,
    contrastNote: personalWindowResult.dailyContrast === "low" ? "Über den Tag nur geringe Unterschiede." : null,
    confidenceLabel: confLabelDe(whenConfEnToDe(w.confidence)),
  };
}

// "Wann?" — Auftrag Abschnitt 5/6: bestes Zeitfenster als "ca."-Spanne (keine Scheinpraezision,
// gleiches Prinzip wie die bisherige Daemmerungsfenster-Anzeige), Kontrast-Hinweis NUR wenn die
// Unterschiede ueber den Tag tatsaechlich gering sind (dailyContrast === "low" aus HI-2B) — sonst
// KEINE Behauptung einer starken Ueberlegenheit.
// v28: bleibt UNVERAENDERT als reine Rohdaten-Praesentationsfunktion fuer das RAW-HI-2B-Fenster im
// ?hidebug=1-Transparenzpanel (Abschnitt 22) — die produktive Hauptanzeige nutzt jetzt
// buildPersonalWhenPresentation() oben.
function buildWhenPresentation(dayWW) {
  if (!dayWW || !dayWW.whenBestWindow) {
    return { text: "Bestes Zeitfenster derzeit nicht berechenbar (Prognosedaten unvollständig).", contrastNote: null };
  }
  const w = dayWW.whenBestWindow;
  const start = new Date(w.startTimestamp);
  const displayEnd = new Date(new Date(w.endTimestamp).getTime() + 3600000); // endTimestamp = Beginn der letzten Fensterstunde
  return {
    text: `Bestes Zeitfenster · ca. ${fmtApproxTime(start)}–${fmtApproxTime(displayEnd)}`,
    contrastNote: dayWW.dailyContrast === "low" ? "Über den Tag nur geringe Unterschiede." : null,
    confidenceLabel: confLabelDe(whenConfEnToDe(w.confidence)),
  };
}

// "Wo?" — Auftrag Abschnitt 7/8: bei LOW_SPOT_CONTRAST NIE ein deterministisches Tie-Breaking als
// "Top 3" verkaufen — stattdessen ehrlich "Keine klare Spot-Differenzierung" (+ optionale, explizit
// UNGERANKTE Kandidatenliste). Nur bei ausreichendem Kontrast ein echtes Top-3 mit je maximal einem
// kurzen Grund, Confidence separat je Spot.
function whereSpotReasonDe(s) {
  if (s.biologicalRules && s.biologicalRules.some((r) => r.ruleId === "WAVE_ONSHORE_ACTIVATION")) {
    return "experimentell: auflandiger Wellenschlag";
  }
  return "experimentelle Spot-Einschätzung";
}
function buildWherePresentation(dayWW) {
  if (!dayWW || !dayWW.bestWhere || !dayWW.bestWhere.top3 || !dayWW.bestWhere.top3.topSpots.length) {
    return { mode: "no_data", text: "Spot-Einschätzung derzeit nicht verfügbar (Prognosedaten unvollständig).", list: [] };
  }
  const top3 = dayWW.bestWhere.top3;
  if (top3.spotContrast === "low" || top3.spotContrast === "unknown") {
    const candidates = top3.topSpots.map((s) => spotDisplayName(s.spotId)).sort((a, b) => a.localeCompare(b, "de"));
    return { mode: "low_contrast", text: "Keine klare Spot-Differenzierung", list: candidates,
      note: "Die Bedingungen unterscheiden sich zwischen den Spots aktuell kaum (experimentelle Einschätzung, HI-2C)." };
  }
  return { mode: "top3", list: top3.topSpots.map((s) => ({
    name: spotDisplayName(s.spotId), reason: whereSpotReasonDe(s), confidence: confLabelDe(whenConfEnToDe(s.confidence)),
  })) };
}

// "Warum?" — Auftrag Abschnitt 15: max. 2-3 kurze Gruende, KLAR getrennt Champion- vs.
// Shadow-basiert, kein technischer Jargon (H1/H2/rawSuitability/...) in der normalen UI.
function shadowWarumFromWhen(dayWW) {
  if (!dayWW || !dayWW.whenBestWindow || dayWW.dailyContrast === "low") return null;
  const reasons = dayWW.whenBestWindow.reasons || [];
  if (reasons.includes("H1_ACTIVE")) {
    return "🧪 Experimentell: wärmeres Wasser + niedriger Sonnenstand im besten Zeitfenster (unbewiesene Hypothese).";
  }
  return "🧪 Experimentell: rechnerisch günstigeres Zeitfenster laut Schatten-Analyse (unbewiesene Hypothese).";
}

// "Live-Bedingungen" (Auftrag Abschnitt 16) — kompakte Karte, Minimum Wassertemperatur/Wind/
// Windrichtung/Welle/Pegelphase/Sonnenuntergang, Lufttemperatur optional. Welle kommt bewusst AUS
// der bereits geladenen WHEN/WHERE-Fensteraggregation (aggregateWindowConditions) statt eines
// weiteren Requests (Performance, Auftrag Abschnitt 29) — fehlt sie, wird das ehrlich benannt
// (Auftrag Abschnitt 30 Beispieltext "Wellenprognose derzeit nicht verfügbar.").
function buildLiveConditionsPanel(snap, waterPhase, todayWW) {
  const waveM = todayWW?.bestWhere?.windowConditions?.waveHeightMMedian;
  const rows = [
    ["Wassertemperatur", snap?.water_temp_c?.value != null ? UI.fmtProvValue(snap.water_temp_c) : "nicht verfügbar"],
    ["Wind", (snap?.wind_speed_bft?.value != null && snap?.wind_dir_deg?.value != null)
      ? `${Math.round(snap.wind_dir_deg.value)}° / ${snap.wind_speed_bft.value} Bft` : "nicht verfügbar"],
    ["Welle", (typeof waveM === "number") ? `${waveM.toFixed(1)} m (im besten Zeitfenster, experimentell)` : "Wellenprognose derzeit nicht verfügbar."],
    ["Pegelphase", waterPhase.ok ? FIMefoModel.waterPhaseLabel(waterPhase.phase) : "derzeit unklar"],
    ["Sonnenuntergang", snap?.sunset?.value ? fmtTime(new Date(snap.sunset.value)) : "nicht verfügbar"],
  ];
  if (snap?.air_temp_c?.value != null) rows.push(["Lufttemperatur", UI.fmtProvValue(snap.air_temp_c)]);
  return UI.el("div", { class: "panel" }, [
    UI.el("div", { class: "panel-label" }, "Live-Bedingungen"),
    UI.el("div", { class: "quality-grid" }, rows.map(([k, v]) => UI.el("div", {}, [UI.el("strong", {}, k + ": "), v]))),
  ]);
}

// 5-Tage-Ausblick-Detailzeile (Auftrag Abschnitt 17-19): Champion-Tagesbewertung (unveraendert
// wiederverwendet), + bestes HI-2B-Zeitfenster, + HI-2C-Status (Top-Spot NUR bei ausreichendem
// Kontrast, sonst ehrlich "Keine klare Spot-Differenzierung" statt eines willkuerlichen
// Tie-Breaking-Spots) — NIE ein erfundener Spot, wenn WHERE fuer diesen Tag keine Daten liefert.
// v28 (Auftrag Teil C, Abschnitt 23): "dieselbe Regel gilt fuer jeden Tag im 5-Tage-Ausblick" — jeder
// Tag bekommt hier seinen EIGENEN Sonnenkorridor + sein eigenes erlaubtes bestes Fenster
// (buildPersonalWindow(localDate), von buildMefoCopilotPanels() uebergeben), NIE ein Nachtfenster
// ausserhalb der persoenlichen Grenze.
function buildFiveDayItem(entry, whereWhenResult, buildPersonalWindow) {
  const key = localDateKeyBerlin(entry.date);
  const dWW = whereWhenResult && whereWhenResult.supported ? whereWhenResult.days.find((d) => d.localDate === key) : null;
  const personal = buildPersonalWindow ? buildPersonalWindow(key) : null;
  const personalPresentation = buildPersonalWhenPresentation(personal);
  const ar = personal && personal.allowedResult;
  const whenText = (ar && ar.status === "ok" && ar.allowedWindow)
    ? `ca. ${fmtApproxTime(new Date(ar.allowedWindow.startTimestamp))}–${fmtApproxTime(new Date(new Date(ar.allowedWindow.endTimestamp).getTime() + 3600000))} (Datenlage: ${personalPresentation.confidenceLabel || "niedrig"})`
    : "Kein Fenster im persönlichen Tageskorridor";
  let whereText;
  const where = buildWherePresentation(dWW);
  if (where.mode === "top3") whereText = where.list[0].name;
  else if (where.mode === "low_contrast") whereText = "Keine klare Spot-Differenzierung";
  else whereText = "Spot-Einschätzung nicht verfügbar";
  return UI.el("div", { class: "outlook-day-row" }, [
    UI.el("div", {}, [UI.el("strong", {}, `${weekdayShort(entry.date)} ${String(entry.date.getUTCDate()).padStart(2, "0")}.${String(entry.date.getUTCMonth() + 1).padStart(2, "0")}`), ` · `,
      UI.el("span", { style: `color:${tierColor(entry.label)};font-weight:700;` }, entry.label.toUpperCase())]),
    UI.el("div", { class: "subtext" }, `Zeitfenster: ${whenText} · Wo: ${whereText}`),
  ]);
}

// PRODUCT FINISH SPRINT (Fishing Intelligence v1, 03.09.2026) — Co-Pilot-Hauptbildschirm, neu
// orchestriert nach der geforderten Informationsarchitektur (Auftrag Abschnitt 3): LOHNT ES SICH? ->
// WANN? -> WO? -> WAS? -> WARUM? -> LIVE-BEDINGUNGEN -> NAECHSTE 5 TAGE -> Details/Rohdaten. Reine
// ORCHESTRATION bereits bestehender, unveraenderter Engines (Model Scope Lock, Auftrag Abschnitt 2):
// Champion/SPOT_STATS (meerforelle-model.js), HI-2B WHEN (hourly-window-intelligence.js), HI-2C
// WHERE (where-spot-intelligence.js), WHAT (what-intelligence.js, NEU diese Sprint — Scoring-Impact
// "none"), Spot-Metadaten (spot-intelligence-data.js, hier NICHT gelesen — bleibt reine
// Debug-Anzeige unter ?hidebug=1). Ersetzt die bisherige "Alternativen heute"-Historisch-Rangliste
// im Hauptbildschirm (Auftrag-Design-Entscheidung, siehe PRODUCT_CHANGE_REPORT): zwei
// unterschiedliche "welcher Spot?"-Aussagen (historisch vs. live-experimentell) nebeneinander im
// Hauptbildschirm wuerden Abschnitt 27 ("keine verwirrende Sprache") verletzen — die historische
// Rangliste bleibt vollstaendig erhalten, nur jetzt ausschliesslich in "Details & Rohdaten".
async function buildMefoCopilotPanels() {
  const waterId = STATE.water;
  const dayPart = currentDayPartNow();
  const today = todayUtcMidnight();
  const [refLat, refLon] = FIRegistry.WATER_REFERENCE_POINTS[waterId];

  const snap = await ensureFreshSnapshot(waterId, dayPart);
  const waterPhase = await ensureWaterLevelPhase(waterId); // SPRINT 3.1 MUST

  const rankedSpots = FIMefoModel.rankSpots();
  const topSpot = rankedSpots[0] || null;

  // PRODUCT FINISH SPRINT: EIN gecachter WHEN+WHERE-Lauf fuer heute+die naechsten Tage (siehe
  // ensureWhereWhenAnalysis oben) — deckt sowohl "Wann?"/"Wo?" heute als auch den 5-Tage-Ausblick ab.
  const whereWhenResult = await ensureWhereWhenAnalysis(waterId);
  const todayKey = localDateKeyBerlin(today);
  const todayWW = whereWhenResult && whereWhenResult.supported
    ? (whereWhenResult.days.find((d) => d.localDate === todayKey) || whereWhenResult.days[0] || null) : null;

  // v28 PERSONAL FISHING WINDOW (Auftrag Teil C, Abschnitt 17-23): eigener HI-2B-Lauf fuer die
  // vollstaendigen Stunden-Rohdaten (siehe ensurePersonalWindowAnalysis oben, Begruendung fuer den
  // separaten Aufruf dort). HI-2B selbst unveraendert, gecacht analog zum WHERE-Ergebnis.
  const personalWindowResult = await ensurePersonalWindowAnalysis(waterId);

  const forecast = await ensureForecastDaily(waterId, refLat, refLon, today, 5);
  const astro = new FIAstro.NOAAAstroProvider();
  // Abschnitt 23: JEDER Tag bekommt seinen eigenen Sonnenkorridor + sein eigenes erlaubtes bestes
  // Fenster — kein globaler/geteilter Korridor ueber alle 5 Tage.
  const buildPersonalWindow = (localDate) => buildPersonalWindowForLocalDate(
    personalWindowResult && personalWindowResult.supported ? personalWindowResult.days : [], localDate, refLat, refLon, astro);
  const todayPersonalWindow = buildPersonalWindow(todayKey);
  const dayEntries = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(today.getTime() + i * 86400000);
    const month = d.getUTCMonth() + 1;
    let wassertemp, envTier, sunEvents;
    if (i === 0) {
      wassertemp = snap?.water_temp_c?.value ?? null;
      envTier = snap?.data_quality || "niedrig";
      sunEvents = snap?.sunset && snap?.civil_twilight_end ? { sunset: snap.sunset, civil_twilight_end: snap.civil_twilight_end } : astro.getSunEvents(refLat, refLon, d);
    } else {
      const fEntry = forecast?.ok ? forecast.days.find((x) => x.dayOffset === i) : null;
      wassertemp = (fEntry && fEntry.value !== null) ? fEntry.value : null;
      envTier = wassertemp === null ? "niedrig" : FIMefoModel.forecastEnvTier(i, "hoch");
      sunEvents = astro.getSunEvents(refLat, refLon, d);
    }
    const fc = FIMefoModel.basisFangchance(month, wassertemp);
    const confidenceTier = FIMefoModel.combineConfidenceTier(envTier, topSpot ? topSpot.confidenceTier : "niedrig");
    dayEntries.push({ date: d, dayOffset: i, index: fc.score, label: fc.label, tFactor: fc.tFactor,
      wassertemp, envTier, confidenceTier, duskWindow: duskWindowFromSunEvents(sunEvents) });
  }

  const todayEntry = dayEntries[0];
  const nochBesser = FIMefoModel.pickNochBesser(todayEntry, dayEntries.slice(1));
  const waterLevelCandidate = FIMefoModel.waterLevelWarumCandidate(waterPhase); // SPRINT 3.1
  const expWindow = FIMefoModel.experimentalPostPeakWindow(waterPhase); // SPRINT 3.1 — Hypothese, getrennt von der Messung
  // Auftrag Abschnitt 15: max. 2-3 kurze Gruende im Hauptbildschirm (statt der bisherigen 4) — die
  // vollstaendige, bis zu 4 Eintraege lange Liste bleibt zusaetzlich unveraendert in den Details.
  const warumReasonsAll = FIMefoModel.buildWarumReasons(
    today.getUTCMonth() + 1, todayEntry.wassertemp, todayEntry.tFactor, topSpot, waterLevelCandidate);
  const warumReasonsChampion = warumReasonsAll.slice(0, 2);
  // v28 (Auftrag Teil C, Abschnitt 22): "Warum" muss zum tatsaechlich ANGEZEIGTEN Fenster passen —
  // seit die Hauptanzeige das persoenlich gefilterte Fenster zeigt (statt des rohen HI-2B-Fensters),
  // liest der Warum-Text jetzt dessen reasons (gleiche Funktion shadowWarumFromWhen unveraendert,
  // nur mit einem anders befuellten "dayWW"-foermigen Objekt gefuettert — kein HI-2B-Code veraendert).
  const warumShadow = (todayPersonalWindow?.allowedResult?.status === "ok" && todayPersonalWindow.allowedResult.allowedWindow)
    ? shadowWarumFromWhen({ whenBestWindow: todayPersonalWindow.allowedResult.allowedWindow, dailyContrast: todayPersonalWindow.dailyContrast })
    : null;

  // SPRINT 3.1 (Punkt 7): "beste Aussicht der naechsten Tage" — bewusst GETRENNT von pickNochBesser
  // (das ist nur eine SCHWELLENWERT-gebundene, deutliche Verbesserung gegenueber heute). Hier: rein
  // deskriptiv der beste Tag unter Tag+1..Tag+4, unabhaengig davon, ob er die Noch-besser-Schwelle
  // reisst — kann also auch bei insgesamt schwacher Woche der "am wenigsten schlechte" Tag sein.
  const futureDays = dayEntries.slice(1);
  const bestOutlook = futureDays.reduce((best, d) =>
    (d.index !== null && (best === null || d.index > best.index) ? d : best), null);

  // ---- "WANN?" (HI-2B + v28 Personal Fishing Window, Auftrag Teil C Abschnitt 17-23) — zeigt jetzt
  // das auf den persoenlichen Tageskorridor (Sonnenaufgang -1h bis Sonnenuntergang +1h) gefilterte
  // beste Fenster statt des rohen, ggf. naechtlichen HI-2B-Bestfensters. Das rohe HI-2B-Fenster
  // bleibt vollstaendig einsehbar im ?hidebug=1-Transparenzpanel (buildWhenPresentation(todayWW),
  // unveraendert). ----
  const whenInfo = buildPersonalWhenPresentation(todayPersonalWindow);
  // ---- "WO?" (HI-2C, Auftrag Abschnitt 7/8) ----
  const whereInfo = buildWherePresentation(todayWW);
  // ---- "WAS?" (WHAT, Auftrag Abschnitt 11-14) — Kontext AUSSCHLIESSLICH aus bereits geladenen
  // Daten (kein weiterer Request, Auftrag Abschnitt 29): heutige Wassertemperatur, aktuelle
  // Sonnenhoehe (rein astronomisch/offline berechnet, HI-1-Funktion wiederverwendet), Bewoelkung
  // aus dem ohnehin geladenen Snapshot.
  const nowSolar = (window.FIHourlyIntelligence && refLat !== undefined)
    ? FIHourlyIntelligence.computeSolarFeatures(refLat, refLon, new Date()) : { solarElevationDeg: null };
  const whatRec = window.FIWhatIntelligence ? FIWhatIntelligence.buildLureRecommendation({
    waterTempC: todayEntry.wassertemp, solarElevationDeg: nowSolar.solarElevationDeg,
    cloudCoverPct: snap?.cloud_cover_pct?.value ?? null,
  }) : null;

  const wrap = UI.el("div", {});

  // ---- 1) "LOHNT ES SICH?" + 2) "WANN?" (Hero-Karte, Auftrag Abschnitt 4/5/6/20) ----
  const indexReveal = UI.el("div", { class: "index-reveal hidden" },
    "Fangindex ist eine Modellzahl (Saison × Wassertemperatur), KEINE Fangwahrscheinlichkeit in Prozent.");
  const indexToggle = UI.el("button", { class: "index-toggle-btn", onclick: (ev) => {
    indexReveal.classList.toggle("hidden");
    ev.currentTarget.textContent = indexReveal.classList.contains("hidden") ? "Index anzeigen ⓘ" : "Index ausblenden";
  } }, "Index anzeigen ⓘ");
  // Auftrag Abschnitt 4: Fangindex-Zahl SEKUNDAER, aber sichtbar ("GUT / Fangindex 68"), NIE als
  // "%"/"Fangwahrscheinlichkeit" formuliert (bewusst ohne "/100"-Schreibweise, siehe Sprint-3-Guardrail).
  const heroIndexLine = UI.el("div", { class: "hero-index-line" },
    todayEntry.index !== null ? `Fangindex ${todayEntry.index}` : "Fangindex nicht berechenbar (keine aktuelle Wassertemperatur)");
  const heroTimeLine = [whenInfo.text, whenInfo.contrastNote].filter(Boolean).join(" · ");

  const confDots = (tier) => {
    const n = tier === "hoch" ? 3 : tier === "mittel" ? 2 : 1;
    return UI.el("div", { class: "confidence-dots" }, [1, 2, 3].map((i) => UI.el("span", { class: i <= n ? "on" : "" })));
  };

  // SPRINT 3.1 (Punkt 2, MUST): Wasserstandsphase-Zeile — Phase + Hochstand-Zeit/seit/Rate, ODER
  // ehrlich "derzeit unklar" statt eines erfundenen Zustands. Punkt 3: das experimentelle
  // Fangfenster ist eine EIGENE Zeile mit 🧪-Praefix, NIE in die Phase-Aussage selbst eingemischt.
  const wlDetailParts = [];
  if (waterPhase.ok) {
    if (waterPhase.phase === "laeuft_ab" && waterPhase.peakTime) {
      const hhmm = new Date(waterPhase.peakTime).toISOString().slice(11, 16);
      wlDetailParts.push(`Hochstand ${hhmm}`, `seit ${waterPhase.minutesSincePeak} min`);
    } else if (waterPhase.phase === "laeuft_ab") {
      wlDetailParts.push("Zeitpunkt des letzten Hochstands nicht eindeutig bestimmbar");
    }
    if (waterPhase.rateCmPerHour !== null && waterPhase.phase !== "stabil") {
      wlDetailParts.push(`${waterPhase.rateCmPerHour > 0 ? "+" : ""}${waterPhase.rateCmPerHour} cm/h`);
    }
  } else if (waterPhase.reason) {
    wlDetailParts.push(waterPhase.reason);
  }
  const waterlevelRow = UI.el("div", { class: "waterlevel-row" }, [
    UI.el("div", { class: "waterlevel-phase" }, `🌊 ${FIMefoModel.waterPhaseLabel(waterPhase.ok ? waterPhase.phase : null)}`),
    wlDetailParts.length ? UI.el("div", { class: "waterlevel-detail" }, wlDetailParts.join(" · ")) : null,
    expWindow && expWindow.active
      ? UI.el("div", { class: "experimental-badge" }, `🧪 Experimentelles 30–60-Min.-Fenster nach Hochstand (seit ${expWindow.minutesSincePeak} min) — NICHT validiert, siehe Details`)
      : null,
  ]);

  // ---- 1) LOHNT ES SICH? + 2) WANN? (Hero-Karte) ----
  const heroCard = UI.el("div", { class: "hero-card" }, [
    UI.el("div", { class: "hero-tag" }, "Heute"),
    UI.el("div", { class: "hero-label-row" }, [
      UI.el("div", { class: "hero-label", style: `color:${tierColor(todayEntry.label)};` }, todayEntry.label.toUpperCase()),
    ]),
    heroIndexLine,
    indexToggle, indexReveal,
    UI.el("div", { class: "hero-sub" }, heroTimeLine),
    UI.el("div", { class: "confidence-row" }, [
      UI.el("span", {}, ["Confidence: ", UI.el("strong", {}, confLabelDe(todayEntry.confidenceTier))]),
      confDots(todayEntry.confidenceTier),
    ]),
    waterlevelRow,
  ]);
  wrap.appendChild(heroCard);

  // ---- 3) WO? (HI-2C — Auftrag Abschnitt 7/8: bei geringem Spot-Kontrast KEIN vorgetaeuschtes
  // Top-3-Ranking, sondern ehrlich "Keine klare Spot-Differenzierung") ----
  wrap.appendChild(UI.el("div", { class: "section-label" }, "Wo?"));
  if (whereInfo.mode === "no_data") {
    wrap.appendChild(UI.el("div", { class: "panel" }, whereInfo.text));
  } else if (whereInfo.mode === "low_contrast") {
    wrap.appendChild(UI.el("div", { class: "panel" }, [
      UI.el("div", { class: "wo-line" }, whereInfo.text),
      UI.el("div", { class: "subtext" }, whereInfo.note),
      whereInfo.list.length ? UI.el("div", { class: "subtext" }, "Geeignete Kandidaten (unsortiert): " + whereInfo.list.join(", ")) : null,
    ]));
  } else if (whereInfo.mode === "top3") {
    wrap.appendChild(UI.el("div", { class: "alt-row" }, whereInfo.list.map((s) =>
      UI.el("div", { class: "alt-card" }, [
        UI.el("div", { class: "alt-name" }, s.name),
        UI.el("div", { class: "alt-label", style: "font-size:11px;font-weight:600;" }, s.reason),
        UI.el("div", { class: "alt-conf" }, `Confidence: ${s.confidence}`),
      ]))));
    wrap.appendChild(UI.el("div", { class: "subtext" }, "Experimentelle Spot-Einschätzung (HI-2C) — kein historisches Ranking."));
  }

  // ---- 4) WAS? (WHAT — Auftrag Abschnitt 11-14: max. 3 Angaben, IMMER evidenzbasiert formuliert) ----
  wrap.appendChild(UI.el("div", { class: "section-label" }, "Was?"));
  if (whatRec) {
    wrap.appendChild(UI.el("div", { class: "panel" }, [
      UI.el("div", { class: "was-line" }, whatRec.koedertyp.text),
      UI.el("div", { class: "subtext" }, `${whatRec.farbeMuster.text} · ${whatRec.praesentation.text}`),
      UI.el("div", { class: "subtext" }, whatRec.alternative.text),
    ]));
  } else {
    wrap.appendChild(UI.el("div", { class: "panel" }, "Köder-Empfehlung derzeit nicht verfügbar."));
  }

  // ---- 5) WARUM? (max. 2-3 kurze Gruende, Champion klar getrennt von Shadow/experimentell) ----
  wrap.appendChild(UI.el("div", { class: "warum-label" }, "Warum?"));
  wrap.appendChild(UI.el("ul", { class: "warum-list" }, [
    ...warumReasonsChampion.map((r) => UI.el("li", { class: r.ok ? "" : "warum-neg" }, `${r.ok ? "✓" : "•"} ${r.text}`)),
    warumShadow ? UI.el("li", { class: "warum-shadow" }, warumShadow) : null,
  ]));

  // ---- LIVE-BEDINGUNGEN ----
  wrap.appendChild(buildLiveConditionsPanel(snap, waterPhase, todayWW));

  // ---- NOCH BESSER (nur bei erfuellter, dokumentierter Regel — siehe pickNochBesser, unveraendert) ----
  if (nochBesser) {
    wrap.appendChild(UI.el("div", { class: "noch-besser-banner" }, [
      UI.el("div", { class: "noch-besser-tag" }, "🔥 Noch besser"),
      UI.el("div", { class: "noch-besser-body" }, weekdayLong(nochBesser.date)),
      UI.el("div", { class: "noch-besser-sub" }, [
        nochBesser.duskWindow ? `${fmtTime(nochBesser.duskWindow.start)} – ${fmtTime(nochBesser.duskWindow.end)} · ` : "",
        UI.el("strong", { style: `color:${tierColor(nochBesser.label)};` }, nochBesser.label.toUpperCase()),
      ]),
    ]));
  }

  // ---- NÄCHSTE 5 TAGE (Auftrag Abschnitt 17-19: Champion-Tagesbewertung unveraendert + reales
  // HI-2B-Zeitfenster + ehrlicher HI-2C-Status pro Tag, nie ein erfundener Spot) ----
  wrap.appendChild(UI.el("div", { class: "section-label" }, "Nächste 5 Tage"));
  wrap.appendChild(UI.el("div", { class: "day-strip" }, dayEntries.map((entry, i) => {
    const isBest = bestOutlook && entry.dayOffset === bestOutlook.dayOffset;
    return UI.el("div", { class: "day-chip" + (i === 0 ? " is-today" : "") + (isBest ? " is-best-outlook" : "") }, [
      UI.el("div", { class: "dname" + (i === 0 ? " is-today-label" : "") }, i === 0 ? `${weekdayShort(entry.date)}·heute` : weekdayShort(entry.date)),
      UI.el("div", { class: "ddot", style: `background:${tierColor(entry.label)};` }),
      UI.el("div", { class: "dlabel" }, entry.label.toUpperCase()),
      isBest ? UI.el("div", { class: "dstar" }, "⭐") : null,
    ]);
  })));
  if (bestOutlook) {
    wrap.appendChild(UI.el("div", { class: "outlook-caption" },
      `⭐ ${weekdayLong(bestOutlook.date)} · ${bestOutlook.label.toUpperCase()} — beste Aussicht der nächsten Tage`));
  }
  wrap.appendChild(UI.el("div", { class: "panel" }, dayEntries.map((entry) => buildFiveDayItem(entry, whereWhenResult, buildPersonalWindow))));

  // ---- DETAILS & ROHDATEN (eingeklappt: Strategie-/Bedingungen-Panel + Spot-Rangliste, jetzt
  // zusaetzlich die historische Spot-Option (Auftrag Abschnitt 9: Spot-Metadaten/-Historie bleiben
  // rein beschreibend, NIE als versteckte neue Rangliste im Hauptbildschirm) + ehrlicher
  // Boot-Hinweis (Auftrag Abschnitt 10) ----
  const windBft = snap?.wind_speed_bft?.value ?? null;
  const windDir = snap?.wind_dir_deg?.value ?? null;
  const detailsBody = UI.el("div", { class: "details-body hidden" }, [
    UI.el("div", { class: "panel" }, [
      UI.el("div", { class: "panel-label" }, "Strategie"),
      UI.el("div", { class: "subtext", style: "font-size:14px;color:var(--text);" }, FIMefoModel.strategieHinweis(windDir, windBft, 68)),
    ]),
    UI.el("div", { class: "panel" }, [
      UI.el("div", { class: "panel-label" }, "Bedingungen"),
      UI.el("div", { class: "quality-grid", style: "grid-template-columns:1fr 1fr;font-size:13px;" }, [
        UI.el("div", {}, `Lufttemp.: ${UI.fmtProvValue(snap?.air_temp_c)}`),
        UI.el("div", {}, `Wind: ${UI.fmtProvValue(snap?.wind_dir_deg, 0)}° / ${UI.fmtProvValue(snap?.wind_speed_bft, 0)} Bft`),
        UI.el("div", {}, `Pegel (absolut): ${UI.fmtProvValue(snap?.water_level_cm, 0)}`),
        UI.el("div", {}, `Wassertemp.: ${UI.fmtProvValue(snap?.water_temp_c)}`),
      ]),
      UI.el("div", { class: "subtext" },
        waterPhase.ok
          ? `Wasserstandstrend: ${FIMefoModel.waterPhaseLabel(waterPhase.phase)}` +
            (waterPhase.rateCmPerHour !== null ? ` (${waterPhase.rateCmPerHour > 0 ? "+" : ""}${waterPhase.rateCmPerHour} cm/h)` : "") +
            ` · Confidence: ${confLabelDe(waterPhase.confidence)} · Datenalter: ${waterPhase.dataAgeMinutes} min`
          : `Wasserstandstrend: unklar${waterPhase.reason ? ` (${waterPhase.reason})` : ""}`),
      todayEntry.duskWindow
        ? UI.el("div", { class: "subtext" },
          `Dämmerungsfenster (exakt, astronomisch): ${fmtTime(todayEntry.duskWindow.start)}–${fmtTime(todayEntry.duskWindow.end)} (60min vor Sonnenuntergang bis 60min nach Ende bürgerliche Dämmerung)`)
        : null,
      snap ? UI.el("div", { class: "subtext", html: `Status: ${UI.statusChip(snap.status)} · Datenqualität: ${snap.data_quality}` }) : null,
    ]),
    UI.el("div", { class: "panel" }, [
      UI.el("div", { class: "panel-label" }, "Historische Spot-Stärke"),
      UI.el("div", { class: "subtext" },
        `Rangfolge aus deinem Fangbuch. Aktuelle Wetterbedingungen verändern diese Rangfolge derzeit noch nicht. ` +
        `Stärkste historische Spot-Option: ${topSpot ? topSpot.name : "kein historisch validierter Spot"}.`),
      UI.el("ul", { class: "historic-spot-list", style: "padding-left:16px;font-size:13.5px;line-height:1.55;" }, rankedSpots.slice(0, 6).map((sp) =>
        UI.el("li", {}, `${sp.name}: ${Math.round(sp.shrunkRate * 100)}% (n=${sp.n}, Confidence: ${confLabelDe(sp.confidenceTier)})`))),
    ]),
    UI.el("div", { class: "panel" }, [
      UI.el("div", { class: "panel-label" }, "Hinweis Ufer/Boot"),
      UI.el("div", { class: "subtext" },
        "Die Abschnitte „Wo?“ oben gehen von Ufer-Angeln aus (bislang einzige fachlich validierte HI-2C-Kombination). " +
        "Für Boot ist die dynamische Spot-Empfehlung noch nicht validiert."),
    ]),
    // v28 PERSONAL FISHING WINDOW (Auftrag Teil C, Abschnitt 22/23) — rein lesendes Transparenzpanel:
    // RAW HI-2B-Bestfenster (unveraendert, unbeschraenkt) NEBEN dem erlaubten Tageskorridor UND dem
    // tatsaechlich empfohlenen (gefilterten) Fenster, fuer HEUTE UND jeden Tag im 5-Tage-Ausblick
    // einzeln — beweist, dass HI-2B selbst unveraendert bleibt und nur eine Produkt-Filterung
    // stattfindet (Abschnitt 22 explizit gefordert).
    HI_DEBUG ? UI.el("div", { class: "panel" }, [
      UI.el("div", { class: "panel-label" }, `🕐 Personal Fishing Window (Debug, ?hidebug=1, Auftrag v28 Abschnitt 22/23)`),
      UI.el("div", { class: "subtext" }, window.FIPersonalWindow
        ? `Konfiguration: Sonnenaufgang ${window.FIPersonalWindow.FISHING_WINDOW_PREFERENCE.sunriseOffsetMinutes} min · Sonnenuntergang ${window.FIPersonalWindow.FISHING_WINDOW_PREFERENCE.sunsetOffsetMinutes > 0 ? "+" : ""}${window.FIPersonalWindow.FISHING_WINDOW_PREFERENCE.sunsetOffsetMinutes} min.`
        : "personal-fishing-window.js nicht geladen."),
      ...dayEntries.map((entry) => {
        const key = localDateKeyBerlin(entry.date);
        const p = buildPersonalWindow(key);
        const rawText = p.rawBestWindow
          ? `${fmtApproxTime(new Date(p.rawBestWindow.startTimestamp))}–${fmtApproxTime(new Date(new Date(p.rawBestWindow.endTimestamp).getTime() + 3600000))}`
          : "kein Fenster";
        const corridorText = p.corridor ? `${fmtApproxTime(p.corridor.allowedStart)}–${fmtApproxTime(p.corridor.allowedEnd)}` : "nicht berechenbar";
        const ar = p.allowedResult;
        const recText = (ar && ar.status === "ok" && ar.allowedWindow)
          ? `${fmtApproxTime(new Date(ar.allowedWindow.startTimestamp))}–${fmtApproxTime(new Date(new Date(ar.allowedWindow.endTimestamp).getTime() + 3600000))} (${ar.durationHours}h)`
          : `kein Fenster (${ar ? ar.status : p.status})`;
        return UI.el("div", { class: "subtext", style: "font-family:monospace;font-size:11px;margin-top:4px;" },
          `${key}${key === localDateKeyBerlin(today) ? " (heute)" : ""}: RAW HI-2B ${rawText} · Erlaubt ${corridorText} · Empfohlen ${recText}`);
      }),
    ]) : null,
    UI.el("button", { class: "btn btn-ghost", onclick: async (ev) => {
      ev.target.textContent = "Lädt…"; ev.target.disabled = true;
      try {
        await FIEnrichment.enrich(waterId, isoToday(), dayPart, "approximate", null, "session", "copilot_live");
        UI.toast("Umweltdaten aktualisiert.", "success");
      } catch (e) { UI.toast("Aktualisierung fehlgeschlagen: " + e.message, "error"); }
      renderView();
    } }, "🔄 Umweltdaten jetzt aktualisieren"),
  ]);
  const detailsToggleLabel = UI.el("span", {}, "▾ Details & Rohdaten");
  const detailsToggle = UI.el("div", { class: "details-toggle", onclick: () => {
    detailsBody.classList.toggle("hidden");
    detailsToggleLabel.textContent = detailsBody.classList.contains("hidden") ? "▾ Details & Rohdaten" : "▴ Details & Rohdaten";
  } }, [detailsToggleLabel, UI.el("span", {}, "Wind · Pegel · Datenqualität · Spot-Rangliste")]);
  wrap.appendChild(detailsToggle);
  wrap.appendChild(detailsBody);

  const container = document.createDocumentFragment();
  container.appendChild(wrap);
  return container;
}

async function buildUncalibratedPanel() {
  const wrap = UI.el("div", {});
  const speciesRec = await FIDB.get("species", STATE.species);
  wrap.appendChild(UI.el("div", { class: "uncalibrated-box" }, [
    UI.el("div", { style: "font-size:16px;font-weight:700;margin-bottom:6px;" }, `${speciesRec?.name_de || STATE.species} — ${(await FIDB.get("water", STATE.water))?.name_de || STATE.water}`),
    "Datensammlung läuft.",
    UI.el("div", { class: "subtext" }, "Noch kein kalibriertes Modell (nur Meerforelle/Lübecker Bucht ist Phase-1/2/2.5-validiert) — es wird bewusst KEINE erfundene Wahrscheinlichkeit angezeigt."),
  ]));

  const reports = (await FIDB.getAll("intelligence_report")).filter((r) => r.species === STATE.species && r.water_id === STATE.water);
  const catches = (await FIDB.getAll("catch_event")).filter((c) => c.species === STATE.species);
  wrap.appendChild(UI.el("div", { class: "panel" }, [
    UI.el("div", { class: "panel-label" }, "Bisher gesammelt"),
    UI.el("div", { class: "row-wrap" }, [
      UI.el("span", { class: "chip" }, `${reports.length} Intelligence-Meldungen`),
      UI.el("span", { class: "chip" }, `${catches.length} eigene Fänge`),
    ]),
    UI.el("div", { class: "subtext" }, "Sobald genug eigene Daten vorliegen, wird hier ein kalibriertes Modell ergänzt — nicht vorher."),
  ]));
  return wrap;
}

async function latestSnapshotForWater(waterId) {
  const all = await FIDB.getAll("environmental_snapshot");
  const filtered = all.filter((s) => s.water_id === waterId).sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  return filtered[0] || null;
}

function isoToday() { return todayUtcMidnight().toISOString().slice(0, 10); }

// ---------------------------------------------------------------------------
// VIEW: Angeln
// ---------------------------------------------------------------------------
async function viewAngeln() {
  const root = UI.el("div", {});
  root.appendChild(UI.el("h1", {}, "🎣 Angeln"));
  root.appendChild(UI.el("button", { class: "btn btn-primary", style: "margin-bottom:10px;", onclick: () => renderCatchForm(root) }, "📷 Fang erfassen"));
  root.appendChild(UI.el("button", { class: "btn btn-secondary", style: "margin-bottom:10px;", onclick: () => renderObservationForm(root) }, "👁 Beobachtung erfassen"));
  root.appendChild(UI.el("button", { class: "btn btn-secondary", style: "margin-bottom:16px;", onclick: () => renderTripScreen(root) }, "🎣 Trip starten (optional)"));

  // v28 DATA INTEGRITY (Auftrag Teil A, Abschnitt 8 sinngemaess): seit fishing_session bereits bei
  // Trip-Start (status "in_progress") angelegt wird, wuerde diese Liste ohne Filter jetzt auch noch
  // laufende bzw. verworfene Trips als vermeintlich abgeschlossene Faenge/Nullrunden anzeigen (z.B.
  // "0x mefo" fuer einen gerade erst gestarteten Trip) — hier bewusst weiterhin nur ABGESCHLOSSENE
  // Eintraege, konsistent mit dem "Eigene Trips"-Zaehler in Insights. Laufende/verworfene Trips
  // bleiben ausschliesslich im Data-Integrity-Debug-Panel sichtbar (?hidebug=1).
  const sessions = (await FIDB.getAll("fishing_session")).filter((s) => tripStatus(s) === "completed")
    .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "")).slice(0, 10);
  root.appendChild(UI.el("h2", {}, "Letzte eigene Einträge"));
  if (!sessions.length) {
    root.appendChild(UI.el("div", { class: "empty-state" }, "Noch keine eigenen Fänge/Trips erfasst."));
  } else {
    for (const s of sessions) {
      // PHASE 6 TEIL A (Konsolidierungsfix, Master Audit Abschnitt O #4): Ufer/Boot wird seit
      // Phase 5 optional erfasst (s. renderTripScreen()), war bisher aber nirgends sichtbar —
      // robustester bislang ungenutzter personal-statistischer Befund des Projekts (Winter:
      // Boot 66,7% vs. Ufer 18,2% Fangquote). Rein informative Anzeige, FLIESST WEITERHIN NICHT in
      // Fangindex/Champion/Challenger/Shadow-Scoring ein — reine UI-Sichtbarkeit.
      const shoreBoatTag = s.shore_or_boat === "ufer" ? " · 🚶 Ufer" : s.shore_or_boat === "boot" ? " · 🚤 Boot" : "";
      root.appendChild(UI.el("div", { class: "inbox-item" }, [
        UI.el("div", { class: "inbox-headline" }, s.is_blank_trip ? "Nullrunde" : `${s.result_fish_count}x ${s.species_target}`),
        UI.el("div", { class: "inbox-meta" }, `${UI.fmtDate(s.date)} · ${s.spot_id || s.water_id || "?"} · ${UI.fmtDayPart(s.day_part)}${shoreBoatTag}`),
      ]));
    }
  }
  return root;
}

function renderCatchForm(root) {
  root.innerHTML = "";
  const speciesSel = UI.el("select", {}, []);
  const waterSel = UI.el("select", {}, []);
  const spotSel = UI.el("select", {}, []);
  Promise.all([FIDB.getAll("species"), FIDB.getAll("water"), FIDB.getAll("spot")]).then(([sp, wa, spots]) => {
    sp.forEach((s) => speciesSel.appendChild(UI.el("option", { value: s.species_id }, s.name_de)));
    wa.forEach((w) => waterSel.appendChild(UI.el("option", { value: w.water_id }, w.name_de)));
    const refreshSpots = () => {
      spotSel.innerHTML = "";
      spotSel.appendChild(UI.el("option", { value: "" }, "(kein bestimmter Spot)"));
      spots.filter((sp2) => sp2.water_id === waterSel.value).forEach((sp2) => spotSel.appendChild(UI.el("option", { value: sp2.spot_id }, sp2.name)));
    };
    waterSel.addEventListener("change", refreshSpots);
    refreshSpots();
  });

  const dateInput = UI.el("input", { type: "date", value: isoToday() });
  const daypartSel = UI.el("select", {}, ["unknown", "dawn", "morning", "midday", "afternoon", "evening", "dusk", "night"].map((d) => UI.el("option", { value: d }, UI.fmtDayPart(d))));
  const countInput = UI.el("input", { type: "number", min: "1", value: "1" });
  const blankCheck = UI.el("input", { type: "checkbox" });
  const lengthInput = UI.el("input", { type: "number", step: "1", placeholder: "z.B. 55" });
  const lengthApprox = UI.el("input", { type: "checkbox", checked: "checked" });
  const lureInput = UI.el("input", { type: "text", placeholder: "z.B. Gummifisch" });
  const colorInput = UI.el("input", { type: "text", placeholder: "z.B. Motoroil" });
  const notesInput = UI.el("textarea", { placeholder: "Notizen (optional)" });

  root.appendChild(UI.el("h1", {}, "📷 Fang erfassen"));
  root.appendChild(UI.el("label", {}, "Zielart")); root.appendChild(speciesSel);
  root.appendChild(UI.el("label", {}, "Gewässer")); root.appendChild(waterSel);
  root.appendChild(UI.el("label", {}, "Spot")); root.appendChild(spotSel);
  root.appendChild(UI.el("label", {}, "Datum")); root.appendChild(dateInput);
  root.appendChild(UI.el("label", {}, "Tageszeit")); root.appendChild(daypartSel);
  root.appendChild(UI.el("label", {}, "Anzahl")); root.appendChild(countInput);
  root.appendChild(UI.el("div", { class: "check-row" }, [blankCheck, "Nullrunde (0 Fische)"]));
  // v28 DATA INTEGRITY (Auftrag Teil A, Abschnitt 7): Fang vs. Nullrunde muessen sich GEGENSEITIG
  // AUSSCHLIESSEN, statt wie bisher unabhaengig voneinander lesbar zu sein (vorheriger Bug: die
  // Checkbox setzte countInput beim Ankreuzen zwar auf "0", aber ein erneutes Abwaehlen stellte den
  // Zaehler NIE wieder her — beim Speichern wurde ausschliesslich countInput.value gelesen, die
  // Checkbox selbst gar nicht mehr abgefragt. Ergebnis: ein Nutzer, der "Nullrunde" aus Versehen an-
  // und wieder abwaehlte, verlor kommentarlos seinen echten Fang, OHNE dass ein catch_event je
  // entstand — plausibler Root-Cause fuer den vom Nutzer gemeldeten Barsch-Fang, der als 0 Faenge
  // landete). Jetzt: Checkbox sperrt/leert das Zaehlfeld waehrend sie aktiv ist UND merkt sich den
  // zuletzt eingegebenen Wert, um ihn beim Abwaehlen wiederherzustellen — es kann nie beides
  // gleichzeitig "wahr" sein (count>0 UND Nullrunde angekreuzt).
  let _lastNonZeroCount = "1";
  countInput.addEventListener("input", () => {
    const n = parseInt(countInput.value || "0", 10);
    if (n > 0) _lastNonZeroCount = String(n);
  });
  blankCheck.addEventListener("change", () => {
    if (blankCheck.checked) {
      if (parseInt(countInput.value || "0", 10) > 0) _lastNonZeroCount = countInput.value;
      countInput.value = "0";
      countInput.disabled = true;
    } else {
      countInput.disabled = false;
      countInput.value = _lastNonZeroCount || "1";
    }
  });
  root.appendChild(UI.el("label", {}, "Länge (cm)")); root.appendChild(lengthInput);
  root.appendChild(UI.el("div", { class: "check-row" }, [lengthApprox, "nur ungefähr (keine exakte Messung)"]));
  root.appendChild(UI.el("label", {}, "Köder")); root.appendChild(lureInput);
  root.appendChild(UI.el("label", {}, "Farbe")); root.appendChild(colorInput);
  root.appendChild(UI.el("label", {}, "Notizen")); root.appendChild(notesInput);

  const btnRow = UI.el("div", { class: "btn-row" }, [
    UI.el("button", { class: "btn btn-secondary", onclick: () => renderView() }, "Abbrechen"),
    UI.el("button", { class: "btn btn-primary", onclick: async (ev) => {
      // v28 DATA INTEGRITY (Auftrag Teil A, Abschnitt 7): count/Nullrunde sind jetzt strukturell
      // exklusiv (siehe Checkbox-Handler oben), hier zusaetzlich eine explizite Validierung statt
      // eines stillen Speicherns eines mehrdeutigen Zustands — ein Fang OHNE Nullrunde-Haekchen MUSS
      // eine Anzahl >= 1 haben, sonst wird gar nichts gespeichert und der Nutzer bekommt eine klare
      // Fehlermeldung (Abschnitt 6: "kein falsches 'gespeichert' bei fehlgeschlagenem Schreiben" —
      // sinngemaess auch fuer einen erst gar nicht sinnvoll speicherbaren Eingabezustand).
      const count = blankCheck.checked ? 0 : parseInt(countInput.value || "0", 10);
      if (!blankCheck.checked && count <= 0) {
        UI.toast("Bitte eine Anzahl ≥ 1 eingeben oder „Nullrunde“ ankreuzen.", "error");
        return;
      }
      const session = {
        session_id: FIDB.newId("sess"), angler: "Nils", species_target: speciesSel.value,
        water_id: waterSel.value, spot_id: spotSel.value || null, date: dateInput.value,
        day_part: daypartSel.value, time_precision: daypartSel.value === "unknown" ? "unknown" : "approximate",
        result_fish_count: count, result_contact_count: 0, is_blank_trip: count === 0,
        notes: notesInput.value, source_quality: "A_own_verified", created_at: FIDB.nowIso(),
        // v28 (Auftrag Teil A, Abschnitt 8): Quick-Log-Eintraege sind per Definition sofort
        // vollstaendig/abgeschlossen — explizites status-Feld statt Verlass auf den Legacy-Fallback
        // (fehlendes status == "completed"), damit neue Eintraege ab v28 immer explizit sind.
        status: "completed",
        species_specific: {}, data_origin: "prospective_app_own", // PHASE 6A, Auftrag Punkt 9
      };
      // v28 (Auftrag Teil A, Abschnitt 6): Schreiben VOLLSTAENDIG abwarten UND absichern — bei einem
      // Fehler (z.B. IndexedDB-Quota) darf NIE ein "gespeichert"-Toast erscheinen; der Nutzer bekommt
      // stattdessen eine explizite Fehlermeldung und kann erneut versuchen (Eingaben bleiben erhalten,
      // kein renderView()).
      let catchEvent = null;
      try {
        await FIDB.put("fishing_session", session);
        if (window.FISync) FISync.enqueue("fishing_session", session.session_id);
        if (count > 0) {
          catchEvent = {
            catch_id: FIDB.newId("catch"), session_id: session.session_id, species: speciesSel.value,
            length_cm: lengthInput.value ? parseFloat(lengthInput.value) : null,
            length_precision: lengthInput.value ? (lengthApprox.checked ? "approximate" : "exact") : "unknown",
            catch_time: null, day_part: daypartSel.value, spot_id: spotSel.value || null,
            lure_type: lureInput.value || null, lure_color: colorInput.value || null,
            created_at: FIDB.nowIso(), species_specific: {}, data_origin: "prospective_app_own",
          };
          await FIDB.put("catch_event", catchEvent);
          if (window.FISync) FISync.enqueue("catch_event", catchEvent.catch_id);
        }
      } catch (e) {
        UI.toast("Speichern fehlgeschlagen: " + e.message + " — bitte erneut versuchen.", "error");
        return;
      }
      // Speichern + Navigation sofort (Schreiben oben bereits vollstaendig abgewartet);
      // Environmental Enrichment laeuft im Hintergrund weiter (gleiche Begruendung wie bei
      // saveDraft() — siehe Kommentar dort).
      UI.toast("Fang gespeichert. Umweltdaten werden im Hintergrund ergänzt…", "success");
      STATE.view = "angeln"; renderView();
      FIEnrichment.enrich(waterSel.value, dateInput.value, daypartSel.value, "approximate", null, "session", session.session_id)
        .then(async (snap) => {
          session.environmental_snapshot_id = snap.snapshot_id;
          await FIDB.put("fishing_session", session);
          if (window.FISync) FISync.enqueue("fishing_session", session.session_id);
          UI.toast(`Umweltdaten für Fang: ${snap.status === "complete" ? "vollständig ergänzt" : snap.status}.`, snap.status === "failed" ? "" : "success");
          if (STATE.view === "angeln") renderView();
          // PHASE 5 (GO-Freigabe): explizites Outcome ist hier immer bekannt (Nullrunde-Checkbox
          // bzw. Anzahl explizit gesetzt) — Shadow-Auswertung nur fuer Mefo/Lübecker Bucht (Scope
          // von CHALLENGER_STATE_V1, siehe shadow.js).
          if (window.FIShadow) {
            await window.FIShadow.recordShadowEvaluation({
              linkedEntityType: "fishing_session", linkedEntityId: session.session_id,
              species: session.species_target, waterId: session.water_id,
              snapshot: snap, dateIso: session.date,
              spotKey: session.spot_id, shoreOrBoat: null, sessionDurationMinutes: null,
              outcomeKnown: true, fangJa: count > 0, catchCountMefo: count,
            });
          }
        })
        .catch((e) => UI.toast("Umweltdaten-Abruf im Hintergrund fehlgeschlagen: " + e.message, "error"));
    } }, "✓ Speichern"),
  ]);
  root.appendChild(btnRow);
}

function renderObservationForm(root) {
  root.innerHTML = "";
  const waterSel = UI.el("select", {}, []);
  FIDB.getAll("water").then((wa) => wa.forEach((w) => waterSel.appendChild(UI.el("option", { value: w.water_id }, w.name_de))));
  const textInput = UI.el("textarea", { placeholder: "z.B. Wasser klar, viel Kleinfisch gesehen" });
  const dateInput = UI.el("input", { type: "date", value: isoToday() });

  root.appendChild(UI.el("h1", {}, "👁 Beobachtung erfassen"));
  root.appendChild(UI.el("label", {}, "Gewässer")); root.appendChild(waterSel);
  root.appendChild(UI.el("label", {}, "Datum")); root.appendChild(dateInput);
  root.appendChild(UI.el("label", {}, "Beobachtung")); root.appendChild(textInput);
  root.appendChild(UI.el("div", { class: "subtext" }, "Qualitative Notiz — kein Fangbezug nötig. Wird getrennt gespeichert (Abschnitt 22) und beeinflusst kein Fangmodell direkt."));

  root.appendChild(UI.el("div", { class: "btn-row" }, [
    UI.el("button", { class: "btn btn-secondary", onclick: () => renderView() }, "Abbrechen"),
    UI.el("button", { class: "btn btn-primary", onclick: async () => {
      if (!textInput.value.trim()) { UI.toast("Bitte eine Beobachtung eintragen.", "error"); return; }
      const obs = {
        observation_id: FIDB.newId("obs"), observer: "Nils", water_id: waterSel.value, spot_id: null,
        date: dateInput.value, day_part: "unknown", text: textInput.value, category: "manuell",
        raw_transcript: textInput.value, created_at: FIDB.nowIso(),
      };
      await FIDB.put("observation", obs);
      if (window.FISync) FISync.enqueue("observation", obs.observation_id);
      UI.toast("Beobachtung gespeichert.", "success");
      STATE.view = "angeln"; renderView();
    } }, "✓ Speichern"),
  ]));
}

// ---------------------------------------------------------------------------
// PHASE 6A (Data Safety Quick Fix, 22.08.2026): Persistenz eines laufenden Trips + seiner
// GPS-Route. Siehe PHASE6A_DATA_SAFETY_IMPLEMENTATION_REPORT.md, Abschnitt "GPS-Persistenz-Design"
// fuer die Begruendung (eigener Store statt Einbettung in fishing_session).
// ---------------------------------------------------------------------------
async function persistActiveTripState() {
  const s = STATE.trip.session;
  if (!s) return;
  try {
    await FIDB.put("active_trip_state", {
      state_id: "current", session_id: s.session_id, species_target: s.species_target,
      water_id: s.water_id, spot_id: s.spot_id, shore_or_boat: s.shore_or_boat,
      start_time: s.start_time, gps_mode: STATE.trip.gpsMode, updated_at: FIDB.nowIso(),
    });
  } catch (e) { console.warn("Aktiver-Trip-Status konnte nicht gespeichert werden:", e); }
}

async function clearActiveTripState() {
  try { await FIDB.del("active_trip_state", "current"); } catch (e) { console.warn("Aktiver-Trip-Status konnte nicht geloescht werden:", e); }
}

// Persistiert die bisher aufgezeichnete Route GEDROSSELT (nicht bei jedem einzelnen GPS-Punkt, um
// die IndexedDB-Schreiblast klein zu halten, siehe Implementierungsbericht) — Aufrufer entscheiden
// selbst, wann persistiert wird (alle 5 Punkte waehrend der Aufzeichnung, IMMER beim Stoppen/
// Trip-Ende als finaler Flush).
async function persistTripTrack(sessionId, points) {
  if (!sessionId) return;
  try { await FIDB.put("trip_track", { session_id: sessionId, points: points.slice(), updated_at: FIDB.nowIso() }); }
  catch (e) { console.warn("GPS-Track konnte nicht gespeichert werden:", e); }
}

// Recovery-Ansicht: wird vom Router (renderView()) gezeigt, solange STATE.pendingRecovery gesetzt
// ist (ein bei App-Start gefundener active_trip_state-Eintrag). Kein stillschweigendes Verwerfen
// UND kein automatisches Fortsetzen — der Nutzer entscheidet explizit (Auftrag Punkt 3).
async function renderTripRecoveryScreen() {
  const root = UI.el("div", {});
  const rec = STATE.pendingRecovery;
  const [speciesRec, waterRec, trackDoc] = await Promise.all([
    FIDB.get("species", rec.species_target), FIDB.get("water", rec.water_id), FIDB.get("trip_track", rec.session_id),
  ]);
  const pointCount = trackDoc?.points?.length || 0;
  root.appendChild(UI.el("h1", {}, "⚠️ Laufender Trip gefunden"));
  root.appendChild(UI.el("div", { class: "panel" }, [
    UI.el("div", { class: "panel-label" }, "Beim letzten Schließen der App lief noch ein Trip"),
    UI.el("div", {}, `${speciesRec?.name_de || rec.species_target} · ${waterRec?.name_de || rec.water_id}${rec.spot_id ? " · " + rec.spot_id : ""}`),
    UI.el("div", { class: "subtext" }, `Gestartet: ${new Date(rec.start_time).toLocaleString("de-DE")} · ${pointCount} GPS-Punkt(e) bereits gespeichert.`),
    UI.el("div", { class: "subtext" }, "Die Routenaufzeichnung selbst muss nach dem Fortsetzen ggf. erneut gestartet werden (🔴-Button) — bereits aufgezeichnete Punkte bleiben in jedem Fall erhalten."),
    UI.el("div", { class: "btn-row", style: "margin-top:12px;" }, [
      UI.el("button", { class: "btn btn-primary", onclick: async () => {
        // v28 DATA INTEGRITY (Auftrag Teil A, Abschnitt 3): ein v27-Alt-active_trip_state OHNE
        // passende fishing_session bekommt beim expliziten "Fortsetzen" jetzt idempotent eine
        // persistente Session (Abgleich per get() VOR dem put() verhindert Duplikate bei
        // mehrfachem Fortsetzen). Existiert die Session bereits (v28-Trip), wird sie unveraendert
        // uebernommen — nichts wird hier ueberschrieben/erfunden, alle Felder stammen 1:1 aus dem
        // bereits vorhandenen, echten active_trip_state-Eintrag.
        let session = await FIDB.get("fishing_session", rec.session_id);
        if (!session) {
          session = { session_id: rec.session_id, angler: "Nils", start_time: rec.start_time,
            species_target: rec.species_target, water_id: rec.water_id, spot_id: rec.spot_id || null,
            shore_or_boat: rec.shore_or_boat || null, result_fish_count: 0, result_contact_count: 0,
            status: "in_progress", created_at: rec.start_time || FIDB.nowIso(),
            data_origin: "prospective_app_own",
            legacy_recovered: true, // Transparenzmarker (v28 Abschnitt 3) — beeinflusst kein Scoring
          };
          await FIDB.put("fishing_session", session);
          if (window.FISync) FISync.enqueue("fishing_session", session.session_id);
        }
        STATE.trip.session = { ...session };
        STATE.trip.active = true;
        STATE.trip.track = trackDoc?.points ? trackDoc.points.slice() : [];
        STATE.trip.gpsMode = "off";
        STATE.trip.watchId = null;
        STATE.pendingRecovery = null;
        renderTripScreen(root);
      } }, "▶ Trip fortsetzen"),
      UI.el("button", { class: "btn btn-secondary", onclick: async () => {
        // v28 DATA INTEGRITY (Auftrag Teil A, Abschnitt 5): "Verwerfen" darf einen echten,
        // gestarteten Trip nicht mehr spurenlos verschwinden lassen. Die persistente
        // fishing_session (oder — bei einem v27-Alt-Eintrag ohne eigene Session — eine daraus jetzt
        // erstmals abgeleitete, ausschliesslich aus bereits vorhandenen echten Feldern bestehende
        // Session) bleibt bestehen und bekommt status "abandoned". KEIN Loeschen von trip_track
        // mehr (GPS-Route bleibt als session-verknuepftes Datum erhalten) — nur der
        // active_trip_state-Zeiger (reiner Recovery-Hinweis, keine eigenen Nutzdaten) wird geleert.
        const abandonedAt = FIDB.nowIso();
        let session = await FIDB.get("fishing_session", rec.session_id);
        if (session) {
          session.status = "abandoned";
          session.abandoned_at = abandonedAt;
        } else {
          session = { session_id: rec.session_id, angler: "Nils", start_time: rec.start_time,
            species_target: rec.species_target, water_id: rec.water_id, spot_id: rec.spot_id || null,
            shore_or_boat: rec.shore_or_boat || null, result_fish_count: 0, result_contact_count: 0,
            status: "abandoned", abandoned_at: abandonedAt, outcome_known: false,
            created_at: rec.start_time || abandonedAt, data_origin: "prospective_app_own",
            legacy_recovered: true,
          };
        }
        await FIDB.put("fishing_session", session);
        if (window.FISync) FISync.enqueue("fishing_session", session.session_id);
        await clearActiveTripState();
        STATE.pendingRecovery = null;
        UI.toast("Trip als verworfen markiert. Bereits erfasste Daten (Route, Start) bleiben erhalten — sichtbar unter Insights → Data Integrity (?hidebug=1).", "success");
        renderView();
      } }, "✕ Verwerfen"),
    ]),
  ]));
  return root;
}

// ---------------------------------------------------------------------------
// Trip-Modus (Abschnitt 28-32) — GPS strikt opt-in
// ---------------------------------------------------------------------------
function renderTripScreen(root) {
  root.innerHTML = "";
  root.appendChild(UI.el("h1", {}, "🎣 Trip"));
  const gpsIndicator = UI.el("span", { class: `gps-indicator ${STATE.trip.gpsMode === "off" ? "gps-off" : "gps-active"}` },
    STATE.trip.gpsMode === "off" ? "📴 GPS aus" : STATE.trip.gpsMode === "track" ? "🔴 Routenaufzeichnung aktiv" : "📍 Einmal-Standort verwendet");
  root.appendChild(gpsIndicator);

  if (!STATE.trip.active) {
    // BUGFIX (Android-Realtest, Phase 5 Folgefix): Trip-Start hat frueher IMMER
    // water_id:"luebecker_bucht" hartkodiert und STATE.water/STATE.species nie gelesen — der
    // Spot-Selector im laufenden Trip filtert zwar korrekt nach s.water_id (siehe unten), aber
    // s.water_id war nie das tatsaechlich gewuenschte Gewaesser. Root Cause war also NICHT der
    // Spot-Filter selbst, sondern dass die Kette "Species -> Water" vor dem Spot-Filter fehlte.
    // Fix: explizite Art-/Gewaesser-Auswahl VOR Trip-Start, vorbefuellt aus dem aktuellen
    // Co-Pilot-Kontext (STATE.species/STATE.water) aber frei aenderbar — ein Trip kann eine andere
    // Art/ein anderes Gewaesser als der Co-Pilot-Tab gerade zeigt. Nutzt ausschliesslich bereits
    // vorhandene species/water-Referenzdaten (seed-data.js), keine neuen Arten/Gewaesser/Spots.
    // FOLGEFIX Runde 2 (Android-Realtest 22.08.2026, Testfall 5 auf echtem Geraet FAILED): zusaetzlich
    // zu Vorbefuellung + Lesen von .value beim Klick jetzt auch EXPLIZITE change-Listener, die die
    // getroffene Wahl in eigenen Variablen festhalten — kein Verlass mehr ausschliesslich auf
    // ".value zum Klickzeitpunkt", falls ein bestimmter WebView/Android-Rendering-Pfad die Werte
    // anders liefert als im (mit echtem Chromium getesteten) Playwright-Testlauf. TRIP_DEBUG macht
    // beide Werte live sichtbar, damit ein Geraetetest zweifelsfrei zeigen kann, ob (a) der Change
    // ueberhaupt ankommt und (b) welcher Build tatsaechlich laeuft.
    // MULTI-WATER UX FOLLOW-UP (Android-Retest 22.08.2026): "Species -> Water -> Spot" ist jetzt
    // funktional korrekt, aber fuer Meerforelle/Luebecker Bucht aus Nutzersicht ein Rueckschritt:
    // vorher (vor Runde 1) war water_id sowieso immer luebecker_bucht, aber die Kuestenspots
    // (Pelzerhaken, Sierksdorf, Weissenhaus, ...) waren im Trip-Start-Bereich zumindest im
    // nachfolgenden aktiven Trip direkt sichtbar. Jetzt zeigt der Trip-Start nur noch "Gewaesser:
    // Luebecker Bucht" OHNE die einzelnen Spots. Fix: DRITTE Ebene "Spot" bereits im Trip-Start-
    // Panel selbst ergaenzen (water_id bleibt der Gewaesser-Kontext, spot_id bleibt die konkrete
    // Angelstelle) — baut sich aus den vorhandenen seed-data.js-Spots zum jeweils gewaehlten
    // Gewaesser auf und aktualisiert sich SOFORT bei jedem Water-Wechsel (kein Reload noetig). Der
    // bestehende Spot-Selector im laufenden Trip (unten, "sonst"-Zweig) bleibt zusaetzlich
    // bestehen, um den Spot auch waehrend des Trips noch aendern zu koennen.
    // FOLGEFIX Runde 4 (Android-Realtest 22.08.2026, dritte Ebene "Spot" auf dem Geraet weiterhin
    // nicht sichtbar/leer): die Diagnosezeile war bisher hinter ?tripdebug=1 versteckt — auf einem
    // als Home-Screen-App INSTALLIERTEN PWA gibt es aber i.d.R. KEINE editierbare Adresszeile, der
    // Parameter war dort also praktisch nie erreichbar. Deshalb jetzt IMMER sichtbar (kein Flag
    // mehr noetig), mit genau den angeforderten Feldern: build_version, selected_species,
    // selected_water, spots_total_in_db, spots_matching_water, trip_start_spot_element_exists,
    // trip_start_spot_option_count. Zusaetzlich water_ids_in_db (Bonus): zeigt die tatsaechlich in
    // der IndexedDB vorkommenden water_id-Werte alter Spot-Datensaetze — falls ein Geraet noch
    // Referenzdaten aus einem sehr alten Stand haette (abweichende/fehlende water_id-Werte), waere
    // das hier sofort sichtbar. reconcileReferenceData() (seed-data.js, laeuft bei jedem App-Start)
    // gleicht genau das jetzt zusaetzlich automatisch ab.
    let chosenSpecies = null;
    let chosenWater = null;
    let chosenSpot = null;
    const tripSpeciesSel = UI.el("select", { id: "trip-start-species", onchange: (e) => { chosenSpecies = e.target.value; updateTripDebug(); } }, []);
    const tripWaterSel = UI.el("select", { id: "trip-start-water", onchange: (e) => { chosenWater = e.target.value; chosenSpot = null; rebuildTripStartSpots(); updateTripDebug(); } }, []);
    const tripSpotSel = UI.el("select", { id: "trip-start-spot", onchange: (e) => { chosenSpot = e.target.value || null; updateTripDebug(); } }, []);
    const debugLine = UI.el("div", { id: "trip-debug-info", class: "subtext", style: "margin-top:8px;font-family:monospace;white-space:pre-wrap;" }, "Diagnose laedt…");
    let allSpotsCache = null;
    function currentWaterId() { return chosenWater || tripWaterSel.value || STATE.water; }
    function rebuildTripStartSpots() {
      if (!allSpotsCache) return; // Spots noch nicht geladen — wird nach dem Laden einmal aufgerufen
      const waterId = currentWaterId();
      tripSpotSel.innerHTML = "";
      tripSpotSel.appendChild(UI.el("option", { value: "" }, "(kein bestimmter Spot)"));
      allSpotsCache.filter((sp) => sp.water_id === waterId).forEach((sp) =>
        tripSpotSel.appendChild(UI.el("option", { value: sp.spot_id }, sp.name)));
      updateTripDebug();
    }
    function updateTripDebug() {
      const waterId = currentWaterId();
      const spotsMatchingWater = allSpotsCache ? allSpotsCache.filter((sp) => sp.water_id === waterId).length : "lädt…";
      const spotsTotalInDb = allSpotsCache ? allSpotsCache.length : "lädt…";
      const distinctWaterIds = allSpotsCache ? [...new Set(allSpotsCache.map((sp) => sp.water_id))].sort().join(",") : "lädt…";
      const elementExists = document.getElementById("trip-start-spot") !== null;
      const optionCount = tripSpotSel.options ? tripSpotSel.options.length : 0;
      debugLine.textContent =
        `build_version: ${APP_BUILD}\n` +
        `selected_species: ${chosenSpecies || tripSpeciesSel.value || STATE.species}\n` +
        `selected_water: ${waterId}\n` +
        `spots_total_in_db: ${spotsTotalInDb}\n` +
        `spots_matching_water: ${spotsMatchingWater}\n` +
        `trip_start_spot_element_exists: ${elementExists ? "ja" : "nein"}\n` +
        `trip_start_spot_option_count: ${optionCount}\n` +
        `water_ids_in_db (zur Kontrolle): ${distinctWaterIds}`;
    }
    Promise.all([FIDB.getAll("species"), FIDB.getAll("water"), FIDB.getAll("spot")]).then(([sp, wa, spots]) => {
      sp.forEach((s) => tripSpeciesSel.appendChild(UI.el("option", { value: s.species_id, ...(s.species_id === STATE.species ? { selected: "selected" } : {}) }, `${speciesEmoji(s.species_id)} ${s.name_de}`)));
      wa.forEach((w) => tripWaterSel.appendChild(UI.el("option", { value: w.water_id, ...(w.water_id === STATE.water ? { selected: "selected" } : {}) }, w.name_de)));
      allSpotsCache = spots;
      rebuildTripStartSpots();
      updateTripDebug();
    }).catch((e) => { debugLine.textContent = `FEHLER beim Laden der Referenzdaten: ${e && e.message}`; });
    root.appendChild(UI.el("div", { class: "panel", style: "margin-top:14px;" }, [
      UI.el("p", {}, "Standard: KEIN GPS. Ein Trip kann vollständig ohne Standort geführt werden (Start-/Endzeit, Gewässer, Spot manuell, Köder, Fänge, Nullrunde)."),
      UI.el("label", {}, "Zielart"), tripSpeciesSel,
      UI.el("label", {}, "Gewässer"), tripWaterSel,
      UI.el("label", {}, "Spot (optional)"), tripSpotSel,
      UI.el("button", { class: "btn btn-primary", style: "margin-top:12px;", onclick: async () => {
        // v28 DATA INTEGRITY (Auftrag Teil A, Abschnitt 4): kein stilles Ueberschreiben einer
        // bereits laufenden Session. Der Router (init()/renderView()) faengt den Normalfall zwar
        // bereits ab (Recovery-Screen VOR jeder anderen Ansicht, siehe STATE.pendingRecovery), dieser
        // defensive Zweit-Check schuetzt zusaetzlich vor dem theoretischen Randfall einer zwischen
        // App-Start und Klick veraenderten active_trip_state (z.B. zweiter Tab/Fenster).
        const staleActive = await FIDB.get("active_trip_state", "current");
        if (staleActive && (!STATE.trip.session || staleActive.session_id !== STATE.trip.session.session_id)) {
          STATE.pendingRecovery = staleActive;
          UI.toast("Es läuft bereits ein anderer Trip — bitte zuerst fortsetzen oder verwerfen.", "error");
          renderView();
          return;
        }
        // Reihenfolge bewusst: zuerst der zuletzt via change-Event festgehaltene Wert, DANN erst
        // .value als Fallback (deckt den Fall ab, dass der Nutzer den Default nie angefasst hat und
        // daher nie ein change-Event feuerte), zuletzt STATE/null als letzter Fallback.
        STATE.trip.active = true;
        const nowIso = new Date().toISOString();
        STATE.trip.session = { session_id: FIDB.newId("sess"), angler: "Nils", start_time: nowIso,
          species_target: chosenSpecies || tripSpeciesSel.value || STATE.species,
          water_id: chosenWater || tripWaterSel.value || STATE.water,
          spot_id: (chosenSpot !== null ? chosenSpot : tripSpotSel.value) || null,
          shore_or_boat: null, result_fish_count: 0, result_contact_count: 0,
          // v28 DATA INTEGRITY (Auftrag Teil A, Abschnitt 2): fishing_session existiert jetzt SOFORT
          // bei Trip-Start, nicht erst bei "Trip beenden" — status durchlaeuft
          // in_progress -> completed (finalizeTripWithOutcome) bzw. -> abandoned (Verwerfen, siehe
          // renderTripRecoveryScreen). created_at bleibt ab hier fuer die gesamte Lebensdauer der
          // Session unveraendert (Erstzeitpunkt), finalizeTripWithOutcome darf ihn nie ueberschreiben.
          status: "in_progress", created_at: nowIso, data_origin: "prospective_app_own" };
        STATE.trip.track = [];
        // PHASE 6A + v28: fishing_session (jetzt bereits in_progress) UND Trip-Kontext + (leerer)
        // GPS-Track sofort persistieren, damit ein Reload direkt nach dem Start nichts verliert
        // (Auftrag Punkt 2/3, v28 Abschnitt 2/6 sinngemaess auch fuer Trips).
        await FIDB.put("fishing_session", STATE.trip.session);
        if (window.FISync) FISync.enqueue("fishing_session", STATE.trip.session.session_id);
        await persistActiveTripState();
        await persistTripTrack(STATE.trip.session.session_id, []);
        renderTripScreen(root);
      } }, "▶ Trip starten (ohne GPS)"),
      ...(debugLine ? [debugLine] : []),
    ]));
  } else {
    const s = STATE.trip.session;
    // PHASE 5 (GO-Freigabe): optionale, NICHT verpflichtende Kontextfelder Ufer/Boot + Spot —
    // dienen ausschliesslich der spaeteren Stratifizierung im Shadow-Pilot (siehe
    // PHASE5_REGIME_STATE_SHADOW_PILOT_SPEC.md, Abschnitt 6.3/7 "Methode/Platform-Confounder"),
    // fliessen NICHT in Champion oder Challenger ein. "Soweit verfügbar" — der Trip laesst sich
    // unveraendert ohne diese Angaben starten und beenden.
    const shoreBoatRow = UI.el("div", { class: "panel", style: "margin-top:14px;" }, [
      UI.el("div", { class: "panel-label" }, "Ufer/Boot (optional)"),
      UI.el("div", { class: "btn-row" }, [
        UI.el("button", { class: `btn ${s.shore_or_boat === "ufer" ? "btn-primary" : "btn-ghost"}`, onclick: () => { s.shore_or_boat = s.shore_or_boat === "ufer" ? null : "ufer"; persistActiveTripState(); renderTripScreen(root); } }, "🚶 Ufer"),
        UI.el("button", { class: `btn ${s.shore_or_boat === "boot" ? "btn-primary" : "btn-ghost"}`, onclick: () => { s.shore_or_boat = s.shore_or_boat === "boot" ? null : "boot"; persistActiveTripState(); renderTripScreen(root); } }, "🚤 Boot"),
      ]),
    ]);
    const spotSel = UI.el("select", { id: "trip-active-spot", onchange: (e) => { s.spot_id = e.target.value || null; persistActiveTripState(); } });
    spotSel.appendChild(UI.el("option", { value: "" }, "(kein bestimmter Spot)"));
    const activeDebugLine = UI.el("div", { id: "trip-debug-info", class: "subtext", style: "margin-top:8px;font-family:monospace;white-space:pre-wrap;" }, "Diagnose lädt…");
    FIDB.getAll("spot").then((spots) => {
      const matching = spots.filter((sp) => sp.water_id === s.water_id);
      matching.forEach((sp) =>
        spotSel.appendChild(UI.el("option", { value: sp.spot_id, ...(s.spot_id === sp.spot_id ? { selected: "selected" } : {}) }, sp.name)));
      activeDebugLine.textContent =
        `build_version: ${APP_BUILD}\n` +
        `selected_species: ${s.species_target}\n` +
        `selected_water: ${s.water_id}\n` +
        `spots_total_in_db: ${spots.length}\n` +
        `spots_matching_water: ${matching.length}\n` +
        `trip_start_spot_element_exists: n/a (aktiver Trip, kein Trip-Start-Panel mehr)\n` +
        `trip_start_spot_option_count: n/a — aktiver Spot-Select (#trip-active-spot) hat ${spotSel.options.length} Optionen`;
    }).catch((e) => { activeDebugLine.textContent = `FEHLER beim Laden der Spots: ${e && e.message}`; });
    const spotRow = UI.el("div", { class: "panel" }, [UI.el("div", { class: "panel-label" }, "Spot (optional)"), spotSel, activeDebugLine]);

    root.appendChild(UI.el("div", { class: "panel" }, [
      UI.el("p", {}, `Trip läuft seit ${new Date(s.start_time).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}.`),
      UI.el("button", { class: "btn btn-ghost", onclick: async () => {
        if (!navigator.geolocation) { UI.toast("Geolocation auf diesem Gerät nicht verfügbar.", "error"); return; }
        navigator.geolocation.getCurrentPosition((pos) => {
          STATE.trip.gpsMode = "single_fix";
          STATE.trip.session.gps_lat = pos.coords.latitude; STATE.trip.session.gps_lon = pos.coords.longitude;
          persistActiveTripState();
          UI.toast("Standort einmalig erfasst. GPS ist jetzt wieder aus.", "success");
          renderTripScreen(root);
        }, (err) => { UI.toast("Standort nicht verfügbar: " + err.message, "error"); }, { enableHighAccuracy: false, timeout: 8000 });
      } }, "📍 Standort jetzt verwenden (einmalig)"),
      STATE.trip.gpsMode !== "track"
        ? UI.el("button", { class: "btn btn-secondary", style: "margin-top:8px;", onclick: () => startFullTrack(root) }, "🔴 Routenaufzeichnung starten")
        : UI.el("button", { class: "btn btn-danger", style: "margin-top:8px;", onclick: () => stopFullTrack(root) }, "⏹ Routenaufzeichnung stoppen"),
      UI.el("button", { class: "btn btn-primary", style: "margin-top:16px;", onclick: () => renderTripOutcomeStep(root) }, "⏹ Trip beenden"),
    ]));
    root.appendChild(shoreBoatRow);
    root.appendChild(spotRow);
  }
  root.appendChild(UI.el("button", { class: "btn btn-ghost", style: "margin-top:16px;", onclick: () => renderView() }, "← Zurück"));
}

// PHASE 5 (GO-Freigabe 19.08.2026, Auftrag Punkt 2 "Nullrunden"): verbindliche, moeglichst
// einfache Trip-Abschlusslogik. "Trip beenden" fuehrt IMMER zuerst durch diese Outcome-Abfrage —
// eine abgeschlossene Session bekommt dadurch garantiert ein explizites Outcome (catch/no_catch),
// eine Nullrunde ist ein vollwertiger Datenpunkt, kein fehlender Wert (siehe Auftrag). Bewusst als
// eigene App-Ansicht (nicht window.confirm/prompt) — konsistent mit dem Rest der App, blockiert
// den Haupt-Thread nicht und laesst sich (Abbrechen) folgenlos verlassen.
// PHASE 6 TEIL A (Konsolidierungsfix, Master Audit Abschnitt B/O #5): vorher hartkodiert
// "Meerforelle gefangen?"/"Wie viele Meerforellen?" UNABHAENGIG von der tatsaechlich gewaehlten
// Zielart (species_target) — bei Zander/Hecht/Barsch fachlich falsch. Fix: Artname wird jetzt aus
// dem species-Store gelesen (name_de/name_de_plural, siehe seed-data.js), Fallback auf die rohe
// species_id, falls der Datensatz ausnahmsweise fehlen sollte. Reine Text-/Anzeigeaenderung, keine
// Aenderung an Speicherformat, Scoring oder Champion/Challenger/Shadow.
async function renderTripOutcomeStep(root) {
  // GPS IMMER sofort stoppen, sobald "Trip beenden" angetippt wird — NICHT erst nach Beantwortung
  // der Nullrunden-Frage (Abschnitt 31, Pflicht-Testfall: kein GPS-Tracking mehr, sobald der Nutzer
  // den Beenden-Vorgang eingeleitet hat, unabhaengig davon, wie lange die Outcome-Abfrage offen
  // bleibt). finalizeTripWithOutcome() prüft denselben watchId-Guard zusätzlich defensiv.
  if (STATE.trip.watchId !== null) { navigator.geolocation.clearWatch(STATE.trip.watchId); STATE.trip.watchId = null; }
  STATE.trip.gpsMode = "off";
  const s = STATE.trip.session;
  const speciesRec = s ? await FIDB.get("species", s.species_target) : null;
  const speciesLabel = speciesRec?.name_de || s?.species_target || "Fisch";
  root.innerHTML = "";
  root.appendChild(UI.el("h1", {}, "🎣 Trip beenden"));
  root.appendChild(UI.el("div", { class: "panel" }, [
    UI.el("div", { class: "panel-label" }, `${speciesLabel} gefangen?`),
    UI.el("div", { class: "btn-row" }, [
      UI.el("button", { class: "btn btn-primary", onclick: () => renderTripCatchCountStep(root) }, "✓ Ja"),
      UI.el("button", { class: "btn btn-secondary", onclick: () => finalizeTripWithOutcome(root, false, 0) }, "✕ Nein (Nullrunde)"),
    ]),
    UI.el("div", { class: "subtext" }, "Eine Nullrunde ist ein wichtiger Datenpunkt und wird genauso gespeichert wie ein Fang."),
  ]));
  root.appendChild(UI.el("button", { class: "btn btn-ghost", style: "margin-top:16px;", onclick: () => renderTripScreen(root) }, "← Zurück zum laufenden Trip"));
}

async function renderTripCatchCountStep(root) {
  const s = STATE.trip.session;
  const speciesRec = s ? await FIDB.get("species", s.species_target) : null;
  const speciesLabelPlural = speciesRec?.name_de_plural || speciesRec?.name_de || s?.species_target || "Fische";
  root.innerHTML = "";
  root.appendChild(UI.el("h1", {}, "🎣 Trip beenden"));
  const countInput = UI.el("input", { type: "number", min: "1", value: "1" });
  root.appendChild(UI.el("div", { class: "panel" }, [
    UI.el("div", { class: "panel-label" }, `Wie viele ${speciesLabelPlural}?`),
    countInput,
    UI.el("div", { class: "btn-row", style: "margin-top:12px;" }, [
      UI.el("button", { class: "btn btn-primary", onclick: () => finalizeTripWithOutcome(root, true, Math.max(1, parseInt(countInput.value || "1", 10))) }, "✓ Speichern"),
      UI.el("button", { class: "btn btn-secondary", onclick: () => renderTripOutcomeStep(root) }, "← Zurück"),
    ]),
  ]));
}

async function finalizeTripWithOutcome(root, caught, count) {
  // GPS IMMER sofort stoppen, unabhaengig vom bisherigen Modus (Abschnitt 31, Pflicht-Testfall).
  if (STATE.trip.watchId !== null) { navigator.geolocation.clearWatch(STATE.trip.watchId); STATE.trip.watchId = null; }
  const s = STATE.trip.session;
  s.end_time = new Date().toISOString();
  s.duration_minutes = Math.round((new Date(s.end_time) - new Date(s.start_time)) / 60000);
  s.date = isoToday();
  s.day_part = currentDayPartNow();
  s.time_precision = "exact";
  s.species_target = s.species_target || "mefo";
  s.result_fish_count = count;
  s.is_blank_trip = !caught; // Nullrunden-Konvention (Abschnitt 21) — nie leer lassen
  // PHASE 5: explizites Outcome, verbindlich (Auftrag Punkt 2) — ersetzt die bisherige implizite
  // Ableitung "is_blank_trip = result_fish_count === 0" (die nie befuellt wurde, weil es im Trip-
  // Screen bislang keine Fangerfassung gab) durch eine tatsaechlich abgefragte Antwort.
  s.outcome = caught ? "catch" : "no_catch";
  s.outcome_known = true;
  s.source_quality = "A_own_verified";
  // v28 DATA INTEGRITY (Auftrag Teil A, Abschnitt 2): s.created_at ist der ECHTE Erstzeitpunkt der
  // Session (seit Trip-Start gesetzt, siehe renderTripScreen) und darf beim Beenden NICHT mehr
  // ueberschrieben werden — das UPDATE derselben, bereits seit Trip-Start existierenden
  // fishing_session (gleiche session_id, siehe FIDB.put weiter unten) ist der ganze Punkt von
  // Abschnitt 2 ("Trip-Ende aktualisiert, erzeugt KEINE zweite Session"). Vorherige Zeile
  // "s.created_at = FIDB.nowIso()" haette bei jedem alten Trip diesen Ursprungszeitpunkt verloren.
  if (!s.created_at) s.created_at = FIDB.nowIso(); // nur Fallback fuer sehr alte, vor v28 gestartete Trips
  s.status = "completed";
  s.completed_at = FIDB.nowIso();
  s.species_specific = {};
  // PHASE 6A (Data Safety Quick Fix, 22.08.2026): Datenherkunft markieren (Auftrag Punkt 9) — ein
  // ueber diesen Trip-Flow abgeschlossener Trip ist per Definition eine eigene, prospektive
  // App-Erfassung. s.data_origin || ... schuetzt zusaetzlich fuer den (hier nicht erwarteten) Fall,
  // dass schon vorher ein Wert gesetzt wurde.
  s.data_origin = s.data_origin || "prospective_app_own";
  // GPS-Route final + vollstaendig persistieren (nicht nur den gedrosselten Zwischenstand aus
  // startFullTrack()) UND dauerhaft mit der Session verknuepfen (ueber die gemeinsame session_id im
  // trip_track-Store, siehe Implementierungsbericht) — behebt den Phase-6-Audit-Fund, dass die volle
  // Route bisher nirgends ueberlebte. Reine Zaehl-/Flag-Felder auf der Session machen die Verknuepfung
  // ohne Zusatz-Lookup sichtbar, OHNE die Route selbst in fishing_session einzubetten.
  await persistTripTrack(s.session_id, STATE.trip.track);
  // PHASE 6B (Cloud Backup): trip_track wird BEWUSST erst hier bei Trip-ENDE zur Sync-Queue
  // hinzugefuegt, nicht waehrend der laufenden Aufzeichnung (persistTripTrack() selbst bleibt
  // unveraendert und wird auch waehrend eines aktiven Trips aufgerufen) — siehe Begleitdokument
  // Abschnitt 3a/6: ein Backup-Job entsteht per Definition erst, wenn ein Datensatz abgeschlossen
  // ist ("Trip Ende -> IndexedDB -> Backup-Job", Auftrag Abschnitt 11), nicht bei jeder Zwischenstufe.
  if (window.FISync) FISync.enqueue("trip_track", s.session_id);
  s.gps_track_point_count = STATE.trip.track.length;
  s.has_gps_track = STATE.trip.track.length > 0;
  await FIDB.put("fishing_session", s);
  if (window.FISync) {
    FISync.enqueue("fishing_session", s.session_id);
    // v29 (Auftrag Abschnitt 4B — Ausfuehrungsgelegenheit "nach einem neuen lokalen Schreibvorgang"):
    // ein abgeschlossener Trip ist der bedeutsamste Einzel-Schreibvorgang der App (Session + Fang(e) +
    // GPS-Route) — ein EINMALIGER, nicht awaiteter Sync-Versuch direkt danach ist kein "aggressives
    // Polling" (Auftrag Abschnitt 4B), sondern genau die im Auftrag genannte Gelegenheit. Lokal ist
    // zu diesem Zeitpunkt (FIDB.put oben) bereits vollstaendig abgeschlossen — Local First bleibt
    // gewahrt, ein Fehlschlag hier ist folgenlos (Warteschlange bleibt bestehen, naechster Trigger).
    FISync.flushQueue().catch(() => {});
  }
  // Trip ist abgeschlossen — active_trip_state (Recovery-Zustand) wird nicht mehr gebraucht.
  await clearActiveTripState();
  UI.toast(`Trip gespeichert (${s.duration_minutes} Min., ${s.is_blank_trip ? "Nullrunde" : s.result_fish_count + " Fisch(e)"}). Umweltdaten werden im Hintergrund ergänzt…`, "success");
  const finishedSession = { ...s };
  STATE.trip = { active: false, session: null, gpsMode: "off", watchId: null, track: [] };
  STATE.view = "angeln";
  renderView();

  // Environmental Enrichment lief fuer Trips bisher NICHT (Luecke, siehe Implementierungsbericht) —
  // wird jetzt analog zu renderCatchForm() im Hintergrund nachgeholt, DANACH die Shadow-Auswertung
  // (Champion bleibt sichtbar/unveraendert, Challenger nur mitgeloggt, siehe shadow.js).
  const startTimeHHMM = new Date(finishedSession.start_time).toISOString().slice(11, 16);
  FIEnrichment.enrich(finishedSession.water_id, finishedSession.date, finishedSession.day_part, "exact", startTimeHHMM, "fishing_session", finishedSession.session_id)
    .then(async (snap) => {
      finishedSession.environmental_snapshot_id = snap.snapshot_id;
      await FIDB.put("fishing_session", finishedSession);
      if (window.FISync) FISync.enqueue("fishing_session", finishedSession.session_id);
      if (STATE.view === "angeln") renderView();
      if (window.FIShadow) {
        await window.FIShadow.recordShadowEvaluation({
          linkedEntityType: "fishing_session", linkedEntityId: finishedSession.session_id,
          species: finishedSession.species_target, waterId: finishedSession.water_id,
          snapshot: snap, dateIso: finishedSession.date,
          spotKey: finishedSession.spot_id, shoreOrBoat: finishedSession.shore_or_boat,
          sessionDurationMinutes: finishedSession.duration_minutes,
          outcomeKnown: true, fangJa: caught, catchCountMefo: count,
        });
      }
    })
    .catch((e) => UI.toast("Umweltdaten-Abruf im Hintergrund fehlgeschlagen: " + e.message, "error"));
}

function startFullTrack(root) {
  if (!navigator.geolocation) { UI.toast("Geolocation nicht verfügbar.", "error"); return; }
  STATE.trip.gpsMode = "track";
  persistActiveTripState();
  STATE.trip.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      STATE.trip.track.push({ t: Date.now(), lat: pos.coords.latitude, lon: pos.coords.longitude });
      // PHASE 6A (Data Safety Quick Fix): gedrosselte Persistenz — nicht bei jedem einzelnen Punkt
      // schreiben (IndexedDB-Schreiblast), aber regelmaessig genug, dass ein Reload waehrend der
      // laufenden Aufzeichnung nur wenige, nicht alle Punkte kosten kann. Finaler Flush passiert in
      // jedem Fall in stopFullTrack()/finalizeTripWithOutcome().
      if (STATE.trip.track.length % 5 === 0 && STATE.trip.session) {
        persistTripTrack(STATE.trip.session.session_id, STATE.trip.track);
      }
    },
    (err) => UI.toast("GPS-Fehler: " + err.message, "error"),
    { enableHighAccuracy: true }
  );
  renderTripScreen(root);
}

function stopFullTrack(root) {
  if (STATE.trip.watchId !== null) { navigator.geolocation.clearWatch(STATE.trip.watchId); STATE.trip.watchId = null; }
  STATE.trip.gpsMode = "off";
  // Finaler Flush: stellt sicher, dass auch die letzten (seit dem letzten 5er-Schritt noch nicht
  // gedrosselt gespeicherten) Punkte nicht verloren gehen.
  if (STATE.trip.session) persistTripTrack(STATE.trip.session.session_id, STATE.trip.track);
  persistActiveTripState();
  renderTripScreen(root);
}

// (endTrip() wurde in Phase 5 durch renderTripOutcomeStep()/renderTripCatchCountStep()/
// finalizeTripWithOutcome() oben ersetzt — verbindliche Nullrunden-Abfrage statt stiller
// result_fish_count===0-Ableitung, siehe Kommentar dort.)

// ---------------------------------------------------------------------------
// VIEW: Intelligence (Voice-Workflow + Inbox) — höchste Priorität (Abschnitt 5)
// ---------------------------------------------------------------------------
async function viewIntelligence() {
  const root = UI.el("div", {});
  root.appendChild(UI.el("h1", {}, "🎤 Intelligence"));

  if (STATE.voice.draft) { root.appendChild(buildConfirmCard(STATE.voice.draft)); return root; }

  const micLabel = STATE.voice.finalizing ? "Verarbeite Aufnahme…" : (STATE.voice.listening ? "Aufnahme läuft — antippen zum Stoppen" : "FANGINFO SPRECHEN");
  const micBtnAttrs = { class: `big-tile ${STATE.voice.listening ? "recording" : ""} ${STATE.voice.finalizing ? "finalizing" : ""}`, onclick: () => toggleVoiceCapture() };
  if (STATE.voice.finalizing) micBtnAttrs.disabled = "true";
  const micBtn = UI.el("button", micBtnAttrs, [
    UI.el("span", { class: "big-tile-icon" }, STATE.voice.finalizing ? "…" : (STATE.voice.listening ? "⏹" : "🎤")),
    UI.el("span", {}, micLabel),
  ]);
  root.appendChild(micBtn);
  root.appendChild(UI.el("div", { class: "subtext", style: "text-align:center;margin:8px 0 16px;" },
    "Sprachaufnahme wird zur Erkennung an den Browser-/Google-Spracherkennungsdienst gesendet, nicht an unsere eigenen Server (siehe docs/STT_RESEARCH.md). Alternativ: unten Text eintippen."));

  if (STATE.voice.listening && STATE.voice.interim) {
    root.appendChild(UI.el("div", { class: "panel" }, [UI.el("div", { class: "panel-label" }, "Live-Transkript"), UI.el("p", {}, STATE.voice.interim)]));
  }

  // Runde 4 Debug-Panel (nur mit ?voicedebug=1 in der URL sichtbar) — zeigt das rohe onresult-Log
  // dieser Session als Klartext, damit es bei einem echten Geraetetest abfotografiert/abgetippt
  // werden kann. Bleibt nach STOP stehen (wird erst beim naechsten Start geleert), damit es auch
  // NACH der Aufnahme noch in Ruhe gelesen werden kann.
  if (VOICE_DEBUG && STATE.voice.debugLog.length) {
    const lines = STATE.voice.debugLog.map((e) => {
      const entries = e.entries.map((x) => `[${x.index}:${x.isFinal ? "F" : "I"} "${x.transcript}"]`).join(" ");
      return `#${e.seq} inst=${e.instanceId} resultIndex=${e.resultIndex} n=${e.resultsCount} t=${e.t}\n  ${entries}`;
    }).join("\n");
    root.appendChild(UI.el("div", { class: "panel debug-panel" }, [
      UI.el("div", { class: "panel-label" }, `🐞 Voice Debug Log (${STATE.voice.debugLog.length} Ereignisse, ?voicedebug=1)`),
      UI.el("textarea", { readonly: "true", class: "debug-log-textarea", rows: "10" }, lines),
    ]));
  }

  const textInput = UI.el("textarea", { placeholder: "…oder Fanginfo als Text eintippen (funktioniert auch offline)" });
  root.appendChild(UI.el("label", {}, "Text-Eingabe (Fallback, immer verfügbar)"));
  root.appendChild(textInput);
  root.appendChild(UI.el("button", { class: "btn btn-secondary", style: "margin:8px 0 20px;", onclick: () => {
    if (!textInput.value.trim()) return;
    runExtraction(textInput.value.trim());
  } }, "Extrahieren"));

  await renderIntelligenceInbox(root);
  return root;
}

function toggleVoiceCapture() {
  // finalizing: STOP wurde bereits gedrueckt, wir warten noch auf das vollstaendige Transkript
  // der laufenden Session -> weitere Taps ignorieren, statt eine zweite Session zu ueberlappen
  // (Race Condition aus dem Voice Reliability Loop: "Nutzer drueckt STOP waehrend Restart").
  if (STATE.voice.finalizing) return;

  if (STATE.voice.listening) {
    STATE.voice.listening = false;
    STATE.voice.finalizing = true; // Button zeigt "Verarbeite Aufnahme..." bis onSessionEnd feuert
    renderView();
    STATE.voice.provider?.stop(); // fuehrt spaeter (async) zu onSessionEnd unten
    return;
  }
  if (!STATE.voice.provider) STATE.voice.provider = new FISpeech.BrowserSpeechToTextProvider();
  if (!STATE.voice.provider.isAvailable()) { UI.toast("Spracherkennung auf diesem Gerät/Browser nicht verfügbar — bitte Text eintippen.", "error"); return; }
  STATE.voice.listening = true; STATE.voice.finalizing = false; STATE.voice.interim = ""; STATE.voice.debugLog = [];
  renderView();
  STATE.voice.provider.start(
    (interim) => { STATE.voice.interim = interim; if (STATE.view === "intelligence") renderView(); },
    // onSessionEnd: feuert GENAU EINMAL pro Session, mit dem UEBER DIE GESAMTE Aufnahme
    // akkumulierten Transkript (nicht nur dem ersten Fragment) - siehe speech.js.
    (fullText) => {
      STATE.voice.listening = false;
      STATE.voice.finalizing = false;
      if (fullText) runExtraction(fullText);
      else { UI.toast("Keine Sprache erkannt. Bitte nochmal versuchen oder Text eintippen.", "error"); renderView(); }
    },
    (errMsg) => { UI.toast(errMsg, "error"); if (STATE.view === "intelligence") renderView(); },
    // onDebug (Runde 4, nur bei ?voicedebug=1 ueberhaupt sichtbar - siehe viewIntelligence oben):
    // rohes onresult-Ereignis, wird laufend gesammelt, damit ein echter Geraetetest das tatsaechliche
    // Android-Verhalten dokumentieren kann, falls die Merge-Logik doch noch einen Fall uebersieht.
    VOICE_DEBUG ? (entry) => { STATE.voice.debugLog.push(entry); if (STATE.view === "intelligence") renderView(); } : undefined
  );
}

// USER VOCABULARY lernen (Abschnitt 8/9): wird aufgerufen, wenn ein Fuzzy-Match (z.B. "Blies
// Dorf" -> Spot 'bliesdorf') vom Nutzer implizit (SPEICHERN) oder explizit (BEARBEITEN) bestaetigt
// wurde. Speichert NUR die eine konkrete Zuordnung, keine Heuristik/kein Scoring - bewusst simpel
// (Abschnitt 8: "noch keine komplexe automatische Lernlogik noetig, aber vorbereiten").
async function learnSpotAlias(rawToken, spotId, waterId) {
  if (!rawToken || !spotId) return;
  const key = rawToken.toLowerCase().trim();
  if (!key || GAZ.SPOT_ALIASES[key]) return; // schon bekannt (exakt) -> nichts zu lernen
  try {
    const existing = await FIDB.getAll("user_vocabulary", "by_category", "spot");
    if (existing.some((e) => e.alias_text === key)) return; // bereits gelernt
    const entry = {
      vocab_id: FIDB.newId("vocab"), category: "spot", alias_text: key,
      resolved_spot_id: spotId, resolved_water_id: waterId, created_at: FIDB.nowIso(),
      source: "user_confirmed_fuzzy_match",
    };
    await FIDB.put("user_vocabulary", entry);
    if (window.FISync) FISync.enqueue("user_vocabulary", entry.vocab_id);
    GAZ.mergeUserVocabulary([entry]); // sofort wirksam, nicht erst nach Neuladen der App
    UI.toast(`Gemerkt: "${rawToken}" bedeutet für dich künftig ${spotId}.`, "success");
  } catch (e) { console.warn("User-Vokabular konnte nicht gespeichert werden:", e); }
}

function runExtraction(text) {
  const extractor = new FIExtraction.RuleBasedExtractor();
  const draft = extractor.extract(text, todayUtcMidnight());
  STATE.voice.draft = draft;
  renderView();
}

function buildConfirmCard(draft) {
  const card = FIExtraction.confirmCard(draft);
  const wrap = UI.el("div", { class: "panel" });
  // Roh-Transkript IMMER zuerst und deutlich sichtbar (Voice Reliability Loop Runde 2, Abschnitt
  // 2): so laesst sich bei jedem Test sofort trennen, ob ein Fehler von der Spracherkennung
  // (falscher Text hier) oder von der Extraktion (richtiger Text, falsches Feld unten) kommt.
  wrap.appendChild(UI.el("div", { class: "panel-label" }, "🎙️ Erkanntes Transkript (Rohtext, vor der Extraktion)"));
  wrap.appendChild(UI.el("p", { style: "font-style:italic;color:var(--text-dim);" }, `"${draft.rawTranscript}"`));
  wrap.appendChild(UI.el("h2", { style: "margin-top:14px;" }, card.headline));

  const rows = [
    ["📅 Datum", draft.date.value ? UI.fmtDate(draft.date.value) : "unbekannt", draft.date],
    ["🕐 Tageszeit", UI.fmtDayPart(draft.dayPart.value), draft.dayPart],
    // Anzeigename statt interner ID (Fishing Domain Vocabulary, Runde 6): "Bliesdorf" statt
    // "bliesdorf" — displayName faellt auf .value zurueck, falls (noch) kein huebscher Name
    // hinterlegt ist (siehe withDisplayName() in extractor.js).
    ["📍 Ort", (draft.spot.value ? draft.spot.displayName : draft.water.displayName) || draft.spot.value || draft.water.value || "unbekannt", draft.spot.value ? draft.spot : draft.water],
    ["🐟 Anzahl", draft.fishCount.value ?? "unbekannt/nicht quantifiziert", draft.fishCount],
    ["📏 Größe", draft.lengthCm.value ? `ca. ${draft.lengthCm.value} cm` : "keine Angabe", draft.lengthCm],
    ["🎣 Köder", [draft.lureType.value, draft.lureColor.value, draft.lureSize.value].filter(Boolean).join(" · ") || "keine Angabe", draft.lureType],
    ["🌊 Tiefe", draft.depthM.value ? `ca. ${draft.depthM.value} m` : "keine Angabe", draft.depthM],
    ["👤 Quelle", card.von ? `${card.quelle}: ${card.von}` : card.quelle, null],
  ];
  for (const [label, value, guess] of rows) {
    wrap.appendChild(UI.el("div", { class: "row", style: "border-bottom:1px solid var(--panel-border);padding:7px 0;" }, [
      UI.el("span", { style: "color:var(--text-dim);font-size:13.5px;" }, label),
      UI.el("span", { html: `${value} ${guess ? UI.precisionBadge(guess.precision) : ""}` }),
    ]));
  }
  if (card.hinweis) wrap.appendChild(UI.el("div", { class: "subtext" }, card.hinweis));
  if (draft.unresolvedNotes.length) wrap.appendChild(UI.el("div", { class: "subtext" }, draft.unresolvedNotes.join(" ")));

  wrap.appendChild(UI.el("div", { class: "btn-row" }, [
    UI.el("button", { class: "btn btn-primary", onclick: () => saveDraft(draft) }, "✓ SPEICHERN"),
    UI.el("button", { class: "btn btn-secondary", onclick: () => editDraft(draft) }, "BEARBEITEN"),
    UI.el("button", { class: "btn btn-danger", onclick: () => { STATE.voice.draft = null; renderView(); } }, "VERWERFEN"),
  ]));
  return wrap;
}

function editDraft(draft) {
  // Einfache Inline-Bearbeitung — bewusst nicht 20 Felder, nur die editierbarsten (Abschnitt 6).
  const root = ROOT(); root.innerHTML = "";
  root.appendChild(UI.el("h1", {}, "Bearbeiten"));
  const speciesInput = UI.el("input", { type: "text", value: draft.species.value || "" });
  const spotInput = UI.el("input", { type: "text", value: draft.spot.value || draft.water.value || "" });
  const countInput = UI.el("input", { type: "number", value: draft.fishCount.value ?? "" });
  const lengthInput = UI.el("input", { type: "number", value: draft.lengthCm.value ?? "" });
  root.appendChild(UI.el("label", {}, "Zielart (Kürzel: mefo/zander/hecht/barsch)")); root.appendChild(speciesInput);
  root.appendChild(UI.el("label", {}, "Spot/Gewässer")); root.appendChild(spotInput);
  if (draft.spot.fuzzy) {
    root.appendChild(UI.el("div", { class: "subtext" }, `📍 ${draft.spot.note}`));
  }
  root.appendChild(UI.el("label", {}, "Anzahl")); root.appendChild(countInput);
  root.appendChild(UI.el("label", {}, "Länge (cm)")); root.appendChild(lengthInput);
  root.appendChild(UI.el("div", { class: "btn-row" }, [
    UI.el("button", { class: "btn btn-secondary", onclick: () => renderView() }, "Abbrechen"),
    UI.el("button", { class: "btn btn-primary", onclick: () => {
      draft.species.value = speciesInput.value || null; draft.species.confidence = 1.0; draft.species.precision = "exact"; draft.species.note = "manuell korrigiert";
      draft.fishCount.value = countInput.value !== "" ? parseInt(countInput.value, 10) : null;
      draft.lengthCm.value = lengthInput.value !== "" ? parseFloat(lengthInput.value) : null;
      if (draft.lengthCm.value !== null) { draft.lengthCm.confidence = 1.0; draft.lengthCm.precision = "exact"; draft.lengthCm.note = "manuell korrigiert"; }

      // Spot/Gewaesser aus dem Textfeld aufloesen (Abschnitt 8: vorher wurde dieses Feld beim
      // Uebernehmen still ignoriert - der Nutzer konnte einen falschen Spot gar nicht korrigieren).
      // Dieselbe Gazetteer-/Fuzzy-Logik wie bei der Spracherkennung nutzen, nicht neu erfinden.
      const originalFuzzyToken = draft.spot.fuzzyRawToken; // VOR dem Ueberschreiben merken
      const typed = spotInput.value.trim();
      if (typed) {
        const [waterGuess, spotGuess] = FIExtraction.extractWaterAndSpot(typed.toLowerCase());
        if (spotGuess.value) {
          draft.spot = new FIExtraction.FieldGuess(spotGuess.value, 1.0, "exact", "manuell bestätigt/korrigiert");
          draft.water = new FIExtraction.FieldGuess(waterGuess.value, 1.0, "exact", "aus Spot erschlossen");
          if (originalFuzzyToken) learnSpotAlias(originalFuzzyToken, spotGuess.value, waterGuess.value);
        } else if (waterGuess.value) {
          draft.water = new FIExtraction.FieldGuess(waterGuess.value, 0.9, "exact", "manuell korrigiert");
          draft.spot = new FIExtraction.FieldGuess(null, 0.0, "unknown", "Kein konkreter Spot, nur Gewässer eingegeben");
        } else {
          // Nicht im Gazetteer aufloesbar — als Freitext uebernehmen, ehrlich als unsicher markiert,
          // statt so zu tun, als waere es ein bekannter Ort (keine Scheingenauigkeit).
          draft.spot = new FIExtraction.FieldGuess(null, 0.2, "unknown", `Freitext "${typed}" nicht im Spot-Gazetteer gefunden — als Rohtext vermerkt, kein GPS-Punkt erfunden.`);
          draft.spot.rawFreeText = typed;
        }
      }
      renderView();
    } }, "Übernehmen"),
  ]));
}

async function saveDraft(draft) {
  // WICHTIG: IndexedDB-Speichern wird awaited (schnell, lokal — muss abgeschlossen sein, bevor wir
  // navigieren, sonst waere ein Datenverlust bei sofortigem Tab-Wechsel denkbar). Das Environmental
  // Enrichment (potenziell viele sequentielle fetch()-Aufrufe, siehe enrichment.js) laeuft danach
  // BEWUSST NICHT awaited weiter, sondern als echter Hintergrund-Vorgang — sonst wuerde ein
  // langsames/offline Enrichment den "Speichern"-Tap gefuehlt blockieren, UND (Bug, im Sprint-2-
  // GPS/Smoke-Test gefunden) ein spaeter abgeschlossenes Enrichment wuerde den Nutzer per
  // erzwungenem renderView() zurueck auf die Intelligence-Ansicht reissen, selbst wenn er
  // laengst weiternavigiert ist. Der Hintergrund-Task aktualisiert die View nur noch, wenn der
  // Nutzer zufaellig noch/wieder auf der Intelligence-Ansicht ist.

  // Implizite Bestaetigung eines Fuzzy-Spot-Vorschlags: der Nutzer hat die Confirm-Card mit dem
  // sichtbaren "Fuzzy-Match ... Confidence: mittel"-Hinweis gesehen und direkt SPEICHERN gedrueckt,
  // statt zu korrigieren -> das werten wir als Bestaetigung und merken uns den Begriff (Abschnitt 8).
  if (draft.spot.fuzzy && draft.spot.fuzzyRawToken) {
    learnSpotAlias(draft.spot.fuzzyRawToken, draft.spot.value, draft.water.value);
  }

  const waterId = draft.water.value;
  if (draft.recordType === "observation") {
    const voiceObs = {
      observation_id: FIDB.newId("obs"), observer: "Nils", water_id: waterId, spot_id: draft.spot.value,
      date: draft.date.value, day_part: draft.dayPart.value, text: draft.rawTranscript,
      category: "sprach-erfasst", raw_transcript: draft.rawTranscript, created_at: FIDB.nowIso(),
    };
    await FIDB.put("observation", voiceObs);
    if (window.FISync) FISync.enqueue("observation", voiceObs.observation_id);
    UI.toast("Beobachtung gespeichert.", "success");
    STATE.voice.draft = null; STATE.voice.interim = ""; STATE.view = "intelligence";
    renderView();
    return;
  }

  const report = {
    report_id: FIDB.newId("rep"),
    source_type: { hearsay_report: "hearsay", direct_report: "direct_report", trip_blank: "own_manual", catch: "own_manual" }[draft.recordType] || "own_manual",
    // PHASE 6A (Data Safety Quick Fix, 22.08.2026, Auftrag Punkt 9/11): hearsay/direct_report sind
    // Meldungen UEBER einen Kontakt (Fremdbericht), nicht der eigene, vollstaendig prospektiv
    // getrackte Trip — daher external_contact_report statt prospective_app_own. Steuert u.a., ob ein
    // Shadow-Eintrag entstehen darf (siehe enrichReportInBackground() weiter unten).
    data_origin: { hearsay_report: "external_contact_report", direct_report: "external_contact_report", trip_blank: "prospective_app_own", catch: "prospective_app_own" }[draft.recordType] || "prospective_app_own",
    source_quality: FIExtraction.sourceQualityFor(draft), source_person: draft.sourcePerson,
    report_date: isoToday(), catch_date: draft.date.value, date_precision: draft.date.precision,
    day_part: draft.dayPart.value, time_precision: draft.dayPart.precision,
    species: draft.species.value, water_id: waterId, spot_id: draft.spot.value,
    spot_name_raw: !draft.spot.value ? (draft.spot.rawFreeText || draft.spot.note || null) : null,
    gps_lat: null, gps_lon: null, gps_precision: "unknown",
    fish_count: draft.fishCount.value, length_cm: draft.lengthCm.value, length_precision: draft.lengthCm.precision,
    method: null, lure_type: draft.lureType.value, lure_color: draft.lureColor.value, lure_size: draft.lureSize.value,
    depth_m: draft.depthM.value, is_blank_trip: !!draft.isBlankTrip.value, contact_count: draft.contactCount.value,
    remark: "", raw_transcript: draft.rawTranscript,
    confidence_time: draft.date.confidence, confidence_spot: draft.spot.value ? draft.spot.confidence : draft.water.confidence,
    confidence_species: draft.species.confidence, confidence_size: draft.lengthCm.confidence,
    confidence_lure: draft.lureType.confidence, confidence_environment: 0.0,
    environmental_snapshot_id: null, created_at: FIDB.nowIso(), inbox_status: "confirmed", record_type: draft.recordType,
    enrichment_pending: !!waterId,
  };
  await FIDB.put("intelligence_report", report);
  if (window.FISync) FISync.enqueue("intelligence_report", report.report_id);

  STATE.voice.draft = null; STATE.voice.interim = "";
  STATE.view = "intelligence";
  renderView();

  if (waterId) {
    UI.toast("Gespeichert. Umweltdaten werden im Hintergrund ergänzt…", "success");
    enrichReportInBackground(report, waterId, draft);
  } else {
    UI.toast("Gespeichert (kein Gewässer erkannt — Umweltdaten übersprungen).", "success");
  }
}

async function enrichReportInBackground(report, waterId, draft) {
  try {
    const snap = await FIEnrichment.enrich(waterId, draft.date.value || isoToday(), draft.dayPart.value,
      draft.dayPart.value !== "unknown" ? "approximate" : "unknown", null, "report", report.report_id);
    report.environmental_snapshot_id = snap.snapshot_id;
    report.enrichment_pending = false;
    await FIDB.put("intelligence_report", report);
    if (window.FISync) FISync.enqueue("intelligence_report", report.report_id);
    UI.toast(`Umweltdaten für "${report.species || report.record_type}"-Meldung: ${snap.status === "complete" ? "vollständig ergänzt" : snap.status}.`, snap.status === "failed" ? "" : "success");

    // PHASE 5 (GO-Freigabe): Voice/Text-Intelligence-Meldungen liefern nicht IMMER ein
    // zweifelsfrei explizites Outcome (is_blank_trip ist eine Extraktions-Vermutung, keine
    // erzwungene Abfrage wie beim Trip-Ende) — daher hier bewusst KONSERVATIV: nur als bekanntes
    // Outcome werten, wenn entweder eine Fangzahl vorliegt ODER die Meldung explizit als Nullrunde
    // erkannt wurde. Sonst wird outcome_known=false protokolliert statt eine unsichere Vermutung
    // als sicheres Outcome zu verkaufen (Spezifikation, offener Punkt K.6).
    // PHASE 6A (Auftrag Punkt 10/11): Kontaktmeldungen (external_contact_report) erzeugen KEINE
    // Shadow-Evaluation — nur vollstaendig eigene, prospektive App-Erfassungen duerfen das
    // mehrjaehrige Regime-State-Pilotprogramm speisen. shadow.js selbst bleibt unveraendert
    // (STOP-RULE) — die zusaetzliche Bedingung gilt nur an diesem einen Aufrufort.
    if (window.FIShadow && report.species === "mefo" && waterId === "luebecker_bucht" && report.data_origin === "prospective_app_own") {
      const hasExplicitOutcome = (report.fish_count !== null && report.fish_count !== undefined) || report.is_blank_trip === true;
      await window.FIShadow.recordShadowEvaluation({
        linkedEntityType: "intelligence_report", linkedEntityId: report.report_id,
        species: report.species, waterId,
        snapshot: snap, dateIso: report.catch_date,
        spotKey: report.spot_id, shoreOrBoat: null, sessionDurationMinutes: null,
        outcomeKnown: hasExplicitOutcome,
        fangJa: hasExplicitOutcome ? ((report.fish_count || 0) > 0) : null,
        catchCountMefo: hasExplicitOutcome ? (report.fish_count || 0) : null,
      });
    }
  } catch (e) {
    UI.toast("Umweltdaten-Abruf im Hintergrund fehlgeschlagen: " + e.message, "error");
  }
  if (STATE.view === "intelligence") renderView(); // nur auffrischen, wenn der Nutzer noch/wieder hier ist
}

async function renderIntelligenceInbox(root) {
  const reports = (await FIDB.getAll("intelligence_report")).sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  root.appendChild(UI.el("h2", {}, `🧠 Inbox (${reports.length})`));
  if (!reports.length) { root.appendChild(UI.el("div", { class: "empty-state" }, "Noch keine Gesprächsinformationen erfasst.")); return; }

  for (const r of reports) {
    const snap = r.environmental_snapshot_id ? await FIDB.get("environmental_snapshot", r.environmental_snapshot_id) : null;
    const enrichedCount = snap ? countEnrichedFields(snap) : 0;
    const item = UI.el("div", { class: "inbox-item" });
    item.appendChild(UI.el("div", { class: "inbox-headline" }, `${r.fish_count ?? "?"}x ${r.species || "?"} ${r.is_blank_trip ? "(Nullrunde)" : ""}`));
    item.appendChild(UI.el("div", { class: "inbox-meta" }, [
      `${r.spot_id || r.water_id || "Ort unbekannt"} · ${UI.fmtDate(r.catch_date)} · ${UI.fmtDayPart(r.day_part)}`, UI.el("br"),
      r.lure_type ? `🎣 ${r.lure_type}${r.lure_color ? " · " + r.lure_color : ""}` : "", UI.el("br"),
      `👤 Quelle: ${{ own_manual: "Eigene Meldung", direct_report: "Direktbericht", hearsay: "Hörensagen" }[r.source_type] || r.source_type}${r.source_person ? " (" + r.source_person + ")" : ""} · ${r.source_quality}`,
    ]));
    item.appendChild(UI.el("div", { class: "quality-grid" }, [
      `Zeit: ${confPct(r.confidence_time)}`, `Spot: ${confPct(r.confidence_spot)}`,
      `Fangzahl: ${confPct(r.confidence_species)}`, `Größe: ${confPct(r.confidence_size)}`,
    ].map((t) => UI.el("div", {}, t))));
    item.appendChild(UI.el("div", { style: "margin-top:8px;",
      html: snap ? `${UI.statusChip(snap.status)} ${enrichedCount} Parameter ergänzt` : UI.statusChip("pending") }));
    item.appendChild(UI.el("div", { class: "btn-row" }, [
      UI.el("button", { class: "btn btn-ghost", onclick: () => showReportDetails(r, snap) }, "Details"),
      UI.el("button", { class: "btn btn-danger", onclick: async () => { await FIDB.del("intelligence_report", r.report_id); renderView(); } }, "Löschen"),
    ]));
    root.appendChild(item);
  }
}

function confPct(v) { return v !== undefined && v !== null ? `${Math.round(v * 100)}%` : "—"; }

function countEnrichedFields(snap) {
  const keys = Object.keys(snap).filter((k) => snap[k] && typeof snap[k] === "object" && "value" in snap[k]);
  return keys.filter((k) => snap[k].value !== null && snap[k].value !== undefined).length;
}

function showReportDetails(r, snap) {
  const root = ROOT(); root.innerHTML = "";
  root.appendChild(UI.el("h1", {}, "Details"));
  root.appendChild(UI.el("div", { class: "panel" }, [
    UI.el("div", { class: "panel-label" }, "Original-Transkript"),
    UI.el("p", { style: "font-style:italic;" }, `"${r.raw_transcript}"`),
  ]));
  root.appendChild(UI.el("pre", { style: "white-space:pre-wrap;font-size:11.5px;background:var(--panel);padding:12px;border-radius:10px;overflow:auto;" }, JSON.stringify(r, null, 2)));
  if (snap) root.appendChild(UI.el("pre", { style: "white-space:pre-wrap;font-size:11.5px;background:var(--panel);padding:12px;border-radius:10px;overflow:auto;" }, JSON.stringify(snap, null, 2)));
  root.appendChild(UI.el("button", { class: "btn btn-secondary", onclick: () => { STATE.view = "intelligence"; renderView(); } }, "← Zurück"));
}

// ---------------------------------------------------------------------------
// VIEW: Gewässer
// ---------------------------------------------------------------------------
async function viewGewaesser() {
  const root = UI.el("div", {});
  root.appendChild(UI.el("h1", {}, "🗺 Gewässer"));
  const waters = await FIDB.getAll("water");
  const spots = await FIDB.getAll("spot");
  for (const w of waters) {
    const profile = FIRegistry.PROFILES[w.water_id];
    const wSpots = spots.filter((s) => s.water_id === w.water_id);
    const panel = UI.el("div", { class: "panel" }, [
      UI.el("h2", {}, w.name_de),
      UI.el("div", { class: "subtext" }, profile?.notes || ""),
      UI.el("div", { class: "row-wrap", style: "margin-top:8px;" }, [
        UI.el("span", { class: `chip ${profile?.weatherProvider ? "chip-green" : "chip-red"}` }, "Wetter"),
        UI.el("span", { class: `chip ${profile?.waterLevelProvider ? "chip-green" : "chip-red"}` }, "Pegel"),
        UI.el("span", { class: `chip ${profile?.waterTempProvider?.name?.includes("kein") ? "chip-red" : "chip-green"}` }, "Wassertemp."),
        UI.el("span", { class: `chip ${profile?.dischargeProvider ? "chip-green" : "chip-red"}` }, "Abfluss"),
        UI.el("span", { class: "chip chip-green" }, "Astro"),
      ]),
    ]);
    if (wSpots.length) {
      const list = UI.el("div", { style: "margin-top:10px;" });
      wSpots.forEach((s) => list.appendChild(UI.el("div", { class: "row", style: "padding:5px 0;border-bottom:1px solid var(--panel-border);" }, [
        s.name,
        // v28 (Auftrag Teil B, Abschnitt 15, geklaerte Produktentscheidung): fangbuch_n === null
        // (die 29 Master-Spots, siehe seed-data.js master29Spots()) heisst ehrlich "keine eigenen
        // historischen Daten fuer DIESEN Punkt" — bewusst UNTERSCHIEDEN von "wenig Daten" (ein
        // Legacy-Spot mit z.B. n=5 hat sehr wohl ein paar eigene historische Faenge, nur nicht genug
        // fuer eine belastbare Aussage). Keine erfundene historische Evidenz (Abschnitt 15).
        UI.el("span", { class: "chip" }, s.fangbuch_n === null || s.fangbuch_n === undefined ? "Keine eigenen historischen Daten" : (s.fangbuch_n >= 10 ? `n=${s.fangbuch_n}` : "wenig Daten")),
      ])));
      panel.appendChild(list);
    }
    root.appendChild(panel);
  }
  return root;
}

// ---------------------------------------------------------------------------
// VIEW: Insights (MVP/Placeholder, Architektur vorbereitet — Abschnitt 36-38)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// PHASE 6A (Data Safety Quick Fix, 22.08.2026): manuelles Backup/Restore.
// Siehe PHASE6A_DATA_SAFETY_IMPLEMENTATION_REPORT.md, Abschnitte "Backup-Schema"/"Restore-Strategie".
// ---------------------------------------------------------------------------
const BACKUP_FORMAT_VERSION = 1;
// Referenzdaten (species/water/spot) und enrichment_queue werden bewusst NICHT exportiert — beide
// sind vollstaendig reproduzierbar (Referenzdaten aus seed-data.js, enrichment_queue ist rein
// operativer Zwischenzustand), siehe Phase-6-Architekturbericht Abschnitt 3.
const BACKUP_STORES = [
  "fishing_session", "catch_event", "intelligence_report", "observation",
  "environmental_snapshot", "user_vocabulary", "shadow_evaluation", "trip_track",
];

async function buildBackupExport() {
  const stores = {};
  for (const name of BACKUP_STORES) stores[name] = await FIDB.getAll(name);
  return {
    export_format_version: BACKUP_FORMAT_VERSION,
    schema_version: FIDB.DB_VERSION,
    exported_at: FIDB.nowIso(),
    app_build: APP_BUILD,
    stores,
  };
}

function downloadBackupFile(exportObj) {
  const json = JSON.stringify(exportObj, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `fishing-intelligence-backup-${isoToday()}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Strukturvalidierung VOR jedem Schreibzugriff — lehnt eine falsche/inkompatible Datei sauber ab
// (Auftrag Punkt 6), statt irgendetwas zu schreiben oder zu raten.
function validateBackupStructure(obj) {
  const errors = [];
  if (!obj || typeof obj !== "object") { errors.push("Datei ist kein gültiges JSON-Objekt."); return { valid: false, errors }; }
  if (typeof obj.export_format_version !== "number") errors.push("Fehlendes/ungültiges Feld export_format_version.");
  else if (obj.export_format_version > BACKUP_FORMAT_VERSION) errors.push(`Backup stammt aus einer neueren App-Version (Format ${obj.export_format_version}) — diese App-Version (Format ${BACKUP_FORMAT_VERSION}) kann es nicht sicher lesen.`);
  if (!obj.stores || typeof obj.stores !== "object") errors.push("Fehlendes/ungültiges Feld stores.");
  else {
    for (const [name, arr] of Object.entries(obj.stores)) {
      if (!Array.isArray(arr)) errors.push(`stores.${name} ist keine Liste.`);
    }
  }
  return { valid: errors.length === 0, errors };
}

// Dry-Run VOR dem eigentlichen Schreiben: zeigt dem Nutzer, was gefunden wurde, bevor irgendetwas
// geschrieben wird (Auftrag Punkt 6). Unbekannte Store-Namen (aeltere/neuere Backup-Struktur) werden
// sauber uebersprungen, nicht als Fehler behandelt.
async function computeRestorePreview(obj) {
  const preview = [];
  for (const [name, arr] of Object.entries(obj.stores || {})) {
    if (!BACKUP_STORES.includes(name) || !Array.isArray(arr) || !FIDB.STORES[name]) continue;
    const keyPath = FIDB.STORES[name];
    const existing = await FIDB.getAll(name);
    const existingKeys = new Set(existing.map((e) => e[keyPath]));
    const neu = arr.filter((r) => !existingKeys.has(r[keyPath])).length;
    preview.push({ store: name, total: arr.length, neu, aktualisiert: arr.length - neu });
  }
  return preview;
}

// Eigentlicher Restore — reiner Upsert ueber die vorhandene ID (genau wie ueberall sonst in der App,
// siehe db.js put()), daher von Natur aus idempotent: doppelte IDs ueberschreiben denselben
// Datensatz statt ihn zu duplizieren. Loescht NIE bestehende Daten (kein clearAll()) und ruft KEINE
// Champion/Challenger/Shadow-Neuberechnung auf — reines Datenschreiben (Auftrag Punkt 6/10).
async function executeRestore(obj) {
  let written = 0;
  for (const [name, arr] of Object.entries(obj.stores || {})) {
    if (!BACKUP_STORES.includes(name) || !Array.isArray(arr) || !FIDB.STORES[name]) continue;
    for (const record of arr) { await FIDB.put(name, record); written++; }
  }
  return written;
}

// ---------------------------------------------------------------------------
// TEST DATA CLEANUP Sprint (03.09.2026, Baseline v26) — gezielte Loeschung einzelner, vom Nutzer
// EXPLIZIT ausgewaehlter Test-Touren (fishing_session + tatsaechlich verknuepfte Datensaetze).
// Siehe claude/PHASE_DATA_CLEANUP_IMPLEMENTATION_REPORT.md Abschnitt "Datenmodell-Audit" fuer die
// vollstaendige Herleitung. REINE Datenverwaltung — liest/aendert an keiner Stelle Champion-/HI-2B-/
// HI-2C-/WHAT-Code (Model Scope Lock, Auftrag Abschnitt 10). KEINE automatische Testdaten-Erkennung
// (Auftrag Abschnitt 4) — der Nutzer waehlt jede zu loeschende Tour einzeln aus einer vollstaendigen
// Liste seiner eigenen Touren aus.
//
// Ergebnis des Datenmodell-Audits (echte Erzeugungsstellen in diesem File + enrichment.js/shadow.js/
// sync.js gelesen, nichts angenommen):
//   - catch_event: DIREKT verknuepft ueber das Feld session_id (siehe renderCatchForm oben).
//   - trip_track: DIREKT verknuepft — der Store-KEY selbst ist die session_id (ein Dokument je
//     Session, siehe persistTripTrack()).
//   - environmental_snapshot: DIREKT verknuepft ueber linked_entity_type==="fishing_session" +
//     linked_entity_id===session_id (siehe enrichment.js enrich()) — NIE zwischen mehreren Sessions
//     geteilt, jeder enrich()-Aufruf legt einen fabrikneuen Snapshot mit eigener snapshot_id an.
//   - shadow_evaluation: DIREKT verknuepft ueber dasselbe linked_entity_type/-id-Muster (siehe
//     shadow.js recordShadowEvaluation(), nur fuer linkedEntityType "fishing_session" aufgerufen).
//   - enrichment_queue: NUR TRANSITIV verknuepft (Feld snapshot_id zeigt auf einen Snapshot, der
//     oben zur Loeschung ansteht) — kein direkter Sessionbezug, aber ein Ghost-Retry-Eintrag ohne
//     zugehoerigen Snapshot waere inkonsistent, siehe enrichment.js retryPendingQueue().
//   - sync_queue: fuer JEDEN tatsaechlich geloeschten Datensatz wird der deterministische
//     queue_key = "<store>:<id>" (sync.js) mitgeloescht, damit kein lokal geloeschter Testdatensatz
//     durch einen spaeteren FISync.flushQueue()-Lauf erneut in die Cloud geschrieben wird (Auftrag
//     Abschnitt 7). Betrifft nur die tatsaechlich cloud-gesicherten Stores (FISync.CLOUD_STORES).
//   - intelligence_report: NACHWEISLICH NICHT verknuepft — kein session_id-Feld an der einzigen
//     Erzeugungsstelle (saveDraft() oben); Voice-/Text-Meldungen sind ein eigenstaendiger
//     Erfassungspfad ("Intelligence Inbox"), unabhaengig vom Trip-/Fang-Flow. NIE geloescht.
//   - observation: NACHWEISLICH NICHT verknuepft — kein session_id-Feld an beiden Erzeugungsstellen
//     (renderObservationForm(), saveDraft()). NIE geloescht.
//   - hourly_shadow_snapshot / hourly_window_shadow_prediction / where_spot_shadow_prediction:
//     GLOBALE, orts-/datumsbasierte Forecast-Caches (keyPath id, Felder locationId/waterId/
//     speciesId/localDate — siehe hourly-intelligence.js/hourly-window-intelligence.js/
//     where-spot-intelligence.js) — an KEINER Stelle ein session_id/linked_entity_id-Feld. NIE
//     geloescht (Auftrag Abschnitt 6: "Globale Forecast-/Research-Daten NICHT loeschen").
//   - species/water/spot (Referenzdaten) und die statische Spot Intelligence Metadata
//     (spot-intelligence-data.js, kein DB-Store) — NIE angefasst.
//   - user_vocabulary, active_trip_state — unabhaengig von einzelnen abgeschlossenen Touren
//     (persoenliche Sprachkorrekturen bzw. Singleton-Zustand des GERADE laufenden Trips — eine in
//     der Bereinigungsliste angezeigte, abgeschlossene Session hat strukturell nie einen
//     zugehoerigen active_trip_state-Eintrag, siehe finalizeTripWithOutcome()). NIE angefasst.
const SESSION_CASCADE_DELETABLE_STORES = ["catch_event", "trip_track", "environmental_snapshot", "shadow_evaluation", "enrichment_queue"];

// Ermittelt (rein lesend, OHNE zu loeschen) alles, was beim Loeschen dieser fishing_session
// tatsaechlich mitentfernt wuerde — Grundlage sowohl fuer die Bestaetigungsanzeige als auch fuer den
// eigentlichen Loeschvorgang (dieselbe Funktion, damit Anzeige und Wirkung nie auseinanderlaufen).
async function buildSessionCascadePlan(sessionId) {
  const [allCatches, track, allSnapshots, allShadow, allEnrichQueue] = await Promise.all([
    FIDB.getAll("catch_event"),
    FIDB.get("trip_track", sessionId),
    FIDB.getAll("environmental_snapshot"),
    FIDB.getAll("shadow_evaluation"),
    FIDB.getAll("enrichment_queue"),
  ]);
  const catches = allCatches.filter((c) => c.session_id === sessionId);
  const snapshots = allSnapshots.filter((s) => s.linked_entity_type === "fishing_session" && s.linked_entity_id === sessionId);
  const shadowEntries = allShadow.filter((s) => s.linked_entity_type === "fishing_session" && s.linked_entity_id === sessionId);
  const snapshotIds = new Set(snapshots.map((s) => s.snapshot_id));
  const enrichQueueEntries = allEnrichQueue.filter((q) => snapshotIds.has(q.snapshot_id));

  const deletions = [{ store: "fishing_session", key: sessionId }];
  for (const c of catches) deletions.push({ store: "catch_event", key: c.catch_id });
  if (track) deletions.push({ store: "trip_track", key: sessionId });
  for (const s of snapshots) deletions.push({ store: "environmental_snapshot", key: s.snapshot_id });
  for (const s of shadowEntries) deletions.push({ store: "shadow_evaluation", key: s.shadow_id });
  for (const q of enrichQueueEntries) deletions.push({ store: "enrichment_queue", key: q.queue_id });

  // Zugehoerige pending sync_queue-Eintraege (Auftrag Abschnitt 7) — nur fuer Stores, die
  // tatsaechlich cloud-gesichert werden (FISync.CLOUD_STORES); enrichment_queue/sync_queue selbst
  // sind rein lokal und nie in der Cloud-Queue.
  const cloudStores = (window.FISync && FISync.CLOUD_STORES) || [];
  const syncQueueKeys = deletions
    .filter((d) => cloudStores.includes(d.store))
    .map((d) => `${d.store}:${d.key}`);

  return { sessionId, catches, track, snapshots, shadowEntries, enrichQueueEntries, deletions, syncQueueKeys };
}

// Fuehrt die eigentliche Loeschung durch — EINE einzige IndexedDB-Transaktion ueber alle
// betroffenen Stores (FIDB.deleteMany), dadurch nativ atomar (Auftrag Abschnitt 11: "kein teilweise
// gelöschter inkonsistenter Zustand" bei einem Fehler).
async function deleteFishingSessionCascade(sessionId) {
  const plan = await buildSessionCascadePlan(sessionId);
  // v29 (Auftrag Abschnitt 10 — Tombstones): VOR dem eigentlichen lokalen Loeschen fuer jeden
  // betroffenen Cloud-Store einen Tombstone-Queue-Eintrag anlegen (ersetzt den bisherigen normalen
  // Queue-Eintrag fuer dieselbe ID). Dadurch schreibt der naechste flushQueue()-Lauf einen
  // deleted_at-Marker auf die Cloud-Zeile, statt den Datensatz einfach unsynchronisiert zu lassen —
  // das verhindert, dass ein spaeteres "Cloud -> Lokal wiederherstellen" (Auftrag Abschnitt 7/8)
  // diese absichtlich geloeschten Testdaten unbemerkt zurueckbringt (Auftrag Abschnitt 10). Die
  // physische Cloud-Zeile bleibt dabei bestehen (siehe Hinweistext in buildCleanupSessionRow oben) —
  // nur als "geloescht" markiert, nie destruktiv entfernt (keine DELETE-Policy noetig/vorhanden).
  if (window.FISync) { try { await FISync.enqueueTombstones(plan.deletions); } catch (e) { /* lokal folgenlos, siehe sync.js */ } }
  // v29: die zugehoerigen sync_queue-Eintraege werden NICHT MEHR hier geloescht (anders als v27) —
  // enqueueTombstones() hat sie oben bereits durch Tombstone-Eintraege (op:"delete") mit demselben
  // deterministischen queue_key ERSETZT (FIDB.put ueberschreibt). Wuerden sie hier zusaetzlich
  // geloescht, wuerde genau dieser gerade geschriebene Tombstone wieder entfernt, bevor er jemals
  // synchronisiert werden konnte — der naechste flushQueue()-Lauf entfernt den Tombstone-Eintrag
  // ganz regulaer selbst, sobald er erfolgreich in die Cloud geschrieben wurde (siehe sync.js).
  await FIDB.deleteMany(plan.deletions);
  return plan;
}

const DATA_ORIGIN_LABELS_CLEANUP = {
  prospective_app_own: "Eigene App-Erfassung (prospektiv)",
  external_contact_report: "Fremdbericht (Kontakt)",
};

function pluralDe(n, sing, plur) { return `${n} ${n === 1 ? sing : plur}`; }

// Baut den Listeneintrag samt Inline-Bestaetigung fuer EINE Tour (Auftrag Abschnitt 3/5). Die
// Bestaetigung ist bewusst ein normaler App-Bildschirmbereich (kein window.confirm) — konsistent
// mit dem Rest der App (siehe Backup-Wiederherstellung oben) und robust in automatisierten Tests.
function buildCleanupSessionRow(s, water, spot, onDeleted) {
  const row = UI.el("div", { class: "inbox-item cleanup-session-row" });
  const timeLabel = s.start_time ? new Date(s.start_time).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : null;
  row.appendChild(UI.el("div", { class: "inbox-headline" }, `${UI.fmtDate(s.date)}${timeLabel ? " · " + timeLabel : ""}`));
  row.appendChild(UI.el("div", { class: "inbox-meta" }, [
    `${water?.name_de || s.water_id || "Gewässer unbekannt"}${spot ? " · " + spot.name : ""}`, UI.el("br"),
    `${s.shore_or_boat === "ufer" ? "🚶 Ufer" : s.shore_or_boat === "boot" ? "🚤 Boot" : "Ufer/Boot: —"}${typeof s.duration_minutes === "number" ? ` · Dauer: ${s.duration_minutes} Min.` : ""}`, UI.el("br"),
    `${s.is_blank_trip ? "Nullrunde" : pluralDe(s.result_fish_count ?? 0, "Fisch", "Fische")} · Herkunft: ${DATA_ORIGIN_LABELS_CLEANUP[s.data_origin] || s.data_origin || "unbekannt"}`,
  ]));
  const confirmSlot = UI.el("div", {});
  row.appendChild(UI.el("div", { class: "btn-row" }, [
    UI.el("button", { class: "btn btn-danger", onclick: async () => {
      confirmSlot.innerHTML = "";
      const plan = await buildSessionCascadePlan(s.session_id);
      const cascadeBits = [];
      if (plan.catches.length) cascadeBits.push(pluralDe(plan.catches.length, "Fangeintrag", "Fangeinträge"));
      if (plan.track) cascadeBits.push("GPS-Route");
      if (plan.snapshots.length) cascadeBits.push(pluralDe(plan.snapshots.length, "Umwelt-Snapshot", "Umwelt-Snapshots"));
      if (plan.shadowEntries.length) cascadeBits.push(pluralDe(plan.shadowEntries.length, "Shadow-Vergleichsdatensatz", "Shadow-Vergleichsdatensätze"));
      confirmSlot.appendChild(UI.el("div", { class: "uncalibrated-box cleanup-confirm-box" }, [
        UI.el("div", { class: "cleanup-confirm-headline" },
          `Tour vom ${UI.fmtDate(s.date)}${spot ? " in " + spot.name : water ? " in " + water.name_de : ""} wirklich löschen?`),
        UI.el("div", { class: "subtext" }, cascadeBits.length
          ? `Dabei werden auch alle mit dieser Tour verbundenen Datensätze gelöscht: ${cascadeBits.join(", ")}.`
          : "Für diese Tour sind keine weiteren verknüpften Datensätze vorhanden."),
        UI.el("div", { class: "subtext" }, "Dies kann nicht rückgängig gemacht werden."),
        UI.el("div", { class: "subtext" }, "Hinweis: Falls diese Tour bereits in die Cloud gesichert wurde, bleibt diese Kopie dort bestehen — diese Funktion löscht ausschließlich lokale Daten auf diesem Gerät."),
        UI.el("div", { class: "btn-row" }, [
          UI.el("button", { class: "btn btn-secondary", onclick: () => { confirmSlot.innerHTML = ""; } }, "Abbrechen"),
          UI.el("button", { class: "btn btn-danger", onclick: async (ev) => {
            ev.target.disabled = true; ev.target.textContent = "Lösche…";
            try {
              await deleteFishingSessionCascade(s.session_id);
              UI.toast("Tour und verbundene Daten gelöscht.", "success");
              onDeleted();
            } catch (e) {
              UI.toast("Löschen fehlgeschlagen: " + e.message, "error");
              ev.target.disabled = false; ev.target.textContent = "Tour endgültig löschen";
            }
          } }, "Tour endgültig löschen"),
        ]),
      ]));
    } }, "Löschen"),
  ]));
  row.appendChild(confirmSlot);
  return row;
}

async function renderTestDataCleanupList(slot) {
  slot.innerHTML = "";
  const [sessions, waters, spots] = await Promise.all([
    FIDB.getAll("fishing_session"), FIDB.getAll("water"), FIDB.getAll("spot"),
  ]);
  const waterById = Object.fromEntries(waters.map((w) => [w.water_id, w]));
  const spotById = Object.fromEntries(spots.map((sp) => [sp.spot_id, sp]));
  // Neueste zuerst (Auftrag Abschnitt 3) — created_at ist bei jeder Session gesetzt, date als
  // Fallback fuer den unwahrscheinlichen Fall eines aelteren/unvollstaendigen Datensatzes.
  sessions.sort((a, b) => (b.created_at || b.date || "").localeCompare(a.created_at || a.date || ""));

  if (!sessions.length) {
    slot.appendChild(UI.el("div", { class: "empty-state" }, "Keine eigenen Touren vorhanden."));
    return;
  }
  for (const s of sessions) {
    const water = waterById[s.water_id] || null;
    const spot = s.spot_id ? (spotById[s.spot_id] || null) : null;
    // Nach dem Loeschen wird NUR diese Liste neu gezeichnet (nicht die gesamte Insights-Ansicht) —
    // die aufgeklappte Sektion bleibt aufgeklappt und zeigt sofort den aktualisierten Bestand
    // (Auftrag Abschnitt 13: "Liste aktualisiert"), statt wieder einzuklappen.
    slot.appendChild(buildCleanupSessionRow(s, water, spot, () => { renderTestDataCleanupList(slot); }));
  }
}

// Auftrag Abschnitt 3: "Testdaten bereinigen" liegt im Datenverwaltungs-Bereich von Insights (siehe
// viewInsights()), standardmaessig eingeklappt (gleiches Interaktionsmuster wie "Details & Rohdaten"
// im Co-Pilot, .details-toggle/.details-body — Auftrag stellt keine eigene Vorgabe, dieses Muster
// ist bereits an anderer Stelle der App etabliert und getestet).
function renderTestDataCleanupSection(root) {
  const body = UI.el("div", { class: "details-body hidden" });
  const listSlot = UI.el("div", { style: "margin-top:10px;" });
  let opened = false;
  const toggle = UI.el("div", { class: "details-toggle", onclick: async () => {
    body.classList.toggle("hidden");
    if (!body.classList.contains("hidden") && !opened) { opened = true; await renderTestDataCleanupList(listSlot); }
  } }, "🧹 Testdaten bereinigen — Liste anzeigen/verbergen");
  body.appendChild(UI.el("div", { class: "subtext" },
    "Zeigt alle eigenen Touren einzeln an. Du wählst selbst aus, welche Touren gelöscht werden — es gibt keine automatische Erkennung und kein Löschen aller Daten auf einmal."));
  body.appendChild(UI.el("div", { class: "subtext" }, "Bei Bedarf vorher unter „Meine Daten sichern“ oben ein Backup erstellen."));
  body.appendChild(listSlot);
  root.appendChild(UI.el("div", { class: "panel", style: "margin-top:14px;" }, [
    UI.el("div", { class: "panel-label" }, "Datenverwaltung"),
    toggle,
    body,
  ]));
}

// PHASE 6B (Automatic Cloud Backup, 26.08.2026) / v29 (RELIABLE CLOUD BACKUP, Auftrag Abschnitt
// 6/7): Inhalt der "☁️ Cloud-Sicherung"-Kachel in Insights ("Datensicherheit"-Bereich). Rendert je
// nach Status (SDK/Login/Queue/Verifizierung) — siehe FISync.getStatus() (sync.js). Keine technische
// Sync-Konsole (Auftrag Abschnitt 6: "Do not expose technical jargon as the primary UI") — nur die
// vier erlaubten Zustaende plus Login/Logout/manueller-Sync-Button/Wiederherstellung.
async function renderCloudBackupPanel(slot) {
  slot.innerHTML = "";
  if (!window.FISync) {
    slot.appendChild(UI.el("div", { class: "subtext" }, "Cloud-Sicherung ist in diesem Build nicht verfügbar. Das manuelle Backup oben funktioniert davon unabhängig weiter."));
    return;
  }
  const status = await FISync.getStatus();

  if (!status.loggedIn) {
    slot.appendChild(UI.el("div", { class: "subtext" }, "Sichert eigene Trips, Fänge, Meldungen, Beobachtungen, Umweltdaten, Shadow-Vergleichsdaten und GPS-Routen zusätzlich automatisch in der Cloud (Supabase, EU-Region) — als zweite Kopie, falls das Handy verloren geht oder kaputt wird. Ersetzt das Backup oben nicht, ergänzt es."));
    if (!status.sdkAvailable) {
      slot.appendChild(UI.el("div", { class: "subtext" }, "⚠️ Cloud-Sicherung gerade nicht verbunden (kein Netz oder Cloud-Baustein konnte nicht geladen werden). Alle anderen Funktionen sind davon nicht betroffen."));
    }
    const emailInput = UI.el("input", { type: "email", placeholder: "deine@email.de", autocomplete: "email" });
    const msgSlot = UI.el("div", { class: "subtext" });
    slot.appendChild(UI.el("label", {}, "Anmelden per Magic Link"));
    slot.appendChild(emailInput);
    slot.appendChild(UI.el("button", { class: "btn btn-secondary", style: "margin-top:8px;", onclick: async (ev) => {
      const email = emailInput.value.trim();
      if (!email) { UI.toast("Bitte E-Mail-Adresse eingeben.", "error"); return; }
      ev.target.disabled = true; ev.target.textContent = "Sende…";
      const res = await FISync.signInWithMagicLink(email);
      ev.target.disabled = false; ev.target.textContent = "Magic Link senden";
      msgSlot.textContent = res.ok
        ? `Link gesendet an ${email} — E-Mail öffnen und Link antippen, um dich anzumelden.`
        : `Fehlgeschlagen: ${res.error}`;
    } }, "Magic Link senden"));
    slot.appendChild(msgSlot);
    return;
  }

  // v29 (Auftrag Abschnitt 6): GENAU die vier vorgegebenen, menschenlesbaren Zustaende — Reihenfolge
  // der Prüfung entspricht der im Auftrag gezeigten Priorität (nicht erreichbar > ausstehend >
  // nicht aktuell > gesichert). "Gesichert" wird NIEMALS allein daraus abgeleitet, dass die
  // Warteschlange leer ist (Auftrag Abschnitt 6, letzter Satz) — zusaetzlich muss eine tatsaechlich
  // ERFOLGREICHE Verifizierung (FISync.verifyCloudCompleteness(), Abschnitt 5) nicht laenger als 24h
  // zurueckliegen (status.verificationDue === false).
  let icon, line, sub = null;
  if (!status.online || !status.sdkAvailable) {
    icon = "❌"; line = "Cloud nicht erreichbar";
    sub = !status.online ? "Kein Netz — alle anderen Funktionen sind davon nicht betroffen." : "Cloud-Baustein konnte nicht geladen werden.";
  } else if (status.pendingCount > 0) {
    icon = "⏳"; line = "Sicherung ausstehend";
    sub = `${status.pendingCount} Datensatz${status.pendingCount === 1 ? "" : "e"} warten auf Upload`;
  } else if (status.verificationDue) {
    icon = "⚠️"; line = "Cloud-Sicherung nicht aktuell";
    sub = status.lastVerificationAt ? `Letzte erfolgreiche Prüfung: ${UI.fmtRelativeDe ? UI.fmtRelativeDe(status.lastVerificationAt) : new Date(status.lastVerificationAt).toLocaleString("de-DE")}` : "Noch nie erfolgreich geprüft.";
  } else {
    icon = "☁️"; line = "Gesichert";
    sub = `Zuletzt geprüft: ${new Date(status.lastVerificationAt).toLocaleString("de-DE")}`;
  }
  slot.appendChild(UI.el("div", {}, `${icon} ${line}`));
  if (sub) slot.appendChild(UI.el("div", { class: "subtext" }, sub));
  if (status.lastSyncAt) {
    slot.appendChild(UI.el("div", { class: "subtext" }, `Letzte Cloud-Sicherung: ${new Date(status.lastSyncAt).toLocaleString("de-DE")}`));
  }
  slot.appendChild(UI.el("div", { class: "btn-row", style: "margin-top:8px;" }, [
    UI.el("button", { class: "btn btn-secondary", onclick: async (ev) => {
      ev.target.disabled = true; ev.target.textContent = "Sichere…";
      // v29 (Auftrag Abschnitt 6): "Jetzt sichern" loest einen ECHTEN Sync- UND Verifizierungs-
      // Versuch aus (nicht nur flushQueue()) — verifyCloudCompleteness() ruft flushQueue() intern
      // bereits mit auf (siehe sync.js), daher genuegt hier ein einziger Aufruf.
      const r = await FISync.verifyCloudCompleteness();
      ev.target.disabled = false; ev.target.textContent = "Jetzt sichern";
      if (r.reason === "offline") UI.toast("Kein Netz — wird automatisch nachgeholt, sobald wieder online.", "");
      else if (r.reason === "pending_after_flush") UI.toast("Synchronisierung teilweise fehlgeschlagen, wird später erneut versucht.", "");
      else if (r.ok) UI.toast("Cloud-Sicherung geprüft und aktuell.", "success");
      else UI.toast("Prüfung fehlgeschlagen — wird später erneut versucht. Lokale Daten sind unverändert vorhanden.", "error");
      if (STATE.view === "insights") renderView();
    } }, "Jetzt sichern"),
    UI.el("button", { class: "btn btn-ghost", onclick: async (ev) => {
      await FISync.signOut();
      UI.toast("Abgemeldet. Lokale Daten sind unverändert vorhanden.", "success");
      if (STATE.view === "insights") renderView();
    } }, "Abmelden"),
  ]));

  slot.appendChild(await buildCloudRestoreSection());
}

// v29 (Auftrag Abschnitt 7/8) — "☁️ Aus Cloud wiederherstellen": standardmaessig eingeklappt
// (gleiches Muster wie "Details & Rohdaten"/"Testdaten bereinigen"), zeigt beim Aufklappen zunaechst
// NUR eine leichtgewichtige Vorschau (FISync.fetchCloudSummary(), reine Zaehlwerte, kein Download —
// Auftrag Abschnitt 8), schreibt aber ERST nach einer expliziten zweiten Bestaetigung tatsaechlich
// lokal (FISync.fetchCloudRestoreData() + computeCloudRestorePlan() + executeCloudRestore()).
const CLOUD_STORE_LABELS_DE = {
  fishing_session: "Trips", catch_event: "Fänge", intelligence_report: "Intelligence-Meldungen",
  observation: "Beobachtungen", environmental_snapshot: "Umwelt-Snapshots", user_vocabulary: "Vokabeleinträge",
  shadow_evaluation: "Shadow-Vergleichsdatensätze", trip_track: "GPS-Tracks",
};
async function buildCloudRestoreSection() {
  const wrap = UI.el("div", { style: "margin-top:12px;" });
  const body = UI.el("div", { class: "details-body hidden" });
  let opened = false;
  const toggle = UI.el("div", { class: "details-toggle", onclick: async () => {
    body.classList.toggle("hidden");
    if (!body.classList.contains("hidden") && !opened) { opened = true; await renderCloudRestorePreview(body); }
  } }, "☁️ Aus Cloud wiederherstellen — Vorschau anzeigen");
  wrap.appendChild(toggle);
  wrap.appendChild(body);
  return wrap;
}

async function renderCloudRestorePreview(body) {
  body.innerHTML = "";
  body.appendChild(UI.el("div", { class: "subtext" }, "Lade Vorschau…"));
  const summary = await FISync.fetchCloudSummary();
  body.innerHTML = "";
  if (!summary.ok) {
    const reasons = { offline: "Kein Netz.", sdk_unavailable: "Cloud-Baustein nicht verfügbar.", not_authenticated: "Nicht angemeldet." };
    body.appendChild(UI.el("div", { class: "subtext" }, reasons[summary.reason] || "Vorschau derzeit nicht verfügbar."));
    return;
  }
  body.appendChild(UI.el("div", { class: "cleanup-confirm-headline" }, "Cloud-Sicherung gefunden"));
  const list = UI.el("div", { class: "subtext" });
  for (const store of FISync.CLOUD_STORES) {
    const n = summary.perStore[store];
    list.appendChild(UI.el("div", {}, `${CLOUD_STORE_LABELS_DE[store] || store}: ${n === null ? "unbekannt" : n}`));
  }
  body.appendChild(list);
  body.appendChild(UI.el("div", { class: "subtext" }, "Bereits lokal vorhandene Datensätze (gleiche ID) werden NICHT überschrieben — nur Datensätze, die lokal fehlen, werden ergänzt. Absichtlich gelöschte Testdaten werden nicht wiederhergestellt."));
  const resultSlot = UI.el("div", {});
  body.appendChild(UI.el("div", { class: "btn-row", style: "margin-top:8px;" }, [
    UI.el("button", { class: "btn btn-danger", onclick: async (ev) => {
      ev.target.disabled = true; ev.target.textContent = "Stelle wieder her…";
      resultSlot.innerHTML = "";
      const data = await FISync.fetchCloudRestoreData();
      if (!data.ok) {
        resultSlot.appendChild(UI.el("div", { class: "subtext" }, "Wiederherstellung fehlgeschlagen: " + (data.error || data.reason)));
        ev.target.disabled = false; ev.target.textContent = "Jetzt wiederherstellen";
        return;
      }
      const localByStore = {};
      for (const store of FISync.CLOUD_STORES) localByStore[store] = await FIDB.getAll(store);
      const plan = FISync.computeCloudRestorePlan(localByStore, data.byStore);
      const result = await FISync.executeCloudRestore(plan);
      ev.target.disabled = false; ev.target.textContent = "Jetzt wiederherstellen";
      UI.toast(`Wiederherstellung abgeschlossen: ${result.written} Datensatz${result.written === 1 ? "" : "e"} ergänzt.`, "success");
      resultSlot.appendChild(UI.el("div", { class: "cleanup-confirm-headline" }, `${result.written} Datensätze ergänzt.`));
      if (STATE.view === "insights") renderView();
    } }, "Jetzt wiederherstellen"),
  ]));
  body.appendChild(resultSlot);
}

// v28 DATA INTEGRITY (Auftrag Teil A, Abschnitt 8): zentrale Status-Ableitung fuer fishing_session.
// Ein fehlendes status-Feld (jede vor v28 abgeschlossene Session, Trip ODER Quick-Log) gilt als
// implizit "completed" — vor v28 wurde eine fishing_session AUSSCHLIESSLICH beim erfolgreichen
// Abschluss angelegt (siehe Auftrag Abschnitt 1/Diagnose), ein Legacy-Datensatz OHNE status-Feld war
// also strukturell immer ein vollstaendiger Trip/Fang, nie ein "laufender"/"verworfener" Zustand.
function tripStatus(s) { return (s && s.status) || "completed"; }

// v28 DATA INTEGRITY (Auftrag Teil A, Abschnitt 9) — siehe Aufrufstelle in viewInsights(). Rein
// lesend, keine Mutation an irgendeinem Store. Zahlen bewusst nicht limitiert auf "die letzten N" bei
// den Kernlisten (Auftrag: vollstaendige Diagnose), aber defensiv mit sort() + einer harten Obergrenze
// pro Tabelle, damit ein Geraet mit sehr vielen Datensaetzen die Ansicht nicht unbrauchbar macht.
async function renderDataIntegrityDebugPanel(root, sessions, catches, abandonedSessions) {
  const [activeTripState, tripTracks] = await Promise.all([
    FIDB.get("active_trip_state", "current"), FIDB.getAll("trip_track"),
  ]);
  const sessionIds = new Set(sessions.map((s) => s.session_id));
  const orphanCatches = catches.filter((c) => c.session_id && !sessionIds.has(c.session_id));
  const trackBySession = new Map(tripTracks.map((t) => [t.session_id, t]));
  const orphanTracks = tripTracks.filter((t) => !sessionIds.has(t.session_id));

  const sortedSessions = [...sessions].sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  const MAX_ROWS = 40;

  const wrap = UI.el("div", { class: "panel", style: "margin-top:14px;" }, [
    UI.el("div", { class: "panel-label" }, "🩺 Data Integrity (Debug, ?hidebug=1 — nur lesend, Auftrag v28 Abschnitt 9)"),
    UI.el("div", { class: "subtext" }, `fishing_session gesamt: ${sessions.length} (completed: ${sessions.length - abandonedSessions.length - sessions.filter((s) => tripStatus(s) === "in_progress").length}, in_progress: ${sessions.filter((s) => tripStatus(s) === "in_progress").length}, abandoned: ${abandonedSessions.length}) · catch_event gesamt: ${catches.length} · orphan catch_events: ${orphanCatches.length} · trip_track gesamt: ${tripTracks.length} · orphan trip_track: ${orphanTracks.length}`),
    UI.el("div", { class: "subtext" }, activeTripState
      ? `active_trip_state (Singleton): session_id=${activeTripState.session_id}, water=${activeTripState.water_id}, spot=${activeTripState.spot_id || "–"}, start=${activeTripState.start_time} → fishing_session vorhanden: ${sessionIds.has(activeTripState.session_id) ? "ja" : "NEIN (v27-Alt-Eintrag, wird beim Fortsetzen/Verwerfen idempotent nachgezogen)"}`
      : "active_trip_state (Singleton): kein laufender Trip."),
  ]);

  const table = UI.el("div", { style: "margin-top:8px;font-family:monospace;font-size:11px;white-space:pre-wrap;max-height:260px;overflow:auto;border:1px solid var(--panel-border);padding:6px;" });
  table.appendChild(document.createTextNode(
    "fishing_session (neueste zuerst" + (sortedSessions.length > MAX_ROWS ? `, ${MAX_ROWS} von ${sortedSessions.length}` : "") + "):\n" +
    sortedSessions.slice(0, MAX_ROWS).map((s) => {
      const track = trackBySession.get(s.session_id);
      return `  ${s.session_id} | status=${tripStatus(s)} | start=${s.start_time || s.date || "?"} | end=${s.end_time || "–"} | species=${s.species_target || "?"} | water=${s.water_id || "?"} | spot=${s.spot_id || "–"} | fish=${s.result_fish_count ?? "?"} | track=${track ? track.points.length + "pt" : "–"}${s.legacy_recovered ? " | legacy_recovered" : ""}`;
    }).join("\n") +
    "\n\ncatch_event (neueste zuerst" + (catches.length > MAX_ROWS ? `, ${MAX_ROWS} von ${catches.length}` : "") + "):\n" +
    [...catches].sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "")).slice(0, MAX_ROWS).map((c) =>
      `  ${c.catch_id} | session_id=${c.session_id} | species=${c.species} | created_at=${c.created_at}${!sessionIds.has(c.session_id) ? " | ⚠ ORPHAN" : ""}`
    ).join("\n") +
    (orphanTracks.length ? "\n\n⚠ orphan trip_track (session_id ohne fishing_session):\n" + orphanTracks.map((t) => `  ${t.session_id} | ${t.points.length}pt`).join("\n") : "")
  ));
  wrap.appendChild(table);
  root.appendChild(wrap);
}

// v29 (Auftrag Abschnitt 14) — "Cloud Backup Diagnostics", rein lesend, nur ?hidebug=1. Nutzt
// FISync.getDiagnostics() (sync.js), das bewusst NIE SUPABASE_URL/ANON_KEY zurueckgibt.
async function renderCloudDiagnosticsDebugPanel(root) {
  const wrap = UI.el("div", { class: "panel", style: "margin-top:14px;" }, [
    UI.el("div", { class: "panel-label" }, "☁️🩺 Cloud Backup Diagnostics (Debug, ?hidebug=1, Auftrag v29 Abschnitt 14)"),
  ]);
  if (!window.FISync) {
    wrap.appendChild(UI.el("div", { class: "subtext" }, "FISync nicht geladen."));
    root.appendChild(wrap);
    return;
  }
  const d = await FISync.getDiagnostics();
  const fmt = (iso) => iso ? new Date(iso).toLocaleString("de-DE") : "–";
  const lines = [
    `APP_BUILD: ${APP_BUILD}`,
    `cloud konfiguriert: ${d.cloudConfigured ? "ja" : "nein"} | online: ${d.online ? "ja" : "nein"} | SDK geladen: ${d.sdkAvailable ? "ja" : "nein"} | angemeldet: ${d.loggedIn ? "ja" : "nein"}`,
    `pending sync_queue gesamt: ${d.pendingCount}`,
    ...Object.entries(d.pendingByStore).map(([store, c]) => `  · ${store}: ${c.upserts} Upload(s), ${c.deletes} Tombstone(s)`),
    `letzter Sync-Versuch: ${fmt(d.lastSyncAttemptAt)} | letzter ERFOLGREICHER Sync: ${fmt(d.lastSyncAt)}`,
    `letzter Verifizierungs-Versuch: ${fmt(d.lastVerificationAttemptAt)} | letzte ERFOLGREICHE Verifizierung: ${fmt(d.lastVerificationAt)} | faellig: ${d.verificationDue ? "ja (>24h)" : "nein"}`,
    d.lastVerificationResult ? `letztes Verifizierungsergebnis: ${JSON.stringify(d.lastVerificationResult)}` : "letztes Verifizierungsergebnis: –",
    "",
    "lokale Datensätze je Cloud-Store:",
    ...Object.entries(d.localCounts).map(([store, n]) => `  · ${store}: ${n}`),
    "",
    d.lastRestoreResult ? `letztes Restore-Ergebnis: ${JSON.stringify(d.lastRestoreResult)}` : "letztes Restore-Ergebnis: noch nie ausgeführt.",
  ];
  wrap.appendChild(UI.el("div", { style: "margin-top:4px;font-family:monospace;font-size:11px;white-space:pre-wrap;max-height:300px;overflow:auto;border:1px solid var(--panel-border);padding:6px;" },
    lines.join("\n")));
  root.appendChild(wrap);
}

async function viewInsights() {
  const root = UI.el("div", {});
  root.appendChild(UI.el("h1", {}, "🧠 Insights"));

  const [sessions, catches, reports, observations] = await Promise.all([
    FIDB.getAll("fishing_session"), FIDB.getAll("catch_event"), FIDB.getAll("intelligence_report"), FIDB.getAll("observation"),
  ]);
  // v28 DATA INTEGRITY (Auftrag Teil A, Abschnitt 8): "Eigene Trips" zaehlt jetzt ausschliesslich
  // ABGESCHLOSSENE Trips (status "completed"/Legacy-Fallback) — ein laufender Trip (in_progress) ist
  // kein abgeschlossener Datenpunkt und wird SEPARAT ausgewiesen statt den Hauptzaehler zu verfaelschen;
  // ein verworfener Trip (abandoned) bleibt in der Datenbank erhalten (Abschnitt 5), zaehlt aber
  // bewusst NICHT als "eigener Trip" (sichtbar nur im Data-Integrity-Debug-Panel unten,
  // ?hidebug=1, Abschnitt 9) — kein stiller Datenverlust, aber auch keine verfaelschte Statistik.
  const completedSessions = sessions.filter((s) => tripStatus(s) === "completed");
  const inProgressSessions = sessions.filter((s) => tripStatus(s) === "in_progress");
  const abandonedSessions = sessions.filter((s) => tripStatus(s) === "abandoned");
  root.appendChild(UI.el("div", { class: "panel" }, [
    UI.el("div", { class: "panel-label" }, "Datenbestand (Provenance bleibt getrennt, Abschnitt 38)"),
    UI.el("div", { class: "quality-grid" }, [
      UI.el("div", {}, `Eigene Trips: ${completedSessions.length}`), UI.el("div", {}, `Eigene Fänge: ${catches.length}`),
      UI.el("div", {}, `Intelligence-Meldungen: ${reports.length}`), UI.el("div", {}, `Beobachtungen: ${observations.length}`),
    ]),
    inProgressSessions.length ? UI.el("div", { class: "subtext", style: "margin-top:6px;" }, `🔄 Laufende Trips: ${inProgressSessions.length}`) : null,
  ]));

  // PHASE 6A (Data Safety Quick Fix): manuelles Backup/Restore — bewusst hier in "Insights" statt
  // eines eigenen Bottom-Nav-Tabs (keine Navigation-Aenderung, siehe Sprint-3-UX-Gate-Test).
  const lastBackupAt = (() => { try { return localStorage.getItem("fi_last_backup_at"); } catch (e) { return null; } })();
  root.appendChild(UI.el("div", { class: "panel", style: "margin-top:14px;" }, [
    UI.el("div", { class: "panel-label" }, "💾 Meine Daten sichern"),
    UI.el("div", { class: "subtext" }, "Sichert alle eigenen Trips, Fänge, Meldungen, Beobachtungen, Umweltdaten, Shadow-Vergleichsdaten und GPS-Routen in einer Datei. Referenzdaten (Arten/Gewässer/Spots) werden nicht mitgesichert — die kommen automatisch mit der App."),
    UI.el("div", { class: "subtext" }, "⚠️ Ein Backup schützt nur dann vor Handyverlust, wenn die Datei danach von diesem Handy heruntergeladen wird — z. B. auf den Computer, in ein Cloud-Laufwerk oder per E-Mail an dich selbst. Auf dem Handy allein liegend hilft sie nicht."),
    ...(lastBackupAt ? [UI.el("div", { class: "subtext" }, `Letzte Sicherung: ${new Date(lastBackupAt).toLocaleString("de-DE")}`)] : []),
    UI.el("button", { class: "btn btn-primary", style: "margin-top:8px;", onclick: async (ev) => {
      ev.target.disabled = true; ev.target.textContent = "Sichere…";
      try {
        const exp = await buildBackupExport();
        downloadBackupFile(exp);
        try { localStorage.setItem("fi_last_backup_at", FIDB.nowIso()); } catch (e) { /* ignorieren, rein informativ */ }
        UI.toast("Backup erstellt und heruntergeladen.", "success");
        if (STATE.view === "insights") renderView();
      } catch (e) {
        UI.toast("Backup fehlgeschlagen: " + e.message, "error");
        ev.target.disabled = false; ev.target.textContent = "💾 Meine Daten sichern";
      }
    } }, "💾 Meine Daten sichern"),
  ]));

  const restorePreviewSlot = UI.el("div", {});
  const restoreInput = UI.el("input", { type: "file", accept: "application/json,.json", style: "display:none;" });
  restoreInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    restorePreviewSlot.innerHTML = "";
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (err) {
      restorePreviewSlot.appendChild(UI.el("div", { class: "uncalibrated-box" }, "Diese Datei ist kein gültiges Backup (kein lesbares JSON). Nichts wurde verändert."));
      return;
    }
    const { valid, errors } = validateBackupStructure(parsed);
    if (!valid) {
      restorePreviewSlot.appendChild(UI.el("div", { class: "uncalibrated-box" }, "Diese Datei ist kein gültiges Fishing-Intelligence-Backup: " + errors.join(" ") + " Nichts wurde verändert."));
      return;
    }
    const preview = await computeRestorePreview(parsed);
    restorePreviewSlot.appendChild(UI.el("div", { class: "panel" }, [
      UI.el("div", { class: "panel-label" }, "Gefunden in dieser Datei"),
      ...(preview.length
        ? preview.map((p) => UI.el("div", { class: "subtext" }, `${p.store}: ${p.total} Datensätze (${p.neu} neu, ${p.aktualisiert} bereits vorhanden — werden aktualisiert, nicht dupliziert)`))
        : [UI.el("div", { class: "subtext" }, "Keine bekannten Datenstores in dieser Datei gefunden.")]),
      UI.el("div", { class: "subtext", style: "margin-top:6px;" }, `Backup vom ${parsed.exported_at ? new Date(parsed.exported_at).toLocaleString("de-DE") : "unbekanntem Zeitpunkt"}. Bestehende Daten werden NICHT gelöscht, nur ergänzt/aktualisiert.`),
      UI.el("div", { class: "btn-row", style: "margin-top:10px;" }, [
        UI.el("button", { class: "btn btn-primary", onclick: async (ev) => {
          ev.target.disabled = true; ev.target.textContent = "Stelle wieder her…";
          const written = await executeRestore(parsed);
          UI.toast(`Wiederhergestellt: ${written} Datensätze.`, "success");
          restoreInput.value = "";
          if (STATE.view === "insights") renderView();
        } }, "✓ Jetzt wiederherstellen"),
        UI.el("button", { class: "btn btn-secondary", onclick: () => { restoreInput.value = ""; restorePreviewSlot.innerHTML = ""; } }, "Abbrechen"),
      ]),
    ]));
  });
  root.appendChild(UI.el("div", { class: "panel", style: "margin-top:14px;" }, [
    UI.el("div", { class: "panel-label" }, "📥 Backup wiederherstellen"),
    UI.el("div", { class: "subtext" }, "Wählt eine zuvor gesicherte Backup-Datei aus. Bevor etwas geschrieben wird, zeigt die App genau, was gefunden wurde."),
    UI.el("button", { class: "btn btn-secondary", onclick: () => restoreInput.click() }, "Datei auswählen…"),
    restoreInput,
    restorePreviewSlot,
  ]));

  // ---------------------------------------------------------------------------
  // PHASE 6B (Automatic Cloud Backup, 26.08.2026): automatische Cloud-Sicherung (Supabase).
  // Ersetzt das manuelle JSON-Backup NICHT (Auftrag Abschnitt 15, Panel bleibt oben unveraendert)
  // — bewusst als zweiter, zusaetzlicher Baustein direkt darunter. Local First: fehlt window.FISync
  // oder das SDK, zeigt dieses Panel einfach "nicht verfügbar" an, der Rest der App bleibt
  // unberuehrt (siehe PHASE6B_CLOUD_BACKUP_VORBEREITUNG.md).
  // ---------------------------------------------------------------------------
  const cloudSlot = UI.el("div", {});
  root.appendChild(UI.el("div", { class: "panel", style: "margin-top:14px;" }, [
    UI.el("div", { class: "panel-label" }, "☁️ Cloud-Sicherung"),
    cloudSlot,
  ]));
  await renderCloudBackupPanel(cloudSlot);

  // TEST DATA CLEANUP Sprint (03.09.2026): "Testdaten bereinigen" — bewusst direkt unterhalb von
  // Backup/Restore/Cloud-Sicherung (derselbe Datenverwaltungs-/Datensicherheits-Bereich, Auftrag
  // Abschnitt 3), keine neue Bottom-Nav-Ansicht.
  renderTestDataCleanupSection(root);

  // v28 DATA INTEGRITY (Auftrag Teil A, Abschnitt 9): rein LESENDES Debug-Panel unter ?hidebug=1 —
  // KEINE Loesch-/Reparaturfunktion, ausschliesslich Diagnose. Zeigt fishing_session (id/status/
  // start/end/species/water/spot), catch_event (id/session_id/species/timestamp), orphan
  // catch_events (session_id ohne passende fishing_session), den aktuellen active_trip_state
  // (Singleton) sowie die trip_track-Beziehung (inkl. verwaister trip_track-Eintraege).
  if (HI_DEBUG) await renderDataIntegrityDebugPanel(root, sessions, catches, abandonedSessions);

  // v29 (Auftrag Abschnitt 14): rein LESENDES "Cloud Backup Diagnostics"-Panel unter ?hidebug=1.
  // Gibt bewusst NIE Zugangsdaten/Secrets zurueck (siehe FISync.getDiagnostics()).
  if (HI_DEBUG) await renderCloudDiagnosticsDebugPanel(root);

  const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  const recent = reports.filter((r) => r.catch_date && r.catch_date >= tenDaysAgo);
  const byCombo = {};
  for (const r of recent) {
    const key = `${r.species || "?"}__${r.water_id || "?"}`;
    byCombo[key] = byCombo[key] || [];
    byCombo[key].push(r);
  }
  root.appendChild(UI.el("div", { class: "panel-label" }, "🔥 Was läuft?"));
  const relevant = Object.entries(byCombo).filter(([, v]) => v.length >= 3);
  if (!relevant.length) {
    root.appendChild(UI.el("div", { class: "uncalibrated-box" }, "Noch nicht genug Daten (Mindestens 3 Meldungen zu einer Art/Gewässer-Kombination in den letzten 10 Tagen nötig) — Datenstruktur ist vorbereitet, es wird aber bewusst kein ungeprüftes Muster angezeigt."));
  } else {
    for (const [key, items] of relevant) {
      const [species, water] = key.split("__");
      const own = items.filter((i) => i.source_type === "own_manual").length;
      root.appendChild(UI.el("div", { class: "panel" }, [
        UI.el("h2", {}, `${species} · ${water}`),
        UI.el("div", { class: "subtext" }, `${items.length} relevante Informationen letzte 10 Tage (davon ${own} eigene, ${items.length - own} Gesprächsinformationen).`),
      ]));
    }
  }

  // PRODUCT FINISH SPRINT (Auftrag Abschnitt 22): "Frag meine Angeldaten" ist ein unfertiges,
  // deaktiviertes Eingabefeld — bleibt NICHT laenger prominent in der normalen UI sichtbar (das
  // waere ein sichtbar kaputtes Feature), sondern nur noch unter ?hidebug=1 als "Coming Later".
  if (HI_DEBUG) {
    root.appendChild(UI.el("div", { class: "panel-label", style: "margin-top:10px;" }, "🔎 Frag meine Angeldaten (Debug/Coming Later — vorbereitet, Sprint 3)"));
    root.appendChild(UI.el("input", { type: "text", placeholder: "z.B. „Was wissen wir über Zander in der Trave bei steigendem Pegel?“", disabled: "disabled" }));
    root.appendChild(UI.el("div", { class: "subtext" }, "Noch nicht funktional — Datenmodell/Provenance ist dafür bereits vorbereitet (getrennte Quellen, Confidence, Umweltdaten), die Auswertungslogik folgt erst nach ausreichender Datenbasis (Abschnitt 37/38)."));
  }

  // ---------------------------------------------------------------------------
  // PHASE HI-1 (Sea Trout Hourly Intelligence — Data Foundation & Shadow Infrastructure,
  // 30.08.2026): rein diagnostisches Debug-Panel, NUR sichtbar mit ?hidebug=1 (siehe HI_DEBUG oben).
  // Berechnet auf Knopfdruck EINMALIG einen HourlyEnvironment/HourlyFeatures-Snapshot fuer das
  // aktuell gewaehlte Gewaesser + "jetzt" und zeigt ihn als rohes JSON. Explizit KEINE Bewertung,
  // KEIN Score, KEINE Empfehlung — HOURLY_INTELLIGENCE_MODE bleibt "SHADOW", nichts hier ist
  // produktiv sichtbar. Auftrag Abschnitt 19 erlaubt ausdruecklich eine kleine Developer-Ausgabe.
  // ---------------------------------------------------------------------------
  if (HI_DEBUG && window.FIHourlyIntelligence) {
    const hiSlot = UI.el("div", {});
    root.appendChild(UI.el("div", { class: "panel debug-panel", style: "margin-top:14px;" }, [
      UI.el("div", { class: "panel-label" }, `🔬 Hourly Intelligence — SHADOW (${window.FIHourlyIntelligence.HI_ENGINE_VERSION})`),
      UI.el("div", { class: "subtext" }, `Nur Diagnose, ?hidebug=1. Modus: ${window.FIHourlyIntelligence.HOURLY_INTELLIGENCE_MODE} — beeinflusst Champion/Fangindex/Tiers nicht. Gewässer: ${STATE.water}.`),
      UI.el("button", { class: "btn btn-secondary", style: "margin-top:6px;", onclick: async (ev) => {
        ev.target.disabled = true; ev.target.textContent = "Berechne…";
        try {
          const snap = await window.FIHourlyIntelligence.buildAndPersistHourlyShadowSnapshot(STATE.water, new Date().toISOString());
          hiSlot.innerHTML = "";
          hiSlot.appendChild(UI.el("textarea", { readonly: "true", class: "debug-log-textarea", rows: "16" }, JSON.stringify(snap, null, 2)));
        } catch (e) {
          hiSlot.innerHTML = "";
          hiSlot.appendChild(UI.el("div", { class: "uncalibrated-box" }, `Fehler (produktive Daten unberührt): ${e.message}`));
        } finally {
          ev.target.disabled = false; ev.target.textContent = "Jetzt Shadow-Snapshot berechnen";
        }
      } }, "Jetzt Shadow-Snapshot berechnen"),
      hiSlot,
    ]));

    // -------------------------------------------------------------------------
    // PHASE HI-2A (Forecast Time Series & Spot Foundation, 31.08.2026): zweiter, ebenfalls rein
    // diagnostischer Button — loest EINEN 120h-Batch-Forecast aus (buildHourlyForecastSeries) und
    // zeigt eine kompakte Coverage-Uebersicht + 4 Beispielstunden als rohes JSON (Auftrag Abschnitt
    // 15). AUSDRUECKLICH NICHT: "beste Stunde"/"bestes Fenster"/Top-3-Spots/ein Score — nur
    // Diagnose-Zaehlung, wie viele der zurueckgegebenen Stunden je Feld einen Wert != null tragen.
    // -------------------------------------------------------------------------
    const batchSlot = UI.el("div", {});
    root.appendChild(UI.el("div", { class: "panel debug-panel", style: "margin-top:14px;" }, [
      UI.el("div", { class: "panel-label" }, `🔬 Hourly Intelligence — Batch Forecast (SHADOW, ${window.FIHourlyIntelligence.HI_ENGINE_VERSION})`),
      UI.el("div", { class: "subtext" }, `Nur Diagnose, ?hidebug=1. Loest EINEN 120h-Forecast fuer „${STATE.water}“ aus (wenige HTTP-Requests, siehe Provider-Status unten). Keine Bewertung, kein Score, kein „beste Stunde“/Top-3.`),
      UI.el("button", { class: "btn btn-secondary", style: "margin-top:6px;", onclick: async (ev) => {
        ev.target.disabled = true; ev.target.textContent = "Berechne Batch-Forecast…";
        try {
          const series = await window.FIHourlyIntelligence.buildHourlyForecastSeries(STATE.water, { horizonHours: 120 });
          const hours = series.hours;
          const n = hours.length;
          const cov = (getter) => hours.filter((h) => getter(h) !== null && getter(h) !== undefined).length;
          const coverage = {
            "Solar (solarElevationDeg)": cov((h) => h.environment.solarElevationDeg),
            "Lufttemperatur": cov((h) => h.environment.airTempC),
            "Wassertemperatur": cov((h) => h.environment.waterTempC),
            "Wind (Geschwindigkeit m/s)": cov((h) => h.environment.windSpeedMs),
            "Wellen (Höhe)": cov((h) => h.environment.waveHeightM),
            "Luftdruck": cov((h) => h.environment.pressureHpa),
            "Wasserstand (nur jetzt-nah)": cov((h) => h.environment.waterLevelCm),
          };
          const coverageLines = Object.entries(coverage).map(([label, count]) => `  ${label}: ${count}/${n}`).join("\n");
          const exampleIdx = [0, Math.min(24, n - 1), Math.min(72, n - 1), n - 1];
          const examples = [...new Set(exampleIdx)].map((i) => ({ h: i, ...hours[i] }));
          const summary = {
            generatedAt: series.generatedAt, locationId: series.locationId, startTimestamp: series.startTimestamp,
            horizonHours: series.horizonHours, stundenGesamt: n,
            // HI-2A.1: SST und Wellen haben seit dem Hotfix getrennte Provenance (getrennte
            // Requests/Modelle, siehe hourly-intelligence.js/providers.js) — beide hier sichtbar.
            waterTempSourceStatus: series.waterTempSourceStatus, waterTempModel: series.waterTempModel,
            waveSourceStatus: series.waveSourceStatus, waveModel: series.waveModel,
            requestLog: series.requestLog,
          };
          batchSlot.innerHTML = "";
          batchSlot.appendChild(UI.el("div", { class: "subtext", style: "margin-top:6px; white-space:pre-line;" },
            `Feld-Abdeckung (Werte != null von ${n} Stunden):\n${coverageLines}`));
          batchSlot.appendChild(UI.el("textarea", { readonly: "true", class: "debug-log-textarea", rows: "10" }, JSON.stringify(summary, null, 2)));
          batchSlot.appendChild(UI.el("div", { class: "subtext", style: "margin-top:6px;" }, "Beispielstunden (erste, ~+24h, ~+72h, letzte) — Rohdaten:"));
          batchSlot.appendChild(UI.el("textarea", { readonly: "true", class: "debug-log-textarea", rows: "20" }, JSON.stringify(examples, null, 2)));
        } catch (e) {
          batchSlot.innerHTML = "";
          batchSlot.appendChild(UI.el("div", { class: "uncalibrated-box" }, `Fehler (produktive Daten unberührt): ${e.message}`));
        } finally {
          ev.target.disabled = false; ev.target.textContent = "120h-Batch-Forecast berechnen";
        }
      } }, "120h-Batch-Forecast berechnen"),
      batchSlot,
    ]));

    // -------------------------------------------------------------------------
    // PHASE HI-2B (Sea Trout WHEN Shadow Engine — Hourly Opportunity & 2-3h Window Ranking,
    // 31.08.2026): dritter, ebenfalls rein diagnostischer Button — loest EINE WHEN-Analyse
    // (runWhenShadowAnalysis, intern EIN 120h-Batch-Forecast + lokale Tagesgruppierung/Fenster-
    // Ranking) aus und zeigt pro lokalem Tag das beste 3h-Fenster, Alternativen, Daily Contrast und
    // Reason Codes. AUSDRUECKLICH: SHADOW / EXPERIMENTAL / RELATIVE OPPORTUNITY — KEINE
    // Fangwahrscheinlichkeit, KEIN "%", KEINE produktive Empfehlung (Auftrag Abschnitt 28/29).
    // -------------------------------------------------------------------------
    const whenSlot = UI.el("div", {});
    root.appendChild(UI.el("div", { class: "panel debug-panel", style: "margin-top:14px;" }, [
      UI.el("div", { class: "panel-label" }, `🔬 WHEN Intelligence — SHADOW (${window.FIHourlyWindowIntelligence ? window.FIHourlyWindowIntelligence.WHEN_ENGINE_VERSION : "?"})`),
      UI.el("div", { class: "subtext" }, `Nur Diagnose, ?hidebug=1. EXPERIMENTAL. Loest EINE 120h-WHEN-Analyse fuer „${STATE.water}" aus. relativeOpportunity ist ein pro Tag normalisiertes, dimensionsloses Ranking-Signal — NICHT CATCH PROBABILITY, keine Fangwahrscheinlichkeit, kein Prozentwert.`),
      UI.el("button", { class: "btn btn-secondary", style: "margin-top:6px;", onclick: async (ev) => {
        ev.target.disabled = true; ev.target.textContent = "Berechne WHEN-Analyse…";
        try {
          const result = await window.FIHourlyWindowIntelligence.runWhenShadowAnalysis(STATE.water, { horizonHours: 120 });
          whenSlot.innerHTML = "";
          const fmtWindow = (w) => !w ? "— kein valides Fenster —" :
            `${w.startTimestamp} → ${w.endTimestamp} (${w.durationHours}h) | relativeOpportunity=${w.windowRelativeOpportunity} (SHADOW, NICHT %) | confidence=${w.confidence} | reasons=${w.reasons.join(", ")}`;
          for (const day of result.days) {
            const lines = [
              `Bestes 3h-Fenster: ${fmtWindow(day.bestWindow)}`,
              `Daily Contrast: ${day.dailyDiagnostics.dailyContrast} (rawRange=${day.dailyDiagnostics.dayRawRange}, ${day.dailyDiagnostics.validHourCount}/${day.dailyDiagnostics.totalHourCount} Stunden mit Kerndaten)`,
              day.alternativeWindows.length ? `Top-Alternativen: ${day.alternativeWindows.slice(0, 2).map(fmtWindow).join(" | ")}` : "Keine Alternativen (nicht-ueberlappend) gefunden.",
            ].join("\n");
            whenSlot.appendChild(UI.el("div", { class: "panel", style: "margin-top:8px;" }, [
              UI.el("div", { class: "panel-label" }, `📅 ${day.localDate} (Europe/Berlin)`),
              UI.el("div", { class: "subtext", style: "white-space:pre-line;" }, lines),
            ]));
          }
          whenSlot.appendChild(UI.el("div", { class: "subtext", style: "margin-top:6px;" }, "Stuendliche Rohdaten (rawOpportunity/relativeOpportunity/solarElevation/waterTemp/lightPhase) je Tag:"));
          whenSlot.appendChild(UI.el("textarea", { readonly: "true", class: "debug-log-textarea", rows: "16" },
            JSON.stringify(result.days.map((d) => ({ localDate: d.localDate, hours: d.hours })), null, 2)));
          whenSlot.appendChild(UI.el("div", { class: "subtext", style: "margin-top:6px;" }, "Forecast-Metadaten (Provider-Status, siehe HI-2A.1):"));
          whenSlot.appendChild(UI.el("textarea", { readonly: "true", class: "debug-log-textarea", rows: "6" }, JSON.stringify(result.forecastMetadata, null, 2)));
        } catch (e) {
          whenSlot.innerHTML = "";
          whenSlot.appendChild(UI.el("div", { class: "uncalibrated-box" }, `Fehler (produktive Daten unberührt): ${e.message}`));
        } finally {
          ev.target.disabled = false; ev.target.textContent = "120h WHEN-Analyse berechnen";
        }
      } }, "120h WHEN-Analyse berechnen"),
      whenSlot,
    ]));

    // -------------------------------------------------------------------------
    // PHASE HI-2C (Sea Trout WHERE Shadow Engine — Dynamic Spot Suitability & Top-3, 31.08.2026):
    // vierter, ebenfalls rein diagnostischer Button — loest EINE WHERE-Analyse
    // (runWhereShadowAnalysis, nutzt intern denselben 120h-Batch-Forecast + die bereits vorhandene
    // HI-2B-Rankingfunktion, KEIN zweiter Netzwerk-Request) aus und zeigt pro lokalem Tag das
    // beste WHEN-Fenster und die dazugehoerigen Top-3-Spots. Nur mefo x luebecker_bucht x shore
    // (Auftrag Abschnitt 3) — ein "Boot"-Toggle demonstriert bewusst den unsupported/not_applicable-
    // Pfad. AUSDRUECKLICH: SHADOW / EXPERIMENTAL / RELATIVE SPOT SUITABILITY — KEINE
    // Fangwahrscheinlichkeit, KEIN "%", KEINE historischen SPOT_STATS-Fangquoten im Score
    // (Auftrag Abschnitt 21/28/30/31/38).
    // -------------------------------------------------------------------------
    if (window.FIWhereIntelligence) {
      const whereSlot = UI.el("div", {});
      let whereFishingMode = "shore";
      const modeBtnSlot = UI.el("div", { style: "margin-top:6px;" });
      const renderModeBtns = () => {
        modeBtnSlot.innerHTML = "";
        modeBtnSlot.appendChild(UI.el("button", { class: `btn ${whereFishingMode === "shore" ? "btn-primary" : "btn-ghost"}`,
          style: "margin-right:6px;",
          onclick: () => { whereFishingMode = "shore"; renderModeBtns(); } }, "🚶 Ufer (unterstützt)"));
        modeBtnSlot.appendChild(UI.el("button", { class: `btn ${whereFishingMode === "boat" ? "btn-primary" : "btn-ghost"}`,
          onclick: () => { whereFishingMode = "boat"; renderModeBtns(); } }, "🚤 Boot (zeigt not_applicable)"));
      };
      renderModeBtns();
      root.appendChild(UI.el("div", { class: "panel debug-panel", style: "margin-top:14px;" }, [
        UI.el("div", { class: "panel-label" }, `🗺 WHERE Intelligence — SHADOW (${window.FIWhereIntelligence.WHERE_ENGINE_VERSION})`),
        UI.el("div", { class: "subtext" }, `Nur Diagnose, ?hidebug=1. EXPERIMENTAL. Loest EINE WHERE-Analyse fuer „${STATE.water}" (Art: ${STATE.species}) aus, aufbauend auf der 120h-WHEN-Analyse. relativeSuitability ist ein pro Fenster normalisiertes, dimensionsloses Ranking-Signal — NICHT CATCH PROBABILITY, keine Fangwahrscheinlichkeit, kein Prozentwert, KEINE historische Spot-Fangquote.`),
        modeBtnSlot,
        UI.el("button", { class: "btn btn-secondary", style: "margin-top:6px;", onclick: async (ev) => {
          ev.target.disabled = true; ev.target.textContent = "Berechne WHERE-Analyse…";
          try {
            const result = await window.FIWhereIntelligence.runWhereShadowAnalysis(STATE.water, STATE.species, whereFishingMode, { horizonHours: 120 });
            whereSlot.innerHTML = "";
            if (!result.supported) {
              whereSlot.appendChild(UI.el("div", { class: "uncalibrated-box" },
                `unsupported / not_applicable — ${result.reasons.join("; ")}`));
            } else {
              const fmtSpot = (s, rank) => `${rank}. ${s.spotId} | relativeSuitability=${s.relativeSuitability} (SHADOW, NICHT %) | confidence=${s.confidence} | reasons=${s.reasonCodes.join(", ")}`;
              for (const day of result.days) {
                if (!day.bestWhere) {
                  whereSlot.appendChild(UI.el("div", { class: "panel", style: "margin-top:8px;" }, [
                    UI.el("div", { class: "panel-label" }, `📅 ${day.localDate} (Europe/Berlin)`),
                    UI.el("div", { class: "subtext" }, "Kein valides WHEN-Fenster an diesem Tag — keine WHERE-Analyse möglich."),
                  ]));
                  continue;
                }
                const top3 = day.bestWhere.top3;
                const lines = [
                  `WHEN: ${day.bestWhere.startTimestamp} → ${day.bestWhere.endTimestamp} (${day.bestWhere.durationHours}h)`,
                  `Fenster-Bedingungen: Wind ${day.bestWhere.windowConditions.windSpeedMsMedian ?? "?"} m/s aus ${day.bestWhere.windowConditions.windDirectionDegCircularMean ?? "?"}°, Welle ${day.bestWhere.windowConditions.waveHeightMMedian ?? "?"} m aus ${day.bestWhere.windowConditions.waveDirectionDegCircularMean ?? "?"}° / ${day.bestWhere.windowConditions.wavePeriodSecMedian ?? "?"} s`,
                  top3.topSpots.length ? `Shadow WHERE:\n${top3.topSpots.map((s, i) => "  " + fmtSpot(s, i + 1)).join("\n")}` : "Keine rankbaren Spots (siehe unrankableSpots).",
                  `Spot Contrast: ${top3.spotContrast}`,
                  top3.unrankableSpots.length ? `Nicht rankbar: ${top3.unrankableSpots.map((s) => s.spotId).join(", ")}` : "Alle betrachteten Spots rankbar.",
                  `H3 (Summer Deep/Current Exception): ${top3.diagnostics.h3Status}`,
                ].join("\n");
                whereSlot.appendChild(UI.el("div", { class: "panel", style: "margin-top:8px;" }, [
                  UI.el("div", { class: "panel-label" }, `📅 ${day.localDate} (Europe/Berlin)`),
                  UI.el("div", { class: "subtext", style: "white-space:pre-line;" }, lines),
                ]));
              }
              whereSlot.appendChild(UI.el("div", { class: "subtext", style: "margin-top:6px;" }, "Vollständige Tagesergebnisse (physicalFeatures, biologicalRules, missingData je Spot):"));
              whereSlot.appendChild(UI.el("textarea", { readonly: "true", class: "debug-log-textarea", rows: "16" },
                JSON.stringify(result.days.map((d) => ({ localDate: d.localDate, bestWhere: d.bestWhere })), null, 2)));
              whereSlot.appendChild(UI.el("div", { class: "subtext", style: "margin-top:6px;" }, "Forecast-Metadaten:"));
              whereSlot.appendChild(UI.el("textarea", { readonly: "true", class: "debug-log-textarea", rows: "6" }, JSON.stringify(result.forecastMetadata, null, 2)));
            }
          } catch (e) {
            whereSlot.innerHTML = "";
            whereSlot.appendChild(UI.el("div", { class: "uncalibrated-box" }, `Fehler (produktive Daten unberührt): ${e.message}`));
          } finally {
            ev.target.disabled = false; ev.target.textContent = "WHERE-Analyse berechnen";
          }
        } }, "WHERE-Analyse berechnen"),
        whereSlot,
      ]));
    }

    // -------------------------------------------------------------------------
    // PHASE HI-2C.1 (Sea Trout Spot Intelligence Metadata Layer, 03.09.2026): rein diagnostischer
    // Viewer fuer die neue, reine Datenschicht js/spot-intelligence-data.js (window.
    // FISpotIntelligenceData). Zeigt AUSSCHLIESSLICH beschreibende physikalische/geografische
    // Metadaten (Geometrie/Bathymetrie/Substrat/Habitat/kuenstliche Struktur/Ufer-Zugriffsprofil/
    // Evidenz/Unknowns) fuer einen ausgewaehlten Spot als rohes JSON — KEIN Rating, KEIN Bonus,
    // KEINE Fangwahrscheinlichkeit, KEINE Empfehlung, KEIN Rang (Auftrag Abschnitt 45). Rein
    // synchron, kein Netzwerk-/DB-Zugriff, keine Interaktion mit Champion/HI-2B/HI-2C-Scoring.
    // -------------------------------------------------------------------------
    if (window.FISpotIntelligenceData) {
      const spotSlot = UI.el("div", { style: "margin-top:8px;" });
      const spotIds = window.FISpotIntelligenceData.listSpotIds();
      const renderSpot = (spotId) => {
        const spot = window.FISpotIntelligenceData.getSpotIntelligence(spotId);
        spotSlot.innerHTML = "";
        spotSlot.appendChild(UI.el("textarea", { readonly: "true", class: "debug-log-textarea", rows: "20" },
          JSON.stringify(spot, null, 2)));
      };
      const select = UI.el("select", { class: "input", onchange: (ev) => renderSpot(ev.target.value) },
        spotIds.map((id) => UI.el("option", { value: id }, `${id} — ${window.FISpotIntelligenceData.getSpotIntelligence(id).name}`))
      );
      root.appendChild(UI.el("div", { class: "panel debug-panel", style: "margin-top:14px;" }, [
        UI.el("div", { class: "panel-label" }, `🧭 Spot Intelligence Metadata (${window.FISpotIntelligenceData.SPOT_INTELLIGENCE_VERSION})`),
        UI.el("div", { class: "subtext" }, `Nur Diagnose, ?hidebug=1. scoringImpact=„${window.FISpotIntelligenceData.SPOT_INTELLIGENCE_SCORING_IMPACT}" — reine physikalische Spot-Metadaten (${spotIds.length} Spots), KEIN Rating, KEIN Bonus, KEINE Fangwahrscheinlichkeit, KEINE Empfehlung, KEIN Rang. Quelle: ${window.FISpotIntelligenceData.SPOT_INTELLIGENCE_GENERATED_FROM}.`),
        select,
        spotSlot,
      ]));
      if (spotIds.length) renderSpot(spotIds[0]);
    }
  }

  return root;
}

document.addEventListener("DOMContentLoaded", init);
