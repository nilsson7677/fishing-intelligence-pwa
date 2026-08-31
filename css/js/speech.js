// SpeechToTextProvider-Abstraktion (Abschnitt 8) — siehe docs/STT_RESEARCH.md fuer die
// vollstaendige Recherche/Begruendung. Sprint 2 implementiert NUR BrowserSpeechToTextProvider
// (Web Speech API). Weitere Provider (On-Device/Cloud) sind bewusst NICHT implementiert — keine
// kostenpflichtige API ohne Nutzerfreigabe (Abschnitt 8/46).
//
// VOICE RELIABILITY LOOP (nach echtem Android-Test): Kernbefund war, dass eine "Voice Session"
// (das, was der Nutzer als EINE Aufnahme von Mikrofon-Start bis STOP versteht) technisch NICHT
// dasselbe ist wie eine einzelne Browser-`SpeechRecognition`-Instanz. `continuous:false` UND ein
// fehlender Restart-Mechanismus fuehrten dazu, dass die App die erste `onresult`-Endmeldung der
// Recognition-Engine (nach ca. 8s, Android-seitiges Verhalten) faelschlich als Ende der GESAMTEN
// Spracheingabe behandelt hat -> nur 1-2 Informationen kamen beim Extractor an.
//
// Architekturregel (siehe Auftrag): Recognition-Ende != Session-Ende, solange der Nutzer nicht
// selbst STOP gedrueckt hat. Diese Datei trennt beide Konzepte bewusst: `_beginRecognition()`
// erzeugt einzelne, kurzlebige Recognition-Instanzen; die Klasse selbst haelt den kumulierten
// Transkript-Zustand UEBER mehrere Instanzen hinweg und entscheidet, ob nach einem `onend`
// automatisch neu gestartet wird oder die Session wirklich beendet ist.
//
// RUNDE 4 — WICHTIGE KORREKTUR gegenueber Runde 3: der echte Android-Test zeigte, dass Android
// NICHT nur EIN finales Ergebnis pro logischem Satzteil liefert (mit vorherigen Interim-Stufen),
// sondern MEHRERE, jeweils LAENGER werdende Ergebnisse, die ALLE mit isFinal=true markiert sind
// UND jeweils an einem NEUEN Index in event.results stehen (z.B. Index 0 = "Kai-Uwe" (final),
// Index 1 = "Kai-Uwe hat" (final), Index 2 = "Kai-Uwe hat gestern" (final), ...). Die Runde-3-
// Logik (idempotent PRO INDEX ueberschreiben) half hier nicht, weil jede Revision einen NEUEN
// Index bekam - es waren aus Sicht des Codes "verschiedene" finale Segmente. Die eigentliche Frage
// ist daher NICHT mehr nur "isFinal true/false?", sondern "ist dieses Final-Ergebnis ein NEUES
// Segment - oder nur eine laengere Fassung des vorherigen Segments?". Siehe `_mergeGrowingSegments`
// weiter unten: die Erkennung erfolgt ueber einen INHALTLICHEN Praefix-Vergleich ZWISCHEN
// AUFEINANDERFOLGENDEN result-Eintraegen (nicht ueber eine globale "doppelte Woerter entfernen"-
// Heuristik auf dem fertigen String, die legitime Wiederholungen wie "sehr sehr langsam" zerstoeren
// wuerde).
//
// RUNDE 5 — der reale Android-Debug-Log (aus dem Runde-4-Testmodus) bestaetigte das erwartete
// Muster (mehrere wachsende isFinal=true-Ergebnisse an neuen Indizes fuer DASSELBE Segment) UND
// zeigte, dass der reine STRIKTE Zeichen-Praefix-Vergleich aus Runde 4 nicht in jedem Fall robust
// genug ist. Die Merge-Regel wurde daher auf die vom Auftrag vorgegebenen 5 Faelle praezisiert
// (siehe `_classifyCandidate`):
//   (1) neuer Kandidat ist identisch mit dem bisherigen Segment          -> ignorieren
//   (2) neuer Kandidat erweitert den bisherigen woertlich am Anfang      -> bisherigen ERSETZEN
//   (3) bisheriger Kandidat erweitert (ist laenger als) den neuen        -> neuen ignorieren
//       (Schutz gegen einen von der Recognition-Engine "zurueckgenommenen", kuerzeren Zwischenstand)
//   (4) sehr wenige abweichende Wortpositionen innerhalb der bisherigen Segmentlaenge UND neuer
//       Kandidat klar laenger (mehr Woerter)                            -> bisherigen ERSETZEN
//       (toleriert kleine Nachkorrekturen der Recognition-Engine an bereits gesprochenen Woertern,
//       die einen reinen Zeichen-Praefix-Vergleich brechen wuerden)
//   (5) sonst: kein Revisionsverhaeltnis erkennbar                       -> echtes neues Segment
// Bewusst KEINE zeitbasierte Pause-Erkennung als PRIMAERES Kriterium: ein Recognition-Restart ist
// bereits eine harte Instanzgrenze (neue Instanz = neue, leere Segmentliste), und zwei echte,
// unabhaengige Saetze erfuellen praktisch nie die strenge Wort-Uebereinstimmung aus Regel 4 - eine
// zusaetzliche starre Zeitschwelle wuerde das Risiko bergen, eine einzelne, natuerlich pausierte
// Aussage faelschlich in zwei Segmente zu zerreissen.
//
// RUNDE 7 — Real-Device-Regression nach Runde 6: ein NEUES Geraete-Muster zeigte eine Luecke in
// Regel 4. Bisher wurde Regel 4 ueber einen gemeinsamen WORT-PRAEFIX bestimmt, der beim ERSTEN
// abweichenden Wort abbricht (_commonWordPrefixLen) - das erkennt zuverlaessig Nachkorrekturen am
// ENDE des bisherigen Segments (z.B. "...ein" -> "...eine Mefo..."), nicht aber eine Korrektur
// MITTEN im Satz, waehrend alle nachfolgenden Woerter unveraendert bleiben. Genau das beobachtete
// der Nutzer real: "Kai-Uwe hat gestern im Bliesdorf ..." wurde von Android zu "Kai-Uwe hat gestern
// in Bliesdorf ..." korrigiert (nur "im" -> "in", alle folgenden Woerter identisch). Ein Praefix-
// Vergleich, der bei "im"/"in" abbricht, sieht dann nur noch 3 von 6 gemeinsamen Woertern - viel zu
// wenig fuer die alte Abdeckungsschwelle - und haengt den Kandidaten faelschlich als NEUES Segment
// an, statt ihn als Revision zu erkennen (Ergebnis: doppelter, unleserlicher Rohtext). Fix: statt
// eines Praefixes, der beim ersten Mismatch stoppt, wird jetzt die GESAMTE Ueberlappung (Laenge des
// bisherigen, kuerzeren Segments) Wort-fuer-Wort verglichen und die Anzahl ABWEICHENDER Positionen
// gezaehlt (`_wordOverlapMismatches`) - ohne beim ersten Mismatch abzubrechen. Nur bei SEHR WENIGEN
// Abweichungen (kleine Nachkorrektur, kein neuer Satz) gilt weiterhin Regel 4. Das bleibt bewusst
// ein reiner Wort-fuer-Wort-POSITIONSVERGLEICH innerhalb des bereits gesprochenen Fensters - KEINE
// globale String-Deduplizierung, keine Wortverschiebung/Neuausrichtung, kein Vergleich ausserhalb
// dieses Fensters. Siehe test/voice_round7_test.js fuer das exakte Real-Device-Regressionsfixture
// (inkl. Sicherheitsnetz-Test, dass zwei echte unabhaengige Saetze weiterhin NICHT verschmolzen
// werden) und docs/STT_RESEARCH.md Nachtrag 13 fuer die vollstaendige Herleitung.

class SpeechToTextProvider {
  isAvailable() { throw new Error("not implemented"); }
  start() { throw new Error("not implemented"); }
  stop() { throw new Error("not implemented"); }
}

class BrowserSpeechToTextProvider extends SpeechToTextProvider {
  constructor() {
    super();
    this._Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
    this._recognition = null;       // die AKTUELL laufende Recognition-Instanz (oder null zwischen Restarts)
    this._generation = 0;           // Race-Condition-Schutz: jede _beginRecognition() erhoeht dies; Callbacks
                                     // einer ueberholten Instanz erkennen sich daran und werden ignoriert
    this._userStopped = false;      // true erst NACH explizitem stop() durch den Nutzer
    this._sessionFinished = false;  // Schutz gegen doppeltes Feuern von onSessionEnd
    // sessionFinalTranscript: NUR bereits abgeschlossene (committete) Recognition-Instanzen dieser
    // Session (Voice Reliability Loop Runde 3). Wird EINMAL pro Instanz in onend fortgeschrieben,
    // niemals in onresult - onresult darf nur den State DER AKTUELL LAUFENDEN Instanz veraendern
    // (siehe _instanceFinalByIndex/_instanceInterim in _beginRecognition). Das trennt bewusst
    // "abgeschlossen" von "wird gerade erkannt", statt beides in einem Feld zu vermischen.
    this._sessionFinalTranscript = "";
    this._restartCount = 0;
    this._maxRestarts = 30;         // Sicherheitsnetz gegen Endlosschleifen (z.B. defektes Mikrofon)
    this._restartDelayMs = 80;      // kurze Pause vor Neustart (manche Android-Chrome-Versionen werfen
                                     // InvalidStateError bei sofortigem re-start() innerhalb von onend)
    this._callbacks = null;
    // Debug-Log (Runde 4, "Bitte zuerst instrumentieren"): protokolliert JEDES onresult-Ereignis
    // roh, BEVOR irgendeine Merge-/Dedup-Logik angewendet wird - damit sich das tatsaechliche
    // Android-Verhalten beim naechsten Geraetetest exakt nachvollziehen laesst, falls die
    // Merge-Logik in einem noch nicht bedachten Fall versagt. Immer aktiv (vernachlaessigbarer
    // Overhead, auf 300 Eintraege begrenzt), aber nur im Testmodus (URL-Flag ?voicedebug=1) in der
    // UI sichtbar gemacht (siehe app.js). Wird bei jedem start() geleert.
    this._debugSeq = 0;
    this._debugLog = [];
  }

  isAvailable() {
    return this._Recognition !== null && (window.isSecureContext !== false);
  }

  getDebugLog() {
    return this._debugLog.slice();
  }

  _pushDebug(entry) {
    this._debugLog.push(entry);
    if (this._debugLog.length > 300) this._debugLog.shift();
    this._callbacks?.onDebug?.(entry);
  }

  // Callback-Schnittstelle (onDebug ist NEU in Runde 4, alle anderen unveraendert):
  //   onInterim(text)        — LIVE-VORSCHAU = sessionFinalTranscript + currentInterimTranscript
  //                            (Runde 3: vorher wurde hier nur das lose Interim-Fragment der
  //                            aktuellen Instanz durchgereicht - jetzt der volle, wachsende Satz,
  //                            wie im Auftrag als Live-Anzeige-Prinzip vorgegeben). Wird bei JEDEM
  //                            onresult komplett NEU BERECHNET, nicht angehaengt.
  //   onSessionEnd(fullText) — feuert GENAU EINMAL, wenn die gesamte Voice Session beendet ist
  //                            (Nutzer hat STOP gedrueckt, ODER ein nicht behebbarer Fehler trat auf).
  //                            fullText ist NUR sessionFinalTranscript (plus ggf. ein sauber per
  //                            isFinal uebernommener letzter Rest) - NIE ungesicherte Interim-Reste.
  //   onError(message)       — nicht-fatale Warnung (Toast); Session laeuft ggf. weiter, ODER
  //                            fataler Fehler, der direkt danach auch onSessionEnd ausloest
  //   onDebug(entry)         — OPTIONAL, feuert bei JEDEM rohen onresult-Ereignis (vor jeder Merge-
  //                            Logik) mit { seq, resultIndex, resultsCount, entries, instanceId, t }.
  //                            Nur fuer den Testmodus gedacht (siehe app.js ?voicedebug=1).
  start(onInterim, onSessionEnd, onError, onDebug) {
    if (!this.isAvailable()) { onError("Spracherkennung auf diesem Geraet/Browser nicht verfuegbar."); return; }
    if (!navigator.onLine) {
      onError("Spracherkennung braucht in diesem Browser eine Internetverbindung (Cloud-basierte " +
        "Erkennung, siehe docs/STT_RESEARCH.md) — aktuell offline. Bitte Text eintippen.");
      return;
    }
    this._callbacks = { onInterim, onSessionEnd, onError, onDebug };
    this._userStopped = false;
    this._sessionFinished = false;
    this._sessionFinalTranscript = "";
    this._restartCount = 0;
    this._debugSeq = 0;
    this._debugLog = [];
    this._beginRecognition();
  }

  _finishSession() {
    if (this._sessionFinished) return; // Schutz: darf nur einmal feuern (z.B. bei stop() waehrend Restart-Race)
    this._sessionFinished = true;
    this._recognition = null;
    this._callbacks?.onSessionEnd?.(this._sessionFinalTranscript.trim());
  }

  // RUNDE 4 — Kernstueck der segmentbasierten Final-Verarbeitung. Praeziser Auftrag: "Ist dieses
  // neue Final-Ergebnis ein neues Segment - oder nur eine laengere Revision des vorherigen
  // Segments?" Die Antwort wird NICHT global/String-weit ("doppelte Woerter entfernen") gesucht -
  // das wuerde legitime Wiederholungen wie "sehr sehr langsam" zerstoeren -, sondern ausschliesslich
  // durch einen Praefix-Vergleich ZWISCHEN ZWEI AUFEINANDERFOLGENDEN result-Eintraegen (derselben
  // Instanz, in der Reihenfolge von ev.results): wenn der naechste Eintrag mit dem Text des
  // vorherigen (normalisiert) beginnt, ist er eine Revision desselben Segments -> ERSETZEN. Sonst
  // ist er ein neues, unabhaengiges Segment -> ANHAENGEN. Diese Funktion wird bei JEDEM onresult
  // komplett neu ueber das gesamte aktuelle ev.results-Array ausgefuehrt (kein inkrementeller
  // State ausserhalb von ev.results selbst) und ist damit von Natur aus idempotent.
  _normalizeForPrefixCompare(s) {
    // Nachsichtig gegenueber Gross-/Kleinschreibung und abschliessenden Satzzeichen, DAMIT eine
    // spaete Interpunktions-/Gross-Korrektur durch die Recognition-Engine nicht faelschlich als
    // "neues Segment" gewertet wird - aber weiterhin ein STRIKTER Praefix-Vergleich, keine Fuzzy-
    // Distanz. Das ist bewusst konservativ: lieber ein paar Grenzfaelle nicht zusammenfuehren, als
    // durch zu aggressives Matching zwei tatsaechlich unabhaengige Saetze faelschlich zu verschmelzen.
    return s.trim().toLowerCase().replace(/[.,!?;:]+$/, "");
  }

  _wordsOf(s) {
    return this._normalizeForPrefixCompare(s).split(/\s+/).filter(Boolean);
  }

  _commonWordPrefixLen(aWords, bWords) {
    let n = 0;
    while (n < aWords.length && n < bWords.length && aWords[n] === bWords[n]) n++;
    return n;
  }

  // RUNDE 7 — ersetzt die reine "stoppt beim ersten Mismatch"-Praefixzaehlung fuer Regel 4 (siehe
  // Kommentarblock oben). Vergleicht die ERSTEN min(aWords.length, bWords.length) Woerter beider
  // Listen PAARWEISE UEBER DAS GESAMTE FENSTER (bricht NICHT beim ersten Mismatch ab) und liefert
  // { mismatches, overlapLen } zurueck. Woerter, die NUR im laengeren neuen Kandidaten zusaetzlich
  // vorkommen (weil der Satz einfach weitergesprochen wurde), liegen ausserhalb des Fensters und
  // zaehlen bewusst NICHT als Abweichung - hier geht es ausschliesslich um Nachkorrekturen INNERHALB
  // des bereits gesprochenen Teils.
  _wordOverlapMismatches(aWords, bWords) {
    const overlapLen = Math.min(aWords.length, bWords.length);
    let mismatches = 0;
    for (let i = 0; i < overlapLen; i++) {
      if (aWords[i] !== bWords[i]) mismatches++;
    }
    return { mismatches, overlapLen };
  }

  // RUNDE 5 — die 5-Fall-Merge-Regel aus dem Auftrag. Gibt zurueck:
  //   "replace"          — neuer Kandidat ersetzt das bisherige Segment (Faelle 2 & 4)
  //   "ignore-duplicate"  — identisch, nichts aendert sich (Fall 1)
  //   "ignore-shorter"    — bisheriges Segment ist bereits die vollstaendigere Fassung (Fall 3)
  //   "new-segment"       — kein Revisionsverhaeltnis erkennbar (Fall 5)
  _classifyCandidate(prevText, newText) {
    const a = this._normalizeForPrefixCompare(prevText);
    const b = this._normalizeForPrefixCompare(newText);
    if (!a) return "replace";               // kein/leeres Vorgaenger-Segment -> einfach uebernehmen
    if (a === b) return "ignore-duplicate"; // Fall 1
    if (b.startsWith(a)) return "replace";  // Fall 2: neuer Kandidat erweitert den bisherigen woertlich
    if (a.startsWith(b)) return "ignore-shorter"; // Fall 3: bisheriger ist bereits die laengere Fassung

    // Fall 4 (Runde 7 verallgemeinert, siehe Kommentarblock oben): kein exakter Zeichen-Praefix,
    // aber innerhalb der bisherigen Segmentlaenge weichen nur SEHR WENIGE Wortpositionen ab UND der
    // neue Kandidat ist klar laenger -> toleriert kleine Nachkorrekturen einzelner Woerter (egal ob
    // am Ende ODER MITTEN im Satz), die einen reinen Zeichen-Praefix-Vergleich brechen wuerden, ohne
    // bei zwei echten, unabhaengigen Saetzen faelschlich anzuschlagen (die weichen fast ueberall ab).
    const aWords = this._wordsOf(prevText);
    const bWords = this._wordsOf(newText);
    const clearlyLonger = bWords.length > aWords.length;
    if (clearlyLonger && aWords.length >= 2) {
      const { mismatches, overlapLen } = this._wordOverlapMismatches(aWords, bWords);
      const allowedMismatches = Math.max(1, Math.floor(aWords.length * 0.15));
      const matches = overlapLen - mismatches;
      const smallRevision = mismatches >= 1 && mismatches <= allowedMismatches;
      const exactPrefixOfOverlap = mismatches === 0; // z.B. Interpunktions-/Gross-Abweichung o.ae.
      if ((smallRevision || exactPrefixOfOverlap) && matches >= 2 && matches / overlapLen >= 0.7) {
        return "replace";
      }
    }

    return "new-segment"; // Fall 5
  }

  _mergeGrowingSegments(rawEntries) {
    const merged = [];
    for (const entry of rawEntries) {
      const text = entry.transcript.trim();
      if (!text) continue;
      const last = merged[merged.length - 1];
      if (!last) { merged.push({ text, final: entry.isFinal }); continue; }
      const verdict = this._classifyCandidate(last.text, text);
      if (verdict === "replace") {
        merged[merged.length - 1] = { text, final: entry.isFinal };
      } else if (verdict === "ignore-duplicate" || verdict === "ignore-shorter") {
        // Bisheriges Segment bleibt inhaltlich stehen — aber falls der ignorierte Kandidat final
        // war und das bisherige Segment das noch nicht ist, wird der Final-Status trotzdem
        // uebernommen (der Inhalt ist ja mindestens genauso vollstaendig).
        if (entry.isFinal && !last.final) merged[merged.length - 1] = { text: last.text, final: true };
      } else {
        merged.push({ text, final: entry.isFinal }); // Fall 5: echtes neues, unabhaengiges Segment
      }
    }
    return merged;
  }

  _beginRecognition() {
    const myGeneration = ++this._generation;
    const rec = new this._Recognition();
    rec.lang = "de-DE";
    rec.continuous = true;       // WICHTIG (Kernfix Runde 1): nicht nach der ersten Sprechpause abbrechen
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    // Instanz-lokaler State (Runde 4 — segmentbasierte Final-Verarbeitung). BEWUSST pro Recognition-
    // Instanz neu angelegt (Closure-Variable, nicht this.*): jede neue Instanz nach einem Restart
    // faengt bei einer LEEREN Segmentliste an, damit bereits committete (sessionFinalTranscript)
    // Fragmente niemals erneut hineingeraten koennen.
    //   instanceSegments: Array<{text, final}> — wird bei JEDEM onresult KOMPLETT NEU aus dem
    //     gesamten aktuellen ev.results-Array (ab Index 0) berechnet (siehe _mergeGrowingSegments
    //     weiter unten), NICHT inkrementell fortgeschrieben. Dadurch ist die Verarbeitung von Natur
    //     aus idempotent und robust sowohl gegen einen unzuverlaessigen ev.resultIndex als auch
    //     gegen das in Runde 4 beobachtete Android-Verhalten (mehrere, jeweils laenger werdende
    //     isFinal=true-Ergebnisse an verschiedenen Indizes fuer DASSELBE Segment).
    let instanceSegments = [];

    const instanceFinalSoFar = () => instanceSegments
      .filter((s) => s.final).map((s) => s.text).join(" ").trim();

    rec.onresult = (ev) => {
      if (myGeneration !== this._generation) return; // veraltete Instanz (Race Condition) -> ignorieren

      // Rohdaten fuer das Debug-Log (Runde 4) — UNVERAENDERT, bevor irgendeine Merge-Logik lief:
      this._debugSeq++;
      const rawEntries = [];
      for (let i = 0; i < ev.results.length; i++) {
        rawEntries.push({ index: i, isFinal: !!ev.results[i].isFinal, transcript: ev.results[i][0].transcript });
      }
      this._pushDebug({
        seq: this._debugSeq, resultIndex: ev.resultIndex, resultsCount: ev.results.length,
        entries: rawEntries, instanceId: myGeneration, t: Date.now(),
      });

      // Absichtlich das GESAMTE ev.results-Array ab Index 0 durchgehen (nicht ab ev.resultIndex):
      // manche Android-Chrome-Versionen liefern resultIndex nicht zuverlaessig fortlaufend.
      instanceSegments = this._mergeGrowingSegments(rawEntries);

      const finalSoFar = instanceFinalSoFar();
      const lastSeg = instanceSegments[instanceSegments.length - 1];
      const interimNow = (lastSeg && !lastSeg.final) ? lastSeg.text : ""; // ERSETZT, nie angehaengt
      const livePreview = [this._sessionFinalTranscript, finalSoFar, interimNow]
        .filter(Boolean).join(" ").trim();
      this._callbacks?.onInterim?.(livePreview);
    };

    rec.onerror = (ev) => {
      if (myGeneration !== this._generation) return;
      if (ev.error === "no-speech") {
        // Kein echter Fehler aus Nutzersicht — Android beendet die Recognition oft nach Stille;
        // das eigentliche Verhalten (Neustart oder Ende) entscheidet onend, hier nichts weiter tun.
        return;
      }
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        // Mikrofonberechtigung fehlt/entzogen -> Neustarten waere sinnlos und wuerde nur denselben
        // Fehler wiederholen. Session sofort und endgueltig beenden.
        this._userStopped = true;
        this._callbacks?.onError?.("Mikrofon-Zugriff wurde verweigert. Bitte in den Browser-/App-Einstellungen erlauben.");
        return; // onend folgt unmittelbar und ruft _finishSession() auf
      }
      if (ev.error === "network") {
        if (!navigator.onLine) {
          // Echter Verbindungsabbruch waehrend der Session (nicht nur beim Start geprueft) -> nicht
          // endlos gegen eine tote Verbindung neu starten.
          this._userStopped = true;
          this._callbacks?.onError?.("Internetverbindung während der Spracherkennung verloren. " +
            "Bisher erkannter Text wird übernommen — bitte fehlende Angaben ergänzen.");
        } else {
          this._callbacks?.onError?.("Kurzer Netzwerkfehler bei der Spracherkennung — versuche automatisch weiter…");
        }
        return; // onend entscheidet ueber Neustart bzw. _finishSession()
      }
      // sonstige Fehler: als nicht-fatale Warnung behandeln, onend entscheidet weiter
      this._callbacks?.onError?.(`Spracherkennungsfehler: ${ev.error}`);
    };

    rec.onend = () => {
      if (myGeneration !== this._generation) return; // veraltete Instanz -> ignorieren
      this._recognition = null;
      // KERNSTUECK (seit Runde 3, Merge-Logik in Runde 4 geschaerft): genau HIER, beim tatsaechlichen
      // Ende DIESER Instanz, wird ihr bisher gesammelter finaler Text (aus den zu diesem Zeitpunkt
      // zusammengefuehrten Segmenten, siehe _mergeGrowingSegments) EIN EINZIGES MAL in den Session-
      // weiten Akkumulator uebernommen — egal ob die Session danach neu startet oder wirklich endet.
      // Nicht-finale Segmentreste werden NICHT uebernommen: nicht final bestaetigter Text darf nie
      // in sessionFinalTranscript landen, auch nicht beim Restart. Da instanceFinalSoFar() bei jedem
      // onresult komplett NEU aus dem aktuellen Segment-Snapshot berechnet wird (nicht additiv ueber
      // mehrere Aufrufe summiert), kann es hier auch bei der Sequenz onresult -> stop() -> onend zu
      // KEINEM Doppelcommit kommen: es wird immer nur der EINE, aktuellste Snapshot committet.
      const committed = instanceFinalSoFar();
      if (committed) {
        this._sessionFinalTranscript = (this._sessionFinalTranscript + " " + committed).trim();
      }
      if (this._userStopped) { this._finishSession(); return; }
      if (this._restartCount >= this._maxRestarts) {
        this._callbacks?.onError?.("Spracherkennung wurde zu oft unterbrochen — Aufnahme wird beendet, bitte Text prüfen/ergänzen.");
        this._finishSession();
        return;
      }
      // ARCHITEKTURREGEL: Recognition-Ende != Session-Ende, solange der Nutzer nicht STOP gedrueckt hat.
      this._restartCount++;
      setTimeout(() => {
        if (this._userStopped || this._sessionFinished) return; // STOP kam waehrend der Wartezeit (Race)
        this._beginRecognition();
      }, this._restartDelayMs);
    };

    this._recognition = rec;
    try {
      rec.start();
    } catch (e) {
      // z.B. InvalidStateError bei zu schnellem Neustart -> wie einen erwarteten Restart behandeln
      this._recognition = null;
      if (this._userStopped) { this._finishSession(); return; }
      if (this._restartCount >= this._maxRestarts) {
        this._callbacks?.onError?.("Spracherkennung konnte nicht gestartet werden.");
        this._finishSession();
        return;
      }
      this._restartCount++;
      setTimeout(() => {
        if (this._userStopped || this._sessionFinished) return;
        this._beginRecognition();
      }, this._restartDelayMs);
    }
  }

  // Nutzer-initiiertes STOP — einzige Stelle, die _userStopped setzt und damit den Auto-Restart
  // in onend abschaltet. Deckt explizit den Fall "STOP waehrend eines laufenden Restarts" ab: dann
  // ist this._recognition gerade null (Instanz bereits beendet, naechste noch nicht gestartet) ->
  // Session wird direkt finalisiert, statt auf eine Instanz zu warten, die nie mehr kommt.
  stop() {
    this._userStopped = true;
    if (this._recognition) {
      try { this._recognition.stop(); } catch (e) { this._finishSession(); }
      // WICHTIG: rec.stop() beendet die Erkennung "sanft" (liefert ggf. noch ein letztes finales
      // Ergebnis via onresult, DANACH onend) - im Unterschied zu abort(), das sofort abbricht und
      // das letzte Fragment verlieren wuerde. onend ruft dann _finishSession() auf.
    } else {
      this._finishSession(); // kein aktives Recognition-Objekt (z.B. mitten in einer Restart-Pause)
    }
  }
}

window.FISpeech = { SpeechToTextProvider, BrowserSpeechToTextProvider };
