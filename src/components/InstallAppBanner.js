import { useState, useEffect, useRef, useCallback } from "react";

const DISMISS_KEY = "edilblu_install_dismissed";

function isIOS() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.MSStream;
}

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

export default function InstallAppBanner() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [showIOSTip, setShowIOSTip] = useState(false);
  const [visible, setVisible] = useState(false);
  const promptRef = useRef(null);

  useEffect(() => {
    if (isStandalone()) return;
    if (localStorage.getItem(DISMISS_KEY) === "true") return;

    if (isIOS()) {
      setShowIOSTip(true);
      setVisible(true);
      return;
    }

    const handler = (e) => {
      e.preventDefault();
      promptRef.current = e;
      setDeferredPrompt(e);
      setVisible(true);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const handleInstall = useCallback(async () => {
    const prompt = promptRef.current;
    if (!prompt) return;
    prompt.prompt();
    const result = await prompt.userChoice;
    if (result.outcome === "accepted") {
      setVisible(false);
    }
    promptRef.current = null;
    setDeferredPrompt(null);
  }, []);

  const handleDismiss = useCallback(() => {
    localStorage.setItem(DISMISS_KEY, "true");
    setVisible(false);
  }, []);

  if (!visible) return null;

  const banner = {
    position: "fixed",
    bottom: 70,
    left: 0,
    right: 0,
    zIndex: 1000,
    background: "#2e6bb8",
    color: "#fff",
    padding: "12px 16px",
    boxShadow: "0 -4px 12px rgba(0,0,0,0.15)",
    display: "flex",
    alignItems: "center",
    gap: 12,
    fontFamily: "'Barlow', sans-serif",
    animation: "installBannerSlideUp 300ms ease-out",
  };

  const btnInstall = {
    background: "#fff",
    color: "#2e6bb8",
    border: "none",
    padding: "8px 16px",
    borderRadius: 8,
    fontWeight: 600,
    fontSize: 14,
    cursor: "pointer",
    fontFamily: "'Barlow', sans-serif",
    whiteSpace: "nowrap",
    flexShrink: 0,
  };

  const btnClose = {
    background: "transparent",
    border: "none",
    color: "rgba(255,255,255,0.7)",
    fontSize: 22,
    cursor: "pointer",
    padding: 4,
    lineHeight: 1,
    flexShrink: 0,
  };

  return (
    <>
      <style>{`@keyframes installBannerSlideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}`}</style>
      <div style={banner}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            Installa Edil Blu sul telefono
          </div>
          <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>
            {showIOSTip ? (
              <span>
                Tocca{" "}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: "middle", margin: "0 2px" }}>
                  <path d="M4 12v6a2 2 0 002 2h12a2 2 0 002-2v-6" />
                  <polyline points="16 6 12 2 8 6" />
                  <line x1="12" y1="2" x2="12" y2="15" />
                </svg>{" "}
                poi &quot;Aggiungi alla schermata Home&quot;
              </span>
            ) : (
              "Apri l'app con un tap, senza browser"
            )}
          </div>
        </div>
        {!showIOSTip && (
          <button style={btnInstall} onClick={handleInstall}>
            Installa
          </button>
        )}
        <button style={btnClose} onClick={handleDismiss} aria-label="Chiudi">
          ✕
        </button>
      </div>
    </>
  );
}
