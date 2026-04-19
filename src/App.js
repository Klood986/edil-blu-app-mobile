import { useState, useEffect, useRef, useCallback } from "react";
import { auth, db, storage } from "./firebase";
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
} from "firebase/auth";
import {
  collection, doc, getDoc, getDocs, addDoc, updateDoc, setDoc,
  query, where, orderBy, onSnapshot, serverTimestamp, arrayUnion,
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";

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
const splashKeyframes = `
  @keyframes splashFadeScale { from { opacity:0; transform:scale(0.8); } to { opacity:1; transform:scale(1); } }
  @keyframes splashSlideUp { from { opacity:0; transform:translateY(20px); } to { opacity:1; transform:translateY(0); } }
  @keyframes splashLoadBar { from { width:0%; } to { width:100%; } }
`;

function SplashScreen() {
  return (
    <div style={{ position:"fixed", inset:0, background:"linear-gradient(135deg, #070f1e 0%, #0d1f3c 50%, #1a3a6b 100%)", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", zIndex:9999 }}>
      <style>{splashKeyframes}</style>
      <div style={{ animation:"splashFadeScale 0.8s ease-out forwards", textAlign:"center", marginBottom:24 }}>
        <div style={{ width:100, height:100, borderRadius:28, background:"linear-gradient(135deg, #1a3a6b, #4a9eff)", margin:"0 auto 16px", display:"flex", alignItems:"center", justifyContent:"center", boxShadow:"0 16px 64px rgba(74,158,255,0.4)", fontSize:52 }}>🏗</div>
        <div style={{ fontSize:38, fontWeight:900, letterSpacing:8, color:"#ffffff", fontFamily:"Barlow Condensed, sans-serif" }}>EDIL BLU</div>
      </div>
      <div style={{ animation:"splashSlideUp 0.6s ease-out 0.5s both", fontSize:13, color:"#4a9eff", letterSpacing:4, textTransform:"uppercase", marginBottom:48 }}>
        Gestione Cantieri
      </div>
      <div style={{ width:200, height:3, background:"rgba(255,255,255,0.1)", borderRadius:2, overflow:"hidden" }}>
        <div style={{ height:"100%", background:"linear-gradient(90deg, #4a9eff, #38bdf8)", animation:"splashLoadBar 2s ease-in-out forwards", borderRadius:2 }} />
      </div>
      <div style={{ position:"absolute", bottom:40, fontSize:11, color:"rgba(255,255,255,0.25)", animation:"splashSlideUp 0.6s ease-out 1s both" }}>
        v2.0 — Edil Blu ERP
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
  const [ferieAlert, setFerieAlert] = useState([]);
  const [rapAlert, setRapAlert] = useState([]);
  const [showRapForm, setShowRapForm] = useState(false);
  const [cantiereOggi, setCantiereOggi] = useState(null);
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
    // Ultimi rapportini
    getDocs(query(collection(db,"timesheets"),where("workerId","==",user.uid),orderBy("date","desc")))
      .then(s => setUltimiRap(s.docs.slice(0,5).map(d=>({id:d.id,...d.data()})))).catch(()=>{});
  }, [user.ruolo, user.uid]);

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
    <div style={{ paddingBottom:80, flex:1, overflowY:"auto" }} className="fu">
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

        {/* Cantiere di oggi */}
        {cantiereOggi && (
          <div onClick={()=>onSection("cantieri")} style={{ background:`linear-gradient(135deg, ${C.blue}60, ${C.accent}40)`, border:`1px solid ${C.accent}50`, borderRadius:14, padding:"16px 18px", marginBottom:16, cursor:"pointer" }}>
            <div style={{ fontSize:11, color:"#a8d4f0", marginBottom:6 }}>📍 Oggi sei a:</div>
            <div style={{ fontFamily:"Barlow Condensed", fontWeight:800, fontSize:22, color:C.text, marginBottom:4 }}>{cantiereOggi.cantiereName||cantiereOggi.projectName||"Cantiere"}</div>
            {cantiereOggi.indirizzo && <div style={{ fontSize:12, color:"#a8d4f0cc" }}>{cantiereOggi.indirizzo}</div>}
            {cantiereOggi.lavorazione && <div style={{ fontSize:11, color:C.accent, marginTop:6, fontWeight:600 }}>{cantiereOggi.lavorazione}</div>}
          </div>
        )}
        {!cantiereOggi && user.ruolo === "operaio" && (
          <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:14, padding:"14px 18px", marginBottom:16, textAlign:"center" }}>
            <div style={{ fontSize:13, color:C.textMuted }}>Nessun cantiere programmato oggi</div>
          </div>
        )}

        {/* Incarichi in sospeso */}
        {incarichi.length > 0 && (
          <div onClick={()=>onSection("personale")} style={{ background:`${C.gold}12`, border:`1px solid ${C.gold}40`, borderRadius:14, padding:"14px 16px", marginBottom:16, cursor:"pointer", display:"flex", alignItems:"center", gap:12 }}>
            <div style={{ width:40, height:40, borderRadius:12, background:`${C.gold}20`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, flexShrink:0 }}>⚡</div>
            <div style={{ flex:1 }}>
              <div style={{ fontWeight:700, fontSize:13, color:C.gold }}>{incarichi.length} incaric{incarichi.length===1?"o":"hi"} in attesa</div>
              <div style={{ fontSize:11, color:C.textDim, marginTop:2 }}>{incarichi.slice(0,2).map(i=>i.titolo).join(" · ")}</div>
            </div>
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

        {/* Ultimi rapportini */}
        {ultimiRap.length > 0 && (
          <>
            <div style={{ fontSize:10, fontWeight:800, color:C.textMuted, letterSpacing:2, textTransform:"uppercase", marginBottom:12, marginTop:24 }}>Ultimi rapportini</div>
            {ultimiRap.map(r => (
              <div key={r.id} style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:10, padding:"10px 14px", marginBottom:6, display:"flex", alignItems:"center", gap:10 }}>
                <div style={{ fontSize:11, color:C.textMuted, minWidth:60 }}>{r.date?.toDate?.()?.toLocaleDateString("it-IT")||r.date||""}</div>
                <div style={{ flex:1, fontSize:13, fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.projectName||r.cantiere||"—"}</div>
                <div style={{ fontSize:12, color:C.accent, fontWeight:700 }}>{r.totaleOre||r.hoursWorked||"—"}h</div>
              </div>
            ))}
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
  const [misuraFile, setMisuraFile] = useState(null); // { url, nome } — apre il misuratore
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
    const tabsCantiere = ["anagrafica","disegni","lavorazioni","appunti","contatti"];
    const disFiltrati = disegni.filter(d => d.categoria === disTab);
    // Misuratore aperto su un file del cantiere
    if (misuraFile) {
      return <MisuratoreDisegno user={user} projectId={sel.id} projectName={sel.clientName||sel.name} fileUrl={misuraFile.url} fileName={misuraFile.nome} onBack={() => setMisuraFile(null)} />;
    }
    return (
      <div style={{ paddingBottom:80, flex:1, overflowY:"auto" }} className="fu">
        {/* Header */}
        <div style={{ background:`linear-gradient(135deg,${C.mid},${C.blue}40)`, padding:"16px 16px 0", borderBottom:`1px solid ${C.border}` }}>
          <button onClick={()=>setSel(null)} style={{ background:"none", border:"none", color:C.accent, fontSize:13, cursor:"pointer", fontFamily:"Barlow", marginBottom:8 }}>← Cantieri</button>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:4 }}>
            <div style={{ flex:1 }}>
              {sel.code && <div style={{ fontSize:10, color:C.accent, fontWeight:700, letterSpacing:1, marginBottom:4 }}>{sel.code}</div>}
              <div style={{ fontFamily:"Barlow Condensed", fontWeight:800, fontSize:22 }}>{sel.clientName || sel.name}</div>
              {sel.name && sel.name !== sel.clientName && <div style={{ fontSize:12, color:C.accent, marginTop:2 }}>{sel.name}</div>}
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

          {/* APPUNTI */}
          {tab === "appunti" && (
            <AppuntiCantiere
              user={user}
              projectId={sel.id}
              projectName={sel.clientName || sel.name}
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
  return (
    <div style={{ paddingBottom:80, flex:1, overflowY:"auto", padding:"16px 16px 80px" }} className="fu">
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
    getDocs(query(collection(db,"richieste_assenza"),where("operaioId","==",user.uid))).then(s=>setFerie(s.docs.map(d=>({id:d.id,...d.data()}))));
    getDocs(query(collection(db,"documenti_operai"),where("operaioId","==",user.uid))).then(s=>setBuste(s.docs.map(d=>({id:d.id,...d.data()}))));
  }, [user.uid]);

  const reload = () => {
    getDocs(query(collection(db,"timesheets"),where("workerId","==",user.uid),orderBy("date","desc"))).then(s=>setRapportini(s.docs.map(d=>({id:d.id,...d.data()}))));
    getDocs(query(collection(db,"richieste_assenza"),where("operaioId","==",user.uid))).then(s=>setFerie(s.docs.map(d=>({id:d.id,...d.data()}))));
  };

  const inviaFerie = async () => {
    if (!ferF.dal) return;
    const r = await addDoc(collection(db,"richieste_assenza"), {
      operaioId:user.uid, operaioNome:user.nome||user.displayName||"",
      tipo:ferF.tipo, dal:ferF.dal, al:ferF.al||ferF.dal, note:ferF.note,
      stato:"in_attesa", createdAt:serverTimestamp()
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
          {tab==="documenti" && (
            <>
              {buste.length===0 && <Empty icon="📄" msg="Nessun documento disponibile. L'amministrazione li caricherà qui." />}
              {buste.map(b => (
                <Card key={b.id}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                    <div>
                      <div style={{ fontWeight:700, fontSize:14 }}>{b.tipo==="busta_paga"?"📄":"📋"} {b.nome||b.mese||b.tipo||"Documento"}</div>
                      <div style={{ fontSize:11, color:C.textDim, marginTop:3 }}>
                        {b.tipo && <span style={{ background:`${C.accent}20`, color:C.accent, padding:"1px 6px", borderRadius:4, fontSize:10, fontWeight:600, marginRight:6 }}>{b.tipo==="busta_paga"?"Busta paga":b.tipo==="contratto"?"Contratto":b.tipo==="attestato"?"Attestato":b.tipo}</span>}
                        {b.data && new Date(b.data).toLocaleDateString("it-IT")}
                      </div>
                    </div>
                    {b.url && <a href={b.url} target="_blank" rel="noreferrer"><Btn label="↓ Scarica" small variant="ghost" /></a>}
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
    getDocs(query(collection(db,"richieste_assenza"),where("stato","==","in_attesa"))).then(s=>setFerie(s.docs.map(d=>({id:d.id,...d.data()}))));
    getDocs(collection(db,"richieste_assenza")).then(s=>setTutteFerie(s.docs.map(d=>({id:d.id,...d.data()}))));
    getDocs(collection(db,"utenti")).then(s=>setUtenti(s.docs.map(d=>({id:d.id,...d.data()}))));
    getDocs(collection(db,"rapportini")).then(s=>setRapportini(s.docs.map(d=>({id:d.id,...d.data()}))));
    getDocs(collection(db,"programma")).then(s=>setProgrammi(s.docs.map(d=>({id:d.id,...d.data()}))));
  }, []);

  const approvaFeria = async (id, stato) => {
    await updateDoc(doc(db,"richieste_assenza",id),{stato});
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
  const fCol = { approvata:C.green, "in_attesa":C.gold, "in attesa":C.gold, rifiutata:C.red };

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
            <div style={{ fontWeight:700, fontSize:15 }}>{c.clientName || c.name}</div>
            {c.address && <div style={{ fontSize:11, color:C.textMuted, marginTop:2 }}>📍 {c.address}</div>}
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

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState("dashboard");
  const [altroOpen, setAltroOpen] = useState(false);
  const [appuntiCantiere, setAppuntiCantiere] = useState(null);
  const [misuratoreProgetto, setMisuratoreProgetto] = useState(null);
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
          // Init notifiche push
          try {
            if ("Notification" in window && Notification.permission !== "denied") {
              import("firebase/messaging").then(async ({ getMessaging, getToken }) => {
                try {
                  const perm = await Notification.requestPermission();
                  if (perm !== "granted") return;
                  const messaging = getMessaging();
                  const token = await getToken(messaging, { vapidKey: process.env.REACT_APP_FCM_VAPID_KEY });
                  if (token) await updateDoc(doc(db,"utenti",fu.uid), { fcmToken: token });
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

  if (loading) return (
    <>
      <style>{globalCss}</style>
      <SplashScreen />
    </>
  );

  if (!user) return <LoginScreen onLogin={u=>{ setUser(u); setSection(u.ruolo==="operaio"?"personale":"dashboard"); }} />;

  const isOp = user.ruolo === "operaio";
  const navAll = isOp ? [
    { id:"cantieri",   icon:"🏗", label:"Cantieri" },
    { id:"personale",  icon:"👤", label:"Personale" },
    { id:"chat",       icon:"💬", label:"Chat" },
    { id:"altro",      icon:"⋯",  label:"Altro" },
  ] : [
    { id:"dashboard",  icon:"🏠", label:"Home" },
    { id:"cantieri",   icon:"🏗", label:"Cantieri" },
    { id:"chat",       icon:"💬", label:"Chat" },
    { id:"personale",  icon:"👤", label:"Personale" },
    { id:"altro",      icon:"⋯",  label:"Altro" },
  ];
  const navItems = navAll;

  const altroItems = [
    ...(isOp ? [
      { id:"procedure",      icon:"📋", label:"Manuale lavorazioni" },
      { id:"misuratore_hub", icon:"📐", label:"Misuratore" },
      { id:"appunti_hub",    icon:"📷", label:"Appunti cantiere" },
      { id:"regolamento",    icon:"📜", label:"Regolamento" },
    ] : [
      { id:"cronoprogramma", icon:"📅", label:"Cronoprogramma" },
      { id:"procedure",      icon:"📋", label:"Manuale lavorazioni" },
      { id:"appunti_hub",    icon:"📷", label:"Appunti cantiere" },
      { id:"misuratore_hub", icon:"📐", label:"Misuratore" },
      { id:"regolamento",    icon:"📜", label:"Regolamento" },
    ]),
    ...(isManager(user.ruolo)?[{ id:"gestione", icon:"⚙", label:"Gestione" }]:[]),
  ];

  const titles = { dashboard:"Dashboard", cantieri:"Cantieri", chat:"Chat", personale:"Area Personale", cronoprogramma:"Cronoprogramma", procedure:"Procedure", regolamento:"Regolamento", gestione:"Gestione", appunti_hub:"Appunti cantiere", misuratore_hub:"Misuratore" };

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
      {section==="appunti_hub"    && !appuntiCantiere && <AppuntiHub user={user} onSelect={c => setAppuntiCantiere(c)} />}
      {section==="appunti_hub"    && appuntiCantiere && <AppuntiCantiere user={user} projectId={appuntiCantiere.id} projectName={appuntiCantiere.clientName||appuntiCantiere.name} onBack={() => setAppuntiCantiere(null)} />}
      {section==="misuratore_hub" && !misuratoreProgetto && <MisuratoreHub user={user} onSelect={p => setMisuratoreProgetto(p)} />}
      {section==="misuratore_hub" && misuratoreProgetto && <MisuratoreDisegno user={user} projectId={misuratoreProgetto.id} projectName={misuratoreProgetto.clientName||misuratoreProgetto.name} onBack={() => setMisuratoreProgetto(null)} />}

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
      <nav style={{ position:"fixed", bottom:0, left:"50%", transform:"translateX(-50%)", width:"100%", maxWidth:480, background:C.surface, borderTop:`1px solid ${C.border}`, display:"flex", zIndex:200, paddingBottom:"env(safe-area-inset-bottom)" }}>
        {navItems.map(n => {
          const active = n.id==="altro" ? altroItems.map(i=>i.id).includes(section) : section===n.id;
          return (
            <button key={n.id} onClick={()=>n.id==="altro"?setAltroOpen(!altroOpen):(setSection(n.id),setAppuntiCantiere(null),setMisuratoreProgetto(null))}
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
