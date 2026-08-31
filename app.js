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
const APP_BUILD = "phase-hi2a1-marine-hotfix-v21-2026-08-31";

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
    if (window.FISync) FISync.flushQueue().then((r) => { if (STATE.view === "insights") renderView(); }).catch(() => {});
  });
  window.addEventListener("offline", updateOfflineBadge);
  updateOfflineBadge();

  if (navigator.onLine) {
    FIEnrichment.retryPendingQueue().then((r) => { if (r.done) UI.toast(`${r.done} Umweltdaten-Snapshot(s) nachtraeglich ergaenzt.`, "success"); });
    // PHASE 6B (Cloud Backup): stiller Sync-Versuch bei App-Start (Auftrag Abschnitt 12) — greift
    // nur, wenn SDK geladen, Netz vorhanden UND Nutzer eingeloggt ist; sonst folgenloser No-Op.
    if (window.FISync) FISync.flushQueue().then(() => { if (STATE.view === "insights") renderView(); }).catch(() => {});
  }

  renderView();
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

// SPRINT 3 — Opportunity Hero. Ersetzt die bisherigen fuenf gleichrangigen Panels (Fangchance /
// hartcodierter Top-Spot / Zeitfenster / Strategie / Bedingungen) durch: eine "Heute"-Hero-Karte
// (Spot ECHT berechnet statt hartcodiert, Zeitfenster, Label GROSS + Index nur hinter Tap, Confidence
// SEPARAT, dynamisches "Warum?"), einen "Noch besser"-Hinweis (nur wenn ein Folgetag die dokumentierte
// Schwelle ueberschreitet, siehe FIMefoModel.pickNochBesser), einen kompakten 3-5-Tage-Streifen,
// 1-2 Alternativ-Spots (echte Rangliste, siehe FIMefoModel.rankSpots), und einen eingeklappten
// "Details & Rohdaten"-Bereich fuer Strategie-Text/Rohwerte/Spot-Rangliste. Siehe
// docs/SPRINT3_UX_GATE_FINALIZATION.md fuer die vollstaendige Methodik/Begruendung.
async function buildMefoCopilotPanels() {
  const waterId = STATE.water;
  const dayPart = currentDayPartNow();
  const today = todayUtcMidnight();
  const [refLat, refLon] = FIRegistry.WATER_REFERENCE_POINTS[waterId];

  const snap = await ensureFreshSnapshot(waterId, dayPart);
  const waterPhase = await ensureWaterLevelPhase(waterId); // SPRINT 3.1 MUST

  const rankedSpots = FIMefoModel.rankSpots();
  const topSpot = rankedSpots[0] || null;
  const altSpots = rankedSpots.slice(1, 3);

  const forecast = await ensureForecastDaily(waterId, refLat, refLon, today, 5);
  const astro = new FIAstro.NOAAAstroProvider();
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
  const warumReasons = FIMefoModel.buildWarumReasons(
    today.getUTCMonth() + 1, todayEntry.wassertemp, todayEntry.tFactor, topSpot, waterLevelCandidate);

  // SPRINT 3.1 (Punkt 7): "beste Aussicht der naechsten Tage" — bewusst GETRENNT von pickNochBesser
  // (das ist nur eine SCHWELLENWERT-gebundene, deutliche Verbesserung gegenueber heute). Hier: rein
  // deskriptiv der beste Tag unter Tag+1..Tag+4, unabhaengig davon, ob er die Noch-besser-Schwelle
  // reisst — kann also auch bei insgesamt schwacher Woche der "am wenigsten schlechte" Tag sein.
  const futureDays = dayEntries.slice(1);
  const bestOutlook = futureDays.reduce((best, d) =>
    (d.index !== null && (best === null || d.index > best.index) ? d : best), null);

  const wrap = UI.el("div", {});

  // ---- HERO: HEUTE ----
  const indexReveal = UI.el("div", { class: "index-reveal hidden" },
    todayEntry.index !== null
      ? `Index ${todayEntry.index} — informativ, ersetzt nicht die Confidence. Index ≠ Fangwahrscheinlichkeit.`
      : "Index nicht berechenbar (keine aktuelle Wassertemperatur).");
  const indexToggle = UI.el("button", { class: "index-toggle-btn", onclick: (ev) => {
    indexReveal.classList.toggle("hidden");
    ev.currentTarget.textContent = indexReveal.classList.contains("hidden") ? "Index anzeigen ⓘ" : "Index ausblenden";
  } }, "Index anzeigen ⓘ");

  // SPRINT 3.1 (Punkt 5): "ca."-Zeitspanne statt exakter Minutenangabe — das Fenster ist
  // astronomisch abgeleitet (Daemmerung), nicht aus dem Fangbuch als exaktes Beissfenster
  // validiert. Exakte Werte bleiben in "Details & Rohdaten" (siehe dort).
  const heroTimeLine = todayEntry.duskWindow
    ? `Abendfenster · ca. ${fmtApproxTime(todayEntry.duskWindow.start)}–${fmtApproxTime(todayEntry.duskWindow.end)}`
    : "Zeitfenster nicht berechenbar (Umweltdaten aktualisieren)";

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

  const heroCard = UI.el("div", { class: "hero-card" }, [
    UI.el("div", { class: "hero-tag" }, "Heute"),
    UI.el("div", { class: "hero-headline" }, `${speciesEmoji("mefo")} Meerforelle`),
    UI.el("div", { class: "hero-sub" }, heroTimeLine),
    UI.el("div", { class: "hero-label-row" }, [
      UI.el("div", { class: "hero-label", style: `color:${tierColor(todayEntry.label)};` }, todayEntry.label.toUpperCase()),
    ]),
    // SPRINT 3.1 (Punkt 4): eigene Zeile statt Teil der Headline — "Staerkste historische
    // Spot-Option" macht explizit, dass das eine HISTORISCHE Kennzahl ist, keine Aussage ueber die
    // heutige Eignung des Spots (siehe rankSpots-Dokumentation).
    UI.el("div", { class: "hero-spot-line" }, `📍 Stärkste historische Spot-Option: ${topSpot ? topSpot.name : "kein historisch validierter Spot"}`),
    indexToggle, indexReveal,
    UI.el("div", { class: "confidence-row" }, [
      UI.el("span", {}, ["Confidence: ", UI.el("strong", {}, confLabelDe(todayEntry.confidenceTier))]),
      confDots(todayEntry.confidenceTier),
    ]),
    waterlevelRow,
    UI.el("div", { class: "warum-label" }, "Warum?"),
    UI.el("ul", { class: "warum-list" }, warumReasons.map((r) =>
      UI.el("li", { class: r.ok ? "" : "warum-neg" }, `${r.ok ? "✓" : "•"} ${r.text}`))),
  ]);
  wrap.appendChild(heroCard);

  // ---- NOCH BESSER (nur bei erfuellter, dokumentierter Regel — siehe pickNochBesser) ----
  if (nochBesser) {
    wrap.appendChild(UI.el("div", { class: "noch-besser-banner" }, [
      UI.el("div", { class: "noch-besser-tag" }, "🔥 Noch besser"),
      UI.el("div", { class: "noch-besser-body" }, `${weekdayLong(nochBesser.date)} · ${topSpot ? topSpot.name : "—"}`),
      UI.el("div", { class: "noch-besser-sub" }, [
        nochBesser.duskWindow ? `${fmtTime(nochBesser.duskWindow.start)} – ${fmtTime(nochBesser.duskWindow.end)} · ` : "",
        UI.el("strong", { style: `color:${tierColor(nochBesser.label)};` }, nochBesser.label.toUpperCase()),
      ]),
    ]));
  }

  // ---- NAECHSTE TAGE ----
  // SPRINT 3.1 (Punkt 7): Stern markiert den Tag mit der besten Aussicht unter Tag+1..Tag+4 — rein
  // deskriptiv, unabhaengig von der "Noch besser"-Schwelle oben (siehe bestOutlook-Berechnung).
  wrap.appendChild(UI.el("div", { class: "section-label" }, "Nächste Tage"));
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

  // ---- ALTERNATIVEN HEUTE (nur bei echtem Entscheidungswert, siehe Punkt 8) ----
  // Das Fangindex-Modell ist NICHT spot-abhaengig (nur Saison × Wassertemperatur) — alle Spots
  // teilen sich daher IMMER dasselbe Tages-Label. "Alternativen" mit demselben Label wie der Hero
  // erneut anzuzeigen, taeuscht eine Differenzierung vor, die es fachlich nicht gibt. Ist der
  // heutige Tag insgesamt schwach, ist "noch ein schwacher Spot" kein Mehrwert — stattdessen wird
  // die naechste tatsaechlich bessere Gelegenheit hervorgehoben (kein Alternativen-Panel nur, weil
  // die Daten technisch verfuegbar sind).
  // "Unbekannt" (Index nicht berechenbar, z.B. keine Wassertemperatur) gehoert ebenfalls zur
  // Gating-Bedingung: ohne heutige Bewertung wirken "Alternativen" wie eine vorgetaeuschte
  // Differenzierung — die Hero-Karte kommuniziert die fehlende Datenlage bereits ehrlich.
  const showAlternatives = todayEntry.label !== "Schwach" && todayEntry.label !== "Unbekannt" && altSpots.length > 0;
  if (showAlternatives) {
    wrap.appendChild(UI.el("div", { class: "section-label" }, "Alternativen heute"));
    wrap.appendChild(UI.el("div", { class: "alt-row" }, altSpots.map((sp) =>
      UI.el("div", { class: "alt-card" }, [
        UI.el("div", { class: "alt-name" }, sp.name),
        UI.el("div", { class: "alt-label" }, `${Math.round(sp.shrunkRate * 100)}% historisch`),
        UI.el("div", { class: "alt-conf" }, `Confidence: ${confLabelDe(sp.confidenceTier)}`),
      ])
    )));
  } else if (todayEntry.label === "Schwach") {
    const better = bestOutlook && FIMefoModel.labelRank(bestOutlook.label) > FIMefoModel.labelRank(todayEntry.label) ? bestOutlook : null;
    wrap.appendChild(UI.el("div", { class: "next-better-block" },
      better
        ? ["Heute insgesamt schwach. ", UI.el("strong", {}, `⭐ Nächste bessere Aussicht: ${weekdayLong(better.date)} (${better.label.toUpperCase()})`)]
        : "Heute insgesamt schwach — auch die nächsten Tage zeigen aktuell keine klar bessere Gelegenheit."));
  }

  // ---- DETAILS & ROHDATEN (eingeklappt: bisheriges Strategie-/Bedingungen-Panel + Spot-Rangliste) ----
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
      // SPRINT 3.1 (Punkt 2/9): Wasserstandstrend als eigene, tiefere Detailzeile — der absolute
      // Pegel bleibt (oben), die Phase/Rate/Datenalter kommen zusaetzlich dazu, nicht anstelle.
      UI.el("div", { class: "subtext" },
        waterPhase.ok
          ? `Wasserstandstrend: ${FIMefoModel.waterPhaseLabel(waterPhase.phase)}` +
            (waterPhase.rateCmPerHour !== null ? ` (${waterPhase.rateCmPerHour > 0 ? "+" : ""}${waterPhase.rateCmPerHour} cm/h)` : "") +
            ` · Confidence: ${confLabelDe(waterPhase.confidence)} · Datenalter: ${waterPhase.dataAgeMinutes} min`
          : `Wasserstandstrend: unklar${waterPhase.reason ? ` (${waterPhase.reason})` : ""}`),
      todayEntry.duskWindow
        ? UI.el("div", { class: "subtext" },
          `Zeitfenster (exakt, astronomisch): ${fmtTime(todayEntry.duskWindow.start)}–${fmtTime(todayEntry.duskWindow.end)} (60min vor Sonnenuntergang bis 60min nach Ende bürgerliche Dämmerung)`)
        : null,
      snap ? UI.el("div", { class: "subtext", html: `Status: ${UI.statusChip(snap.status)} · Datenqualität: ${snap.data_quality}` }) : null,
    ]),
    UI.el("div", { class: "panel" }, [
      // SPRINT 3.1 (Punkt 9): einfachere Sprache — Methodik (Shrinkage etc.) bleibt in
      // docs/audit_fangindex_v1.md dokumentiert, hier nur noch die fuer den Angler relevante Aussage.
      UI.el("div", { class: "panel-label" }, "Historische Spot-Stärke"),
      UI.el("div", { class: "subtext" },
        "Rangfolge aus deinem Fangbuch. Aktuelle Wetterbedingungen verändern diese Rangfolge derzeit noch nicht."),
      UI.el("ul", { class: "warum-list", style: "padding-left:16px;" }, rankedSpots.slice(0, 6).map((sp) =>
        UI.el("li", {}, `${sp.name}: ${Math.round(sp.shrunkRate * 100)}% (n=${sp.n}, Confidence: ${confLabelDe(sp.confidenceTier)})`))),
    ]),
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

  const sessions = (await FIDB.getAll("fishing_session")).sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "")).slice(0, 10);
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
  const countInput = UI.el("input", { type: "number", min: "0", value: "1" });
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
  blankCheck.addEventListener("change", () => { if (blankCheck.checked) countInput.value = "0"; });
  root.appendChild(UI.el("label", {}, "Länge (cm)")); root.appendChild(lengthInput);
  root.appendChild(UI.el("div", { class: "check-row" }, [lengthApprox, "nur ungefähr (keine exakte Messung)"]));
  root.appendChild(UI.el("label", {}, "Köder")); root.appendChild(lureInput);
  root.appendChild(UI.el("label", {}, "Farbe")); root.appendChild(colorInput);
  root.appendChild(UI.el("label", {}, "Notizen")); root.appendChild(notesInput);

  const btnRow = UI.el("div", { class: "btn-row" }, [
    UI.el("button", { class: "btn btn-secondary", onclick: () => renderView() }, "Abbrechen"),
    UI.el("button", { class: "btn btn-primary", onclick: async () => {
      const count = parseInt(countInput.value || "0", 10);
      const session = {
        session_id: FIDB.newId("sess"), angler: "Nils", species_target: speciesSel.value,
        water_id: waterSel.value, spot_id: spotSel.value || null, date: dateInput.value,
        day_part: daypartSel.value, time_precision: daypartSel.value === "unknown" ? "unknown" : "approximate",
        result_fish_count: count, result_contact_count: 0, is_blank_trip: count === 0,
        notes: notesInput.value, source_quality: "A_own_verified", created_at: FIDB.nowIso(),
        species_specific: {}, data_origin: "prospective_app_own", // PHASE 6A, Auftrag Punkt 9
      };
      await FIDB.put("fishing_session", session);
      if (window.FISync) FISync.enqueue("fishing_session", session.session_id);
      if (count > 0) {
        const catchEvent = {
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
      // Speichern + Navigation sofort; Environmental Enrichment laeuft im Hintergrund weiter
      // (gleiche Begruendung wie bei saveDraft() — siehe Kommentar dort).
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
      UI.el("button", { class: "btn btn-primary", onclick: () => {
        STATE.trip.session = { ...rec };
        STATE.trip.active = true;
        STATE.trip.track = trackDoc?.points ? trackDoc.points.slice() : [];
        STATE.trip.gpsMode = "off";
        STATE.trip.watchId = null;
        STATE.pendingRecovery = null;
        renderTripScreen(root);
      } }, "▶ Trip fortsetzen"),
      UI.el("button", { class: "btn btn-secondary", onclick: async () => {
        await clearActiveTripState();
        try { await FIDB.del("trip_track", rec.session_id); } catch (e) { console.warn("Verworfener Trip-Track konnte nicht geloescht werden:", e); }
        STATE.pendingRecovery = null;
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
        // Reihenfolge bewusst: zuerst der zuletzt via change-Event festgehaltene Wert, DANN erst
        // .value als Fallback (deckt den Fall ab, dass der Nutzer den Default nie angefasst hat und
        // daher nie ein change-Event feuerte), zuletzt STATE/null als letzter Fallback.
        STATE.trip.active = true;
        STATE.trip.session = { session_id: FIDB.newId("sess"), angler: "Nils", start_time: new Date().toISOString(),
          species_target: chosenSpecies || tripSpeciesSel.value || STATE.species,
          water_id: chosenWater || tripWaterSel.value || STATE.water,
          spot_id: (chosenSpot !== null ? chosenSpot : tripSpotSel.value) || null,
          shore_or_boat: null, result_fish_count: 0, result_contact_count: 0 };
        STATE.trip.track = [];
        // PHASE 6A: Trip-Kontext + (leerer) GPS-Track sofort persistieren, damit ein Reload direkt
        // nach dem Start nichts verliert (Auftrag Punkt 2/3).
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
  s.created_at = FIDB.nowIso();
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
  if (window.FISync) FISync.enqueue("fishing_session", s.session_id);
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
        s.name, UI.el("span", { class: "chip" }, s.fangbuch_n >= 10 ? `n=${s.fangbuch_n}` : "wenig Daten"),
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

// PHASE 6B (Automatic Cloud Backup, 26.08.2026): Inhalt der "☁️ Cloud-Sicherung"-Kachel in
// Insights. Rendert je nach Status (SDK/Login/Queue) — siehe FISync.getStatus() (sync.js).
// Keine technische Sync-Konsole (Auftrag Abschnitt 14) — nur die vier erlaubten Zustaende plus
// Login/Logout/manueller-Sync-Button.
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

  // Eingeloggt: Status-Kachel gemaess Auftrag Abschnitt 14 (drei erlaubte Zustaende + Zeitstempel).
  let line, icon;
  if (!status.online || !status.sdkAvailable) { icon = "⚠️"; line = "Cloud-Sicherung nicht verbunden"; }
  else if (status.pendingCount > 0) { icon = "⏳"; line = `${status.pendingCount} Eintrag${status.pendingCount === 1 ? "" : "e"} warten auf Sicherung`; }
  else { icon = "✓"; line = "Aktuell"; }
  slot.appendChild(UI.el("div", {}, `${icon} ${line}`));
  if (status.lastSyncAt) {
    slot.appendChild(UI.el("div", { class: "subtext" }, `Letzte Cloud-Sicherung: ${new Date(status.lastSyncAt).toLocaleString("de-DE")}`));
  }
  slot.appendChild(UI.el("div", { class: "btn-row", style: "margin-top:8px;" }, [
    UI.el("button", { class: "btn btn-secondary", onclick: async (ev) => {
      ev.target.disabled = true; ev.target.textContent = "Synchronisiere…";
      const r = await FISync.flushQueue();
      ev.target.disabled = false; ev.target.textContent = "Jetzt synchronisieren";
      if (r.reason === "offline") UI.toast("Kein Netz — wird automatisch nachgeholt, sobald wieder online.", "");
      else if (r.done > 0) UI.toast(`${r.done} Eintrag${r.done === 1 ? "" : "e"} gesichert.`, "success");
      else if (r.stillPending > 0) UI.toast("Synchronisierung teilweise fehlgeschlagen, wird später erneut versucht.", "");
      if (STATE.view === "insights") renderView();
    } }, "Jetzt synchronisieren"),
    UI.el("button", { class: "btn btn-ghost", onclick: async (ev) => {
      await FISync.signOut();
      UI.toast("Abgemeldet. Lokale Daten sind unverändert vorhanden.", "success");
      if (STATE.view === "insights") renderView();
    } }, "Abmelden"),
  ]));
}

async function viewInsights() {
  const root = UI.el("div", {});
  root.appendChild(UI.el("h1", {}, "🧠 Insights"));

  const [sessions, catches, reports, observations] = await Promise.all([
    FIDB.getAll("fishing_session"), FIDB.getAll("catch_event"), FIDB.getAll("intelligence_report"), FIDB.getAll("observation"),
  ]);
  root.appendChild(UI.el("div", { class: "panel" }, [
    UI.el("div", { class: "panel-label" }, "Datenbestand (Provenance bleibt getrennt, Abschnitt 38)"),
    UI.el("div", { class: "quality-grid" }, [
      UI.el("div", {}, `Eigene Trips: ${sessions.length}`), UI.el("div", {}, `Eigene Fänge: ${catches.length}`),
      UI.el("div", {}, `Intelligence-Meldungen: ${reports.length}`), UI.el("div", {}, `Beobachtungen: ${observations.length}`),
    ]),
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

  root.appendChild(UI.el("div", { class: "panel-label", style: "margin-top:10px;" }, "🔎 Frag meine Angeldaten (vorbereitet, Sprint 3)"));
  root.appendChild(UI.el("input", { type: "text", placeholder: "z.B. „Was wissen wir über Zander in der Trave bei steigendem Pegel?“", disabled: "disabled" }));
  root.appendChild(UI.el("div", { class: "subtext" }, "Noch nicht funktional — Datenmodell/Provenance ist dafür bereits vorbereitet (getrennte Quellen, Confidence, Umweltdaten), die Auswertungslogik folgt erst nach ausreichender Datenbasis (Abschnitt 37/38)."));

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
  }

  return root;
}

document.addEventListener("DOMContentLoaded", init);
