import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { ArrowLeft, Building2, Globe2, ImageIcon, LockKeyhole, Phone, ShieldCheck } from "lucide-react";
import "./AuthScreen.css";
import { churchUrl, currentChurchSlug, setCurrentChurchSlug } from "./authChurch";
import type { BrandingSettings, Member } from "./types";

type AccessMode = "login" | "church" | "register";
type Props = {
  branding: BrandingSettings;
  needsMasterSetup: boolean;
  initialMode?: AccessMode;
  onInstitutionalBack?: () => void;
  onAuthenticated: (member: Member) => void;
};

type IdentifiedMember = { id: string; name: string };
type LoginStep = "phone" | "password" | "first-access";

export default function AuthScreen({ branding, needsMasterSetup, initialMode = "login", onInstitutionalBack, onAuthenticated }: Props) {
  const [mode, setMode] = useState<AccessMode>(initialMode);
  const [step, setStep] = useState<LoginStep>("phone");
  const [identified, setIdentified] = useState<IdentifiedMember | null>(null);
  const [name, setName] = useState("Conta Master");
  const [organizationName, setOrganizationName] = useState("");
  const [churchSlug, setChurchSlug] = useState(currentChurchSlug());
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const normalizedPreview = useMemo(() => String(churchSlug || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "").slice(0, 48), [churchSlug]);

  async function request(path: string, payload: Record<string, unknown>) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Não foi possível concluir o acesso.");
    return data;
  }

  function resetAccess() {
    if(onInstitutionalBack){onInstitutionalBack();return;}
    setMode("login"); setStep("phone"); setIdentified(null);
    setPassword(""); setConfirmation(""); setError("");
  }

  async function setupMaster() {
    if (loading || !name.trim() || !phone.trim() || !password || !confirmation) return;
    setLoading(true); setError("");
    try {
      const data = await request("/api/auth/bootstrap-master", { name, phone, password, confirmation });
      onAuthenticated(data.member);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Não foi possível configurar a conta master.");
    } finally { setLoading(false); }
  }

  async function identify() {
    if (loading || !phone.trim()) return;
    setLoading(true); setError("");
    try {
      const data = await request("/api/auth/identify", { phone, churchSlug: currentChurchSlug() });
      setIdentified(data.member);
      setStep(data.firstAccess ? "first-access" : "password");
      setPassword(""); setConfirmation("");
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Celular não encontrado nesta igreja.");
    } finally { setLoading(false); }
  }

  async function authenticate() {
    if (loading || !password || (step === "first-access" && !confirmation)) return;
    setLoading(true); setError("");
    try {
      const path = step === "first-access" ? "/api/auth/first-access" : "/api/auth/login";
      const data = await request(path, { phone, password, confirmation, churchSlug: currentChurchSlug() });
      if (data.church?.slug) setCurrentChurchSlug(data.church.slug);
      onAuthenticated(data.member);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Não foi possível entrar.");
    } finally { setLoading(false); }
  }

  function goBack() {
    setStep("phone"); setIdentified(null); setPassword(""); setConfirmation(""); setError("");
  }

  function openChurch() {
    const slug = setCurrentChurchSlug(churchSlug);
    if (slug.length < 3) { setError("Informe o endereço da sua igreja."); return; }
    window.location.assign(churchUrl(slug));
  }

  async function registerChurch() {
    if (loading || !organizationName.trim() || !name.trim() || !phone.trim() || !password || !confirmation) return;
    setLoading(true); setError("");
    try {
      const data = await request("/api/auth/register-church", {
        organizationName, churchSlug: normalizedPreview, name, phone, password, confirmation,
      });
      const slug = setCurrentChurchSlug(data.church?.slug || normalizedPreview);
      const target = data.redirectUrl || churchUrl(slug);
      const localDevelopment = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" || window.location.hostname.endsWith(".localhost");
      if (!localDevelopment && new URL(target, window.location.href).origin !== window.location.origin) {
        window.location.assign(target);
        return;
      }
      onAuthenticated(data.member);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Não foi possível cadastrar a igreja.");
    } finally { setLoading(false); }
  }

  const institutionalAccess = Boolean(onInstitutionalBack);
  const theme = { "--tenant-accent": institutionalAccess ? "#00ffbc" : branding.accentColor || "#d8ff55" } as CSSProperties;

  return <div className={`auth-page ${institutionalAccess?"institutional-auth-page":""}`} style={theme}>
    <section className="auth-brand-panel">
      {institutionalAccess
        ? <div className="auth-product-mark institutional-auth-product"><img src="/branding/louwy-institucional-v2.svg" alt="Louwy"/><span>Plataforma para ministérios de louvor</span></div>
        : <div className="auth-product-mark"><strong>Louwy</strong><span>Plataforma para ministérios de louvor</span></div>}
      <div className={`auth-ministry-lockup ${institutionalAccess?"auth-institutional-message":""}`}>
        {institutionalAccess ? <>
          <h1 className="auth-institutional-title">Tudo o que o ministério de louvor precisa, em um só lugar.</h1>
          <p>Equipe, repertório, eventos e preparação musical em um só ambiente.</p>
        </> : <>
          {branding.logoUrl ? <img src={branding.logoUrl} alt={branding.organizationName}/> : <div className="auth-logo-fallback"><ImageIcon size={36}/></div>}
          <p>Equipe, repertório, eventos e preparação musical em um só ambiente.</p>
        </>}
      </div>
      <div className="auth-feature"><ShieldCheck size={18}/><span>Cada igreja possui dados, catálogo, equipes e eventos separados.</span></div>
    </section>

    <section className="auth-form-panel">
      <div className="auth-card">
        {mode === "church" ? <>
          <button className="auth-back" onClick={resetAccess}><ArrowLeft size={15}/> Voltar ao acesso</button>
          <div className="auth-icon"><Globe2 size={22}/></div>
          <div className="eyebrow">Outra igreja</div>
          <h2>Qual é o endereço?</h2>
          <p>Digite apenas a parte que vem antes de <strong>.louwy.com.br</strong>.</p>
          <label className="auth-field"><span>ENDEREÇO DA IGREJA</span><div><Globe2 size={16}/><input value={churchSlug} onChange={(event)=>setChurchSlug(event.target.value)} onKeyDown={(event)=>{if(event.key==="Enter")openChurch();}} placeholder="ex.: primicias" autoFocus/></div></label>
          {normalizedPreview&&<div className="church-url-preview">{normalizedPreview}.louwy.com.br</div>}
          {error&&<div className="auth-error">{error}</div>}
          <button className="auth-submit" disabled={!normalizedPreview||loading} onClick={openChurch}>Abrir minha igreja</button>
        </> : mode === "register" ? <>
          <button className="auth-back" onClick={resetAccess}><ArrowLeft size={15}/> Voltar ao acesso</button>
          <div className="auth-icon"><Building2 size={22}/></div>
          <div className="eyebrow">Nova igreja</div>
          <h2>Cadastre sua organização</h2>
          <p>Quem concluir o cadastro será o master responsável por esta igreja.</p>
          <label className="auth-field"><span>NOME DA IGREJA</span><input value={organizationName} onChange={(event)=>setOrganizationName(event.target.value)} placeholder="Ex.: Igreja Esperança" autoFocus/></label>
          <label className="auth-field"><span>ENDEREÇO</span><div><Globe2 size={16}/><input value={churchSlug} onChange={(event)=>setChurchSlug(event.target.value)} placeholder="esperanca"/></div></label>
          {normalizedPreview&&<div className="church-url-preview">{normalizedPreview}.louwy.com.br</div>}
          <label className="auth-field"><span>NOME DO RESPONSÁVEL</span><input value={name} onChange={(event)=>setName(event.target.value)}/></label>
          <label className="auth-field"><span>CELULAR COM DDD</span><div><Phone size={16}/><input inputMode="tel" value={phone} onChange={(event)=>setPhone(event.target.value)} placeholder="(43) 99999-9999"/></div></label>
          <label className="auth-field"><span>SENHA</span><div><LockKeyhole size={16}/><input type="password" value={password} onChange={(event)=>setPassword(event.target.value)} placeholder="Mínimo de 6 caracteres"/></div></label>
          <label className="auth-field"><span>CONFIRMAR SENHA</span><div><LockKeyhole size={16}/><input type="password" value={confirmation} onChange={(event)=>setConfirmation(event.target.value)} onKeyDown={(event)=>{if(event.key==="Enter")void registerChurch();}}/></div></label>
          {error&&<div className="auth-error">{error}</div>}
          <button className="auth-submit" disabled={loading||!organizationName.trim()||!normalizedPreview||!name.trim()||!phone.trim()||!password||!confirmation} onClick={()=>void registerChurch()}>{loading?"Cadastrando...":"Criar igreja no Louwy"}</button>
        </> : needsMasterSetup ? <>
          <div className="auth-icon"><ShieldCheck size={22}/></div>
          <div className="eyebrow">Primeira configuração</div>
          <h2>Criar acesso da conta master</h2>
          <p>Cadastre o celular e a senha que administrarão esta igreja.</p>
          <label className="auth-field"><span>NOME</span><input value={name} onChange={(event)=>setName(event.target.value)} autoFocus/></label>
          <label className="auth-field"><span>CELULAR COM DDD</span><div><Phone size={16}/><input inputMode="tel" value={phone} onChange={(event)=>setPhone(event.target.value)} placeholder="(43) 99999-9999"/></div></label>
          <label className="auth-field"><span>SENHA</span><div><LockKeyhole size={16}/><input type="password" value={password} onChange={(event)=>setPassword(event.target.value)} placeholder="Mínimo de 6 caracteres"/></div></label>
          <label className="auth-field"><span>CONFIRMAR SENHA</span><div><LockKeyhole size={16}/><input type="password" value={confirmation} onChange={(event)=>setConfirmation(event.target.value)}/></div></label>
          {error&&<div className="auth-error">{error}</div>}
          <button className="auth-submit" disabled={loading||!name.trim()||!phone.trim()||!password||!confirmation} onClick={()=>void setupMaster()}>{loading?"Configurando...":"Criar conta master"}</button>
        </> : step === "phone" ? <>
          <div className="auth-icon"><Phone size={22}/></div>
          <div className="eyebrow">Acesso pessoal</div>
          <h2>Entre pelo seu celular</h2>
          <p>Use o número cadastrado pelo gestor desta igreja.</p>
          <label className="auth-field"><span>CELULAR COM DDD</span><div><Phone size={16}/><input inputMode="tel" value={phone} onChange={(event)=>setPhone(event.target.value)} onKeyDown={(event)=>{if(event.key==="Enter")void identify();}} placeholder="(43) 99999-9999" autoFocus/></div></label>
          {error&&<div className="auth-error">{error}</div>}
          <button className="auth-submit" disabled={loading||!phone.trim()} onClick={()=>void identify()}>{loading?"Verificando...":"Continuar"}</button>
          <div className="auth-secondary-actions">
            <button onClick={()=>{setMode("church");setError("");}}><Globe2 size={14}/> Entrar em outra igreja</button>
            <button onClick={()=>{setMode("register");setName("");setPhone("");setPassword("");setConfirmation("");setError("");}}><Building2 size={14}/> Cadastrar igreja</button>
          </div>
        </> : <>
          <button className="auth-back" disabled={loading} onClick={goBack}><ArrowLeft size={15}/> Trocar celular</button>
          <div className="auth-icon"><LockKeyhole size={22}/></div>
          <div className="eyebrow">{step==="first-access"?"Primeiro acesso":"Bem-vindo de volta"}</div>
          <h2>{identified?.name}</h2>
          <p>{step==="first-access"?"Crie sua senha pessoal. Ela será usada nos próximos acessos.":"Digite sua senha para continuar."}</p>
          <label className="auth-field"><span>{step==="first-access"?"CRIAR SENHA":"SENHA"}</span><div><LockKeyhole size={16}/><input type="password" value={password} onChange={(event)=>setPassword(event.target.value)} onKeyDown={(event)=>{if(event.key==="Enter"&&step==="password")void authenticate();}} autoFocus/></div></label>
          {step==="first-access"&&<label className="auth-field"><span>CONFIRMAR SENHA</span><div><LockKeyhole size={16}/><input type="password" value={confirmation} onChange={(event)=>setConfirmation(event.target.value)} onKeyDown={(event)=>{if(event.key==="Enter")void authenticate();}}/></div></label>}
          {error&&<div className="auth-error">{error}</div>}
          <button className="auth-submit" disabled={loading||!password||(step==="first-access"&&!confirmation)} onClick={()=>void authenticate()}>{loading?"Entrando...":step==="first-access"?"Criar senha e entrar":"Entrar"}</button>
        </>}
      </div>
    </section>
  </div>;
}
