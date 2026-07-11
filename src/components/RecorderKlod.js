import { useState, useRef, useEffect, useCallback } from "react";
import { ref, uploadBytes } from "firebase/storage";
import { auth, storage } from "../firebase";
import { useTheme } from "../ThemeContext";
import { Mic, Square, Check, AlertCircle, RefreshCw, Shield } from "lucide-react";

const ERP_URL = process.env.REACT_APP_ERP_URL || "https://project-oybwy.vercel.app";

const MAX_DURATA_SEC = 300; // auto-stop a 5:00

// Ordine di preferenza per il formato di registrazione (iOS Safari preferisce mp4)
const MIME_CANDIDATES = [
  { mimeType: "audio/mp4",              ext: "m4a",  contentType: "audio/mp4" },
  { mimeType: "audio/webm;codecs=opus", ext: "webm", contentType: "audio/webm" },
];

function pickRecordingFormat() {
  const supported =
    typeof MediaRecorder !== "undefined" &&
    typeof MediaRecorder.isTypeSupported === "function";
  if (supported) {
    for (const c of MIME_CANDIDATES) {
      if (MediaRecorder.isTypeSupported(c.mimeType)) return c;
    }
  }
  // Nessun mimeType supportato: lascia decidere il browser (ext webm di default)
  return { mimeType: "", ext: "webm", contentType: "audio/webm" };
}

function fmtTimer(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function isIosStandalone() {
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  const iOS = /iP(hone|ad|od)/.test(ua);
  const standalone =
    (typeof navigator !== "undefined" && navigator.standalone === true) ||
    (typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(display-mode: standalone)").matches);
  return iOS && standalone;
}

export default function RecorderKlod({ user }) {
  const { C } = useTheme();

  // Macchina a stati: idle | recording | uploading | processing | done | error
  const [stato, setStato] = useState("idle");
  const [elapsed, setElapsed] = useState(0);
  const [progresso, setProgresso] = useState(""); // messaggio fase elaborazione
  const [esito, setEsito] = useState("");         // messaggio finale (done)
  const [errore, setErrore] = useState("");       // messaggio di errore

  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const durataRef = useRef(0);      // durata dal timer (non dai metadati del blob)
  const formatRef = useRef(null);   // { ext, contentType }
  const blobRef = useRef(null);     // blob tenuto in memoria per il retry

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Cleanup rigoroso su unmount: mai stream orfani
  useEffect(() => {
    return () => {
      clearTimer();
      try {
        if (recorderRef.current && recorderRef.current.state !== "inactive") {
          recorderRef.current.stop();
        }
      } catch (_) {}
      stopStream();
    };
  }, [clearTimer, stopStream]);

  // ─── Gating difensivo: doppia cintura oltre al menu ───────────────────────
  if (user?.ruolo !== "admin") {
    return (
      <div style={{ flex: 1, overflowY: "auto", padding: "40px 20px 90px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-start", fontFamily: "Barlow" }}>
        <div style={{ maxWidth: 340, textAlign: "center", background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: "28px 22px" }}>
          <Shield size={40} strokeWidth={1.6} color={C.textMuted} style={{ marginBottom: 12 }} />
          <div style={{ fontFamily: "Barlow Condensed", fontWeight: 800, fontSize: 22, letterSpacing: 0.5, marginBottom: 8 }}>Sezione riservata</div>
          <div style={{ fontSize: 14, color: C.textDim, lineHeight: 1.5 }}>
            Questa sezione è riservata agli amministratori.
          </div>
        </div>
      </div>
    );
  }

  const resetIdle = () => {
    setStato("idle");
    setElapsed(0);
    setProgresso("");
    setEsito("");
    setErrore("");
  };

  // ─── Fase elaborazione (non bloccante in caso di errore) ──────────────────
  const elabora = async (voiceNoteId, token) => {
    setStato("processing");
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    const body = JSON.stringify({ voiceNoteId });
    try {
      setProgresso("Klod sta trascrivendo...");
      const t = await fetch(`${ERP_URL}/api/voice-notes/transcribe`, { method: "POST", headers, body });
      if (!t.ok) throw new Error(`transcribe ${t.status}`);

      setProgresso("Klod sta classificando...");
      const c = await fetch(`${ERP_URL}/api/voice-notes/classify`, { method: "POST", headers, body });
      if (!c.ok) throw new Error(`classify ${c.status}`);

      setEsito("Nota inviata e classificata: la trovi in Inbox Voce.");
      setStato("done");
    } catch (err) {
      console.error("[Klod] elaborazione:", err);
      // Non bloccante: la nota è comunque salvata
      setEsito("Nota salvata. Completa l'elaborazione da Inbox Voce nell'ERP.");
      setStato("done");
    }
  };

  // ─── Upload su Storage + create sull'ERP ──────────────────────────────────
  const inviaNota = async (blob) => {
    setStato("uploading");
    setProgresso("");
    setEsito("");
    setErrore("");
    const fmt = formatRef.current || { ext: "webm", contentType: "audio/webm" };
    const durataSec = durataRef.current;

    try {
      const uid = auth.currentUser.uid;
      const audioPath = `voice-notes/${uid}/${Date.now()}.${fmt.ext}`;
      const r = ref(storage, audioPath);
      await uploadBytes(r, blob, { contentType: fmt.contentType });

      const token = await auth.currentUser.getIdToken();
      const res = await fetch(`${ERP_URL}/api/voice-notes/create`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ audioPath, durataSec }),
      });
      if (!res.ok) throw new Error(`create ${res.status}`);
      const data = await res.json();
      const voiceNoteId = data.id || data.voiceNoteId || (data.voiceNote && data.voiceNote.id);
      if (!voiceNoteId) throw new Error("id nota mancante nella risposta");

      await elabora(voiceNoteId, token);
    } catch (err) {
      console.error("[Klod] invio nota:", err);
      setErrore("Invio non riuscito. Controlla la connessione e riprova.");
      setStato("error");
    }
  };

  // ─── Stop registrazione ───────────────────────────────────────────────────
  const stopRecording = () => {
    clearTimer();
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop(); // onstop → costruisce il blob e avvia inviaNota
      } catch (_) {
        stopStream();
      }
    } else {
      stopStream();
    }
  };

  // ─── Avvio registrazione (getUserMedia SOLO al tap, requisito iOS) ─────────
  const startRecording = async () => {
    setErrore("");
    setEsito("");
    setProgresso("");

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const negato =
        err &&
        (err.name === "NotAllowedError" ||
          err.name === "SecurityError" ||
          err.name === "PermissionDeniedError");
      if (negato) {
        setErrore(
          isIosStandalone()
            ? "Accesso al microfono negato. Prova ad aprire l'app da Safari per consentire il microfono, oppure abilitalo in Impostazioni › Safari."
            : "Accesso al microfono negato. Consenti l'uso del microfono dal browser (icona lucchetto nella barra degli indirizzi) e riprova."
        );
      } else {
        setErrore("Microfono non disponibile su questo dispositivo.");
      }
      setStato("error");
      return;
    }

    streamRef.current = stream;
    const fmt = pickRecordingFormat();
    formatRef.current = fmt;
    chunksRef.current = [];
    blobRef.current = null;

    let recorder;
    try {
      recorder = fmt.mimeType
        ? new MediaRecorder(stream, { mimeType: fmt.mimeType })
        : new MediaRecorder(stream);
    } catch (_) {
      recorder = new MediaRecorder(stream);
      formatRef.current = { mimeType: "", ext: "webm", contentType: "audio/webm" };
    }
    recorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const ct = (formatRef.current && formatRef.current.contentType) || "audio/webm";
      const blob = new Blob(chunksRef.current, { type: ct });
      blobRef.current = blob; // tenuto per l'eventuale retry
      stopStream();
      inviaNota(blob);
    };

    durataRef.current = 0;
    setElapsed(0);
    recorder.start();
    setStato("recording");

    timerRef.current = setInterval(() => {
      durataRef.current += 1;
      setElapsed(durataRef.current);
      if (durataRef.current >= MAX_DURATA_SEC) {
        stopRecording(); // AUTO-STOP a 5:00
      }
    }, 1000);
  };

  // ─── Retry invio: riusa il blob, senza ri-registrare ──────────────────────
  const retryInvio = () => {
    if (blobRef.current) inviaNota(blobRef.current);
    else resetIdle();
  };

  // ─── UI ───────────────────────────────────────────────────────────────────
  const wrap = {
    flex: 1,
    overflowY: "auto",
    padding: "28px 20px 100px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    fontFamily: "Barlow",
  };

  const bigBtn = (bg, border) => ({
    width: 132,
    height: 132,
    borderRadius: "50%",
    background: bg,
    border: `2px solid ${border}`,
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    fontFamily: "Barlow",
  });

  const hint = { fontSize: 14, color: C.textDim, textAlign: "center", lineHeight: 1.5, maxWidth: 320 };

  return (
    <div style={wrap}>
      <style>{`
        @keyframes klodspin{to{transform:rotate(360deg)}}
        @keyframes klodpulse{0%,100%{opacity:1}50%{opacity:.25}}
      `}</style>
      <div style={{ fontFamily: "Barlow Condensed", fontWeight: 800, fontSize: 24, letterSpacing: 0.5, marginBottom: 4 }}>
        Registratore Klod
      </div>
      <div style={{ ...hint, marginBottom: 28 }}>
        Registra una nota vocale: Klod la trascrive e la smista in Inbox Voce.
      </div>

      {/* IDLE */}
      {stato === "idle" && (
        <>
          <button onClick={startRecording} style={bigBtn(C.accent, C.accent)} aria-label="Avvia registrazione">
            <Mic size={54} strokeWidth={1.8} />
          </button>
          <div style={{ ...hint, marginTop: 22 }}>Tocca per registrare (max 5:00)</div>
        </>
      )}

      {/* RECORDING */}
      {stato === "recording" && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
            <span style={{ width: 12, height: 12, borderRadius: "50%", background: C.red, animation: "klodpulse 1s ease-in-out infinite" }} />
            <span style={{ fontFamily: "Barlow Condensed", fontWeight: 800, fontSize: 40, letterSpacing: 1, color: C.text }}>
              {fmtTimer(elapsed)}
            </span>
          </div>
          <button onClick={stopRecording} style={bigBtn(C.red, C.red)} aria-label="Ferma registrazione">
            <Square size={46} strokeWidth={1.8} fill="#fff" />
          </button>
          <div style={{ ...hint, marginTop: 22 }}>Tocca per fermare e inviare</div>
        </>
      )}

      {/* UPLOADING */}
      {stato === "uploading" && (
        <>
          <div style={bigBtn(C.card, C.border)}>
            <RefreshCw size={46} strokeWidth={1.8} color={C.accent} style={{ animation: "klodspin 1s linear infinite" }} />
          </div>
          <div style={{ ...hint, marginTop: 22, color: C.text }}>Invio in corso...</div>
        </>
      )}

      {/* PROCESSING */}
      {stato === "processing" && (
        <>
          <div style={bigBtn(C.card, C.border)}>
            <RefreshCw size={46} strokeWidth={1.8} color={C.accent} style={{ animation: "klodspin 1s linear infinite" }} />
          </div>
          <div style={{ ...hint, marginTop: 22, color: C.text }}>{progresso || "Elaborazione..."}</div>
        </>
      )}

      {/* DONE */}
      {stato === "done" && (
        <>
          <div style={bigBtn(C.greenDim, C.green)}>
            <Check size={54} strokeWidth={2} color={C.green} />
          </div>
          <div style={{ ...hint, marginTop: 22, color: C.text, fontWeight: 600 }}>{esito}</div>
          <button
            onClick={resetIdle}
            style={{ marginTop: 24, padding: "12px 22px", background: C.accent, border: "none", borderRadius: 12, color: "#fff", fontSize: 14, fontWeight: 700, fontFamily: "Barlow", cursor: "pointer" }}
          >
            Registra un'altra nota
          </button>
        </>
      )}

      {/* ERROR */}
      {stato === "error" && (
        <>
          <div style={bigBtn(C.redDim, C.red)}>
            <AlertCircle size={54} strokeWidth={1.8} color={C.red} />
          </div>
          <div style={{ ...hint, marginTop: 22, color: C.text }}>{errore}</div>
          <div style={{ display: "flex", gap: 12, marginTop: 24 }}>
            {blobRef.current && (
              <button
                onClick={retryInvio}
                style={{ padding: "12px 22px", background: C.accent, border: "none", borderRadius: 12, color: "#fff", fontSize: 14, fontWeight: 700, fontFamily: "Barlow", cursor: "pointer" }}
              >
                Riprova invio
              </button>
            )}
            <button
              onClick={resetIdle}
              style={{ padding: "12px 22px", background: "transparent", border: `1px solid ${C.border}`, borderRadius: 12, color: C.text, fontSize: 14, fontWeight: 600, fontFamily: "Barlow", cursor: "pointer" }}
            >
              {blobRef.current ? "Annulla" : "Chiudi"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
