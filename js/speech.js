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
    this._finalTranscript = "";     // ueber ALLE Recognition-Instanzen dieser Session akkumuliert
    this._restartCount = 0;
    this._maxRestarts = 30;         // Sicherheitsnetz gegen Endlosschleifen (z.B. defektes Mikrofon)
    this._restartDelayMs = 80;      // kurze Pause vor Neustart (manche Android-Chrome-Versionen werfen
                                     // InvalidStateError bei sofortigem re-start() innerhalb von onend)
    this._callbacks = null;
  }

  isAvailable() {
    return this._Recognition !== null && (window.isSecureContext !== false);
  }

  // Callback-Schnittstelle (bewusst unveraendert ggue. vorheriger Version, damit app.js nicht
  // angepasst werden musste):
  //   onInterim(text)        — Live-Zwischentext der AKTUELL laufenden Recognition-Instanz
  //   onSessionEnd(fullText) — feuert GENAU EINMAL, wenn die gesamte Voice Session beendet ist
  //                            (Nutzer hat STOP gedrueckt, ODER ein nicht behebbarer Fehler trat auf).
  //                            fullText ist das ueber die gesamte Session akkumulierte Transkript.
  //   onError(message)       — nicht-fatale Warnung (Toast); Session laeuft ggf. weiter, ODER
  //                            fataler Fehler, der direkt danach auch onSessionEnd ausloest
  start(onInterim, onSessionEnd, onError) {
    if (!this.isAvailable()) { onError("Spracherkennung auf diesem Geraet/Browser nicht verfuegbar."); return; }
    if (!navigator.onLine) {
      onError("Spracherkennung braucht in diesem Browser eine Internetverbindung (Cloud-basierte " +
        "Erkennung, siehe docs/STT_RESEARCH.md) — aktuell offline. Bitte Text eintippen.");
      return;
    }
    this._callbacks = { onInterim, onSessionEnd, onError };
    this._userStopped = false;
    this._sessionFinished = false;
    this._finalTranscript = "";
    this._restartCount = 0;
    this._beginRecognition();
  }

  _finishSession() {
    if (this._sessionFinished) return; // Schutz: darf nur einmal feuern (z.B. bei stop() waehrend Restart-Race)
    this._sessionFinished = true;
    this._recognition = null;
    this._callbacks?.onSessionEnd?.(this._finalTranscript.trim());
  }

  _beginRecognition() {
    const myGeneration = ++this._generation;
    const rec = new this._Recognition();
    rec.lang = "de-DE";
    rec.continuous = true;       // WICHTIG (Kernfix): nicht nach der ersten Sprechpause abbrechen
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (ev) => {
      if (myGeneration !== this._generation) return; // veraltete Instanz (Race Condition) -> ignorieren
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const transcript = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) {
          // Fragment-Akkumulation: JEDES finale Fragment wird angehaengt, nicht ueberschrieben.
          this._finalTranscript = (this._finalTranscript + " " + transcript).trim();
        } else {
          interim += transcript;
        }
      }
      if (interim) this._callbacks?.onInterim?.(interim);
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
