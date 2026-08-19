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
};

const ROOT = () => document.getElementById("view-root");

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  await FIDB.openDb();
  const seeded = await FISeed.seedIfEmpty();
  if (seeded) UI.toast("Referenzdaten geladen (Arten/Gewässer/Spots).", "success");

  // USER VOCABULARY (Voice Reliability Loop Runde 2, Abschnitt 8): persoenliche Korrekturen aus
  // vorherigen Sitzungen VOR der ersten Extraktion in die Gazetteer-Tabellen einmischen, damit
  // z.B. eine einmal bestaetigte Fuzzy-Korrektur ("Blies Dorf" -> Bliesdorf) ab sofort als
  // exakter Treffer erkannt wird, nicht erneut nur als unsichere Vermutung.
  try {
    const userVocab = await FIDB.getAll("user_vocabulary");
    if (userVocab.length) GAZ.mergeUserVocabulary(userVocab);
  } catch (e) { console.warn("User-Vokabular konnte nicht geladen werden:", e); }

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

  window.addEventListener("online", () => { updateOfflineBadge(); FIEnrichment.retryPendingQueue().then((r) => { if (r.done) UI.toast(`${r.done} Umweltdaten-Snapshot(s) nachtraeglich ergaenzt.`, "success"); }); });
  window.addEventListener("offline", updateOfflineBadge);
  updateOfflineBadge();

  if (navigator.onLine) {
    FIEnrichment.retryPendingQueue().then((r) => { if (r.done) UI.toast(`${r.done} Umweltdaten-Snapshot(s) nachtraeglich ergaenzt.`, "success"); });
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
  const content = await renderers[STATE.view]();
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
      root.appendChild(UI.el("div", { class: "inbox-item" }, [
        UI.el("div", { class: "inbox-headline" }, s.is_blank_trip ? "Nullrunde" : `${s.result_fish_count}x ${s.species_target}`),
        UI.el("div", { class: "inbox-meta" }, `${UI.fmtDate(s.date)} · ${s.spot_id || s.water_id || "?"} · ${UI.fmtDayPart(s.day_part)}`),
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
        species_specific: {},
      };
      await FIDB.put("fishing_session", session);
      if (count > 0) {
        await FIDB.put("catch_event", {
          catch_id: FIDB.newId("catch"), session_id: session.session_id, species: speciesSel.value,
          length_cm: lengthInput.value ? parseFloat(lengthInput.value) : null,
          length_precision: lengthInput.value ? (lengthApprox.checked ? "approximate" : "exact") : "unknown",
          catch_time: null, day_part: daypartSel.value, spot_id: spotSel.value || null,
          lure_type: lureInput.value || null, lure_color: colorInput.value || null,
          created_at: FIDB.nowIso(), species_specific: {},
        });
      }
      // Speichern + Navigation sofort; Environmental Enrichment laeuft im Hintergrund weiter
      // (gleiche Begruendung wie bei saveDraft() — siehe Kommentar dort).
      UI.toast("Fang gespeichert. Umweltdaten werden im Hintergrund ergänzt…", "success");
      STATE.view = "angeln"; renderView();
      FIEnrichment.enrich(waterSel.value, dateInput.value, daypartSel.value, "approximate", null, "session", session.session_id)
        .then(async (snap) => {
          session.environmental_snapshot_id = snap.snapshot_id;
          await FIDB.put("fishing_session", session);
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
      await FIDB.put("observation", {
        observation_id: FIDB.newId("obs"), observer: "Nils", water_id: waterSel.value, spot_id: null,
        date: dateInput.value, day_part: "unknown", text: textInput.value, category: "manuell",
        raw_transcript: textInput.value, created_at: FIDB.nowIso(),
      });
      UI.toast("Beobachtung gespeichert.", "success");
      STATE.view = "angeln"; renderView();
    } }, "✓ Speichern"),
  ]));
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
    root.appendChild(UI.el("div", { class: "panel", style: "margin-top:14px;" }, [
      UI.el("p", {}, "Standard: KEIN GPS. Ein Trip kann vollständig ohne Standort geführt werden (Start-/Endzeit, Gewässer, Spot manuell, Köder, Fänge, Nullrunde)."),
      UI.el("button", { class: "btn btn-primary", onclick: () => {
        STATE.trip.active = true;
        STATE.trip.session = { session_id: FIDB.newId("sess"), angler: "Nils", start_time: new Date().toISOString(), water_id: "luebecker_bucht", spot_id: null, shore_or_boat: null, result_fish_count: 0, result_contact_count: 0 };
        renderTripScreen(root);
      } }, "▶ Trip starten (ohne GPS)"),
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
        UI.el("button", { class: `btn ${s.shore_or_boat === "ufer" ? "btn-primary" : "btn-ghost"}`, onclick: () => { s.shore_or_boat = s.shore_or_boat === "ufer" ? null : "ufer"; renderTripScreen(root); } }, "🚶 Ufer"),
        UI.el("button", { class: `btn ${s.shore_or_boat === "boot" ? "btn-primary" : "btn-ghost"}`, onclick: () => { s.shore_or_boat = s.shore_or_boat === "boot" ? null : "boot"; renderTripScreen(root); } }, "🚤 Boot"),
      ]),
    ]);
    const spotSel = UI.el("select", { onchange: (e) => { s.spot_id = e.target.value || null; } });
    spotSel.appendChild(UI.el("option", { value: "" }, "(kein bestimmter Spot)"));
    FIDB.getAll("spot").then((spots) => {
      spots.filter((sp) => sp.water_id === s.water_id).forEach((sp) =>
        spotSel.appendChild(UI.el("option", { value: sp.spot_id, ...(s.spot_id === sp.spot_id ? { selected: "selected" } : {}) }, sp.name)));
    });
    const spotRow = UI.el("div", { class: "panel" }, [UI.el("div", { class: "panel-label" }, "Spot (optional)"), spotSel]);

    root.appendChild(UI.el("div", { class: "panel" }, [
      UI.el("p", {}, `Trip läuft seit ${new Date(s.start_time).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}.`),
      UI.el("button", { class: "btn btn-ghost", onclick: async () => {
        if (!navigator.geolocation) { UI.toast("Geolocation auf diesem Gerät nicht verfügbar.", "error"); return; }
        navigator.geolocation.getCurrentPosition((pos) => {
          STATE.trip.gpsMode = "single_fix";
          STATE.trip.session.gps_lat = pos.coords.latitude; STATE.trip.session.gps_lon = pos.coords.longitude;
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
function renderTripOutcomeStep(root) {
  // GPS IMMER sofort stoppen, sobald "Trip beenden" angetippt wird — NICHT erst nach Beantwortung
  // der Nullrunden-Frage (Abschnitt 31, Pflicht-Testfall: kein GPS-Tracking mehr, sobald der Nutzer
  // den Beenden-Vorgang eingeleitet hat, unabhaengig davon, wie lange die Outcome-Abfrage offen
  // bleibt). finalizeTripWithOutcome() prüft denselben watchId-Guard zusätzlich defensiv.
  if (STATE.trip.watchId !== null) { navigator.geolocation.clearWatch(STATE.trip.watchId); STATE.trip.watchId = null; }
  STATE.trip.gpsMode = "off";
  root.innerHTML = "";
  root.appendChild(UI.el("h1", {}, "🎣 Trip beenden"));
  root.appendChild(UI.el("div", { class: "panel" }, [
    UI.el("div", { class: "panel-label" }, "Meerforelle gefangen?"),
    UI.el("div", { class: "btn-row" }, [
      UI.el("button", { class: "btn btn-primary", onclick: () => renderTripCatchCountStep(root) }, "✓ Ja"),
      UI.el("button", { class: "btn btn-secondary", onclick: () => finalizeTripWithOutcome(root, false, 0) }, "✕ Nein (Nullrunde)"),
    ]),
    UI.el("div", { class: "subtext" }, "Eine Nullrunde ist ein wichtiger Datenpunkt und wird genauso gespeichert wie ein Fang."),
  ]));
  root.appendChild(UI.el("button", { class: "btn btn-ghost", style: "margin-top:16px;", onclick: () => renderTripScreen(root) }, "← Zurück zum laufenden Trip"));
}

function renderTripCatchCountStep(root) {
  root.innerHTML = "";
  root.appendChild(UI.el("h1", {}, "🎣 Trip beenden"));
  const countInput = UI.el("input", { type: "number", min: "1", value: "1" });
  root.appendChild(UI.el("div", { class: "panel" }, [
    UI.el("div", { class: "panel-label" }, "Wie viele Meerforellen?"),
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
  await FIDB.put("fishing_session", s);
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
  STATE.trip.watchId = navigator.geolocation.watchPosition(
    (pos) => STATE.trip.track.push({ t: Date.now(), lat: pos.coords.latitude, lon: pos.coords.longitude }),
    (err) => UI.toast("GPS-Fehler: " + err.message, "error"),
    { enableHighAccuracy: true }
  );
  renderTripScreen(root);
}

function stopFullTrack(root) {
  if (STATE.trip.watchId !== null) { navigator.geolocation.clearWatch(STATE.trip.watchId); STATE.trip.watchId = null; }
  STATE.trip.gpsMode = "off";
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
    await FIDB.put("observation", {
      observation_id: FIDB.newId("obs"), observer: "Nils", water_id: waterId, spot_id: draft.spot.value,
      date: draft.date.value, day_part: draft.dayPart.value, text: draft.rawTranscript,
      category: "sprach-erfasst", raw_transcript: draft.rawTranscript, created_at: FIDB.nowIso(),
    });
    UI.toast("Beobachtung gespeichert.", "success");
    STATE.voice.draft = null; STATE.voice.interim = ""; STATE.view = "intelligence";
    renderView();
    return;
  }

  const report = {
    report_id: FIDB.newId("rep"),
    source_type: { hearsay_report: "hearsay", direct_report: "direct_report", trip_blank: "own_manual", catch: "own_manual" }[draft.recordType] || "own_manual",
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
    UI.toast(`Umweltdaten für "${report.species || report.record_type}"-Meldung: ${snap.status === "complete" ? "vollständig ergänzt" : snap.status}.`, snap.status === "failed" ? "" : "success");

    // PHASE 5 (GO-Freigabe): Voice/Text-Intelligence-Meldungen liefern nicht IMMER ein
    // zweifelsfrei explizites Outcome (is_blank_trip ist eine Extraktions-Vermutung, keine
    // erzwungene Abfrage wie beim Trip-Ende) — daher hier bewusst KONSERVATIV: nur als bekanntes
    // Outcome werten, wenn entweder eine Fangzahl vorliegt ODER die Meldung explizit als Nullrunde
    // erkannt wurde. Sonst wird outcome_known=false protokolliert statt eine unsichere Vermutung
    // als sicheres Outcome zu verkaufen (Spezifikation, offener Punkt K.6).
    if (window.FIShadow && report.species === "mefo" && waterId === "luebecker_bucht") {
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
  return root;
}

document.addEventListener("DOMContentLoaded", init);
