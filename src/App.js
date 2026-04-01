import { useState, useEffect, useRef, useCallback } from "react";
import { auth, db, storage } from "./firebase";
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
} from "firebase/auth";
import {
  collection, doc, getDoc, getDocs, addDoc, updateDoc, setDoc,
  query, where, orderBy, onSnapshot, serverTimestamp,
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";

// ─── DESIGN SYSTEM ────────────────────────────────────────────────────────────
const C = {
  bg:           "#070f1e",
  surface:      "#0d1f3c",
  card:         "#112244",
  border:       "#1e3a6a",
  borderLight:  "#2a5090",
  mid:          "#1a3a6b",
  blue:         "#1d5fa8",
  bright:       "#2d7dd2",
  accent:       "#4facde",
  accentDim:    "rgba(79,172,222,0.15)",
  gold:         "#f0a500",
  goldDim:      "rgba(240,165,0,0.15)",
  green:        "#22c98a",
  greenDim:     "rgba(34,201,138,0.12)",
  red:          "#e05470",
  redDim:       "rgba(224,84,112,0.12)",
  text:         "#e8f0fe",
  textDim:      "#8baac8",
  textMuted:    "#4a6a8a",
};

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

// ─── COMPONENTI BASE ──────────────────────────────────────────────────────────
const globalCss = `
  @import url('https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700;800&family=Barlow+Condensed:wght@600;700;800&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:${C.bg};font-family:'Barlow',sans-serif}
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
`;

function Avatar({ name, role, size = 36 }) {
  const r = ROLES[role] || ROLES.operaio;
  const initials = (name || "?").split(" ").map(w => w[0]).join("").slice(0,2).toUpperCase();
  return (
    <div style={{ width:size, height:size, borderRadius:"50%", background:`${r.color}20`, border:`2px solid ${r.color}60`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:size*0.33, fontWeight:700, color:r.color, flexShrink:0, fontFamily:"Barlow Condensed,sans-serif" }}>
      {initials}
    </div>
  );
}

function RoleBadge({ role }) {
  const r = ROLES[role] || ROLES.operaio;
  return <span style={{ background:`${r.color}18`, color:r.color, border:`1px solid ${r.color}40`, borderRadius:4, padding:"2px 8px", fontSize:10, fontWeight:700 }}>{r.label}</span>;
}

function Card({ children, style={}, onClick }) {
  return <div onClick={onClick} style={{ background:C.card, borderRadius:12, border:`1px solid ${C.border}`, padding:16, marginBottom:10, cursor:onClick?"pointer":"default", ...style }}>{children}</div>;
}

function Inp({ placeholder, value, onChange, type="text", style={} }) {
  return <input type={type} placeholder={placeholder} value={value} onChange={onChange}
    style={{ width:"100%", background:`${C.mid}40`, border:`1px solid ${C.border}`, borderRadius:8, color:C.text, padding:"10px 14px", fontSize:14, outline:"none", fontFamily:"Barlow,sans-serif", marginBottom:10, ...style }} />;
}

function Txta({ placeholder, value, onChange, rows=3 }) {
  return <textarea placeholder={placeholder} value={value} onChange={onChange} rows={rows}
    style={{ width:"100%", background:`${C.mid}40`, border:`1px solid ${C.border}`, borderRadius:8, color:C.text, padding:"10px 14px", fontSize:14, outline:"none", fontFamily:"Barlow,sans-serif", marginBottom:10, resize:"vertical" }} />;
}

function Sel({ value, onChange, children }) {
  return <select value={value} onChange={onChange}
    style={{ width:"100%", background:C.card, border:`1px solid ${C.border}`, borderRadius:8, color:C.text, padding:"10px 14px", fontSize:14, outline:"none", fontFamily:"Barlow,sans-serif", marginBottom:10, appearance:"none" }}>
    {children}
  </select>;
}

function Btn({ label, onClick, variant="primary", small, icon, disabled }) {
  const v = {
    primary:   { background:`linear-gradient(135deg,${C.blue},${C.bright})`, color:"#fff", border:"none" },
    secondary: { background:"transparent", color:C.text, border:`1px solid ${C.border}` },
    danger:    { background:C.redDim, color:C.red, border:`1px solid ${C.red}40` },
    ghost:     { background:C.accentDim, color:C.accent, border:`1px solid ${C.accent}40` },
  };
  return <button onClick={onClick} disabled={disabled}
    style={{ ...v[variant], borderRadius:8, padding:small?"6px 12px":"11px 18px", fontSize:small?12:14, fontWeight:700, cursor:disabled?"default":"pointer", fontFamily:"Barlow,sans-serif", marginBottom:small?0:8, width:small?"auto":"100%", opacity:disabled?.5:1, display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}>
    {icon && <span style={{ fontSize:small?12:16 }}>{icon}</span>}{label}
  </button>;
}

function Modal({ title, onClose, children }) {
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.75)", zIndex:500, display:"flex", alignItems:"flex-end", justifyContent:"center" }} onClick={onClose}>
      <div className="fu" style={{ background:C.surface, borderRadius:"16px 16px 0 0", border:`1px solid ${C.border}`, borderBottom:"none", padding:24, width:"100%", maxWidth:480, maxHeight:"88vh", overflowY:"auto" }} onClick={e => e.stopPropagation()}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <div style={{ fontWeight:800, fontSize:17, fontFamily:"Barlow Condensed" }}>{title}</div>
          <button onClick={onClose} style={{ background:"none", border:"none", color:C.textMuted, fontSize:22, cursor:"pointer" }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ProgressBar({ pct }) {
  const col = pct>=80?C.green:pct>=50?C.accent:pct>=25?C.gold:C.red;
  return (
    <div style={{ height:5, borderRadius:3, background:`${C.border}80`, overflow:"hidden", marginTop:8 }}>
      <div style={{ height:"100%", width:`${Math.min(pct||0,100)}%`, background:col, borderRadius:3, transition:"width .6s" }} />
    </div>
  );
}

function SecTitle({ label }) {
  return <div style={{ fontSize:10, fontWeight:800, color:C.textMuted, letterSpacing:2, textTransform:"uppercase", marginBottom:12, marginTop:4 }}>{label}</div>;
}

function Empty({ icon, msg }) {
  return <div style={{ textAlign:"center", padding:"48px 0", color:C.textMuted }}><div style={{ fontSize:40, marginBottom:12 }}>{icon}</div><div style={{ fontSize:14 }}>{msg}</div></div>;
}

// ─── SPLASH SCREEN ────────────────────────────────────────────────────────────
function SplashScreen() {
  return (
    <div style={{ position:"fixed", inset:0, background:C.bg, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", zIndex:9999 }}>
      <div className="splash-logo" style={{ textAlign:"center" }}>
        <div style={{ width:100, height:100, borderRadius:28, background:`linear-gradient(135deg,${C.blue},${C.accent})`, margin:"0 auto 20px", display:"flex", alignItems:"center", justifyContent:"center", boxShadow:`0 12px 48px ${C.blue}80`, fontSize:52 }}>🏗</div>
        <div style={{ fontFamily:"Barlow Condensed", fontWeight:800, fontSize:42, color:C.text, letterSpacing:3 }}>EDIL BLU</div>
        <div style={{ fontSize:11, color:C.accent, letterSpacing:4, textTransform:"uppercase", marginTop:6 }}>Gestionale Aziendale</div>
      </div>
      <div style={{ marginTop:48, display:"flex", gap:6 }}>
        {[0,1,2].map(i => (
          <div key={i} style={{ width:6, height:6, borderRadius:"50%", background:C.accent, opacity:0.3, animation:`pulse 1.2s ease ${i*0.2}s infinite` }} />
        ))}
      </div>
    </div>
  );
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
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
      const snap = await getDoc(doc(db, "utenti", cred.user.uid));
      if (snap.exists()) {
        if (ricordami) {
          localStorage.setItem("eb_email", email);
          localStorage.setItem("eb_pw", pw);
        } else {
          localStorage.removeItem("eb_email");
          localStorage.removeItem("eb_pw");
        }
        const raw = { uid: cred.user.uid, ...snap.data() };
        onLogin({ ...raw, ruolo: getRuolo(raw) });
      } else setErr("Utente non trovato nel sistema.");
    } catch { setErr("Email o password non corretti."); }
    setLoading(false);
  };

  return (
    <div style={{ minHeight:"100vh", background:`radial-gradient(ellipse at 30% 20%,${C.mid}40 0%,${C.bg} 60%)`, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:24 }}>
      {/* Logo */}
      <div style={{ textAlign:"center", marginBottom:40 }}>
        <div style={{ width:84, height:84, borderRadius:24, background:`linear-gradient(135deg,${C.blue},${C.accent})`, margin:"0 auto 18px", display:"flex", alignItems:"center", justifyContent:"center", boxShadow:`0 10px 40px ${C.blue}70`, fontSize:44 }}>🏗</div>
        <div style={{ fontFamily:"Barlow Condensed", fontWeight:800, fontSize:38, color:C.text, letterSpacing:2 }}>EDIL BLU</div>
        <div style={{ fontSize:10, color:C.accent, letterSpacing:4, textTransform:"uppercase", marginTop:5 }}>Gestionale Aziendale</div>
      </div>

      {/* Card login */}
      <div style={{ width:"100%", maxWidth:360, background:`${C.card}e0`, border:`1px solid ${C.borderLight}`, borderRadius:20, padding:28, backdropFilter:"blur(12px)" }}>
        <div style={{ marginBottom:20 }}>
          <div style={{ fontSize:10, color:C.textMuted, fontWeight:700, letterSpacing:1.5, marginBottom:8 }}>EMAIL</div>
          <div style={{ position:"relative" }}>
            <input type="email" placeholder="nome@edilblu.it" value={email} onChange={e=>setEmail(e.target.value)}
              onKeyDown={e=>e.key==="Enter"&&login()}
              style={{ width:"100%", background:`${C.mid}30`, border:`1px solid ${C.border}`, borderRadius:10, color:C.text, padding:"12px 14px", fontSize:14, outline:"none", fontFamily:"Barlow,sans-serif" }} />
          </div>
        </div>
        <div style={{ marginBottom:20 }}>
          <div style={{ fontSize:10, color:C.textMuted, fontWeight:700, letterSpacing:1.5, marginBottom:8 }}>PASSWORD</div>
          <div style={{ position:"relative" }}>
            <input type={showPw?"text":"password"} placeholder="••••••••" value={pw} onChange={e=>setPw(e.target.value)}
              onKeyDown={e=>e.key==="Enter"&&login()}
              style={{ width:"100%", background:`${C.mid}30`, border:`1px solid ${C.border}`, borderRadius:10, color:C.text, padding:"12px 44px 12px 14px", fontSize:14, outline:"none", fontFamily:"Barlow,sans-serif" }} />
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
  const [ferieAlert, setFerieAlert] = useState([]);
  const [rapAlert, setRapAlert] = useState([]);
  const [showRapForm, setShowRapForm] = useState(false);

  const oggi = new Date().toLocaleDateString("it-IT", { weekday:"long", day:"numeric", month:"long" });
  const ora = new Date().getHours();
  const saluto = ora < 12 ? "Buongiorno" : ora < 18 ? "Buon pomeriggio" : "Buonasera";

  useEffect(() => {
    if (isManager(user.ruolo)) {
      getDocs(query(collection(db,"ferie"),where("stato","==","in attesa")))
        .then(s=>setFerieAlert(s.docs.map(d=>({id:d.id,...d.data()}))));
    }
    if (canEdit(user.ruolo)) {
      const ieri = new Date(); ieri.setDate(ieri.getDate()-1);
      getDocs(query(collection(db,"timesheets"),where("date",">=",ieri)))
        .then(s=>setRapAlert(s.docs.map(d=>({id:d.id,...d.data()}))));
    }
  }, [user.ruolo]);

  // Path SVG per icone
  const P = {
    rapportino: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></>,
    cantiere:   <><rect x="3" y="9" width="18" height="12" rx="1"/><path d="M9 9V6a3 3 0 0 1 6 0v3"/><line x1="12" y1="13" x2="12" y2="17"/></>,
    calendario: <><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/></>,
    ferie:      <><path d="M17.8 19.2L16 11l3.5-3.5C21 6 21 4 19 4c-2 0-4 2-4 4l-3.5 3.5L4 9.2c-.5-.2-1 .1-1 .7v1.1c0 .4.2.8.5 1l5.5 3.2L7 18l-2 1 1 2 2-1 1-2 3.2 5.5c.2.3.6.5 1 .5h1.1c.6 0 .9-.5.7-1z"/></>,
    gestione:   <><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></>,
    crono:      <><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></>,
    utenti:     <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></>,
  };

  // Azioni rapide per operaio
  const azioniOperaio = [
    { path:P.rapportino, label:"Rapportino", color:C.accent,  action:()=>setShowRapForm(true) },
    { path:P.cantiere,   label:"Cantieri",   color:"#38bdf8", action:()=>onSection("cantieri") },
    { path:P.calendario, label:"Programma",  color:C.green,   action:()=>onSection("personale") },
    { path:P.ferie,      label:"Ferie",      color:"#a78bfa", action:()=>onSection("personale") },
  ];

  // Azioni rapide per manager
  const azioniManager = [
    { path:P.cantiere,   label:"Cantieri",   color:"#38bdf8", action:()=>onSection("cantieri") },
    { path:P.rapportino, label:"Rapportini", color:C.accent,  action:()=>onSection("gestione") },
    { path:P.crono,      label:"Crono",      color:C.green,   action:()=>onSection("cronoprogramma") },
    { path:P.gestione,   label:"Gestione",   color:C.gold,    action:()=>onSection("gestione") },
  ];

  const azioni = user.ruolo==="operaio" ? azioniOperaio : azioniManager;

  return (
    <div style={{ paddingBottom:80 }} className="fu">
      {/* Header hero */}
      <div style={{ background:`linear-gradient(160deg,${C.mid} 0%,${C.blue}80 60%,${C.bright}30 100%)`, padding:"28px 20px 24px", position:"relative", overflow:"hidden" }}>
        <div style={{ position:"absolute", top:-20, right:-20, width:140, height:140, borderRadius:"50%", background:`${C.accent}15`, pointerEvents:"none" }} />
        <div style={{ position:"absolute", bottom:-30, right:30, width:80, height:80, borderRadius:"50%", background:`${C.bright}20`, pointerEvents:"none" }} />
        <div style={{ fontSize:12, color:"#a8d4f0", marginBottom:6, textTransform:"capitalize" }}>{saluto},</div>
        <div style={{ fontFamily:"Barlow Condensed", fontWeight:800, fontSize:30, color:C.text, marginBottom:6 }}>{user.nome} {user.cognome||""}</div>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <RoleBadge role={user.ruolo} />
          <span style={{ fontSize:11, color:"#a8d4f0cc" }}>· {oggi}</span>
        </div>
      </div>

      <div style={{ padding:"20px 16px" }}>
        {/* Alert ferie */}
        {isManager(user.ruolo) && ferieAlert.length > 0 && (
          <div onClick={()=>onSection("gestione")} style={{ background:`linear-gradient(135deg,${C.goldDim},rgba(240,165,0,.08))`, border:`1px solid ${C.gold}40`, borderRadius:14, padding:"14px 16px", marginBottom:12, cursor:"pointer", display:"flex", alignItems:"center", gap:12 }}>
            <div style={{ width:40, height:40, borderRadius:12, background:C.goldDim, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, flexShrink:0 }}>✈</div>
            <div style={{ flex:1 }}>
              <div style={{ fontWeight:700, fontSize:13, color:C.gold }}>Ferie in attesa di approvazione</div>
              <div style={{ fontSize:12, color:C.textDim, marginTop:2 }}>{ferieAlert.map(f=>f.nomeUtente).join(", ")}</div>
            </div>
            <div style={{ background:C.gold, color:"#000", borderRadius:20, padding:"2px 10px", fontSize:12, fontWeight:800 }}>{ferieAlert.length}</div>
          </div>
        )}

        {/* Alert rapportini */}
        {canEdit(user.ruolo) && rapAlert.length > 0 && (
          <div onClick={()=>onSection("gestione")} style={{ background:C.accentDim, border:`1px solid ${C.accent}40`, borderRadius:14, padding:"14px 16px", marginBottom:12, cursor:"pointer", display:"flex", alignItems:"center", gap:12 }}>
            <div style={{ width:40, height:40, borderRadius:12, background:`${C.accent}20`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, flexShrink:0 }}>📋</div>
            <div style={{ flex:1 }}>
              <div style={{ fontWeight:700, fontSize:13, color:C.accent }}>Nuovi rapportini</div>
              <div style={{ fontSize:12, color:C.textDim, marginTop:2 }}>{rapAlert.length} nelle ultime 24 ore</div>
            </div>
            <div style={{ background:C.accent, color:"#000", borderRadius:20, padding:"2px 10px", fontSize:12, fontWeight:800 }}>{rapAlert.length}</div>
          </div>
        )}

        {/* Azioni rapide */}
        <div style={{ fontSize:10, fontWeight:800, color:C.textMuted, letterSpacing:2, textTransform:"uppercase", marginBottom:14 }}>Accesso Rapido</div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:8, marginBottom:24 }}>
          {azioni.map(a => (
            <button key={a.label} onClick={a.action}
              style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:14, padding:"16px 8px 12px", cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:10, WebkitTapHighlightColor:"transparent" }}
              onTouchStart={e=>e.currentTarget.style.background=`${a.color}15`}
              onTouchEnd={e=>e.currentTarget.style.background=C.card}>
              <div style={{ width:48, height:48, borderRadius:14, background:`${a.color}18`, display:"flex", alignItems:"center", justifyContent:"center" }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={a.color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  {a.path}
                </svg>
              </div>
              <div style={{ fontSize:10, fontWeight:700, color:C.textDim, textAlign:"center", lineHeight:1.3, fontFamily:"Barlow,sans-serif" }}>{a.label}</div>
            </button>
          ))}
        </div>

        {/* Stats */}
        {!["operaio"].includes(user.ruolo) && (
          <>
            <div style={{ fontSize:10, fontWeight:800, color:C.textMuted, letterSpacing:2, textTransform:"uppercase", marginBottom:12 }}>Riepilogo</div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              {[
                { l:"Cantieri", v:stats.cantieri, i:"🏗", c:C.accent },
                { l:"Operai",   v:stats.operai,   i:"👷", c:C.green  },
                { l:"Ferie",    v:stats.ferie,    i:"✈",  c:C.gold   },
                { l:"Rapportini",v:stats.rap,     i:"📋", c:"#38bdf8"},
              ].map(s => (
                <div key={s.l} style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, padding:"14px 16px", display:"flex", alignItems:"center", gap:12 }}>
                  <div style={{ fontSize:24 }}>{s.i}</div>
                  <div>
                    <div style={{ fontFamily:"Barlow Condensed", fontWeight:800, fontSize:26, color:s.c, lineHeight:1 }}>{s.v}</div>
                    <div style={{ fontSize:11, color:C.textMuted, marginTop:2 }}>{s.l}</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {showRapForm && <FormRapportino user={user} onSaved={()=>{}} onClose={()=>setShowRapForm(false)} />}
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
  const canMod = canEdit(user.ruolo);

  useEffect(() => {
    const unsub = onSnapshot(query(collection(db,"projects"),orderBy("name")), s =>
      setList(s.docs.map(d=>({id:d.id,...d.data()})))
    );
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

  const STATUS_COLOR = { active:C.green, draft:C.gold, suspended:C.gold, completed:C.textMuted, cancelled:C.red };
  const STATUS_LABEL = { active:"Attivo", draft:"Bozza", suspended:"Sospeso", completed:"Completato", cancelled:"Annullato" };

  const mapsUrl = (address) => address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : null;

  if (sel) {
    const tabsCantiere = ["anagrafica","contatti","lavorazioni","appunti","disegni"];
    const disFiltrati = disegni.filter(d => d.categoria === disTab);
    return (
      <div style={{ paddingBottom:80 }} className="fu">
        {/* Header */}
        <div style={{ background:`linear-gradient(135deg,${C.mid},${C.blue}40)`, padding:"16px 16px 0", borderBottom:`1px solid ${C.border}` }}>
          <button onClick={()=>setSel(null)} style={{ background:"none", border:"none", color:C.accent, fontSize:13, cursor:"pointer", fontFamily:"Barlow", marginBottom:8 }}>← Cantieri</button>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:4 }}>
            <div style={{ flex:1 }}>
              {sel.code && <div style={{ fontSize:10, color:C.accent, fontWeight:700, letterSpacing:1, marginBottom:4 }}>{sel.code}</div>}
              <div style={{ fontFamily:"Barlow Condensed", fontWeight:800, fontSize:22 }}>{sel.name}</div>
              <div style={{ fontSize:13, color:C.textDim, marginTop:2 }}>{sel.clientName}</div>
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
                  {l:"Committente", v:sel.clientName},
                  {l:"P.IVA Cliente", v:sel.clientVatNumber},

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
              {disFiltrati.length===0 ? <Empty icon="📐" msg={`Nessun file ${disTab}`} /> : disFiltrati.map(d=>(
                <Card key={d.id}>
                  <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                    <span style={{ fontSize:26 }}>{d.nome.match(/\.(png|jpg|jpeg)$/i)?"🖼":"📄"}</span>
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:13, fontWeight:600 }}>{d.nome}</div>
                      <div style={{ fontSize:11, color:C.textMuted }}>di {d.uploadedBy}</div>
                    </div>
                    <a href={d.url} target="_blank" rel="noreferrer" style={{ color:C.accent, fontSize:22, textDecoration:"none" }}>↗</a>
                  </div>
                </Card>
              ))}
            </>
          )}
        </div>
      </div>
    );
  }

  // Lista cantieri
  return (
    <div style={{ padding:"16px 16px 80px" }} className="fu">
      <SecTitle label={`${list.length} commesse`} />
      {list.length===0 && <Empty icon="🏗" msg="Nessuna commessa ancora" />}
      {list.map(c => (
        <Card key={c.id} onClick={()=>{ setSel(c); setTab("anagrafica"); }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:6 }}>
            <div style={{ flex:1 }}>
              {c.code && <div style={{ fontSize:10, color:C.accent, fontWeight:700, letterSpacing:1, marginBottom:3 }}>{c.code}</div>}
              <div style={{ fontFamily:"Barlow Condensed", fontWeight:800, fontSize:18 }}>{c.name}</div>
              {c.clientName && <div style={{ fontSize:12, color:C.textDim, marginTop:2 }}>👤 {c.clientName}</div>}
              {c.address && <div style={{ fontSize:11, color:C.textMuted, marginTop:2 }}>📍 {c.address}</div>}
            </div>
            <span style={{ background:`${STATUS_COLOR[c.status]||C.textMuted}20`, color:STATUS_COLOR[c.status]||C.textMuted, border:`1px solid ${STATUS_COLOR[c.status]||C.textMuted}40`, borderRadius:6, padding:"2px 8px", fontSize:10, fontWeight:700, flexShrink:0 }}>
              {STATUS_LABEL[c.status]||c.status}
            </span>
          </div>

        </Card>
      ))}
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

  useEffect(() => {
    const unsub = onSnapshot(collection(db,"procedure"), s=>setList(s.docs.map(d=>({id:d.id,...d.data()}))));
    return unsub;
  }, []);

  const crea = async () => {
    if (!form.titolo) return;
    await addDoc(collection(db,"procedure"), { ...form, createdBy:user.nome, createdAt:serverTimestamp() });
    setShowForm(false);
    setForm({ titolo:"", categoria:"Muratura", testo:"" });
  };

  const categorie = [...new Set(list.map(p=>p.categoria))];

  if (sel) return (
    <div style={{ paddingBottom:80 }} className="fu">
      <div style={{ padding:"16px 16px 12px", borderBottom:`1px solid ${C.border}` }}>
        <button onClick={()=>setSel(null)} style={{ background:"none", border:"none", color:C.accent, fontSize:13, cursor:"pointer", fontFamily:"Barlow", marginBottom:8 }}>← Procedure</button>
        <div style={{ fontFamily:"Barlow Condensed", fontWeight:800, fontSize:20, marginBottom:6 }}>{sel.titolo}</div>
        <span style={{ background:C.accentDim, color:C.accent, borderRadius:4, padding:"2px 8px", fontSize:10, fontWeight:700 }}>{sel.categoria}</span>
      </div>
      <div style={{ padding:16 }}>
        <div style={{ fontSize:14, color:C.textDim, lineHeight:1.8, whiteSpace:"pre-wrap" }}>{sel.testo}</div>
      </div>
    </div>
  );

  return (
    <div style={{ padding:"16px 16px 80px" }} className="fu">
      {canMod && <Btn label="+ Nuova Procedura" onClick={()=>setShowForm(true)} icon="📋" />}
      {list.length===0 && <Empty icon="📋" msg="Nessuna procedura ancora" />}
      {categorie.map(cat => (
        <div key={cat}>
          <SecTitle label={cat} />
          {list.filter(p=>p.categoria===cat).map(p => (
            <Card key={p.id} onClick={()=>setSel(p)}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div style={{ fontWeight:600, fontSize:14 }}>{p.titolo}</div>
                <span style={{ color:C.accent, fontSize:20 }}>›</span>
              </div>
              <div style={{ fontSize:11, color:C.textMuted, marginTop:4 }}>di {p.createdBy}</div>
            </Card>
          ))}
        </div>
      ))}
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
    <div style={{ paddingBottom:80 }}>
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
          {FASCE.map(fascia => (
            <div key={fascia} style={{ display:"grid", gridTemplateColumns:"52px repeat(6,1fr)", borderBottom:`1px solid ${C.border}40` }}>
              <div style={{ padding:"6px 4px", fontSize:9, color:C.textMuted, fontWeight:700, textAlign:"right", paddingRight:8, paddingTop:8 }}>{fascia}</div>
              {GIORNI.map((g,i) => {
                const k = `${i}_${fascia}`;
                const val = celle[k]||"";
                return (
                  <div key={g} onClick={()=>apriCella(i,fascia)}
                    style={{ minHeight:44, borderLeft:`1px solid ${C.border}40`, padding:"4px 6px", cursor:canWrite?"pointer":"default", background:isOggi(i)?"rgba(79,172,222,0.04)":"transparent" }}>
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

// ─── FORM RAPPORTINO (allineato ERP) ─────────────────────────────────────────
function FormRapportino({ user, onSaved, onClose }) {
  const [cantieri, setCantieri] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [noPasto, setNoPasto] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  // blocks: [{projectId, projectName, lavorazioni:[{taskId,taskName,categoria,ore}]}]
  const [blocks, setBlocks] = useState([{
    projectId:"", projectName:"", lavorazioni:[{ taskId:"", taskName:"", categoria:"", ore:0 }]
  }]);

  useEffect(() => {
    getDocs(query(collection(db,"projects"),orderBy("name"))).then(s => setCantieri(s.docs.filter(d=>d.data().status==="active"||d.data().status==="draft").map(d=>({id:d.id,...d.data()}))));
    getDocs(query(collection(db,"timesheet_tasks"),orderBy("categoria"))).then(s => {
      setTasks(s.docs.filter(d=>d.data().attivo!==false).map(d=>({id:d.id,...d.data()})));
    });
  }, []);

  const categorie = [...new Set(tasks.map(t=>t.categoria))].sort();

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
    ...b, lavorazioni:[...b.lavorazioni,{ taskId:"", taskName:"", categoria:"", ore:0 }]
  }));

  const removeLav = (bi, li) => setBlocks(prev => prev.map((b,i) => i!==bi ? b : {
    ...b, lavorazioni: b.lavorazioni.filter((_,j)=>j!==li)
  }));

  const addBlock = () => setBlocks(prev => [...prev, { projectId:"", projectName:"", lavorazioni:[{ taskId:"", taskName:"", categoria:"", ore:0 }] }]);
  const removeBlock = (bi) => setBlocks(prev => prev.filter((_,i)=>i!==bi));

  const canSave = blocks.every(b => b.projectId && b.lavorazioni.every(l=>l.taskId&&l.ore>0));

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const allLavs = blocks.flatMap(b => b.lavorazioni.map(l=>({ ...l, projectId:b.projectId, projectName:b.projectName })));
    const totaleOre = allLavs.reduce((s,l)=>s+Number(l.ore),0);
    const firstBlock = blocks[0];
    await addDoc(collection(db,"timesheets"), {
      workerId: user.uid,
      workerName: user.nome + (user.cognome ? " "+user.cognome : ""),
      projectId: firstBlock.projectId,
      projectName: firstBlock.projectName,
      lavorazioni: allLavs,
      cantieri: blocks.map(b=>({ projectId:b.projectId, projectName:b.projectName })),
      totaleOre,
      hoursWorked: totaleOre,
      taskDescription: allLavs.map(l=>l.taskName).join(", "),
      noPasto,
      note: note.trim(),
      date: new Date(date),
      status: "submitted",
      createdAt: serverTimestamp(),
    });
    setSaving(false);
    onSaved();
    onClose();
  };

  return (
    <Modal title="Nuovo Rapportino" onClose={onClose}>
      {/* Data */}
      <div style={{ fontSize:10, color:C.textMuted, fontWeight:700, marginBottom:4 }}>DATA</div>
      <Inp type="date" value={date} onChange={e=>setDate(e.target.value)} />

      {/* Blocks cantiere */}
      {blocks.map((b,bi) => (
        <div key={bi} style={{ border:`1px solid ${C.border}`, borderRadius:10, marginBottom:10, overflow:"hidden" }}>
          <div style={{ background:`${C.mid}40`, padding:"10px 12px", borderBottom:`1px solid ${C.border}` }}>
            <div style={{ fontSize:10, color:C.textMuted, fontWeight:700, marginBottom:6 }}>CANTIERE {blocks.length>1?bi+1:""}</div>
            <Sel value={b.projectId} onChange={e=>updBlock(bi,"projectId",e.target.value)}>
              <option value="">Seleziona cantiere...</option>
              {cantieri.map(c=><option key={c.id} value={c.id}>{c.name}{c.code?" ("+c.code+")":""}</option>)}
            </Sel>
            {blocks.length>1 && (
              <button onClick={()=>removeBlock(bi)} style={{ background:"none", border:"none", color:C.red, fontSize:11, cursor:"pointer", fontFamily:"Barlow" }}>Rimuovi cantiere</button>
            )}
          </div>
          <div style={{ padding:"10px 12px" }}>
            <div style={{ fontSize:10, color:C.textMuted, fontWeight:700, marginBottom:6 }}>LAVORAZIONI</div>
            {b.lavorazioni.map((l,li) => (
              <div key={li} style={{ display:"flex", gap:6, marginBottom:8, alignItems:"center" }}>
                <div style={{ flex:1 }}>
                  <Sel value={l.taskId} onChange={e=>updLav(bi,li,"taskId",e.target.value)}>
                    <option value="">Seleziona lavorazione...</option>
                    {categorie.map(cat => (
                      <optgroup key={cat} label={cat}>
                        {tasks.filter(t=>t.categoria===cat).map(t=>(
                          <option key={t.id} value={t.id}>{t.nome}</option>
                        ))}
                      </optgroup>
                    ))}
                  </Sel>
                </div>
                <Inp type="number" placeholder="ore" value={l.ore||""} onChange={e=>updLav(bi,li,"ore",Number(e.target.value))} style={{ width:70, marginBottom:0 }} />
                {b.lavorazioni.length>1 && (
                  <button onClick={()=>removeLav(bi,li)} style={{ background:"none", border:"none", color:C.textMuted, fontSize:16, cursor:"pointer" }}>✕</button>
                )}
              </div>
            ))}
            <button onClick={()=>addLav(bi)} style={{ background:"none", border:`1px dashed ${C.border}`, borderRadius:6, color:C.textMuted, fontSize:11, padding:"5px 12px", cursor:"pointer", fontFamily:"Barlow", width:"100%" }}>
              + Aggiungi lavorazione
            </button>
          </div>
        </div>
      ))}

      <button onClick={addBlock} style={{ background:"none", border:`1px dashed ${C.border}`, borderRadius:8, color:C.textMuted, fontSize:12, padding:"8px", cursor:"pointer", fontFamily:"Barlow", width:"100%", marginBottom:10 }}>
        + Aggiungi cantiere
      </button>

      {/* No pasto */}
      <label style={{ display:"flex", alignItems:"center", gap:8, fontSize:13, color:C.textDim, marginBottom:10, cursor:"pointer" }}>
        <input type="checkbox" checked={noPasto} onChange={e=>setNoPasto(e.target.checked)} />
        No pasto
      </label>

      {/* Note */}
      <Txta placeholder="Note aggiuntive..." value={note} onChange={e=>setNote(e.target.value)} rows={2} />

      <Btn label={saving?"Salvataggio...":"✓ Invia Rapportino"} onClick={save} disabled={saving||!canSave} />
    </Modal>
  );
}

// ─── AREA PERSONALE ───────────────────────────────────────────────────────────
function AreaPersonale({ user }) {
  const [tab, setTab] = useState("rapportini");
  const [rapportini, setRapportini] = useState([]);
  const [ferie, setFerie] = useState([]);
  const [buste, setBuste] = useState([]);
  const [showRap, setShowRap] = useState(false);
  const [showFerie, setShowFerie] = useState(false);
  const [ferF, setFerF] = useState({ tipo:"Ferie", dal:"", al:"", note:"" });

  useEffect(() => {
    getDocs(query(collection(db,"timesheets"),where("workerId","==",user.uid),orderBy("date","desc"))).then(s=>setRapportini(s.docs.map(d=>({id:d.id,...d.data()}))));
    getDocs(query(collection(db,"ferie"),where("userId","==",user.uid))).then(s=>setFerie(s.docs.map(d=>({id:d.id,...d.data()}))));
    getDocs(query(collection(db,"buste"),where("userId","==",user.uid))).then(s=>setBuste(s.docs.map(d=>({id:d.id,...d.data()}))));
  }, [user.uid]);

  const reload = () => {
    getDocs(query(collection(db,"timesheets"),where("workerId","==",user.uid),orderBy("date","desc"))).then(s=>setRapportini(s.docs.map(d=>({id:d.id,...d.data()}))));
  };

  const inviaFerie = async () => {
    if (!ferF.dal) return;
    const r = await addDoc(collection(db,"ferie"), { ...ferF, userId:user.uid, nomeUtente:user.nome, stato:"in attesa", createdAt:serverTimestamp() });
    setFerie([...ferie,{id:r.id,...ferF,stato:"in attesa"}]);
    setShowFerie(false);
    setFerF({ tipo:"Ferie", dal:"", al:"", note:"" });
  };

  const fCol = { approvata:C.green, "in attesa":C.gold, rifiutata:C.red };
  const stCol = { approved:C.green, submitted:C.gold, pending:C.gold, rejected:C.red };
  const stLabel = { approved:"Approvato", submitted:"In attesa", pending:"In attesa", rejected:"Rifiutato" };

  const tabs = [
    {id:"rapportini",l:"📋 Rapportini"},
    {id:"ferie",l:"✈ Ferie"},
    {id:"buste",l:"📄 Buste"},
    {id:"programma",l:"📅 Programma"},
  ];

  return (
    <div className="fu">
      <div style={{ display:"flex", gap:6, padding:"12px 16px", overflowX:"auto", borderBottom:`1px solid ${C.border}` }}>
        {tabs.map(t => (
          <button key={t.id} onClick={()=>setTab(t.id)}
            style={{ background:tab===t.id?C.accentDim:"transparent", color:tab===t.id?C.accent:C.textMuted, border:`1px solid ${tab===t.id?C.accent+"50":C.border}`, borderRadius:20, padding:"6px 14px", fontSize:11, fontWeight:700, cursor:"pointer", whiteSpace:"nowrap", fontFamily:"Barlow" }}>
            {t.l}
          </button>
        ))}
      </div>

      {tab==="programma" && (
        <CalendarioSettimanale
          user={user}
          targetUserId={user.uid}
          targetUserNome={null}
          canWrite={false}
        />
      )}

      {tab!=="programma" && (
        <div style={{ padding:"16px 16px 80px" }}>
          {tab==="rapportini" && (
            <>
              <Btn label="+ Nuovo Rapportino" onClick={()=>setShowRap(true)} icon="📋" />
              {rapportini.length===0 && <Empty icon="📋" msg="Nessun rapportino ancora" />}
              {rapportini.map(r => {
                const lavs = r.lavorazioni || [];
                const totOre = r.totaleOre || r.hoursWorked || 0;
                const col = stCol[r.status] || C.textMuted;
                const lbl = stLabel[r.status] || r.status;
                const modificabile = r.status === "submitted" || r.status === "pending";
                return (
                  <Card key={r.id}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:8 }}>
                      <div style={{ flex:1 }}>
                        <div style={{ fontWeight:700, fontSize:15 }}>
                          {r.date?.toDate ? r.date.toDate().toLocaleDateString("it-IT",{weekday:"short",day:"numeric",month:"short"}) : r.date}
                        </div>
                        <div style={{ fontSize:12, color:C.textDim, marginTop:2 }}>🏗 {r.projectName}</div>
                      </div>
                      <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:6 }}>
                        <div style={{ fontFamily:"Barlow Condensed", fontWeight:800, fontSize:22, color:C.accent, lineHeight:1 }}>{totOre}h</div>
                        <span style={{ background:`${col}20`, color:col, border:`1px solid ${col}40`, borderRadius:20, padding:"3px 10px", fontSize:10, fontWeight:700 }}>{lbl}</span>
                      </div>
                    </div>
                    {lavs.length > 0 && (
                      <div style={{ display:"flex", flexWrap:"wrap", gap:5, marginBottom:8 }}>
                        {lavs.map((l,i) => (
                          <span key={i} style={{ background:C.accentDim, color:C.accent, borderRadius:20, padding:"3px 10px", fontSize:11, fontWeight:600 }}>
                            {l.taskName} · {l.ore}h
                          </span>
                        ))}
                      </div>
                    )}
                    {r.noPasto && <div style={{ fontSize:11, color:C.red, marginBottom:4 }}>🍽 No pasto</div>}
                    {r.note && <div style={{ fontSize:12, color:C.textMuted, fontStyle:"italic", marginBottom:8 }}>{r.note}</div>}
                    {modificabile && (
                      <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:8, marginTop:4 }}>
                        <button onClick={async()=>{
                          if(window.confirm("Eliminare questo rapportino?")) {
                            const { deleteDoc:dd, doc:d2 } = await import("firebase/firestore");
                            await dd(d2(db,"timesheets",r.id));
                            reload();
                          }
                        }} style={{ background:"none", border:"none", color:C.textMuted, fontSize:11, cursor:"pointer", fontFamily:"Barlow" }}>
                          🗑 Elimina
                        </button>
                        <span style={{ fontSize:11, color:C.textMuted, marginLeft:8 }}>· Modificabile fino all'approvazione</span>
                      </div>
                    )}
                    {!modificabile && r.status==="approved" && (
                      <div style={{ fontSize:11, color:C.green, marginTop:4 }}>✓ Approvato — non modificabile</div>
                    )}
                  </Card>
                );
              })}
              {showRap && <FormRapportino user={user} onSaved={reload} onClose={()=>setShowRap(false)} />}
            </>
          )}
          {tab==="ferie" && (
            <>
              <Btn label="+ Nuova Richiesta" onClick={()=>setShowFerie(true)} icon="✈" />
              {ferie.length===0 && <Empty icon="✈" msg="Nessuna richiesta ancora" />}
              {ferie.map(f => (
                <Card key={f.id}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                    <div>
                      <div style={{ fontWeight:700, fontSize:15 }}>{f.tipo}</div>
                      <div style={{ fontSize:12, color:C.textDim, marginTop:3 }}>{f.dal}{f.al&&f.al!==f.dal?` → ${f.al}`:""}</div>
                      {f.note && <div style={{ fontSize:11, color:C.textMuted, marginTop:4 }}>{f.note}</div>}
                    </div>
                    <span style={{ background:`${fCol[f.stato]||C.textMuted}20`, color:fCol[f.stato]||C.textMuted, border:`1px solid ${fCol[f.stato]||C.textMuted}40`, borderRadius:4, padding:"3px 10px", fontSize:10, fontWeight:700 }}>{f.stato}</span>
                  </div>
                </Card>
              ))}
              {showFerie && (
                <Modal title="Nuova Richiesta" onClose={()=>setShowFerie(false)}>
                  <Sel value={ferF.tipo} onChange={e=>setFerF({...ferF,tipo:e.target.value})}>
                    {["Ferie","Permesso","Malattia","Permesso sindacale"].map(t=><option key={t}>{t}</option>)}
                  </Sel>
                  <Inp placeholder="Dal" type="date" value={ferF.dal} onChange={e=>setFerF({...ferF,dal:e.target.value})} />
                  <Inp placeholder="Al" type="date" value={ferF.al} onChange={e=>setFerF({...ferF,al:e.target.value})} />
                  <Txta placeholder="Note (opzionale)" value={ferF.note} onChange={e=>setFerF({...ferF,note:e.target.value})} rows={2} />
                  <Btn label="✓ Invia Richiesta" onClick={inviaFerie} />
                </Modal>
              )}
            </>
          )}
          {tab==="buste" && (
            <>
              {buste.length===0 && <Empty icon="📄" msg="Nessuna busta paga disponibile. L'amministrazione le caricherà qui." />}
              {buste.map(b => (
                <Card key={b.id}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                    <div>
                      <div style={{ fontWeight:700, fontSize:15 }}>📄 {b.mese}</div>
                      <div style={{ fontSize:12, color:C.textDim, marginTop:3 }}>Netto: <span style={{ color:C.green, fontWeight:700 }}>€ {Number(b.netto||0).toLocaleString()}</span></div>
                    </div>
                    {b.url && <a href={b.url} target="_blank" rel="noreferrer"><Btn label="↓ PDF" small variant="ghost" /></a>}
                  </div>
                </Card>
              ))}
            </>
          )}
        </div>
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
  const fileRef = useRef();

  useEffect(() => {
    getDocs(query(collection(db,"ferie"),where("stato","==","in attesa"))).then(s=>setFerie(s.docs.map(d=>({id:d.id,...d.data()}))));
    getDocs(collection(db,"ferie")).then(s=>setTutteFerie(s.docs.map(d=>({id:d.id,...d.data()}))));
    getDocs(collection(db,"utenti")).then(s=>setUtenti(s.docs.map(d=>({id:d.id,...d.data()}))));
    getDocs(collection(db,"rapportini")).then(s=>setRapportini(s.docs.map(d=>({id:d.id,...d.data()}))));
    getDocs(collection(db,"programma")).then(s=>setProgrammi(s.docs.map(d=>({id:d.id,...d.data()}))));
  }, []);

  const approvaFeria = async (id, stato) => {
    await updateDoc(doc(db,"ferie",id),{stato});
    setFerie(ferie.filter(f=>f.id!==id));
    setTutteFerie(tutteFerie.map(f=>f.id===id?{...f,stato}:f));
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
  const fCol = { approvata:C.green, "in attesa":C.gold, rifiutata:C.red };

  const tabs = [
    {id:"ferie",    l:"✈ Ferie",      badge:ferie.length},
    {id:"buste",    l:"📄 Buste",      badge:null},
    {id:"rapportini",l:"📋 Rapportini",badge:null},
    {id:"programmi",l:"📅 Programmi",  badge:null},
    {id:"calendari",l:"🗓 Calendari",  badge:null},
    {id:"utenti",   l:"👷 Utenti",     badge:null},
  ];

  return (
    <div className="fu">
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
            {ferie.map(f=>(
              <Card key={f.id} style={{ borderLeft:`3px solid ${C.gold}` }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <div>
                    <div style={{ fontWeight:700, fontSize:14 }}>{f.nomeUtente}</div>
                    <div style={{ fontSize:13, color:C.textDim, marginTop:2 }}>{f.tipo} — {f.dal}{f.al&&f.al!==f.dal?` → ${f.al}`:""}</div>
                    {f.note&&<div style={{ fontSize:11, color:C.textMuted, marginTop:4 }}>{f.note}</div>}
                  </div>
                  <div style={{ display:"flex", gap:6 }}>
                    <button onClick={()=>approvaFeria(f.id,"approvata")} style={{ background:C.greenDim, color:C.green, border:`1px solid ${C.green}40`, borderRadius:8, padding:"8px 14px", fontSize:13, fontWeight:800, cursor:"pointer" }}>✓</button>
                    <button onClick={()=>approvaFeria(f.id,"rifiutata")} style={{ background:C.redDim, color:C.red, border:`1px solid ${C.red}40`, borderRadius:8, padding:"8px 14px", fontSize:13, fontWeight:800, cursor:"pointer" }}>✕</button>
                  </div>
                </div>
              </Card>
            ))}

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
      </div>
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
          <div style={{ position:"absolute", top:56, right:16, width:300, maxHeight:400, overflowY:"auto", background:C.surface, border:`1px solid ${C.border}`, borderRadius:14, boxShadow:`0 8px 32px rgba(0,0,0,0.5)` }} onClick={e=>e.stopPropagation()}>
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
// ─── APPUNTI CANTIERE ─────────────────────────────────────────────────────────
// Da inserire in App.js prima di export default function App()
// Salva su Firestore: projects/{projectId}/appunti_cantiere
// Stesso schema dell'ERP desktop per sincronizzazione automatica

function AppuntiCantiere({ user, projectId, projectName, onBack }) {
  const [appunti, setAppunti] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [filtroTipo, setFiltroTipo] = useState("tutti");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef();

  const [form, setForm] = useState({
    tipo: "nota",
    categoria: "Generale",
    testo: "",
    checklist: [],
    fotoUrl: "",
  });
  const [nuovaVoce, setNuovaVoce] = useState("");

  const CATEGORIE = ["Generale","Sicurezza","Materiali","Contabilita","Subappalti","Clienti","Altro"];
  const TIPI = [
    { id:"tutti", label:"Tutti", icon:"📋" },
    { id:"nota",  label:"Note",  icon:"📝" },
    { id:"checklist", label:"Checklist", icon:"✅" },
    { id:"foto",  label:"Foto",  icon:"📷" },
  ];

  const catColor = {
    Generale:    C.accent,
    Sicurezza:   C.red,
    Materiali:   C.green,
    Contabilita: C.gold,
    Subappalti:  "#a78bfa",
    Clienti:     "#38bdf8",
    Altro:       C.textMuted,
  };

  useEffect(() => {
    if (!projectId) return;
    const unsub = onSnapshot(
      collection(db, `projects/${projectId}/appunti_cantiere`),
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
  }, [projectId]);

  const uploadFoto = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    try {
      const r = ref(storage, `projects/${projectId}/appunti/${Date.now()}_${file.name}`);
      await uploadBytes(r, file);
      const url = await getDownloadURL(r);
      setForm(p => ({ ...p, fotoUrl: url, tipo: "foto" }));
    } catch (err) { console.error(err); }
    setUploading(false);
    e.target.value = "";
  };

  const aggiungiVoce = () => {
    if (!nuovaVoce.trim()) return;
    setForm(p => ({ ...p, checklist: [...p.checklist, { testo: nuovaVoce.trim(), fatto: false }] }));
    setNuovaVoce("");
  };

  const toggleVoce = (i) => {
    setForm(p => ({
      ...p,
      checklist: p.checklist.map((v, j) => j === i ? { ...v, fatto: !v.fatto } : v)
    }));
  };

  const removeVoce = (i) => {
    setForm(p => ({ ...p, checklist: p.checklist.filter((_, j) => j !== i) }));
  };

  const salva = async () => {
    if (form.tipo === "nota" && !form.testo.trim()) return;
    if (form.tipo === "checklist" && form.checklist.length === 0) return;
    if (form.tipo === "foto" && !form.fotoUrl) return;

    await addDoc(collection(db, `projects/${projectId}/appunti_cantiere`), {
      tipo: form.tipo,
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

    setForm({ tipo:"nota", categoria:"Generale", testo:"", checklist:[], fotoUrl:"" });
    setNuovaVoce("");
    setShowForm(false);
  };

  const toggleChecklistItem = async (appunto, idx) => {
    const nuova = appunto.checklist.map((v, i) => i === idx ? { ...v, fatto: !v.fatto } : v);
    await updateDoc(doc(db, `projects/${projectId}/appunti_cantiere`, appunto.id), {
      checklist: nuova,
      updatedAt: serverTimestamp(),
    });
  };

  const eliminaAppunto = async (id) => {
    if (!window.confirm("Eliminare questo appunto?")) return;
    const { deleteDoc: dd, doc: d2 } = await import("firebase/firestore");
    await dd(d2(db, `projects/${projectId}/appunti_cantiere`, id));
  };

  const appuntiFiltrati = filtroTipo === "tutti"
    ? appunti
    : appunti.filter(a => a.tipo === filtroTipo);

  const fmtData = (ts) => {
    if (!ts?.toDate) return "";
    return ts.toDate().toLocaleDateString("it-IT", { day:"numeric", month:"short", hour:"2-digit", minute:"2-digit" });
  };

  return (
    <div style={{ paddingBottom: 80 }} className="fu">
      {/* Header */}
      <div style={{ background:`linear-gradient(135deg,${C.mid},${C.blue}40)`, padding:"14px 16px 0", borderBottom:`1px solid ${C.border}` }}>
        <button onClick={onBack} style={{ background:"none", border:"none", color:C.accent, fontSize:13, cursor:"pointer", fontFamily:"Barlow", marginBottom:8 }}>
          ← {projectName}
        </button>
        <div style={{ fontFamily:"Barlow Condensed", fontWeight:800, fontSize:20, marginBottom:12 }}>
          Appunti cantiere
        </div>
        {/* Filtri tipo */}
        <div style={{ display:"flex", gap:6, overflowX:"auto", paddingBottom:0 }}>
          {TIPI.map(t => (
            <button key={t.id} onClick={() => setFiltroTipo(t.id)}
              style={{ flex:"0 0 auto", padding:"8px 14px", background:"none", border:"none",
                borderBottom:`2px solid ${filtroTipo===t.id?C.accent:"transparent"}`,
                color:filtroTipo===t.id?C.accent:C.textMuted, fontSize:11, fontWeight:700,
                cursor:"pointer", fontFamily:"Barlow", whiteSpace:"nowrap" }}>
              {t.icon} {t.label}
              {t.id !== "tutti" && (
                <span style={{ marginLeft:4, fontSize:10, color:filtroTipo===t.id?C.accent:C.textMuted }}>
                  ({appunti.filter(a => a.tipo === t.id).length})
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div style={{ padding:"14px 16px" }}>
        {/* Bottone aggiungi */}
        <div style={{ display:"flex", gap:8, marginBottom:16 }}>
          <button onClick={() => { setForm(p => ({...p, tipo:"nota"})); setShowForm(true); }}
            style={{ flex:1, background:C.accentDim, border:`1px solid ${C.accent}40`, borderRadius:10, padding:"10px", fontSize:12, fontWeight:700, color:C.accent, cursor:"pointer", fontFamily:"Barlow" }}>
            📝 Nota
          </button>
          <button onClick={() => { setForm(p => ({...p, tipo:"checklist"})); setShowForm(true); }}
            style={{ flex:1, background:C.greenDim, border:`1px solid ${C.green}40`, borderRadius:10, padding:"10px", fontSize:12, fontWeight:700, color:C.green, cursor:"pointer", fontFamily:"Barlow" }}>
            ✅ Checklist
          </button>
          <button onClick={() => fileRef.current.click()}
            style={{ flex:1, background:C.goldDim, border:`1px solid ${C.gold}40`, borderRadius:10, padding:"10px", fontSize:12, fontWeight:700, color:C.gold, cursor:"pointer", fontFamily:"Barlow" }}>
            {uploading ? "..." : "📷 Foto"}
          </button>
          <input ref={fileRef} type="file" accept="image/*" capture="environment"
            onChange={e => { uploadFoto(e).then(() => setShowForm(true)); }}
            style={{ display:"none" }} />
        </div>

        {/* Lista appunti */}
        {loading && <div style={{ textAlign:"center", color:C.textMuted, padding:32 }}>Caricamento...</div>}
        {!loading && appuntiFiltrati.length === 0 && (
          <div style={{ textAlign:"center", padding:"48px 0", color:C.textMuted }}>
            <div style={{ fontSize:40, marginBottom:12 }}>📋</div>
            <div style={{ fontSize:14 }}>Nessun appunto ancora</div>
            <div style={{ fontSize:12, marginTop:6 }}>Aggiungi note, checklist o foto dal cantiere</div>
          </div>
        )}

        {appuntiFiltrati.map(a => {
          const col = catColor[a.categoria] || C.accent;
          const canDel = a.autorId === user.uid || user.ruolo === "admin";
          return (
            <div key={a.id} style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, marginBottom:10, overflow:"hidden", borderLeft:`3px solid ${col}` }}>
              {/* Header card */}
              <div style={{ display:"flex", alignItems:"center", gap:8, padding:"10px 14px 8px" }}>
                <span style={{ fontSize:16 }}>
                  {a.tipo==="nota"?"📝":a.tipo==="checklist"?"✅":"📷"}
                </span>
                <span style={{ fontSize:9, padding:"2px 6px", borderRadius:3, fontWeight:700, background:`${col}20`, color:col }}>
                  {a.categoria}
                </span>
                <span style={{ fontSize:10, color:C.textMuted, marginLeft:"auto" }}>
                  {a.autore} · {fmtData(a.createdAt)}
                </span>
                {canDel && (
                  <button onClick={() => eliminaAppunto(a.id)}
                    style={{ background:"none", border:"none", color:C.textMuted, fontSize:14, cursor:"pointer", padding:"0 0 0 4px" }}>
                    🗑
                  </button>
                )}
              </div>

              {/* Contenuto */}
              <div style={{ padding:"0 14px 12px" }}>
                {/* NOTA */}
                {a.tipo === "nota" && a.testo && (
                  <div style={{ fontSize:14, color:C.text, lineHeight:1.7, whiteSpace:"pre-wrap" }}>
                    {a.testo}
                  </div>
                )}

                {/* FOTO */}
                {a.tipo === "foto" && a.fotoUrl && (
                  <div>
                    <img src={a.fotoUrl} alt="foto cantiere"
                      style={{ width:"100%", borderRadius:8, maxHeight:240, objectFit:"cover", display:"block" }} />
                    {a.testo && (
                      <div style={{ fontSize:12, color:C.textDim, marginTop:8, lineHeight:1.5 }}>{a.testo}</div>
                    )}
                  </div>
                )}

                {/* CHECKLIST */}
                {a.tipo === "checklist" && (
                  <div>
                    {a.testo && (
                      <div style={{ fontSize:13, color:C.textDim, marginBottom:8 }}>{a.testo}</div>
                    )}
                    {(a.checklist || []).map((v, i) => (
                      <div key={i} onClick={() => toggleChecklistItem(a, i)}
                        style={{ display:"flex", alignItems:"center", gap:10, padding:"7px 0",
                          borderBottom:`1px solid ${C.border}40`, cursor:"pointer" }}>
                        <div style={{ width:20, height:20, borderRadius:5, flexShrink:0,
                          border:`2px solid ${v.fatto?C.green:C.border}`,
                          background:v.fatto?C.green:"transparent",
                          display:"flex", alignItems:"center", justifyContent:"center" }}>
                          {v.fatto && <span style={{ color:"#000", fontSize:11, fontWeight:800 }}>✓</span>}
                        </div>
                        <span style={{ fontSize:13, color:v.fatto?C.textMuted:C.text,
                          textDecoration:v.fatto?"line-through":"none", flex:1 }}>
                          {v.testo}
                        </span>
                      </div>
                    ))}
                    {/* Progresso checklist */}
                    {(a.checklist || []).length > 0 && (
                      <div style={{ marginTop:8 }}>
                        <div style={{ display:"flex", justifyContent:"space-between", fontSize:10, color:C.textMuted, marginBottom:3 }}>
                          <span>Completate</span>
                          <span style={{ color:C.green, fontWeight:700 }}>
                            {a.checklist.filter(v=>v.fatto).length}/{a.checklist.length}
                          </span>
                        </div>
                        <div style={{ height:3, borderRadius:2, background:`${C.border}80`, overflow:"hidden" }}>
                          <div style={{ height:"100%", borderRadius:2, background:C.green,
                            width:`${Math.round(a.checklist.filter(v=>v.fatto).length/a.checklist.length*100)}%`,
                            transition:"width .3s" }} />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* MODAL AGGIUNGI */}
      {showForm && (
        <Modal title={form.tipo==="nota"?"Nuova nota":form.tipo==="checklist"?"Nuova checklist":"Nuova foto"} onClose={() => setShowForm(false)}>

          {/* Categoria */}
          <div style={{ fontSize:10, color:C.textMuted, fontWeight:700, marginBottom:6 }}>CATEGORIA</div>
          <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:12 }}>
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

          {/* Anteprima foto */}
          {form.tipo === "foto" && form.fotoUrl && (
            <img src={form.fotoUrl} alt="preview"
              style={{ width:"100%", borderRadius:8, maxHeight:200, objectFit:"cover", marginBottom:10 }} />
          )}

          {/* Testo/descrizione */}
          <Txta
            placeholder={form.tipo==="foto"?"Descrizione foto (opzionale)...":form.tipo==="checklist"?"Titolo checklist (opzionale)...":"Scrivi la tua nota..."}
            value={form.testo}
            onChange={e => setForm(p => ({...p, testo:e.target.value}))}
            rows={form.tipo==="nota"?4:2}
          />

          {/* Voci checklist */}
          {form.tipo === "checklist" && (
            <div>
              {form.checklist.map((v, i) => (
                <div key={i} style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                  <div style={{ width:18, height:18, borderRadius:4, border:`2px solid ${C.border}`, background:"transparent", flexShrink:0 }} />
                  <span style={{ flex:1, fontSize:13, color:C.text }}>{v.testo}</span>
                  <button onClick={() => removeVoce(i)}
                    style={{ background:"none", border:"none", color:C.textMuted, fontSize:16, cursor:"pointer" }}>✕</button>
                </div>
              ))}
              <div style={{ display:"flex", gap:8 }}>
                <input value={nuovaVoce} onChange={e => setNuovaVoce(e.target.value)}
                  onKeyDown={e => e.key==="Enter" && aggiungiVoce()}
                  placeholder="Aggiungi voce..."
                  style={{ flex:1, background:`${C.mid}40`, border:`1px solid ${C.border}`, borderRadius:8,
                    color:C.text, padding:"8px 12px", fontSize:13, outline:"none", fontFamily:"Barlow" }} />
                <button onClick={aggiungiVoce}
                  style={{ background:C.accentDim, border:`1px solid ${C.accent}40`, borderRadius:8,
                    color:C.accent, padding:"8px 14px", fontSize:13, fontWeight:700, cursor:"pointer" }}>
                  +
                </button>
              </div>
            </div>
          )}

          <div style={{ height:16 }} />
          <Btn label="✓ Salva appunto" onClick={salva}
            disabled={
              (form.tipo==="nota" && !form.testo.trim()) ||
              (form.tipo==="checklist" && form.checklist.length===0) ||
              (form.tipo==="foto" && !form.fotoUrl)
            } />
        </Modal>
      )}
    </div>
  );
}


export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState("dashboard");
  const [altroOpen, setAltroOpen] = useState(false);
  const [stats, setStats] = useState({ cantieri:0, operai:0, ferie:0, rap:0 });

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fu) => {
      if (fu) {
        const snap = await getDoc(doc(db,"utenti",fu.uid));
        if (snap.exists()) {
          const raw = { uid:fu.uid, ...snap.data() };
          const u = { ...raw, ruolo: getRuolo(raw) };
          setUser(u);
          setSection(u.ruolo==="operaio"?"personale":"dashboard");
        }
      } else setUser(null);
      setLoading(false);
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!user) return;
    Promise.all([
      getDocs(collection(db,"cantieri")),
      getDocs(query(collection(db,"utenti"),where("ruolo","==","operaio"))),
      getDocs(query(collection(db,"ferie"),where("stato","==","in attesa"))),
      getDocs(collection(db,"rapportini")),
    ]).then(([c,o,f,r]) => setStats({ cantieri:c.size, operai:o.size, ferie:f.size, rap:r.size }));
  }, [user]);

  if (loading) return (
    <>
      <style>{globalCss}</style>
      <SplashScreen />
    </>
  );

  if (!user) return <LoginScreen onLogin={u=>{ setUser(u); setSection(u.ruolo==="operaio"?"personale":"dashboard"); }} />;

  const navAll = [
    { id:"dashboard",  icon:"🏠", label:"Home",     roles:["admin","amministrazione","ufficio_tecnico"] },
    { id:"cantieri",   icon:"🏗", label:"Cantieri",  roles:["admin","amministrazione","ufficio_tecnico","operaio"] },
    { id:"chat",       icon:"💬", label:"Chat",      roles:["admin","amministrazione","ufficio_tecnico","operaio"] },
    { id:"personale",  icon:"👤", label:"Personale", roles:["admin","amministrazione","ufficio_tecnico","operaio"] },
    { id:"altro",      icon:"⋯",  label:"Altro",     roles:["admin","amministrazione","ufficio_tecnico","operaio"] },
  ];
  const navItems = navAll.filter(n => n.roles.includes(user.ruolo));

  const altroItems = [
    { id:"cronoprogramma", icon:"📅", label:"Cronoprogramma" },
    { id:"procedure",      icon:"📋", label:"Procedure" },
    { id:"regolamento",    icon:"📜", label:"Regolamento" },
    ...(isManager(user.ruolo)?[{ id:"gestione", icon:"⚙", label:"Gestione" }]:[]),
  ];

  const titles = { dashboard:"Dashboard", cantieri:"Cantieri", chat:"Chat", personale:"Area Personale", cronoprogramma:"Cronoprogramma", procedure:"Procedure", regolamento:"Regolamento", gestione:"Gestione" };

  return (
    <div style={{ minHeight:"100vh", background:C.bg, color:C.text, fontFamily:"Barlow,sans-serif", maxWidth:480, margin:"0 auto" }}>
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
          <button onClick={()=>signOut(auth)} style={{ background:"none", border:"none", color:C.textMuted, fontSize:18, cursor:"pointer" }}>⏏</button>
        </div>
      </div>

      {/* Sections */}
      {section==="dashboard"      && <Dashboard user={user} stats={stats} onSection={setSection} />}
      {section==="cantieri"       && <Cantieri user={user} />}
      {section==="chat"           && <Chat user={user} />}
      {section==="personale"      && <AreaPersonale user={user} />}
      {section==="cronoprogramma" && <Cronoprogramma />}
      {section==="procedure"      && <Procedure user={user} />}
      {section==="regolamento"    && <Regolamento user={user} />}
      {section==="gestione"       && <Gestione user={user} />}

      {/* Menu Altro */}
      {altroOpen && (
        <div style={{ position:"fixed", inset:0, zIndex:300 }} onClick={()=>setAltroOpen(false)}>
          <div style={{ position:"absolute", bottom:70, left:"50%", transform:"translateX(-50%)", width:"88%", maxWidth:420, background:C.surface, border:`1px solid ${C.border}`, borderRadius:14, padding:8 }} onClick={e=>e.stopPropagation()}>
            {altroItems.map(item => (
              <button key={item.id} onClick={()=>{ setSection(item.id); setAltroOpen(false); }}
                style={{ width:"100%", display:"flex", alignItems:"center", gap:14, padding:"12px 16px", background:"none", border:"none", color:C.text, fontSize:14, cursor:"pointer", fontFamily:"Barlow", borderRadius:10, textAlign:"left" }}>
                <span style={{ fontSize:22 }}>{item.icon}</span>
                <span style={{ fontWeight:600 }}>{item.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Bottom Nav */}
      <nav style={{ position:"fixed", bottom:0, left:"50%", transform:"translateX(-50%)", width:"100%", maxWidth:480, background:C.surface, borderTop:`1px solid ${C.border}`, display:"flex", zIndex:200 }}>
        {navItems.map(n => {
          const active = n.id==="altro" ? altroItems.map(i=>i.id).includes(section) : section===n.id;
          return (
            <button key={n.id} onClick={()=>n.id==="altro"?setAltroOpen(!altroOpen):setSection(n.id)}
              style={{ flex:1, padding:"10px 0 8px", background:"none", border:"none", color:active?C.accent:C.textMuted, fontSize:9, fontWeight:active?800:500, cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:3, borderTop:`2px solid ${active?C.accent:"transparent"}`, fontFamily:"Barlow", letterSpacing:0.3, textTransform:"uppercase" }}>
              <span style={{ fontSize:20 }}>{n.icon}</span>
              {n.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
