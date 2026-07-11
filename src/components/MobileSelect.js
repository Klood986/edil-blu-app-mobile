import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTheme } from "../ThemeContext";
import { Search, X, ChevronDown, Check } from "lucide-react";

/**
 * MobileSelect — dropdown a bottom-sheet, immune per costruzione a overflow,
 * scroll e tastiera (pannello position:fixed ancorato al viewport via portale).
 *
 * Con la ricerca a fuoco, il pannello si aggancia a window.visualViewport
 * (offsetTop/offsetLeft/width/height) e segue la tastiera iOS: dvh/svh non
 * bastano perché la tastiera iOS non ridimensiona il layout viewport.
 *
 * Props:
 *  - label        etichetta opzionale sopra il campo-bottone
 *  - value        valore selezionato
 *  - options      [{ value, label, sub?, group? }] — passate GIÀ ORDINATE.
 *                 Quando `group` cambia rispetto alla voce precedente viene
 *                 renderizzata una riga intestazione non interattiva.
 *  - onChange     (value) => void
 *  - searchable   mostra la barra di ricerca in alto
 *  - placeholder  testo con selezione vuota
 *  - disabled
 */
export default function MobileSelect({ label, value, options = [], onChange, searchable = false, placeholder = "Seleziona...", disabled = false }) {
  const { C } = useTheme();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [kbFocus, setKbFocus] = useState(false); // ricerca a fuoco (tastiera)
  const [vvRect, setVvRect] = useState(null);     // geometria visualViewport in modalità tastiera
  const listRef = useRef(null);
  const searchInputRef = useRef(null);
  const blurTimerRef = useRef(null);

  const hasVV = typeof window !== "undefined" && !!window.visualViewport;

  const selected = options.find(o => o.value === value);
  const displayLabel = selected ? selected.label : "";

  // ─── Blocco scroll del body robusto (position:fixed, ripristino esatto) ───
  useEffect(() => {
    if (!open) return;
    const scrollY = window.scrollY || window.pageYOffset || 0;
    const body = document.body;
    const prev = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
      overflow: body.style.overflow,
    };
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";
    return () => {
      body.style.position = prev.position;
      body.style.top = prev.top;
      body.style.left = prev.left;
      body.style.right = prev.right;
      body.style.width = prev.width;
      body.style.overflow = prev.overflow;
      window.scrollTo(0, scrollY);
    };
  }, [open]);

  // ─── Modalità tastiera guidata da visualViewport ──────────────────────────
  useEffect(() => {
    if (!open || !kbFocus) return;
    const vv = window.visualViewport;
    if (!vv) return; // fallback: nessuna regressione su browser senza visualViewport
    const update = () => {
      // tastiera chiusa → l'altezza torna ~ layout viewport: rientro bottom-sheet
      const kbClosed = vv.height >= window.innerHeight - 100;
      if (kbClosed) {
        setVvRect(null);
      } else {
        setVvRect({ top: vv.offsetTop, left: vv.offsetLeft, width: vv.width, height: vv.height });
      }
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [open, kbFocus]);

  // ─── Reset scroll lista ad ogni cambio ricerca (primi risultati visibili) ─
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [search]);

  // ─── Cleanup del timer di blur deferito su unmount ────────────────────────
  useEffect(() => () => {
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
  }, []);

  const close = () => {
    if (blurTimerRef.current) { clearTimeout(blurTimerRef.current); blurTimerRef.current = null; }
    setOpen(false);
    setSearch("");
    setKbFocus(false);
    setVvRect(null);
  };

  const seleziona = (val) => {
    onChange(val);
    close();
  };

  const searchLower = search.trim().toLowerCase();
  const filtered = !searchLower
    ? options
    : options.filter(o =>
        `${o.label || ""} ${o.sub || ""}`.toLowerCase().includes(searchLower)
      );

  // Modalità pannello: vv (agganciato al visualViewport) | expanded (fallback
  // senza visualViewport) | sheet (bottom-sheet di default)
  const panelMode = vvRect ? "vv" : (kbFocus && !hasVV ? "expanded" : "sheet");

  const baseColumn = {
    position: "fixed",
    background: C.card,
    border: `1px solid ${C.border}`,
    borderBottom: "none",
    display: "flex",
    flexDirection: "column",
    zIndex: 1001,
  };

  let panelStyle;
  if (panelMode === "vv") {
    panelStyle = {
      ...baseColumn,
      top: vvRect.top,
      left: vvRect.left,
      width: vvRect.width,
      height: vvRect.height,
      maxHeight: vvRect.height,
      borderTopLeftRadius: 0,
      borderTopRightRadius: 0,
      paddingBottom: 0,
    };
  } else if (panelMode === "expanded") {
    panelStyle = {
      ...baseColumn,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      maxWidth: 500,
      margin: "0 auto",
      maxHeight: "100%",
      borderTopLeftRadius: 0,
      borderTopRightRadius: 0,
      paddingBottom: "env(safe-area-inset-bottom)",
    };
  } else {
    panelStyle = {
      ...baseColumn,
      left: 0,
      right: 0,
      bottom: 0,
      maxWidth: 500,
      margin: "0 auto",
      maxHeight: "70vh",
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      animation: "slideUp 0.22s ease",
      paddingBottom: "env(safe-area-inset-bottom)",
    };
  }

  // ─── Campo-bottone (chiuso) ───────────────────────────────────────────────
  const trigger = (
    <div>
      {label && (
        <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 700, letterSpacing: 0.5, marginBottom: 4, textTransform: "uppercase" }}>{label}</div>
      )}
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen(true)}
        style={{
          width: "100%",
          boxSizing: "border-box",
          minHeight: 48,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "10px 14px",
          background: C.card,
          border: `1.5px solid ${open ? C.accent : C.border}`,
          borderRadius: 10,
          color: displayLabel ? C.text : C.textDim,
          fontSize: 14,
          fontFamily: "Barlow,sans-serif",
          fontWeight: 500,
          textAlign: "left",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.55 : 1,
          transition: "border-color 0.15s",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
          {displayLabel || placeholder}
        </span>
        <ChevronDown size={18} color={C.textMuted} style={{ flexShrink: 0 }} />
      </button>
    </div>
  );

  // ─── Bottom-sheet / pannello (aperto) ─────────────────────────────────────
  const sheet = open ? createPortal(
    <div
      onClick={close}
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(3px)" }}
    >
      <div
        onClick={e => e.stopPropagation()}
        onMouseDown={e => { if (e.target !== searchInputRef.current) e.preventDefault(); }}
        style={panelStyle}
      >
        {/* Maniglia di trascinamento (visiva) */}
        <div style={{ flexShrink: 0, padding: "10px 0 4px", display: "flex", justifyContent: "center", cursor: "pointer" }} onClick={close}>
          <div style={{ width: 40, height: 4, background: C.border, borderRadius: 2 }} />
        </div>

        {label && (
          <div style={{ flexShrink: 0, padding: "4px 16px 8px", fontSize: 15, fontWeight: 700, fontFamily: "Barlow Condensed", color: C.text }}>{label}</div>
        )}

        {/* Barra di ricerca (fissa in alto) */}
        {searchable && (
          <div style={{ flexShrink: 0, padding: "6px 12px 10px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, background: C.bg, border: `1.5px solid ${C.borderLight}`, borderRadius: 9, padding: "9px 12px" }}>
              <Search size={15} color={C.textMuted} />
              <input
                ref={searchInputRef}
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                onFocus={() => {
                  if (blurTimerRef.current) { clearTimeout(blurTimerRef.current); blurTimerRef.current = null; }
                  setKbFocus(true);
                }}
                onBlur={() => {
                  // Blur deferito: il tap su una voce fa blur PRIMA del click.
                  // Aspetta ~150ms; collassa solo se il pannello è ancora aperto
                  // (input montato) e l'input non ha ripreso il fuoco.
                  if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
                  blurTimerRef.current = setTimeout(() => {
                    blurTimerRef.current = null;
                    if (!searchInputRef.current || document.activeElement === searchInputRef.current) return;
                    setKbFocus(false);
                    setVvRect(null);
                  }, 150);
                }}
                placeholder="Cerca..."
                style={{ flex: 1, border: "none", background: "transparent", outline: "none", color: C.text, fontSize: 15, fontFamily: "Barlow,sans-serif" }}
              />
              {search && (
                <span onClick={() => setSearch("")} style={{ cursor: "pointer", color: C.textMuted, display: "flex" }}>
                  <X size={16} />
                </span>
              )}
            </div>
          </div>
        )}

        {/* Lista scrollabile (flex:1) */}
        <div ref={listRef} style={{ flex: 1, overflowY: "auto", WebkitOverflowScrolling: "touch", overscrollBehavior: "contain", minHeight: 0 }}>
          {filtered.length === 0 ? (
            <div style={{ padding: "28px 20px", textAlign: "center", color: C.textMuted, fontSize: 14, fontFamily: "Barlow" }}>
              Nessun risultato
            </div>
          ) : (
            filtered.map((o, i) => {
              const prev = filtered[i - 1];
              const showHeader = o.group && (!prev || prev.group !== o.group);
              const isSel = o.value === value;
              return (
                <div key={`${o.value}-${i}`}>
                  {showHeader && (
                    <div style={{ padding: "10px 16px 5px", fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.6, background: C.surface, position: "sticky", top: 0, zIndex: 1 }}>
                      {o.group}
                    </div>
                  )}
                  <div
                    onClick={() => seleziona(o.value)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                      padding: "13px 16px",
                      minHeight: 48,
                      boxSizing: "border-box",
                      cursor: "pointer",
                      borderBottom: `1px solid ${C.border}40`,
                      background: isSel ? C.accentDim : "transparent",
                      borderLeft: isSel ? `3px solid ${C.accent}` : "3px solid transparent",
                      color: isSel ? C.accent : C.text,
                      fontWeight: isSel ? 600 : 400,
                      fontFamily: "Barlow,sans-serif",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.label}</div>
                      {o.sub && (
                        <div style={{ fontSize: 12, color: C.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2 }}>{o.sub}</div>
                      )}
                    </div>
                    {isSel && <Check size={17} color={C.accent} style={{ flexShrink: 0 }} />}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body
  ) : null;

  return (
    <>
      {trigger}
      {sheet}
    </>
  );
}
