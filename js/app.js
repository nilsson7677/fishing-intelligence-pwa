// Haupt-App: Router, State, View-Rendering, Voice-Workflow, Intelligence Inbox, Trip/GPS.
// Bewusst ein einziges Modul ohne Framework/Build-Schritt (Abschnitt 4/46: "working software",
// keine zusaetzliche Komplexitaet, die auf dem Handy getestet werden muesste, ohne Mehrwert).

const STATE = {
  view: "copilot",
  species: "mefo",
  water: "luebecker_bucht",
  // finalizing: true zwischen "Nutzer hat STOP gedrueckt" und "volles Transkript ist da"
  // (Voice Reliability Loop) - verhindert, dass waehrend dieser kurzen async-Luecke eine neue
  // Aufnahme gestartet wird und die noch ausstehende Extraktion der vorigen Session ueberschreibt.
  voice: { provider: null, listening: false, finalizing: false, interim: "", draft: null },
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

  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("sw.js"); } catch (e) { console.warn("SW-Registrierung fehlgeschlagen:", e); }
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

  const selectors = UI.el("div", { class: "top-selectors" }, [
    UI.el("div", { class: "selector" }, [
      "Zielart",
      UI.el("select", { onchange: (e) => { STATE.species = e.target.value; renderView(); } },
        speciesList.map((s) => UI.el("option", { value: s.species_id, ...(s.species_id === STATE.species ? { selected: "selected" } : {}) }, `${speciesEmoji(s.species_id)} ${s.name_de}`))),
    ]),
    UI.el("div", { class: "selector" }, [
      "Gewässer",
      UI.el("select", { onchange: (e) => { STATE.water = e.target.value; renderView(); } },
        waterList.map((w) => UI.el("option", { value: w.water_id, ...(w.water_id === STATE.water ? { selected: "selected" } : {}) }, w.name_de))),
    ]),
  ]);
  root.appendChild(selectors);

  const calibrated = STATE.species === "mefo" && STATE.water === "luebecker_bucht";
  if (calibrated) {
    root.appendChild(await buildMefoCopilotPanels());
  } else {
    root.appendChild(await buildUncalibratedPanel());
  }
  return root;
}

function speciesEmoji(id) { return { mefo: "🐟", zander: "🐠", hecht: "🐊", barsch: "🐟" }[id] || "🐟"; }

async function buildMefoCopilotPanels() {
  const container = document.createDocumentFragment();
  const dt = new Date();
  dt.setMinutes(0, 0, 0);
  const dayPart = currentDayPartNow();

  let snap = await latestSnapshotForWater("luebecker_bucht");
  const refreshBtn = UI.el("button", { class: "btn btn-ghost", style: "margin-bottom:12px;", onclick: async (ev) => {
    ev.target.textContent = "Lädt…"; ev.target.disabled = true;
    try {
      snap = await FIEnrichment.enrich("luebecker_bucht", isoToday(), dayPart, "approximate", null, "session", "copilot_live");
      UI.toast(`Umweltdaten aktualisiert (${snap.status}).`, snap.status === "failed" ? "error" : "success");
    } catch (e) { UI.toast("Aktualisierung fehlgeschlagen: " + e.message, "error"); }
    renderView();
  } }, "🔄 Umweltdaten jetzt aktualisieren");

  const wrap = UI.el("div", {});
  wrap.appendChild(refreshBtn);

  const wassertemp = snap?.water_temp_c?.value ?? null;
  const fc = FIMefoModel.basisFangchance(dt.getMonth() + 1, wassertemp);

  wrap.appendChild(UI.el("div", { class: "panel" }, [
    UI.el("div", { class: "panel-label" }, "Fangchance"),
    UI.el("div", { class: "row" }, [
      UI.el("div", { style: "font-size:44px;font-weight:700;color:var(--accent-green);",
        html: fc.score !== null ? `${fc.score}<span style="font-size:18px;color:var(--text-dim)">/100</span>` : "—" }),
      UI.el("span", { class: "chip chip-green" }, fc.label),
    ]),
    UI.el("div", { class: "subtext" }, fc.hinweis + (wassertemp === null ? " (aktuell keine Wassertemperatur verfügbar — auf 🔄 tippen.)" : "")),
  ]));

  wrap.appendChild(UI.el("div", { class: "panel" }, [
    UI.el("div", { class: "panel-label" }, "Top Spot (historisch, Lübecker Bucht)"),
    UI.el("div", { class: "row" }, ["Pelzerhaken", UI.el("span", { class: "chip" }, "Confidence: mittel (n=26)")]),
    UI.el("div", { class: "subtext" }, FIMefoModel.spotMatch("pelzerhaken").hinweis + " Kein automatisches GPS-Matching — Spot wird beim Fang-Log manuell gewählt."),
  ]));

  const sun = snap?.sunrise?.measured_at ? new Date(snap.sunrise.measured_at) : null;
  const sunset = snap?.sunset?.measured_at ? new Date(snap.sunset.measured_at) : null;
  wrap.appendChild(UI.el("div", { class: "panel" }, [
    UI.el("div", { class: "panel-label" }, "Zeitfenster (Dämmerung, heute)"),
    UI.el("div", { style: "font-size:22px;font-weight:700;color:var(--accent-yellow);" },
      sun && sunset ? `${sun.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} / ${sunset.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}` : "🔄 aktualisieren für Zeiten"),
    UI.el("div", { class: "subtext" }, "Sonnenauf-/-untergang, deterministisch berechnet (NOAA Sunrise Equation) — läuft immer, unabhängig vom Netz."),
  ]));

  const windBft = snap?.wind_speed_bft?.value ?? null;
  const windDir = snap?.wind_dir_deg?.value ?? null;
  wrap.appendChild(UI.el("div", { class: "panel" }, [
    UI.el("div", { class: "panel-label" }, "Strategie"),
    UI.el("div", { class: "subtext", style: "font-size:14px;color:var(--text);" }, FIMefoModel.strategieHinweis(windDir, windBft, 68)),
  ]));

  wrap.appendChild(UI.el("div", { class: "panel" }, [
    UI.el("div", { class: "panel-label" }, "Bedingungen"),
    UI.el("div", { class: "quality-grid", style: "grid-template-columns:1fr 1fr;font-size:13px;" }, [
      UI.el("div", {}, `Lufttemp.: ${UI.fmtProvValue(snap?.air_temp_c)}`),
      UI.el("div", {}, `Wind: ${UI.fmtProvValue(snap?.wind_dir_deg, 0)}° / ${UI.fmtProvValue(snap?.wind_speed_bft, 0)} Bft`),
      UI.el("div", {}, `Pegel: ${UI.fmtProvValue(snap?.water_level_cm, 0)}`),
      UI.el("div", {}, `Wassertemp.: ${UI.fmtProvValue(snap?.water_temp_c)}`),
    ]),
    snap ? UI.el("div", { class: "subtext", html: `Status: ${UI.statusChip(snap.status)} · Datenqualität: ${snap.data_quality}` }) : null,
  ]));

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
        STATE.trip.session = { session_id: FIDB.newId("sess"), angler: "Nils", start_time: new Date().toISOString(), water_id: "luebecker_bucht", spot_id: null, result_fish_count: 0, result_contact_count: 0 };
        renderTripScreen(root);
      } }, "▶ Trip starten (ohne GPS)"),
    ]));
  } else {
    root.appendChild(UI.el("div", { class: "panel" }, [
      UI.el("p", {}, `Trip läuft seit ${new Date(STATE.trip.session.start_time).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}.`),
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
      UI.el("button", { class: "btn btn-primary", style: "margin-top:16px;", onclick: () => endTrip(root) }, "⏹ Trip beenden"),
    ]));
  }
  root.appendChild(UI.el("button", { class: "btn btn-ghost", style: "margin-top:16px;", onclick: () => renderView() }, "← Zurück"));
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

async function endTrip(root) {
  // GPS IMMER sofort stoppen, unabhaengig vom bisherigen Modus (Abschnitt 31, Pflicht-Testfall).
  if (STATE.trip.watchId !== null) { navigator.geolocation.clearWatch(STATE.trip.watchId); STATE.trip.watchId = null; }
  const s = STATE.trip.session;
  s.end_time = new Date().toISOString();
  s.duration_minutes = Math.round((new Date(s.end_time) - new Date(s.start_time)) / 60000);
  s.date = isoToday();
  s.day_part = currentDayPartNow();
  s.time_precision = "exact";
  s.species_target = s.species_target || "unbekannt";
  s.is_blank_trip = s.result_fish_count === 0; // Nullrunden-Konvention (Abschnitt 21) — nie leer lassen
  s.source_quality = "A_own_verified";
  s.created_at = FIDB.nowIso();
  s.species_specific = {};
  await FIDB.put("fishing_session", s);
  UI.toast(`Trip gespeichert (${s.duration_minutes} Min., ${s.is_blank_trip ? "Nullrunde" : s.result_fish_count + " Fisch(e)"}).`, "success");
  STATE.trip = { active: false, session: null, gpsMode: "off", watchId: null, track: [] };
  STATE.view = "angeln";
  renderView();
}

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
  STATE.voice.listening = true; STATE.voice.finalizing = false; STATE.voice.interim = "";
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
    (errMsg) => { UI.toast(errMsg, "error"); if (STATE.view === "intelligence") renderView(); }
  );
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
  wrap.appendChild(UI.el("div", { class: "panel-label" }, "Original-Transkript"));
  wrap.appendChild(UI.el("p", { style: "font-style:italic;color:var(--text-dim);" }, `"${draft.rawTranscript}"`));
  wrap.appendChild(UI.el("h2", { style: "margin-top:14px;" }, card.headline));

  const rows = [
    ["📅 Datum", draft.date.value ? UI.fmtDate(draft.date.value) : "unbekannt", draft.date],
    ["🕐 Tageszeit", UI.fmtDayPart(draft.dayPart.value), draft.dayPart],
    ["📍 Ort", draft.spot.value || draft.water.value || "unbekannt", draft.spot.value ? draft.spot : draft.water],
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
  root.appendChild(UI.el("label", {}, "Anzahl")); root.appendChild(countInput);
  root.appendChild(UI.el("label", {}, "Länge (cm)")); root.appendChild(lengthInput);
  root.appendChild(UI.el("div", { class: "btn-row" }, [
    UI.el("button", { class: "btn btn-secondary", onclick: () => renderView() }, "Abbrechen"),
    UI.el("button", { class: "btn btn-primary", onclick: () => {
      draft.species.value = speciesInput.value || null; draft.species.confidence = 1.0; draft.species.precision = "exact"; draft.species.note = "manuell korrigiert";
      draft.fishCount.value = countInput.value !== "" ? parseInt(countInput.value, 10) : null;
      draft.lengthCm.value = lengthInput.value !== "" ? parseFloat(lengthInput.value) : null;
      if (draft.lengthCm.value !== null) { draft.lengthCm.confidence = 1.0; draft.lengthCm.precision = "exact"; draft.lengthCm.note = "manuell korrigiert"; }
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
    spot_name_raw: !draft.spot.value && draft.spot.note ? draft.spot.note : null,
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
