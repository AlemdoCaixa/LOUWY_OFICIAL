import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  Bell, CalendarDays, Camera, CheckCheck, Compass, CreditCard, Home, ImageIcon, Library, ListMusic, LockKeyhole, LogOut,
  Music2, Settings2, SlidersHorizontal, Upload, Users, X
} from "lucide-react";
import "./App.css";
import AuthScreen from "./AuthScreen";
import CommunityModule from "./CommunityModule";
import InstitutionalHome from "./InstitutionalHome";
import TeamModule from "./TeamModule";
import Studio from "./Studio";
import { responseData } from "./api";
import { formatPlanPrice, planMemberLabel, PLANS } from "./plans";
import { isInstitutionalHostname } from "./authChurch";
import type { BillingSummary, BrandingSettings, Member, PlanId, Song, UserNotification, UserProfile, View, Workspace } from "./types";

const DEFAULT_BRANDING: BrandingSettings = {
  productName: "Louwy",
  organizationName: "Louwy",
  logoUrl: "/pwa/icon-512.png",
  accentColor: "#d8b247"
};
type InstitutionalMode = "landing" | "church" | "register";
function initialInstitutionalMode():InstitutionalMode{
  const access=new URLSearchParams(window.location.search).get("access");
  return access==="church"||access==="register"?access:"landing";
}
const EMPTY_PROFILE: UserProfile = { folders: [], library: [], playlists: [] };
const EMPTY_WORKSPACE: Workspace = {
  branding: DEFAULT_BRANDING,
  members: [],
  teams: [],
  events: [],
  agenda: [],
  profiles: {}
};

export default function App() {
  const institutionalHost=isInstitutionalHostname();
  const [institutionalMode,setInstitutionalMode]=useState<InstitutionalMode>(initialInstitutionalMode);
  const [view,setView]=useState<View>("home");
  const [catalog,setCatalog]=useState<Song[]>([]);
  const [workspace,setWorkspace]=useState<Workspace>(EMPTY_WORKSPACE);
  const [branding,setBranding]=useState<BrandingSettings>(DEFAULT_BRANDING);
  const [brandingOpen,setBrandingOpen]=useState(false);
  const [billingOpen,setBillingOpen]=useState(false);
  const [accountOpen,setAccountOpen]=useState(false);
  const [notifications,setNotifications]=useState<UserNotification[]>([]);
  const [notificationsOpen,setNotificationsOpen]=useState(false);
  const [notificationsLoading,setNotificationsLoading]=useState(false);
  const [sessionMember,setSessionMember]=useState<Member|null>(null);
  const [activeSong,setActiveSong]=useState<Song|null>(null);
  const [authLoading,setAuthLoading]=useState(true);
  const [appLoading,setAppLoading]=useState(false);
  const [needsMasterSetup,setNeedsMasterSetup]=useState(false);
  const [applicationError,setApplicationError]=useState("");
  const profileSavingRef=useRef(false);

  async function refreshCatalog(){
    const response=await fetch("/api/catalog");
    if(response.status===401)throw new Error("UNAUTHORIZED");
    const rows=await responseData<Song[]>(response,"Não foi possível carregar o catálogo.");
    if(!Array.isArray(rows))throw new Error("O catálogo retornou dados inválidos.");
    setCatalog(rows);
  }

  async function refreshWorkspace(){
    const response=await fetch("/api/workspace");
    if(response.status===401)throw new Error("UNAUTHORIZED");
    const data=await responseData<Workspace>(response,"Não foi possível carregar os dados do ministério.");
    if(!Array.isArray(data.members)||!Array.isArray(data.events))throw new Error("O ministério retornou dados inválidos.");
    setWorkspace(data);
    if(data.branding)setBranding(data.branding);
  }

  async function refreshNotifications(){
    setNotificationsLoading(true);
    try{
      const response=await fetch("/api/notifications");
      if(response.status===401)throw new Error("UNAUTHORIZED");
      const data=await responseData<{notifications:UserNotification[]}>(response,"Não foi possível carregar as notificações.");
      setNotifications(Array.isArray(data.notifications)?data.notifications:[]);
    }finally{setNotificationsLoading(false);}
  }

  async function loadApplication(){
    setAppLoading(true);setApplicationError("");
    try{
      await Promise.all([refreshCatalog(),refreshWorkspace(),refreshNotifications().catch(()=>{})]);
    }catch(error){
      if(error instanceof Error&&error.message==="UNAUTHORIZED")setSessionMember(null);
      else setApplicationError(error instanceof Error?error.message:"Não foi possível carregar seus dados.");
    }finally{setAppLoading(false);}
  }

  useEffect(()=>{
    let cancelled=false;
    async function bootstrap(){
      try{
        const brandResponse=await fetch("/api/branding");
        if(brandResponse.ok){
          const brand=await brandResponse.json();
          if(!cancelled)setBranding(brand);
        }
        if(institutionalHost)return;
        const response=await fetch("/api/auth/me");
        if(response.ok){
          const data=await response.json();
          if(!cancelled){
            setSessionMember(data.member);
            await loadApplication();
          }
          return;
        }
        const status=await fetch("/api/auth/bootstrap-status");
        const data=await status.json();
        if(!cancelled)setNeedsMasterSetup(Boolean(data.needsMasterSetup));
      }catch{
        if(!cancelled)setNeedsMasterSetup(false);
      }finally{
        if(!cancelled)setAuthLoading(false);
      }
    }
    void bootstrap();
    return()=>{cancelled=true;};
  },[institutionalHost]);

  useEffect(()=>{
    const accent=/^#[0-9a-f]{6}$/i.test(branding.accentColor||"")?String(branding.accentColor):"#d8ff55";
    document.documentElement.style.setProperty("--tenant-accent",accent);
    document.title=institutionalHost?"Louwy | Plataforma para ministérios de louvor":`${branding.organizationName} | Louwy`;
    return()=>{document.documentElement.style.removeProperty("--tenant-accent");};
  },[branding.accentColor,branding.organizationName,institutionalHost]);

  const sessionMemberId=sessionMember?.id;
  useEffect(()=>{
    if(!sessionMemberId)return;
    const update=()=>void refreshNotifications().catch(()=>{});
    const timer=window.setInterval(update,30000);
    window.addEventListener("focus",update);
    return()=>{window.clearInterval(timer);window.removeEventListener("focus",update);};
  },[sessionMemberId]);

  useEffect(()=>{
    if(!sessionMemberId)return;
    const url=new URL(window.location.href);
    const billingResult=url.searchParams.get("billing");
    if(!billingResult)return;
    setBillingOpen(true);
    const synchronize=async()=>{
      if(billingResult==="return")await fetch("/api/billing/sync",{method:"POST"}).catch(()=>{});
      await refreshWorkspace().catch(()=>{});
    };
    const timers=[500,2500,7000].map((delay)=>window.setTimeout(()=>void synchronize(),delay));
    url.searchParams.delete("billing");url.searchParams.delete("session_id");
    window.history.replaceState(null,"",url.pathname+(url.search||"")+url.hash);
    return()=>timers.forEach((timer)=>window.clearTimeout(timer));
  },[sessionMemberId]);

  async function handleAuthenticated(member:Member){
    setSessionMember(member);
    setNeedsMasterSetup(false);
    setView("home");
    await loadApplication();
  }

  async function logout(){
    await fetch("/api/auth/logout",{method:"POST"}).catch(()=>{});
    setSessionMember(null);
    setWorkspace(EMPTY_WORKSPACE);
    setCatalog([]);
    setNotifications([]);
    setNotificationsOpen(false);
    setBrandingOpen(false);
    setBillingOpen(false);
    setAccountOpen(false);
    setApplicationError("");
    setActiveSong(null);
    setView("home");
  }

  const currentUserId=sessionMember?.id||"";
  const currentUser=workspace.members.find((member)=>member.id===currentUserId)||sessionMember;
  const isMaster=currentUser?.role==="master";
  const canCustomizeOrganization=isMaster||Boolean(currentUser?.permissions?.includes("branding"));
  const profile=workspace.profiles?.[currentUserId]||EMPTY_PROFILE;
  const unreadNotifications=useMemo(()=>notifications.filter((notification)=>!notification.readAt).length,[notifications]);

  const personalSongs=useMemo(()=>{
    const ids=new Set(profile.library.map((entry)=>entry.songId));
    return catalog.filter((song)=>ids.has(song.id));
  },[catalog,profile.library]);

  const upcomingEvents=useMemo(()=>{
    const now=new Date();
    const today=String(now.getFullYear())+"-"+String(now.getMonth()+1).padStart(2,"0")+"-"+String(now.getDate()).padStart(2,"0");
    return workspace.events
      .filter((event)=>!event.archived&&(isMaster||event.participants.some((item)=>item.memberId===currentUserId))&&event.date>=today)
      .slice()
      .sort((a,b)=>(a.date+" "+a.time).localeCompare(b.date+" "+b.time))
      .slice(0,4);
  },[workspace.events,isMaster,currentUserId]);

  async function saveProfile(next:UserProfile){
    if(!currentUserId)throw new Error("Entre novamente para salvar suas alterações.");
    if(profileSavingRef.current)throw new Error("Aguarde a alteração anterior terminar e tente novamente.");
    profileSavingRef.current=true;
    try{
      const response=await fetch("/api/profile/"+currentUserId,{
        method:"PUT",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({profile:next})
      });
      if(response.status===401){await logout();throw new Error("Sua sessão expirou. Entre novamente.");}
      const saved=await responseData<UserProfile>(response,"Não foi possível salvar suas alterações.");
      setWorkspace((prev)=>({...prev,profiles:{...prev.profiles,[currentUserId]:saved}}));
    }finally{profileSavingRef.current=false;}
  }

  async function addToMyLibrary(song:Song){
    if(profile.library.some((entry)=>entry.songId===song.id))return;
    await saveProfile({
      ...profile,
      library:profile.library.concat({
        songId:song.id,
        preferredShift:0,
        preferredSpeed:1,
        preferredInstrument:"original",
        favorite:false
      })
    });
  }

  function openStudio(song:Song){setActiveSong(song);setView("studio");}
  const updateSong=useCallback((updated:Pick<Song,"id">&Partial<Song>)=>{setCatalog((prev)=>prev.map((song)=>song.id===updated.id?{...song,...updated}:song));setActiveSong((current)=>current?.id===updated.id?{...current,...updated}:current);},[]);

  async function markNotificationRead(notification:UserNotification){
    if(notification.readAt)return;
    const readAt=new Date().toISOString();
    setNotifications((prev)=>prev.map((item)=>item.id===notification.id?{...item,readAt}:item));
    try{
      const response=await fetch(`/api/notifications/${notification.id}/read`,{method:"PATCH"});
      if(!response.ok)throw new Error("Falha ao marcar notificação.");
    }catch{setNotifications((prev)=>prev.map((item)=>item.id===notification.id?{...item,readAt:notification.readAt}:item));}
  }

  async function openNotification(notification:UserNotification){
    await markNotificationRead(notification);
    setNotificationsOpen(false);
    if(notification.type==="team"){setView("team");return;}
    if(notification.eventId){setView("schedule");return;}
  }

  async function markAllNotificationsRead(){
    if(!unreadNotifications)return;
    const readAt=new Date().toISOString();
    setNotifications((prev)=>prev.map((item)=>item.readAt?item:{...item,readAt}));
    try{
      const response=await fetch("/api/notifications/read-all",{method:"POST"});
      if(!response.ok)throw new Error("Falha ao marcar notificações.");
    }catch{setNotifications((prev)=>prev.map((item)=>({...item,readAt:notifications.find((original)=>original.id===item.id)?.readAt})));}
  }

  function updateCurrentMember(member:Member){
    setSessionMember(member);
    setWorkspace((prev)=>({...prev,members:prev.members.map((item)=>item.id===member.id?member:item)}));
  }

  function openInstitutional(mode:Exclude<InstitutionalMode,"landing">){
    window.history.replaceState(null,"",`/?access=${mode}`);
    setInstitutionalMode(mode);
  }

  function closeInstitutionalAccess(){
    window.history.replaceState(null,"","/");
    setInstitutionalMode("landing");
  }

  if(authLoading)return <div className="app-loader"><img className="loader-ministry-logo" src={branding.logoUrl} alt={branding.organizationName}/><strong>Preparando o Louwy...</strong></div>;
  if(institutionalHost){
    if(institutionalMode==="landing")return <InstitutionalHome onAccess={()=>openInstitutional("church")} onRegister={()=>openInstitutional("register")}/>;
    return <AuthScreen branding={DEFAULT_BRANDING} needsMasterSetup={false} initialMode={institutionalMode} onInstitutionalBack={closeInstitutionalAccess} onAuthenticated={(member)=>void handleAuthenticated(member)}/>;
  }
  if(!sessionMember)return <AuthScreen branding={branding} needsMasterSetup={needsMasterSetup} onAuthenticated={(member)=>void handleAuthenticated(member)}/>;

  const navItems=[
    ["home",Home,"Início"],
    ["library",Library,"Biblioteca"],
    ["explore",Compass,"Explorar"],
    ["playlists",ListMusic,"Playlists"],
    ["team",Users,"Pessoas & equipes"],
    ["schedule",CalendarDays,"Eventos"],
    ["studio",SlidersHorizontal,"Estúdio"]
  ] as const;
  const appStyle={"--tenant-accent":branding.accentColor||"#d8ff55"} as CSSProperties;

  return <div className="app" style={appStyle}>
    <aside className="sidebar">
      <div className="sidebar-branding">
        <div className="tenant-brand-card" aria-label="Logo da organização">
          {branding.logoUrl?<img className="sidebar-ministry-logo" src={branding.logoUrl} alt={branding.organizationName}/>:<div className="tenant-logo-fallback"><ImageIcon size={22}/></div>}
        </div>
      </div>
      <nav className="nav">{navItems.map(([id,Icon,label])=><button key={id} className={"nav-button "+(view===id?"active":"")} onClick={()=>setView(id)}><Icon size={18}/>{label}</button>)}</nav>
      <div className="sidebar-foot personalize-foot">
        {isMaster&&<button className="account-plan-button" onClick={()=>setBillingOpen(true)}><CreditCard size={16}/> Plano</button>}
        <button className="account-personalize-button" disabled={!canCustomizeOrganization} title={canCustomizeOrganization?"Personalizar organização":"Sua conta não tem permissão para personalizar"} onClick={()=>{if(canCustomizeOrganization)setBrandingOpen(true);}}><Settings2 size={16}/> Personalizar</button>
      </div>
    </aside>

    <main>
      <div className="topbar">
        <div className="topbar-left"><img className="mobile-top-logo" src={branding.logoUrl} alt={branding.organizationName}/><div className="topbar-product-text">Louwy - Plataforma para ministérios de louvor.</div></div>
        <div className="top-account">
          <div className="notification-center">
            <button className={"notification-button "+(notificationsOpen?"active":"")} title="Notificações" aria-label={`Notificações${unreadNotifications?` · ${unreadNotifications} não lidas`:""}`} onClick={()=>{const next=!notificationsOpen;setNotificationsOpen(next);if(next)void refreshNotifications().catch(()=>{});}}>
              <Bell size={18}/>{unreadNotifications>0&&<span className="notification-badge">{unreadNotifications>99?"99+":unreadNotifications}</span>}
            </button>
            {notificationsOpen&&<>
              <button className="notification-scrim" aria-label="Fechar notificações" onClick={()=>setNotificationsOpen(false)}/>
              <section className="notification-panel">
                <header className="notification-panel-head"><div><strong>Notificações</strong><span>{unreadNotifications?`${unreadNotifications} não ${unreadNotifications===1?"lida":"lidas"}`:"Tudo em dia"}</span></div>{unreadNotifications>0&&<button onClick={()=>void markAllNotificationsRead()}><CheckCheck size={14}/> Marcar todas</button>}</header>
                <div className="notification-list">
                  {notificationsLoading&&notifications.length===0&&<div className="notification-empty">Carregando atualizações...</div>}
                  {!notificationsLoading&&notifications.length===0&&<div className="notification-empty"><Bell size={24}/><strong>Nenhuma notificação</strong><span>As atualizações que afetam você aparecerão aqui.</span></div>}
                  {notifications.map((notification)=><button key={notification.id} className={"notification-item "+(!notification.readAt?"unread":"")} onClick={()=>void openNotification(notification)}>
                    <span className="notification-kind">{notificationGlyph(notification.type)}</span>
                    <span className="notification-copy"><strong>{notification.title}</strong><span>{notification.message}</span><time>{relativeNotificationTime(notification.createdAt)}</time></span>
                    {!notification.readAt&&<i className="notification-unread-dot"/>}
                  </button>)}
                </div>
              </section>
            </>}
          </div>
          <button className="top-account-profile" title="Minha conta" onClick={()=>setAccountOpen(true)}><UserAvatar member={currentUser} className="small-account"/><div><strong>{currentUser?.name}</strong><span>{isMaster?"Administrador":"Minha conta"}</span></div></button><button className="icon-btn" title="Sair" onClick={()=>void logout()}><LogOut size={16}/></button>
        </div>
      </div>

      {appLoading&&<div className="panel">Carregando seus dados...</div>}
      {!appLoading&&applicationError&&<div className="panel notice error" role="alert">{applicationError}<button className="secondary" onClick={()=>void loadApplication()}>Tentar novamente</button></div>}

      {!appLoading&&!applicationError&&view==="home"&&<>
        <section className="hero"><div className="eyebrow">Seu ambiente de louvor</div><h1>Pessoas, eventos e preparação musical no mesmo lugar.</h1><p>O administrador cria equipes e eventos. Cada músico acessa sua própria biblioteca, preferências e escalas.</p><div className="actions"><button className="primary" onClick={()=>setView("schedule")}><CalendarDays size={17}/> Ver meus eventos</button><button className="secondary" onClick={()=>setView("explore")}><Compass size={17}/> Explorar músicas</button></div></section>
        <div className="grid-3"><div className="panel"><div className="stat">{profile.library.length}</div><div className="stat-label">Músicas na minha biblioteca</div></div><div className="panel"><div className="stat">{upcomingEvents.length}</div><div className="stat-label">Próximos eventos</div></div><div className="panel"><div className="stat">{catalog.length}</div><div className="stat-label">Músicas no catálogo global</div></div></div>
        <section className="section"><div className="section-head"><h2>Próximos eventos</h2><button className="ghost" onClick={()=>setView("schedule")}>Ver agenda</button></div><div className="home-events">{upcomingEvents.length===0&&<div className="panel muted">Nenhum evento futuro para esta conta.</div>}{upcomingEvents.map((event)=><button key={event.id} className="home-event" onClick={()=>setView("schedule")}><div className="home-event-date"><strong>{event.date.split("-")[2]}</strong><span>{monthShort(event.date)}</span></div><div><strong>{event.title}</strong><span>{event.time||"Sem horário"} · {event.participants.length} participantes · {event.songs.length} músicas</span></div></button>)}</div></section>
        <section className="section"><div className="section-head"><h2>Minha biblioteca recente</h2><button className="ghost" onClick={()=>setView("library")}>Abrir biblioteca</button></div><div className="home-song-strip">{personalSongs.slice(0,5).map((song)=><button key={song.id} className="home-song" onClick={()=>openStudio(song)}>{song.cover?<img src={song.cover}/>:<div className="home-song-cover"><Music2 size={20}/></div>}<div><strong>{song.title}</strong><span>{song.artist}</span></div></button>)}{personalSongs.length===0&&<div className="panel muted">Sua biblioteca ainda está vazia.</div>}</div></section>
      </>}

      {!appLoading&&!applicationError&&(view==="library"||view==="explore"||view==="playlists")&&<CommunityModule mode={view} catalog={catalog} profile={profile} currentUserId={currentUserId} isMaster={isMaster} onProfileChange={saveProfile} onCatalogRefresh={refreshCatalog} onOpenStudio={openStudio}/>} 
      {!appLoading&&!applicationError&&(view==="team"||view==="schedule")&&<TeamModule mode={view} workspace={workspace} currentUserId={currentUserId} catalog={catalog} profile={profile} onRefresh={refreshWorkspace} onCatalogRefresh={refreshCatalog} onOpenStudio={openStudio} onSaveToMyLibrary={addToMyLibrary} onProfileChange={saveProfile} onOpenBilling={()=>setBillingOpen(true)}/>} 
      {!appLoading&&!applicationError&&view==="studio"&&<Studio key={(activeSong||personalSongs[0]||catalog[0])?.id||"empty"} song={activeSong||personalSongs[0]||catalog[0]||null} profile={profile} currentUserId={currentUserId} isMaster={isMaster} onChoose={()=>setView("library")} onProfileChange={saveProfile} onSongUpdate={updateSong}/>} 
    </main>

    <div className="bottom-nav">{navItems.map(([id,Icon,label])=><button key={id} className={view===id?"active":""} onClick={()=>setView(id)}><Icon size={18}/>{label}</button>)}</div>
    {brandingOpen&&<BrandingModal branding={branding} onClose={()=>setBrandingOpen(false)} onSaved={(next)=>{setBranding(next);setWorkspace((prev)=>({...prev,branding:next}));setBrandingOpen(false);}}/>}
    {billingOpen&&isMaster&&<BillingModal billing={workspace.billing} currentUser={currentUser} onClose={()=>setBillingOpen(false)} onSaved={async()=>{await refreshWorkspace();}}/>}
    {accountOpen&&currentUser&&<AccountModal member={currentUser} onClose={()=>setAccountOpen(false)} onSaved={updateCurrentMember}/>}
  </div>;
}

function UserAvatar({member,className=""}:{member:Member|null|undefined;className?:string}){
  const classes=`account-avatar ${className} ${member?.avatarUrl?"account-avatar-photo":""}`.trim();
  return member?.avatarUrl?<img className={classes} src={member.avatarUrl} alt={member.name||"Foto da conta"}/>:<span className={classes}>{initials(member?.name||"U")}</span>;
}

function AccountModal({member,onClose,onSaved}:{member:Member;onClose:()=>void;onSaved:(member:Member)=>void}){
  const [name,setName]=useState(member.name);
  const [avatarFile,setAvatarFile]=useState<File|null>(null);
  const [preview,setPreview]=useState(member.avatarUrl||"");
  const [removeAvatar,setRemoveAvatar]=useState(false);
  const [profileSaving,setProfileSaving]=useState(false);
  const [profileError,setProfileError]=useState("");
  const [profileSuccess,setProfileSuccess]=useState("");
  const [currentPassword,setCurrentPassword]=useState("");
  const [newPassword,setNewPassword]=useState("");
  const [confirmation,setConfirmation]=useState("");
  const [passwordSaving,setPasswordSaving]=useState(false);
  const [passwordError,setPasswordError]=useState("");
  const [passwordSuccess,setPasswordSuccess]=useState("");

  useEffect(()=>()=>{if(preview.startsWith("blob:"))URL.revokeObjectURL(preview);},[preview]);

  function selectAvatar(file:File|null){
    if(!file)return;
    if(preview.startsWith("blob:"))URL.revokeObjectURL(preview);
    setAvatarFile(file);setPreview(URL.createObjectURL(file));setRemoveAvatar(false);setProfileError("");setProfileSuccess("");
  }

  function clearAvatar(){
    if(preview.startsWith("blob:"))URL.revokeObjectURL(preview);
    setAvatarFile(null);setPreview("");setRemoveAvatar(true);setProfileSuccess("");
  }

  async function saveProfile(){
    if(name.trim().length<2)return;
    setProfileSaving(true);setProfileError("");setProfileSuccess("");
    try{
      const body=new FormData();body.append("name",name.trim());body.append("removeAvatar",String(removeAvatar));if(avatarFile)body.append("avatar",avatarFile);
      const response=await fetch("/api/account",{method:"POST",body});
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(data.error||"Não foi possível atualizar sua conta.");
      onSaved(data.member as Member);setAvatarFile(null);setRemoveAvatar(false);setPreview(data.member.avatarUrl||"");setProfileSuccess("Dados atualizados.");
    }catch(issue){setProfileError(issue instanceof Error?issue.message:"Não foi possível atualizar sua conta.");}
    finally{setProfileSaving(false);}
  }

  async function changePassword(){
    setPasswordSaving(true);setPasswordError("");setPasswordSuccess("");
    try{
      const response=await fetch("/api/auth/change-password",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({currentPassword,newPassword,confirmation})});
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(data.error||"Não foi possível alterar a senha.");
      setCurrentPassword("");setNewPassword("");setConfirmation("");setPasswordSuccess("Senha alterada com segurança.");
    }catch(issue){setPasswordError(issue instanceof Error?issue.message:"Não foi possível alterar a senha.");}
    finally{setPasswordSaving(false);}
  }

  return <div className="modal-backdrop" onMouseDown={onClose}><div className="modal account-modal" onMouseDown={(event)=>event.stopPropagation()}>
    <div className="account-modal-head"><div><div className="eyebrow">Minha conta</div><h2>Perfil e segurança</h2><p>Atualize como seu nome e sua foto aparecem no Louwy.</p></div><button className="icon-btn" onClick={onClose}><X size={17}/></button></div>
    <section className="account-section">
      <div className="account-section-title"><Camera size={17}/><div><strong>Perfil</strong><span>Nome e foto do seu usuário.</span></div></div>
      <div className="account-avatar-editor">
        {preview?<img src={preview} alt="Prévia do avatar"/>:<div className="account-avatar account-avatar-large">{initials(name||member.name)}</div>}
        <div><label className="account-upload-avatar"><Upload size={15}/> Escolher foto<input hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event)=>selectAvatar(event.target.files?.[0]||null)}/></label>{preview&&<button className="account-remove-avatar" onClick={clearAvatar}>Remover foto</button>}<small>PNG, JPG ou WebP · até 5 MB</small></div>
      </div>
      <label className="field"><span>NOME</span><input value={name} onChange={(event)=>setName(event.target.value)} maxLength={80}/></label>
      {profileError&&<div className="notice error">{profileError}</div>}{profileSuccess&&<div className="notice">{profileSuccess}</div>}
      <div className="actions"><button className="primary" disabled={profileSaving||name.trim().length<2} onClick={()=>void saveProfile()}>{profileSaving?"Salvando...":"Salvar perfil"}</button></div>
    </section>
    <section className="account-section account-security-section">
      <div className="account-section-title"><LockKeyhole size={17}/><div><strong>Trocar senha</strong><span>Confirme sua senha atual antes de criar outra.</span></div></div>
      <div className="form-grid two"><label className="field span-2"><span>SENHA ATUAL</span><input type="password" value={currentPassword} onChange={(event)=>setCurrentPassword(event.target.value)}/></label><label className="field"><span>NOVA SENHA</span><input type="password" value={newPassword} onChange={(event)=>setNewPassword(event.target.value)} placeholder="Mínimo de 6 caracteres"/></label><label className="field"><span>CONFIRMAR NOVA SENHA</span><input type="password" value={confirmation} onChange={(event)=>setConfirmation(event.target.value)}/></label></div>
      {passwordError&&<div className="notice error">{passwordError}</div>}{passwordSuccess&&<div className="notice">{passwordSuccess}</div>}
      <div className="actions"><button className="secondary" disabled={passwordSaving||!currentPassword||newPassword.length<6||!confirmation} onClick={()=>void changePassword()}>{passwordSaving?"Alterando...":"Alterar senha"}</button></div>
    </section>
  </div></div>;
}

function BillingModal({billing,currentUser,onClose,onSaved}:{billing:BillingSummary|undefined;currentUser:Member|null|undefined;onClose:()=>void;onSaved:()=>Promise<void>}){
  const [requesting,setRequesting]=useState<PlanId|"cancel"|"sync"|null>(null);
  const [payerEmail,setPayerEmail]=useState(currentUser?.email||billing?.subscription.payerEmail||"");
  const [message,setMessage]=useState("");
  const [error,setError]=useState("");
  const currentPlanId=billing?.subscription.planId||"free";
  const requestedPlanId=billing?.subscription.requestedPlanId||"";
  const status=billing?.subscription.status||"active";
  const nextPaymentAt=billing?.subscription.nextPaymentAt;
  const paidSubscription=currentPlanId!=="free"&&Boolean(billing?.subscription.providerSubscriptionId);

  async function requestPlan(planId:PlanId){
    setRequesting(planId);setMessage("");setError("");
    try{
      if(planId!=="free"&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerEmail.trim()))throw new Error("Informe um e-mail válido para a cobrança mensal.");
      const endpoint=planId==="free"?"/api/billing/request-plan":"/api/billing/checkout";
      const response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({planId,payerEmail:payerEmail.trim()})});
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(data.error||"Não foi possível alterar o plano.");
      if(data.url){window.location.assign(data.url);return;}
      setMessage(data.message||"Plano atualizado.");
      await onSaved();
    }catch(issue){setError(issue instanceof Error?issue.message:"Não foi possível alterar o plano.");}
    finally{setRequesting(null);}
  }

  async function syncSubscription(){
    setRequesting("sync");setMessage("");setError("");
    try{
      const response=await fetch("/api/billing/sync",{method:"POST"});
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(data.error||"Não foi possível consultar a assinatura.");
      setMessage(data.subscription?.status==="active"?"Pagamento confirmado e plano ativado.":"A assinatura ainda aguarda confirmação do Mercado Pago.");
      await onSaved();
    }catch(issue){setError(issue instanceof Error?issue.message:"Não foi possível consultar a assinatura.");}
    finally{setRequesting(null);}
  }

  async function cancelSubscription(){
    if(!confirm("Cancelar a cobrança mensal? A igreja voltará ao plano grátis e novos membros poderão ficar bloqueados acima de 5 contas."))return;
    setRequesting("cancel");setMessage("");setError("");
    try{
      const response=await fetch("/api/billing/cancel",{method:"POST"});
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(data.error||"Não foi possível cancelar a assinatura.");
      setMessage(data.message||"Assinatura cancelada.");
      await onSaved();
    }catch(issue){setError(issue instanceof Error?issue.message:"Não foi possível cancelar a assinatura.");}
    finally{setRequesting(null);}
  }

  return <div className="modal-backdrop" onMouseDown={onClose}><div className="modal billing-modal" onMouseDown={(event)=>event.stopPropagation()}>
    <div className="billing-modal-head"><div><div className="eyebrow">Plano da igreja</div><h2>Escolha o tamanho da sua equipe</h2><p>O plano grátis inclui até 5 contas ativas, contando a conta master. Os planos pagos têm cobrança mensal recorrente.</p></div><button className="icon-btn" onClick={onClose}><X size={17}/></button></div>
    <div className="billing-usage"><div><span>Uso atual</span><strong>{billing?.members||0}{billing?.memberLimit===null?" membros":` de ${billing?.memberLimit||5} membros`}</strong></div><div><span>Plano ativo</span><strong>{billing?.plan.name||"Grátis"}</strong><small>{status==="pending"?"Aguardando pagamento":status==="past_due"?"Pagamento pendente":status==="cancelled"?"Assinatura cancelada":"Ativo"}</small></div></div>
    {nextPaymentAt&&status==="active"&&<div className="billing-next-payment">Próxima cobrança mensal: <strong>{new Intl.DateTimeFormat("pt-BR",{dateStyle:"long"}).format(new Date(nextPaymentAt))}</strong></div>}
    {billing?.overLimit&&<div className="notice error">A igreja está acima do limite do plano atual. Os membros existentes continuam preservados, mas novos cadastros ficam bloqueados.</div>}
    {requestedPlanId&&requestedPlanId!==currentPlanId&&<div className="notice billing-pending-notice"><div><strong>Assinatura em andamento</strong><span>Conclua o pagamento no Mercado Pago ou atualize o status após retornar.</span></div><button className="ghost" disabled={Boolean(requesting)} onClick={()=>void syncSubscription()}>{requesting==="sync"?"Consultando...":"Atualizar status"}</button></div>}
    <label className="field billing-email-field"><span>E-MAIL PARA COBRANÇA</span><input type="email" value={payerEmail} onChange={(event)=>setPayerEmail(event.target.value)} placeholder="financeiro@suaigreja.com.br"/><small>O Mercado Pago usará este e-mail para identificar o responsável pela assinatura.</small></label>
    <div className="billing-plan-grid">{PLANS.map((plan)=>{const active=plan.id===currentPlanId;const requested=plan.id===requestedPlanId;return <article className={`billing-plan-card ${active?"active":""}`} key={plan.id}>
      <div className="billing-plan-title"><strong>{plan.name}</strong>{active&&<span>ATIVO</span>}{requested&&!active&&<span className="pending">EM PAGAMENTO</span>}</div>
      <div className="billing-plan-price"><b>{formatPlanPrice(plan.priceCents)}</b>{plan.priceCents>0&&<small>/mês</small>}</div>
      <p>{planMemberLabel(plan.memberLimit)}</p>
      <button className={active?"secondary":"primary"} disabled={Boolean(requesting)||active} onClick={()=>void requestPlan(plan.id)}>{requesting===plan.id?"Abrindo Mercado Pago...":active?"Plano atual":requested?"Retomar assinatura":plan.id==="free"?"Usar plano grátis":"Assinar mensalmente"}</button>
    </article>;})}</div>
    <div className="billing-payment-note"><CreditCard size={17}/><div><strong>Pagamento recorrente e seguro pelo Mercado Pago</strong><span>R$ 19,90, R$ 29,90 ou R$ 59,90 por mês, conforme o plano. Não é parcelamento. O plano é ativado automaticamente após a autorização.</span></div>{(paidSubscription||requestedPlanId)&&<button className="danger-outline" disabled={Boolean(requesting)} onClick={()=>void cancelSubscription()}>{requesting==="cancel"?"Cancelando...":"Cancelar assinatura"}</button>}</div>
    {message&&<div className="notice">{message}</div>}{error&&<div className="notice error">{error}</div>}
  </div></div>;
}

function BrandingModal({branding,onClose,onSaved}:{branding:BrandingSettings;onClose:()=>void;onSaved:(branding:BrandingSettings)=>void}){
  const [organizationName,setOrganizationName]=useState(branding.organizationName);
  const [accentColor,setAccentColor]=useState(branding.accentColor||"#d8ff55");
  const [logoFile,setLogoFile]=useState<File|null>(null);
  const [preview,setPreview]=useState(branding.logoUrl);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");

  useEffect(()=>()=>{if(preview.startsWith("blob:"))URL.revokeObjectURL(preview);},[preview]);

  function selectLogo(file:File|null){
    if(!file)return;
    if(preview.startsWith("blob:"))URL.revokeObjectURL(preview);
    setLogoFile(file);
    setPreview(URL.createObjectURL(file));
    setError("");
  }

  async function save(){
    if(!organizationName.trim())return;
    setSaving(true);setError("");
    try{
      const body=new FormData();
      body.append("organizationName",organizationName.trim());
      body.append("accentColor",accentColor);
      if(logoFile)body.append("logo",logoFile);
      const response=await fetch("/api/branding",{method:"POST",body});
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(data.error||"Não foi possível salvar a identidade visual.");
      onSaved(data as BrandingSettings);
    }catch(issue){setError(issue instanceof Error?issue.message:"Não foi possível salvar a identidade visual.");}
    finally{setSaving(false);}
  }

  return <div className="modal-backdrop" onMouseDown={onClose}><div className="modal branding-modal" onMouseDown={(event)=>event.stopPropagation()}>
    <div className="branding-modal-head"><div><div className="eyebrow">White-label</div><h2>Identidade da organização</h2><p>O produto continua sendo Louwy. Aqui você personaliza o espaço do seu ministério.</p></div><button className="icon-btn" onClick={onClose}><X size={17}/></button></div>
    <div className="branding-product-lock"><div><small>Nome do sistema</small><strong>Louwy</strong></div></div>
    <label className="field"><span>NOME DA ORGANIZAÇÃO</span><input value={organizationName} onChange={(event)=>setOrganizationName(event.target.value)} placeholder="Ex.: Ministério Primícias"/></label>
    <div className="branding-upload-grid">
      <div className="branding-preview">{preview?<img src={preview} alt="Prévia da logo"/>:<ImageIcon size={32}/>}</div>
      <label className="branding-upload-button"><Upload size={16}/><span>Escolher logo</span><small>PNG, JPG ou WebP · até 5 MB</small><input type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={(event)=>selectLogo(event.target.files?.[0]||null)}/></label>
    </div>
    <label className="field branding-color-field"><span>COR DE DESTAQUE</span><div><input type="color" value={accentColor} onChange={(event)=>setAccentColor(event.target.value)}/><input value={accentColor} onChange={(event)=>setAccentColor(event.target.value)}/></div></label>
    {error&&<div className="notice error">{error}</div>}
    <div className="actions"><button className="primary" disabled={saving||!organizationName.trim()} onClick={()=>void save()}>{saving?"Salvando...":"Salvar identidade"}</button><button className="ghost" onClick={onClose}>Cancelar</button></div>
  </div></div>;
}

function notificationGlyph(type:UserNotification["type"]){
  if(type==="event-invitation")return "📅";
  if(type==="event-update")return "✏️";
  if(type==="event-removed")return "🗑️";
  if(type==="repertoire")return "🎵";
  if(type==="message")return "💬";
  if(type==="file")return "📎";
  if(type==="mention")return "@";
  if(type==="attendance")return "✓";
  if(type==="team")return "👥";
  return "🔔";
}

function relativeNotificationTime(value:string){
  const date=new Date(value);
  const seconds=Math.max(0,Math.floor((Date.now()-date.getTime())/1000));
  if(!Number.isFinite(seconds))return "";
  if(seconds<60)return "agora";
  const minutes=Math.floor(seconds/60);
  if(minutes<60)return `há ${minutes} min`;
  const hours=Math.floor(minutes/60);
  if(hours<24)return `há ${hours} h`;
  const days=Math.floor(hours/24);
  if(days<7)return `há ${days} d`;
  return new Intl.DateTimeFormat("pt-BR",{day:"2-digit",month:"short"}).format(date);
}

function initials(name:string){return name.split(/\s+/).filter(Boolean).slice(0,2).map((part)=>part[0]?.toUpperCase()).join("")||"U";}
function monthShort(value:string){const parts=value.split("-").map(Number);return new Intl.DateTimeFormat("pt-BR",{month:"short"}).format(new Date(parts[0],parts[1]-1,parts[2])).replace(".","");}
