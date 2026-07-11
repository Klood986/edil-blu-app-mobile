import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTheme } from "../ThemeContext";
import { Search, X, ChevronDown, Check } from "lucide-react";

/**
 * MobileSelect — dropdown a bottom-sheet, immune per costruzione a overflow,
 * scroll e tastiera (pannello position:fixed ancorato al viewport via portale).
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
  const [expanded, setExpanded] = useState(false); // ricerca a fuoco → quasi fullscreen

  const selected = options.find(o => o.value === value);
  const displayLabel = selected ? selected.label : "";

  // Blocco scroll del body mentre aperto (ripristino su chiusura e unmount)
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  const close = () => {
    setOpen(false);
    setSearch("");
    setExpanded(false);
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

  // ─── Bottom-sheet (aperto) ────────────────────────────────────────────────
  const sheet = open ? createPortal(
    <div
      onClick={close}
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(3px)" }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          top: expanded ? 0 : "auto",
          maxWidth: 500,
          margin: "0 auto",
          background: C.card,
          borderTopLeftRadius: expanded ? 0 : 18,
          borderTopRightRadius: expanded ? 0 : 18,
          border: `1px solid ${C.border}`,
          borderBottom: "none",
          display: "flex",
          flexDirection: "column",
          maxHeight: expanded ? "100%" : "70vh",
          zIndex: 1001,
          animation: "slideUp 0.22s ease",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        {/* Maniglia di trascinamento (visiva) */}
        <div style={{ flexShrink: 0, padding: "10px 0 4px", display: "flex", justifyContent: "center", cursor: "pointer" }} onClick={close}>
          <div style={{ width: 40, height: 4, background: C.border, borderRadius: 2 }} />
        </div>

        {label && (
          <div style={{ flexShrink: 0, padding: "4px 16px 8px", fontSize: 15, fontWeight: 700, fontFamily: "Barlow Condensed", color: C.text }}>{label}</div>
        )}

        {/* Barra di ricerca */}
        {searchable && (
          <div style={{ flexShrink: 0, padding: "6px 12px 10px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, background: C.bg, border: `1.5px solid ${C.borderLight}`, borderRadius: 9, padding: "9px 12px" }}>
              <Search size={15} color={C.textMuted} />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                onFocus={() => setExpanded(true)}
                onBlur={() => setExpanded(false)}
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

        {/* Lista scrollabile */}
        <div style={{ flex: 1, overflowY: "auto", WebkitOverflowScrolling: "touch", overscrollBehavior: "contain", minHeight: 0 }}>
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
