import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  CalendarDays, CheckCircle2, ChevronDown, ChevronLeft, ChevronUp,
  Clock, Copy, Download, Eye, FileText, KeyRound, MapPin, MessageCircle, Music2,
  Pencil, Plus, Save, Send, Settings2, Trash2, Upload, UserPlus, Users, X,
  XCircle
} from "lucide-react";
import "./TeamModule.css";
import { responseData } from "./api";
import { importErrorMessage, importSong, isImportCancelled } from "./importSong";
import type {
  EventAttachment, EventModule, EventModuleKind, EventSong, Member, MinistryEvent, Song, Team, UserProfile, Workspace
} from "./types";

const FUNCTION_SUGGESTIONS = [
  "Vocal", "Violão", "Guitarra", "Baixo", "Teclado", "Bateria",
  "Percussão", "Direção musical", "Playback", "Técnico de áudio"
];
const KEYS = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const MODULES: Array<{kind:EventModuleKind;title:string;description:string;emoji:string}> = [
  {kind:"participants",title:"Participantes",description:"Músicos e funções escaladas.",emoji:"👥"},
  {kind:"confirmations",title:"Confirmações",description:"Presença, ausência e pendências.",emoji:"✓"},
  {kind:"repertoire",title:"Repertório",description:"Músicas enviadas pelos ministrantes.",emoji:"♪"},
  {kind:"vocal-arrangement",title:"Arranjo vocal",description:"Principal, altas e baixas por música.",emoji:"🎙️"},
  {kind:"chat",title:"Conversas",description:"Mural de comunicação do evento.",emoji:"💬"},
  {kind:"files",title:"Arquivos",description:"Uploads, cifras, partituras e materiais.",emoji:"📎"}
];

type Props = {
  mode: "team" | "schedule";
  workspace: Workspace;
  currentUserId: string;
  catalog: Song[];
  profile: UserProfile;
  onRefresh: () => Promise<void>;
  onCatalogRefresh: () => Promise<void>;
  onOpenStudio: (song: Song) => void;
  onSaveToMyLibrary: (song: Song) => Promise<void>;
  onProfileChange: (profile: UserProfile) => Promise<void>;
  onOpenBilling: () => void;
};

export default function TeamModule(props:Props) {
  const currentUser=props.workspace.members.find((member)=>member.id===props.currentUserId);
  const isMaster=currentUser?.role==="master";
  const [activeEventId,setActiveEventId]=useState<string|null>(null);
  const activeEvent=props.workspace.events.find((event)=>event.id===activeEventId)||null;

  if(props.mode==="team") return <TeamView workspace={props.workspace} actorId={props.currentUserId} isMaster={isMaster} onRefresh={props.onRefresh} onOpenBilling={props.onOpenBilling}/>;
  if(activeEvent) return <EventDetail {...props} event={activeEvent} isMaster={isMaster} onBack={()=>setActiveEventId(null)}/>;
  return <EventsView workspace={props.workspace} actorId={props.currentUserId} isMaster={isMaster} onRefresh={props.onRefresh} onOpen={setActiveEventId}/>;
}

function leadsTeam(workspace:Workspace,actorId:string,teamId?:string){
  return Boolean(teamId&&workspace.teams.some((team)=>team.id===teamId&&team.leaderId===actorId&&!team.archived));
}

function canManageEvent(workspace:Workspace,actorId:string,isMaster:boolean,event:MinistryEvent){
  return isMaster||leadsTeam(workspace,actorId,event.teamId);
}

function TeamView({workspace,actorId,isMaster,onRefresh,onOpenBilling}:{workspace:Workspace;actorId:string;isMaster:boolean;onRefresh:()=>Promise<void>;onOpenBilling:()=>void}) {
  const [teamOpen,setTeamOpen]=useState(false);
  const [memberOpen,setMemberOpen]=useState(false);
  const [editingTeam,setEditingTeam]=useState<Team|null>(null);
  const [editingMember,setEditingMember]=useState<Member|null>(null);
  const activeTeams=workspace.teams.filter((team)=>!team.archived);
  const ledTeams=activeTeams.filter((team)=>team.leaderId===actorId);
  const billing=workspace.billing;
  const canAddMembers=billing?.canAddMembers!==false;

  async function removeTeam(team:Team){
    if(!confirm(`Excluir a equipe “${team.name}”? Os eventos serão preservados.`))return;
    const response=await fetch(`/api/teams/${team.id}?actorId=${encodeURIComponent(actorId)}`,{method:"DELETE"});
    if(response.ok)await onRefresh();
  }
  async function removeMember(member:Member){
    if(member.role==="master"||!confirm(`Excluir ${member.name} do ministério?`))return;
    const response=await fetch(`/api/members/${member.id}?actorId=${encodeURIComponent(actorId)}`,{method:"DELETE"});
    if(response.ok)await onRefresh();
  }
  async function resetPassword(member:Member){
    if(member.role==="master"||!confirm(`Resetar a senha de ${member.name}? No próximo acesso ele criará uma nova senha.`))return;
    const response=await fetch(`/api/auth/reset-member/${member.id}`,{method:"POST"});
    const data=await response.json().catch(()=>({}));
    if(response.ok){alert("Senha resetada. O músico criará uma nova senha no próximo acesso.");await onRefresh();}
    else alert(data.error||"Não foi possível resetar a senha.");
  }

  return <>
    <header className="module-head">
      <div><div className="eyebrow">Workspace</div><h1>Pessoas & equipes</h1><p>Nada vem pronto. Cadastre as pessoas e monte cada equipe conforme o ministério trabalha.</p></div>
      {isMaster&&<div className="head-actions">
        <button className="secondary" onClick={()=>{if(!canAddMembers){onOpenBilling();return;}setEditingMember(null);setMemberOpen(true);}}><UserPlus size={16}/> Novo músico</button>
        <button className="primary" onClick={()=>{setEditingTeam(null);setTeamOpen(true);}}><Plus size={17}/> Nova equipe</button>
      </div>}
    </header>

    {isMaster&&billing&&<section className={`plan-usage-card ${billing.canAddMembers?"":"limit-reached"}`}>
      <div><div className="eyebrow">Plano da igreja</div><h2>{billing.plan.name}</h2><p>{billing.members}{billing.memberLimit===null?" membros ativos":` de ${billing.memberLimit} membros ativos`}</p></div>
      <div className="plan-usage-actions"><span>{billing.memberLimit===null?"Sem limite":billing.remaining===0?"Limite atingido":`${billing.remaining} vagas restantes`}</span><button className="secondary" onClick={onOpenBilling}>Ver planos</button></div>
    </section>}

    <section className="team-section">
      <div className="panel-head"><div><div className="eyebrow">Equipes personalizadas</div><h2>{activeTeams.length} equipes</h2></div></div>
      <div className="custom-team-grid">
        {activeTeams.map((team)=>{const leader=workspace.members.find((member)=>member.id===team.leaderId);const canEdit=isMaster||team.leaderId===actorId;return <article className="custom-team-card" key={team.id} style={{"--team-color":team.color||workspace.branding?.accentColor||"#d8ff55"} as React.CSSProperties}>
          <div className="team-card-symbol">{team.emoji||"♪"}</div>
          <div className="team-card-copy"><strong>{team.name}</strong><span>{team.memberIds.length} integrantes</span>{leader&&<span className="team-leader-label">Líder: {leader.name}</span>}<p>{team.description||"Sem descrição"}</p></div>
          <div className="voice-config"><span>Altas {team.vocalConfig.highParts}</span><span>Baixas {team.vocalConfig.lowParts}</span></div>
          {canEdit&&<div className="team-card-actions"><button className="icon-btn" title="Editar equipe" onClick={()=>{setEditingTeam(team);setTeamOpen(true);}}><Pencil size={14}/></button>{isMaster&&<button className="danger-icon" title="Excluir equipe" onClick={()=>void removeTeam(team)}><Trash2 size={14}/></button>}</div>}
        </article>;})}
        {activeTeams.length===0&&<EmptyMini text="Nenhuma equipe criada. O administrador começa com uma tela vazia e monta a primeira equipe."/>}
      </div>
    </section>

    <section className="team-section">
      <div className="panel-head"><div><div className="eyebrow">Pessoas</div><h2>{workspace.members.filter((member)=>member.active!==false).length} cadastradas</h2></div></div>
      <div className="member-grid">
        {workspace.members.filter((member)=>member.active!==false).map((member)=><article className="member-card" key={member.id}>
          <div className={"avatar "+(member.role==="master"?"master":"")}>{initials(member.name)}</div>
          <div className="member-main"><div className="member-name">{member.name}{member.role==="master"&&<span className="master-tag">MASTER</span>}</div><div className="member-functions">{member.functions.join(" · ")||"Sem função definida"}</div>{member.vocalRegister&&<div className="vocal-register">Região: {member.vocalRegister==="high"?"alta":member.vocalRegister==="low"?"baixa":"flexível"}</div>}</div>
          {isMaster&&member.role!=="master"&&<div className="member-actions"><button className="icon-btn" title="Resetar senha" onClick={()=>void resetPassword(member)}><KeyRound size={14}/></button><button className="icon-btn" title="Editar músico" onClick={()=>{setEditingMember(member);setMemberOpen(true);}}><Pencil size={14}/></button><button className="danger-icon" title="Excluir músico" onClick={()=>void removeMember(member)}><Trash2 size={14}/></button></div>}
        </article>)}
      </div>
    </section>

    {!isMaster&&ledTeams.length===0&&<div className="module-note">Somente a conta master pode cadastrar pessoas e montar equipes.</div>}
    {!isMaster&&ledTeams.length>0&&<div className="module-note">Você pode editar as equipes das quais é líder. O cadastro de pessoas e a criação de novas equipes continuam com a conta master.</div>}
    {teamOpen&&<TeamModal workspace={workspace} actorId={actorId} isMaster={isMaster} team={editingTeam} onClose={()=>setTeamOpen(false)} onSaved={async()=>{setTeamOpen(false);setEditingTeam(null);await onRefresh();}}/>}
    {memberOpen&&<MemberModal actorId={actorId} member={editingMember} onClose={()=>setMemberOpen(false)} onSaved={async()=>{setMemberOpen(false);setEditingMember(null);await onRefresh();}}/>}
  </>;
}

function TeamModal({workspace,actorId,isMaster,team,onClose,onSaved}:{workspace:Workspace;actorId:string;isMaster:boolean;team:Team|null;onClose:()=>void;onSaved:()=>Promise<void>}) {
  const [name,setName]=useState(team?.name||"");
  const [description,setDescription]=useState(team?.description||"");
  const [color,setColor]=useState(team?.color||workspace.branding?.accentColor||"#d8ff55");
  const [emoji,setEmoji]=useState(team?.emoji||"🎵");
  const [memberIds,setMemberIds]=useState<string[]>(team?.memberIds||[]);
  const [leaderId,setLeaderId]=useState(team?.leaderId||"");
  const [highParts,setHighParts]=useState(team?.vocalConfig.highParts??3);
  const [lowParts,setLowParts]=useState(team?.vocalConfig.lowParts??3);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  const toggle=(id:string)=>setMemberIds((prev)=>prev.includes(id)?prev.filter((item)=>item!==id):prev.concat(id));
  async function save(){
    if(saving||!name.trim())return;
    setSaving(true);setError("");
    try{
      const nextMemberIds=leaderId&&!memberIds.includes(leaderId)?memberIds.concat(leaderId):memberIds;
      const response=await fetch(team?`/api/teams/${team.id}`:"/api/teams",{method:team?"PATCH":"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({actorId,name,description,color,emoji,memberIds:nextMemberIds,leaderId:isMaster?leaderId:team?.leaderId||actorId,vocalConfig:{highParts,lowParts}})});
      await responseData(response,"Não foi possível salvar a equipe.");
      await onSaved();
    }catch(issue){setError(issue instanceof Error?issue.message:"Não foi possível salvar a equipe.");}
    finally{setSaving(false);}
  }
  return <ModalShell eyebrow="Equipe" title={team?"Editar equipe":"Criar equipe do zero"} onClose={onClose}>
    <div className="form-grid two">
      <label className="field"><span>NOME</span><input autoFocus value={name} onChange={(e)=>setName(e.target.value)} placeholder="Nome livre"/></label>
      <label className="field"><span>ÍCONE</span><input value={emoji} onChange={(e)=>setEmoji(e.target.value)} maxLength={8}/></label>
      <label className="field"><span>COR</span><div className="color-field"><input type="color" value={color} onChange={(e)=>setColor(e.target.value)}/><input value={color} onChange={(e)=>setColor(e.target.value)}/></div></label>
      <label className="field"><span>VOZES ALTAS</span><input type="number" min="0" max="8" value={highParts} onChange={(e)=>setHighParts(Number(e.target.value))}/></label>
      <label className="field"><span>VOZES BAIXAS</span><input type="number" min="0" max="8" value={lowParts} onChange={(e)=>setLowParts(Number(e.target.value))}/></label>
      {isMaster&&<label className="field span-2"><span>LÍDER RESPONSÁVEL</span><select value={leaderId} onChange={(event)=>setLeaderId(event.target.value)}><option value="">Sem líder definido</option>{workspace.members.filter((member)=>member.role!=="master"&&member.active!==false).map((member)=><option key={member.id} value={member.id}>{member.name}</option>)}</select></label>}
      {!isMaster&&team?.leaderId&&<div className="notice span-2">Você está editando esta equipe como líder responsável.</div>}
      <label className="field span-2"><span>DESCRIÇÃO</span><textarea rows={3} value={description} onChange={(e)=>setDescription(e.target.value)}/></label>
    </div>
    <div className="field"><span>INTEGRANTES</span><div className="member-picks">{workspace.members.filter((member)=>member.role!=="master"&&member.active!==false).map((member)=><button key={member.id} className={"member-pick "+(memberIds.includes(member.id)?"selected":"")} onClick={()=>toggle(member.id)}><span className="avatar tiny">{initials(member.name)}</span><span>{member.name}</span></button>)}</div></div>
    {error&&<div className="notice error" role="alert">{error}</div>}
    <div className="actions"><button className="primary" disabled={saving||!name.trim()} onClick={()=>void save()}><Save size={16}/>{saving?"Salvando...":team?"Salvar equipe":"Criar equipe"}</button></div>
  </ModalShell>;
}

function MemberModal({actorId,member,onClose,onSaved}:{actorId:string;member:Member|null;onClose:()=>void;onSaved:()=>Promise<void>}) {
  const [name,setName]=useState(member?.name||"");
  const [email,setEmail]=useState(member?.email||"");
  const [phone,setPhone]=useState(member?.phone||"");
  const [functions,setFunctions]=useState<string[]>(member?.functions||[]);
  const [customFunction,setCustomFunction]=useState("");
  const [vocalRegister,setVocalRegister]=useState(member?.vocalRegister||"");
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  const toggle=(value:string)=>setFunctions((prev)=>prev.includes(value)?prev.filter((item)=>item!==value):prev.concat(value));
  function addCustom(){const value=customFunction.trim();if(value&&!functions.includes(value))setFunctions((prev)=>prev.concat(value));setCustomFunction("");}
  async function save(){
    if(!name.trim())return;setSaving(true);setError("");
    try{const response=await fetch(member?`/api/members/${member.id}`:"/api/members",{method:member?"PATCH":"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({actorId,name,email,phone,functions,vocalRegister})});const data=await response.json();if(!response.ok)throw new Error(data.error||"Não foi possível salvar.");await onSaved();}
    catch(error){setError(error instanceof Error?error.message:"Falha ao salvar.");}finally{setSaving(false);}
  }
  return <ModalShell eyebrow="Pessoa" title={member?"Editar músico":"Cadastrar músico"} onClose={onClose}>
    <div className="form-grid two"><label className="field"><span>NOME</span><input autoFocus value={name} onChange={(e)=>setName(e.target.value)}/></label><label className="field"><span>E-MAIL</span><input value={email} onChange={(e)=>setEmail(e.target.value)}/></label><label className="field"><span>WHATSAPP</span><input value={phone} onChange={(e)=>setPhone(e.target.value)}/></label><label className="field"><span>REGIÃO VOCAL</span><select value={vocalRegister} onChange={(e)=>setVocalRegister(e.target.value as ""|"high"|"low"|"flex")}><option value="">Não se aplica</option><option value="high">Alta</option><option value="low">Baixa</option><option value="flex">Flexível</option></select></label></div>
    <div className="field"><span>FUNÇÕES / INSTRUMENTOS</span><div className="chip-grid">{FUNCTION_SUGGESTIONS.map((value)=><button key={value} className={"choice-chip "+(functions.includes(value)?"selected":"")} onClick={()=>toggle(value)}>{value}</button>)}</div><div className="inline-add"><input value={customFunction} onChange={(e)=>setCustomFunction(e.target.value)} onKeyDown={(e)=>{if(e.key==="Enter"){e.preventDefault();addCustom();}}} placeholder="Outra função..."/><button className="secondary" onClick={addCustom}>Adicionar</button></div>{functions.filter((value)=>!FUNCTION_SUGGESTIONS.includes(value)).map((value)=><button key={value} className="custom-function" onClick={()=>toggle(value)}>{value} ×</button>)}</div>
    {error&&<div className="notice error">{error}</div>}
    <div className="actions"><button className="primary" disabled={saving||!name.trim()} onClick={()=>void save()}>{saving?"Salvando...":member?"Salvar músico":"Cadastrar músico"}</button></div>
  </ModalShell>;
}

function EventsView({workspace,actorId,isMaster,onRefresh,onOpen}:{workspace:Workspace;actorId:string;isMaster:boolean;onRefresh:()=>Promise<void>;onOpen:(id:string)=>void}) {
  const [open,setOpen]=useState(false);
  const [editing,setEditing]=useState<MinistryEvent|null>(null);
  const [duplicating,setDuplicating]=useState<MinistryEvent|null>(null);
  const ledTeamIds=useMemo(()=>workspace.teams.filter((team)=>team.leaderId===actorId&&!team.archived).map((team)=>team.id),[workspace.teams,actorId]);
  const canCreate=isMaster||ledTeamIds.length>0;
  const canManage=(event:MinistryEvent)=>isMaster||Boolean(event.teamId&&ledTeamIds.includes(event.teamId));
  const events=useMemo(()=>workspace.events.filter((event)=>!event.archived).slice().sort(sortEvents),[workspace.events]);
  const publicAgenda=useMemo(()=>(workspace.agenda||[]).slice().sort((a,b)=>((a.date||"9999-99-99")+" "+(a.time||"")).localeCompare((b.date||"9999-99-99")+" "+(b.time||""))),[workspace.agenda]);

  async function remove(event:MinistryEvent){
    if(!confirm(`Excluir o evento “${event.title}”?`))return;
    const response=await fetch(`/api/events/${event.id}`,{method:"DELETE"});
    if(response.ok)await onRefresh();
  }

  return <>
    <header className="module-head">
      <div><div className="eyebrow">Agenda da igreja</div><h1>Eventos</h1><p>Você entra nos grupos em que foi escalado. A agenda das outras equipes mostra somente as informações públicas.</p></div>
      {canCreate&&<button className="primary" onClick={()=>{setEditing(null);setOpen(true);}}><Plus size={17}/> Novo evento</button>}
    </header>

    <section className="team-section">
      <div className="panel-head"><div><div className="eyebrow">Meus grupos</div><h2>{events.length} eventos acessíveis</h2></div></div>
      <div className="event-list">
        {events.map((event)=>{const manageable=canManage(event);return <article className="modular-event-card" key={event.id} style={{"--event-color":event.color||workspace.branding?.accentColor||"#d8ff55"} as React.CSSProperties}>
          <button className="event-open" onClick={()=>onOpen(event.id)}><div className="event-symbol">{event.emoji||"✦"}</div><div className="event-card-main"><div className="event-title">{event.title}</div><div className="event-meta">{event.date&&<span><CalendarDays size={13}/>{formatDate(event.date)}</span>}{event.time&&<span><Clock size={13}/>{event.time}</span>}{event.location&&<span><MapPin size={13}/>{event.location}</span>}</div><div className="module-tags">{event.modules.map((module)=><span key={module.id}>{module.title}</span>)}{event.modules.length===0&&<span>Sem blocos</span>}</div></div><div className="event-numbers"><strong>{event.participants.length}</strong><span>pessoas</span><strong>{event.songs.length}</strong><span>músicas</span></div></button>
          {manageable&&<div className="event-master-actions"><button className="icon-btn" title="Duplicar com opções" onClick={()=>setDuplicating(event)}><Copy size={14}/></button><button className="icon-btn" title="Editar evento e escala" onClick={()=>{setEditing(event);setOpen(true);}}><Pencil size={14}/></button><button className="danger-icon" title="Excluir evento" onClick={()=>void remove(event)}><Trash2 size={14}/></button></div>}
        </article>;})}
        {events.length===0&&<div className="empty-state"><CalendarDays size={34}/><strong>Nenhum grupo de evento disponível</strong><span>{canCreate?"Crie um evento para uma equipe que você lidera.":"Você ainda não foi escalado para nenhum evento."}</span></div>}
      </div>
    </section>

    {publicAgenda.length>0&&<section className="team-section church-agenda-section">
      <div className="panel-head"><div><div className="eyebrow">Outras equipes</div><h2>Agenda pública da igreja</h2><p>Esses cartões não dão acesso ao grupo, repertório, conversas ou participantes.</p></div></div>
      <div className="church-agenda-grid">{publicAgenda.map((event)=><article className="church-agenda-card" key={event.id} style={{"--event-color":event.color||workspace.branding?.accentColor||"#d8ff55"} as React.CSSProperties}>
        <div className="event-symbol">{event.emoji||"✦"}</div><div><strong>{event.title}</strong><span className="agenda-team-name">{event.teamName}</span><div className="event-meta">{event.date&&<span><CalendarDays size={13}/>{formatDate(event.date)}</span>}{event.time&&<span><Clock size={13}/>{event.time}</span>}{event.location&&<span><MapPin size={13}/>{event.location}</span>}</div></div><span className="agenda-readonly-badge">Somente agenda</span>
      </article>)}</div>
    </section>}

    {open&&<EventModal workspace={workspace} actorId={actorId} event={editing} onClose={()=>setOpen(false)} onSaved={async()=>{setOpen(false);setEditing(null);await onRefresh();}}/>}
    {duplicating&&<DuplicateEventModal event={duplicating} onClose={()=>setDuplicating(null)} onSaved={async()=>{setDuplicating(null);await onRefresh();}}/>}
  </>;
}

function EventModal({workspace,actorId,event,onClose,onSaved}:{workspace:Workspace;actorId:string;event:MinistryEvent|null;onClose:()=>void;onSaved:()=>Promise<void>}) {
  const currentUser=workspace.members.find((member)=>member.id===actorId);
  const isMaster=currentUser?.role==="master";
  const manageableTeams=workspace.teams.filter((team)=>!team.archived&&(isMaster||team.leaderId===actorId));
  const initialTeamId=event?.teamId||(isMaster?"":manageableTeams[0]?.id||"");
  const initialTeam=workspace.teams.find((team)=>team.id===initialTeamId);
  const [title,setTitle]=useState(event?.title||"");
  const [date,setDate]=useState(event?.date||"");
  const [time,setTime]=useState(event?.time||"");
  const [location,setLocation]=useState(event?.location||"");
  const [description,setDescription]=useState(event?.description||"");
  const [color,setColor]=useState(event?.color||initialTeam?.color||workspace.branding?.accentColor||"#d8ff55");
  const [emoji,setEmoji]=useState(event?.emoji||initialTeam?.emoji||"✦");
  const [teamId,setTeamId]=useState(initialTeamId);
  const [highParts,setHighParts]=useState(event?.vocalConfig.highParts??initialTeam?.vocalConfig.highParts??3);
  const [lowParts,setLowParts]=useState(event?.vocalConfig.lowParts??initialTeam?.vocalConfig.lowParts??3);
  const [modules,setModules]=useState<EventModule[]>(event?.modules||[]);
  const [participants,setParticipants]=useState<Record<string,string>>(()=>event
    ? Object.fromEntries(event.participants.map((item)=>[item.memberId,item.function]))
    : Object.fromEntries((initialTeam?.memberIds||[]).map((memberId)=>{const member=workspace.members.find((item)=>item.id===memberId);return [memberId,member?.functions[0]||"Equipe"];})));
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");

  function chooseTeam(id:string){
    setTeamId(id);const team=workspace.teams.find((item)=>item.id===id);if(!team)return;
    setColor(team.color||color);setEmoji(team.emoji||emoji);setHighParts(team.vocalConfig.highParts);setLowParts(team.vocalConfig.lowParts);
    const next:Record<string,string>={};team.memberIds.forEach((memberId)=>{const member=workspace.members.find((item)=>item.id===memberId);next[memberId]=member?.functions[0]||"Equipe";});setParticipants(next);
  }
  function toggleMember(member:Member){setParticipants((prev)=>{const next={...prev};if(next[member.id])delete next[member.id];else next[member.id]=member.functions[0]||"Equipe";return next;});}
  function toggleModule(definition:(typeof MODULES)[number]){setModules((prev)=>prev.some((item)=>item.kind===definition.kind)?prev.filter((item)=>item.kind!==definition.kind):prev.concat({id:crypto.randomUUID(),kind:definition.kind,title:definition.title,order:prev.length}));}
  function renameModule(kind:EventModuleKind,title:string){setModules((prev)=>prev.map((module)=>module.kind===kind?{...module,title}:module));}
  async function save(){
    if(saving||!title.trim()||(!isMaster&&!teamId))return;setSaving(true);setError("");
    const payload={actorId,title,date,time,location,description,color,emoji,teamId,vocalConfig:{highParts,lowParts},modules:modules.map((module,index)=>({...module,order:index})),participants:Object.entries(participants).map(([memberId,fn])=>({memberId,function:fn}))};
    try{
      const response=await fetch(event?`/api/events/${event.id}`:"/api/events",{method:event?"PATCH":"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
      await responseData(response,"Não foi possível salvar o evento.");
      await onSaved();
    }catch(issue){setError(issue instanceof Error?issue.message:"Não foi possível salvar o evento.");}
    finally{setSaving(false);}
  }
  return <ModalShell wide eyebrow="Evento" title={event?"Editar evento e escala":"Criar evento do zero"} onClose={onClose}>
    {!isMaster&&<div className="notice">Como líder, você cria e edita eventos somente das equipes sob sua responsabilidade.</div>}
    <div className="form-grid two"><label className="field"><span>NOME</span><input autoFocus value={title} onChange={(e)=>setTitle(e.target.value)} placeholder="O administrador define"/></label><label className="field"><span>{isMaster?"EQUIPE (OPCIONAL)":"EQUIPE RESPONSÁVEL"}</span><select value={teamId} onChange={(e)=>chooseTeam(e.target.value)}>{isMaster&&<option value="">Sem equipe vinculada</option>}{manageableTeams.map((team)=><option key={team.id} value={team.id}>{team.name}</option>)}</select></label><label className="field"><span>DATA</span><input type="date" value={date} onChange={(e)=>setDate(e.target.value)}/></label><label className="field"><span>HORÁRIO</span><input type="time" value={time} onChange={(e)=>setTime(e.target.value)}/></label><label className="field"><span>LOCAL</span><input value={location} onChange={(e)=>setLocation(e.target.value)}/></label><label className="field"><span>ÍCONE</span><input value={emoji} onChange={(e)=>setEmoji(e.target.value)} maxLength={8}/></label><label className="field"><span>COR</span><div className="color-field"><input type="color" value={color} onChange={(e)=>setColor(e.target.value)}/><input value={color} onChange={(e)=>setColor(e.target.value)}/></div></label><label className="field"><span>ALTAS / BAIXAS</span><div className="voice-number-row"><input type="number" min="0" max="8" value={highParts} onChange={(e)=>setHighParts(Number(e.target.value))}/><span>altas</span><input type="number" min="0" max="8" value={lowParts} onChange={(e)=>setLowParts(Number(e.target.value))}/><span>baixas</span></div></label><label className="field span-2"><span>DESCRIÇÃO</span><textarea rows={3} value={description} onChange={(e)=>setDescription(e.target.value)}/></label></div>
    <div className="builder-section"><div className="builder-title"><Settings2 size={17}/><div><strong>Blocos do evento</strong><span>Nenhum bloco é adicionado automaticamente.</span></div></div><div className="module-picker">{MODULES.map((definition)=>{const selected=modules.find((module)=>module.kind===definition.kind);return <div key={definition.kind} className={"module-choice "+(selected?"selected":"")}><button onClick={()=>toggleModule(definition)}><span>{definition.emoji}</span><div><strong>{definition.title}</strong><small>{definition.description}</small></div><b>{selected?"✓":"+"}</b></button>{selected&&<input value={selected.title} onChange={(e)=>renameModule(definition.kind,e.target.value)} aria-label="Nome do bloco"/>}</div>;})}</div></div>
    <div className="builder-section"><div className="builder-title"><Users size={17}/><div><strong>Participantes</strong><span>{event?"Adicione ou remova músicos. As confirmações de quem permanecer serão preservadas.":"Selecione individualmente ou carregue uma equipe."}</span></div></div><div className="assignment-builder">{workspace.members.filter((member)=>member.role!=="master"&&member.active!==false).map((member)=>{const selected=Boolean(participants[member.id]);return <div className={"assign-member "+(selected?"selected":"")} key={member.id}><button className="assign-check" onClick={()=>toggleMember(member)}>{selected?"✓":"+"}</button><div><strong>{member.name}</strong><span>{member.functions.join(" · ")||"Equipe"}</span></div>{selected&&<select value={participants[member.id]} onChange={(e)=>setParticipants((prev)=>({...prev,[member.id]:e.target.value}))}>{(member.functions.length?member.functions:FUNCTION_SUGGESTIONS).map((fn)=><option key={fn}>{fn}</option>)}</select>}</div>;})}</div></div>
    {error&&<div className="notice error" role="alert">{error}</div>}
    <div className="actions"><button className="primary" disabled={saving||!title.trim()||(!isMaster&&!teamId)} onClick={()=>void save()}>{saving?"Salvando...":event?"Salvar evento":"Criar evento"}</button></div>
  </ModalShell>;
}


function DuplicateEventModal({event,onClose,onSaved}:{event:MinistryEvent;onClose:()=>void;onSaved:()=>Promise<void>}) {
  const [title,setTitle]=useState(`${event.title} · cópia`);
  const [date,setDate]=useState("");
  const [time,setTime]=useState(event.time||"");
  const [copyParticipants,setCopyParticipants]=useState(true);
  const [copyRepertoire,setCopyRepertoire]=useState(true);
  const [copyDescription,setCopyDescription]=useState(true);
  const [copyMaterials,setCopyMaterials]=useState(false);
  const [copyMessages,setCopyMessages]=useState(false);
  const [copyConfirmations,setCopyConfirmations]=useState(false);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");

  async function duplicate(){
    if(!title.trim())return;
    setSaving(true);setError("");
    try{
      const response=await fetch(`/api/events/${event.id}/duplicate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title,date,time,copyParticipants,copyRepertoire,copyDescription,copyMaterials,copyMessages,copyConfirmations:copyParticipants&&copyConfirmations})});
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(data.error||"Não foi possível duplicar o evento.");
      await onSaved();
    }catch(error){setError(error instanceof Error?error.message:"Falha ao duplicar evento.");}
    finally{setSaving(false);}
  }

  const option=(label:string,checked:boolean,onChange:(value:boolean)=>void,disabled=false)=><label className={"duplicate-option "+(disabled?"disabled":"")}><input type="checkbox" checked={checked} disabled={disabled} onChange={(event)=>onChange(event.target.checked)}/><span>{label}</span></label>;

  return <ModalShell wide eyebrow="Evento" title="Duplicar evento" onClose={onClose}>
    <div className="form-grid two"><label className="field"><span>NOME DO NOVO EVENTO</span><input autoFocus value={title} onChange={(event)=>setTitle(event.target.value)}/></label><label className="field"><span>NOVA DATA</span><input type="date" value={date} onChange={(event)=>setDate(event.target.value)}/></label><label className="field"><span>HORÁRIO</span><input type="time" value={time} onChange={(event)=>setTime(event.target.value)}/></label></div>
    <div className="duplicate-options"><div className="builder-title"><Copy size={17}/><div><strong>O que deve ser copiado?</strong><span>As opções desligadas começam vazias no novo evento.</span></div></div><div className="duplicate-option-grid">{option("Músicos e funções",copyParticipants,setCopyParticipants)}{option("Repertório",copyRepertoire,setCopyRepertoire)}{option("Descrição e observações",copyDescription,setCopyDescription)}{option("Materiais enviados",copyMaterials,setCopyMaterials)}{option("Mensagens do mural",copyMessages,setCopyMessages)}{option("Confirmações e justificativas",copyConfirmations,setCopyConfirmations,!copyParticipants)}</div></div>
    {!copyConfirmations&&copyParticipants&&<div className="notice">Os músicos serão copiados com confirmação pendente.</div>}
    {error&&<div className="notice error">{error}</div>}
    <div className="actions"><button className="primary" disabled={saving||!title.trim()} onClick={()=>void duplicate()}>{saving?"Duplicando...":"Criar cópia"}</button><button className="ghost" onClick={onClose}>Cancelar</button></div>
  </ModalShell>;
}

function AbsenceReasonModal({reason,error,onClose,onSubmit}:{reason:string;error:string;onClose:()=>void;onSubmit:(reason:string)=>Promise<boolean>}) {
  const [value,setValue]=useState(reason);
  const [localError,setLocalError]=useState("");
  const [saving,setSaving]=useState(false);
  async function submit(){
    const clean=value.trim();
    if(clean.length<3){setLocalError("Explique brevemente por que você não poderá comparecer.");return;}
    setSaving(true);setLocalError("");
    try{await onSubmit(clean);}
    catch(issue){setLocalError(issue instanceof Error?issue.message:"Não foi possível registrar sua resposta.");}
    finally{setSaving(false);}
  }
  return <ModalShell eyebrow="Confirmação de presença" title="Não vou comparecer" onClose={onClose}>
    <div className="absence-dialog-copy"><XCircle size={24}/><div><strong>Avise o motivo ao responsável pela escala</strong><span>A justificativa ficará visível para você e para a conta master.</span></div></div>
    <label className="field"><span>JUSTIFICATIVA</span><textarea autoFocus rows={5} maxLength={500} value={value} onChange={(event)=>setValue(event.target.value)} placeholder="Ex.: estarei trabalhando neste horário, viagem, compromisso familiar..."/><small className="field-counter">{value.length}/500</small></label>
    {(localError||error)&&<div className="notice error">{localError||error}</div>}
    <div className="actions"><button className="primary absence-submit" disabled={saving||value.trim().length<3} onClick={()=>void submit()}>{saving?"Enviando...":"Confirmar que não vou"}</button><button className="ghost" onClick={onClose}>Voltar</button></div>
  </ModalShell>;
}

function EventDetail(props:Props&{event:MinistryEvent;isMaster:boolean;onBack:()=>void}) {
  const {event,workspace,currentUserId:actorId,isMaster,catalog,profile,onBack,onRefresh,onCatalogRefresh,onOpenStudio,onSaveToMyLibrary,onProfileChange}=props;
  const participant=event.participants.find((item)=>item.memberId===actorId);
  const currentMember=workspace.members.find((member)=>member.id===actorId);
  const canManage=canManageEvent(workspace,actorId,isMaster,event);
  const [songOpen,setSongOpen]=useState(false);
  const [playlistSong,setPlaylistSong]=useState<Song|null>(null);
  const [editingSong,setEditingSong]=useState<EventSong|null>(null);
  const [eventOpen,setEventOpen]=useState(false);
  const [duplicateOpen,setDuplicateOpen]=useState(false);
  const [absenceOpen,setAbsenceOpen]=useState(false);
  const [absenceReason,setAbsenceReason]=useState(participant?.absenceReason||"");
  const [attendanceError,setAttendanceError]=useState("");
  const [message,setMessage]=useState("");
  const canSubmit=canManage||Boolean(participant&&isVocal(currentMember));
  const has=(kind:EventModuleKind)=>event.modules.some((module)=>module.kind===kind);

  async function attendance(status:"confirmed"|"unavailable"|"pending",reason=""){
    setAttendanceError("");
    try{
      const response=await fetch(`/api/events/${event.id}/attendance`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({actorId,status,reason})});
      await responseData(response,"Não foi possível registrar sua resposta.");
      await onRefresh();
      setAbsenceOpen(false);
      return true;
    }catch(issue){setAttendanceError(issue instanceof Error?issue.message:"Não foi possível registrar sua resposta.");return false;}
  }
  async function sendMessage(){if(!message.trim())return;const response=await fetch(`/api/events/${event.id}/messages`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({actorId,text:message})});if(response.ok){setMessage("");await onRefresh();}}
  async function removeSong(item:EventSong){if(!confirm("Remover esta música do evento?"))return;const response=await fetch(`/api/events/${event.id}/songs/${item.id}`,{method:"DELETE"});if(response.ok)await onRefresh();}

  return <>
    <button className="back-button" onClick={onBack}><ChevronLeft size={17}/> Voltar para eventos</button>
    <section className="event-hero modular" style={{"--event-color":event.color||workspace.branding?.accentColor||"#d8ff55"} as React.CSSProperties}>
      <div className="event-symbol large">{event.emoji||"✦"}</div>
      <div className="event-hero-main"><div className="eyebrow">Evento personalizado</div><h1>{event.title}</h1><div className="event-meta">{event.date&&<span><CalendarDays size={14}/>{formatDate(event.date)}</span>}{event.time&&<span><Clock size={14}/>{event.time}</span>}{event.location&&<span><MapPin size={14}/>{event.location}</span>}</div>{event.description&&<p>{event.description}</p>}<div className="module-tags">{event.modules.map((module)=><span key={module.id}>{module.title}</span>)}</div></div>
      <div className="event-hero-actions">
        {canManage&&<div className="master-event-buttons"><button className="secondary" onClick={()=>setEventOpen(true)}><Pencil size={15}/> Editar evento e escala</button><button className="ghost" onClick={()=>setDuplicateOpen(true)}><Copy size={15}/> Duplicar</button></div>}
        {has("confirmations")&&participant&&<div className="attendance-box"><span>Minha presença</span><div className="attendance-actions"><button className={participant.status==="confirmed"?"attend yes active":"attend yes"} onClick={()=>void attendance("confirmed")}><CheckCircle2 size={16}/> Vou</button><button className={participant.status==="unavailable"?"attend no active":"attend no"} onClick={()=>{setAbsenceReason(participant.absenceReason||"");setAttendanceError("");setAbsenceOpen(true);}}><XCircle size={16}/> Não vou</button></div>{participant.status==="unavailable"&&participant.absenceReason&&<small className="my-absence-reason">Justificativa: {participant.absenceReason}</small>}</div>}
      </div>
    </section>

    {attendanceError&&!absenceOpen&&<div className="notice error" role="alert">{attendanceError}</div>}
    {event.modules.length===0&&<div className="empty-state"><Settings2 size={34}/><strong>Evento sem blocos</strong><span>O administrador criou o evento, mas ainda não adicionou módulos.</span></div>}
    <div className="event-columns"><div className="event-main-col">
      {has("repertoire")&&<RepertoireBlock event={event} workspace={workspace} actorId={actorId} isMaster={isMaster} canManage={canManage} catalog={catalog} canSubmit={canSubmit} showArrangement={has("vocal-arrangement")} onRefresh={onRefresh} onCatalogRefresh={onCatalogRefresh} onOpenStudio={onOpenStudio} onSave={(song)=>setPlaylistSong(song)} onEdit={(item)=>{setEditingSong(item);setSongOpen(true);}} onAdd={()=>{setEditingSong(null);setSongOpen(true);}} onRemove={removeSong}/>} 
      {has("chat")&&<section className="module-panel"><div className="panel-head"><div><div className="eyebrow">Conversas</div><h2>Mural do evento</h2></div><MessageCircle size={20}/></div><div className="message-list">{event.messages.length===0&&<EmptyMini text="Ainda não há mensagens."/>}{event.messages.map((item)=>{const author=workspace.members.find((member)=>member.id===item.authorId);return <div className="message" key={item.id}><div className="avatar small">{initials(author?.name||"?")}</div><div><strong>{author?.name||"Membro"}</strong><span>{formatDateTime(item.createdAt)}</span><p>{item.text}</p></div></div>;})}</div><div className="message-compose"><input value={message} onChange={(e)=>setMessage(e.target.value)} onKeyDown={(e)=>{if(e.key==="Enter")void sendMessage();}} placeholder="Escreva para a equipe..."/><button className="primary" disabled={!message.trim()} onClick={()=>void sendMessage()}><Send size={16}/></button></div></section>}
      {has("files")&&<EventMaterials event={event} workspace={workspace} actorId={actorId} isMaster={canManage} onRefresh={onRefresh}/>}
    </div><aside className="event-side-col">
      {(has("participants")||has("confirmations"))&&<section className="module-panel"><div className="panel-head"><div><div className="eyebrow">Participantes</div><h2>{event.participants.length} pessoas</h2></div>{canManage&&<button className="mini-link" onClick={()=>setEventOpen(true)}>Editar escala</button>}</div><div className="roster">{event.participants.map((item)=>{const member=workspace.members.find((entry)=>entry.id===item.memberId);if(!member)return null;const showReason=item.status==="unavailable"&&item.absenceReason&&(canManage||item.memberId===actorId);return <div className="roster-row" key={item.memberId}><div className="avatar small">{initials(member.name)}</div><div className="roster-member-copy"><strong>{member.name}</strong><span>{item.function}</span>{showReason&&<small className="absence-reason">Não comparecerá: {item.absenceReason}</small>}</div>{has("confirmations")&&<span className={"status-dot "+item.status}/>}</div>;})}</div></section>}
      {has("vocal-arrangement")&&<section className="module-panel vocal-legend"><div className="panel-head"><div><div className="eyebrow">Divisões vocais</div><h2>{event.vocalConfig.highParts} altas · {event.vocalConfig.lowParts} baixas</h2></div></div><p>Cada ministrante ocupa a voz principal da própria música. Nos demais cânticos, cada vocal escolhe a divisão que fará.</p></section>}
    </aside></div>
    {songOpen&&<SongModal event={event} item={editingSong} actorId={actorId} isMaster={canManage} workspace={workspace} catalog={catalog} onClose={()=>setSongOpen(false)} onSaved={async(signal)=>{await onCatalogRefresh();if(signal.aborted)return;await onRefresh();if(signal.aborted)return;setSongOpen(false);setEditingSong(null);}}/>}
    {playlistSong&&<PlaylistPicker song={playlistSong} profile={profile} onClose={()=>setPlaylistSong(null)} onLibrary={onSaveToMyLibrary} onProfileChange={onProfileChange}/>}
    {eventOpen&&<EventModal workspace={workspace} actorId={actorId} event={event} onClose={()=>setEventOpen(false)} onSaved={async()=>{setEventOpen(false);await onRefresh();}}/>}
    {duplicateOpen&&<DuplicateEventModal event={event} onClose={()=>setDuplicateOpen(false)} onSaved={async()=>{setDuplicateOpen(false);await onRefresh();}}/>}
    {absenceOpen&&<AbsenceReasonModal reason={absenceReason} error={attendanceError} onClose={()=>setAbsenceOpen(false)} onSubmit={async(reason)=>{setAbsenceReason(reason);return attendance("unavailable",reason);}}/>}
  </>;
}


function EventMaterials({event,workspace,actorId,isMaster,onRefresh}:{event:MinistryEvent;workspace:Workspace;actorId:string;isMaster:boolean;onRefresh:()=>Promise<void>}) {
  const inputRef=useRef<HTMLInputElement>(null);
  const [uploading,setUploading]=useState(false);
  const [progress,setProgress]=useState(0);
  const [dragging,setDragging]=useState(false);
  const [error,setError]=useState("");

  async function uploadFiles(fileSource:FileList|File[]){
    const files=Array.from(fileSource).slice(0,5);
    if(!files.length)return;
    setUploading(true);setProgress(0);setError("");
    const body=new FormData();files.forEach((file)=>body.append("files",file));
    await new Promise<void>((resolve)=>{
      const xhr=new XMLHttpRequest();
      xhr.open("POST",`/api/events/${event.id}/attachments`);
      xhr.withCredentials=true;
      xhr.upload.onprogress=(value)=>{if(value.lengthComputable)setProgress(Math.round((value.loaded/value.total)*100));};
      xhr.onload=async()=>{
        let data:Record<string,unknown>={};
        try{data=JSON.parse(xhr.responseText||"{}");}catch{}
        try{
          if(xhr.status>=200&&xhr.status<300){setProgress(100);await onRefresh();}
          else setError(String(data.error||"Não foi possível enviar o arquivo."));
        }catch(issue){setError(issue instanceof Error?issue.message:"O arquivo foi enviado, mas a lista não pôde ser atualizada.");}
        finally{resolve();}
      };
      xhr.onerror=()=>{setError("Falha de conexão durante o upload.");resolve();};
      xhr.timeout=120000;
      xhr.ontimeout=()=>{setError("O envio demorou demais. Tente novamente.");resolve();};
      xhr.onabort=()=>{setError("O envio foi interrompido.");resolve();};
      xhr.send(body);
    });
    setUploading(false);
    if(inputRef.current)inputRef.current.value="";
  }

  async function removeAttachment(file:EventAttachment){
    if(!confirm(`Excluir “${file.originalName||file.title}”?`))return;
    const response=await fetch(`/api/events/${event.id}/attachments/${file.id}`,{method:"DELETE"});
    const data=await response.json().catch(()=>({}));
    if(response.ok)await onRefresh();
    else setError(data.error||"Não foi possível excluir o arquivo.");
  }

  function handleDrop(event:React.DragEvent<HTMLDivElement>){
    event.preventDefault();setDragging(false);
    if(!uploading&&event.dataTransfer.files.length)void uploadFiles(event.dataTransfer.files);
  }

  return <section className="module-panel event-materials">
    <div className="panel-head"><div><div className="eyebrow">Arquivos</div><h2>Materiais do evento</h2></div><FileText size={20}/></div>
    <div className="attachment-list">
      {event.attachments.map((file)=>{
        const author=workspace.members.find((member)=>member.id===file.authorId);
        const stored=Boolean(file.storedName);
        const openUrl=stored?`/api/events/${event.id}/attachments/${file.id}/file`:file.url||"#";
        const downloadUrl=stored?`${openUrl}?download=1`:openUrl;
        const isImage=file.mimeType?.startsWith("image/");
        const isAudio=file.mimeType?.startsWith("audio/");
        const canDelete=isMaster||file.authorId===actorId;
        return <article className="attachment-card" key={file.id}>
          {isImage?<a className="attachment-thumb" href={openUrl} target="_blank" rel="noreferrer"><img src={openUrl} alt=""/></a>:<div className="attachment-icon"><FileText size={19}/></div>}
          <div className="attachment-copy"><strong>{file.originalName||file.title}</strong><span>{author?.name||"Membro"} · {formatDateTime(file.createdAt)}{file.size?` · ${formatBytes(file.size)}`:""}</span>{isAudio&&<audio controls preload="metadata" src={openUrl}/>}</div>
          <div className="attachment-actions"><a className="ghost" href={openUrl} target="_blank" rel="noreferrer"><Eye size={14}/>{stored?"Visualizar":"Abrir"}</a>{stored&&<a className="ghost" href={downloadUrl}><Download size={14}/>Baixar</a>}{canDelete&&<button className="danger-icon" onClick={()=>void removeAttachment(file)}><Trash2 size={14}/></button>}</div>
        </article>;
      })}
      {event.attachments.length===0&&<EmptyMini text="Nenhum arquivo enviado para este evento."/>}
    </div>
    <div className={"upload-dropzone "+(dragging?"dragging":"")+(uploading?" uploading":"")} onDragEnter={(event)=>{event.preventDefault();setDragging(true);}} onDragOver={(event)=>event.preventDefault()} onDragLeave={(event)=>{if(event.currentTarget===event.target)setDragging(false);}} onDrop={handleDrop} onClick={()=>!uploading&&inputRef.current?.click()}>
      <input ref={inputRef} type="file" multiple hidden accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.webp,.mp3,.wav,.m4a,.aac,.zip,.txt" onChange={(event)=>event.target.files&&void uploadFiles(event.target.files)}/>
      <Upload size={25}/><div><strong>{uploading?"Enviando arquivos...":"Arraste os arquivos aqui"}</strong><span>ou clique para selecionar · até 5 arquivos de 50 MB</span><small>PDF, Office, imagens, áudio, ZIP e TXT</small></div>
      <button type="button" className="secondary" disabled={uploading} onClick={(event)=>{event.stopPropagation();inputRef.current?.click();}}>Selecionar arquivos</button>
    </div>
    {uploading&&<div className="upload-progress"><span style={{width:`${progress}%`}}/><b>{progress}%</b></div>}
    {error&&<div className="notice error" style={{marginTop:10}}>{error}</div>}
  </section>;
}

function RepertoireBlock({event,workspace,actorId,isMaster,canManage,catalog,canSubmit,showArrangement,onRefresh,onOpenStudio,onSave,onEdit,onAdd,onRemove}:{event:MinistryEvent;workspace:Workspace;actorId:string;isMaster:boolean;canManage:boolean;catalog:Song[];canSubmit:boolean;showArrangement:boolean;onRefresh:()=>Promise<void>;onCatalogRefresh:()=>Promise<void>;onOpenStudio:(song:Song)=>void;onSave:(song:Song)=>void;onEdit:(item:EventSong)=>void;onAdd:()=>void;onRemove:(item:EventSong)=>Promise<void>}) {
  async function move(item:EventSong,direction:-1|1){const rows=event.songs.slice().sort((a,b)=>a.order-b.order);const index=rows.findIndex((song)=>song.id===item.id);const target=index+direction;if(target<0||target>=rows.length)return;[rows[index],rows[target]]=[rows[target],rows[index]];const response=await fetch(`/api/events/${event.id}/songs/reorder`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({actorId,ids:rows.map((song)=>song.id)})});if(response.ok)await onRefresh();}
  return <section className="module-panel"><div className="panel-head"><div><div className="eyebrow">Repertório</div><h2>Plano de ministração</h2></div>{canSubmit&&<button className="primary" onClick={onAdd}><Plus size={16}/> Enviar minha música</button>}</div><div className="setlist">{event.songs.length===0&&<EmptyMini text="Nenhum vocal enviou música para este evento."/>}{event.songs.slice().sort((a,b)=>a.order-b.order).map((item,index)=>{const song=catalog.find((entry)=>entry.id===item.songId);if(!song)return null;const minister=workspace.members.find((member)=>member.id===item.ministerId);const canEdit=canManage||item.ministerId===actorId;return <article className="ministry-song" key={item.id}><div className="ministry-song-head"><div className="set-order">{index+1}</div>{song.cover?<img src={song.cover} className="set-cover"/>:<div className="set-cover placeholder"><Music2 size={18}/></div>}<div className="set-main"><strong>{song.title}</strong><span>{song.artist}</span><div className="minister-label">🎤 Ministra: <b>{minister?.name||"Não definido"}</b></div>{item.description&&<p>{item.description}</p>}{item.message&&<div className="song-note">{item.message}</div>}</div><div className="set-key"><small>Tom oficial</small><strong>{item.key||song.originalKey}</strong><span>semitons</span></div><div className="set-actions"><button className="ghost" onClick={()=>onOpenStudio(song)}>Estudar</button><button className="ghost" onClick={()=>onSave(song)}>+ Playlist</button>{canManage&&<div className="order-actions"><button onClick={()=>void move(item,-1)} disabled={index===0}><ChevronUp size={14}/></button><button onClick={()=>void move(item,1)} disabled={index===event.songs.length-1}><ChevronDown size={14}/></button></div>}{canEdit&&<button className="icon-btn" onClick={()=>onEdit(item)}><Pencil size={14}/></button>}{canEdit&&<button className="danger-icon" onClick={()=>void onRemove(item)}><Trash2 size={14}/></button>}</div></div>{showArrangement&&<VocalArrangement event={event} item={item} workspace={workspace} actorId={actorId} isMaster={isMaster} onRefresh={onRefresh}/>}<SongComments event={event} item={item} workspace={workspace} actorId={actorId} onRefresh={onRefresh}/></article>;})}</div></section>;
}

function VocalArrangement({event,item,workspace,actorId,isMaster,onRefresh}:{event:MinistryEvent;item:EventSong;workspace:Workspace;actorId:string;isMaster:boolean;onRefresh:()=>Promise<void>}) {
  const member=workspace.members.find((entry)=>entry.id===actorId);
  const canChoose=!isMaster&&isVocal(member)&&event.participants.some((entry)=>entry.memberId===actorId)&&item.ministerId!==actorId;
  const current=item.vocalAssignments.find((entry)=>entry.memberId===actorId);
  async function choose(register:"high"|"low"|null,part?:number){const response=await fetch(`/api/events/${event.id}/songs/${item.id}/vocal-part`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({actorId,register,part})});if(response.ok)await onRefresh();}
  const render=(register:"high"|"low",count:number)=><div className={"vocal-lane "+register}><strong>{register==="high"?"Vozes altas":"Vozes baixas"}</strong><div className="vocal-parts">{Array.from({length:count},(_,index)=>index+1).map((part)=>{const assigned=item.vocalAssignments.filter((entry)=>entry.register===register&&entry.part===part).map((entry)=>workspace.members.find((member)=>member.id===entry.memberId)?.name).filter(Boolean);const mine=current?.register===register&&current.part===part;return <button key={part} className={"vocal-part "+(mine?"mine":"")} disabled={!canChoose} onClick={()=>void choose(register,part)}><span>{register==="high"?"Alta":"Baixa"} {part}</span><small>{assigned.length?assigned.join(", "):"Livre"}</small></button>;})}</div></div>;
  const minister=workspace.members.find((entry)=>entry.id===item.ministerId);
  return <div className="vocal-arrangement"><div className="principal-voice"><span>Principal</span><strong>{minister?.name||"Não definido"}</strong></div>{render("high",event.vocalConfig.highParts)}{render("low",event.vocalConfig.lowParts)}{canChoose&&current&&<button className="mini-clear" onClick={()=>void choose(null)}>Remover minha divisão</button>}</div>;
}

function SongModal({event,item,actorId,isMaster,workspace,catalog,onClose,onSaved}:{event:MinistryEvent;item:EventSong|null;actorId:string;isMaster:boolean;workspace:Workspace;catalog:Song[];onClose:()=>void;onSaved:(signal:AbortSignal)=>Promise<void>}) {
  const vocalParticipants=event.participants.map((participant)=>workspace.members.find((member)=>member.id===participant.memberId)).filter((member):member is Member=>Boolean(member&&isVocal(member)));
  const defaultMinister=isMaster?(item?.ministerId||vocalParticipants[0]?.id||actorId):actorId;
  const [ministerId,setMinisterId]=useState(defaultMinister);
  const [songId,setSongId]=useState(item?.songId||catalog[0]?.id||"");
  const [youtube,setYoutube]=useState("");
  const selected=catalog.find((song)=>song.id===songId);
  const [key,setKey]=useState(item?.key||selected?.originalKey||"C");
  const [description,setDescription]=useState(item?.description||"");
  const [message,setMessage]=useState(item?.message||"");
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  const [duplicate,setDuplicate]=useState<Song|null>(null);
  const [progress,setProgress]=useState("");
  const [importStarted,setImportStarted]=useState(false);
  const [importedSong,setImportedSong]=useState<Song|null>(null);
  const [eventSaved,setEventSaved]=useState(false);
  const requestRef=useRef<AbortController|null>(null);
  const busyRef=useRef(false);
  useEffect(()=>()=>{requestRef.current?.abort();},[]);
  function close(){requestRef.current?.abort();onClose();}

  async function save(){
    if(busyRef.current)return;
    busyRef.current=true;
    const controller=new AbortController();requestRef.current=controller;
    const signal=controller.signal;
    setSaving(true);setError("");setDuplicate(null);setImportStarted(false);
    let imported=Boolean(importedSong);
    let saved=eventSaved;
    try{
      if(!saved){
        let finalSong=importedSong||catalog.find((song)=>song.id===songId);
        if(!item&&youtube.trim()&&!importedSong){
          const result=await importSong(youtube,actorId,{signal,onProgress:({status,message})=>{setProgress(message);if(status!=="submitting")setImportStarted(true);}});
          if(signal.aborted)return;
          if(result.duplicate){setDuplicate(result.song);setError("Essa versão da música já existe na plataforma.");return;}
          finalSong=result.song;imported=true;setImportedSong(result.song);setSongId(result.song.id);
        }
        if(!finalSong)throw new Error("Escolha uma música.");
        if(signal.aborted)return;
        setProgress("Salvando no evento…");
        const endpoint=item?`/api/events/${event.id}/songs/${item.id}`:`/api/events/${event.id}/songs`;
        const response=await fetch(endpoint,{method:item?"PATCH":"POST",headers:{"Content-Type":"application/json"},signal,body:JSON.stringify({actorId,songId:finalSong.id,ministerId,key:key||finalSong.originalKey,description,message})});
        await responseData(response,"Não foi possível salvar a música no evento.");
        if(signal.aborted)return;
        saved=true;setEventSaved(true);
      }
      setProgress("Atualizando evento…");
      await onSaved(signal);
    }catch(issue){
      if(signal.aborted||isImportCancelled(issue))return;
      if(saved)setError("A música foi salva no evento, mas não foi possível atualizar a tela. Tente atualizar novamente.");
      else setError((imported?"A música já está no catálogo, mas não foi possível salvá-la no evento. ":"")+importErrorMessage(issue,"Não foi possível salvar a música."));
    }finally{
      if(requestRef.current===controller){
        busyRef.current=false;
        if(!signal.aborted){setSaving(false);setProgress("");}
      }
    }
  }

  if(eventSaved)return <ModalShell eyebrow="Plano de ministração" title="Música salva" onClose={close}>
    {progress&&<div className="notice" role="status">{progress}</div>}
    {error&&<div className="notice error" role="alert">{error}</div>}
    <div className="actions"><button className="primary" disabled={saving} onClick={()=>void save()}>{saving?"Atualizando…":"Atualizar evento"}</button><button className="ghost" onClick={close}>Fechar</button></div>
  </ModalShell>;

  return <ModalShell eyebrow="Plano de ministração" title={item?"Editar minha música":"Enviar minha música"} onClose={close}>
    {isMaster&&<label className="field"><span>MINISTRANTE / VOZ PRINCIPAL</span><select disabled={saving} value={ministerId} onChange={(e)=>setMinisterId(e.target.value)}>{vocalParticipants.map((member)=><option key={member.id} value={member.id}>{member.name}</option>)}</select></label>}
    {!item&&<><label className="field"><span>MÚSICA DA BIBLIOTECA</span><select disabled={saving} value={songId} onChange={(e)=>{setSongId(e.target.value);setYoutube("");setImportedSong(null);setDuplicate(null);const song=catalog.find((entry)=>entry.id===e.target.value);if(song)setKey(song.originalKey);}}><option value="">Selecione...</option>{importedSong&&!catalog.some((song)=>song.id===importedSong.id)&&<option value={importedSong.id}>{importedSong.title} · {importedSong.artist}</option>}{catalog.map((song)=><option key={song.id} value={song.id}>{song.title} · {song.artist}</option>)}</select></label><div className="or-divider">ou</div><label className="field"><span>LINK DO YOUTUBE</span><input disabled={saving} value={youtube} onChange={(e)=>{setYoutube(e.target.value);setImportedSong(null);setDuplicate(null);}} placeholder="https://youtube.com/watch?v=..."/></label></>}
    <div className="form-grid two"><label className="field"><span>TOM OFICIAL · MEIO EM MEIO TOM</span><select disabled={saving} value={key} onChange={(e)=>setKey(e.target.value)}>{KEYS.map((value)=><option key={value}>{value}</option>)}</select></label><label className="field"><span>DESCRIÇÃO</span><input disabled={saving} value={description} onChange={(e)=>setDescription(e.target.value)} placeholder="Ex.: começar somente voz e piano"/></label><label className="field span-2"><span>ORIENTAÇÕES</span><textarea disabled={saving} rows={3} value={message} onChange={(e)=>setMessage(e.target.value)} placeholder="Entradas, dinâmica, final, referências..."/></label></div>
    {progress&&<div className="notice" role="status">{progress}{importStarted&&<p>Você pode fechar esta janela. Depois, atualize o catálogo para conferir a música e adicioná-la ao evento.</p>}</div>}
    {duplicate&&<button className="duplicate-link" disabled={saving} onClick={()=>{setImportedSong(duplicate);setSongId(duplicate.id);setKey(duplicate.originalKey);setYoutube("");setDuplicate(null);setError("");}}>{duplicate.cover?<img src={duplicate.cover}/>:<div className="dup-cover"><Music2 size={17}/></div>}<div><strong>{duplicate.title}</strong><span>{duplicate.artist}</span><small>Usar a faixa existente →</small></div></button>}
    {error&&<div className="notice error" role="alert">{error}</div>}<div className="actions"><button className="primary" disabled={saving||(!item&&!songId&&!youtube.trim())} onClick={()=>void save()}>{saving?"Salvando...":item?"Salvar música":"Enviar música"}</button></div>
  </ModalShell>;
}

function SongComments({event,item,workspace,actorId,onRefresh}:{event:MinistryEvent;item:EventSong;workspace:Workspace;actorId:string;onRefresh:()=>Promise<void>}) {const [text,setText]=useState("");async function send(){if(!text.trim())return;const response=await fetch(`/api/events/${event.id}/songs/${item.id}/comments`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({actorId,text})});if(response.ok){setText("");await onRefresh();}}return <div className="song-comments">{(item.comments||[]).map((comment)=>{const author=workspace.members.find((member)=>member.id===comment.authorId);return <div className="song-comment" key={comment.id}><strong>{author?.name||"Membro"}</strong><span>{comment.text}</span></div>;})}<div className="song-comment-compose"><input value={text} onChange={(e)=>setText(e.target.value)} placeholder="Conversar sobre esta música..." onKeyDown={(e)=>{if(e.key==="Enter")void send();}}/><button onClick={()=>void send()}><Send size={13}/></button></div></div>;}

function PlaylistPicker({song,profile,onClose,onLibrary,onProfileChange}:{song:Song;profile:UserProfile;onClose:()=>void;onLibrary:(song:Song)=>Promise<void>;onProfileChange:(profile:UserProfile)=>Promise<void>}) {
  const [newName,setNewName]=useState("");
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  async function save(action:()=>Promise<void>){
    if(saving)return;
    setSaving(true);setError("");
    try{await action();onClose();}
    catch(issue){setError(issue instanceof Error?issue.message:"Não foi possível salvar a música.");}
    finally{setSaving(false);}
  }
  async function saveToPlaylist(playlistId:string){
    const library=profile.library.some((entry)=>entry.songId===song.id)?profile.library:profile.library.concat({songId:song.id,preferredShift:0,preferredSpeed:1,preferredInstrument:"original",favorite:false});
    const playlists=profile.playlists.map((playlist)=>playlist.id===playlistId&& !playlist.songIds.includes(song.id)?{...playlist,songIds:playlist.songIds.concat(song.id)}:playlist);
    await save(()=>onProfileChange({...profile,library,playlists}));
  }
  async function createPlaylist(){
    const name=newName.trim();if(!name)return;
    const library=profile.library.some((entry)=>entry.songId===song.id)?profile.library:profile.library.concat({songId:song.id,preferredShift:0,preferredSpeed:1,preferredInstrument:"original",favorite:false});
    const playlist={id:crypto.randomUUID(),name,songIds:[song.id],public:false};
    await save(()=>onProfileChange({...profile,library,playlists:profile.playlists.concat(playlist)}));
  }
  async function libraryOnly(){await save(()=>onLibrary(song));}
  return <ModalShell eyebrow="Minha biblioteca" title="Salvar música" onClose={onClose}>
    <div className="playlist-song-preview">{song.cover?<img src={song.cover}/>:<div><Music2 size={20}/></div>}<span><strong>{song.title}</strong><small>{song.artist}</small></span></div>
    <div className="playlist-picks">{profile.playlists.map((playlist)=><button key={playlist.id} disabled={saving||playlist.songIds.includes(song.id)} onClick={()=>void saveToPlaylist(playlist.id)}><ListMusicIcon/><span><strong>{playlist.name}</strong><small>{playlist.songIds.includes(song.id)?"Já está nesta playlist":`${playlist.songIds.length} músicas`}</small></span></button>)}{profile.playlists.length===0&&<EmptyMini text="Você ainda não possui playlists."/>}</div>
    <div className="inline-add"><input value={newName} onChange={(e)=>setNewName(e.target.value)} placeholder="Nome de uma nova playlist"/><button className="secondary" disabled={saving||!newName.trim()} onClick={()=>void createPlaylist()}>Criar e salvar</button></div>
    {error&&<div className="notice error" role="alert">{error}</div>}
    <div className="actions"><button className="ghost" disabled={saving} onClick={()=>void libraryOnly()}>Salvar apenas na biblioteca</button></div>
  </ModalShell>;
}

function ListMusicIcon(){return <div className="playlist-icon">♪</div>;}

function ModalShell({title,eyebrow,onClose,children,wide=false}:{title:string;eyebrow:string;onClose:()=>void;children:ReactNode;wide?:boolean}) {return <div className="modal-backdrop" onMouseDown={onClose}><div className={"modal team-modal "+(wide?"wide":"")} onMouseDown={(e)=>e.stopPropagation()}><div className="modal-title"><div><div className="eyebrow">{eyebrow}</div><h2>{title}</h2></div><button className="icon-btn" onClick={onClose}><X size={17}/></button></div>{children}</div></div>;}
function EmptyMini({text}:{text:string}){return <div className="empty-mini">{text}</div>;}
function isVocal(member?:Member){return Boolean(member&&/vocal|voz|louvor|worship|cantor|cantora/i.test(member.functions.join(" ")));}
function initials(name:string){return name.split(/\s+/).filter(Boolean).slice(0,2).map((part)=>part[0]?.toUpperCase()).join("")||"?";}
function formatDate(value:string){if(!value)return"";const parts=value.split("-").map(Number);return new Intl.DateTimeFormat("pt-BR",{day:"2-digit",month:"short",year:"numeric"}).format(new Date(parts[0],parts[1]-1,parts[2]));}
function formatDateTime(value:string){try{return new Intl.DateTimeFormat("pt-BR",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}).format(new Date(value));}catch{return"";}}
function formatBytes(value:number){if(value<1024)return `${value} B`;if(value<1024*1024)return `${(value/1024).toFixed(1)} KB`;return `${(value/(1024*1024)).toFixed(1)} MB`;}
function sortEvents(a:MinistryEvent,b:MinistryEvent){const av=(a.date||"9999-99-99")+" "+(a.time||"");const bv=(b.date||"9999-99-99")+" "+(b.time||"");return av.localeCompare(bv);}
