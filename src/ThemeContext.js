import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { doc, updateDoc } from "firebase/firestore";
import { db } from "./firebase";
import { themes } from "./theme";

const STORAGE_KEY = "edilblu_theme";

const ThemeContext = createContext();

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && themes[saved]) return saved;
    } catch (_) {}
    return "dark";
  });

  const [uid, setUid] = useState(null);

  const setTheme = useCallback((t) => {
    if (!themes[t]) return;
    setThemeState(t);
  }, []);

  // Persist to localStorage
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, theme); } catch (_) {}
  }, [theme]);

  // Persist to Firestore when user is logged in
  useEffect(() => {
    if (!uid) return;
    try {
      updateDoc(doc(db, "users", uid), { themePreference: theme }).catch(() => {});
    } catch (_) {}
  }, [theme, uid]);

  const C = themes[theme];

  return (
    <ThemeContext.Provider value={{ theme, setTheme, C, setUid }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
