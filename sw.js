// Service Worker — Fishing Intelligence Co-Pilot
// Cache-first fuer den App-Shell (HTML/CSS/JS/Icons), damit die App OHNE Netz startet
// (Abschnitt 4/34: Offline-Grundfunktion). Externe API-Aufrufe (Open-Meteo/Pegelonline) werden
// NICHT durch den Service Worker geleitet/gecacht - die laufen direkt aus enrichment.js per
// fetch() und muessen bei Ausfall ehrlich fehlschlagen (Retry-/Pending-Prinzip aus Sprint 1
// bleibt erhalten, siehe js/enrichment.js).

const CACHE_NAME = "fishintel-shell-v29-3"; // v29.3: SUPABASE AUTH 401 HOTFIX (05.09.2026). Live
// bestaetigt: signInWithOtp() schlug mit 401 UNAUTHORIZED_INVALID_API_KEY fehl, weil supabase-js den
// Auth-Teilclient IMMER mit "Authorization: Bearer <apikey>" konstruiert (SDK-Standardverhalten) — der
// neue, nicht-JWT-foermige sb_publishable_-Key wird dort als JWT geparst und abgelehnt (siehe
// claude/PHASE_SUPABASE_AUTH_401_DIAGNOSTIC_V29_3_REPORT.md fuer die vollstaendige Root-Cause-Analyse
// inkl. supabase-js-Quellcode-Zitat). EINZIGE Aenderung dieses Hotfixes: js/sync.js, getClient() —
// ein zusaetzlicher createClient()-Parameter "global: { headers: { Authorization: "" } }", der genau
// diesen einen Default-Header fuer den anonymen (nicht eingeloggten) Zustand ueberschreibt. Vom Nutzer
// per echtem Live-Request gegen das Produktions-Supabase-Projekt bestaetigt (error:null, Magic-Link-
// Mail kam an) — dies ist also KEIN spekulativer Fix. CACHE_NAME-Anhebung erzwingt wie gewohnt einen
// sauberen Neuabruf aller Shell-Dateien inkl. der korrigierten js/sync.js. APP_BUILD in js/app.js
// parallel auf v29.3 angehoben — Versions-Label zeigt automatisch "Fishing Intelligence · v29.3".
// KEINE weitere Aenderung: DB_VERSION bleibt 8, keine IndexedDB-/Supabase-Schema-/Migrations-
// Aenderung, keine Aenderung an Sync-Queue/Verifizierung/Restore/Tombstone-Logik (nur der eine
// zusaetzliche Client-Header, keine Logikaenderung), keine Aenderung an Champion/Challenger/HI-2B/
// HI-2C/WHAT/Fangindex/Spot-Logik/Datenmodell.
// v29.2 (davor): CLOUD-KEY-CACHE-MICROHOTFIX (04.09.2026).
// Reiner Cache-Bust + Versionsanhebung, KEINE Logik-/Modell-/DB-/Schema-Aenderung: js/sync.js wurde
// LOKAL bereits korrigiert (SUPABASE_ANON_KEY war um genau EIN Zeichen verkuerzt — "Invalid API key"
// serverseitig) — diese Korrektur war aber vom Nutzer bereits vorher vorgenommen worden und wirkte
// wegen des Service-Worker-Cache-first-Verhaltens (CACHE_NAME "fishintel-shell-v29-1") auf einem
// bereits installierten Geraet nicht: der Service Worker lieferte weiterhin die ALTE, gecachte
// js/sync.js aus. Diese CACHE_NAME-Anhebung (wie schon bei jedem vorigen Sprint, siehe Kommentar oben
// in dieser Datei) erzwingt einen sauberen Neuabruf ALLER SHELL_FILES vom Netz, inkl. der bereits
// korrigierten js/sync.js, und loescht den alten Cache beim naechsten Service-Worker-Update (siehe
// "activate"-Event unten, unveraendert). APP_BUILD in js/app.js parallel auf v29.2 angehoben (gleiche
// Konvention wie v29.1) — das Versions-Label auf dem Co-Pilot-Bildschirm zeigt automatisch
// "Fishing Intelligence · v29.2" (aus APP_BUILD abgeleitet, siehe deriveVersionLabel()/
// APP_VERSION_LABEL in js/app.js, keine eigene Aenderung dort noetig ausser dem APP_BUILD-String
// selbst). KEINE Aenderung an DB_VERSION (bleibt 8), IndexedDB-Schema/-Daten, Supabase-Schema,
// Auth-/Sync-/Verifizierungs-/Restore-/Tombstone-Logik, Champion/Challenger/HI-2B/HI-2C/WHAT/
// Fangindex/Spot-Logik/Datenmodell. Keine neue SQL-Migration. Kein Site-Data-Reset/keine
// IndexedDB-Loeschung — der Service-Worker-Cache betrifft ausschliesslich die App-Shell-Dateien
// (HTML/CSS/JS/Icons), niemals IndexedDB (siehe js/db.js, komplett getrennter Speicher).
// v29.1 (davor): VERSION LABEL MICRO-HOTFIX — permanent sichtbares, dezentes Versions-Label oben auf
// dem Co-Pilot-Hauptbildschirm, aus APP_BUILD abgeleitet (js/app.js: deriveVersionLabel/
// APP_VERSION_LABEL) — einzige Quelle der Wahrheit. Geaenderte Dateien damals: js/app.js
// (APP_BUILD-String, neues Label, viewCoPilot()), css/style.css (neue .app-version-tag-Regel).
// v29 (davor): Fishing Intelligence v1 — Reliable Cloud Backup
// (04.09.2026). DATA-SAFETY-Sprint, KEINE neue Fishing Intelligence, KEIN Scoring-/Modell-Code
// veraendert (Champion/Fangindex/HI-2B/HI-2C/SPOT_STATS/WHAT/historisches Fangbuch unveraendert,
// per Diff verifiziert — siehe claude/PHASE_RELIABLE_CLOUD_BACKUP_V29_IMPLEMENTATION_REPORT.md).
// AUDIT-BEFUND (root weakness): der Cloud-Tabellen-Schema-Stand aus Phase 6B (supabase_setup.sql,
// 26.08.2026) kennt die in v28 neu eingefuehrten fishing_session-Felder status/completed_at/
// abandoned_at/legacy_recovered NICHT — jeder Upsert einer fishing_session mit diesen Feldern
// schlaegt seit v28 serverseitig mit "column does not exist" fehl (PostgREST), was ueber die FK
// session_id->fishing_session AUCH catch_event/trip_track-Uploads fuer denselben Trip blockiert.
// Local First hat das bisher unsichtbar folgenlos gehalten (Warteschlange blieb einfach pending),
// aber KEIN Datensatz dieser Art wurde seit v28 tatsaechlich cloud-gesichert. Behoben durch additive
// Cloud-Schema-Migration (supabase_migration_v29.sql, vom Nutzer manuell in Supabase auszufuehren —
// dieses Sandbox kann weder das Supabase-Projekt erreichen noch DDL ausfuehren, siehe Bericht
// "Known Limitations").
// NEU: (1) Tombstones (deleted_at-Spalte auf allen 8 Cloud-Tabellen, additiv) — lokal absichtlich
// geloeschte Testdaten (Insights -> Testdaten bereinigen) schreiben jetzt vor dem lokalen Loeschen
// einen Tombstone-Marker in die sync_queue (op:"delete"), der beim naechsten Sync-Lauf NUR
// deleted_at auf der bestehenden Cloud-Zeile setzt (kein DELETE, keine DELETE-RLS-Policy noetig/
// vorhanden) — verhindert, dass "Cloud -> Lokal wiederherstellen" solche Datensaetze zurueckbringt.
// (2) Taegliche Verifizierung (FISync.verifyCloudCompleteness()): mehr als "HTTP 200" — nach
// erfolgreichem Leerlaufen der Warteschlange wird pro Cloud-Store ein leichtgewichtiger
// Server-Zaehl-Request (count:exact,head:true, kein Datendownload) gegen einen lokalen Zaehler
// verglichen; nur bei Erfolg wird der "gesichert"-Zeitstempel (>24h-Pruefung) fortgeschrieben.
// Ausfuehrungsgelegenheiten: App-Start, online-Event, Vordergrund (visibilitychange), nach
// Trip-Abschluss, manueller "Jetzt sichern"-Button — kein Intervall-Timer/Polling.
// (3) Cloud -> Lokal Restore (Insights -> Datensicherheit -> "Aus Cloud wiederherstellen"):
// leichtgewichtige Zaehl-Vorschau vor jeder Schreibaktion, MERGE BY STABLE ID (nur echte
// cloud-only-IDs werden geschrieben, ein bereits lokal vorhandener Datensatz wird NIE ueberschrieben
// — deterministische, destruktionsfreie Konfliktpolitik, siehe Bericht), Tombstones werden beim
// Laden serverseitig ausgefiltert. Restore-Schreibvorgaenge rufen bewusst NIE enqueue() auf (kein
// Restore-Sync-Loop). (4) Vier-Zustand-Status-UI unter Insights ("☁️ Gesichert"/"⏳ Sicherung
// ausstehend"/"⚠️ Cloud-Sicherung nicht aktuell"/"❌ Cloud nicht erreichbar") — "Gesichert" NIE allein
// aus leerer Warteschlange abgeleitet, sondern nur nach einer tatsaechlich erfolgreichen
// Verifizierung <24h. (5) Neues rein lesendes "Cloud Backup Diagnostics"-Debug-Panel unter
// ?hidebug=1 (Insights) — Queue/Sync/Verifizierungs-/Restore-Zeitstempel + lokale Store-Zaehler,
// NIE Zugangsdaten. Store-Klassifikation (Auftrag Abschnitt 12): MUST BACKUP fishing_session/
// catch_event/intelligence_report/observation/trip_track/user_vocabulary/shadow_evaluation, SHOULD
// BACKUP environmental_snapshot (alle bereits Teil von FISync.CLOUD_STORES seit Phase 6B,
// unveraendert), RECREATABLE/kein Restore noetig hourly_shadow_snapshot/
// hourly_window_shadow_prediction/where_spot_shadow_prediction (bereits vorher NICHT cloud-gesichert,
// Entscheidung nur bestaetigt/dokumentiert, kein Code-Vorgang). JSON-Backup/-Restore (Phase 6A)
// bleibt vollstaendig unveraendert als zweite, unabhaengige Sicherheitsebene. KEINE DB_VERSION-
// Aenderung (bleibt 8 — der neue sync_queue-Eintrag "op" ist ein rein additives, optionales Feld auf
// bereits vorhandenen Dokumenten, kein neuer Store/Index). KEIN neuer SHELL_FILES-Eintrag (alle
// Aenderungen in js/sync.js und js/app.js, keine neue Datei). v28: Fishing Intelligence v1 — Data Integrity + 29-Spot
// Product Coverage + Personal Fishing Window (04.09.2026). DREI Teile, alle Model-Scope-Lock-konform
// (Champion/Fangindex/HI-2B/HI-2C/SPOT_STATS/WHAT/historische Daten unveraendert):
// TEIL A (Data Integrity): fishing_session existiert jetzt SOFORT bei Trip-Start (status
// "in_progress"), nicht erst bei "Trip beenden" (vorher die strukturelle Ursache dafuer, dass ein
// abgebrochener/verworfener Trip spurenlos verschwinden konnte) — durchlaeuft
// in_progress -> completed (Trip-Ende, UPDATE derselben Session, KEINE zweite Session) bzw.
// -> abandoned (explizites "Verwerfen" im Recovery-Screen, KEIN Loeschen mehr von trip_track/
// fishing_session). Legacy-v27-active_trip_state-Eintraege OHNE passende Session bekommen beim
// expliziten Fortsetzen/Verwerfen idempotent (kein Duplikat bei Mehrfachaufruf) eine nachtraeglich
// erstellte Session aus den bereits vorhandenen echten Feldern — nichts wird erfunden/rekonstruiert.
// Quick-Log "Fang erfassen": Nullrunde-Checkbox und Anzahl-Feld waren bisher unabhaengig voneinander
// lesbar (Checkbox setzte beim Ankreuzen den Zaehler auf 0, ein erneutes Abwaehlen stellte ihn nie
// wieder her, gespeichert wurde ausschliesslich der Zaehlerwert) — plausibler Root-Cause fuer
// "Eigene Faenge: 0" trotz eines echten geloggten Fangs. Jetzt strukturell exklusiv + Validierung vor
// dem Speichern + vollstaendig abgewartetes Schreiben mit explizitem Fehler-Feedback (kein falsches
// "gespeichert" bei fehlgeschlagenem Write). Insights-Zaehler "Eigene Trips" zaehlt jetzt nur noch
// abgeschlossene (completed) Trips, laufende separat ausgewiesen, verworfene bleiben in der DB
// erhalten, aber ausserhalb der Hauptzaehler. Neues rein lesendes Debug-Panel "Data Integrity" unter
// ?hidebug=1 (Insights) — fishing_session/catch_event/orphan-Eintraege/active_trip_state/
// trip_track-Beziehung, keine Loesch-/Reparaturfunktion. Die beiden bereits vor v28 fehlenden
// historischen Trips werden NICHT rekonstruiert (kein erfundener Datensatz).
// TEIL B (29-Spot Product Coverage): alle 29 autoritativen HI-2C.1-Master-Spots (u.a. Scharbeutz,
// Haffkrug, Niendorf Badesteg/Mole/Blindenstrand) sind jetzt in der produktiven Spot-Auswahl (Trip-
// Start, Fang erfassen, Gewässer-Ansicht) waehlbar — additiv ueber die bereits bestehende, bei jedem
// App-Start laufende reconcileReferenceData()-Idempotenz-Logik (seed-data.js), funktioniert daher
// auch auf einer bestehenden Installation, OHNE Nutzerdaten anzufassen. ID-Strategie (Auftrag
// Abschnitt 13): alle 29 Spots bekommen den garantiert kollisionsfreien Praefix "m29-" (3 der 29
// Original-IDs — bliesdorf/groemitz/dahmeshoeved — waeren sonst mit bereits bestehenden,
// snake_case-identischen SPOT_STATS-IDs kollidiert und haetten diese beim naechsten Reconcile-Lauf
// STILL UEBERSCHRIEBEN). Alle 14 bisherigen SPOT_STATS-spot_ids + "herrenwyk" bleiben zu 100%
// unveraendert. Neue Spots erben KEINEN historischen SPOT_STATS-Wert (fangbuch_n bleibt null,
// Gewässer-Ansicht zeigt ehrlich "Keine eigenen historischen Daten" statt "wenig Daten"). HI-2C
// selbst (SPOT_GEO_METADATA, hourly-intelligence.js, 13 Spots) UNVERAENDERT — die 29-Spot-Liste
// speist NICHT automatisch die HI-2C-Rankingbasis (das ist strukturell unmoeglich, da HI-2C
// ausschliesslich SPOT_GEO_METADATA liest, nie den IndexedDB-"spot"-Store).
// TEIL C (Personal Fishing Window): NEUE Datei js/personal-fishing-window.js
// (window.FIPersonalWindow) — reine Produkt-/Nutzer-Constraint-Schicht, liest AUSSCHLIESSLICH die
// bereits oeffentlichen HI-2B-Test-Hook-Funktionen (buildWindowCandidates/deduplicateOverlapping aus
// window.FIHourlyWindowIntelligence), hourly-window-intelligence.js selbst UNVERAENDERT. Der
// Co-Pilot ("Wann?", Hero-Karte + 5-Tage-Ausblick) zeigt jetzt nur noch das beste HI-2B-Fenster
// INNERHALB von Sonnenaufgang-1h bis Sonnenuntergang+1h (FISHING_WINDOW_PREFERENCE) statt eines
// moeglichen Nachtfensters — HI-2B bewertet weiterhin intern alle 24h, KEINE Renormalisierung der
// relativeOpportunity-Skala auf den Korridor. ?hidebug=1 zeigt zusaetzlich RAW HI-2B-Fenster/
// erlaubten Korridor/produktiv empfohlenes Fenster nebeneinander (Transparenz), fuer heute UND jeden
// Tag im 5-Tage-Ausblick einzeln (eigener Sonnenauf-/-untergang pro Tag).
// KEINE DB_VERSION-Aenderung (bleibt 8 — status/completed_at/abandoned_at/legacy_recovered auf
// fishing_session und access_modes/spot_layer/source_spot_intelligence_id auf spot sind rein additive
// Felder auf bereits bestehenden Stores, kein neuer Store/Index noetig). EIN neuer SHELL_FILES-Eintrag
// (js/personal-fishing-window.js). v27: Fishing Intelligence v1 — Test Data Cleanup Sprint
// (03.09.2026). NEUE, rein additive Funktion "Testdaten bereinigen" unter Insights (Datenverwaltung):
// der Nutzer kann einzelne, EXPLIZIT ausgewaehlte eigene Touren (fishing_session) samt tatsaechlich
// verknuepfter Datensaetze (catch_event/trip_track/environmental_snapshot/shadow_evaluation, siehe
// vollstaendiges Datenmodell-Audit in claude/PHASE_DATA_CLEANUP_IMPLEMENTATION_REPORT.md) endgueltig
// loeschen — KEINE automatische Testdaten-Erkennung, KEIN "Alle loeschen", KEIN IndexedDB-Reset. NEUE
// Hilfsfunktion FIDB.deleteMany() (js/db.js) fuehrt die Loeschung in EINER atomaren IndexedDB-
// Transaktion ueber alle betroffenen Stores aus. intelligence_report/observation/die drei globalen
// HI-Forecast-Caches (hourly_shadow_snapshot/hourly_window_shadow_prediction/
// where_spot_shadow_prediction)/Referenzdaten (species/water/spot)/Spot Intelligence Metadata werden
// NIE angefasst (nachweislich nicht session-gebunden bzw. globale/Referenzdaten). Pending
// sync_queue-Eintraege der geloeschten Datensaetze werden mitbereinigt, damit nichts erneut in die
// Cloud geschrieben wird — die Cloud-Kopie (Supabase) selbst kann von dieser rein lokalen Funktion
// NICHT geloescht werden, das wird im UI-Hinweistext und im Sprint-Bericht ehrlich dokumentiert.
// KEINE DB_VERSION-Aenderung (bleibt 8, kein neuer Store/Index/Feld). KEIN SHELL_FILES-Eintrag
// hinzugekommen (keine neue Skriptdatei, die Funktion lebt additiv in js/app.js/js/db.js/
// css/style.css). Champion/Fangindex/SPOT_STATS/HI-1/HI-2A/HI-2A.1/HI-2B/HI-2C/HI-2C.1-Spot-
// Metadaten/WHAT-Intelligence/5-Tage-Logik/Co-Pilot-Entscheidungslogik unveraendert (Model Scope
// Lock, Auftrag Abschnitt 10). v26: Fishing Intelligence v1 — Product Finish Sprint
// (03.09.2026). NEUE Datei js/what-intelligence.js (window.FIWhatIntelligence, WHAT_SCORING_IMPACT
// = "none"): erstmals produktsichtbare Koeder-/Fliegen-Intelligenz, AUSSCHLIESSLICH aus der bereits
// dokumentierten Sea Trout Lure & Fly Intelligence KB (claude/sea_trout_lure_fly_intelligence_kb_v1.md),
// ohne jeden Einfluss auf Champion/Fangindex/SPOT_STATS/HI-2B/HI-2C (reine, deterministische
// Orchestrations-/Praesentationsschicht, kein neues Scoring). js/app.js: viewCoPilot()/
// buildMefoCopilotPanels() komplett neu orchestriert nach der geforderten Informationsarchitektur
// (Lohnt es sich?/Wann?/Wo?/Was?/Warum?/Live-Bedingungen/Naechste 5 Tage), "Frag meine Angeldaten"
// nur noch unter ?hidebug=1 sichtbar (vorher unfertig prominent in Insights). Champion-Formel/
// Saisonfaktor/Temperaturfaktor/Tier-Schwellen/SPOT_STATS/Challenger/HI-1/HI-2A.1/HI-2B-Formel-
// Gewichte/HI-2C-Scoring/Spot-Metadaten (spot-intelligence-data.js) UNVERAENDERT (Model Scope Lock,
// Auftrag Abschnitt 2 — siehe Model Scope Audit im Product Change Report). DB_VERSION unveraendert
// (bleibt 8) — keine neue Persistenz noetig, WHAT ist zustandslos. Reiner Cache-Version-Bump plus
// ein neues SHELL_FILES-Element (js/what-intelligence.js), sonst identisches Service-Worker-
// Verhalten (Cache-first, wie unten dokumentiert). v25: Phase HI-2C.1 E2E-Reparatur-Build (03.09.2026) — REIN
// vorsorglicher Cache-Version-Bump, KEINE Code-/Logikaenderung an Champion/Fangindex/SPOT_STATS/
// HI-1/HI-2A/HI-2A.1/HI-2B/HI-2C-Scoring/Cloud/DB. Grund: nach dem v24-Build wurde live beobachtet,
// dass js/spot-intelligence-data.js zunaechst 404'te; nach Behebung des 404 blieb
// window.FISpotIntelligenceData im Browser dennoch zeitweise "undefined" und das neue Debug-Panel
// erschien nicht — ein Symptombild, das exakt zum bereits einmal aufgetretenen Muster "gemischte
// GitHub-Pages-/Service-Worker-Cache-Version" passt (alte gecachte Antwort unter einer URL, die nie
// neu abgerufen wird, solange derselbe CACHE_NAME aktiv bleibt — der Fetch-Handler ist bewusst
// cache-first, siehe unten). Diese Session konnte die Live-Deployment-Umgebung nicht direkt
// inspizieren; ein Node/Playwright-Audit des aktuellen Codestands fand KEINEN Syntaxfehler und KEINE
// Logikluecke in js/spot-intelligence-data.js/js/app.js (echter Browser-E2E-Test, 18/18 bestanden,
// siehe HI2C1_E2E_REPAIR_REPORT.md) — der wahrscheinlichste Erklaerungsansatz bleibt eine veraltete
// Service-Worker-Cache-Instanz. Ein neuer CACHE_NAME erzwingt bei jedem Client einen vollstaendigen
// Neuabruf ALLER SHELL_FILES vom Netz (install-Event, cache.addAll) und loescht beim naechsten
// activate-Event JEDE Cache-Instanz mit abweichendem Namen (bestehende activate-Logik, unveraendert)
// — IndexedDB/Nutzerdaten sind davon nicht betroffen (siehe Lehre aus einem frueheren, aehnlichen
// Cache-Vorfall: nur Cache loeschen + SW neu registrieren, NIEMALS IndexedDB anfassen). v24: Phase HI-2C.1 "Spot Intelligence Metadata Layer" (03.09.2026) — NEUE Datei
// js/spot-intelligence-data.js (window.FISpotIntelligenceData): REINE, statische Datenschicht mit
// granularen physikalischen/geografischen Metadaten (Geometrie, Bathymetrie, Substrat, Habitat,
// kuenstliche Struktur, Hydrodynamik-Hypothesen, Ufer-/Boot-Zugriffsprofil, Provenance, Evidenzgrad,
// Unknowns) fuer alle 29 vom Nutzer autoritativ vorgegebenen Spots (Master-Handover Abschnitt 17/40).
// SPOT_INTELLIGENCE_SCORING_IMPACT ist strukturell "none" — die Datei wird von KEINER Scoring-Funktion
// gelesen (Champion/meerforelle-model.js, Challenger/challenger-state.js, HI-2B/
// hourly-window-intelligence.js, HI-2C/where-spot-intelligence.js bleiben unveraendert und referenzieren
// diese Datei an keiner Stelle, siehe Selbst-Audit im Implementierungsbericht). Kein neuer IndexedDB-Store,
// KEINE DB-Versionsaenderung (reine statische Konstante, kein Persistenzbedarf). Ergaenzt, NICHT ersetzt,
// die bestehenden, bewusst unangetasteten groeberen Spot-Layer FIMefoModel.SPOT_STATS
// (meerforelle-model.js, 14 Orte, historische Fangquoten) und SPOT_GEO_METADATA
// (hourly-intelligence.js, 13 Orte, lat/lon/shoreOrientationDeg fuer HI-2C). Optionaler Debug-Viewer
// "Spot Intelligence Metadata" unter ?hidebug=1 (falls in dieser Phase ergaenzt, siehe Implementierungs-
// bericht) zeigt AUSSCHLIESSLICH beschreibende Metadaten — kein Rating/Bonus/Fangwahrscheinlichkeit/
// Empfehlung/Rang. Champion/Fangindex/Tiers/SPOT_STATS/Wasserstandsmodell/Windmodell/Koederlogik/HI-1/
// HI-2A/HI-2A.1/HI-2B/HI-2C-Scoring-Code unveraendert (Auftrag Abschnitt 38 Scope Lock). v23: Phase HI-2C "WHERE Shadow Engine - Dynamic Spot Suitability & Top-3" (31.08.2026) — NEUE Datei js/where-spot-intelligence.js (window.FIWhereIntelligence): reine additive Konsumenten-Schicht, scope-begrenzt auf mefo x luebecker_bucht x shore (andere Kombinationen liefern unsupported/not_applicable). Nutzt EIN bereits geladenes HI-2A.1-Batch-Forecast plus die reine HI-2B-Rankingfunktion (kein zweiter Netzwerk-Request), aggregiert robuste Fensterbedingungen (Median/zirkulaeres Mittel, keine Peak-Stunde) und berechnet pro Spot rawSuitability = BASE + WAVE_ONSHORE_WEIGHT * (wave.onshoreWaveComponent > 0), GENAU EINE experimentelle biologische Regel (WAVE_ONSHORE_ACTIVATION, Grade C/D, hypothesisId H4) — Windgeometrie wird vollstaendig berechnet/gezeigt, aber bewusst NICHT gescort (Phase 2.5: berechnete Wind-Exposure lieferte OOS AUC 0,42-0,43, unter Zufallsniveau, identischer Ansatz). Keine historischen SPOT_STATS-Fangquoten im Score (nur Spot-IDs gelesen), keine absolute Fangwahrscheinlichkeit, kein "%". IndexedDB v7->v8 (NEUER Store where_spot_shadow_prediction, unveraenderliche Top-3-Predictions pro Fenster). Debug-Panel um "WHERE Intelligence"-Panel erweitert (?hidebug=1, weiterhin kein produktives UI, boat-Modus liefert bewusst keine Ufer-Top-3). Champion/Fangindex/Tiers/SPOT_STATS/Wasserstandsmodell/Windmodell/Koederlogik/HI-1/HI-2A/HI-2A.1/HI-2B-Code unveraendert. v22 (Phase HI-2B, 31.08.2026): WHEN Shadow Engine - Hourly Opportunity & 2-3h Window Ranking. — NEUE Datei js/hourly-window-intelligence.js (window.FIHourlyWindowIntelligence): reine additive Konsumenten-Schicht ueber dem live-verifizierten HI-2A.1-Batch-Forecast (buildHourlyForecastSeries), erstmals eine WHEN-Logik (relativeOpportunity pro Stunde, 2h/3h-Fenster, Tagesgruppierung Europe/Berlin, Daily-Contrast, Confidence getrennt von Opportunity). rawOpportunity = BASE + THERMAL_SOLAR_WEIGHT[thermalRegime] * lowSolarProxy(solarElevationDeg) — kontinuierliche Sigmoid-Transformation statt fester Uhrzeit/diskreter Lichtphase, alle Gewichte EXPERIMENTAL/dokumentiert. Explizit KEINE absolute Fangwahrscheinlichkeit, KEIN Windbonus, KEIN Wavebonus, KEIN Pegelbonus, KEIN Pressurebonus. IndexedDB v6->v7 (NEUER Store hourly_window_shadow_prediction, unveraenderliche Predictions pro lokalem Tag, keine volle Rohserie persistiert). Debug-Panel um "WHEN Intelligence"-Panel erweitert (?hidebug=1, weiterhin kein produktives UI). Champion/Fangindex/Tiers/Wasserstandsmodell/Windmodell/Spot-Ranking/Lure-Intelligence/Voice/Spot-Namen/-Statistiken/Spot-Geo-Metadaten/HI-1/HI-2A/HI-2A.1-Code unveraendert. v21 (Phase HI-2A.1, 31.08.2026): Marine Provider Separation (getWaterTempRangeRaw/getWaveRangeRaw statt getMarineRangeRaw) + Forecast-Horizon-Fix, live verifiziert. v20 (Phase HI-2A, 31.08.2026): 120h-Batch-Forecast-Architektur, Spot-Geo-Modell mit Provenance. v19 (Phase HI-1, 30.08.2026): IndexedDB v5->v6 (Store hourly_shadow_snapshot), Solar-/Thermal-/Wind-Shore-Features, Shadow-Hypothesis-Registry.
const SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/style.css",
  "./js/db.js",
  "./js/sync.js",
  "./js/gazetteers.js",
  "./js/extractor.js",
  "./js/astro.js",
  "./js/providers.js",
  "./js/registry.js",
  "./js/enrichment.js",
  "./js/meerforelle-model.js",
  "./js/challenger-state.js",
  "./js/shadow.js",
  "./js/hourly-intelligence.js",
  "./js/hourly-window-intelligence.js",
  "./js/where-spot-intelligence.js",
  "./js/spot-intelligence-data.js",
  "./js/what-intelligence.js",
  "./js/personal-fishing-window.js",
  "./js/speech.js",
  "./js/seed-data.js",
  "./js/ui.js",
  "./js/app.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-192-maskable.png",
  "./icons/icon-512-maskable.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

// Herkunft der Domain, auf der die App selbst laeuft - NUR fuer diese wird der Cache-first-Pfad
// genutzt. Alles andere (externe APIs) geht direkt ans Netz, kein Caching, kein Vortaeuschen von
// Offline-Verfuegbarkeit fuer Umweltdaten.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    return; // externe API-Aufrufe unangetastet durchreichen
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return resp;
        })
        .catch(() => caches.match("./index.html"));
    })
  );
});
