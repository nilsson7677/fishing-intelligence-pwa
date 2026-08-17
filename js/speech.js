// SpeechToTextProvider-Abstraktion (Abschnitt 8) — siehe docs/STT_RESEARCH.md fuer die
// vollstaendige Recherche/Begruendung. Sprint 2 implementiert NUR BrowserSpeechToTextProvider
// (Web Speech API). Weitere Provider (On-Device/Cloud) sind bewusst NICHT implementiert — keine
// kostenpflichtige API ohne Nutzerfreigabe (Abschnitt 8/46).

class SpeechToTextProvider {
  isAvailable() { throw new Error("not implemented"); }
  start() { throw new Error("not implemented"); }
  stop() { throw new Error("not implemented"); }
}

class BrowserSpeechToTextProvider extends SpeechToTextProvider {
  constructor() {
    super();
    this._Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
    this._recognition = null;
  }

  isAvailable() {
    return this._Recognition !== null && (window.isSecureContext !== false);
  }

  // onInterim(text), onFinal(text), onError(message) — reine Callback-Schnittstelle, damit die
  // UI (voice_view in app.js) nie direkt gegen die Web Speech API programmiert.
  start(onInterim, onFinal, onError) {
    if (!this.isAvailable()) { onError("Spracherkennung auf diesem Geraet/Browser nicht verfuegbar."); return; }
    if (!navigator.onLine) {
      onError("Spracherkennung braucht in diesem Browser eine Internetverbindung (Cloud-basierte " +
        "Erkennung, siehe docs/STT_RESEARCH.md) — aktuell offline. Bitte Text eintippen.");
      return;
    }
    const rec = new this._Recognition();
    rec.lang = "de-DE";
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let finalTranscript = "";
    rec.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const transcript = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finalTranscript += transcript;
        else interim += transcript;
      }
      if (interim) onInterim(interim);
      if (finalTranscript) onFinal(finalTranscript.trim());
    };
    rec.onerror = (ev) => {
      const messages = {
        "not-allowed": "Mikrofon-Zugriff wurde verweigert. Bitte in den Browser-/App-Einstellungen erlauben.",
        "no-speech": "Keine Sprache erkannt. Bitte nochmal versuchen oder Text eintippen.",
        network: "Netzwerkfehler bei der Spracherkennung (Cloud-Dienst nicht erreichbar).",
      };
      onError(messages[ev.error] || `Spracherkennungsfehler: ${ev.error}`);
    };
    rec.onend = () => { this._recognition = null; };
    this._recognition = rec;
    rec.start();
  }

  stop() {
    if (this._recognition) { this._recognition.stop(); this._recognition = null; }
  }
}

window.FISpeech = { SpeechToTextProvider, BrowserSpeechToTextProvider };
