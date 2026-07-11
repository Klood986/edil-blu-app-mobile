import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { auth, db, storage, functions } from "./firebase";
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
  updatePassword,
} from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import {
  collection, doc, getDoc, getDocs, addDoc, updateDoc, setDoc, deleteDoc,
  query, where, orderBy, onSnapshot, serverTimestamp, arrayUnion,
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { useTheme } from "./ThemeContext";
import { Home, HardHat, MessageCircle, User, Menu as MenuIcon,
         Calendar, ClipboardList, Camera, Ruler, FileText, Settings,
         ChevronLeft, X, Plus, ChevronDown, Inbox,
         Plane, Activity, Sun, Moon, LogOut,
         UserPlus, Copy, Check, AlertCircle, Eye, EyeOff, Shield,
         ChevronRight, GripVertical, Trash2, Save, RefreshCw, Search, Mic } from "lucide-react";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import InstallAppBanner from "./components/InstallAppBanner";
import RecorderKlod from "./components/RecorderKlod";
import MobileSelect from "./components/MobileSelect";

// ─── Helper: parsing ore in formato italiano (virgola o punto) ───────────────
// "0,5" -> 0.5 | "1.5" -> 1.5 | "" -> "" | invalido -> ""
// Allineato a src/lib/numUtils.ts dell'ERP (parseNum semplificato per il caso ore)
function parseOreIT(raw) {
  if (typeof raw === "number") return raw;
  const s = String(raw ?? "").trim().replace(",", ".");
  if (s === "") return "";
  const n = parseFloat(s);
  return isNaN(n) ? "" : n;
}

// Formatta ore per display nell'input (mostra virgola decimale per UX IT)
function fmtOreIT(n) {
  if (n === "" || n === null || n === undefined || n === 0) return "";
  return String(n).replace(".", ",");
}

// ─── Helper: orari turni rapportino (HH:MM ↔ minuti) ─────────────────────────
// "08:30" -> 510 | "25:00" -> null | "abc" -> null
function parseTime(hhmm) {
  if (typeof hhmm !== "string") return null;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

// true se hhmm cade su un multiplo di 15 min. Stringa vuota = true (gestita altrove).
function isStep15Min(hhmm) {
  if (!hhmm) return true;
  const m = parseTime(hhmm);
  if (m === null) return false;
  return m % 15 === 0;
}

// Ore decimali (string IT o number) -> minuti interi (round, no floating point garbage)
function oreToMin(ore) {
  const n = parseOreIT(ore);
  if (typeof n !== "number") return 0;
  return Math.round(n * 60);
}

// Somma minuti di tutti i turni con tempi validi (fine > inizio)
function sumMinTurni(turni) {
  if (!Array.isArray(turni)) return 0;
  return turni.reduce((acc, t) => {
    const i = parseTime(t?.inizio);
    const f = parseTime(t?.fine);
    if (i === null || f === null || f <= i) return acc;
    return acc + (f - i);
  }, 0);
}

// Minuti del permesso (0 se non attivo o invalido)
function permessoMin(p) {
  if (!p || !p.attivo) return 0;
  const da = parseTime(p.da);
  const a = parseTime(p.a);
  if (da === null || a === null || a <= da) return 0;
  return a - da;
}

// true se [da,a] del permesso è interamente contenuto in UN singolo turno valido
function permessoDentroTurni(p, turni) {
  if (!p || !p.attivo) return true;
  const da = parseTime(p.da);
  const a = parseTime(p.a);
  if (da === null || a === null || a <= da) return false;
  if (!Array.isArray(turni)) return false;
  return turni.some(t => {
    const i = parseTime(t?.inizio);
    const f = parseTime(t?.fine);
    if (i === null || f === null || f <= i) return false;
    return da >= i && a <= f;
  });
}

// true se ogni turno ha tempi validi e fine > inizio (array non vuoto)
function turniValidi(turni) {
  if (!Array.isArray(turni) || turni.length === 0) return false;
  return turni.every(t => {
    const i = parseTime(t?.inizio);
    const f = parseTime(t?.fine);
    return i !== null && f !== null && f > i;
  });
}

// Formatta minuti come ore decimali italiane: 450 -> "7,5h" | 480 -> "8h" | 0 -> "0h"
function fmtMinAsOreIT(m) {
  if (!m || m <= 0) return "0h";
  const ore = Math.round((m / 60) * 100) / 100;
  return String(ore).replace(".", ",") + "h";
}

// ─── DESIGN SYSTEM ────────────────────────────────────────────────────────────
// Palette importata da theme.js — default dark per retrocompatibilità
import { themes } from "./theme";
const C = themes.dark;

const ROLES = {
  admin:           { label: "Admin",           color: C.gold  },
  amministrazione: { label: "Amministrazione", color: C.green },
  ufficio_tecnico: { label: "Ufficio Tecnico", color: C.accent },
  operaio:         { label: "Operaio",         color: "#a8d4f0" },
};

const RUOLI_STANDARD = ["admin","amministrazione","ufficio_tecnico","operaio"];

// Normalizza il ruolo: se non è uno standard (es. "muratore") → operaio
// Usa ruoloApp se presente, altrimenti controlla ruolo
const getRuolo = (u) => {
  if (u.ruoloApp && RUOLI_STANDARD.includes(u.ruoloApp)) return u.ruoloApp;
  if (RUOLI_STANDARD.includes(u.ruolo)) return u.ruolo;
  return "operaio"; // muratore, pittore, ecc. → operaio
};

const canEdit  = (r) => ["admin","amministrazione","ufficio_tecnico"].includes(r);
const isManager = (r) => ["admin","amministrazione"].includes(r);

// Trova documento utente per UID Auth: prima per doc ID, poi per campo authUid
async function findUserDoc(uid) {
  const byId = await getDoc(doc(db, "utenti", uid));
  if (byId.exists()) return { id: byId.id, ...byId.data() };
  const q = await getDocs(query(collection(db, "utenti"), where("authUid", "==", uid)));
  if (!q.empty) { const d = q.docs[0]; return { id: d.id, ...d.data() }; }
  return null;
}

// ─── COMPONENTI BASE ──────────────────────────────────────────────────────────
const buildGlobalCss = (C) => `
  @import url('https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700;800&family=Barlow+Condensed:wght@600;700;800&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:${C.bg};font-family:'Barlow',sans-serif;color:${C.text}}
  ::-webkit-scrollbar{width:4px;height:4px}
  ::-webkit-scrollbar-track{background:${C.surface}}
  ::-webkit-scrollbar-thumb{background:${C.mid};border-radius:2px}
  input::placeholder,textarea::placeholder{color:${C.textMuted}}
  select option{background:${C.card};color:${C.text}}
  @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
  @keyframes splashIn{0%{opacity:0;transform:scale(.8)}60%{transform:scale(1.05)}100%{opacity:1;transform:scale(1)}}
  @keyframes splashFade{0%{opacity:1}100%{opacity:0;pointer-events:none}}
  @keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(79,172,222,.4)}70%{box-shadow:0 0 0 12px rgba(79,172,222,0)}}
  .fu{animation:fadeUp .25s ease}
  .splash-logo{animation:splashIn .6s cubic-bezier(.34,1.56,.64,1) forwards}
  .splash-out{animation:splashFade .4s ease forwards}
  @keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}
  @keyframes modalFadeIn{from{opacity:0;transform:scale(.95)}to{opacity:1;transform:scale(1)}}
`;

function Avatar({ name, role, size = 36 }) {
  const { C } = useTheme();
  const r = ROLES[role] || ROLES.operaio;
  const initials = (name || "?").split(" ").map(w => w[0]).join("").slice(0,2).toUpperCase();
  return (
    <div style={{ width:size, height:size, borderRadius:"50%", background:`linear-gradient(135deg, ${r.color}25, ${r.color}10)`, border:`1.5px solid ${r.color}60`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:size*0.33, fontWeight:700, color:r.color, flexShrink:0, fontFamily:"Barlow Condensed,sans-serif", boxShadow:`0 2px 8px ${r.color}20` }}>
      {initials}
    </div>
  );
}

function RoleBadge({ role }) {
  const { C } = useTheme();
  const r = ROLES[role] || ROLES.operaio;
  return <span style={{ background:`${r.color}18`, color:r.color, border:"none", borderRadius:999, padding:"4px 10px", fontSize:10, fontWeight:600, letterSpacing:0.3 }}>{r.label}</span>;
}

function Card({ children, style={}, onClick }) {
  const { C } = useTheme();
  const [hov, setHov] = useState(false);
  return <div onClick={onClick}
    onMouseEnter={onClick ? ()=>setHov(true) : undefined}
    onMouseLeave={onClick ? ()=>setHov(false) : undefined}
    style={{ background:C.card, borderRadius:16, border:`1px solid ${C.border}`, padding:18, marginBottom:10, cursor:onClick?"pointer":"default", transition:"transform 0.15s, box-shadow 0.15s", transform:hov?"scale(1.01)":"none", boxShadow:hov?`0 4px 20px ${C.border}60`:"none", ...style }}>{children}</div>;
}

function Inp({ placeholder, value, onChange, type="text", inputMode, onBlur, disabled, step, style={} }) {
  const { C, theme } = useTheme();
  const [focused, setFocused] = useState(false);
  return <input type={type} inputMode={inputMode} placeholder={placeholder} value={value} onChange={onChange}
    disabled={disabled}
    step={step}
    onFocus={()=>setFocused(true)}
    onBlur={(e)=>{ setFocused(false); if (onBlur) onBlur(e); }}
    style={{ width:"100%", boxSizing:"border-box", background:theme==="dark"?`${C.mid}40`:C.surface, border:`1.5px solid ${focused?C.accent:C.border}`, borderRadius:10, color:C.text, padding:"12px 14px", fontSize:14, outline:"none", fontFamily:"Barlow,sans-serif", marginBottom:10, transition:"border-color 0.15s", cursor: disabled ? "not-allowed" : "auto", opacity: disabled ? 0.55 : 1, ...style }} />;
}

function Txta({ placeholder, value, onChange, rows=3 }) {
  const { C, theme } = useTheme();
  const [focused, setFocused] = useState(false);
  return <textarea placeholder={placeholder} value={value} onChange={onChange} rows={rows}
    onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)}
    style={{ width:"100%", boxSizing:"border-box", background:theme==="dark"?`${C.mid}40`:C.surface, border:`1.5px solid ${focused?C.accent:C.border}`, borderRadius:10, color:C.text, padding:"12px 14px", fontSize:14, outline:"none", fontFamily:"Barlow,sans-serif", marginBottom:10, resize:"vertical", minHeight:80, transition:"border-color 0.15s" }} />;
}

function Sel({ value, onChange, children }) {
  const { C } = useTheme();
  return <select value={value} onChange={onChange}
    style={{ width:"100%", boxSizing:"border-box", background:C.card, border:`1.5px solid ${C.border}`, borderRadius:10, color:C.text, padding:"12px 14px", paddingRight:32, fontSize:14, outline:"none", fontFamily:"Barlow,sans-serif", marginBottom:10, appearance:"none", backgroundImage:`url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%238baac8' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`, backgroundRepeat:"no-repeat", backgroundPosition:"right 10px center" }}>
    {children}
  </select>;
}

function Btn({ label, onClick, variant="primary", small, icon, disabled }) {
  const { C } = useTheme();
  const v = {
    primary:   { background:`linear-gradient(135deg,${C.blue},${C.bright})`, color:"#fff", border:"none", boxShadow:`0 4px 14px ${C.blue}40` },
    secondary: { background:`${C.mid}40`, color:C.text, border:`1px solid ${C.border}`, boxShadow:"none" },
    ghost:     { background:"transparent", color:C.text, border:`1px solid ${C.border}`, boxShadow:"none" },
    danger:    { background:C.red, color:"#fff", border:"none", boxShadow:"none" },
  };
  const isComponent = icon && (typeof icon === "function" || icon.$$typeof);
  const IconComp = icon;
  return <button onClick={onClick} disabled={disabled}
    style={{ ...v[variant], borderRadius:10, padding:small?"8px 14px":"12px 18px", fontSize:small?13:14, fontWeight:700, cursor:disabled?"default":"pointer", fontFamily:"Barlow,sans-serif", marginBottom:small?0:8, width:small?"auto":"100%", opacity:disabled?.5:1, display:"flex", alignItems:"center", justifyContent:"center", gap:8, transition:"all 0.15s" }}>
    {icon && (isComponent ? <IconComp size={small?14:16} /> : <span style={{ fontSize:small?13:16 }}>{icon}</span>)}{label}
  </button>;
}

function Modal({ title, onClose, children }) {
  const { C } = useTheme();
  return (
    <div style={{ position:"fixed", top:0, left:0, right:0, bottom:0, background:"rgba(0,0,0,0.6)", backdropFilter:"blur(4px)", zIndex:500, display:"flex", alignItems:"flex-end", justifyContent:"center", overflow:"hidden" }} onClick={onClose}>
      <div style={{ background:C.card, borderRadius:"18px 18px 0 0", border:`1px solid ${C.border}`, borderBottom:"none", width:"100%", maxWidth:500, height:"90vh", maxHeight:"90vh", display:"flex", flexDirection:"column", animation:"modalFadeIn 0.2s ease" }} onClick={e => e.stopPropagation()}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"20px 20px 16px", flexShrink:0, borderBottom:`1px solid ${C.border}` }}>
          <div style={{ fontWeight:700, fontSize:18, fontFamily:"Barlow Condensed" }}>{title}</div>
          <button onClick={onClose} style={{ background:"none", border:"none", color:C.textMuted, cursor:"pointer", padding:4, display:"flex" }}><X size={20} /></button>
        </div>
        <div style={{ flex:"1 1 auto", overflowY:"auto", WebkitOverflowScrolling:"touch", overscrollBehavior:"contain", minHeight:0, padding:"16px 20px calc(24px + env(safe-area-inset-bottom))" }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function ProgressBar({ pct }) {
  const { C } = useTheme();
  return (
    <div style={{ height:6, borderRadius:3, background:`${C.mid}40`, overflow:"hidden", marginTop:8 }}>
      <div style={{ height:"100%", width:`${Math.min(pct||0,100)}%`, background:`linear-gradient(90deg, ${C.accent}, ${C.bright})`, borderRadius:3, transition:"width 0.3s ease" }} />
    </div>
  );
}

function SecTitle({ label }) {
  const { C } = useTheme();
  return <div style={{ fontSize:11, fontWeight:700, color:C.textMuted, letterSpacing:1.2, textTransform:"uppercase", marginBottom:10, marginTop:4 }}>{label}</div>;
}

function Empty({ icon, msg }) {
  const { C } = useTheme();
  const IconComp = icon || Inbox;
  return (
    <div style={{ textAlign:"center", padding:"40px 20px", color:C.textMuted }}>
      {(typeof IconComp === "function" || IconComp?.$$typeof) ? <IconComp size={40} color={C.textMuted} /> : <div style={{ fontSize:40, marginBottom:12 }}>{IconComp}</div>}
      <div style={{ fontSize:14, marginTop:12 }}>{msg}</div>
    </div>
  );
}

// ─── SPLASH SCREEN ────────────────────────────────────────────────────────────
function SplashScreen() {
  const { theme, C } = useTheme();
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: theme === "light" ? "#ffffff" : `radial-gradient(ellipse at center, ${C.mid}40 0%, ${C.bg} 70%)`,
      display: "flex", alignItems: "center", justifyContent: "center",
      animation: "splashFade 0.4s ease 1.8s forwards"
    }}>
      <div className="splash-logo" style={{ textAlign: "center" }}>
        <img src="/logo-splash.png" alt="Edil Blu"
          style={{ width: 200, height: "auto", margin: "0 auto", display: "block",
                   filter: "drop-shadow(0 10px 40px rgba(46,107,184,0.3))" }} />
      </div>
    </div>
  );
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const { C } = useTheme();
  const [email, setEmail] = useState(() => localStorage.getItem("eb_email") || "");
  const [pw, setPw] = useState(() => localStorage.getItem("eb_pw") || "");
  const [ricordami, setRicordami] = useState(() => !!localStorage.getItem("eb_email"));
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPw, setShowPw] = useState(false);

  const login = async () => {
    if (!email || !pw) return;
    setLoading(true); setErr("");
    try {
      const cred = await signInWithEmailAndPassword(auth, email, pw);
      const userData = await findUserDoc(cred.user.uid);
      if (userData) {
        if (ricordami) {
          localStorage.setItem("eb_email", email);
          localStorage.setItem("eb_pw", pw);
        } else {
          localStorage.removeItem("eb_email");
          localStorage.removeItem("eb_pw");
        }
        const raw = { uid: cred.user.uid, ...userData };
        onLogin({ ...raw, ruolo: getRuolo(raw), mansione: raw.ruolo });
      } else setErr("Utente non trovato nel sistema.");
    } catch { setErr("Email o password non corretti."); }
    setLoading(false);
  };

  return (
    <div style={{ minHeight:"100vh", background:`radial-gradient(ellipse at 30% 20%,${C.mid}40 0%,${C.bg} 60%)`, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:24 }}>
      {/* Logo */}
      <div style={{ textAlign:"center", marginBottom:40 }}>
        <img src="/logo-splash.png" alt="Edil Blu" style={{ width: 140, height: "auto", margin: "0 auto 8px", display: "block", filter: `drop-shadow(0 10px 30px ${C.blue}50)` }} />
        <div style={{ fontSize:10, color:C.accent, letterSpacing:4, textTransform:"uppercase", marginTop:5 }}>Gestionale Aziendale</div>
      </div>

      {/* Card login */}
      <div style={{ width:"100%", maxWidth:360, background:`${C.card}e0`, border:`1px solid ${C.borderLight}`, borderRadius:20, padding:28, backdropFilter:"blur(12px)" }}>
        <div style={{ marginBottom:20 }}>
          <div style={{ fontSize:10, color:C.textMuted, fontWeight:700, letterSpacing:1.5, marginBottom:8 }}>EMAIL</div>
          <div style={{ position:"relative" }}>
            <input type="email" placeholder="nome@edilblu.it" value={email} onChange={e=>setEmail(e.target.value)}
              onKeyDown={e=>e.key==="Enter"&&login()}
              style={{ width:"100%", boxSizing:"border-box", background:`${C.mid}30`, border:`1px solid ${C.border}`, borderRadius:10, color:C.text, padding:"12px 14px", fontSize:14, outline:"none", fontFamily:"Barlow,sans-serif" }} />
          </div>
        </div>
        <div style={{ marginBottom:20 }}>
          <div style={{ fontSize:10, color:C.textMuted, fontWeight:700, letterSpacing:1.5, marginBottom:8 }}>PASSWORD</div>
          <div style={{ position:"relative" }}>
            <input type={showPw?"text":"password"} placeholder="••••••••" value={pw} onChange={e=>setPw(e.target.value)}
              onKeyDown={e=>e.key==="Enter"&&login()}
              style={{ width:"100%", boxSizing:"border-box", background:`${C.mid}30`, border:`1px solid ${C.border}`, borderRadius:10, color:C.text, padding:"12px 44px 12px 14px", fontSize:14, outline:"none", fontFamily:"Barlow,sans-serif" }} />
            <button onClick={()=>setShowPw(!showPw)} style={{ position:"absolute", right:12, top:"50%", transform:"translateY(-50%)", background:"none", border:"none", color:C.textMuted, cursor:"pointer", fontSize:16 }}>
              {showPw?"🙈":"👁"}
            </button>
          </div>
        </div>

        {/* Ricordami */}
        <label style={{ display:"flex", alignItems:"center", gap:10, marginBottom:20, cursor:"pointer" }}>
          <div onClick={()=>setRicordami(!ricordami)}
            style={{ width:20, height:20, borderRadius:6, border:`2px solid ${ricordami?C.accent:C.border}`, background:ricordami?C.accent:"transparent", display:"flex", alignItems:"center", justifyContent:"center", transition:"all .2s", flexShrink:0 }}>
            {ricordami && <span style={{ color:"#000", fontSize:12, fontWeight:800 }}>✓</span>}
          </div>
          <span style={{ fontSize:13, color:C.textDim }}>Ricordami</span>
        </label>

        {err && <div style={{ background:C.redDim, border:`1px solid ${C.red}40`, borderRadius:8, color:C.red, fontSize:13, marginBottom:16, padding:"10px 14px", textAlign:"center" }}>{err}</div>}

        <button onClick={login} disabled={loading||!email||!pw}
          style={{ width:"100%", background:`linear-gradient(135deg,${C.blue},${C.bright})`, border:"none", borderRadius:12, color:"#fff", padding:"14px", fontSize:15, fontWeight:800, cursor:"pointer", fontFamily:"Barlow,sans-serif", opacity:(loading||!email||!pw)?.6:1, letterSpacing:0.5 }}>
          {loading ? "Accesso in corso..." : "Accedi →"}
        </button>
      </div>
    </div>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function Dashboard({ user, stats, onSection }) {
  const { C } = useTheme();
  const [ferieAlert, setFerieAlert] = useState([]);
  const [rapAlert, setRapAlert] = useState([]);
  const [showRapForm, setShowRapForm] = useState(false);
  const [cantiereOggi, setCantiereOggi] = useState(null);
  const [cantiereOggiProject, setCantiereOggiProject] = useState(null);
  const [incarichi, setIncarichi] = useState([]);
  const [ultimiRap, setUltimiRap] = useState([]);

  const oggi = new Date().toLocaleDateString("it-IT", { weekday:"long", day:"numeric", month:"long", year:"numeric" });
  const ora = new Date().getHours();
  const saluto = ora < 12 ? "Buongiorno" : ora < 18 ? "Buon pomeriggio" : "Buonasera";
  const todayStr = new Date().toISOString().split("T")[0];

  useEffect(() => {
    if (isManager(user.ruolo)) {
      getDocs(query(collection(db,"richieste_assenza"),where("stato","==","in_attesa")))
        .then(s=>setFerieAlert(s.docs.map(d=>({id:d.id,...d.data()}))));
    }
    if (canEdit(user.ruolo)) {
      const ieri = new Date(); ieri.setDate(ieri.getDate()-1);
      getDocs(query(collection(db,"timesheets"),where("date",">=",ieri)))
        .then(s=>setRapAlert(s.docs.map(d=>({id:d.id,...d.data()}))));
    }
    // Cantiere di oggi
    getDocs(query(collection(db,"assegnazioni_manuali"),where("operaioId","==",user.uid),where("data","==",todayStr)))
      .then(s => { if (s.docs.length > 0) setCantiereOggi(s.docs[0].data()) }).catch(()=>{});
    // Incarichi miei aperti
    getDocs(query(collection(db,"incarichi"),where("assegnatoA","==",user.uid)))
      .then(s => setIncarichi(s.docs.map(d=>d.data()).filter(i=>i.stato!=="completato"&&i.stato!=="confermato"))).catch(()=>{});
    // Ultimi rapportini (real-time)
    const unsubUltimiRap = onSnapshot(query(collection(db,"timesheets"),where("workerId","==",user.uid),orderBy("date","desc")), s => {
      setUltimiRap(s.docs.slice(0,5).map(d=>({id:d.id,...d.data()})));
    });
    // Reload al ritorno in foreground
    const handleVisibility = () => {
      if (!document.hidden) {
        getDocs(query(collection(db,"incarichi"),where("assegnatoA","==",user.uid)))
          .then(s => setIncarichi(s.docs.map(d=>d.data()).filter(i=>i.stato!=="completato"&&i.stato!=="confermato"))).catch(()=>{});
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => { unsubUltimiRap(); document.removeEventListener("visibilitychange", handleVisibility); };
  }, [user.ruolo, user.uid]);

  useEffect(() => {
    if (!cantiereOggi?.projectId && !cantiereOggi?.cantiereId) { setCantiereOggiProject(null); return; }
    const pid = cantiereOggi.projectId || cantiereOggi.cantiereId;
    getDoc(doc(db, "projects", pid)).then(s => {
      if (s.exists()) setCantiereOggiProject({ id: s.id, ...s.data() });
    }).catch(() => {});
  }, [cantiereOggi?.projectId, cantiereOggi?.cantiereId]);

  // Azioni rapide per operaio
  const azioniOperaio = [
    { icon: ClipboardList, label:"Rapportino", color:C.accent,  action:()=>setShowRapForm(true) },
    { icon: HardHat,       label:"Cantieri",   color:C.bright,  action:()=>onSection("cantieri") },
    { icon: Calendar,      label:"Programma",  color:C.green,   action:()=>onSection("personale") },
    { icon: Plane,         label:"Ferie",      color:"#a78bfa", action:()=>onSection("personale") },
  ];

  // Azioni rapide per manager
  const azioniManager = [
    { icon: HardHat,       label:"Cantieri",   color:C.bright,  action:()=>onSection("cantieri") },
    { icon: ClipboardList, label:"Rapportini", color:C.accent,  action:()=>onSection("gestione") },
    { icon: Activity,      label:"Crono",      color:C.green,   action:()=>onSection("cronoprogramma") },
    { icon: Settings,      label:"Gestione",   color:C.gold,    action:()=>onSection("gestione") },
  ];

  const azioni = user.ruolo==="operaio" ? azioniOperaio : azioniManager;

  return (
    <div style={{ paddingBottom:90, flex:1, overflowY:"auto", background:C.bg, minHeight:"100vh" }} className="fu">

      {/* Header saluto */}
      <div style={{ padding:"20px 20px 24px", background:C.surface, borderBottom:`1px solid ${C.border}`, display:"flex", alignItems:"center", gap:14 }}>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:11, color:C.textMuted, fontWeight:600, letterSpacing:0.5 }}>{saluto.toUpperCase()}</div>
          <div style={{ fontSize:19, fontWeight:700, color:C.text, marginTop:2 }}>{user.nome} {user.cognome||""}</div>
        </div>
        <Avatar name={`${user.nome} ${user.cognome||""}`} role={user.ruolo} size={40} />
      </div>

      {/* Data + badge ruolo */}
      <div style={{ padding:"14px 20px 0", display:"flex", alignItems:"center", gap:10 }}>
        <RoleBadge role={user.ruolo} />
        <span style={{ fontSize:12, color:C.textMuted, textTransform:"capitalize" }}>{oggi}</span>
      </div>

      {/* CONTENT */}
      <div style={{ padding:"16px 20px" }}>

        {/* Alert ferie (solo manager) */}
        {isManager(user.ruolo) && ferieAlert.length > 0 && (
          <Card onClick={()=>onSection("gestione")} style={{ marginBottom:12, borderLeft:`3px solid ${C.gold}`, padding:14, cursor:"pointer" }}>
            <div style={{ display:"flex", alignItems:"center", gap:12 }}>
              <div style={{ width:38, height:38, borderRadius:10, background:C.goldDim, display:"flex", alignItems:"center", justifyContent:"center" }}>
                <Plane size={18} color={C.gold} />
              </div>
              <div style={{ flex:1 }}>
                <div style={{ fontWeight:700, fontSize:13, color:C.text }}>Ferie da approvare</div>
                <div style={{ fontSize:11, color:C.textMuted, marginTop:2 }}>{ferieAlert.map(f=>f.nomeUtente).join(", ")}</div>
              </div>
              <div style={{ background:C.gold, color:"#000", borderRadius:20, padding:"2px 9px", fontSize:11, fontWeight:800 }}>{ferieAlert.length}</div>
            </div>
          </Card>
        )}

        {/* Alert rapportini */}
        {canEdit(user.ruolo) && rapAlert.length > 0 && (
          <Card onClick={()=>onSection("gestione")} style={{ marginBottom:12, borderLeft:`3px solid ${C.accent}`, padding:14, cursor:"pointer" }}>
            <div style={{ display:"flex", alignItems:"center", gap:12 }}>
              <div style={{ width:38, height:38, borderRadius:10, background:C.accentDim, display:"flex", alignItems:"center", justifyContent:"center" }}>
                <ClipboardList size={18} color={C.accent} />
              </div>
              <div style={{ flex:1 }}>
                <div style={{ fontWeight:700, fontSize:13, color:C.text }}>Nuovi rapportini</div>
                <div style={{ fontSize:11, color:C.textMuted, marginTop:2 }}>Ultime 24 ore</div>
              </div>
              <div style={{ background:C.accent, color:"#fff", borderRadius:20, padding:"2px 9px", fontSize:11, fontWeight:800 }}>{rapAlert.length}</div>
            </div>
          </Card>
        )}

        {/* Cantiere di oggi */}
        {cantiereOggi && (
          <Card onClick={()=>onSection("cantieri")} style={{ marginBottom:16, padding:16, cursor:"pointer", background:`linear-gradient(135deg, ${C.blue}, ${C.accent})`, border:"none" }}>
            <div style={{ fontSize:10, color:"rgba(255,255,255,0.8)", fontWeight:600, letterSpacing:0.5, marginBottom:4 }}>OGGI LAVORI A</div>
            <div style={{ fontSize:17, fontWeight:700, color:"#fff" }}>
              {cantiereOggiProject ? formatNomeCantiere(cantiereOggiProject) : (cantiereOggi.cantiereName || cantiereOggi.projectName || "Cantiere assegnato")}
            </div>
            {cantiereOggiProject && formatCommittente(cantiereOggiProject) && (
              <div style={{ fontSize:12, color:"rgba(255,255,255,0.85)", marginTop:3, fontWeight:600 }}>
                {formatCommittente(cantiereOggiProject)}
              </div>
            )}
            {cantiereOggiProject && formatIndirizzo(cantiereOggiProject) ? (
              <div style={{ fontSize:11, color:"rgba(255,255,255,0.72)", marginTop:4 }}>📍 {formatIndirizzo(cantiereOggiProject)}</div>
            ) : cantiereOggi.indirizzo && (
              <div style={{ fontSize:11, color:"rgba(255,255,255,0.72)", marginTop:4 }}>📍 {cantiereOggi.indirizzo}</div>
            )}
            {cantiereOggi.lavorazione && <div style={{ fontSize:11, color:"rgba(255,255,255,0.9)", marginTop:6, fontWeight:600 }}>{cantiereOggi.lavorazione}</div>}
          </Card>
        )}
        {!cantiereOggi && user.ruolo === "operaio" && (
          <Card style={{ marginBottom:16, padding:14, textAlign:"center" }}>
            <div style={{ fontSize:13, color:C.textMuted }}>Nessun cantiere programmato oggi</div>
          </Card>
        )}

        {/* Incarichi in sospeso */}
        {incarichi.length > 0 && (
          <>
            <SecTitle label="Incarichi aperti" />
            {incarichi.map((inc, i) => (
              <Card key={i} style={{ marginBottom:8, padding:12 }}>
                <div style={{ fontSize:13, fontWeight:600, color:C.text }}>{inc.titolo || "Incarico"}</div>
                <div style={{ fontSize:11, color:C.textMuted, marginTop:2 }}>{inc.descrizione || ""}</div>
              </Card>
            ))}
          </>
        )}

        {/* Azioni rapide (grid 2x2) */}
        <SecTitle label="Accesso rapido" />
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:24 }}>
          {azioni.map(a => {
            const IconComp = a.icon;
            return (
              <Card key={a.label} onClick={a.action} style={{ padding:18, cursor:"pointer", textAlign:"center" }}>
                <div style={{ width:48, height:48, borderRadius:12, margin:"0 auto 10px", background:`${a.color}18`, display:"flex", alignItems:"center", justifyContent:"center" }}>
                  <IconComp size={24} color={a.color} />
                </div>
                <div style={{ fontSize:13, fontWeight:700, color:C.text }}>{a.label}</div>
              </Card>
            );
          })}
        </div>

        {/* Stats (solo manager) */}
        {!["operaio"].includes(user.ruolo) && (
          <>
            <SecTitle label="Riepilogo" />
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:16 }}>
              {[
                { l:"Cantieri",  v:stats.cantieri, icon:HardHat,       c:C.accent },
                { l:"Operai",    v:stats.operai,   icon:User,           c:C.green  },
                { l:"Ferie",     v:stats.ferie,    icon:Plane,          c:C.gold   },
                { l:"Rapportini",v:stats.rap,      icon:ClipboardList,  c:C.bright },
              ].map(s => {
                const SIcon = s.icon;
                return (
                  <Card key={s.l} style={{ padding:"14px 16px", display:"flex", alignItems:"center", gap:12 }}>
                    <div style={{ width:40, height:40, borderRadius:10, background:`${s.c}18`, display:"flex", alignItems:"center", justifyContent:"center" }}>
                      <SIcon size={20} color={s.c} />
                    </div>
                    <div>
                      <div style={{ fontFamily:"Barlow Condensed", fontWeight:800, fontSize:26, color:s.c, lineHeight:1 }}>{s.v}</div>
                      <div style={{ fontSize:11, color:C.textMuted, marginTop:2 }}>{s.l}</div>
                    </div>
                  </Card>
                );
              })}
            </div>
          </>
        )}

        {/* Ultimi rapportini */}
        {ultimiRap.length > 0 && (
          <>
            <SecTitle label="Ultimi rapportini" />
            <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:16 }}>
              {ultimiRap.map(r => (
                <Card key={r.id} style={{ padding:12, display:"flex", alignItems:"center", gap:12 }}>
                  <Calendar size={18} color={C.accent} />
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:13, fontWeight:600, color:C.text }}>{r.date?.toDate?.()?.toLocaleDateString("it-IT")||r.date||""}</div>
                    <div style={{ fontSize:11, color:C.textMuted, marginTop:2 }}>{r.totaleOre||r.hoursWorked||0}h · {r.projectName||r.cantiere||"Cantiere"}</div>
                  </div>
                </Card>
              ))}
            </div>
          </>
        )}
      </div>

      {showRapForm && <FormRapportino user={user} onSaved={()=>{}} onClose={()=>setShowRapForm(false)} />}
    </div>
  );
}

// ─── IMPOSTAZIONI ────────────────────────────────────────────────────────────
function Impostazioni({ user }) {
  const { theme, setTheme, C } = useTheme();

  return (
    <div style={{ padding:"20px 16px 90px", background:C.bg, minHeight:"100vh" }} className="fu">
      <div style={{ fontSize:22, fontWeight:700, color:C.text, marginBottom:20 }}>Impostazioni</div>

      <SecTitle label="Aspetto" />
      <Card style={{ marginBottom:16, padding:4 }}>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:4 }}>
          <button onClick={()=>setTheme("light")}
            style={{ padding:"12px", borderRadius:10, border:"none", background:theme==="light"?C.accent:"transparent", color:theme==="light"?"#fff":C.text, fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"Barlow", display:"flex", alignItems:"center", justifyContent:"center", gap:8, transition:"all 0.15s" }}>
            <Sun size={16} /> Chiaro
          </button>
          <button onClick={()=>setTheme("dark")}
            style={{ padding:"12px", borderRadius:10, border:"none", background:theme==="dark"?C.accent:"transparent", color:theme==="dark"?"#fff":C.text, fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"Barlow", display:"flex", alignItems:"center", justifyContent:"center", gap:8, transition:"all 0.15s" }}>
            <Moon size={16} /> Scuro
          </button>
        </div>
      </Card>

      <SecTitle label="Account" />
      <Card style={{ marginBottom:10, padding:14, display:"flex", alignItems:"center", gap:12 }}>
        <Avatar name={`${user.nome} ${user.cognome||""}`} role={user.ruolo} size={44} />
        <div style={{ flex:1 }}>
          <div style={{ fontSize:14, fontWeight:600, color:C.text }}>{user.nome} {user.cognome||""}</div>
          <div style={{ fontSize:12, color:C.textMuted, marginTop:2 }}>{user.email}</div>
        </div>
        <RoleBadge role={user.ruolo} />
      </Card>

      <Card style={{ marginBottom:10, padding:14 }}>
        <div style={{ fontSize:12, color:C.textMuted, marginBottom:4 }}>Versione app</div>
        <div style={{ fontSize:13, color:C.text, fontWeight:600 }}>v1.0.0 beta</div>
      </Card>

      <button onClick={()=>signOut(auth)}
        style={{ width:"100%", padding:"14px", borderRadius:10, background:C.redDim, color:C.red, border:`1px solid ${C.red}40`, fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:"Barlow", marginTop:16, display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
        <LogOut size={18} /> Esci
      </button>
    </div>
  );
}

// ─── LAVORAZIONI (sub-component) ─────────────────────────────────────────────
function Lavorazioni({ cantiere, user }) {
  const [categorie, setCategorie] = useState([]);
  const [lavorazioni, setLavorazioni] = useState([]);
  const [showCat, setShowCat] = useState(false);
  const [showLav, setShowLav] = useState(false);
  const [newCat, setNewCat] = useState("");
  const [lavForm, setLavForm] = useState({ nome:"", categoria:"", descrizione:"", percentuale:0 });
  const canMod = canEdit(user.ruolo);

  useEffect(() => {
    const u1 = onSnapshot(collection(db,`cantieri/${cantiere.id}/lavorazioni`), s => {
      const lavs = s.docs.map(d=>({id:d.id,...d.data()}));
      setLavorazioni(lavs);
      // ricalcola avanzamento cantiere
      if (lavs.length > 0) {
        const avg = lavs.reduce((a,l)=>a+(l.percentuale||0),0) / lavs.length;
        updateDoc(doc(db,"cantieri",cantiere.id),{ avanzamento: Math.round(avg) });
      }
    });
    const u2 = onSnapshot(collection(db,`cantieri/${cantiere.id}/categorie_lav`), s => {
      setCategorie(s.docs.map(d=>({id:d.id,...d.data()})));
    });
    return () => { u1(); u2(); };
  }, [cantiere.id]);

  const creaCat = async () => {
    if (!newCat.trim()) return;
    await addDoc(collection(db,`cantieri/${cantiere.id}/categorie_lav`), { nome:newCat.trim(), createdAt:serverTimestamp() });
    setNewCat(""); setShowCat(false);
  };

  const creaLav = async () => {
    if (!lavForm.nome || !lavForm.categoria) return;
    await addDoc(collection(db,`cantieri/${cantiere.id}/lavorazioni`), {
      ...lavForm, percentuale:0, completata:false, createdAt:serverTimestamp()
    });
    setLavForm({ nome:"", categoria:"", descrizione:"", percentuale:0 });
    setShowLav(false);
  };

  const aggiornaPct = async (id, pct) => {
    const val = Math.max(0,Math.min(100,Number(pct)));
    await updateDoc(doc(db,`cantieri/${cantiere.id}/lavorazioni`,id),{
      percentuale: val, completata: val>=100
    });
  };

  const toggleCheck = async (lav) => {
    const nuovoPct = lav.completata ? 0 : 100;
    await updateDoc(doc(db,`cantieri/${cantiere.id}/lavorazioni`,lav.id),{
      completata: !lav.completata, percentuale: nuovoPct
    });
  };

  const catNomi = categorie.map(c=>c.nome);

  return (
    <div>
      {canMod && (
        <div style={{ display:"flex", gap:8, marginBottom:14 }}>
          <Btn label="+ Categoria" onClick={()=>setShowCat(true)} small variant="secondary" />
          <Btn label="+ Lavorazione" onClick={()=>setShowLav(true)} small variant="ghost" />
        </div>
      )}

      {lavorazioni.length===0 && categorie.length===0 && <Empty icon="🔨" msg="Nessuna lavorazione ancora. Aggiungi una categoria per iniziare." />}

      {categorie.map(cat => {
        const lavCat = lavorazioni.filter(l=>l.categoria===cat.nome);
        const pctMedia = lavCat.length > 0 ? Math.round(lavCat.reduce((a,l)=>a+(l.percentuale||0),0)/lavCat.length) : 0;
        return (
          <div key={cat.id} style={{ marginBottom:18 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
              <div style={{ fontSize:11, fontWeight:800, color:C.accent, letterSpacing:1.5, textTransform:"uppercase" }}>{cat.nome}</div>
              <span style={{ fontSize:11, color:C.accent, fontWeight:700 }}>{pctMedia}%</span>
            </div>
            <div style={{ height:3, borderRadius:2, background:`${C.border}80`, marginBottom:10, overflow:"hidden" }}>
              <div style={{ height:"100%", width:`${pctMedia}%`, background:pctMedia>=100?C.green:C.accent, borderRadius:2, transition:"width .5s" }} />
            </div>
            {lavCat.length===0 && <div style={{ fontSize:12, color:C.textMuted, paddingLeft:8, marginBottom:8 }}>Nessuna lavorazione in questa categoria</div>}
            {lavCat.map(lav => (
              <div key={lav.id} style={{ background:C.card, border:`1px solid ${lav.completata?C.green+"50":C.border}`, borderRadius:10, padding:"12px 14px", marginBottom:8 }}>
                <div style={{ display:"flex", alignItems:"flex-start", gap:10 }}>
                  {/* Checkbox */}
                  <div onClick={()=>canMod&&toggleCheck(lav)}
                    style={{ width:22, height:22, borderRadius:6, border:`2px solid ${lav.completata?C.green:C.border}`, background:lav.completata?C.green:"transparent", display:"flex", alignItems:"center", justifyContent:"center", cursor:canMod?"pointer":"default", flexShrink:0, marginTop:1, transition:"all .2s" }}>
                    {lav.completata && <span style={{ color:"#000", fontSize:13, fontWeight:800 }}>✓</span>}
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontWeight:700, fontSize:14, color:lav.completata?C.green:C.text, textDecoration:lav.completata?"line-through":"none" }}>{lav.nome}</div>
                    {lav.descrizione && <div style={{ fontSize:11, color:C.textMuted, marginTop:3 }}>{lav.descrizione}</div>}
                    {/* Slider percentuale */}
                    {canMod && !lav.completata && (
                      <div style={{ marginTop:10 }}>
                        <div style={{ display:"flex", justifyContent:"space-between", fontSize:10, color:C.textMuted, marginBottom:4 }}>
                          <span>Avanzamento</span><span style={{ color:C.accent, fontWeight:700 }}>{lav.percentuale||0}%</span>
                        </div>
                        <input type="range" min={0} max={100} value={lav.percentuale||0}
                          onChange={e=>aggiornaPct(lav.id,e.target.value)}
                          style={{ width:"100%", accentColor:C.accent }} />
                      </div>
                    )}
                    {!canMod && (
                      <div style={{ marginTop:6 }}>
                        <div style={{ height:4, borderRadius:2, background:`${C.border}80`, overflow:"hidden" }}>
                          <div style={{ height:"100%", width:`${lav.percentuale||0}%`, background:lav.completata?C.green:C.accent, borderRadius:2 }} />
                        </div>
                      </div>
                    )}
                  </div>
                  <div style={{ fontSize:12, fontWeight:700, color:lav.completata?C.green:C.accent, minWidth:32, textAlign:"right" }}>{lav.percentuale||0}%</div>
                </div>
              </div>
            ))}
          </div>
        );
      })}

      {showCat && (
        <Modal title="Nuova Macrocategoria" onClose={()=>setShowCat(false)}>
          <Inp placeholder="Es. Fondazioni, Muratura, Impianti..." value={newCat} onChange={e=>setNewCat(e.target.value)} />
          <Btn label="✓ Crea Categoria" onClick={creaCat} />
        </Modal>
      )}

      {showLav && (
        <Modal title="Nuova Lavorazione" onClose={()=>setShowLav(false)}>
          <Inp placeholder="Nome lavorazione *" value={lavForm.nome} onChange={e=>setLavForm({...lavForm,nome:e.target.value})} />
          <Sel value={lavForm.categoria} onChange={e=>setLavForm({...lavForm,categoria:e.target.value})}>
            <option value="">Seleziona categoria *</option>
            {catNomi.map(c=><option key={c}>{c}</option>)}
          </Sel>
          <Txta placeholder="Descrizione (opzionale)" value={lavForm.descrizione} onChange={e=>setLavForm({...lavForm,descrizione:e.target.value})} rows={2} />
          <Btn label="✓ Aggiungi Lavorazione" onClick={creaLav} />
        </Modal>
      )}
    </div>
  );
}

// ─── LAVORAZIONI DAL PREVENTIVO ──────────────────────────────────────────────
function LavorazioniPreventivo({ projectId }) {
  const [voci, setVoci] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filtroStato, setFiltroStato] = useState("tutte");

  useEffect(() => {
    if (!projectId) return;
    // Prende il primo preventivo del progetto
    getDocs(query(collection(db, `projects/${projectId}/preventivi`), orderBy("numero")))
      .then(snap => {
        if (snap.empty) { setLoading(false); return; }
        const primoPreventivo = snap.docs[0].data();
        const vociFiltrate = (primoPreventivo.voci || []).filter(v => v.nome && v.categoria);
        setVoci(vociFiltrate);
        setLoading(false);
      });
  }, [projectId]);

  const categorie = [...new Set(voci.map(v => v.categoria))].sort();

  const STATI = ["tutte", "da fare", "in corso", "eseguita"];
  const statoColor = { "da fare": C.textMuted, "in corso": C.accent, "eseguita": C.green };

  // Stato locale per ogni voce (salvato in localStorage per semplicità)
  const [stati, setStati] = useState(() => {
    try { return JSON.parse(localStorage.getItem(`stati_${projectId}`) || "{}"); }
    catch { return {}; }
  });

  const setStato = (id, stato) => {
    const nuovi = { ...stati, [id]: stato };
    setStati(nuovi);
    try { localStorage.setItem(`stati_${projectId}`, JSON.stringify(nuovi)); } catch {}
  };

  const vociFiltrate = filtroStato === "tutte"
    ? voci
    : voci.filter(v => (stati[v.id] || "da fare") === filtroStato);

  if (loading) return <div style={{ padding:24, textAlign:"center", color:C.textMuted }}>Caricamento lavorazioni...</div>;
  if (voci.length === 0) return <Empty icon="🔨" msg="Nessuna lavorazione nel preventivo" />;

  return (
    <div>
      {/* Filtri stato */}
      <div style={{ display:"flex", gap:6, marginBottom:14, flexWrap:"wrap" }}>
        {STATI.map(s => (
          <button key={s} onClick={()=>setFiltroStato(s)}
            style={{ background:filtroStato===s?C.accentDim:"transparent", color:filtroStato===s?C.accent:C.textMuted, border:`1px solid ${filtroStato===s?C.accent+"60":C.border}`, borderRadius:20, padding:"5px 12px", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"Barlow", textTransform:"capitalize" }}>
            {s}
          </button>
        ))}
      </div>

      {/* Riepilogo */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8, marginBottom:14 }}>
        {[
          { l:"Totale", v:voci.length, c:C.textDim },
          { l:"In corso", v:voci.filter(v=>(stati[v.id]||"da fare")==="in corso").length, c:C.accent },
          { l:"Eseguite", v:voci.filter(v=>(stati[v.id]||"da fare")==="eseguita").length, c:C.green },
        ].map(s => (
          <div key={s.l} style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:10, padding:"10px 12px", textAlign:"center" }}>
            <div style={{ fontFamily:"Barlow Condensed", fontWeight:800, fontSize:22, color:s.c }}>{s.v}</div>
            <div style={{ fontSize:10, color:C.textMuted }}>{s.l}</div>
          </div>
        ))}
      </div>

      {/* Lavorazioni per categoria */}
      {categorie.map(cat => {
        const vociCat = vociFiltrate.filter(v => v.categoria === cat);
        if (vociCat.length === 0) return null;
        const eseguite = vociCat.filter(v=>(stati[v.id]||"da fare")==="eseguita").length;
        const pct = Math.round(eseguite/vociCat.length*100);
        return (
          <div key={cat} style={{ marginBottom:20 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
              <div style={{ fontSize:11, fontWeight:800, color:C.accent, letterSpacing:1.5, textTransform:"uppercase" }}>{cat}</div>
              <span style={{ fontSize:11, color:C.accent, fontWeight:700 }}>{eseguite}/{vociCat.length}</span>
            </div>
            <div style={{ height:3, borderRadius:2, background:`${C.border}80`, marginBottom:10, overflow:"hidden" }}>
              <div style={{ height:"100%", width:`${pct}%`, background:pct===100?C.green:C.accent, borderRadius:2, transition:"width .5s" }} />
            </div>
            {vociCat.map(v => {
              const stato = stati[v.id] || "da fare";
              const col = statoColor[stato] || C.textMuted;
              return (
                <div key={v.id} style={{ background:C.card, border:`1px solid ${stato==="eseguita"?C.green+"40":C.border}`, borderRadius:10, padding:"12px 14px", marginBottom:8 }}>
                  <div style={{ display:"flex", alignItems:"flex-start", gap:10 }}>
                    <div style={{ flex:1 }}>
                      <div style={{ fontWeight:600, fontSize:13, color:stato==="eseguita"?C.green:C.text, marginBottom:4 }}>{v.nome}</div>
                      <div style={{ fontSize:11, color:C.textMuted }}>{v.codice} · {v.quantita} {v.unitaMisura}</div>
                    </div>
                    <span style={{ background:`${col}20`, color:col, border:`1px solid ${col}40`, borderRadius:6, padding:"4px 10px", fontSize:10, fontWeight:700, whiteSpace:"nowrap" }}>
                      {stato==="da fare"?"Da fare":stato==="in corso"?"In corso":"Eseguita"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ─── CANTIERI ─────────────────────────────────────────────────────────────────
function Cantieri({ user }) {
  const [list, setList] = useState([]);
  const [sel, setSel] = useState(null);
  const [tab, setTab] = useState("anagrafica");
  const [disTab, setDisTab] = useState("strutturali");
  const [disegni, setDisegni] = useState([]);
  const [misuraFile, setMisuraFile] = useState(null); // { url, nome } — apre il misuratore
  const canMod = canEdit(user.ruolo);

  useEffect(() => {
    const statusOrder = { active: 0, draft: 1 };
    const unsub = onSnapshot(query(collection(db,"projects"),orderBy("name")), s => {
      const mapped = s.docs.map(d => ({ id: d.id, ...d.data() }));
      mapped.sort((a, b) => {
        const sa = statusOrder[a.status] ?? 2;
        const sb = statusOrder[b.status] ?? 2;
        if (sa !== sb) return sa - sb;
        return (a.name || "").localeCompare(b.name || "");
      });
      setList(mapped);
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!sel) return;
    const unsub = onSnapshot(collection(db,`projects/${sel.id}/files`), s =>
      setDisegni(s.docs.map(d=>({id:d.id,...d.data()})))
    );
    return unsub;
  }, [sel]);

  const uploadFile = async (e, categoria) => {
    const file = e.target.files[0];
    if (!file || !sel) return;
    try {
      const r = ref(storage, `projects/${sel.id}/${Date.now()}_${file.name}`);
      await uploadBytes(r, file);
      const url = await getDownloadURL(r);
      await addDoc(collection(db,`projects/${sel.id}/files`), {
        nome:file.name, url, categoria, uploadedBy:user.nome, createdAt:serverTimestamp()
      });
    } catch(e) { console.error(e); }
    e.target.value = "";
  };

  const [fasi, setFasi] = useState([]);
  const [mostraAppunti, setMostraAppunti] = useState(false);

  useEffect(() => {
    if (!sel) return;
    const unsub = onSnapshot(
      query(collection(db,`projects/${sel.id}/phases`), orderBy("orderIndex")),
      s => setFasi(s.docs.map(d=>({id:d.id,...d.data()})))
    );
    return unsub;
  }, [sel]);

  const fileRef = useRef();
  const [uploading, setUploading] = useState(false);

  const grouped = useMemo(() => {
    const out = { active: [], draft: [], altri: [] };
    for (const c of list) {
      if (c.status === "active") out.active.push(c);
      else if (c.status === "draft") out.draft.push(c);
      else out.altri.push(c);
    }
    return out;
  }, [list]);

  const STATUS_COLOR = { active:C.green, draft:C.gold, suspended:C.gold, completed:C.textMuted, cancelled:C.red };
  const STATUS_LABEL = { active:"Attivo", draft:"Bozza", suspended:"Sospeso", completed:"Completato", cancelled:"Annullato" };

  const mapsUrl = (address) => address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : null;

  if (sel) {
    const tabsCantiere = ["anagrafica","disegni","lavorazioni","appunti","contatti"];
    const disFiltrati = disegni.filter(d => d.categoria === disTab);
    // Misuratore aperto su un file del cantiere
    if (misuraFile) {
      return <MisuratoreDisegno user={user} projectId={sel.id} projectName={formatNomeCantiere(sel)} fileUrl={misuraFile.url} fileName={misuraFile.nome} onBack={() => setMisuraFile(null)} />;
    }
    return (
      <div style={{ paddingBottom:80, flex:1, overflowY:"auto" }} className="fu">
        {/* Header */}
        <div style={{ background:`linear-gradient(135deg,${C.mid},${C.blue}40)`, padding:"16px 16px 0", borderBottom:`1px solid ${C.border}` }}>
          <button onClick={()=>setSel(null)} style={{ background:"none", border:"none", color:C.accent, fontSize:13, cursor:"pointer", fontFamily:"Barlow", marginBottom:8 }}>← Cantieri</button>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:4 }}>
            <div style={{ flex:1 }}>
              {sel.code && <div style={{ fontSize:10, color:C.accent, fontWeight:700, letterSpacing:1, marginBottom:4 }}>{sel.code}</div>}
              <div style={{ fontFamily:"Barlow Condensed", fontWeight:800, fontSize:22, color: C.text }}>
                {formatNomeCantiere(sel)}
              </div>
              {formatCommittente(sel) && (
                <div style={{ fontSize:13, color:C.text, marginTop:3, fontWeight:600 }}>
                  {formatCommittente(sel)}
                </div>
              )}
              {formatIndirizzo(sel) && (
                <div style={{ fontSize:11, color:C.textMuted, marginTop:4, display:"flex", alignItems:"center", gap:4 }}>
                  <span>📍</span><span>{formatIndirizzo(sel)}</span>
                </div>
              )}
              {sel.code && (
                <div style={{ fontSize:10, color:C.textMuted, marginTop:3, opacity:0.8 }}>
                  Commessa {sel.code}
                </div>
              )}
            </div>
            <span style={{ background:`${STATUS_COLOR[sel.status]||C.textMuted}20`, color:STATUS_COLOR[sel.status]||C.textMuted, border:`1px solid ${STATUS_COLOR[sel.status]||C.textMuted}40`, borderRadius:6, padding:"3px 10px", fontSize:10, fontWeight:700, flexShrink:0, marginTop:4 }}>
              {STATUS_LABEL[sel.status]||sel.status}
            </span>
          </div>
          {sel.address && (
            <a href={mapsUrl(sel.address)} target="_blank" rel="noreferrer" style={{ display:"flex", alignItems:"center", gap:6, fontSize:12, color:C.accent, textDecoration:"none", marginBottom:10 }}>
              📍 {sel.address} <span style={{ fontSize:10 }}>→ Maps</span>
            </a>
          )}
          <div style={{ display:"flex", overflowX:"auto" }}>
            {tabsCantiere.map(t => (
              <button key={t} onClick={()=>setTab(t)}
                style={{ flex:"0 0 auto", padding:"10px 14px", background:"none", border:"none", borderBottom:`2px solid ${tab===t?C.accent:"transparent"}`, color:tab===t?C.accent:C.textMuted, fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"Barlow", textTransform:"uppercase", letterSpacing:0.5, whiteSpace:"nowrap" }}>
                {t==="fasi"?"Lavorazioni":t==="appunti"?"Appunti":t}
              </button>
            ))}
          </div>
        </div>

        <div style={{ padding:"16px 16px" }}>
          {/* ANAGRAFICA */}
          {tab==="anagrafica" && (
            <>
              <Card>
                <SecTitle label="Dati Commessa" />
                {[
                  {l:"Committente", v:formatCommittente(sel)},
                  {l:"P.IVA Cliente", v:sel.clientVatNumber},
                  {l:"Indirizzo", v:formatIndirizzo(sel)},
                  {l:"Descrizione lavori", v:sel.descrizioneLavori},
                  {l:"Inizio", v:sel.startDate?.toDate?sel.startDate.toDate().toLocaleDateString("it-IT"):sel.startDate},
                  {l:"Fine Prevista", v:sel.endDate?.toDate?sel.endDate.toDate().toLocaleDateString("it-IT"):sel.endDate},
                ].filter(r=>r.v).map(({l,v}) => (
                  <div key={l} style={{ marginBottom:10 }}>
                    <div style={{ fontSize:10, color:C.textMuted, fontWeight:700, letterSpacing:1, marginBottom:2 }}>{l.toUpperCase()}</div>
                    <div style={{ fontSize:14, color:C.text }}>{v}</div>
                  </div>
                ))}
                {sel.address && (
                  <div style={{ marginBottom:10 }}>
                    <div style={{ fontSize:10, color:C.textMuted, fontWeight:700, letterSpacing:1, marginBottom:2 }}>INDIRIZZO</div>
                    <a href={mapsUrl(sel.address)} target="_blank" rel="noreferrer" style={{ fontSize:14, color:C.accent, textDecoration:"none", display:"flex", alignItems:"center", gap:6 }}>
                      {sel.address} <span style={{ fontSize:12 }}>🗺</span>
                    </a>
                  </div>
                )}
                {sel.notes && (
                  <div>
                    <div style={{ fontSize:10, color:C.textMuted, fontWeight:700, letterSpacing:1, marginBottom:2 }}>NOTE</div>
                    <div style={{ fontSize:13, color:C.textDim, lineHeight:1.7 }}>{sel.notes}</div>
                  </div>
                )}
              </Card>
            </>
          )}

          {/* CONTATTI */}
          {tab==="contatti" && (
            <>
              <SecTitle label="Contatti di Cantiere" />
              {(!sel.contacts || sel.contacts.length===0) && <Empty icon="👥" msg="Nessun contatto associato" />}
              {(sel.contacts||[]).map((c,i) => (
                <Card key={i}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                    <div>
                      <div style={{ fontWeight:700, fontSize:14 }}>{c.contactName}</div>
                      <div style={{ fontSize:12, color:C.textDim, marginTop:2 }}>{c.role}</div>
                      <span style={{ background:C.accentDim, color:C.accent, borderRadius:4, padding:"1px 8px", fontSize:10, fontWeight:700, marginTop:4, display:"inline-block" }}>{c.type}</span>
                    </div>
                    {c.phone && (
                      <a href={`tel:${c.phone}`} style={{ background:C.greenDim, color:C.green, border:`1px solid ${C.green}40`, borderRadius:8, padding:"6px 12px", fontSize:12, fontWeight:700, textDecoration:"none" }}>
                        📞 Chiama
                      </a>
                    )}
                  </div>
                  {c.phone && <div style={{ fontSize:12, color:C.textMuted, marginTop:6 }}>{c.phone}</div>}
                  {c.email && <div style={{ fontSize:12, color:C.textMuted }}>{c.email}</div>}
                </Card>
              ))}
            </>
          )}

          {/* FASI DI LAVORO */}
          {tab==="fasi" && (
            <>
              <SecTitle label="Fasi di Lavoro" />
              {fasi.length===0 && <Empty icon="📋" msg="Nessuna fase definita per questa commessa" />}
              {fasi.map((f,i) => {
                const faseCol = {
                  not_started: C.textMuted,
                  in_progress: C.accent,
                  completed:   C.green,
                  blocked:     C.red,
                };
                const faseLabel = {
                  not_started: "Non iniziata",
                  in_progress: "In corso",
                  completed:   "Completata",
                  blocked:     "Bloccata",
                };
                const col = faseCol[f.status] || C.textMuted;
                const lbl = faseLabel[f.status] || f.status;
                const pct = f.completionPct || 0;
                return (
                  <Card key={f.id} style={{ borderLeft:`3px solid ${col}` }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:8 }}>
                      <div style={{ flex:1 }}>
                        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4 }}>
                          <span style={{ fontFamily:"Barlow Condensed", fontWeight:800, fontSize:13, color:C.textMuted }}>#{i+1}</span>
                          <div style={{ fontWeight:700, fontSize:15 }}>{f.name}</div>
                        </div>
                        <span style={{ background:`${col}20`, color:col, border:`1px solid ${col}40`, borderRadius:4, padding:"2px 8px", fontSize:10, fontWeight:700 }}>{lbl}</span>
                      </div>
                      <div style={{ fontFamily:"Barlow Condensed", fontWeight:800, fontSize:22, color:col, minWidth:48, textAlign:"right" }}>{pct}%</div>
                    </div>
                    {/* Barra avanzamento */}
                    <div style={{ height:6, borderRadius:3, background:`${C.border}80`, overflow:"hidden", marginBottom:8 }}>
                      <div style={{ height:"100%", width:`${Math.min(pct,100)}%`, background:col, borderRadius:3, transition:"width .5s" }} />
                    </div>
                    {/* Date */}
                    {(f.plannedStart || f.plannedEnd) && (
                      <div style={{ display:"flex", gap:16, fontSize:11, color:C.textMuted }}>
                        {f.plannedStart && <span>📅 Inizio: {f.plannedStart?.toDate ? f.plannedStart.toDate().toLocaleDateString("it-IT") : f.plannedStart}</span>}
                        {f.plannedEnd && <span>🏁 Fine: {f.plannedEnd?.toDate ? f.plannedEnd.toDate().toLocaleDateString("it-IT") : f.plannedEnd}</span>}
                      </div>
                    )}
                    {f.budgetAmount > 0 && (
                      <div style={{ fontSize:11, color:C.textMuted, marginTop:4 }}>
                        💰 Budget: € {Number(f.budgetAmount).toLocaleString("it-IT")}
                      </div>
                    )}
                    {f.notes && <div style={{ fontSize:12, color:C.textMuted, marginTop:6, fontStyle:"italic" }}>{f.notes}</div>}
                  </Card>
                );
              })}
            </>
          )}

          {/* LAVORAZIONI DAL PREVENTIVO */}
          {/* LAVORAZIONI DAL PREVENTIVO */}
          {tab==="lavorazioni" && (
            <LavorazioniPreventivo projectId={sel.id} />
          )}

          {/* APPUNTI */}
          {tab === "appunti" && (
            <AppuntiCantiere
              user={user}
              projectId={sel.id}
              projectName={formatNomeCantiere(sel)}
              onBack={() => setTab("anagrafica")}
            />
          )}

          {/* DISEGNI */}
          {tab==="disegni" && (
            <>
              <div style={{ display:"flex", gap:6, marginBottom:14, flexWrap:"wrap" }}>
                {["strutturali","architettonici","impianti","altro"].map(cat => (
                  <button key={cat} onClick={()=>setDisTab(cat)}
                    style={{ background:disTab===cat?C.accentDim:"transparent", color:disTab===cat?C.accent:C.textMuted, border:`1px solid ${disTab===cat?C.accent+"60":C.border}`, borderRadius:20, padding:"5px 12px", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"Barlow", textTransform:"capitalize" }}>
                    {cat}
                  </button>
                ))}
              </div>
              {canMod && (
                <>
                  <input ref={fileRef} type="file" accept=".pdf,.dwg,.png,.jpg,.jpeg" onChange={e=>uploadFile(e,disTab)} style={{ display:"none" }} />
                  <Btn label={uploading?"Caricamento...":"+ Carica disegno"} onClick={()=>fileRef.current.click()} variant="ghost" icon="📎" disabled={uploading} />
                </>
              )}
              {disFiltrati.length===0 ? <Empty icon="📐" msg={`Nessun file ${disTab}`} /> : disFiltrati.map(d=>{
                const ext = (d.nome||'').split('.').pop()?.toLowerCase()||'';
                const canMisura = ['pdf','png','jpg','jpeg','tif','tiff'].includes(ext);
                return (
                <Card key={d.id}>
                  <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                    <span style={{ fontSize:26 }}>{d.nome.match(/\.(png|jpg|jpeg)$/i)?"🖼":"📄"}</span>
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:13, fontWeight:600 }}>{d.nome}</div>
                      <div style={{ fontSize:11, color:C.textMuted }}>di {d.uploadedBy}</div>
                    </div>
                    <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                      {canMisura && (
                        <button onClick={() => setMisuraFile({ url:d.url, nome:d.nome })}
                          style={{ background:C.accentDim, border:`1px solid ${C.accent}40`, borderRadius:8, padding:"6px 10px", color:C.accent, fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"Barlow", display:"flex", alignItems:"center", gap:4 }}>
                          📐 Misura
                        </button>
                      )}
                      <a href={d.url} target="_blank" rel="noreferrer" style={{ color:C.textMuted, fontSize:18, textDecoration:"none", padding:"4px" }}>↗</a>
                    </div>
                  </div>
                </Card>
                );
              })}
            </>
          )}
        </div>
      </div>
    );
  }

  // Lista cantieri
  const renderCantiereCard = (c) => (
    <Card key={c.id} onClick={() => { setSel(c); setTab("anagrafica"); }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
        <div style={{ flex: 1 }}>
          {c.code && <div style={{ fontSize: 10, color: C.accent, fontWeight: 700, letterSpacing: 1, marginBottom: 3 }}>{c.code}</div>}
          <div style={{ fontFamily: "Barlow Condensed", fontWeight: 800, fontSize: 18 }}>{c.name}</div>
          {formatCommittente(c) && (
            <div style={{ fontSize: 12, color: C.text, marginTop: 2, fontWeight: 600 }}>
              {formatCommittente(c)}
            </div>
          )}
          {formatIndirizzo(c) && (
            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2, display: "flex", alignItems: "center", gap: 3 }}>
              <span>📍</span><span>{formatIndirizzo(c)}</span>
            </div>
          )}
        </div>
        <span style={{ background: `${STATUS_COLOR[c.status] || C.textMuted}20`, color: STATUS_COLOR[c.status] || C.textMuted, border: `1px solid ${STATUS_COLOR[c.status] || C.textMuted}40`, borderRadius: 6, padding: "2px 8px", fontSize: 10, fontWeight: 700, flexShrink: 0 }}>
          {STATUS_LABEL[c.status] || c.status}
        </span>
      </div>
    </Card>
  );

  return (
    <div style={{ paddingBottom: 80, flex: 1, overflowY: "auto", padding: "16px 16px 80px" }} className="fu">
      <SecTitle label={`${list.length} commesse`} />
      {list.length === 0 && <Empty icon={HardHat} msg="Nessuna commessa ancora" />}
      {grouped.active.length > 0 && (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, color: C.green, margin: "10px 0 8px", textTransform: "uppercase" }}>
            ATTIVI · {grouped.active.length}
          </div>
          {grouped.active.map(renderCantiereCard)}
        </>
      )}
      {grouped.draft.length > 0 && (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, color: C.gold, margin: "16px 0 8px", textTransform: "uppercase" }}>
            BOZZE · {grouped.draft.length}
          </div>
          {grouped.draft.map(renderCantiereCard)}
        </>
      )}
      {grouped.altri.length > 0 && (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, color: C.textMuted, margin: "16px 0 8px", textTransform: "uppercase" }}>
            ALTRI · {grouped.altri.length}
          </div>
          {grouped.altri.map(renderCantiereCard)}
        </>
      )}
    </div>
  );
}

// ─── CRONOPROGRAMMA ───────────────────────────────────────────────────────────
function Cronoprogramma() {
  const [list, setList] = useState([]);
  useEffect(() => { getDocs(collection(db,"cantieri")).then(s=>setList(s.docs.map(d=>({id:d.id,...d.data()})))); }, []);
  const mesi = ["Gen","Feb","Mar","Apr","Mag","Giu","Lug","Ago","Set","Ott","Nov","Dic"];
  const oggi = new Date().getMonth();
  return (
    <div style={{ padding:"16px 16px 80px" }} className="fu">
      <SecTitle label="Cronoprogramma 2025" />
      {list.length===0 && <Empty icon="📅" msg="Nessun cantiere" />}
      {list.map(c => {
        const s = c.inizio?new Date(c.inizio).getMonth():0;
        const e = c.fine?new Date(c.fine).getMonth():11;
        return (
          <Card key={c.id}>
            <div style={{ fontFamily:"Barlow Condensed", fontWeight:700, fontSize:15, marginBottom:10 }}>{c.nome}</div>
            <div style={{ display:"flex", gap:2, alignItems:"flex-end" }}>
              {mesi.map((m,i) => {
                const act = i>=s && i<=e;
                return (
                  <div key={i} style={{ flex:1, textAlign:"center" }}>
                    <div style={{ height:act?20:10, background:act?(i===oggi?C.gold:C.accent):C.border, borderRadius:3, marginBottom:3, opacity:act?1:0.3 }} />
                    <div style={{ fontSize:7, color:i===oggi?C.gold:C.textMuted, fontWeight:i===oggi?800:400 }}>{m}</div>
                  </div>
                );
              })}
            </div>
            <div style={{ display:"flex", justifyContent:"space-between", marginTop:8 }}>
              <span style={{ fontSize:10, color:C.textMuted }}>{c.inizio||"—"}</span>
              <span style={{ fontSize:11, color:C.accent, fontWeight:700 }}>{c.avanzamento||0}%</span>
              <span style={{ fontSize:10, color:C.textMuted }}>{c.fine||"—"}</span>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ─── PROCEDURE ────────────────────────────────────────────────────────────────
function Procedure({ user }) {
  const [list, setList] = useState([]);
  const [sel, setSel] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ titolo:"", categoria:"Muratura", testo:"" });
  const canMod = isManager(user.ruolo);

  const [search, setSearch] = useState("");
  const [catFilt, setCatFilt] = useState("Tutte");

  useEffect(() => {
    const unsub = onSnapshot(collection(db,"procedure_lavorazioni"), s=>setList(s.docs.map(d=>({id:d.id,...d.data()}))));
    return unsub;
  }, []);

  const crea = async () => {
    if (!form.titolo) return;
    await addDoc(collection(db,"procedure_lavorazioni"), { ...form, createdBy:user.nome, createdAt:serverTimestamp() });
    setShowForm(false);
    setForm({ titolo:"", categoria:"Muratura", testo:"" });
  };

  const filteredProc = list.filter(p => {
    if (catFilt !== "Tutte" && p.categoria !== catFilt) return false;
    if (search && !p.titolo?.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const categorie = [...new Set(list.map(p=>p.categoria))];

  if (sel) return (
    <div style={{ paddingBottom:80, flex:1, overflowY:"auto" }} className="fu">
      <div style={{ padding:"16px 16px 12px", borderBottom:`1px solid ${C.border}` }}>
        <button onClick={()=>setSel(null)} style={{ background:"none", border:"none", color:C.accent, fontSize:13, cursor:"pointer", fontFamily:"Barlow", marginBottom:8 }}>← Procedure</button>
        <div style={{ fontFamily:"Barlow Condensed", fontWeight:800, fontSize:20, marginBottom:6 }}>{sel.titolo}</div>
        <span style={{ background:C.accentDim, color:C.accent, borderRadius:4, padding:"2px 8px", fontSize:10, fontWeight:700 }}>{sel.categoria}</span>
      </div>
      <div style={{ padding:16 }}>
        {sel.testo && <div style={{ fontSize:14, color:C.textDim, lineHeight:1.8, whiteSpace:"pre-wrap", marginBottom:16 }}>{sel.testo}</div>}
        {sel.noteSicurezza && (
          <Card style={{ background:"#FF000010", border:`1px solid #FF000030` }}>
            <div style={{ fontWeight:700, fontSize:12, color:"#D00", marginBottom:6 }}>⚠ SICUREZZA</div>
            <div style={{ fontSize:13, color:"#B00", lineHeight:1.6, whiteSpace:"pre-wrap" }}>{sel.noteSicurezza}</div>
          </Card>
        )}
        {sel.steps?.length > 0 && (
          <div style={{ marginBottom:16 }}>
            <div style={{ fontWeight:700, fontSize:13, color:C.accent, marginBottom:8 }}>Procedura operativa</div>
            {sel.steps.map((s,i) => (
              <div key={i} style={{ display:"flex", gap:10, marginBottom:8 }}>
                <div style={{ width:24, height:24, borderRadius:12, background:C.accentDim, color:C.accent, display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:800, flexShrink:0 }}>{i+1}</div>
                <div style={{ fontSize:13, color:C.textDim, lineHeight:1.6, flex:1 }}>{s}</div>
              </div>
            ))}
          </div>
        )}
        {sel.materiali?.length > 0 && (
          <div style={{ marginBottom:16 }}>
            <div style={{ fontWeight:700, fontSize:13, marginBottom:6 }}>🧱 Materiali necessari</div>
            {sel.materiali.map((m,i) => <div key={i} style={{ fontSize:13, color:C.textDim, padding:"3px 0" }}>• {m}</div>)}
          </div>
        )}
        {sel.attrezzature?.length > 0 && (
          <div style={{ marginBottom:16 }}>
            <div style={{ fontWeight:700, fontSize:13, marginBottom:6 }}>🔧 Attrezzature</div>
            {sel.attrezzature.map((a,i) => <div key={i} style={{ fontSize:13, color:C.textDim, padding:"3px 0" }}>• {a}</div>)}
          </div>
        )}
        {sel.tempistiche && <div style={{ fontSize:12, color:C.textMuted, marginTop:8 }}>⏱ Tempistiche: {sel.tempistiche}</div>}
      </div>
    </div>
  );

  return (
    <div style={{ paddingBottom:80, flex:1, overflowY:"auto", padding:"16px 16px 80px" }} className="fu">
      {canMod && <Btn label="+ Nuova Procedura" onClick={()=>setShowForm(true)} icon="📋" />}
      <input placeholder="Cerca lavorazione..." value={search} onChange={e=>setSearch(e.target.value)}
        style={{ width:"100%", padding:"10px 14px", fontSize:14, border:`1px solid ${C.border}`, borderRadius:10, background:C.surface, color:C.text, marginBottom:10, boxSizing:"border-box", fontFamily:"Barlow" }} />
      <div style={{ display:"flex", gap:6, marginBottom:12, overflowX:"auto", flexWrap:"nowrap" }}>
        {["Tutte",...categorie].map(c => (
          <button key={c} onClick={()=>setCatFilt(c)} style={{ padding:"5px 12px", fontSize:11, fontWeight:600, border:`1px solid ${catFilt===c?C.accent:C.border}`, borderRadius:6, background:catFilt===c?C.accentDim:"transparent", color:catFilt===c?C.accent:C.textMuted, cursor:"pointer", whiteSpace:"nowrap", fontFamily:"Barlow" }}>{c}</button>
        ))}
      </div>
      {filteredProc.length===0 && <Empty icon="📋" msg={list.length===0?"Nessuna procedura ancora":"Nessun risultato"} />}
      {categorie.filter(c=>catFilt==="Tutte"||c===catFilt).map(cat => {
        const items = filteredProc.filter(p=>p.categoria===cat);
        if (items.length===0) return null;
        return (
        <div key={cat}>
          <SecTitle label={cat} />
          {items.map(p => (
            <Card key={p.id} onClick={()=>setSel(p)}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div style={{ fontWeight:600, fontSize:14 }}>{p.titolo}</div>
                <span style={{ color:C.accent, fontSize:20 }}>›</span>
              </div>
              <div style={{ fontSize:11, color:C.textMuted, marginTop:4 }}>{p.tempistiche||""}</div>
            </Card>
          ))}
        </div>
        );
      })}
      {showForm && (
        <Modal title="Nuova Procedura" onClose={()=>setShowForm(false)}>
          <Inp placeholder="Titolo" value={form.titolo} onChange={e=>setForm({...form,titolo:e.target.value})} />
          <Sel value={form.categoria} onChange={e=>setForm({...form,categoria:e.target.value})}>
            {["Muratura","Carpenteria","Impianti","Sicurezza","Fondazioni","Finiture","Altro"].map(c=><option key={c}>{c}</option>)}
          </Sel>
          <Txta placeholder="Testo procedura..." value={form.testo} onChange={e=>setForm({...form,testo:e.target.value})} rows={8} />
          <Btn label="✓ Pubblica" onClick={crea} />
        </Modal>
      )}
    </div>
  );
}

// ─── REGOLAMENTO ──────────────────────────────────────────────────────────────
function Regolamento({ user }) {
  const [list, setList] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ titolo:"", testo:"" });
  const canMod = isManager(user.ruolo);

  useEffect(() => {
    const unsub = onSnapshot(query(collection(db,"regolamento"),orderBy("createdAt")), s=>setList(s.docs.map(d=>({id:d.id,...d.data()}))));
    return unsub;
  }, []);

  const crea = async () => {
    if (!form.titolo) return;
    await addDoc(collection(db,"regolamento"), { ...form, createdAt:serverTimestamp() });
    setShowForm(false);
    setForm({ titolo:"", testo:"" });
  };

  return (
    <div style={{ padding:"16px 16px 80px" }} className="fu">
      {canMod && <Btn label="+ Aggiungi Articolo" onClick={()=>setShowForm(true)} icon="📜" />}
      {list.length===0 && <Empty icon="📜" msg="Nessun articolo nel regolamento" />}
      {list.map((a,i) => (
        <Card key={a.id}>
          <div style={{ display:"flex", gap:12, alignItems:"flex-start" }}>
            <div style={{ width:34, height:34, borderRadius:8, background:C.accentDim, border:`1px solid ${C.accent}40`, display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"Barlow Condensed", fontWeight:800, fontSize:14, color:C.accent, flexShrink:0 }}>{i+1}</div>
            <div>
              <div style={{ fontWeight:700, fontSize:15, marginBottom:6 }}>{a.titolo}</div>
              <div style={{ fontSize:13, color:C.textDim, lineHeight:1.7, whiteSpace:"pre-wrap" }}>{a.testo}</div>
            </div>
          </div>
        </Card>
      ))}
      {showForm && (
        <Modal title="Nuovo Articolo" onClose={()=>setShowForm(false)}>
          <Inp placeholder="Titolo articolo" value={form.titolo} onChange={e=>setForm({...form,titolo:e.target.value})} />
          <Txta placeholder="Testo..." value={form.testo} onChange={e=>setForm({...form,testo:e.target.value})} rows={6} />
          <Btn label="✓ Aggiungi" onClick={crea} />
        </Modal>
      )}
    </div>
  );
}

// ─── CHAT ─────────────────────────────────────────────────────────────────────
function Chat({ user }) {
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState("");
  const bottomRef = useRef();

  useEffect(() => {
    const unsub = onSnapshot(query(collection(db,"chat"),orderBy("createdAt")), s => {
      setMsgs(s.docs.map(d=>({id:d.id,...d.data()})));
      setTimeout(()=>bottomRef.current?.scrollIntoView({behavior:"smooth"}),80);
    });
    return unsub;
  }, []);

  const send = async () => {
    if (!text.trim()) return;
    const t = text.trim();
    setText("");
    await addDoc(collection(db,"chat"), { text:t, userId:user.uid, userName:user.nome, userRole:user.ruolo, createdAt:serverTimestamp() });
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"calc(100vh - 130px)" }}>
      <div style={{ flex:1, overflowY:"auto", padding:"12px 16px" }}>
        {msgs.length===0 && <Empty icon="💬" msg="Nessun messaggio ancora" />}
        {msgs.map(m => {
          const isMe = m.userId===user.uid;
          return (
            <div key={m.id} style={{ display:"flex", justifyContent:isMe?"flex-end":"flex-start", marginBottom:12, alignItems:"flex-end", gap:8 }}>
              {!isMe && <Avatar name={m.userName} role={m.userRole} size={28} />}
              <div style={{ maxWidth:"72%" }}>
                {!isMe && <div style={{ fontSize:10, color:C.textMuted, marginBottom:3, fontWeight:700 }}>{m.userName}</div>}
                <div style={{ background:isMe?`linear-gradient(135deg,${C.blue},${C.bright})`:C.card, borderRadius:isMe?"12px 12px 4px 12px":"12px 12px 12px 4px", padding:"10px 14px", fontSize:14, color:C.text, border:isMe?"none":`1px solid ${C.border}`, lineHeight:1.5 }}>
                  {m.text}
                </div>
                <div style={{ fontSize:9, color:C.textMuted, marginTop:3, textAlign:isMe?"right":"left" }}>
                  {m.createdAt?.toDate?m.createdAt.toDate().toLocaleTimeString("it",{hour:"2-digit",minute:"2-digit"}):""}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      <div style={{ padding:"12px 16px", background:C.surface, borderTop:`1px solid ${C.border}`, display:"flex", gap:8, alignItems:"center" }}>
        <input value={text} onChange={e=>setText(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}}}
          placeholder="Scrivi un messaggio..."
          style={{ flex:1, background:C.card, border:`1px solid ${C.border}`, borderRadius:24, color:C.text, padding:"10px 16px", fontSize:14, outline:"none", fontFamily:"Barlow,sans-serif" }} />
        <button onClick={send} style={{ width:40, height:40, borderRadius:"50%", background:`linear-gradient(135deg,${C.blue},${C.bright})`, border:"none", color:"white", fontSize:16, cursor:"pointer", flexShrink:0 }}>→</button>
      </div>
    </div>
  );
}

// ─── CALENDARIO SETTIMANALE ───────────────────────────────────────────────────
// targetUserId = UID del dipendente di cui si vuole vedere/compilare il programma
// canWrite = true solo per admin e ufficio_tecnico che compilano per altri
function CalendarioSettimanale({ user, targetUserId, targetUserNome, canWrite }) {
  const GIORNI = ["Lun","Mar","Mer","Gio","Ven","Sab"];
  const FASCE  = ["07:00","08:00","09:00","10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00"];

  const lunediDiSettimana = (d) => {
    const dt = new Date(d);
    const diff = dt.getDay()===0 ? -6 : 1-dt.getDay();
    dt.setDate(dt.getDate()+diff);
    return dt;
  };

  const uid = targetUserId || user.uid;
  const nomeTarget = targetUserNome || user.nome;

  const [settimana, setSettimana] = useState(() => lunediDiSettimana(new Date()));
  const [celle, setCelle] = useState({});
  const [editCella, setEditCella] = useState(null);
  const [editVal, setEditVal] = useState("");
  const [saving, setSaving] = useState(false);
  const [notifica, setNotifica] = useState("");
  const [ferieUtente, setFerieUtente] = useState([]);
  const [ferieAltriCount, setFerieAltriCount] = useState(0);

  const chiaveDoc = (lun) => `${uid}_${lun.toISOString().split("T")[0]}`;

  useEffect(() => {
    const k = chiaveDoc(settimana);
    // listener realtime: l operaio vede subito gli aggiornamenti
    const unsub = onSnapshot(doc(db,"programma_cal",k), s => {
      if (s.exists()) setCelle(s.data().celle||{});
      else setCelle({});
    });
    return unsub;
  }, [settimana, uid]);

  useEffect(() => {
    if (!uid) return;
    getDocs(query(collection(db,"richieste_assenza"),
      where("operaioId","==",uid),
      where("stato","==","approvata")
    )).then(s => {
      setFerieUtente(s.docs.map(d => ({ id: d.id, ...d.data() })));
    });
    const settiEnd = new Date(settimana);
    settiEnd.setDate(settiEnd.getDate() + 6);
    const dalStr = settimana.toISOString().split("T")[0];
    const alStr = settiEnd.toISOString().split("T")[0];
    getDocs(query(collection(db,"richieste_assenza"),
      where("stato","==","approvata")
    )).then(s => {
      const altri = s.docs
        .map(d => d.data())
        .filter(f => f.operaioId !== uid)
        .filter(f => {
          const df = f.dal;
          const af = f.al || f.dal;
          return df && df <= alStr && af >= dalStr;
        });
      const operaiUnici = new Set(altri.map(f => f.operaioId));
      setFerieAltriCount(operaiUnici.size);
    });
  }, [uid, settimana]);

  const getFeriaDelGiorno = (dateStr) => {
    return ferieUtente.find(f => {
      const dal = f.dal;
      const al = f.al || f.dal;
      return dal && dateStr >= dal && dateStr <= al;
    });
  };

  const spostaSettimana = (n) => {
    const nuova = new Date(settimana);
    nuova.setDate(nuova.getDate() + n*7);
    setSettimana(nuova);
  };

  const apriCella = (g, f) => {
    if (!canWrite) return;
    setEditCella(`${g}_${f}`);
    setEditVal(celle[`${g}_${f}`]||"");
  };

  const salvaCella = async () => {
    if (!editCella) return;
    setSaving(true);
    const nuoveCelle = { ...celle, [editCella]: editVal };
    setCelle(nuoveCelle);
    const k = chiaveDoc(settimana);
    await setDoc(doc(db,"programma_cal",k), {
      celle: nuoveCelle,
      userId: uid,
      nomeUtente: nomeTarget,
      settimana: settimana.toISOString().split("T")[0],
      aggiornatoDa: user.nome,
      aggiornatoAt: serverTimestamp(),
    }, {merge:true});
    // Notifica in-app per il dipendente
    await addDoc(collection(db,"notifiche"), {
      userId: uid,
      tipo: "programma",
      testo: `${user.nome} ha aggiornato il tuo programma settimanale (${settimana.toLocaleDateString("it",{day:"2-digit",month:"long"})})`,
      letto: false,
      createdAt: serverTimestamp(),
    });
    setEditCella(null);
    setSaving(false);
    setNotifica("✓ Salvato e notifica inviata!");
    setTimeout(()=>setNotifica(""), 3000);
  };

  const formatData = (lun, i) => {
    const d = new Date(lun); d.setDate(d.getDate()+i); return d.getDate();
  };
  const oggi = new Date();
  const isOggi = (i) => { const d=new Date(settimana); d.setDate(d.getDate()+i); return d.toDateString()===oggi.toDateString(); };

  return (
    <div style={{ paddingBottom:80, flex:1, overflowY:"auto" }}>
      {/* Header */}
      <div style={{ background:C.surface, borderBottom:`1px solid ${C.border}`, padding:"12px 16px" }}>
        {targetUserNome && (
          <div style={{ fontSize:11, color:C.accent, fontWeight:700, marginBottom:8, textAlign:"center", letterSpacing:0.5 }}>
            📅 Programma di {targetUserNome}
          </div>
        )}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <button onClick={()=>spostaSettimana(-1)} style={{ background:C.accentDim, border:"none", color:C.accent, borderRadius:8, padding:"6px 14px", fontSize:18, cursor:"pointer" }}>‹</button>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontFamily:"Barlow Condensed", fontWeight:800, fontSize:15, color:C.text }}>
              {settimana.toLocaleDateString("it",{day:"2-digit",month:"long"})} — {new Date(settimana.getTime()+5*86400000).toLocaleDateString("it",{day:"2-digit",month:"long",year:"numeric"})}
            </div>
            <button onClick={()=>setSettimana(lunediDiSettimana(new Date()))} style={{ background:"none", border:"none", color:C.accent, fontSize:11, cursor:"pointer", fontFamily:"Barlow", fontWeight:700 }}>Settimana corrente</button>
          </div>
          <button onClick={()=>spostaSettimana(1)} style={{ background:C.accentDim, border:"none", color:C.accent, borderRadius:8, padding:"6px 14px", fontSize:18, cursor:"pointer" }}>›</button>
        </div>
        {!canWrite && (
          <div style={{ textAlign:"center", fontSize:11, color:C.textMuted, marginTop:8 }}>
            👁 Sola lettura — il programma viene aggiornato dal tuo responsabile
          </div>
        )}
        {notifica && (
          <div style={{ textAlign:"center", fontSize:12, color:C.green, fontWeight:700, marginTop:8 }}>{notifica}</div>
        )}
      </div>

      {ferieAltriCount > 0 && (
        <div style={{ background: C.goldDim, border: `1px solid ${C.gold}40`, borderRadius: 8, padding: "8px 12px", margin: "12px 16px 0", fontSize: 12, color: C.gold, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
          <span>{"\u24D8"}</span>
          <span>{ferieAltriCount} {ferieAltriCount === 1 ? "operaio" : "operai"} in ferie questa settimana</span>
        </div>
      )}

      {/* Griglia */}
      <div style={{ overflowX:"auto" }}>
        <div style={{ minWidth:520 }}>
          <div style={{ display:"grid", gridTemplateColumns:"52px repeat(6,1fr)", borderBottom:`2px solid ${C.border}`, background:C.surface }}>
            <div />
            {GIORNI.map((g,i) => (
              <div key={g} style={{ padding:"8px 4px", textAlign:"center", borderLeft:`1px solid ${C.border}` }}>
                <div style={{ fontSize:10, fontWeight:800, color:isOggi(i)?C.accent:C.textMuted, textTransform:"uppercase" }}>{g}</div>
                <div style={{ fontFamily:"Barlow Condensed", fontWeight:800, fontSize:18, color:isOggi(i)?C.accent:C.text }}>{formatData(settimana,i)}</div>
              </div>
            ))}
          </div>
          {/* Banda FERIE: si mostra solo se almeno un giorno della settimana ha ferie */}
          {(() => {
            const giorniFerie = GIORNI.map((g, i) => {
              const dGiorno = new Date(settimana);
              dGiorno.setDate(dGiorno.getDate() + i);
              const dateStr = dGiorno.toISOString().split("T")[0];
              return getFeriaDelGiorno(dateStr);
            });
            if (!giorniFerie.some(f => f)) return null;
            return (
              <div style={{ display:"grid", gridTemplateColumns:"52px repeat(6,1fr)", borderBottom:`1px solid ${C.border}40`, minHeight: 56 }}>
                <div />
                {giorniFerie.map((feria, i) => (
                  <div key={i} style={{
                    borderLeft: `1px solid ${C.border}40`,
                    background: feria ? `${C.red}15` : "transparent",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 4
                  }}>
                    {feria && (
                      <span style={{
                        fontSize: 13,
                        fontWeight: 800,
                        color: C.red,
                        letterSpacing: 1,
                        fontFamily: "Barlow Condensed",
                        textTransform: "uppercase"
                      }}>
                        {feria.tipo === "Malattia" ? "MALATTIA" : feria.tipo === "Permesso" ? "PERMESSO" : "FERIE"}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            );
          })()}
          {FASCE.map(fascia => (
            <div key={fascia} style={{ display:"grid", gridTemplateColumns:"52px repeat(6,1fr)", borderBottom:`1px solid ${C.border}40` }}>
              <div style={{ padding:"6px 4px", fontSize:9, color:C.textMuted, fontWeight:700, textAlign:"right", paddingRight:8, paddingTop:8 }}>{fascia}</div>
              {GIORNI.map((g,i) => {
                const k = `${i}_${fascia}`;
                const val = celle[k]||"";
                const dGiorno = new Date(settimana);
                dGiorno.setDate(dGiorno.getDate()+i);
                const dateStr = dGiorno.toISOString().split("T")[0];
                const feriaGiorno = getFeriaDelGiorno(dateStr);
                return (
                  <div key={g} onClick={()=> feriaGiorno ? null : apriCella(i,fascia)}
                    style={{ minHeight:44, borderLeft:`1px solid ${C.border}40`, padding:"4px 6px", cursor: feriaGiorno ? "not-allowed" : (canWrite?"pointer":"default"), background: feriaGiorno ? `${C.red}08` : (isOggi(i)?"rgba(79,172,222,0.04)":"transparent"), position:"relative", opacity: feriaGiorno ? 0.4 : 1 }}>
                    {val && (
                      <div style={{ background:`${C.blue}80`, border:`1px solid ${C.accent}40`, borderRadius:4, padding:"3px 6px", fontSize:10, color:C.text, lineHeight:1.4, wordBreak:"break-word" }}>
                        {val}
                      </div>
                    )}
                    {!val && canWrite && (
                      <div style={{ fontSize:9, color:`${C.textMuted}50`, textAlign:"center", paddingTop:12 }}>+</div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {editCella !== null && canWrite && (
        <Modal title="Modifica slot" onClose={()=>setEditCella(null)}>
          <div style={{ fontSize:12, color:C.textMuted, marginBottom:12 }}>
            {GIORNI[Number(editCella.split("_")[0])]} — {editCella.split("_")[1]}
          </div>
          <Txta placeholder="Attività, cantiere, note..." value={editVal} onChange={e=>setEditVal(e.target.value)} rows={3} />
          <Btn label={saving?"Salvataggio...":"✓ Salva e notifica"} onClick={salvaCella} disabled={saving} />
          {editVal && <Btn label="🗑 Cancella slot" onClick={()=>setEditVal("")} variant="danger" />}
        </Modal>
      )}
    </div>
  );
}

// ─── DROPDOWN LAVORAZIONI CON RICERCA ────────────────────────────────────────
function LavorazioneSelect({ value, onChange, gruppiTask, categorie, tasks }) {
  const { C } = useTheme();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const dropdownRef = useRef(null);
  const portalRef = useRef(null);
  const inputRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 });

  const allTasks = tasks || [];
  const selectedTask = allTasks.find(t => t.id === value);
  const displayLabel = selectedTask ? (selectedTask.nome || selectedTask.name) : "";

  useEffect(() => {
    if (!open || !dropdownRef.current) return;
    const updatePos = () => {
      const rect = dropdownRef.current.getBoundingClientRect();
      setPos({
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width,
      });
    };
    updatePos();
    window.addEventListener("resize", updatePos);
    window.addEventListener("scroll", updatePos, true);
    return () => {
      window.removeEventListener("resize", updatePos);
      window.removeEventListener("scroll", updatePos, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target) &&
        (!portalRef.current || !portalRef.current.contains(e.target))
      ) {
        setOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("touchstart", handleClick);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("touchstart", handleClick);
    };
  }, [open]);

  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current && inputRef.current.focus(), 50);
    }
  }, [open]);

  const searchLower = search.trim().toLowerCase();
  const filterFn = (t) => !searchLower || (t.nome || t.name || "").toLowerCase().includes(searchLower);

  const selezionaTask = (taskId) => {
    onChange(taskId);
    setOpen(false);
    setSearch("");
  };

  const renderGruppo = (label, items, colore) => {
    if (!items || items.length === 0) return null;
    return (
      <div key={label}>
        <div style={{ padding: "8px 14px 4px", fontSize: 10, fontWeight: 700, color: colore, textTransform: "uppercase", letterSpacing: 0.6, background: `${colore}08`, position: "sticky", top: 0, zIndex: 1 }}>
          {label}
        </div>
        {items.map(t => (
          <div key={t.id} onClick={() => selezionaTask(t.id)}
            style={{ padding: "11px 14px", fontSize: 13, color: value === t.id ? C.accent : C.text, cursor: "pointer", borderBottom: `1px solid ${C.border}40`, background: value === t.id ? C.accentDim : "transparent", borderLeft: value === t.id ? `3px solid ${C.accent}` : "3px solid transparent", fontWeight: value === t.id ? 600 : 400, transition: "background 0.12s" }}>
            {t.nome || t.name}
          </div>
        ))}
      </div>
    );
  };

  // Build filtered groups
  let groups = [];
  if (gruppiTask) {
    const consFiltered = gruppiTask.prioList.filter(filterFn);
    const stessaFiltered = gruppiTask.stessaCat.filter(filterFn);
    const altreFiltered = gruppiTask.altre.filter(filterFn);
    groups = [
      { label: "\u2B50 Consigliate per te", items: consFiltered, color: C.accent },
      { label: "Stessa categoria", items: stessaFiltered, color: C.gold || "#f59e0b" },
      { label: "Altre", items: altreFiltered, color: C.textMuted },
    ];
  } else if (categorie) {
    groups = categorie.map(cat => ({
      label: cat,
      items: allTasks.filter(t => t.categoria === cat).filter(filterFn),
      color: C.textMuted,
    }));
  }
  const totalFiltered = groups.reduce((sum, g) => sum + (g.items ? g.items.length : 0), 0);

  return (
    <div ref={dropdownRef} style={{ position: "relative", width: "100%", overflow: "visible" }}>
      <div onClick={() => setOpen(!open)}
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 14px", background: `${C.blue}25`, border: `1.5px solid ${open ? C.accent : C.borderLight}`, borderRadius: 10, cursor: "pointer", fontSize: 14, color: displayLabel ? C.text : C.textDim, minHeight: 44, transition: "all 0.15s" }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
          {displayLabel || "Seleziona lavorazione..."}
        </span>
        <span style={{ color: C.textMuted, marginLeft: 8, transition: "transform 0.15s", transform: open ? "rotate(180deg)" : "rotate(0)" }}>{"\u25BE"}</span>
      </div>

      {open && createPortal(
        <div ref={portalRef} style={{
          position: "fixed",
          top: pos.top,
          left: pos.left,
          width: pos.width,
          background: C.card,
          border: `1.5px solid ${C.accent}`,
          borderRadius: 12,
          boxShadow: `0 16px 40px rgba(0,0,0,0.7), 0 0 0 1px ${C.accent}30`,
          zIndex: 999999,
          maxHeight: "min(320px, 50vh)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden"
        }}>
          <div style={{ padding: 10, borderBottom: `1px solid ${C.borderLight}`, flexShrink: 0, background: C.surface }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, background: C.bg, border: `1.5px solid ${C.borderLight}`, borderRadius: 8, padding: "8px 12px" }}>
              <Search size={14} color={C.textMuted} />
              <input ref={inputRef} type="text" value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Cerca lavorazione..."
                style={{ flex: 1, border: "none", background: "transparent", outline: "none", color: C.text, fontSize: 14, fontFamily: "inherit" }} />
              {search && (
                <span onClick={() => setSearch("")} style={{ cursor: "pointer", color: C.textMuted, fontSize: 16, lineHeight: 1, padding: "0 4px" }}>{"\u2715"}</span>
              )}
            </div>
          </div>

          <div style={{ flex: 1, overflowY: "auto", WebkitOverflowScrolling: "touch", overscrollBehavior: "contain", minHeight: 0 }}>
            {searchLower && totalFiltered === 0 ? (
              <div style={{ padding: 20, textAlign: "center", color: C.textMuted, fontSize: 13 }}>
                Nessuna lavorazione trovata
              </div>
            ) : (
              groups.map(g => renderGruppo(g.label, g.items, g.color))
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// ─── FORM RAPPORTINO (allineato ERP) ─────────────────────────────────────────
function FormRapportino({ user, onSaved, onClose, rapportinoDaModificare }) {
  const isEdit = !!rapportinoDaModificare;
  const readOnly = rapportinoDaModificare?.status === "submitted"
                   || rapportinoDaModificare?.status === "approved"
                   || rapportinoDaModificare?.status === "rejected";
  // LEGACY-EDIT: rapportino storico salvato prima dell'introduzione dei turni
  const isLegacyEdit = isEdit && (!Array.isArray(rapportinoDaModificare?.turni) || rapportinoDaModificare.turni.length === 0);
  const [showConfermaInvio, setShowConfermaInvio] = useState(false);
  const [showConfermaDelete, setShowConfermaDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [noteAperte, setNoteAperte] = useState({});
  const canDelete = rapportinoDaModificare?.id && (!rapportinoDaModificare.status || rapportinoDaModificare.status === "draft");
  const [cantieri, setCantieri] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [loadingData, setLoadingData] = useState(true);
  const [date, setDate] = useState(() => {
    if (rapportinoDaModificare?.date) {
      const d = rapportinoDaModificare.date;
      if (d?.toDate) return d.toDate().toISOString().split("T")[0];
      if (typeof d === "string") return d.split("T")[0];
      if (d instanceof Date) return d.toISOString().split("T")[0];
    }
    return new Date().toISOString().split("T")[0];
  });
  const [noPasto, setNoPasto] = useState(rapportinoDaModificare?.noPasto || false);
  const [guidaMezzo, setGuidaMezzo] = useState(!!rapportinoDaModificare?.mezzoGuidato);
  const [mezzoId, setMezzoId] = useState(rapportinoDaModificare?.mezzoGuidato?.id || "");
  const [mezzi, setMezzi] = useState([]);
  const [segnalaProblema, setSegnalaProblema] = useState(false);
  const [problemaTipo, setProblemaTipo] = useState("Guasto");
  const [problemaDescr, setProblemaDescr] = useState("");
  const [note, setNote] = useState(rapportinoDaModificare?.note || "");
  const [saving, setSaving] = useState(false);
  const [blocks, setBlocks] = useState(() => {
    if (rapportinoDaModificare?.blocks?.length) return rapportinoDaModificare.blocks;
    if (rapportinoDaModificare?.lavorazioni?.length) {
      // Raggruppa lavorazioni per projectId
      const grouped = {};
      rapportinoDaModificare.lavorazioni.forEach(l => {
        const pid = rapportinoDaModificare.projectId || l.projectId || "";
        if (!grouped[pid]) grouped[pid] = { projectId: pid, projectName: rapportinoDaModificare.projectName || l.projectName || "", lavorazioni: [] };
        grouped[pid].lavorazioni.push({ taskId: l.taskId || "", taskName: l.taskName || "", categoria: l.categoria || "", ore: l.ore || 0, nota: l.nota || "" });
      });
      const result = Object.values(grouped);
      if (result.length) return result;
    }
    return [{ projectId:"", projectName:"", lavorazioni:[{ taskId:"", taskName:"", categoria:"", ore:0, nota:"" }] }];
  });

  // Turni di lavoro: NEW = valore esistente o default 08-12 / 13-17 | LEGACY-EDIT = []
  const [turni, setTurni] = useState(() => {
    if (isLegacyEdit) return [];
    if (Array.isArray(rapportinoDaModificare?.turni) && rapportinoDaModificare.turni.length > 0) {
      return rapportinoDaModificare.turni.map(t => ({ inizio: t?.inizio || "", fine: t?.fine || "" }));
    }
    return [{ inizio: "08:00", fine: "12:00" }, { inizio: "13:00", fine: "17:00" }];
  });
  const [permesso, setPermesso] = useState(() => {
    const p = rapportinoDaModificare?.permesso;
    if (!isLegacyEdit && p && typeof p === "object") {
      return { attivo: !!p.attivo, da: p.da || "", a: p.a || "" };
    }
    return { attivo: false, da: "", a: "" };
  });

  const [taskPrioritarie, setTaskPrioritarie] = useState([]);
  const [categorieOperaio, setCategorieOperaio] = useState([]);

  useEffect(() => {
    let done = 0;
    const mark = () => { done += 1; if (done >= 2) setLoadingData(false); };
    getDocs(query(collection(db,"projects"),orderBy("name")))
      .then(s => setCantieri(s.docs.filter(d=>d.data().status==="active"||d.data().status==="draft").map(d=>({id:d.id,...d.data()}))))
      .finally(mark);
    getDocs(query(collection(db,"timesheet_tasks"),orderBy("categoria")))
      .then(s => setTasks(s.docs.filter(d=>d.data().attivo!==false).map(d=>({id:d.id,...d.data()}))))
      .finally(mark);
    getDocs(query(collection(db, "parco_mezzi"), orderBy("targa")))
      .then(s => setMezzi(s.docs.map(d => ({ id: d.id, ...d.data() }))))
      .catch(() => setMezzi([]));
  }, []);

  useEffect(() => {
    const mansione = user.mansione || user.ruolo;
    if (!mansione || RUOLI_STANDARD.includes(mansione)) return;
    getDoc(doc(db, "lavorazioni_per_ruolo", mansione)).then(snap => {
      if (snap.exists()) setTaskPrioritarie(snap.data().lavorazioni_ordinate || []);
    }).catch(() => {});
  }, [user]);

  useEffect(() => {
    if (!user?.uid) return;
    getDoc(doc(db, "utenti", user.uid)).then(snap => {
      if (snap.exists()) {
        const d = snap.data();
        setCategorieOperaio(Array.isArray(d.categorieOperaio) ? d.categorieOperaio : []);
      }
    }).catch(() => {});
  }, [user]);

  const categorie = [...new Set(tasks.map(t=>t.categoria))].sort();

  const gruppiTask = useMemo(() => {
    // NUOVA LOGICA: se operaio ha categorieOperaio, prioritizza per categoria
    if (categorieOperaio.length > 0) {
      const catPrimaria = categorieOperaio[0];
      const catSecondarie = categorieOperaio.slice(1);

      const prioList = tasks.filter(t => t.categoria === catPrimaria)
        .sort((a, b) => (a.nome || "").localeCompare(b.nome || ""));
      const prioIds = new Set(prioList.map(t => t.id));

      const stessaCat = tasks.filter(t =>
        !prioIds.has(t.id) && catSecondarie.includes(t.categoria)
      ).sort((a, b) => {
        const aIdx = catSecondarie.indexOf(a.categoria);
        const bIdx = catSecondarie.indexOf(b.categoria);
        if (aIdx !== bIdx) return aIdx - bIdx;
        return (a.nome || "").localeCompare(b.nome || "");
      });
      const stessaCatIds = new Set(stessaCat.map(t => t.id));

      const altre = tasks.filter(t => !prioIds.has(t.id) && !stessaCatIds.has(t.id))
        .sort((a, b) => (a.nome || "").localeCompare(b.nome || ""));

      return { prioList, stessaCat, altre };
    }

    // FALLBACK: vecchia logica con taskPrioritarie (lavorazioni_ordinate)
    if (!taskPrioritarie.length) return null;
    const prioList = taskPrioritarie.map(tid => tasks.find(t => t.id === tid)).filter(Boolean);
    const prioIds = new Set(prioList.map(t => t.id));
    const categoriePrio = new Set(prioList.map(t => t.categoria).filter(Boolean));
    const stessaCat = tasks.filter(t => !prioIds.has(t.id) && categoriePrio.has(t.categoria));
    const stessaCatIds = new Set(stessaCat.map(t => t.id));
    const altre = tasks.filter(t => !prioIds.has(t.id) && !stessaCatIds.has(t.id))
      .sort((a, b) => (a.nome || "").localeCompare(b.nome || ""));
    return { prioList, stessaCat, altre };
  }, [tasks, taskPrioritarie, categorieOperaio]);

  // Opzioni per i MobileSelect (bottom-sheet). Cantieri: comune/indirizzo come sub.
  const cantiereOptions = useMemo(() => cantieri.map(c => ({
    value: c.id,
    label: formatNomeCantiere(c),
    sub: [c.comune, c.indirizzo].filter(Boolean).join(" · ") || undefined,
  })), [cantieri]);

  // Lavorazioni: opzioni GIÀ ORDINATE (Consigliate → Stessa categoria → Altre),
  // stesse etichette dei gruppi di LavorazioneSelect; fallback per categoria.
  const lavOptions = useMemo(() => {
    const opt = (t, group) => ({ value: t.id, label: t.nome || t.name || "", group });
    if (gruppiTask) {
      return [
        ...gruppiTask.prioList.map(t => opt(t, "⭐ Consigliate per te")),
        ...gruppiTask.stessaCat.map(t => opt(t, "Stessa categoria")),
        ...gruppiTask.altre.map(t => opt(t, "Altre")),
      ];
    }
    return categorie.flatMap(cat => tasks.filter(t => t.categoria === cat).map(t => opt(t, cat)));
  }, [gruppiTask, categorie, tasks]);

  const updBlock = (bi, field, val) => setBlocks(prev => prev.map((b,i) => {
    if (i!==bi) return b;
    if (field==="projectId") {
      const c = cantieri.find(c=>c.id===val);
      return { ...b, projectId:val, projectName:c?.name||"" };
    }
    return { ...b, [field]:val };
  }));

  const updLav = (bi, li, field, val) => setBlocks(prev => prev.map((b,i) => {
    if (i!==bi) return b;
    return { ...b, lavorazioni: b.lavorazioni.map((l,j) => {
      if (j!==li) return l;
      if (field==="taskId") {
        const t = tasks.find(t=>t.id===val);
        return { ...l, taskId:val, taskName:t?.nome||"", categoria:t?.categoria||"" };
      }
      return { ...l, [field]:val };
    })};
  }));

  const addLav = (bi) => setBlocks(prev => prev.map((b,i) => i!==bi ? b : {
    ...b, lavorazioni:[...b.lavorazioni,{ taskId:"", taskName:"", categoria:"", ore:0, nota:"" }]
  }));

  const removeLav = (bi, li) => setBlocks(prev => prev.map((b,i) => i!==bi ? b : {
    ...b, lavorazioni: b.lavorazioni.filter((_,j)=>j!==li)
  }));

  const addBlock = () => setBlocks(prev => [...prev, { projectId:"", projectName:"", lavorazioni:[{ taskId:"", taskName:"", categoria:"", ore:0, nota:"" }] }]);
  const removeBlock = (bi) => setBlocks(prev => prev.filter((_,i)=>i!==bi));

  const addTurno = () => setTurni(prev => [...prev, { inizio: "", fine: "" }]);
  const updTurno = (ti, field, val) => setTurni(prev => prev.map((t, i) => i === ti ? { ...t, [field]: val } : t));
  const removeTurno = (ti) => setTurni(prev => prev.filter((_, i) => i !== ti));

  // Totali (minuti interi) + errore inline per la sezione orari
  const oreInfo = useMemo(() => {
    const lavMin = blocks.reduce((s, b) =>
      s + b.lavorazioni.reduce((s2, l) => s2 + oreToMin(l.ore), 0), 0);
    const turniMin = sumMinTurni(turni);
    const permMin = permessoMin(permesso);
    const netMin = turniMin - permMin;
    const diffMin = lavMin - netMin;

    let errore = null;
    if (turni.length > 0) {
      const hasEmpty = turni.some(t => !t.inizio || !t.fine);
      const allTimes = turni.flatMap(t => [t.inizio, t.fine]);
      if (permesso.attivo) allTimes.push(permesso.da, permesso.a);
      const stepViolation = allTimes.some(t => !isStep15Min(t));
      if (hasEmpty) {
        errore = "Compila inizio e fine per tutti i turni.";
      } else if (stepViolation) {
        errore = "Gli orari devono essere multipli di 15 minuti.";
      } else if (!turniValidi(turni)) {
        errore = "Controlla i turni: l'orario di fine deve essere dopo l'inizio.";
      } else if (permesso.attivo) {
        const da = parseTime(permesso.da);
        const a = parseTime(permesso.a);
        if (da === null || a === null) errore = "Inserisci da/a del permesso.";
        else if (a <= da) errore = "L'orario di fine permesso deve essere dopo l'inizio.";
        else if (!permessoDentroTurni(permesso, turni)) errore = "Il permesso deve essere interamente dentro un singolo turno.";
      }
    }
    return { lavMin, turniMin, permMin, netMin, diffMin, errore };
  }, [blocks, turni, permesso]);

  // Validazione orari: legacy con turni vuoti = skip | NEW con turni vuoti = fail | altrimenti strict
  const orariValidationOK = useMemo(() => {
    if (turni.length === 0) return isLegacyEdit;
    if (oreInfo.errore) return false;
    return oreInfo.diffMin === 0;
  }, [turni.length, isLegacyEdit, oreInfo]);

  const canSave = blocks.every(b => b.projectId && b.lavorazioni.every(l=>{
    const n = parseOreIT(l.ore);
    return l.taskId && typeof n === "number" && n > 0;
  })) && orariValidationOK;

  const save = async (submitted = false) => {
    if (!canSave) return;
    setSaving(true);
    try {
      const allLavs = blocks.flatMap(b => b.lavorazioni.map(l=>({ ...l, projectId:b.projectId, projectName:b.projectName })));
      const totaleOre = allLavs.reduce((s,l)=>{
        const n = parseOreIT(l.ore);
        return s + (typeof n === "number" ? n : 0);
      },0);
      const firstBlock = blocks[0];
      const data = {
        workerId: user.uid,
        workerName: user.nome + (user.cognome ? " "+user.cognome : ""),
        projectId: firstBlock.projectId,
        projectName: firstBlock.projectName,
        lavorazioni: allLavs,
        blocks,
        cantieri: blocks.map(b=>({ projectId:b.projectId, projectName:b.projectName })),
        totaleOre,
        hoursWorked: totaleOre,
        taskDescription: allLavs.map(l=>l.taskName).join(", "),
        noPasto,
        mezzoGuidato: guidaMezzo && mezzoId ? (() => {
          const m = mezzi.find(x => x.id === mezzoId);
          if (!m) return null;
          return { id: m.id, modello: m.modello || "", targa: m.targa || "", tipo: m.tipo || "" };
        })() : null,
        note: note.trim(),
        date: new Date(date),
        status: submitted ? "submitted" : "draft",
      };
      if (submitted) {
        data.submittedAt = serverTimestamp();
        data.submittedBy = auth.currentUser?.uid || "";
      }
      // Orari: scriviamo i campi solo se l'utente ha effettivamente compilato turni.
      // Legacy-edit con turni.length===0 = il doc resta legacy puro (no campi ibridi).
      if (turni.length > 0) {
        data.turni = turni.map(t => ({ inizio: t.inizio, fine: t.fine }));
        data.permesso = permesso.attivo
          ? { attivo: true, da: permesso.da, a: permesso.a }
          : { attivo: false, da: "", a: "" };
        data.oreNetteTurni = (sumMinTurni(turni) - permessoMin(permesso)) / 60;
      }
      if (rapportinoDaModificare?.id) {
        await updateDoc(doc(db, "timesheets", rapportinoDaModificare.id), { ...data, updatedAt: serverTimestamp() });
      } else {
        await addDoc(collection(db,"timesheets"), { ...data, createdAt: serverTimestamp() });
      }

      // Crea segnalazione mezzo + notifica admin
      if (guidaMezzo && mezzoId && segnalaProblema && problemaDescr.trim()) {
        const m = mezzi.find(x => x.id === mezzoId);
        if (m) {
          const userNomeCompleto = [user.nome, user.cognome].filter(Boolean).join(" ").trim() || user.displayName || "";
          try {
            const segRef = await addDoc(collection(db, "segnalazioni_mezzi"), {
              mezzoId,
              mezzoTarga: (m.targa || "").toUpperCase(),
              mezzoModello: m.modello || "",
              operaioId: user.uid,
              operaioNome: userNomeCompleto,
              data: new Date().toISOString().split("T")[0],
              tipo: problemaTipo,
              descrizione: problemaDescr.trim(),
              stato: "aperta",
              createdAt: serverTimestamp(),
            });
            try {
              const adminsSnap = await getDocs(query(collection(db, "utenti"), where("ruolo", "==", "admin")));
              for (const a of adminsSnap.docs) {
                await addDoc(collection(db, "notifiche"), {
                  tipo: "segnalazione_mezzo",
                  destinatario: a.id,
                  mittente: user.uid,
                  mittenteNome: userNomeCompleto,
                  testo: `\u26A0 ${problemaTipo} su ${(m.targa || "").toUpperCase()}: ${problemaDescr.trim().slice(0, 60)}`,
                  contesto: "parco_mezzi",
                  contestoId: mezzoId,
                  segnalazioneId: segRef.id,
                  letto: false,
                  createdAt: serverTimestamp(),
                });
              }
            } catch(eN) { console.error("Errore notifica admin:", eN); }
          } catch(e) { console.error("Errore segnalazione mezzo:", e); }
        }
      }

      onSaved();
      onClose();
    } catch (e) {
      alert("Errore salvataggio: " + (e.message || "riprova"));
    }
    setSaving(false);
  };

  const elimina = async () => {
    if (!rapportinoDaModificare?.id) return;
    setDeleting(true);
    try {
      await deleteDoc(doc(db, "timesheets", rapportinoDaModificare.id));
      onSaved();
      onClose();
    } catch (e) {
      alert("Errore eliminazione: " + (e.message || "riprova"));
      setDeleting(false);
    }
  };

  return (
    <Modal title={readOnly ? `Rapportino ${rapportinoDaModificare.status}` : isEdit ? "Modifica Rapportino" : "Nuovo Rapportino"} onClose={onClose}>
      {readOnly && (
        <div style={{ padding: "12px 14px", background: `${C.accent}15`, border: `1px solid ${C.accent}40`, borderRadius: 10, marginBottom: 14, display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: C.accent }}>
          <AlertCircle size={18} />
          <span>Questo rapportino è stato inviato e non può essere modificato.</span>
        </div>
      )}
      {/* Data */}
      <div style={{ fontSize:10, color:C.textMuted, fontWeight:700, marginBottom:4 }}>DATA</div>
      <Inp type="date" value={date} onChange={e=>setDate(e.target.value)} />

      {/* Orari di lavoro */}
      <div style={{ border:`1px solid ${C.border}`, borderRadius:10, marginBottom:10, overflow:"hidden" }}>
        <div style={{ background:`${C.mid}40`, padding:"10px 12px", borderBottom:`1px solid ${C.border}` }}>
          <div style={{ fontSize:10, color:C.accent, fontWeight:700, letterSpacing:1 }}>ORARI DI LAVORO</div>
        </div>
        <div style={{ padding:"10px 12px" }}>
          {isLegacyEdit && turni.length === 0 && (
            readOnly ? (
              <div style={{ fontSize:13, color:C.textMuted, fontStyle:"italic" }}>
                Orari non registrati (rapportino legacy). —
              </div>
            ) : (
              <div style={{ padding:"10px 12px", background:`${C.accent}10`, border:`1px dashed ${C.accent}50`, borderRadius:8, fontSize:12, color:C.textDim, marginBottom:10, lineHeight:1.4 }}>
                Rapportino legacy senza orari. Puoi aggiungerli ora se vuoi (consigliato per buste paga future), oppure lasciare vuoto.
              </div>
            )
          )}

          {turni.length > 0 && (
            <>
              {turni.map((t, ti) => (
                <div key={ti} style={{ display:"flex", gap:6, alignItems:"center", marginBottom:8 }}>
                  <Inp type="time" value={t.inizio} disabled={readOnly} step={900} onChange={e=>updTurno(ti,"inizio",e.target.value)} style={{ flex:1, marginBottom:0 }} />
                  <span style={{ color:C.textMuted, fontSize:13 }}>→</span>
                  <Inp type="time" value={t.fine} disabled={readOnly} step={900} onChange={e=>updTurno(ti,"fine",e.target.value)} style={{ flex:1, marginBottom:0 }} />
                  {!readOnly && (
                    <button onClick={()=>removeTurno(ti)} style={{ background:"none", border:"none", color:C.textMuted, fontSize:16, cursor:"pointer", minWidth:44, minHeight:44, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>✕</button>
                  )}
                </div>
              ))}
            </>
          )}

          {!readOnly && (
            <button onClick={addTurno} style={{ background:"none", border:`1px dashed ${C.border}`, borderRadius:6, color:C.textMuted, fontSize:11, padding:"12px", minHeight:44, boxSizing:"border-box", cursor:"pointer", fontFamily:"Barlow", width:"100%" }}>
              + Aggiungi turno
            </button>
          )}

          {turni.length > 0 && (
            <>
              <label style={{ display:"flex", alignItems:"center", gap:8, fontSize:13, color:C.textDim, marginTop:12, marginBottom:6, cursor: readOnly ? "default" : "pointer" }}>
                <input type="checkbox" checked={permesso.attivo} disabled={readOnly} onChange={e => {
                  const checked = e.target.checked;
                  setPermesso(p => checked ? { ...p, attivo: true } : { attivo: false, da: "", a: "" });
                }} />
                Permesso orario
              </label>
              {permesso.attivo && (
                <div style={{ display:"flex", gap:6, alignItems:"center", paddingLeft:26, marginBottom:8 }}>
                  <Inp type="time" value={permesso.da} disabled={readOnly} step={900} onChange={e=>setPermesso(p=>({...p, da:e.target.value}))} style={{ flex:1, marginBottom:0 }} />
                  <span style={{ color:C.textMuted, fontSize:13 }}>→</span>
                  <Inp type="time" value={permesso.a} disabled={readOnly} step={900} onChange={e=>setPermesso(p=>({...p, a:e.target.value}))} style={{ flex:1, marginBottom:0 }} />
                </div>
              )}

              {/* Banner validazione live */}
              {(() => {
                if (oreInfo.errore) {
                  return (
                    <div style={{ padding:"10px 12px", background:C.redDim, border:`1px solid ${C.red}50`, borderRadius:8, fontSize:12, color:C.red, marginTop:8, fontWeight:600 }}>
                      {oreInfo.errore}
                    </div>
                  );
                }
                const ok = oreInfo.diffMin === 0;
                let msg = `Lavorazioni: ${fmtMinAsOreIT(oreInfo.lavMin)} · Turni netti: ${fmtMinAsOreIT(oreInfo.netMin)}`;
                if (ok) msg += " ✓";
                else if (oreInfo.diffMin < 0) msg += ` · Mancano ${fmtMinAsOreIT(-oreInfo.diffMin)}`;
                else msg += ` · ${fmtMinAsOreIT(oreInfo.diffMin)} in più`;
                return (
                  <div style={{ padding:"10px 12px", background: ok ? C.greenDim : C.redDim, border:`1px solid ${ok ? C.green : C.red}50`, borderRadius:8, fontSize:12, color: ok ? C.green : C.red, marginTop:8, fontWeight:600 }}>
                    {msg}
                  </div>
                );
              })()}
            </>
          )}
        </div>
      </div>

      {/* Blocks cantiere */}
      {blocks.map((b,bi) => (
        <div key={bi} style={{ border:`1px solid ${C.border}`, borderRadius:10, marginBottom:10, overflow:"hidden" }}>
          <div style={{ background:`${C.mid}40`, padding:"10px 12px", borderBottom:`1px solid ${C.border}` }}>
            <div style={{ fontSize:10, color:C.accent, fontWeight:700, letterSpacing:1, marginBottom:6 }}>CANTIERE {blocks.length>1?bi+1:""}</div>
            <MobileSelect
              value={b.projectId}
              onChange={(v)=>updBlock(bi,"projectId",v)}
              options={cantiereOptions}
              searchable
              disabled={loadingData}
              placeholder={loadingData ? "Caricamento..." : "Seleziona cantiere..."}
            />
            {blocks.length>1 && (
              <button onClick={()=>removeBlock(bi)} style={{ background:"none", border:"none", color:C.red, fontSize:11, cursor:"pointer", fontFamily:"Barlow", minHeight:44, padding:"10px 4px", display:"inline-flex", alignItems:"center" }}>Rimuovi cantiere</button>
            )}
          </div>
          <div style={{ padding:"10px 12px" }}>
            <div style={{ fontSize:10, color:C.accent, fontWeight:700, letterSpacing:1, marginBottom:6 }}>LAVORAZIONI</div>
            {b.lavorazioni.map((l,li) => {
              const noteKey = `${bi}-${li}`;
              const notaAperta = noteAperte[noteKey] || !!l.nota;
              return (
                <div key={li} style={{ marginBottom:10 }}>
                  <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                    <div style={{ flex:1 }}>
                      <MobileSelect
                        value={l.taskId}
                        onChange={(taskId) => updLav(bi, li, "taskId", taskId)}
                        options={lavOptions}
                        searchable
                        disabled={loadingData}
                        placeholder={loadingData ? "Caricamento..." : "Seleziona lavorazione..."}
                      />
                    </div>
                    <Inp type="text" inputMode="decimal" placeholder="ore" value={fmtOreIT(l.ore)} onChange={e=>updLav(bi,li,"ore",e.target.value)} onBlur={e=>updLav(bi,li,"ore",parseOreIT(e.target.value))} style={{ width:70, marginBottom:0 }} />
                    {b.lavorazioni.length>1 && (
                      <button onClick={()=>removeLav(bi,li)} style={{ background:"none", border:"none", color:C.textMuted, fontSize:16, cursor:"pointer", minWidth:44, minHeight:44, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>✕</button>
                    )}
                  </div>
                  {!readOnly && (
                    <div style={{ marginTop: 4 }}>
                      {!notaAperta ? (
                        <button type="button" onClick={() => setNoteAperte(prev => ({ ...prev, [noteKey]: true }))}
                          style={{ background: "none", border: "none", color: C.accent, fontSize: 12, cursor: "pointer", padding: "4px 0", display: "flex", alignItems: "center", gap: 4, fontFamily: "Barlow" }}>
                          <Plus size={12} /> Aggiungi nota
                        </button>
                      ) : (
                        <Txta placeholder="Nota (es: rifinitura angoli, materiale finito, ecc.)" value={l.nota || ""} onChange={e => updLav(bi, li, "nota", e.target.value)} rows={2} />
                      )}
                    </div>
                  )}
                  {readOnly && l.nota && (
                    <div style={{ fontSize: 12, color: C.textDim, fontStyle: "italic", marginTop: 4, paddingLeft: 2 }}>{l.nota}</div>
                  )}
                </div>
              );
            })}
            <button onClick={()=>addLav(bi)} style={{ background:"none", border:`1px dashed ${C.border}`, borderRadius:6, color:C.textMuted, fontSize:11, padding:"12px", minHeight:44, boxSizing:"border-box", cursor:"pointer", fontFamily:"Barlow", width:"100%" }}>
              + Aggiungi lavorazione
            </button>
          </div>
        </div>
      ))}

      <button onClick={addBlock} style={{ width:"100%", padding:"13px", minHeight:44, boxSizing:"border-box", background:`${C.accent}10`, border:`1.5px dashed ${C.accent}`, borderRadius:10, color:C.accent, fontSize:13, fontWeight:600, fontFamily:"inherit", cursor:"pointer", transition:"all 0.15s", marginBottom:10 }}>
        + Aggiungi cantiere
      </button>

      {/* No pasto */}
      <label style={{ display:"flex", alignItems:"center", gap:8, fontSize:13, color:C.textDim, marginBottom:10, cursor:"pointer" }}>
        <input type="checkbox" checked={noPasto} onChange={e=>setNoPasto(e.target.checked)} />
        No pasto
      </label>

      {/* Guida mezzo */}
      <label style={{ display:"flex", alignItems:"center", gap:8, fontSize:13, color:C.textDim, marginBottom:10, cursor:"pointer" }}>
        <input type="checkbox" checked={guidaMezzo} onChange={e => {
          setGuidaMezzo(e.target.checked);
          if (!e.target.checked) setMezzoId("");
        }} />
        Guida furgone/mezzo
      </label>
      {guidaMezzo && (
        <div style={{ marginBottom: 12, paddingLeft: 26 }}>
          <select value={mezzoId} onChange={e => setMezzoId(e.target.value)}
            style={{ width: "100%", padding: "10px 12px", background: C.surface, border: `1px solid ${mezzoId ? C.accent : C.border}`, borderRadius: 8, fontSize: 14, color: C.text, fontFamily: "inherit" }}>
            <option value="">Seleziona mezzo...</option>
            {mezzi.map(m => (
              <option key={m.id} value={m.id}>
                {(m.targa || "").toUpperCase()}{m.modello ? " · " + m.modello : ""}
              </option>
            ))}
          </select>
          {mezzi.length === 0 && (
            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4, fontStyle: "italic" }}>
              Nessun mezzo disponibile. L'amministratore deve aggiungerli dal Parco Mezzi.
            </div>
          )}

          {mezzoId && (
            <>
              <label style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", cursor: "pointer", marginTop: 8 }}>
                <input type="checkbox" checked={segnalaProblema} onChange={e => {
                  setSegnalaProblema(e.target.checked);
                  if (!e.target.checked) { setProblemaTipo("Guasto"); setProblemaDescr(""); }
                }} />
                <span style={{ fontSize: 13, color: C.red, fontWeight: 600 }}>{"\u26A0"} Segnala guasto o manutenzione</span>
              </label>

              {segnalaProblema && (
                <div style={{ background: C.red + "10", border: `1px solid ${C.red}40`, borderRadius: 8, padding: 10, marginBottom: 8 }}>
                  <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 700, marginBottom: 4, letterSpacing: 0.5 }}>TIPO</div>
                  <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                    {["Guasto", "Manutenzione"].map(t => (
                      <button key={t} type="button" onClick={() => setProblemaTipo(t)}
                        style={{ flex: 1, padding: "8px 12px", background: problemaTipo === t ? C.red : "transparent", color: problemaTipo === t ? "#fff" : C.text, border: `1px solid ${problemaTipo === t ? C.red : C.border}`, borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                        {t}
                      </button>
                    ))}
                  </div>
                  <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 700, marginBottom: 4, letterSpacing: 0.5 }}>DESCRIZIONE *</div>
                  <textarea value={problemaDescr} onChange={e => setProblemaDescr(e.target.value)}
                    placeholder={problemaTipo === "Guasto" ? "Descrivi il problema al mezzo (es: freni rumorosi, perde olio...)" : "Descrivi l'intervento richiesto (es: tagliando in scadenza, gomme da cambiare...)"}
                    style={{ width: "100%", minHeight: 70, padding: 10, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, fontSize: 13, fontFamily: "inherit", resize: "vertical" }} />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Note */}
      <Txta placeholder="Note aggiuntive..." value={note} onChange={e=>setNote(e.target.value)} rows={2} />

      {!readOnly && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.3fr", gap: 10, marginTop: 16 }}>
          <Btn label={saving ? "..." : "Salva bozza"} variant="secondary" onClick={() => save(false)} disabled={saving || !canSave} />
          <Btn label={saving ? "Invio..." : "Invia rapportino →"} onClick={() => setShowConfermaInvio(true)} disabled={saving || !canSave} />
        </div>
      )}

      {canDelete && !readOnly && (
        <button type="button" onClick={() => setShowConfermaDelete(true)} disabled={deleting || saving}
          style={{ marginTop: 20, width: "100%", padding: "12px", background: "transparent", color: C.red, border: `1px solid ${C.red}40`, borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "Barlow", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, opacity: deleting ? 0.5 : 1, transition: "all 0.15s" }}>
          <Trash2 size={16} />
          {deleting ? "Eliminazione..." : "Elimina rapportino"}
        </button>
      )}

      {showConfermaDelete && (
        <div style={{ position: "fixed", inset: 0, zIndex: 600, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }} onClick={() => !deleting && setShowConfermaDelete(false)}>
          <div onClick={e => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 18, padding: 24, maxWidth: 380, width: "100%" }}>
            <div style={{ width: 54, height: 54, borderRadius: 14, background: `${C.red}20`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}>
              <Trash2 size={28} color={C.red} />
            </div>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.text, textAlign: "center", marginBottom: 8 }}>Eliminare il rapportino?</div>
            <div style={{ fontSize: 13, color: C.textMuted, textAlign: "center", lineHeight: 1.5, marginBottom: 20 }}>
              Questa operazione <b style={{ color: C.text }}>non può essere annullata</b>. Il rapportino e tutte le ore registrate saranno cancellate.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Btn label="Annulla" variant="secondary" onClick={() => setShowConfermaDelete(false)} disabled={deleting} />
              <button onClick={() => { setShowConfermaDelete(false); elimina(); }} disabled={deleting}
                style={{ padding: "12px", background: C.red, color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "Barlow", opacity: deleting ? 0.5 : 1 }}>
                {deleting ? "..." : "Sì, elimina"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showConfermaInvio && (
        <div style={{ position: "fixed", inset: 0, zIndex: 600, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }} onClick={() => setShowConfermaInvio(false)}>
          <div onClick={e => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 18, padding: 24, maxWidth: 380, width: "100%" }}>
            <div style={{ width: 54, height: 54, borderRadius: 14, background: `${C.accent}20`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}>
              <ClipboardList size={28} color={C.accent} />
            </div>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.text, textAlign: "center", marginBottom: 8 }}>Inviare il rapportino?</div>
            <div style={{ fontSize: 13, color: C.textMuted, textAlign: "center", lineHeight: 1.5, marginBottom: 20 }}>
              Dopo l'invio il rapportino sarà inviato per l'approvazione e <b style={{ color: C.text }}>non potrai più modificarlo</b>.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Btn label="Annulla" variant="secondary" onClick={() => setShowConfermaInvio(false)} />
              <Btn label={saving ? "Invio..." : "Conferma invio"} onClick={() => { setShowConfermaInvio(false); save(true); }} disabled={saving} />
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ─── AREA PERSONALE ───────────────────────────────────────────────────────────
function getSaluto() {
  const h = new Date().getHours();
  return h < 12 ? "Buongiorno" : h < 18 ? "Buon pomeriggio" : "Buonasera";
}

function AreaPersonale({ user, onSection }) {
  const { C } = useTheme();
  const [view, setView] = useState("home");
  const [tab, setTab] = useState("rapportini");
  const [rapportini, setRapportini] = useState([]);
  const [ferie, setFerie] = useState([]);
  const [buste, setBuste] = useState([]);
  const [showRap, setShowRap] = useState(false);
  const [showFerie, setShowFerie] = useState(false);
  const [ferF, setFerF] = useState({ tipo:"Ferie", dal:"", al:"", note:"" });
  const [cantiereOggi, setCantiereOggi] = useState(null);
  const [rapportinoOggi, setRapportinoOggi] = useState(null);
  const [rapportinoEdit, setRapportinoEdit] = useState(null);

  useEffect(() => {
    const unsubRap = onSnapshot(query(collection(db,"timesheets"),where("workerId","==",user.uid),orderBy("date","desc")), s => {
      setRapportini(s.docs.map(d=>({id:d.id,...d.data()})));
    });
    getDocs(query(collection(db,"richieste_assenza"),where("operaioId","==",user.uid))).then(s=>setFerie(s.docs.map(d=>({id:d.id,...d.data()}))));
    getDocs(query(collection(db,"documenti_operai"),where("operaioId","==",user.uid))).then(s=>setBuste(s.docs.map(d=>({id:d.id,...d.data()}))));
    return () => unsubRap();
  }, [user.uid]);

  useEffect(() => {
    const todayStr = new Date().toISOString().split("T")[0];
    getDocs(query(collection(db,"assegnazioni_manuali"),where("operaioId","==",user.uid),where("data","==",todayStr)))
      .then(s => { if (s.docs.length > 0) setCantiereOggi(s.docs[0].data()); }).catch(()=>{});
    const unsubToday = onSnapshot(query(collection(db,"timesheets"),where("workerId","==",user.uid)), s => {
      const draft = s.docs.find(d => {
        const data = d.data();
        const dDate = data.date?.toDate ? data.date.toDate().toISOString().split("T")[0] : String(data.date||"").split("T")[0];
        return dDate === todayStr && (!data.status || data.status === "draft");
      });
      setRapportinoOggi(draft ? { id: draft.id, ...draft.data() } : null);
    });
    return () => unsubToday();
  }, [user.uid]);

  const reload = () => {
    getDocs(query(collection(db,"richieste_assenza"),where("operaioId","==",user.uid))).then(s=>setFerie(s.docs.map(d=>({id:d.id,...d.data()}))));
  };

  const inviaFerie = async () => {
    if (!ferF.dal) return;
    const nomeCompleto = [user.nome, user.cognome].filter(Boolean).join(" ").trim() || user.displayName || "";
    const r = await addDoc(collection(db,"richieste_assenza"), {
      operaioId: user.uid,
      operaioNome: nomeCompleto,
      nomeUtente: nomeCompleto,
      operaioCognome: user.cognome || "",
      operaioRuolo: user.ruolo || user.mansione || "",
      tipo: ferF.tipo,
      dal: ferF.dal,
      al: ferF.al || ferF.dal,
      note: ferF.note,
      stato: "in_attesa",
      createdAt: serverTimestamp()
    });
    setFerie([...ferie,{id:r.id,tipo:ferF.tipo,dal:ferF.dal,al:ferF.al||ferF.dal,note:ferF.note,stato:"in_attesa"}]);
    setShowFerie(false);
    setFerF({ tipo:"Ferie", dal:"", al:"", note:"" });
  };

  const fCol = { approvata:C.green, "in_attesa":C.gold, "in attesa":C.gold, rifiutata:C.red };
  const stCol = { approved:C.green, submitted:C.gold, pending:C.gold, rejected:C.red };
  const stLabel = { approved:"Approvato", submitted:"In attesa", pending:"In attesa", rejected:"Rifiutato" };

  const tabs = [
    {id:"rapportini",l:"📋 Rapportini"},
    {id:"ferie",l:"✈ Ferie"},
    {id:"documenti",l:"📄 Documenti"},
    {id:"programma",l:"📅 Programma"},
  ];

  return (
    <div style={{ background: C.bg, minHeight: "100vh", paddingBottom: 90 }} className="fu">
      {/* HEADER */}
      <div style={{ padding: "20px 20px 16px", background: C.surface, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, letterSpacing: 0.5 }}>{getSaluto().toUpperCase()}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: C.text, marginTop: 2 }}>{user.nome} {user.cognome || ""}</div>
          </div>
          <Avatar name={`${user.nome} ${user.cognome || ""}`} role={user.ruolo} size={44} />
        </div>
        <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center" }}>
          <RoleBadge role={user.ruolo} />
          <span style={{ fontSize: 11, color: C.textMuted, textTransform: "capitalize" }}>
            {new Date().toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" })}
          </span>
        </div>
      </div>

      {/* ── HOME ── */}
      {view === "home" && (
        <div style={{ padding: "16px 16px 24px" }}>

          {/* Banner rapportino aperto oggi */}
          {rapportinoOggi && (
            <Card onClick={() => { setRapportinoEdit(rapportinoOggi); setShowRap(true); }}
              style={{ marginBottom: 14, padding: 14, cursor: "pointer", background: `linear-gradient(135deg, ${C.gold}20, ${C.gold}08)`, border: `1px solid ${C.gold}50` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ width: 44, height: 44, borderRadius: 12, background: `${C.gold}25`, display: "flex", alignItems: "center", justifyContent: "center", animation: "pulse 2s infinite" }}>
                  <ClipboardList size={22} color={C.gold} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.gold, letterSpacing: 0.5 }}>RAPPORTINO APERTO · OGGI</div>
                  <div style={{ fontSize: 13, color: C.text, fontWeight: 600, marginTop: 2 }}>Tocca per continuare</div>
                </div>
                <ChevronRight size={18} color={C.gold} />
              </div>
            </Card>
          )}

          {/* Hero cantiere di oggi */}
          {cantiereOggi && (
            <Card onClick={() => onSection && onSection("cantieri")}
              style={{ marginBottom: 16, padding: 18, cursor: "pointer", background: `linear-gradient(135deg, ${C.blue}, ${C.accent})`, border: "none" }}>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.85)", fontWeight: 700, letterSpacing: 1, marginBottom: 6 }}>OGGI LAVORI A</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#fff" }}>{cantiereOggi.nomeCantiere || "Cantiere assegnato"}</div>
              {cantiereOggi.indirizzo && <div style={{ fontSize: 12, color: "rgba(255,255,255,0.8)", marginTop: 6 }}>📍 {cantiereOggi.indirizzo}</div>}
              {cantiereOggi.committente && <div style={{ fontSize: 12, color: "rgba(255,255,255,0.85)", marginTop: 3, fontWeight: 600 }}>{cantiereOggi.committente}</div>}
            </Card>
          )}

          {/* Grid 6 icone */}
          <SecTitle label="Azioni principali" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 20 }}>
            {[
              { icon: ClipboardList, label: "Rapportino", color: C.accent, onClick: () => { setRapportinoEdit(null); setShowRap(true); }, badge: rapportinoOggi ? "APERTO" : null },
              { icon: HardHat, label: "Cantieri", color: C.bright, onClick: () => onSection && onSection("cantieri") },
              { icon: FileText, label: "Procedure", color: C.green, onClick: () => onSection && onSection("procedure") },
              { icon: Plane, label: "Ferie e permessi", color: "#a78bfa", onClick: () => setView("ferie") },
              { icon: Calendar, label: "Programma", color: C.gold, onClick: () => setView("programma") },
              { icon: Ruler, label: "Misuratore", color: "#38bdf8", onClick: () => onSection && onSection("misuratore_hub") },
            ].map(a => {
              const Icon = a.icon;
              return (
                <Card key={a.label} onClick={a.onClick} style={{ padding: "20px 12px", textAlign: "center", cursor: "pointer", position: "relative" }}>
                  {a.badge && <span style={{ position: "absolute", top: 8, right: 8, background: C.gold, color: "#000", fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 6 }}>{a.badge}</span>}
                  <div style={{ width: 56, height: 56, borderRadius: 14, background: `${a.color}20`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 10px" }}>
                    <Icon size={28} color={a.color} strokeWidth={1.8} />
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{a.label}</div>
                </Card>
              );
            })}
          </div>

          {/* Ultimi rapportini (max 3) */}
          {rapportini.length > 0 && (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <SecTitle label="Ultimi rapportini" />
                <button onClick={() => setView("rapportini")} style={{ background: "none", border: "none", color: C.accent, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Vedi tutti →</button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {rapportini.slice(0, 3).map(r => {
                  const isDraft = !r.status || r.status === "draft";
                  const statoCol = r.status === "approved" ? C.green : r.status === "rejected" ? C.red : isDraft ? C.gold : C.accent;
                  const statoLabel = r.status === "approved" ? "Approvato" : r.status === "rejected" ? "Rifiutato" : isDraft ? "Bozza" : "Inviato";
                  return (
                    <Card key={r.id} onClick={() => { setRapportinoEdit(r); setShowRap(true); }} style={{ padding: 12, cursor: "pointer" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <Calendar size={18} color={statoCol} />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
                            {r.date?.toDate ? r.date.toDate().toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short" }) : r.date}
                          </div>
                          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                            {r.totaleOre || r.hoursWorked || 0}h · {r.projectName || "Cantiere"}
                          </div>
                        </div>
                        <span style={{ padding: "3px 10px", borderRadius: 999, fontSize: 10, fontWeight: 700, background: `${statoCol}20`, color: statoCol }}>{statoLabel}</span>
                      </div>
                    </Card>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── VISTA RAPPORTINI ── */}
      {view === "rapportini" && (
        <div style={{ padding: "12px 16px 80px" }}>
          <button onClick={() => setView("home")} style={{ marginBottom: 12, background: "none", border: "none", color: C.accent, fontSize: 13, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
            <ChevronLeft size={16} /> Home
          </button>
          <Btn label="+ Nuovo Rapportino" onClick={() => { setRapportinoEdit(null); setShowRap(true); }} icon={ClipboardList} />
          {rapportini.length === 0 && <Empty icon={ClipboardList} msg="Nessun rapportino ancora" />}
          {rapportini.map(r => {
            const lavs = r.lavorazioni || [];
            const totOre = r.totaleOre || r.hoursWorked || 0;
            const isDraft = !r.status || r.status === "draft";
            const col = isDraft ? C.gold : (stCol[r.status] || C.textMuted);
            const lbl = isDraft ? "Bozza" : (stLabel[r.status] || r.status);
            const modificabile = isDraft || r.status === "submitted" || r.status === "pending";
            return (
              <Card key={r.id} onClick={() => { setRapportinoEdit(r); setShowRap(true); }} style={{ cursor: "pointer" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>
                      {r.date?.toDate ? r.date.toDate().toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short" }) : r.date}
                    </div>
                    <div style={{ fontSize: 12, color: C.textDim, marginTop: 2 }}>{r.projectName}</div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                    <div style={{ fontFamily: "Barlow Condensed", fontWeight: 800, fontSize: 22, color: C.accent, lineHeight: 1 }}>{totOre}h</div>
                    <span style={{ background: `${col}20`, color: col, border: `1px solid ${col}40`, borderRadius: 20, padding: "3px 10px", fontSize: 10, fontWeight: 700 }}>{lbl}</span>
                  </div>
                </div>
                {lavs.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 8 }}>
                    {lavs.map((l, i) => (
                      <span key={i} style={{ background: C.accentDim, color: C.accent, borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 600 }}>{l.taskName} · {l.ore}h</span>
                    ))}
                  </div>
                )}
                {r.noPasto && <div style={{ fontSize: 11, color: C.red, marginBottom: 4 }}>No pasto</div>}
                {r.mezzoGuidato && (
                  <div style={{ fontSize: 11, color: C.accent, marginBottom: 4 }}>
                    🚐 {(r.mezzoGuidato.targa || "").toUpperCase()}
                    {r.mezzoGuidato.modello ? " · " + r.mezzoGuidato.modello : ""}
                  </div>
                )}
                {r.note && <div style={{ fontSize: 12, color: C.textMuted, fontStyle: "italic", marginBottom: 8 }}>{r.note}</div>}
                {modificabile && !isDraft && (
                  <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 8, marginTop: 4 }}>
                    <button onClick={async (e) => {
                      e.stopPropagation();
                      if (window.confirm("Eliminare questo rapportino?")) {
                        const { deleteDoc: dd, doc: d2 } = await import("firebase/firestore");
                        await dd(d2(db, "timesheets", r.id));
                        reload();
                      }
                    }} style={{ background: "none", border: "none", color: C.textMuted, fontSize: 11, cursor: "pointer", fontFamily: "Barlow" }}>
                      Elimina
                    </button>
                  </div>
                )}
                {isDraft && (
                  <div style={{ fontSize: 11, color: C.gold, marginTop: 4 }}>Tocca per modificare</div>
                )}
                {!modificabile && r.status === "approved" && (
                  <div style={{ fontSize: 11, color: C.green, marginTop: 4 }}>Approvato</div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* ── VISTA FERIE ── */}
      {view === "ferie" && (
        <div style={{ padding: "12px 16px 80px" }}>
          <button onClick={() => setView("home")} style={{ marginBottom: 12, background: "none", border: "none", color: C.accent, fontSize: 13, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
            <ChevronLeft size={16} /> Home
          </button>
          <Btn label="+ Nuova Richiesta" onClick={() => setShowFerie(true)} icon={Plane} />
          {ferie.length === 0 && <Empty icon={Plane} msg="Nessuna richiesta ancora" />}
          {ferie.map(f => (
            <Card key={f.id}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{f.tipo}</div>
                  <div style={{ fontSize: 12, color: C.textDim, marginTop: 3 }}>{f.dal}{f.al && f.al !== f.dal ? ` → ${f.al}` : ""}</div>
                  {f.note && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>{f.note}</div>}
                </div>
                <span style={{ background: `${fCol[f.stato] || C.textMuted}20`, color: fCol[f.stato] || C.textMuted, border: `1px solid ${fCol[f.stato] || C.textMuted}40`, borderRadius: 4, padding: "3px 10px", fontSize: 10, fontWeight: 700 }}>{f.stato}</span>
              </div>
            </Card>
          ))}
          {showFerie && (
            <Modal title="Nuova Richiesta" onClose={() => setShowFerie(false)}>
              <Sel value={ferF.tipo} onChange={e => setFerF({ ...ferF, tipo: e.target.value })}>
                {["Ferie", "Permesso", "Malattia", "Permesso sindacale"].map(t => <option key={t}>{t}</option>)}
              </Sel>
              <Inp placeholder="Dal" type="date" value={ferF.dal} onChange={e => setFerF({ ...ferF, dal: e.target.value })} />
              <Inp placeholder="Al" type="date" value={ferF.al} onChange={e => setFerF({ ...ferF, al: e.target.value })} />
              <Txta placeholder="Note (opzionale)" value={ferF.note} onChange={e => setFerF({ ...ferF, note: e.target.value })} rows={2} />
              <Btn label="Invia Richiesta" onClick={inviaFerie} icon={Check} />
            </Modal>
          )}
        </div>
      )}

      {/* ── VISTA DOCUMENTI ── */}
      {view === "buste" && (
        <div style={{ padding: "12px 16px 80px" }}>
          <button onClick={() => setView("home")} style={{ marginBottom: 12, background: "none", border: "none", color: C.accent, fontSize: 13, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
            <ChevronLeft size={16} /> Home
          </button>
          {buste.length === 0 && <Empty icon={FileText} msg="Nessun documento disponibile. L'amministrazione li caricherà qui." />}
          {buste.map(b => (
            <Card key={b.id}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{b.nome || b.mese || b.tipo || "Documento"}</div>
                  <div style={{ fontSize: 11, color: C.textDim, marginTop: 3 }}>
                    {b.tipo && <span style={{ background: `${C.accent}20`, color: C.accent, padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 600, marginRight: 6 }}>{b.tipo === "busta_paga" ? "Busta paga" : b.tipo === "contratto" ? "Contratto" : b.tipo === "attestato" ? "Attestato" : b.tipo}</span>}
                    {b.data && new Date(b.data).toLocaleDateString("it-IT")}
                  </div>
                </div>
                {b.url && <a href={b.url} target="_blank" rel="noreferrer"><Btn label="Scarica" small variant="ghost" /></a>}
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* ── VISTA PROGRAMMA ── */}
      {view === "programma" && (
        <div>
          <div style={{ padding: "12px 16px 0" }}>
            <button onClick={() => setView("home")} style={{ marginBottom: 12, background: "none", border: "none", color: C.accent, fontSize: 13, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
              <ChevronLeft size={16} /> Home
            </button>
          </div>
          <CalendarioSettimanale user={user} targetUserId={user.uid} targetUserNome={null} canWrite={false} />
        </div>
      )}

      {/* Modal rapportino */}
      {showRap && (
        <FormRapportino user={user} rapportinoDaModificare={rapportinoEdit}
          onSaved={() => { reload(); setRapportinoOggi(null); }}
          onClose={() => { setShowRap(false); setRapportinoEdit(null); }} />
      )}
    </div>
  );
}

// ─── CONSOLE AMMINISTRAZIONE ──────────────────────────────────────────────────
function Gestione({ user }) {
  const [tab, setTab] = useState("ferie");
  const [ferie, setFerie] = useState([]);
  const [tutteFerie, setTutteFerie] = useState([]);
  const [utenti, setUtenti] = useState([]);
  const [rapportini, setRapportini] = useState([]);
  const [programmi, setProgrammi] = useState([]);
  const [utenteSel, setUtenteSel] = useState(null);
  const [showBusta, setShowBusta] = useState(false);
  const [bustaForm, setBustaForm] = useState({ mese:"", netto:"" });
  const [uploading, setUploading] = useState(false);
  const [filterUtente, setFilterUtente] = useState("tutti");
  const [maxFerieContemporanee, setMaxFerieContemporanee] = useState(2);
  const [ferieApprovate, setFerieApprovate] = useState([]);
  const fileRef = useRef();

  useEffect(() => {
    getDocs(query(collection(db,"richieste_assenza"),where("stato","==","in_attesa"))).then(s=>setFerie(s.docs.map(d=>({id:d.id,...d.data()}))));
    getDocs(collection(db,"richieste_assenza")).then(s=>setTutteFerie(s.docs.map(d=>({id:d.id,...d.data()}))));
    getDocs(collection(db,"utenti")).then(s=>setUtenti(s.docs.map(d=>({id:d.id,...d.data()}))));
    getDocs(collection(db,"rapportini")).then(s=>setRapportini(s.docs.map(d=>({id:d.id,...d.data()}))));
    getDocs(collection(db,"programma")).then(s=>setProgrammi(s.docs.map(d=>({id:d.id,...d.data()}))));
    getDoc(doc(db,"settings","ferie")).then(s => {
      if (s.exists() && typeof s.data().maxContemporanee === "number") {
        setMaxFerieContemporanee(s.data().maxContemporanee);
      }
    }).catch(() => {});
    getDocs(query(collection(db,"richieste_assenza"),where("stato","==","approvata"))).then(s => {
      setFerieApprovate(s.docs.map(d => ({ id: d.id, ...d.data() })));
    });
  }, []);

  const approvaFeria = async (id, stato) => {
    // Trova la richiesta per ricavare operaioId, dal, al, tipo
    const richiesta = ferie.find(f => f.id === id) || tutteFerie.find(f => f.id === id);

    // Mappa tipo richiesta → codice ERP
    const mapTipoToCode = (tipo) => {
      if (!tipo) return "Fe";
      const t = String(tipo).toLowerCase();
      if (t.includes("malatt")) return "M";
      if (t.includes("permesso")) return "P";
      if (t.includes("assenza") && t.includes("ingiust")) return "AI";
      return "Fe";
    };

    // Helper: genera date nel range escludendo sabato/domenica
    const generaGiorniLavorativi = (dalStr, alStr) => {
      const giorni = [];
      if (!dalStr) return giorni;
      const dal = new Date(dalStr + "T12:00:00");
      const al = new Date((alStr || dalStr) + "T12:00:00");
      const cur = new Date(dal);
      while (cur <= al) {
        if (cur.getDay() !== 0 && cur.getDay() !== 6) {
          const y = cur.getFullYear();
          const m = String(cur.getMonth() + 1).padStart(2, "0");
          const d = String(cur.getDate()).padStart(2, "0");
          giorni.push(`${y}-${m}-${d}`);
        }
        cur.setDate(cur.getDate() + 1);
      }
      return giorni;
    };

    try {
      // 1. Aggiorna stato della richiesta
      await updateDoc(doc(db, "richieste_assenza", id), { stato });

      // 2. Se richiesta approvata → crea docs assenze_operai per ogni giorno lavorativo
      if (stato === "approvata" && richiesta) {
        const tipoCode = mapTipoToCode(richiesta.tipo);
        const giorni = generaGiorniLavorativi(richiesta.dal, richiesta.al || richiesta.dal);
        for (const data of giorni) {
          const qExist = query(
            collection(db, "assenze_operai"),
            where("operaioId", "==", richiesta.operaioId),
            where("data", "==", data)
          );
          const snap = await getDocs(qExist);
          const assData = {
            operaioId: richiesta.operaioId,
            data,
            tipo: tipoCode,
            ore: 0,
            updatedAt: serverTimestamp(),
          };
          if (snap.docs.length > 0) {
            await updateDoc(doc(db, "assenze_operai", snap.docs[0].id), assData);
          } else {
            await addDoc(collection(db, "assenze_operai"), {
              ...assData,
              createdAt: serverTimestamp(),
            });
          }
        }
      }

      // 3. Se richiesta rifiutata → rimuovi eventuali assenze del range
      if (stato === "rifiutata" && richiesta) {
        const giorni = generaGiorniLavorativi(richiesta.dal, richiesta.al || richiesta.dal);
        for (const data of giorni) {
          const qExist = query(
            collection(db, "assenze_operai"),
            where("operaioId", "==", richiesta.operaioId),
            where("data", "==", data)
          );
          const snap = await getDocs(qExist);
          for (const d of snap.docs) {
            await deleteDoc(doc(db, "assenze_operai", d.id));
          }
        }
      }

      // 4. Aggiorna stato UI locale
      setFerie(ferie.filter(f => f.id !== id));
      setTutteFerie(tutteFerie.map(f => f.id === id ? { ...f, stato } : f));
    } catch (e) {
      console.error("Errore approvaFeria:", e);
      alert("Errore durante l'aggiornamento. Controlla la console.");
    }
  };

  const calcolaSovrapposizioni = (richiesta) => {
    const dalReq = richiesta.dal;
    const alReq = richiesta.al || richiesta.dal;
    if (!dalReq) return [];
    return ferieApprovate.filter(f => {
      if (f.operaioId === richiesta.operaioId) return false;
      const dalF = f.dal;
      const alF = f.al || f.dal;
      if (!dalF) return false;
      return dalF <= alReq && alF >= dalReq;
    });
  };

  const uploadBusta = async (e) => {
    const file = e.target.files[0];
    if (!file || !utenteSel) return;
    setUploading(true);
    try {
      const r = ref(storage, `buste/${utenteSel.id}/${Date.now()}_${file.name}`);
      await uploadBytes(r, file);
      const url = await getDownloadURL(r);
      await addDoc(collection(db,"buste"), {
        userId: utenteSel.id,
        nomeUtente: utenteSel.nome,
        mese: bustaForm.mese,
        netto: Number(bustaForm.netto)||0,
        url,
        createdAt: serverTimestamp()
      });
      setShowBusta(false);
      setBustaForm({ mese:"", netto:"" });
    } catch(e) { console.error(e); }
    setUploading(false);
    e.target.value="";
  };

  const rapFiltrati = filterUtente==="tutti" ? rapportini : rapportini.filter(r=>r.userId===filterUtente);
  const progFiltrati = filterUtente==="tutti" ? programmi : programmi.filter(p=>p.userId===filterUtente);
  const giorni = ["lunedi","martedi","mercoledi","giovedi","venerdi","sabato"];
  const fCol = { approvata:C.green, "in_attesa":C.gold, "in attesa":C.gold, rifiutata:C.red };

  const tabs = [
    {id:"ferie",    l:"✈ Ferie",      badge:ferie.length},
    {id:"buste",    l:"📄 Buste",      badge:null},
    {id:"rapportini",l:"📋 Rapportini",badge:null},
    {id:"programmi",l:"📅 Programmi",  badge:null},
    {id:"calendari",l:"🗓 Calendari",  badge:null},
    {id:"utenti",   l:"👷 Utenti",     badge:null},
    {id:"accessi",  l:"🔑 Accessi",    badge:null},
    {id:"lavPerRuolo", l:"🔧 Lavorazioni", badge:null},
  ];

  return (
    <div className="fu" style={{ height: "100%", overflowY: "auto", paddingBottom: 90, WebkitOverflowScrolling: "touch", overscrollBehavior: "contain" }}>
      {/* Tab bar */}
      <div style={{ display:"flex", gap:6, padding:"12px 16px", overflowX:"auto", borderBottom:`1px solid ${C.border}` }}>
        {tabs.map(t => (
          <button key={t.id} onClick={()=>setTab(t.id)}
            style={{ background:tab===t.id?C.accentDim:"transparent", color:tab===t.id?C.accent:C.textMuted, border:`1px solid ${tab===t.id?C.accent+"50":C.border}`, borderRadius:20, padding:"6px 14px", fontSize:11, fontWeight:700, cursor:"pointer", whiteSpace:"nowrap", fontFamily:"Barlow", position:"relative" }}>
            {t.l}
            {t.badge>0 && <span style={{ marginLeft:4, background:C.red, color:"#fff", borderRadius:10, padding:"1px 6px", fontSize:9, fontWeight:800 }}>{t.badge}</span>}
          </button>
        ))}
      </div>

      <div style={{ padding:"16px 16px 80px" }}>

        {/* ── FERIE ── */}
        {tab==="ferie" && (
          <>
            {/* In attesa */}
            <SecTitle label={`Da approvare (${ferie.length})`} />
            {ferie.length===0 && <Empty icon="✈" msg="Nessuna richiesta in attesa" />}
            {ferie.map(f => {
              const sovrapposti = calcolaSovrapposizioni(f);
              const nomiSovrapposti = sovrapposti.map(s => s.nomeUtente || s.operaioNome).filter(Boolean).join(", ");
              const numSovrapposti = sovrapposti.length;
              const sforaLimite = numSovrapposti >= maxFerieContemporanee;
              const bannerBg = sforaLimite ? C.redDim : numSovrapposti > 0 ? C.goldDim : C.greenDim;
              const bannerColor = sforaLimite ? C.red : numSovrapposti > 0 ? C.gold : C.green;
              const bannerMsg = sforaLimite
                ? `Limite raggiunto: gia ${numSovrapposti} in ferie (max ${maxFerieContemporanee})${nomiSovrapposti ? ": " + nomiSovrapposti : ""}`
                : numSovrapposti > 0
                  ? `${numSovrapposti} operaio gia in ferie${nomiSovrapposti ? ": " + nomiSovrapposti : ""}`
                  : "Nessuno in ferie in questi giorni";
              const utenteObj = utenti.find(u => u.id === f.operaioId);
              const displayNome = f.nomeUtente || f.operaioNome || (utenteObj ? `${utenteObj.nome || ""} ${utenteObj.cognome || ""}`.trim() : "Operaio");
              const displayRuolo = f.operaioRuolo || utenteObj?.ruolo || "";
              return (
                <Card key={f.id} style={{ borderLeft: `3px solid ${C.gold}`, marginBottom: 12 }}>
                  <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 10 }}>
                    {utenteObj && <Avatar name={displayNome} role={displayRuolo} size={40} />}
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, color: C.text }}>{displayNome}</div>
                      {displayRuolo && (
                        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 1 }}>{displayRuolo}</div>
                      )}
                      <div style={{ fontSize: 13, color: C.textDim, marginTop: 6 }}>
                        <strong>{f.tipo}</strong> · {f.dal}{f.al && f.al !== f.dal ? ` \u2192 ${f.al}` : ""}
                      </div>
                      {f.note && (
                        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4, fontStyle: "italic" }}>"{f.note}"</div>
                      )}
                    </div>
                  </div>

                  <div style={{ background: bannerBg, border: `1px solid ${bannerColor}40`, borderRadius: 8, padding: "8px 12px", fontSize: 12, color: bannerColor, fontWeight: 600, marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
                    <span>{sforaLimite ? "\u26A0" : numSovrapposti > 0 ? "\u24D8" : "\u2713"}</span>
                    <span>{bannerMsg}</span>
                  </div>

                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button onClick={() => approvaFeria(f.id, "rifiutata")}
                      style={{ background: C.redDim, color: C.red, border: `1px solid ${C.red}40`, borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                      ✕ Rifiuta
                    </button>
                    <button onClick={() => approvaFeria(f.id, "approvata")}
                      style={{ background: C.greenDim, color: C.green, border: `1px solid ${C.green}40`, borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                      ✓ Approva
                    </button>
                  </div>
                </Card>
              );
            })}

            {/* Storico */}
            <SecTitle label="Storico tutte le richieste" />
            {tutteFerie.filter(f=>f.stato!=="in attesa").map(f=>(
              <Card key={f.id}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <div>
                    <div style={{ fontWeight:600, fontSize:13 }}>{f.nomeUtente}</div>
                    <div style={{ fontSize:12, color:C.textDim }}>{f.tipo} — {f.dal}{f.al&&f.al!==f.dal?` → ${f.al}`:""}</div>
                  </div>
                  <span style={{ background:`${fCol[f.stato]||C.textMuted}20`, color:fCol[f.stato]||C.textMuted, border:`1px solid ${fCol[f.stato]||C.textMuted}40`, borderRadius:4, padding:"2px 8px", fontSize:10, fontWeight:700 }}>{f.stato}</span>
                </div>
              </Card>
            ))}
          </>
        )}

        {/* ── BUSTE PAGA ── */}
        {tab==="buste" && (
          <>
            <SecTitle label="Carica busta paga per utente" />
            <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:16 }}>
              {utenti.filter(u=>u.ruolo==="operaio"||u.ruolo==="ufficio_tecnico").map(u=>(
                <Card key={u.id}>
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                      <Avatar name={u.nome} role={u.ruolo} size={36} />
                      <div>
                        <div style={{ fontWeight:700, fontSize:14 }}>{u.nome}</div>
                        <RoleBadge role={u.ruolo} />
                      </div>
                    </div>
                    <Btn label="+ Busta" small variant="ghost" onClick={()=>{ setUtenteSel(u); setShowBusta(true); }} />
                  </div>
                </Card>
              ))}
            </div>

            {showBusta && utenteSel && (
              <Modal title={`Busta paga — ${utenteSel.nome}`} onClose={()=>setShowBusta(false)}>
                <div style={{ fontSize:12, color:C.textMuted, marginBottom:12 }}>Il PDF sarà visibile nella sezione personale dell'utente.</div>
                <Inp placeholder="Mese (es. Marzo 2025)" value={bustaForm.mese} onChange={e=>setBustaForm({...bustaForm,mese:e.target.value})} />
                <Inp placeholder="Netto €" type="number" value={bustaForm.netto} onChange={e=>setBustaForm({...bustaForm,netto:e.target.value})} />
                <input ref={fileRef} type="file" accept=".pdf" onChange={uploadBusta} style={{ display:"none" }} />
                <Btn label={uploading?"Caricamento...":"📎 Seleziona PDF e carica"} onClick={()=>fileRef.current.click()} variant="primary" disabled={!bustaForm.mese||uploading} />
                <Btn label="Annulla" onClick={()=>setShowBusta(false)} variant="secondary" />
              </Modal>
            )}
          </>
        )}

        {/* ── RAPPORTINI ── */}
        {tab==="rapportini" && (
          <>
            <SecTitle label="Rapportini di tutta la squadra" />
            {/* Filtro utente */}
            <Sel value={filterUtente} onChange={e=>setFilterUtente(e.target.value)}>
              <option value="tutti">Tutti gli operai</option>
              {utenti.map(u=><option key={u.id} value={u.id}>{u.nome}</option>)}
            </Sel>
            {rapFiltrati.length===0 && <Empty icon="📋" msg="Nessun rapportino" />}
            {[...rapFiltrati].reverse().map(r=>(
              <Card key={r.id}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
                  <div>
                    <div style={{ fontWeight:700, fontSize:14 }}>{r.nomeUtente}</div>
                    <div style={{ fontSize:12, color:C.textDim }}>{r.data} — {r.cantiere}</div>
                  </div>
                  <span style={{ background:C.accentDim, color:C.accent, borderRadius:4, padding:"2px 8px", fontSize:11, fontWeight:700 }}>{r.ore}h</span>
                </div>
                <div style={{ fontSize:13, color:C.text }}>{r.attivita}</div>
                {r.materiali&&<div style={{ fontSize:11, color:C.textMuted, marginTop:4 }}>🧱 {r.materiali}</div>}
                {r.note&&<div style={{ fontSize:11, color:C.textMuted, marginTop:2 }}>📝 {r.note}</div>}
              </Card>
            ))}
          </>
        )}

        {/* ── CALENDARI PER DIPENDENTE ── */}
        {tab==="calendari" && (
          <>
            {/* Selettore dipendente */}
            <SecTitle label="Compila programma per dipendente" />
            <Sel value={filterUtente} onChange={e=>setFilterUtente(e.target.value)}>
              <option value="tutti">Seleziona dipendente...</option>
              {utenti.filter(u=>u.ruolo==="operaio"||u.ruolo==="ufficio_tecnico"||u.ruolo==="amministrazione").map(u=>(
                <option key={u.id} value={u.id}>{u.nome} — {ROLES[u.ruolo]?.label||u.ruolo}</option>
              ))}
            </Sel>
            {filterUtente==="tutti" && <Empty icon="👷" msg="Seleziona un dipendente per compilare il suo programma" />}
            {filterUtente!=="tutti" && (() => {
              const usel = utenti.find(u=>u.id===filterUtente);
              return usel ? (
                <CalendarioSettimanale
                  user={user}
                  targetUserId={usel.id}
                  targetUserNome={usel.nome}
                  canWrite={true}
                />
              ) : null;
            })()}
          </>
        )}

        {/* ── PROGRAMMI (vecchia vista testuale) ── */}
        {tab==="programmi" && (
          <>
            <SecTitle label="Riepilogo rapportini squadra" />
            <Sel value={filterUtente} onChange={e=>setFilterUtente(e.target.value)}>
              <option value="tutti">Tutti</option>
              {utenti.map(u=><option key={u.id} value={u.id}>{u.nome}</option>)}
            </Sel>
            {rapFiltrati.length===0 && <Empty icon="📋" msg="Nessun rapportino" />}
            {[...rapFiltrati].reverse().map(r=>(
              <Card key={r.id}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
                  <div>
                    <div style={{ fontWeight:700, fontSize:14 }}>{r.nomeUtente}</div>
                    <div style={{ fontSize:12, color:C.textDim }}>{r.data} — {r.cantiere}</div>
                  </div>
                  <span style={{ background:C.accentDim, color:C.accent, borderRadius:4, padding:"2px 8px", fontSize:11, fontWeight:700 }}>{r.ore}h</span>
                </div>
                <div style={{ fontSize:13, color:C.text }}>{r.attivita}</div>
                {r.materiali&&<div style={{ fontSize:11, color:C.textMuted, marginTop:4 }}>🧱 {r.materiali}</div>}
              </Card>
            ))}
          </>
        )}

        {/* ── UTENTI ── */}
        {tab==="utenti" && (
          <>
            <SecTitle label={`${utenti.length} utenti nel sistema`} />
            {utenti.map(u=>(
              <Card key={u.id}>
                <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                  <Avatar name={u.nome} role={u.ruolo} />
                  <div style={{ flex:1 }}>
                    <div style={{ fontWeight:700, fontSize:14 }}>{u.nome}</div>
                    <div style={{ fontSize:11, color:C.textDim }}>{u.email}</div>
                    {u.cantiere&&<div style={{ fontSize:11, color:C.textMuted, marginTop:2 }}>📍 {u.cantiere}</div>}
                  </div>
                  <RoleBadge role={u.ruolo} />
                </div>
              </Card>
            ))}
            <Card style={{ borderStyle:"dashed" }}>
              <SecTitle label="Come aggiungere un utente" />
              <div style={{ fontSize:12, color:C.textDim, lineHeight:2, fontFamily:"monospace" }}>
                1. Firebase → Authentication → Aggiungi utente<br/>
                2. Copia l'UID generato<br/>
                3. Firestore → raccolta "utenti" → Aggiungi documento<br/>
                4. ID documento = UID copiato<br/>
                5. Campi: nome, ruolo, email, cantiere, avatar
              </div>
            </Card>
          </>
        )}

        {tab==="accessi" && <GestioneAccessi />}
        {tab==="lavPerRuolo" && <LavorazioniPerRuolo />}
      </div>
    </div>
  );
}

// ─── GESTIONE ACCESSI ────────────────────────────────────────────────────────
function GestioneAccessi() {
  const { C } = useTheme();
  const [operai, setOperai] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOperaio, setModalOperaio] = useState(null);
  const [modalEmail, setModalEmail] = useState("");
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const [credenziali, setCredenziali] = useState(null);
  const [copiato, setCopiato] = useState(false);
  const [isReset, setIsReset] = useState(false);

  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db, "utenti"), orderBy("cognome")),
      (snap) => {
        setOperai(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      () => setLoading(false)
    );
    return () => unsub();
  }, []);

  const apriModal = (operaio) => {
    setModalOperaio(operaio);
    setModalEmail(operaio.email || "");
    setError("");
    setCredenziali(null);
  };

  const apriModalReset = (operaio) => {
    setModalOperaio(operaio);
    setModalEmail(operaio.email || "");
    setError("");
    setCredenziali(null);
    setIsReset(true);
  };

  const chiudiModal = () => {
    setModalOperaio(null);
    setCredenziali(null);
    setError("");
    setIsReset(false);
  };

  const attivaAccesso = async () => {
    if (!modalOperaio) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(modalEmail)) {
      setError("Email non valida");
      return;
    }
    setProcessing(true);
    setError("");
    try {
      const callable = httpsCallable(functions, "activateWorkerAccount");
      const result = await callable({ utenteId: modalOperaio.id, email: modalEmail });
      setCredenziali(result.data);
    } catch (e) {
      setError(e.message || "Errore durante l'attivazione");
    }
    setProcessing(false);
  };

  const resetAccesso = async () => {
    if (!modalOperaio) return;
    setProcessing(true);
    setError("");
    try {
      const resetFn = httpsCallable(functions, "resetWorkerPassword");
      const result = await resetFn({ userId: modalOperaio.id });
      setCredenziali({
        email: result.data.email,
        tempPassword: result.data.password
      });
    } catch (e) {
      console.error(e);
      setError(e.message || "Errore durante il reset");
    }
    setProcessing(false);
  };

  const copiaCredenziali = () => {
    if (!credenziali) return;
    const text = `Edil Blu - Credenziali accesso\nEmail: ${credenziali.email}\nPassword temporanea: ${credenziali.tempPassword}\n\nDovrai cambiare la password al primo accesso.`;
    navigator.clipboard.writeText(text);
    setCopiato(true);
    setTimeout(() => setCopiato(false), 2000);
  };

  const getStatus = (op) => {
    if (op.authUid) return { label: "Attivo", color: C.green, dim: C.greenDim };
    if (op.email) return { label: "Da attivare", color: C.gold, dim: C.goldDim };
    return { label: "Email mancante", color: C.textMuted, dim: `${C.textMuted}20` };
  };

  if (loading) return <div style={{ textAlign: "center", padding: 40, color: C.textMuted }}>Caricamento...</div>;

  return (
    <>
      <SecTitle label={`Operai registrati (${operai.length})`} />
      {operai.map(op => {
        const st = getStatus(op);
        return (
          <Card key={op.id} style={{ padding: 14, marginBottom: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <Avatar name={`${op.nome || ""} ${op.cognome || ""}`} role={op.ruolo} size={38} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: C.text }}>{op.nome} {op.cognome || ""}</div>
                <div style={{ fontSize: 11, color: C.textDim, marginTop: 2 }}>{op.ruolo}{op.email ? ` · ${op.email}` : ""}</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ background: st.dim, color: st.color, borderRadius: 999, padding: "3px 10px", fontSize: 10, fontWeight: 600 }}>{st.label}</span>
                {!op.authUid && (
                  <button onClick={() => apriModal(op)}
                    style={{ background: C.accentDim, border: "none", borderRadius: 8, padding: "6px 10px", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, color: C.accent, fontSize: 11, fontWeight: 600, fontFamily: "Barlow" }}>
                    <UserPlus size={14} /> Attiva
                  </button>
                )}
                {op.authUid && (
                  <button onClick={() => apriModalReset(op)}
                    style={{ background: C.goldDim || "#78350f20", border: "none", borderRadius: 8, padding: "6px 10px", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, color: C.gold || "#f59e0b", fontSize: 11, fontWeight: 600, fontFamily: "Barlow" }}>
                    <RefreshCw size={14} /> Rigenera
                  </button>
                )}
              </div>
            </div>
          </Card>
        );
      })}

      {operai.filter(o => !o.authUid).length === 0 && (
        <Empty icon={Shield} msg="Tutti gli operai hanno un accesso attivo" />
      )}

      {/* Modal attivazione */}
      {modalOperaio && !credenziali && (
        <Modal title={isReset ? "Rigenera password" : "Attiva accesso operaio"} onClose={chiudiModal}>
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <Avatar name={`${modalOperaio.nome} ${modalOperaio.cognome || ""}`} role={modalOperaio.ruolo} size={44} />
              <div>
                <div style={{ fontWeight: 700, fontSize: 15, color: C.text }}>{modalOperaio.nome} {modalOperaio.cognome || ""}</div>
                <div style={{ fontSize: 12, color: C.textDim }}>{modalOperaio.ruolo}</div>
              </div>
            </div>
            {isReset && (
              <div style={{ padding: 12, background: C.goldDim || "#78350f20", border: `1px solid ${C.gold || "#f59e0b"}40`, borderRadius: 8, marginBottom: 16, fontSize: 12, color: C.text, lineHeight: 1.5 }}>
                <strong>Attenzione:</strong> rigenerando la password, quella attuale non sarà più valida. L'operaio dovrà cambiarla al prossimo accesso.
              </div>
            )}
            <label style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, letterSpacing: 1, marginBottom: 6, display: "block" }}>EMAIL PER L'ACCESSO</label>
            <Inp type="email" placeholder="nome@edilblu.it" value={modalEmail} onChange={e => setModalEmail(e.target.value)} />
          </div>
          {error && (
            <div style={{ background: C.redDim, border: `1px solid ${C.red}40`, borderRadius: 8, padding: "10px 14px", color: C.red, fontSize: 13, marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
              <AlertCircle size={16} /> {error}
            </div>
          )}
          <Btn label={processing ? (isReset ? "Reset in corso..." : "Attivazione in corso...") : (isReset ? "Conferma reset" : "Attiva accesso")} onClick={isReset ? resetAccesso : attivaAccesso} disabled={processing || !modalEmail} icon={isReset ? RefreshCw : UserPlus} />
        </Modal>
      )}

      {/* Modal credenziali generate */}
      {modalOperaio && credenziali && (
        <Modal title={isReset ? "Nuova password generata" : "Credenziali generate"} onClose={chiudiModal}>
          <div style={{ background: C.greenDim, border: `1px solid ${C.green}40`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <Check size={18} color={C.green} />
              <span style={{ fontWeight: 700, color: C.green, fontSize: 14 }}>{isReset ? "Password rigenerata" : "Accesso attivato"}</span>
            </div>
            <div style={{ fontSize: 12, color: C.textDim }}>per {modalOperaio.nome} {modalOperaio.cognome || ""}</div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, letterSpacing: 1 }}>EMAIL</label>
            <div style={{ fontSize: 14, color: C.text, fontWeight: 600, marginTop: 4 }}>{credenziali.email}</div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, letterSpacing: 1 }}>{isReset ? "NUOVA PASSWORD" : "PASSWORD TEMPORANEA"}</label>
            <div style={{ background: `${C.mid}40`, borderRadius: 10, padding: "12px 14px", marginTop: 6, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <code style={{ fontSize: 20, fontWeight: 700, color: C.accent, letterSpacing: 2 }}>{credenziali.tempPassword}</code>
              <button onClick={copiaCredenziali}
                style={{ background: "none", border: "none", cursor: "pointer", color: copiato ? C.green : C.textMuted, display: "flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 600, fontFamily: "Barlow" }}>
                {copiato ? <><Check size={14} /> Copiato</> : <><Copy size={14} /> Copia</>}
              </button>
            </div>
          </div>

          <div style={{ fontSize: 12, color: C.textDim, lineHeight: 1.6, marginBottom: 20, padding: "10px 12px", background: `${C.mid}20`, borderRadius: 8 }}>
            Comunica queste credenziali all'operaio. Dovrà cambiare password al primo accesso.
          </div>

          <Btn label="OK, chiudi" onClick={chiudiModal} variant="secondary" />
        </Modal>
      )}
    </>
  );
}

// ─── CAMBIO PASSWORD OBBLIGATORIO ───────────────────────────────────────────
function CambioPasswordObbligatorio({ user, onDone }) {
  const { C } = useTheme();
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [success, setSuccess] = useState(false);

  const req1 = pw1.length >= 6;
  const req2 = pw1 === pw2 && pw2.length > 0;

  const submit = async () => {
    setErr("");
    if (!req1) { setErr("La password deve avere almeno 6 caratteri"); return; }
    if (!req2) { setErr("Le password non coincidono"); return; }
    setLoading(true);
    try {
      await updatePassword(auth.currentUser, pw1);
      let docRef = null;
      const byId = await getDoc(doc(db, "utenti", auth.currentUser.uid));
      if (byId.exists()) {
        docRef = doc(db, "utenti", auth.currentUser.uid);
      } else {
        const q = await getDocs(query(collection(db, "utenti"), where("authUid", "==", auth.currentUser.uid)));
        if (!q.empty) docRef = q.docs[0].ref;
      }
      if (docRef) {
        await updateDoc(docRef, { mustChangePassword: false });
      }
      setSuccess(true);
      setTimeout(() => onDone(), 800);
    } catch (e) {
      let msg = "Errore. Riprova.";
      if (e.code === "auth/requires-recent-login") msg = "Sessione scaduta. Fai di nuovo login e riprova.";
      else if (e.code === "auth/weak-password") msg = "Password troppo debole. Usa almeno 6 caratteri.";
      else if (e.code === "auth/network-request-failed") msg = "Problema di connessione. Controlla Internet e riprova.";
      else if (e.message) msg = e.message;
      setErr(msg);
    }
    setLoading(false);
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, padding: 24, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center" }}>
      <img src="/logo-splash.png" alt="Edil Blu" style={{ width: 120, marginBottom: 24 }} />
      <Card style={{ width: "100%", maxWidth: 360, padding: 24 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: C.text, marginBottom: 8 }}>Imposta nuova password</h2>
        <p style={{ fontSize: 13, color: C.textMuted, marginBottom: 20 }}>
          Per continuare, imposta una password personale.
        </p>
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, letterSpacing: 1, marginBottom: 6, display: "block" }}>NUOVA PASSWORD</label>
          <div style={{ position: "relative" }}>
            <Inp type={showPw ? "text" : "password"} value={pw1} onChange={e => setPw1(e.target.value)} placeholder="almeno 6 caratteri" />
            <button onClick={() => setShowPw(!showPw)} style={{ position: "absolute", right: 10, top: 12, background: "none", border: "none", color: C.textMuted, cursor: "pointer" }}>
              {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, letterSpacing: 1, marginBottom: 6, display: "block" }}>CONFERMA PASSWORD</label>
          <Inp type={showPw ? "text" : "password"} value={pw2} onChange={e => setPw2(e.target.value)} placeholder="ripeti la password" />
        </div>

        {/* Requisiti dinamici */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16, padding: "12px 14px", background: `${C.mid}30`, borderRadius: 10 }}>
          <div style={{ fontSize: 12, color: C.textMuted, fontWeight: 600, marginBottom: 4 }}>REQUISITI:</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: req1 ? C.green : C.textMuted }}>
            {req1 ? <Check size={14} /> : <AlertCircle size={14} />}
            <span>Almeno 6 caratteri ({pw1.length}/6)</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: req2 ? C.green : C.textMuted }}>
            {req2 ? <Check size={14} /> : <AlertCircle size={14} />}
            <span>Le password coincidono</span>
          </div>
        </div>

        {err && (
          <div style={{ background: C.redDim, border: `1px solid ${C.red}40`, borderRadius: 8, padding: "10px 14px", color: C.red, fontSize: 13, marginBottom: 16 }}>
            {err}
          </div>
        )}
        <Btn label={loading ? "Salvataggio..." : "Imposta password"} onClick={submit} disabled={loading || !req1 || !req2} />
        <p style={{ fontSize: 12, color: C.textMuted, marginTop: 12, marginBottom: 0, textAlign: "center", lineHeight: 1.5 }}>
          Se vedi "sessione scaduta", fai logout sotto e rientra.
        </p>
        <button onClick={() => signOut(auth)}
          style={{ width: "100%", padding: "12px", marginTop: 10, background: "transparent", color: C.textMuted, border: `1px solid ${C.border}`, borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "Barlow", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          <LogOut size={16} /> Esci e rientra con le credenziali
        </button>
      </Card>

      {/* Overlay successo */}
      {success && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 }}>
          <div style={{ background: C.surface, padding: 32, borderRadius: 20, textAlign: "center" }}>
            <div style={{ width: 60, height: 60, borderRadius: "50%", background: `${C.green}20`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px" }}>
              <Check size={32} color={C.green} />
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>Password aggiornata!</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── LAVORAZIONI PER RUOLO (admin config) ────────────────────────────────────
function SortableTaskItem({ task, onRemove }) {
  const { C } = useTheme();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
  return (
    <div ref={setNodeRef} style={{ ...style, display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", marginBottom: 6, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10 }}>
      <div {...attributes} {...listeners} style={{ cursor: "grab", touchAction: "none", color: C.textMuted }}><GripVertical size={16} /></div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{task.nome || task.name}</div>
        {task.categoria && <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>{task.categoria}</div>}
      </div>
      <button onClick={onRemove} style={{ background: "none", border: "none", color: C.red, cursor: "pointer", padding: 4 }}><Trash2 size={15} /></button>
    </div>
  );
}

function LavorazioniPerRuolo() {
  const { C } = useTheme();
  const [mansioni, setMansioni] = useState([]);
  const [selectedMansione, setSelectedMansione] = useState("");
  const [allTasks, setAllTasks] = useState([]);
  const [prioritarie, setPrioritarie] = useState([]);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  useEffect(() => {
    getDocs(query(collection(db, "utenti"), where("active", "==", true))).then(snap => {
      const distinct = new Set();
      snap.docs.forEach(d => { const r = d.data().ruolo; if (r && !RUOLI_STANDARD.includes(r)) distinct.add(r); });
      setMansioni(Array.from(distinct).sort());
    });
  }, []);

  useEffect(() => {
    getDocs(query(collection(db, "timesheet_tasks"), orderBy("categoria"))).then(snap => {
      setAllTasks(snap.docs.filter(d => d.data().attivo !== false).map(d => ({ id: d.id, ...d.data() })));
    });
  }, []);

  useEffect(() => {
    if (!selectedMansione) { setPrioritarie([]); return; }
    getDoc(doc(db, "lavorazioni_per_ruolo", selectedMansione)).then(snap => {
      if (snap.exists()) {
        const mapped = (snap.data().lavorazioni_ordinate || []).map(tid => allTasks.find(t => t.id === tid)).filter(Boolean);
        setPrioritarie(mapped);
      } else setPrioritarie([]);
    });
  }, [selectedMansione, allTasks]);

  const aggiungi = (task) => { if (!prioritarie.some(p => p.id === task.id)) setPrioritarie([...prioritarie, task]); };
  const rimuovi = (id) => setPrioritarie(prioritarie.filter(p => p.id !== id));
  const onDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setPrioritarie(arrayMove(prioritarie, prioritarie.findIndex(p => p.id === active.id), prioritarie.findIndex(p => p.id === over.id)));
  };

  const salva = async () => {
    if (!selectedMansione) return;
    setSaving(true);
    try {
      await setDoc(doc(db, "lavorazioni_per_ruolo", selectedMansione), {
        mansione: selectedMansione, lavorazioni_ordinate: prioritarie.map(p => p.id),
        updatedAt: serverTimestamp(), updatedBy: auth.currentUser?.uid || ""
      });
      setFeedback("Salvato!"); setTimeout(() => setFeedback(""), 2000);
    } catch (e) { setFeedback("Errore: " + e.message); }
    setSaving(false);
  };

  const disponibili = allTasks.filter(t => !prioritarie.some(p => p.id === t.id));
  const categorie = [...new Set(disponibili.map(t => t.categoria).filter(Boolean))].sort();

  return (
    <div style={{ padding: "16px" }}>
      <SecTitle label="Seleziona mansione" />
      <Sel value={selectedMansione} onChange={e => setSelectedMansione(e.target.value)}>
        <option value="">-- scegli --</option>
        {mansioni.map(m => <option key={m} value={m}>{m}</option>)}
      </Sel>
      {selectedMansione && (
        <>
          <div style={{ marginTop: 20 }}>
            <SecTitle label={`Prioritarie per ${selectedMansione} (trascina per riordinare)`} />
            {prioritarie.length === 0 ? (
              <Empty msg="Nessuna lavorazione prioritaria. Aggiungine dalla lista sotto." icon={Plus} />
            ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={prioritarie.map(p => p.id)} strategy={verticalListSortingStrategy}>
                  {prioritarie.map(task => <SortableTaskItem key={task.id} task={task} onRemove={() => rimuovi(task.id)} />)}
                </SortableContext>
              </DndContext>
            )}
            <Btn label={saving ? "Salvataggio..." : "Salva ordine"} onClick={salva} disabled={saving} icon={Save} />
            {feedback && <div style={{ marginTop: 10, fontSize: 12, color: feedback.startsWith("Errore") ? C.red : C.green, textAlign: "center" }}>{feedback}</div>}
          </div>
          <div style={{ marginTop: 28 }}>
            <SecTitle label="Disponibili (tocca per aggiungere)" />
            {categorie.map(cat => (
              <div key={cat} style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.accent, letterSpacing: 0.5, marginBottom: 6 }}>{cat.toUpperCase()}</div>
                {disponibili.filter(t => t.categoria === cat).map(task => (
                  <Card key={task.id} onClick={() => aggiungi(task)} style={{ padding: "10px 12px", marginBottom: 6, display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                    <Plus size={14} color={C.accent} />
                    <span style={{ fontSize: 13, color: C.text }}>{task.nome || task.name}</span>
                  </Card>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── NOTIFICHE CAMPANA ───────────────────────────────────────────────────────
function NotificheCampana({ user }) {
  const [notifiche, setNotifiche] = useState([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db,"notifiche"), where("userId","==",user.uid), where("letto","==",false)),
      s => setNotifiche(s.docs.map(d=>({id:d.id,...d.data()})))
    );
    return unsub;
  }, [user.uid]);

  const segnaLetto = async (id) => {
    await updateDoc(doc(db,"notifiche",id),{ letto:true });
  };

  const segnaLutteLette = async () => {
    await Promise.all(notifiche.map(n => updateDoc(doc(db,"notifiche",n.id),{letto:true})));
  };

  const nonLette = notifiche.length;

  return (
    <div style={{ position:"relative" }}>
      <button onClick={()=>setOpen(!open)}
        style={{ background:"none", border:"none", cursor:"pointer", position:"relative", padding:4 }}>
        <span style={{ fontSize:20 }}>🔔</span>
        {nonLette > 0 && (
          <span style={{ position:"absolute", top:0, right:0, background:C.red, color:"#fff", borderRadius:10, fontSize:9, fontWeight:800, padding:"1px 5px", minWidth:16, textAlign:"center" }}>
            {nonLette}
          </span>
        )}
      </button>

      {open && (
        <div style={{ position:"fixed", inset:0, zIndex:400 }} onClick={()=>setOpen(false)}>
          <div style={{ position:"absolute", top:56, right:16, width:"min(300px, calc(100vw - 32px))", maxHeight:400, overflowY:"auto", background:C.surface, border:`1px solid ${C.border}`, borderRadius:14, boxShadow:`0 8px 32px rgba(0,0,0,0.5)` }} onClick={e=>e.stopPropagation()}>
            <div style={{ padding:"14px 16px 10px", display:"flex", justifyContent:"space-between", alignItems:"center", borderBottom:`1px solid ${C.border}` }}>
              <div style={{ fontWeight:800, fontSize:14, fontFamily:"Barlow Condensed" }}>Notifiche</div>
              {nonLette > 0 && (
                <button onClick={segnaLutteLette} style={{ background:"none", border:"none", color:C.accent, fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"Barlow" }}>
                  Segna tutte lette
                </button>
              )}
            </div>
            {notifiche.length===0 && (
              <div style={{ padding:24, textAlign:"center", color:C.textMuted, fontSize:13 }}>Nessuna notifica non letta</div>
            )}
            {notifiche.map(n => (
              <div key={n.id} style={{ padding:"12px 16px", borderBottom:`1px solid ${C.border}40`, display:"flex", gap:10, alignItems:"flex-start" }}>
                <span style={{ fontSize:20 }}>{n.tipo==="programma"?"📅":n.tipo==="ferie"?"✈":"🔔"}</span>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:13, color:C.text, lineHeight:1.5 }}>{n.testo}</div>
                  <div style={{ fontSize:10, color:C.textMuted, marginTop:4 }}>
                    {n.createdAt?.toDate ? n.createdAt.toDate().toLocaleDateString("it",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}) : ""}
                  </div>
                </div>
                <button onClick={()=>segnaLetto(n.id)} style={{ background:"none", border:"none", color:C.textMuted, fontSize:16, cursor:"pointer", paddingTop:2 }}>✕</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── APP ROOT ─────────────────────────────────────────────────────────────────
// ─── APPUNTI CANTIERE v2 ──────────────────────────────────────────────────────
function AppuntiCantiere({ user, projectId, projectName, onBack }) {
  const [appunti, setAppunti] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [tipoForm, setTipoForm] = useState("nota");
  const [appuntoAperto, setAppuntoAperto] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const fotoRef = useRef();

  const [form, setForm] = useState({
    categoria: "Generale",
    testo: "",
    checklist: [],
    fotoUrl: "",
  });
  const [nuovaVoce, setNuovaVoce] = useState("");

  const CATEGORIE = ["Generale","Sicurezza","Materiali","Contabilita","Subappalti","Clienti","Altro"];

  const catColor = {
    Generale:    C.accent,
    Sicurezza:   C.red,
    Materiali:   C.green,
    Contabilita: C.gold,
    Subappalti:  "#a78bfa",
    Clienti:     "#38bdf8",
    Altro:       C.textMuted,
  };

  // Carica SOLO i propri appunti
  useEffect(() => {
    if (!projectId) return;
    const unsub = onSnapshot(
      query(collection(db, 'appunti_cantiere'), where("autorId", "==", user.uid), where("projectId", "==", projectId)),
      s => {
        const docs = s.docs.map(d => ({ id: d.id, ...d.data() }));
        docs.sort((a, b) => {
          const ta = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
          const tb = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
          return tb - ta;
        });
        setAppunti(docs);
        setLoading(false);
      }
    );
    return unsub;
  }, [projectId, user.uid]);

  // Invia notifica ad admin e ufficio_tecnico
  const inviaNotifica = async (tipo, categoria) => {
    try {
      // Legge admin e tecnici
      const snap = await getDocs(collection(db, "utenti"));
      const destinatari = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(u => {
          const ruolo = u.ruoloApp || u.ruolo || "";
          return ["admin","ufficio_tecnico","amministrazione"].includes(ruolo) && (u.uid || u.id) !== user.uid;
        });

      const tipoLabel = tipo === "nota" ? "nota" : tipo === "foto" ? "foto" : "checklist";
      await Promise.all(destinatari.map(dest =>
        addDoc(collection(db, "notifiche"), {
          userId: dest.uid || dest.id || dest.email,
          tipo: "appunto",
          testo: `${user.nome} ha aggiunto una ${tipoLabel} (${categoria}) su ${projectName}`,
          projectId,
          projectName,
          letto: false,
          createdAt: serverTimestamp(),
        })
      ));
    } catch (e) { console.error("Notifica fallita:", e); }
  };

  // Upload foto e poi apre form con foto precaricata
  const gestisciFoto = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    try {
      console.log("Upload foto:", file.name, file.size, file.type);
      // Percorso semplificato senza sottocartelle
      const nomefile = Date.now() + "_" + file.name.replace(/[^a-zA-Z0-9._]/g, "_");
      const r = ref(storage, `appunti/${projectId}/${nomefile}`);
      console.log("Percorso storage:", r.fullPath);
      const snap = await uploadBytes(r, file);
      console.log("Upload completato:", snap.metadata.fullPath);
      const url = await getDownloadURL(r);
      console.log("URL ottenuto:", url.substring(0, 60));
      setForm(p => ({ ...p, fotoUrl: url, testo: "" }));
      setTipoForm("foto");
      setShowForm(true);
    } catch (err) {
      console.error("Errore upload foto:", err.code, err.message);
      if (err.code === "storage/unauthorized") {
        alert("Permesso negato. Contatta l admin per abilitare l upload foto.");
      } else if (err.code === "storage/canceled") {
        alert("Upload annullato. Riprova.");
      } else {
        alert("Errore: " + (err.message || "Riprova"));
      }
    }
    setUploading(false);
    e.target.value = "";
  };

  const resetForm = () => {
    setForm({ categoria:"Generale", testo:"", checklist:[], fotoUrl:"" });
    setNuovaVoce("");
    setTipoForm("nota");
    setShowForm(false);
  };

  const aggiungiVoce = () => {
    if (!nuovaVoce.trim()) return;
    setForm(p => ({ ...p, checklist: [...p.checklist, { testo: nuovaVoce.trim(), fatto: false }] }));
    setNuovaVoce("");
  };

  const canSalva = () => {
    if (tipoForm === "nota") return form.testo.trim().length > 0;
    if (tipoForm === "checklist") return form.checklist.length > 0;
    if (tipoForm === "foto") return !!form.fotoUrl;
    return false;
  };

  const salva = async () => {
    if (!canSalva()) return;
    setSaving(true);
    try {
      await addDoc(collection(db, 'appunti_cantiere'), {
        tipo: tipoForm,
        categoria: form.categoria,
        testo: form.testo.trim(),
        checklist: form.checklist,
        fotoUrl: form.fotoUrl,
        autore: user.nome,
        autorId: user.uid,
        projectId,
        projectName,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await inviaNotifica(tipoForm, form.categoria);
      resetForm();
    } catch (e) {
      console.error(e);
      alert("Errore nel salvataggio.");
    }
    setSaving(false);
  };

  const [editingCheckIdx, setEditingCheckIdx] = useState(null);
  const [editingCheckText, setEditingCheckText] = useState("");
  const [newCheckVoce, setNewCheckVoce] = useState("");

  const updateChecklist = async (appunto, nuova) => {
    await updateDoc(doc(db, 'appunti_cantiere', appunto.id), {
      checklist: nuova, updatedAt: serverTimestamp(),
    });
    if (appuntoAperto && appuntoAperto.id === appunto.id) {
      setAppuntoAperto(prev => ({ ...prev, checklist: nuova }));
    }
  };

  const toggleChecklistItem = async (appunto, idx) => {
    const nuova = appunto.checklist.map((v, i) => i === idx ? { ...v, fatto: !v.fatto } : v);
    await updateChecklist(appunto, nuova);
  };

  const addChecklistItem = async (appunto) => {
    if (!newCheckVoce.trim()) return;
    const nuova = [...(appunto.checklist || []), { testo: newCheckVoce.trim(), fatto: false }];
    await updateChecklist(appunto, nuova);
    setNewCheckVoce("");
  };

  const removeChecklistItem = async (appunto, idx) => {
    const nuova = appunto.checklist.filter((_, i) => i !== idx);
    await updateChecklist(appunto, nuova);
  };

  const saveChecklistEdit = async (appunto, idx) => {
    if (!editingCheckText.trim()) return;
    const nuova = appunto.checklist.map((v, i) => i === idx ? { ...v, testo: editingCheckText.trim() } : v);
    await updateChecklist(appunto, nuova);
    setEditingCheckIdx(null);
    setEditingCheckText("");
  };

  const eliminaAppunto = async (id) => {
    if (!window.confirm("Eliminare questo appunto?")) return;
    const { deleteDoc: dd, doc: d2 } = await import("firebase/firestore");
    await dd(d2(db, 'appunti_cantiere', id));
    if (appuntoAperto?.id === id) setAppuntoAperto(null);
  };

  const fmtData = (ts) => {
    if (!ts?.toDate) return "";
    return ts.toDate().toLocaleDateString("it-IT", { day:"numeric", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" });
  };

  // Icona e colore per tipo
  const tipoIcon = { nota:"📝", checklist:"✅", foto:"📷" };

  return (
    <div style={{ paddingBottom:80, flex:1, overflowY:"auto" }} className="fu">
      {/* Header */}
      <div style={{ background:`linear-gradient(135deg,${C.mid},${C.blue}40)`, padding:"14px 16px 12px", borderBottom:`1px solid ${C.border}` }}>
        <button onClick={onBack} style={{ background:"none", border:"none", color:C.accent, fontSize:13, cursor:"pointer", fontFamily:"Barlow", marginBottom:6 }}>
          ← {projectName}
        </button>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div style={{ fontFamily:"Barlow Condensed", fontWeight:800, fontSize:20 }}>I miei appunti</div>
          <div style={{ fontSize:11, color:C.textMuted }}>{appunti.length} appunti</div>
        </div>
      </div>

      <div style={{ padding:"14px 16px" }}>

        {/* BOTTONI AGGIUNGI */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:18 }}>
          <button onClick={() => { setTipoForm("nota"); setShowForm(true); }}
            style={{ background:C.accentDim, border:`1px solid ${C.accent}40`, borderRadius:12, padding:"14px 8px", fontSize:12, fontWeight:700, color:C.accent, cursor:"pointer", fontFamily:"Barlow", display:"flex", flexDirection:"column", alignItems:"center", gap:6 }}>
            <span style={{ fontSize:24 }}>📝</span>Nota
          </button>
          <button onClick={() => { setTipoForm("checklist"); setShowForm(true); }}
            style={{ background:C.greenDim, border:`1px solid ${C.green}40`, borderRadius:12, padding:"14px 8px", fontSize:12, fontWeight:700, color:C.green, cursor:"pointer", fontFamily:"Barlow", display:"flex", flexDirection:"column", alignItems:"center", gap:6 }}>
            <span style={{ fontSize:24 }}>✅</span>Checklist
          </button>
          <button onClick={() => fotoRef.current.click()}
            style={{ background:C.goldDim, border:`1px solid ${C.gold}40`, borderRadius:12, padding:"14px 8px", fontSize:12, fontWeight:700, color:C.gold, cursor:"pointer", fontFamily:"Barlow", display:"flex", flexDirection:"column", alignItems:"center", gap:6, opacity:uploading?0.6:1 }}>
            <span style={{ fontSize:24 }}>{uploading ? "⏳" : "📷"}</span>
            {uploading ? "Carico..." : "Foto"}
          </button>
        </div>

        {/* Input foto nascosto — capture=environment forza la camera */}
        <input
          ref={fotoRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={gestisciFoto}
          style={{ display:"none" }}
        />

        {/* Lista appunti */}
        {loading && (
          <div style={{ textAlign:"center", color:C.textMuted, padding:32, fontSize:14 }}>
            Caricamento...
          </div>
        )}

        {!loading && appunti.length === 0 && (
          <div style={{ textAlign:"center", padding:"48px 0", color:C.textMuted }}>
            <div style={{ fontSize:40, marginBottom:12 }}>📋</div>
            <div style={{ fontSize:14, fontWeight:600 }}>Nessun appunto ancora</div>
            <div style={{ fontSize:12, marginTop:6, lineHeight:1.6 }}>
              Aggiungi note, checklist o foto dal cantiere.{"\n"}
              Saranno visibili anche sull ERP desktop.
            </div>
          </div>
        )}

        {appunti.map(a => {
          const col = catColor[a.categoria] || C.accent;
          const pctCheck = a.tipo === "checklist" && a.checklist?.length > 0
            ? Math.round(a.checklist.filter(v=>v.fatto).length / a.checklist.length * 100)
            : 0;

          return (
            <div key={a.id}
              onClick={() => setAppuntoAperto(a)}
              style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, marginBottom:10, overflow:"hidden", borderLeft:`3px solid ${col}`, cursor:"pointer", WebkitTapHighlightColor:"transparent" }}
              onTouchStart={e => e.currentTarget.style.opacity = "0.8"}
              onTouchEnd={e => e.currentTarget.style.opacity = "1"}>

              {/* Anteprima foto */}
              {a.tipo === "foto" && a.fotoUrl && (
                <img src={a.fotoUrl} alt="foto"
                  style={{ width:"100%", maxHeight:160, objectFit:"cover", display:"block" }} />
              )}

              <div style={{ padding:"10px 14px" }}>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                  <span style={{ fontSize:16 }}>{tipoIcon[a.tipo] || "📋"}</span>
                  <span style={{ fontSize:9, padding:"2px 6px", borderRadius:3, fontWeight:700, background:`${col}20`, color:col }}>
                    {a.categoria}
                  </span>
                  <span style={{ fontSize:10, color:C.textMuted, marginLeft:"auto" }}>
                    {fmtData(a.createdAt)}
                  </span>
                </div>

                {/* Anteprima testo */}
                {a.testo && (
                  <div style={{ fontSize:13, color:C.text, lineHeight:1.6,
                    overflow:"hidden", display:"-webkit-box", WebkitLineClamp:2,
                    WebkitBoxOrient:"vertical" }}>
                    {a.testo}
                  </div>
                )}

                {/* Anteprima checklist */}
                {a.tipo === "checklist" && a.checklist?.length > 0 && (
                  <div style={{ marginTop:6 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", fontSize:10, color:C.textMuted, marginBottom:3 }}>
                      <span>{a.checklist.filter(v=>v.fatto).length}/{a.checklist.length} completate</span>
                      <span style={{ color:C.green, fontWeight:700 }}>{pctCheck}%</span>
                    </div>
                    <div style={{ height:3, borderRadius:2, background:`${C.border}80`, overflow:"hidden" }}>
                      <div style={{ height:"100%", borderRadius:2, background:C.green, width:`${pctCheck}%`, transition:"width .3s" }} />
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── MODAL AGGIUNGI ── */}
      {showForm && (
        <Modal
          title={tipoForm==="nota"?"Nuova nota":tipoForm==="checklist"?"Nuova checklist":"Foto con nota"}
          onClose={resetForm}>

          {/* Anteprima foto caricata */}
          {tipoForm === "foto" && form.fotoUrl && (
            <img src={form.fotoUrl} alt="preview"
              style={{ width:"100%", borderRadius:10, maxHeight:200, objectFit:"cover", marginBottom:12 }} />
          )}

          {/* Categoria */}
          <div style={{ fontSize:10, color:C.textMuted, fontWeight:700, marginBottom:8 }}>CATEGORIA</div>
          <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:14 }}>
            {CATEGORIE.map(cat => (
              <button key={cat} onClick={() => setForm(p => ({...p, categoria:cat}))}
                style={{ padding:"5px 10px", fontSize:11, fontWeight:700, borderRadius:20, cursor:"pointer",
                  border:`1px solid ${form.categoria===cat?catColor[cat]+"60":C.border}`,
                  background:form.categoria===cat?`${catColor[cat]}20`:"transparent",
                  color:form.categoria===cat?catColor[cat]:C.textMuted, fontFamily:"Barlow" }}>
                {cat}
              </button>
            ))}
          </div>

          {/* Testo */}
          <Txta
            placeholder={tipoForm==="foto"?"Descrizione foto (opzionale)...":tipoForm==="checklist"?"Titolo checklist (opzionale)...":"Scrivi la tua nota *"}
            value={form.testo}
            onChange={e => setForm(p => ({...p, testo:e.target.value}))}
            rows={tipoForm==="nota"?5:2}
          />

          {/* Voci checklist */}
          {tipoForm === "checklist" && (
            <div style={{ marginBottom:10 }}>
              {form.checklist.map((v, i) => (
                <div key={i} style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                  <div style={{ width:18, height:18, borderRadius:4, border:`2px solid ${C.border}`, flexShrink:0 }} />
                  <span style={{ flex:1, fontSize:13, color:C.text }}>{v.testo}</span>
                  <button onClick={() => setForm(p => ({...p, checklist:p.checklist.filter((_,j)=>j!==i)}))}
                    style={{ background:"none", border:"none", color:C.textMuted, fontSize:16, cursor:"pointer" }}>✕</button>
                </div>
              ))}
              <div style={{ display:"flex", gap:8 }}>
                <input value={nuovaVoce}
                  onChange={e => setNuovaVoce(e.target.value)}
                  onKeyDown={e => e.key==="Enter" && aggiungiVoce()}
                  placeholder="Aggiungi voce..."
                  style={{ flex:1, background:`${C.mid}40`, border:`1px solid ${C.border}`, borderRadius:8,
                    color:C.text, padding:"8px 12px", fontSize:13, outline:"none", fontFamily:"Barlow" }} />
                <button onClick={aggiungiVoce}
                  style={{ background:C.accentDim, border:`1px solid ${C.accent}40`, borderRadius:8,
                    color:C.accent, padding:"8px 16px", fontSize:16, fontWeight:700, cursor:"pointer" }}>
                  +
                </button>
              </div>
            </div>
          )}

          <Btn
            label={saving ? "Salvataggio..." : "✓ Salva e notifica"}
            onClick={salva}
            disabled={saving || !canSalva()}
          />
          <Btn label="Annulla" onClick={resetForm} variant="secondary" />
        </Modal>
      )}

      {/* ── MODAL VISUALIZZA APPUNTO ── */}
      {appuntoAperto && (
        <Modal
          title={appuntoAperto.tipo==="nota"?"Nota":appuntoAperto.tipo==="checklist"?"Checklist":"Foto"}
          onClose={() => setAppuntoAperto(null)}>

          {/* Foto */}
          {appuntoAperto.tipo === "foto" && appuntoAperto.fotoUrl && (
            <img src={appuntoAperto.fotoUrl} alt="foto cantiere"
              style={{ width:"100%", borderRadius:10, marginBottom:12, maxHeight:280, objectFit:"cover" }} />
          )}

          {/* Categoria e data */}
          <div style={{ display:"flex", gap:8, alignItems:"center", marginBottom:12 }}>
            <span style={{ fontSize:10, padding:"3px 8px", borderRadius:4, fontWeight:700,
              background:`${catColor[appuntoAperto.categoria]||C.accent}20`,
              color:catColor[appuntoAperto.categoria]||C.accent }}>
              {appuntoAperto.categoria}
            </span>
            <span style={{ fontSize:11, color:C.textMuted }}>{fmtData(appuntoAperto.createdAt)}</span>
          </div>

          {/* Testo */}
          {appuntoAperto.testo && (
            <div style={{ fontSize:14, color:C.text, lineHeight:1.8, whiteSpace:"pre-wrap", marginBottom:12 }}>
              {appuntoAperto.testo}
            </div>
          )}

          {/* Checklist interattiva — editabile */}
          {appuntoAperto.tipo === "checklist" && (
            <div style={{ marginBottom:12 }}>
              {(appuntoAperto.checklist || []).map((v, i) => (
                <div key={i} style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 0", borderBottom:`1px solid ${C.border}40` }}>
                  <div onClick={() => toggleChecklistItem(appuntoAperto, i)}
                    style={{ width:24, height:24, borderRadius:6, flexShrink:0,
                      border:`2px solid ${v.fatto?C.green:C.border}`,
                      background:v.fatto?C.green:"transparent",
                      display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer" }}>
                    {v.fatto && <span style={{ color:"#000", fontSize:13, fontWeight:800 }}>✓</span>}
                  </div>
                  {editingCheckIdx === i ? (
                    <div style={{ flex:1, display:"flex", gap:4 }}>
                      <input value={editingCheckText} onChange={e => setEditingCheckText(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") saveChecklistEdit(appuntoAperto, i); if (e.key === "Escape") setEditingCheckIdx(null); }}
                        autoFocus
                        style={{ flex:1, background:`${C.mid}40`, border:`1px solid ${C.accent}`, borderRadius:6, color:C.text, padding:"6px 10px", fontSize:13, fontFamily:"Barlow" }} />
                      <button onClick={() => saveChecklistEdit(appuntoAperto, i)} style={{ background:C.green, border:"none", borderRadius:6, color:"#fff", padding:"6px 10px", fontSize:12, fontWeight:700, cursor:"pointer" }}>✓</button>
                    </div>
                  ) : (
                    <span onClick={() => { setEditingCheckIdx(i); setEditingCheckText(v.testo); }}
                      style={{ fontSize:14, color:v.fatto?C.textMuted:C.text,
                        textDecoration:v.fatto?"line-through":"none", flex:1, lineHeight:1.5, cursor:"pointer" }}>
                      {v.testo}
                    </span>
                  )}
                  <button onClick={() => removeChecklistItem(appuntoAperto, i)}
                    style={{ background:"none", border:"none", color:C.red, fontSize:16, cursor:"pointer", padding:"4px 6px", flexShrink:0, opacity:0.6 }}>×</button>
                </div>
              ))}

              {/* Aggiungi voce */}
              <div style={{ display:"flex", gap:6, marginTop:10 }}>
                <input value={newCheckVoce} onChange={e => setNewCheckVoce(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") addChecklistItem(appuntoAperto); }}
                  placeholder="Aggiungi voce..."
                  style={{ flex:1, background:`${C.mid}40`, border:`1px solid ${C.border}`, borderRadius:8, color:C.text, padding:"10px 12px", fontSize:13, fontFamily:"Barlow" }} />
                <button onClick={() => addChecklistItem(appuntoAperto)} disabled={!newCheckVoce.trim()}
                  style={{ background:C.green, border:"none", borderRadius:8, color:"#fff", padding:"10px 14px", fontSize:13, fontWeight:700, cursor:"pointer", opacity:newCheckVoce.trim()?1:0.4 }}>+</button>
              </div>

              {/* Barra progresso */}
              {appuntoAperto.checklist?.length > 0 && (
                <div style={{ marginTop:12 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:C.textMuted, marginBottom:4 }}>
                    <span>Completate</span>
                    <span style={{ color:C.green, fontWeight:700 }}>
                      {appuntoAperto.checklist.filter(v=>v.fatto).length}/{appuntoAperto.checklist.length}
                    </span>
                  </div>
                  <div style={{ height:5, borderRadius:3, background:`${C.border}80`, overflow:"hidden" }}>
                    <div style={{ height:"100%", borderRadius:3, background:C.green, transition:"width .3s",
                      width:`${Math.round(appuntoAperto.checklist.filter(v=>v.fatto).length/appuntoAperto.checklist.length*100)}%` }} />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Elimina */}
          <div style={{ height:8 }} />
          <Btn label="🗑 Elimina appunto" onClick={() => eliminaAppunto(appuntoAperto.id)} variant="danger" />
        </Modal>
      )}
    </div>
  );
}



// ─── HUB APPUNTI (seleziona cantiere) ────────────────────────────────────────
function AppuntiHub({ user, onSelect }) {
  const [cantieri, setCantieri] = useState([]);
  useEffect(() => {
    getDocs(query(collection(db,"projects"),where("status","in",["active","draft"])))
      .then(s => setCantieri(s.docs.map(d => ({id:d.id,...d.data()}))));
  }, []);
  return (
    <div style={{ padding:"16px 16px 80px" }} className="fu">
      <div style={{ fontSize:10, fontWeight:800, color:C.textMuted, letterSpacing:2, textTransform:"uppercase", marginBottom:14 }}>Seleziona cantiere</div>
      {cantieri.length===0 && <Empty icon="🏗" msg="Nessun cantiere attivo" />}
      {cantieri.map(c => (
        <div key={c.id} onClick={() => onSelect(c)}
          style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, padding:"14px 16px", marginBottom:8, cursor:"pointer", display:"flex", alignItems:"center", gap:12 }}
          onTouchStart={e => e.currentTarget.style.opacity="0.8"}
          onTouchEnd={e => e.currentTarget.style.opacity="1"}>
          <div style={{ width:40, height:40, borderRadius:10, background:C.accentDim, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, flexShrink:0 }}>📷</div>
          <div style={{ flex:1 }}>
            <div style={{ fontWeight:700, fontSize:15 }}>{formatNomeCantiere(c)}</div>
            {formatCommittente(c) && <div style={{ fontSize:12, color:C.text, marginTop:2, fontWeight:600 }}>{formatCommittente(c)}</div>}
            {formatIndirizzo(c) && <div style={{ fontSize:11, color:C.textMuted, marginTop:2 }}>📍 {formatIndirizzo(c)}</div>}
          </div>
          <span style={{ color:C.accent, fontSize:20 }}>›</span>
        </div>
      ))}
    </div>
  );
}

// ─── MISURATORE HUB ──────────────────────────────────────────────────────────
function MisuratoreHub({ user, onSelect }) {
  const [cantieri, setCantieri] = useState([]);
  useEffect(() => {
    getDocs(query(collection(db,"projects"),where("status","in",["active","draft"])))
      .then(s => setCantieri(s.docs.map(d => ({id:d.id,...d.data()}))));
  }, []);
  return (
    <div style={{ padding:"16px 16px 80px" }} className="fu">
      <div style={{ fontSize:10, fontWeight:800, color:C.textMuted, letterSpacing:2, textTransform:"uppercase", marginBottom:14 }}>Seleziona cantiere</div>
      {cantieri.length===0 && <Empty icon="📐" msg="Nessun cantiere attivo" />}
      {cantieri.map(c => (
        <div key={c.id} onClick={() => onSelect(c)}
          style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, padding:"14px 16px", marginBottom:8, cursor:"pointer", display:"flex", alignItems:"center", gap:12 }}
          onTouchStart={e => e.currentTarget.style.opacity="0.8"}
          onTouchEnd={e => e.currentTarget.style.opacity="1"}>
          <div style={{ width:40, height:40, borderRadius:10, background:"rgba(32,112,200,0.15)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, flexShrink:0 }}>📐</div>
          <div style={{ flex:1 }}>
            <div style={{ fontWeight:700, fontSize:15, color:C.text }}>{c.clientName || c.name}</div>
            {c.address && <div style={{ fontSize:11, color:C.textMuted, marginTop:2 }}>📍 {c.address}</div>}
          </div>
          <span style={{ color:C.accent, fontSize:20 }}>›</span>
        </div>
      ))}
    </div>
  );
}

// ─── MISURATORE DISEGNO ──────────────────────────────────────────────────────

// Carica pdfjs da CDN (evita problemi di bundling con CRA/Webpack)
function loadPdfjsCDN() {
  return new Promise((resolve, reject) => {
    if (window.pdfjsLib) { resolve(window.pdfjsLib); return; }
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    script.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      resolve(window.pdfjsLib);
    };
    script.onerror = () => reject(new Error('Impossibile caricare il lettore PDF'));
    document.head.appendChild(script);
  });
}

// Scarica PDF come ArrayBuffer via XHR (evita problemi CORS con fetch su Firebase Storage)
function fetchPdfAsBuffer(url) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    xhr.setRequestHeader('Cache-Control', 'no-cache');
    xhr.onload = () => {
      if (xhr.status === 200) resolve(xhr.response);
      else reject(new Error('HTTP ' + xhr.status));
    };
    xhr.onerror = () => reject(new Error('Errore di rete'));
    xhr.send();
  });
}

function MisuratoreDisegno({ user, projectId, projectName, onBack, fileUrl: initFileUrl, fileName: initFileName }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);

  // Tool: scala, linea, angolo
  const [tool, setTool] = useState("linea");
  const [imageEl, setImageEl] = useState(null);
  const [fileName, setFileName] = useState(initFileName || "");

  // View state
  const [offset, setOffset] = useState({ x:0, y:0 });
  const [zoom, setZoom] = useState(1);
  const [scala, setScala] = useState(0); // px per metro
  const [scalaPunti, setScalaPunti] = useState([]); // i 2 punti usati per la scala
  const [scalaMetri, setScalaMetri] = useState(0); // misura reale inserita
  const [dragScala, setDragScala] = useState(null); // { pointIndex }
  const [scalaConfermata, setScalaConfermata] = useState(false); // true = nasconde punti scala

  // Misure e punti
  const [misure, setMisure] = useState([]);
  const [puntiCorrente, setPuntiCorrente] = useState([]);
  const [selectedMisura, setSelectedMisura] = useState(null);
  const [dragHandle, setDragHandle] = useState(null); // { id, pointIndex }
  const dragMisuraRef = useRef(null); // { id, startPunti, startTouch }
  const [magnifier, setMagnifier] = useState(null); // { x, y } coordinate schermo per lente
  const magnifierTimer = useRef(null);

  // Touch state
  const touchRef = useRef({ startPos:null, startOffset:null, startDist:0, startZoom:1, moved:false, lastTap:0 });

  // File list e modali
  const [showFiles, setShowFiles] = useState(false);
  const [files, setFiles] = useState([]);
  const [showScalaModal, setShowScalaModal] = useState(false);
  const [scalaVal, setScalaVal] = useState("");
  const [scalaUnit, setScalaUnit] = useState("m");
  const [showSalvaModal, setShowSalvaModal] = useState(false);
  const [lavorazioni, setLavorazioni] = useState([]);
  const [selectedLav, setSelectedLav] = useState("");
  const [salvaDesc, setSalvaDesc] = useState("");
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState("");

  const COLORS = { scala:"#D85A30", linea:"#2070C8", angolo:"#E24B4A", selected:"#EF9F27" };

  // Carica file e lavorazioni
  useEffect(() => {
    getDocs(collection(db,"projects",projectId,"files"))
      .then(s => setFiles(s.docs.map(d => ({id:d.id,...d.data()}))));
    getDocs(collection(db,"projects",projectId,"lavorazioni"))
      .then(s => setLavorazioni(s.docs.map(d => ({id:d.id,...d.data()}))));
  }, [projectId]);

  // Carica file passato come prop
  useEffect(() => {
    if (initFileUrl) {
      const ext = (initFileName || '').split('.').pop()?.toLowerCase() || '';
      if (['dwg','dxf'].includes(ext)) return;
      loadRemoteFile({ url: initFileUrl, nome: initFileName || 'file' });
    }
  }, [initFileUrl]);

  // Canvas resize
  useEffect(() => {
    function resize() {
      const c = canvasRef.current; const cont = containerRef.current;
      if (!c || !cont) return;
      const dpr = window.devicePixelRatio || 1;
      c.width = cont.clientWidth * dpr;
      c.height = cont.clientHeight * dpr;
      c.style.width = cont.clientWidth + "px";
      c.style.height = cont.clientHeight + "px";
      redraw();
    }
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [imageEl, offset, zoom, misure, puntiCorrente, selectedMisura]);

  // Helpers
  function distPx(a, b) { return Math.sqrt((b.x-a.x)**2 + (b.y-a.y)**2); }
  function distMetri(a, b) { return scala > 0 ? distPx(a,b) / scala : distPx(a,b); }
  function calcolaAngolo(p1, p2, p3) {
    const v1 = { x:p1.x-p2.x, y:p1.y-p2.y };
    const v2 = { x:p3.x-p2.x, y:p3.y-p2.y };
    const dot = v1.x*v2.x + v1.y*v2.y;
    const mag1 = Math.sqrt(v1.x**2+v1.y**2);
    const mag2 = Math.sqrt(v2.x**2+v2.y**2);
    if (mag1===0||mag2===0) return 0;
    return Math.acos(Math.max(-1,Math.min(1, dot/(mag1*mag2)))) * 180/Math.PI;
  }

  function screenToImg(sx, sy) {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x:0, y:0 };
    return { x:(sx-rect.left-offset.x)/zoom, y:(sy-rect.top-offset.y)/zoom };
  }

  function snapPoint(pt) {
    const threshold = 30 / zoom;
    let best = pt; let bestDist = threshold;
    misure.forEach(m => m.punti.forEach(p => {
      const d = distPx(pt,p);
      if (d < bestDist) { bestDist=d; best=p; }
    }));
    puntiCorrente.forEach(p => {
      const d = distPx(pt,p);
      if (d < bestDist) { bestDist=d; best=p; }
    });
    return best;
  }

  // Croce di precisione
  function drawCross(ctx, x, y, size, color, lw) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lw || 1.5/zoom;
    ctx.beginPath();
    ctx.moveTo(x - size, y); ctx.lineTo(x + size, y);
    ctx.moveTo(x, y - size); ctx.lineTo(x, y + size);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 2/zoom, 0, Math.PI*2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }

  // Distanza punto-segmento
  function distPtSeg(pt, a, b) {
    const dx = b.x-a.x, dy = b.y-a.y;
    const len2 = dx*dx+dy*dy;
    if (len2===0) return distPx(pt,a);
    let t = ((pt.x-a.x)*dx+(pt.y-a.y)*dy)/len2;
    t = Math.max(0,Math.min(1,t));
    return distPx(pt, {x:a.x+t*dx, y:a.y+t*dy});
  }

  // OCR su area del canvas
  const [ocrLoading, setOcrLoading] = useState(false);
  const [showOcrResult, setShowOcrResult] = useState(null); // { valore, x, y }

  async function leggiQuotaDaCanvas(sx, sy) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setOcrLoading(true);
    try {
      const ctx = canvas.getContext("2d");
      const dpr = window.devicePixelRatio || 1;
      const size = 140 * dpr;
      const cx = sx * dpr, cy = sy * dpr;
      const x0 = Math.max(0, Math.round(cx - size/2));
      const y0 = Math.max(0, Math.round(cy - size/2));
      const imageData = ctx.getImageData(x0, y0, Math.min(size, canvas.width - x0), Math.min(size, canvas.height - y0));
      const tc = document.createElement("canvas");
      tc.width = imageData.width; tc.height = imageData.height;
      tc.getContext("2d").putImageData(imageData, 0, 0);
      const Tesseract = (await import("tesseract.js")).default;
      const result = await Tesseract.recognize(tc, "eng", { tessedit_char_whitelist: "0123456789.," });
      const testo = result.data.text.trim();
      const numMatch = testo.match(/[\d]+[.,]?[\d]*/);
      if (numMatch) {
        const valore = parseFloat(numMatch[0].replace(",", "."));
        if (valore > 0) {
          setShowOcrResult({ valore, x: sx, y: sy });
          setOcrLoading(false);
          return;
        }
      }
      showToast("Nessun numero trovato");
    } catch (err) {
      console.error("OCR:", err);
      showToast("Errore lettura: " + (err.message || ""));
    }
    setOcrLoading(false);
  }

  // ── DRAW ──
  function redraw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr,0,0,dpr,0,0);
    const w = canvas.width/dpr; const h = canvas.height/dpr;
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(0,0,w,h);

    if (imageEl) {
      ctx.save();
      ctx.translate(offset.x, offset.y);
      ctx.scale(zoom, zoom);
      ctx.drawImage(imageEl, 0, 0);
      ctx.restore();
    }

    // Disegna misure
    misure.forEach(m => {
      if (m.punti.length < 2) return;
      const isSel = m.id === selectedMisura;
      const color = isSel ? COLORS.selected : (COLORS[m.tipo] || COLORS.linea);
      ctx.save();
      ctx.translate(offset.x, offset.y);
      ctx.scale(zoom, zoom);

      // Linee
      ctx.strokeStyle = color;
      ctx.lineWidth = (isSel ? 3 : 2) / zoom;
      ctx.setLineDash([]);
      ctx.beginPath();
      if (m.tipo === "angolo") {
        ctx.moveTo(m.punti[0].x, m.punti[0].y);
        ctx.lineTo(m.punti[1].x, m.punti[1].y);
        ctx.lineTo(m.punti[2].x, m.punti[2].y);
        ctx.stroke();
        const r = Math.min(distPx(m.punti[0],m.punti[1]), distPx(m.punti[2],m.punti[1]), 30/zoom) * 0.5;
        const a1 = Math.atan2(m.punti[0].y-m.punti[1].y, m.punti[0].x-m.punti[1].x);
        const a2 = Math.atan2(m.punti[2].y-m.punti[1].y, m.punti[2].x-m.punti[1].x);
        ctx.beginPath();
        ctx.arc(m.punti[1].x, m.punti[1].y, r, a1, a2, a1 > a2);
        ctx.stroke();
      } else {
        ctx.moveTo(m.punti[0].x, m.punti[0].y);
        for (let i=1; i<m.punti.length; i++) ctx.lineTo(m.punti[i].x, m.punti[i].y);
        ctx.stroke();
      }

      // Label al centro
      let lp;
      if (m.tipo === "angolo") {
        const p2 = m.punti[1];
        const v1 = { x:m.punti[0].x-p2.x, y:m.punti[0].y-p2.y };
        const v2 = { x:m.punti[2].x-p2.x, y:m.punti[2].y-p2.y };
        const m1 = Math.sqrt(v1.x**2+v1.y**2)||1;
        const m2 = Math.sqrt(v2.x**2+v2.y**2)||1;
        const bx = v1.x/m1+v2.x/m2; const by = v1.y/m1+v2.y/m2;
        const bm = Math.sqrt(bx**2+by**2)||1;
        const rr = Math.min(m1,m2,40/zoom)*0.6;
        lp = { x:p2.x+bx/bm*rr, y:p2.y+by/bm*rr };
      } else {
        lp = { x:(m.punti[0].x+m.punti[m.punti.length-1].x)/2, y:(m.punti[0].y+m.punti[m.punti.length-1].y)/2 };
      }
      ctx.font = "bold "+13/zoom+"px sans-serif";
      const tm = ctx.measureText(m.label);
      const pad = 4/zoom;
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(lp.x-tm.width/2-pad, lp.y-12/zoom, tm.width+pad*2, 16/zoom);
      ctx.fillStyle = color;
      ctx.fillText(m.label, lp.x-tm.width/2, lp.y);

      // Croci sugli endpoint
      m.punti.forEach(p => {
        if (isSel) {
          ctx.beginPath(); ctx.arc(p.x, p.y, 30/zoom, 0, Math.PI*2);
          ctx.fillStyle = COLORS.selected + "10"; ctx.fill();
          ctx.strokeStyle = COLORS.selected + "30"; ctx.lineWidth = 1/zoom; ctx.stroke();
          drawCross(ctx, p.x, p.y, 14/zoom, COLORS.selected, 2.5/zoom);
        } else {
          drawCross(ctx, p.x, p.y, 12/zoom, "#000", 2/zoom);
        }
      });
      // X rossa per eliminare
      if (isSel && m.punti.length > 0) {
        const ep = m.punti[0];
        ctx.font = "bold " + 16/zoom + "px sans-serif";
        ctx.fillStyle = "#E24B4A";
        ctx.fillText("\u00D7", ep.x - 18/zoom, ep.y - 18/zoom);
      }
      ctx.restore();
    });

    // Punti in costruzione
    if (puntiCorrente.length > 0) {
      const color = COLORS[tool] || COLORS.linea;
      ctx.save();
      ctx.translate(offset.x, offset.y);
      ctx.scale(zoom, zoom);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2/zoom;
      ctx.setLineDash([5/zoom, 5/zoom]);
      ctx.beginPath();
      ctx.moveTo(puntiCorrente[0].x, puntiCorrente[0].y);
      for (let i=1; i<puntiCorrente.length; i++) ctx.lineTo(puntiCorrente[i].x, puntiCorrente[i].y);
      ctx.stroke();
      ctx.setLineDash([]);
      puntiCorrente.forEach(p => drawCross(ctx, p.x, p.y, 14/zoom, "#000", 2.5/zoom));
      ctx.restore();
    }

    // Punti scala sul canvas (trascinabili, nascosti dopo Accetta)
    if (scalaPunti.length === 2 && !scalaConfermata) {
      ctx.save();
      ctx.translate(offset.x, offset.y);
      ctx.scale(zoom, zoom);
      // Linea tratteggiata arancio tra i 2 punti scala
      ctx.strokeStyle = "#D85A30";
      ctx.lineWidth = 2/zoom;
      ctx.setLineDash([6/zoom, 4/zoom]);
      ctx.beginPath();
      ctx.moveTo(scalaPunti[0].x, scalaPunti[0].y);
      ctx.lineTo(scalaPunti[1].x, scalaPunti[1].y);
      ctx.stroke();
      ctx.setLineDash([]);
      // Croci nere sui punti
      scalaPunti.forEach(p => drawCross(ctx, p.x, p.y, 14/zoom, "#000", 2.5/zoom));
      // Label scala al centro
      const slp = { x:(scalaPunti[0].x+scalaPunti[1].x)/2, y:(scalaPunti[0].y+scalaPunti[1].y)/2 };
      ctx.font = "bold "+12/zoom+"px sans-serif";
      const stm = ctx.measureText(scalaMetri+"m");
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(slp.x-stm.width/2-4/zoom, slp.y-11/zoom, stm.width+8/zoom, 14/zoom);
      ctx.fillStyle = "#D85A30";
      ctx.fillText(scalaMetri+"m", slp.x-stm.width/2, slp.y);
      ctx.restore();
    }

    // Scala info
    if (scala > 0) {
      ctx.fillStyle = "#aaa";
      ctx.font = "11px sans-serif";
      ctx.fillText("Scala: 1m = "+(scala).toFixed(0)+"px", 10, h-10);
    }

    // OCR loading indicator
    if (ocrLoading) {
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(0,0,w,h);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 16px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Lettura quota...", w/2, h/2);
      ctx.textAlign = "start";
    }
  }

  useEffect(() => { requestAnimationFrame(redraw); }, [imageEl, offset, zoom, misure, puntiCorrente, selectedMisura, ocrLoading, scalaPunti]);

  // ── Carica immagine ──
  function loadImage(src, name) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      setImageEl(img); if (name) setFileName(name);
      setOffset({x:0,y:0}); setZoom(1); setMisure([]); setPuntiCorrente([]); setScala(0); setSelectedMisura(null);
    };
    img.src = src;
  }

  async function handleFileInput(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    if (ext === "dwg" || ext === "dxf") {
      alert("Converti in PDF o immagine per misurare");
      return;
    }
    if (file.type === "application/pdf" || ext === "pdf") {
      try {
        const pdfjsLib = await loadPdfjsCDN();
        const ab = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(ab) }).promise;
        const page = await pdf.getPage(1);
        const vp = page.getViewport({ scale:2.5 });
        const tc = document.createElement("canvas");
        tc.width = vp.width; tc.height = vp.height;
        await page.render({ canvasContext:tc.getContext("2d"), viewport:vp }).promise;
        loadImage(tc.toDataURL("image/png"), file.name);
      } catch (err) {
        console.error("Errore PDF locale:", err);
        alert("Errore nel caricamento del PDF: " + (err.message || err));
      }
      return;
    }
    const reader = new FileReader();
    reader.onload = ev => { if (ev.target?.result) loadImage(ev.target.result, file.name); };
    reader.readAsDataURL(file);
  }

  async function loadRemoteFile(f) {
    const ext = (f.nome||"").split(".").pop()?.toLowerCase() || "";
    if (ext === "dwg" || ext === "dxf") {
      alert("Converti in PDF o immagine per misurare");
      return;
    }
    setShowFiles(false);
    if (ext === "pdf") {
      try {
        // Carica PDF direttamente con pdfjs passando l'URL — evita fetch/CORS
        const pdfjsLib = await loadPdfjsCDN();
        const pdf = await pdfjsLib.getDocument({ url: f.url, withCredentials: false }).promise;
        const page = await pdf.getPage(1);
        const vp = page.getViewport({ scale: 2 });
        const tc = document.createElement("canvas");
        tc.width = vp.width; tc.height = vp.height;
        await page.render({ canvasContext: tc.getContext("2d"), viewport: vp }).promise;
        loadImage(tc.toDataURL("image/png"), f.nome);
      } catch (err) { console.error("Errore PDF remoto:", err); alert("Errore PDF: " + (err.message || err)); }
      return;
    }
    // Per immagini: carica con crossOrigin
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => loadImage(img.src, f.nome);
    img.onerror = () => {
      // Fallback senza crossOrigin
      const img2 = new Image();
      img2.onload = () => loadImage(img2.src, f.nome);
      img2.onerror = () => alert("Errore caricamento immagine");
      img2.src = f.url;
    };
    img.src = f.url;
  }

  // ── TOUCH HANDLERS (pinch zoom fluido + pan + tap + handle drag) ──
  const lastPinchDist = useRef(null);
  const lastPinchCenter = useRef(null);
  const lastTapTime = useRef(0);

  function getTouchDist(t1, t2) {
    return Math.sqrt((t2.clientX - t1.clientX) ** 2 + (t2.clientY - t1.clientY) ** 2);
  }
  function getTouchCenter(t1, t2) {
    return { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 };
  }

  function onTouchStart(e) {
    const touches = e.touches;
    if (touches.length === 2) {
      lastPinchDist.current = getTouchDist(touches[0], touches[1]);
      lastPinchCenter.current = getTouchCenter(touches[0], touches[1]);
      touchRef.current.moved = true;
      return;
    }
    const t = touches[0];
    touchRef.current = {
      startPos: { x: t.clientX, y: t.clientY },
      startOffset: { ...offset },
      moved: false,
    };

    // Check drag punti scala (solo se non confermata)
    if (scalaPunti.length === 2 && !scalaConfermata) {
      const pt = screenToImg(t.clientX, t.clientY);
      const scalaThreshold = 44 / zoom;
      for (let i = 0; i < 2; i++) {
        if (distPx(pt, scalaPunti[i]) < scalaThreshold) {
          setDragScala({ pointIndex: i });
          magnifierTimer.current = setTimeout(() => {
            setMagnifier({ x: t.clientX, y: t.clientY });
          }, 400);
          touchRef.current.moved = true;
          return;
        }
      }
    }

    // Check handle della misura selezionata (raggio grande per touch)
    if (selectedMisura) {
      const pt = screenToImg(t.clientX, t.clientY);
      const m = misure.find(mm => mm.id === selectedMisura);
      if (m) {
        const threshold = 40 / zoom; // area grande per dita grosse
        // Prima controlla gli handle
        for (let i = 0; i < m.punti.length; i++) {
          if (distPx(pt, m.punti[i]) < threshold) {
            setDragHandle({ id: m.id, pointIndex: i });
            // Attiva lente dopo 400ms di pressione
            magnifierTimer.current = setTimeout(() => {
              setMagnifier({ x: t.clientX, y: t.clientY });
            }, 400);
            touchRef.current.moved = true;
            return;
          }
        }
        // Poi controlla se tocca il segmento -> drag intera misura
        let onSegment = false;
        for (let j = 0; j < m.punti.length - 1; j++) {
          if (distPtSeg(pt, m.punti[j], m.punti[j+1]) < threshold) { onSegment = true; break; }
        }
        if (onSegment) {
          dragMisuraRef.current = { id: m.id, startPunti: m.punti.map(p => ({...p})), startTouch: pt };
          touchRef.current.moved = true;
          return;
        }
      }
    }
  }

  // Refs per valori usati nel touchmove listener (evita stale closures)
  const stateRef = useRef({ zoom: 1, offset: { x: 0, y: 0 }, dragHandle: null });
  stateRef.current = { zoom, offset, dragHandle, dragScala };

  // addEventListener manuale con passive:false per preventDefault
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleTouchMove = (e) => {
      e.preventDefault();
      const touches = e.touches;
      const { zoom: z, offset: off } = stateRef.current;
      const dh = stateRef.current.dragHandle;

      // screenToImg con valori correnti
      function s2i(sx, sy) {
        const rect = canvas.getBoundingClientRect();
        return { x: (sx - rect.left - off.x) / z, y: (sy - rect.top - off.y) / z };
      }

      // Pinch zoom fluido centrato sul punto di pinch
      if (touches.length === 2 && lastPinchDist.current) {
        const newDist = getTouchDist(touches[0], touches[1]);
        const newCenter = getTouchCenter(touches[0], touches[1]);
        const scale = newDist / lastPinchDist.current;
        const rect = canvas.getBoundingClientRect();
        const cx = newCenter.x - rect.left;
        const cy = newCenter.y - rect.top;

        setZoom(prev => {
          const nz = Math.min(8, Math.max(0.3, prev * scale));
          setOffset(prevOff => ({
            x: cx - (cx - prevOff.x) * (nz / prev),
            y: cy - (cy - prevOff.y) * (nz / prev),
          }));
          return nz;
        });

        lastPinchDist.current = newDist;
        lastPinchCenter.current = newCenter;
        touchRef.current.moved = true;
        return;
      }

      const t = touches[0];

      // Drag punto scala
      const ds = stateRef.current.dragScala;
      if (ds) {
        const pt = s2i(t.clientX, t.clientY);
        setScalaPunti(prev => {
          const np = [...prev]; np[ds.pointIndex] = pt; return np;
        });
        setMagnifier({ x: t.clientX, y: t.clientY });
        touchRef.current.moved = true;
        return;
      }

      // Drag handle
      if (dh) {
        const pt = s2i(t.clientX, t.clientY);
        setMisure(prev => prev.map(m => {
          if (m.id !== dh.id) return m;
          const np = [...m.punti]; np[dh.pointIndex] = pt;
          return { ...m, punti: np };
        }));
        setMagnifier({ x: t.clientX, y: t.clientY });
        touchRef.current.moved = true;
        return;
      }

      // Drag intera misura
      if (dragMisuraRef.current) {
        const pt = s2i(t.clientX, t.clientY);
        const dx = pt.x - dragMisuraRef.current.startTouch.x;
        const dy = pt.y - dragMisuraRef.current.startTouch.y;
        setMisure(prev => prev.map(m => {
          if (m.id !== dragMisuraRef.current.id) return m;
          return { ...m, punti: dragMisuraRef.current.startPunti.map(p => ({ x: p.x + dx, y: p.y + dy })) };
        }));
        touchRef.current.moved = true;
        return;
      }

      // Pan
      if (touchRef.current.startPos) {
        const dx = t.clientX - touchRef.current.startPos.x;
        const dy = t.clientY - touchRef.current.startPos.y;
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
          touchRef.current.moved = true;
          setOffset({
            x: touchRef.current.startOffset.x + dx,
            y: touchRef.current.startOffset.y + dy,
          });
        }
      }
    };

    const handleTouchStart = (e) => { if (e.touches.length > 1) e.preventDefault(); };
    canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
    canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
    return () => {
      canvas.removeEventListener('touchstart', handleTouchStart);
      canvas.removeEventListener('touchmove', handleTouchMove);
    };
  }, []); // registrato una sola volta, usa refs per valori correnti

  function onTouchEnd(e) {
    lastPinchDist.current = null;
    lastPinchCenter.current = null;
    if (magnifierTimer.current) { clearTimeout(magnifierTimer.current); magnifierTimer.current = null; }
    setMagnifier(null);

    // Ricalcola scala dopo drag punto scala
    if (dragScala) {
      if (scalaPunti.length === 2 && scalaMetri > 0) {
        const dist = distPx(scalaPunti[0], scalaPunti[1]);
        setScala(dist / scalaMetri);
        showToast("Scala aggiornata");
      }
      setDragScala(null);
      return;
    }

    // Ricalcola misura dopo drag intera misura
    if (dragMisuraRef.current) {
      const m = misure.find(mm => mm.id === dragMisuraRef.current.id);
      if (m) {
        let valore = 0, label = "";
        if (m.tipo === "linea") { valore = distMetri(m.punti[0], m.punti[1]); label = scala > 0 ? valore.toFixed(2) + " m" : valore.toFixed(0) + " px"; }
        if (m.tipo === "angolo" && m.punti.length === 3) { valore = calcolaAngolo(m.punti[0], m.punti[1], m.punti[2]); label = valore.toFixed(1) + "\u00B0"; }
        setMisure(prev => prev.map(mm => mm.id === m.id ? { ...mm, valore, label } : mm));
      }
      dragMisuraRef.current = null;
      return;
    }

    // Ricalcola misura dopo drag handle
    if (dragHandle) {
      const m = misure.find(mm => mm.id === dragHandle.id);
      if (m) {
        let valore = 0, label = "";
        if (m.tipo === "linea") { valore = distMetri(m.punti[0], m.punti[1]); label = scala > 0 ? valore.toFixed(2) + " m" : valore.toFixed(0) + " px"; }
        if (m.tipo === "angolo" && m.punti.length === 3) { valore = calcolaAngolo(m.punti[0], m.punti[1], m.punti[2]); label = valore.toFixed(1) + "\u00B0"; }
        setMisure(prev => prev.map(mm => mm.id === m.id ? { ...mm, valore, label } : mm));
      }
      setDragHandle(null);
      return;
    }

    if (touchRef.current.moved) return;

    // TAP
    const t = e.changedTouches[0];
    const rawPt = screenToImg(t.clientX, t.clientY);
    const pt = snapPoint(rawPt);
    const now = Date.now();

    // Double tap: elimina misura sotto il dito
    if (now - lastTapTime.current < 350) {
      const hit = hitTestMisura(rawPt);
      if (hit) {
        setMisure(prev => prev.filter(m => m.id !== hit));
        setSelectedMisura(null);
        showToast("Misura eliminata");
        lastTapTime.current = 0;
        return;
      }
    }
    lastTapTime.current = now;

    // Se nessun tool attivo o select: seleziona/deseleziona
    if (!tool || tool === "select") {
      const hit = hitTestMisura(rawPt);
      setSelectedMisura(hit);
      return;
    }

    if (tool === "ocr") {
      // Leggi quota dal disegno con OCR
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect) leggiQuotaDaCanvas(t.clientX - rect.left, t.clientY - rect.top);
      return;
    }

    if (tool === "scala") {
      const pts = [...puntiCorrente, pt];
      setPuntiCorrente(pts);
      if (pts.length === 2) setShowScalaModal(true);
      return;
    }

    if (tool === "linea") {
      const pts = [...puntiCorrente, pt];
      setPuntiCorrente(pts);
      if (pts.length === 2) {
        const dist = distMetri(pts[0], pts[1]);
        const label = scala > 0 ? dist.toFixed(2) + " m" : dist.toFixed(0) + " px";
        const newId = "m_" + Date.now();
        setMisure(prev => [...prev, { id: newId, tipo: "linea", punti: pts, valore: dist, label, colore: COLORS.linea }]);
        setPuntiCorrente([]);
        setSelectedMisura(newId);
        setTool("select");
      }
      return;
    }

    if (tool === "angolo") {
      const pts = [...puntiCorrente, pt];
      setPuntiCorrente(pts);
      if (pts.length === 3) {
        // pts[0]=vertice, pts[1]=lato1, pts[2]=lato2
        // Riorganizza per calcolaAngolo: p1=lato1, p2=vertice, p3=lato2
        const gradi = calcolaAngolo(pts[1], pts[0], pts[2]);
        const label = gradi.toFixed(1) + "\u00B0";
        const newId = "m_" + Date.now();
        // Salva come [lato1, vertice, lato2] per compatibilita con il disegno
        setMisure(prev => [...prev, { id: newId, tipo: "angolo", punti: [pts[1], pts[0], pts[2]], valore: gradi, label, colore: COLORS.angolo }]);
        setPuntiCorrente([]);
        setSelectedMisura(newId);
        setTool("select");
      }
      return;
    }
  }

  function hitTestMisura(pt) {
    const threshold = 30 / zoom;
    for (let i=misure.length-1; i>=0; i--) {
      const m = misure[i];
      // Hit su endpoint
      for (const p of m.punti) {
        if (distPx(pt,p) < threshold) return m.id;
      }
      // Hit su segmenti
      for (let j=0; j<m.punti.length-1; j++) {
        if (distPtSeg(pt, m.punti[j], m.punti[j+1]) < threshold) return m.id;
      }
    }
    return null;
  }

  // Conferma scala (nuova o modifica valore)
  function confermaScala() {
    if (!scalaVal || Number(scalaVal) <= 0) return;
    let valMetri = Number(scalaVal);
    if (scalaUnit === "cm") valMetri /= 100;
    // Usa puntiCorrente se disponibili, altrimenti quelli salvati
    const pts = puntiCorrente.length >= 2 ? [puntiCorrente[0], puntiCorrente[1]] : scalaPunti;
    if (pts.length < 2) return;
    const dist = distPx(pts[0], pts[1]);
    setScala(dist / valMetri);
    setScalaPunti(pts);
    setScalaMetri(valMetri);
    setPuntiCorrente([]);
    setShowScalaModal(false);
    setScalaVal("");
    showToast("Scala: " + valMetri + "m = " + dist.toFixed(0) + "px");
  }

  // Salva misura al libretto
  async function inviaMisura() {
    if (!selectedLav || !selectedMisura) return;
    const m = misure.find(mm => mm.id === selectedMisura);
    if (!m) return;
    setSending(true);
    try {
      const lavRef = doc(db,"projects",projectId,"lavorazioni",selectedLav);
      await updateDoc(lavRef, { misure: arrayUnion({
        desc: salvaDesc || m.label,
        b: m.valore,
        h: null,
        valore: m.valore,
        fonte: "misuratore_mobile",
        createdAt: new Date().toISOString()
      })});
      const lav = lavorazioni.find(l => l.id === selectedLav);
      showToast("Misura inviata a "+(lav?.nome || lav?.descrizione || selectedLav));
      setShowSalvaModal(false);
      setSalvaDesc("");
      setSelectedLav("");
    } catch (e) {
      console.error(e);
      alert("Errore nell'invio");
    }
    setSending(false);
  }

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  function eliminaSelezionata() {
    if (!selectedMisura) return;
    setMisure(prev => prev.filter(m => m.id !== selectedMisura));
    setSelectedMisura(null);
    showToast("Misura eliminata");
  }

  const toolBtns = [
    { id:"select",  icon:"\u261D",        label:"Seleziona", color:C.accent },
    { id:"scala",   icon:"\uD83D\uDCCF", label:"Scala",   color:COLORS.scala },
    { id:"linea",   icon:"\uD83D\uDCCF", label:"Linea",   color:COLORS.linea },
    { id:"angolo",  icon:"\uD83D\uDCD0", label:"Angolo",  color:COLORS.angolo },
    { id:"ocr",     icon:"\uD83D\uDD0D", label:"Leggi",   color:"#8B5CF6" },
    { id:"elimina", icon:"\uD83D\uDDD1", label:"Elimina", color:C.red },
    { id:"salva",   icon:"\uD83D\uDCBE", label:"Salva",   color:C.green },
  ];

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100dvh", background:C.bg, position:"fixed", inset:0, zIndex:400, overflow:"hidden", touchAction:"none" }}>
      {/* Header */}
      <div style={{ background:C.surface, borderBottom:`1px solid ${C.border}`, padding:"10px 12px", display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
        <button onClick={onBack} style={{ background:"none", border:"none", color:C.accent, fontSize:22, cursor:"pointer", padding:"4px 8px" }}>←</button>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontWeight:700, fontSize:14, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{projectName}</div>
          {fileName && <div style={{ fontSize:10, color:C.textMuted, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{fileName}</div>}
        </div>
        {scala > 0 && !scalaConfermata && (
          <div style={{ display:"flex", gap:4 }}>
            <button onClick={() => { setScalaVal(String(scalaMetri)); setShowScalaModal(true); }} style={{ fontSize:10, color:COLORS.scala, fontWeight:700, background:COLORS.scala+"15", border:"1px solid "+COLORS.scala+"40", borderRadius:6, padding:"4px 8px", cursor:"pointer", fontFamily:"Barlow" }}>{scalaMetri}m ✏️</button>
            <button onClick={() => { setScalaConfermata(true); showToast("Scala confermata: "+scalaMetri+"m"); }} style={{ fontSize:10, color:"#fff", fontWeight:700, background:C.green, border:"none", borderRadius:6, padding:"4px 10px", cursor:"pointer", fontFamily:"Barlow" }}>Accetta</button>
          </div>
        )}
        {scala > 0 && scalaConfermata && (
          <span style={{ fontSize:9, color:C.green, fontWeight:600 }}>✓ {scalaMetri}m</span>
        )}
      </div>

      {/* File buttons */}
      <div style={{ display:"flex", gap:8, padding:"8px 12px", background:C.surface, borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>
        <button onClick={() => setShowFiles(true)}
          style={{ flex:1, padding:"10px", fontSize:12, fontWeight:700, background:`${C.accent}15`, border:`1px solid ${C.accent}40`, borderRadius:10, color:C.accent, cursor:"pointer", fontFamily:"Barlow" }}>
          📁 Apri da cantiere
        </button>
        <label style={{ flex:1, padding:"10px", fontSize:12, fontWeight:700, background:`${C.green}15`, border:`1px solid ${C.green}40`, borderRadius:10, color:C.green, cursor:"pointer", fontFamily:"Barlow", textAlign:"center" }}>
          📷 Scatta foto
          <input type="file" accept="image/*" capture="environment" onChange={handleFileInput} style={{ display:"none" }} />
        </label>
      </div>

      {/* Canvas */}
      <div ref={containerRef} style={{ flex:1, position:"relative", overflow:"hidden" }}>
        <canvas ref={canvasRef}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          style={{ display:"block", touchAction:"none" }} />
        {!imageEl && (
          <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", color:C.textMuted, gap:12 }}>
            <div style={{ fontSize:48 }}>📐</div>
            <div style={{ fontSize:16, fontWeight:700, color:C.textDim }}>Apri un disegno</div>
            <div style={{ fontSize:12 }}>Carica da cantiere o scatta una foto</div>
          </div>
        )}

        {/* Info OCR */}
        {tool === "ocr" && !ocrLoading && (
          <div style={{ position:"absolute", top:12, left:"50%", transform:"translateX(-50%)", padding:"8px 16px", background:"rgba(139,92,246,0.85)", borderRadius:10, fontSize:12, fontWeight:700, color:"#fff", pointerEvents:"none" }}>
            Tocca una quota nel disegno per leggerla
          </div>
        )}
        {ocrLoading && (
          <div style={{ position:"absolute", top:12, left:"50%", transform:"translateX(-50%)", padding:"8px 16px", background:"rgba(0,0,0,0.75)", borderRadius:10, fontSize:12, fontWeight:700, color:"#fff", pointerEvents:"none" }}>
            Lettura in corso...
          </div>
        )}
        {/* Guida tool angolo */}
        {tool === "angolo" && puntiCorrente.length === 0 && (
          <div style={{ position:"absolute", top:12, left:"50%", transform:"translateX(-50%)", padding:"8px 16px", background:"rgba(226,75,74,0.85)", borderRadius:10, fontSize:12, fontWeight:700, color:"#fff", pointerEvents:"none" }}>
            Tap sul vertice dell'angolo
          </div>
        )}
        {/* Info punti in corso */}
        {puntiCorrente.length > 0 && (
          <div style={{ position:"absolute", top:12, left:"50%", transform:"translateX(-50%)", padding:"8px 16px", background:"rgba(0,0,0,0.75)", borderRadius:10, fontSize:13, fontWeight:700, color:"#fff", pointerEvents:"none" }}>
            {tool==="scala" && puntiCorrente.length===1 && "Tap il secondo punto della scala"}
            {tool==="linea" && puntiCorrente.length===1 && "Tap il secondo punto"}
            {tool==="angolo" && puntiCorrente.length===1 && "Tap il primo lato"}
            {tool==="angolo" && puntiCorrente.length===2 && "Tap il secondo lato"}
          </div>
        )}

        {/* Lente d'ingrandimento */}
        {magnifier && canvasRef.current && (() => {
          const canvas = canvasRef.current;
          const rect = canvas.getBoundingClientRect();
          const dpr = window.devicePixelRatio || 1;
          const sx = magnifier.x - rect.left;
          const sy = magnifier.y - rect.top;
          const lensSize = 120;
          const zoomFactor = 3;
          const srcSize = lensSize / zoomFactor;
          // Posizione lente: sopra il dito
          const lx = Math.max(lensSize/2, Math.min(rect.width - lensSize/2, sx));
          const ly = sy - 140;
          try {
            const ctx2 = canvas.getContext("2d");
            const imgData = ctx2.getImageData(
              Math.max(0, (sx - srcSize/2) * dpr),
              Math.max(0, (sy - srcSize/2) * dpr),
              srcSize * dpr, srcSize * dpr
            );
            const tc = document.createElement("canvas");
            tc.width = srcSize * dpr; tc.height = srcSize * dpr;
            tc.getContext("2d").putImageData(imgData, 0, 0);
            const lensUrl = tc.toDataURL();
            return (
              <div style={{ position:"absolute", left:lx - lensSize/2, top:Math.max(0, ly - lensSize/2), width:lensSize, height:lensSize, borderRadius:"50%", border:"3px solid #EF9F27", boxShadow:"0 4px 20px rgba(0,0,0,0.5)", overflow:"hidden", pointerEvents:"none", zIndex:10 }}>
                <img src={lensUrl} alt="" style={{ width:lensSize, height:lensSize, imageRendering:"pixelated" }} />
                {/* Croce centrale */}
                <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center", pointerEvents:"none" }}>
                  <div style={{ width:1, height:lensSize, background:"#EF9F2780", position:"absolute" }} />
                  <div style={{ height:1, width:lensSize, background:"#EF9F2780", position:"absolute" }} />
                </div>
              </div>
            );
          } catch { return null; }
        })()}

        {/* Toast */}
        {toast && (
          <div style={{ position:"absolute", bottom:80, left:"50%", transform:"translateX(-50%)", padding:"10px 20px", background:C.green, borderRadius:10, fontSize:13, fontWeight:700, color:"#fff", pointerEvents:"none", animation:"fadeUp .25s ease" }}>
            {toast}
          </div>
        )}
      </div>

      {/* Toolbar bottom */}
      <div style={{ display:"flex", height:64, background:C.surface, borderTop:`1px solid ${C.border}`, flexShrink:0 }}>
        {toolBtns.map(b => {
          const isActive = tool === b.id;
          const isDisabled = (b.id==="elimina" || b.id==="salva") && !selectedMisura;
          return (
            <button key={b.id}
              onClick={() => {
                if (b.id==="elimina") { eliminaSelezionata(); return; }
                if (b.id==="salva") {
                  if (!selectedMisura) return;
                  const m = misure.find(mm => mm.id===selectedMisura);
                  if (m) { setSalvaDesc(m.label); setShowSalvaModal(true); }
                  return;
                }
                // Scala: se gia confermata, riapri modifica
                if (b.id==="scala" && scalaConfermata) { setScalaConfermata(false); }
                setTool(b.id); setPuntiCorrente([]); setSelectedMisura(null);
              }}
              style={{
                flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:4,
                background: isActive ? `${b.color}20` : "transparent",
                border:"none", borderTop: isActive ? `2px solid ${b.color}` : "2px solid transparent",
                color: isDisabled ? C.textMuted : (isActive ? b.color : C.textDim),
                fontSize:10, fontWeight:700, cursor: isDisabled ? "default" : "pointer",
                opacity: isDisabled ? 0.4 : 1, fontFamily:"Barlow",
              }}>
              <span style={{ fontSize:22 }}>{b.icon}</span>
              {b.label}
            </button>
          );
        })}
      </div>

      {/* Modale file cantiere */}
      {showFiles && (
        <Modal title="File cantiere" onClose={() => setShowFiles(false)}>
          {files.length===0 && <Empty icon="📁" msg="Nessun file caricato" />}
          {files.map(f => {
            const ext = (f.nome||"").split(".").pop()?.toLowerCase()||"";
            const isDwg = ["dwg","dxf"].includes(ext);
            return (
              <div key={f.id} onClick={() => loadRemoteFile(f)}
                style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 14px", background:C.card, border:`1px solid ${C.border}`, borderRadius:10, marginBottom:8, cursor:"pointer" }}>
                <span style={{ fontSize:9, fontWeight:700, padding:"3px 6px", borderRadius:4, background: isDwg ? `${C.red}20` : `${C.accent}20`, color: isDwg ? C.red : C.accent }}>
                  {ext.toUpperCase()}
                </span>
                <div style={{ flex:1, fontSize:13, fontWeight:600, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{f.nome}</div>
                {isDwg && <span style={{ fontSize:10, color:C.red }}>No</span>}
              </div>
            );
          })}
          <div style={{ marginTop:12 }}>
            <label style={{ display:"block", padding:"12px", fontSize:13, fontWeight:700, background:`${C.accent}15`, border:`1px solid ${C.accent}40`, borderRadius:10, color:C.accent, cursor:"pointer", textAlign:"center" }}>
              📤 Carica file dal telefono
              <input type="file" accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff" onChange={e => { handleFileInput(e); setShowFiles(false); }} style={{ display:"none" }} />
            </label>
          </div>
        </Modal>
      )}

      {/* Modale scala */}
      {showScalaModal && (
        <Modal title="Imposta scala" onClose={() => { setShowScalaModal(false); setPuntiCorrente([]); }}>
          <div style={{ fontSize:13, color:C.textDim, marginBottom:16 }}>Inserisci la misura reale tra i due punti selezionati</div>
          <Inp placeholder="Es. 3.50" value={scalaVal} onChange={e => setScalaVal(e.target.value)} type="number" />
          <Sel value={scalaUnit} onChange={e => setScalaUnit(e.target.value)}>
            <option value="m">Metri</option>
            <option value="cm">Centimetri</option>
          </Sel>
          <Btn label="✓ Conferma scala" onClick={confermaScala} />
        </Modal>
      )}

      {/* Modale risultato OCR */}
      {showOcrResult && (
        <Modal title="Quota trovata" onClose={() => setShowOcrResult(null)}>
          <div style={{ textAlign:"center", marginBottom:16 }}>
            <div style={{ fontSize:36, fontWeight:800, color:C.accent, fontFamily:"Barlow Condensed" }}>{showOcrResult.valore}</div>
            <div style={{ fontSize:12, color:C.textMuted, marginTop:4 }}>Valore letto dal disegno</div>
          </div>
          <Btn label="Usa come scala (metri)" onClick={() => {
            if (puntiCorrente.length === 2) {
              const dist = distPx(puntiCorrente[0], puntiCorrente[1]);
              setScala(dist / showOcrResult.valore);
              setPuntiCorrente([]);
              showToast("Scala impostata: 1m = " + (dist / showOcrResult.valore).toFixed(0) + "px");
            } else {
              showToast("Prima seleziona 2 punti con lo strumento Scala, poi usa Leggi");
            }
            setShowOcrResult(null);
          }} />
          <Btn label="Annulla" variant="secondary" onClick={() => setShowOcrResult(null)} />
        </Modal>
      )}

      {/* Modale salva misura */}
      {showSalvaModal && (
        <Modal title="Invia misura al libretto" onClose={() => setShowSalvaModal(false)}>
          {(() => {
            const m = misure.find(mm => mm.id === selectedMisura);
            return (
              <>
                <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:10, padding:"14px 16px", marginBottom:16, textAlign:"center" }}>
                  <div style={{ fontSize:10, color:C.textMuted, marginBottom:4 }}>Misura</div>
                  <div style={{ fontSize:24, fontWeight:800, color:C.accent, fontFamily:"Barlow Condensed" }}>{m?.label || "—"}</div>
                </div>
                <Sel value={selectedLav} onChange={e => setSelectedLav(e.target.value)}>
                  <option value="">Seleziona lavorazione...</option>
                  {lavorazioni.map(l => <option key={l.id} value={l.id}>{l.nome || l.descrizione || l.id}</option>)}
                </Sel>
                <Inp placeholder="Descrizione (es. Lunghezza parete nord)" value={salvaDesc} onChange={e => setSalvaDesc(e.target.value)} />
                <Btn label={sending ? "Invio..." : "📤 Invia al libretto"} onClick={inviaMisura} disabled={sending || !selectedLav} />
              </>
            );
          })()}
        </Modal>
      )}
    </div>
  );
}

// ── Helper cantiere: formattazione unificata ────────────────────
function formatCommittente(project) {
  if (!project) return "";
  const n = project.clientName || "";
  const c = project.clientSurname || "";
  return [n, c].filter(Boolean).join(" ").trim();
}

function formatIndirizzo(project) {
  if (!project) return "";
  const via = project.indirizzo || "";
  const citta = [project.cap, project.comune, project.provincia ? `(${project.provincia})` : ""].filter(Boolean).join(" ").trim();
  return [via, citta].filter(Boolean).join(" · ").trim();
}

function formatNomeCantiere(project) {
  if (!project) return "Cantiere";
  return project.name || project.clientName || "Cantiere";
}

// Intento deep-link Klod: se l'URL ha ?s=klod lo memorizza in sessionStorage
// (persiste attraverso login/reload che rimuovono la query); resta true finché
// non viene consumato. Tutto in try/catch → false in caso di ambienti limitati.
function wantsKlodDeepLink() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("s") === "klod") {
      sessionStorage.setItem("klodDeepLink", "1");
      return true;
    }
    return sessionStorage.getItem("klodDeepLink") === "1";
  } catch {
    return false;
  }
}

export default function App() {
  const { C } = useTheme();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState(() => wantsKlodDeepLink() ? "klod" : "dashboard");
  const [altroOpen, setAltroOpen] = useState(false);
  const [appuntiCantiere, setAppuntiCantiere] = useState(null);
  const [misuratoreProgetto, setMisuratoreProgetto] = useState(null);
  const [stats, setStats] = useState({ cantieri:0, operai:0, ferie:0, rap:0 });

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fu) => {
      if (fu) {
        const userData = await findUserDoc(fu.uid);
        if (userData) {
          const u = { uid: fu.uid, ...userData, ruolo: getRuolo(userData), mansione: userData.ruolo };
          setUser(u);
          setSection(u.ruolo==="operaio"?"personale":"dashboard");
          // Init notifiche push
          try {
            if ("Notification" in window && Notification.permission !== "denied") {
              import("firebase/messaging").then(async ({ getMessaging, getToken }) => {
                try {
                  const perm = await Notification.requestPermission();
                  if (perm !== "granted") return;
                  const messaging = getMessaging();
                  const token = await getToken(messaging, { vapidKey: process.env.REACT_APP_FCM_VAPID_KEY });
                  if (token) await updateDoc(doc(db,"utenti", userData.id), { fcmToken: token });
                } catch(e) { console.log("FCM non disponibile:", e.message); }
              }).catch(() => {});
            }
          } catch(e) { console.log("Notifiche non disponibili"); }
        }
      } else setUser(null);
      setLoading(false);
    });
    return unsub;
  }, []);

  // Deep-link Klod resistente a login/reload: quando l'utente è pronto, vince
  // sul reset della section fatto dal flusso auth, poi CONSUMA l'intento
  // (rimuove il flag + toglie ?s=klod dall'URL) → vale una volta per lancio.
  useEffect(() => {
    if (!user) return;
    if (!wantsKlodDeepLink()) return;
    setSection("klod");
    try {
      sessionStorage.removeItem("klodDeepLink");
      const url = new URL(window.location.href);
      url.searchParams.delete("s");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    } catch {}
  }, [user]);

  useEffect(() => {
    if (!user) return;
    Promise.all([
      getDocs(query(collection(db,"projects"),where("status","in",["active","draft"]))),
      getDocs(collection(db,"utenti")),
      getDocs(query(collection(db,"richieste_assenza"),where("stato","==","in_attesa"))),
      getDocs(query(collection(db,"timesheets"),where("status","==","submitted"))),
    ]).then(([c,o,f,r]) => setStats({
      cantieri: c.size,
      operai: o.docs.filter(d => ["operaio","worker"].includes(d.data().ruolo||d.data().ruoloApp||"")).length,
      ferie: f.size,
      rap: r.size
    }));
  }, [user]);

  const globalCss = buildGlobalCss(C);

  if (loading) return (
    <>
      <style>{globalCss}</style>
      <SplashScreen />
    </>
  );

  if (!user) return <LoginScreen onLogin={u=>{ setUser(u); setSection(u.ruolo==="operaio"?"personale":"dashboard"); }} />;

  if (user.mustChangePassword) return (
    <>
      <style>{globalCss}</style>
      <CambioPasswordObbligatorio user={user} onDone={() => setUser({...user, mustChangePassword: false})} />
    </>
  );

  const isOp = user.ruolo === "operaio";
  const navAll = isOp ? [
    { id:"cantieri",   icon:HardHat,        label:"Cantieri" },
    { id:"personale",  icon:User,            label:"Personale" },
    { id:"chat",       icon:MessageCircle,   label:"Chat" },
    { id:"altro",      icon:MenuIcon,        label:"Altro" },
  ] : [
    { id:"dashboard",  icon:Home,            label:"Home" },
    { id:"cantieri",   icon:HardHat,         label:"Cantieri" },
    { id:"chat",       icon:MessageCircle,   label:"Chat" },
    { id:"personale",  icon:User,            label:"Personale" },
    { id:"altro",      icon:MenuIcon,        label:"Altro" },
  ];
  const navItems = navAll;

  const altroItems = [
    ...(isOp ? [
      { id:"procedure",      icon:ClipboardList, label:"Manuale lavorazioni" },
      { id:"misuratore_hub", icon:Ruler,          label:"Misuratore" },
      { id:"appunti_hub",    icon:Camera,         label:"Appunti cantiere" },
      { id:"regolamento",    icon:FileText,        label:"Regolamento" },
    ] : [
      { id:"cronoprogramma", icon:Calendar,       label:"Cronoprogramma" },
      { id:"procedure",      icon:ClipboardList,  label:"Manuale lavorazioni" },
      { id:"appunti_hub",    icon:Camera,          label:"Appunti cantiere" },
      { id:"misuratore_hub", icon:Ruler,           label:"Misuratore" },
      { id:"regolamento",    icon:FileText,         label:"Regolamento" },
    ]),
    ...(user.ruolo === "admin" ? [{ id:"klod", icon:Mic, label:"Klod" }] : []),
    ...(isManager(user.ruolo)?[{ id:"gestione", icon:Settings, label:"Gestione" }]:[]),
    { id:"impostazioni", icon:Settings, label:"Impostazioni" },
  ];

  const titles = { dashboard:"Dashboard", cantieri:"Cantieri", chat:"Chat", personale:"Area Personale", cronoprogramma:"Cronoprogramma", procedure:"Procedure", regolamento:"Regolamento", gestione:"Gestione", appunti_hub:"Appunti cantiere", misuratore_hub:"Misuratore", klod:"Klod", impostazioni:"Impostazioni" };

  return (
    <div style={{ height:"100dvh", width:"100%", background:C.bg, color:C.text, fontFamily:"Barlow,sans-serif", maxWidth:480, margin:"0 auto", display:"flex", flexDirection:"column", overflow:"hidden", position:"relative" }}>
      <style>{globalCss}</style>

      {/* Header */}
      <div style={{ background:C.surface, borderBottom:`1px solid ${C.border}`, padding:"12px 16px", position:"sticky", top:0, zIndex:100, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:34, height:34, borderRadius:9, background:`linear-gradient(135deg,${C.blue},${C.accent})`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:18 }}>🏗</div>
          <div>
            <div style={{ fontFamily:"Barlow Condensed", fontWeight:800, fontSize:17, lineHeight:1, letterSpacing:1 }}>EDIL BLU</div>
            <div style={{ fontSize:9, color:C.accent, letterSpacing:1.5, textTransform:"uppercase" }}>{titles[section]||""}</div>
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <NotificheCampana user={user} />
          <Avatar name={user.nome} role={user.ruolo} size={32} />
          <button onClick={()=>signOut(auth)} style={{ background:"none", border:"none", color:C.textMuted, fontSize:18, cursor:"pointer", minWidth:44, minHeight:44, display:"flex", alignItems:"center", justifyContent:"center" }}>⏏</button>
        </div>
      </div>

      {/* Sections */}
      {section==="dashboard"      && <Dashboard user={user} stats={stats} onSection={setSection} />}
      {section==="cantieri"       && <Cantieri user={user} />}
      {section==="chat"           && <Chat user={user} />}
      {section==="personale"      && <AreaPersonale user={user} onSection={setSection} />}
      {section==="cronoprogramma" && <Cronoprogramma />}
      {section==="procedure"      && <Procedure user={user} />}
      {section==="regolamento"    && <Regolamento user={user} />}
      {section==="gestione"       && <Gestione user={user} />}
      {section==="appunti_hub"    && !appuntiCantiere && <AppuntiHub user={user} onSelect={c => setAppuntiCantiere(c)} />}
      {section==="appunti_hub"    && appuntiCantiere && <AppuntiCantiere user={user} projectId={appuntiCantiere.id} projectName={appuntiCantiere.clientName||appuntiCantiere.name} onBack={() => setAppuntiCantiere(null)} />}
      {section==="misuratore_hub" && !misuratoreProgetto && <MisuratoreHub user={user} onSelect={p => setMisuratoreProgetto(p)} />}
      {section==="misuratore_hub" && misuratoreProgetto && <MisuratoreDisegno user={user} projectId={misuratoreProgetto.id} projectName={misuratoreProgetto.clientName||misuratoreProgetto.name} onBack={() => setMisuratoreProgetto(null)} />}
      {section==="klod"           && <RecorderKlod user={user} />}
      {section==="impostazioni"  && <Impostazioni user={user} />}

      {/* Menu Altro — Bottom Sheet */}
      {altroOpen && (
        <div style={{ position:"fixed", inset:0, zIndex:300, background:"rgba(0,0,0,0.5)", backdropFilter:"blur(3px)" }} onClick={()=>setAltroOpen(false)}>
          <div style={{ position:"absolute", bottom:0, left:0, right:0, background:C.surface, borderTopLeftRadius:20, borderTopRightRadius:20, padding:"12px 16px calc(24px + env(safe-area-inset-bottom))", maxWidth:480, margin:"0 auto", animation:"slideUp 0.25s ease" }} onClick={e=>e.stopPropagation()}>
            <div style={{ width:40, height:4, background:C.border, borderRadius:2, margin:"0 auto 16px" }} />
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
              {altroItems.map(item => {
                const IconComp = item.icon;
                return (
                  <button key={item.id} onClick={()=>{ setSection(item.id); setAltroOpen(false); }}
                    style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:8, padding:"18px 12px", background:`${C.mid}30`, border:`1px solid ${C.border}`, color:C.text, fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"Barlow", borderRadius:14, transition:"all 0.15s" }}>
                    <IconComp size={26} strokeWidth={1.7} color={C.accent} />
                    {item.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Bottom Nav */}
      <nav style={{ position:"fixed", bottom:0, left:"50%", transform:"translateX(-50%)", width:"100%", maxWidth:480, background:C.surface, borderTop:`1px solid ${C.border}`, display:"flex", zIndex:200, paddingBottom:"env(safe-area-inset-bottom)", boxShadow:"0 -2px 20px rgba(0,0,0,0.1)" }}>
        {navItems.map(n => {
          const active = n.id==="altro" ? altroItems.map(i=>i.id).includes(section) : section===n.id;
          const IconComp = n.icon;
          return (
            <button key={n.id} onClick={()=>n.id==="altro"?setAltroOpen(!altroOpen):(setSection(n.id),setAppuntiCantiere(null),setMisuratoreProgetto(null))}
              style={{ flex:1, padding:"10px 0 8px", background:"none", border:"none", color:active?C.accent:C.textMuted, fontSize:10, fontWeight:active?700:500, cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:4, fontFamily:"Barlow", transition:"color 0.15s", position:"relative" }}>
              {active && <div style={{ position:"absolute", top:0, left:"50%", transform:"translateX(-50%)", width:36, height:3, background:C.accent, borderRadius:"0 0 3px 3px" }} />}
              <IconComp size={22} strokeWidth={active?2.2:1.8} />
              {n.label}
            </button>
          );
        })}
      </nav>
      <InstallAppBanner />
    </div>
  );
}
