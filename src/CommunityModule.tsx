import { useEffect, useMemo, useRef, useState } from "react";
import {
  Folder, Heart, ListMusic, Music2, Play, Plus, Search, Trash2, X
} from "lucide-react";
import "./CommunityModule.css";
import { responseData } from "./api";
import { importErrorMessage, importSong, isImportCancelled } from "./importSong";
import type { Playlist, Song, UserProfile } from "./types";

type Props = {
  mode: "library" | "explore" | "playlists";
  catalog: Song[];
  profile: UserProfile;
  currentUserId: string;
  isMaster: boolean;
  onProfileChange: (profile: UserProfile) => Promise<void>;
  onCatalogRefresh: () => Promise<void>;
  onOpenStudio: (song: Song) => void;
};

const emptyProfile = (): UserProfile => ({ folders: [], library: [], playlists: [] });

export default function CommunityModule({
  mode, catalog, profile = emptyProfile(), currentUserId, isMaster,
  onProfileChange, onCatalogRefresh, onOpenStudio
}: Props) {
  const [query, setQuery] = useState("");
  const [activeFolder, setActiveFolder] = useState("all");
  const [activePlaylist, setActivePlaylist] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [playlistOpen, setPlaylistOpen] = useState(false);
  const [error, setError] = useState("");
  function runAction(action:Promise<void>){
    setError("");
    void action.catch((issue)=>setError(issue instanceof Error?issue.message:"Não foi possível salvar suas alterações."));
  }

  const entries = profile.library;
  const entryMap = useMemo(() => new Map(entries.map((entry) => [entry.songId, entry])), [entries]);
  const filteredCatalog = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter((song) => (song.title + " " + song.artist).toLowerCase().includes(q));
  }, [catalog, query]);

  const librarySongs = useMemo(() => {
    let rows = filteredCatalog.filter((song) => entryMap.has(song.id));
    if (activeFolder === "favorites") rows = rows.filter((song) => entryMap.get(song.id)?.favorite);
    else if (activeFolder !== "all") rows = rows.filter((song) => entryMap.get(song.id)?.folderId === activeFolder);
    return rows;
  }, [filteredCatalog, entryMap, activeFolder]);

  async function saveProfile(next: UserProfile) {
    await onProfileChange(next);
  }

  async function addToLibrary(song: Song) {
    if (entryMap.has(song.id)) return;
    const next: UserProfile = {
      ...profile,
      library: (profile.library || []).concat({
        songId: song.id,
        preferredShift: 0,
        preferredSpeed: 1,
        preferredInstrument: "original",
        favorite: false
      })
    };
    await saveProfile(next);
  }

  async function removeFromLibrary(songId: string) {
    const next: UserProfile = {
      ...profile,
      library: profile.library.filter((entry) => entry.songId !== songId),
      playlists: profile.playlists.map((playlist) => ({
        ...playlist,
        songIds: playlist.songIds.filter((id) => id !== songId)
      }))
    };
    await saveProfile(next);
  }

  async function updateEntry(songId: string, patch: Record<string, unknown>) {
    const next: UserProfile = {
      ...profile,
      library: profile.library.map((entry) => entry.songId === songId ? { ...entry, ...patch } : entry)
    };
    await saveProfile(next);
  }

  async function createFolder(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const next: UserProfile = {
      ...profile,
      folders: profile.folders.concat({ id: crypto.randomUUID(), name: trimmed })
    };
    await saveProfile(next);
  }

  async function deleteFolder(folderId: string) {
    const next: UserProfile = {
      ...profile,
      folders: profile.folders.filter((folder) => folder.id !== folderId),
      library: profile.library.map((entry) => entry.folderId === folderId ? { ...entry, folderId: undefined } : entry)
    };
    if (activeFolder === folderId) setActiveFolder("all");
    await saveProfile(next);
  }

  async function createPlaylist(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const next: UserProfile = {
      ...profile,
      playlists: profile.playlists.concat({
        id: crypto.randomUUID(),
        name: trimmed,
        songIds: [],
        public: false
      })
    };
    await saveProfile(next);
  }

  async function deletePlaylist(playlistId: string) {
    if (activePlaylist === playlistId) setActivePlaylist(null);
    await saveProfile({
      ...profile,
      playlists: profile.playlists.filter((playlist) => playlist.id !== playlistId)
    });
  }

  async function addToPlaylist(playlistId: string, songId: string) {
    if(!catalog.some((song)=>song.id===songId))return;
    const library=entryMap.has(songId)?profile.library:profile.library.concat({songId,preferredShift:0,preferredSpeed:1,preferredInstrument:"original",favorite:false});
    const next: UserProfile = {
      ...profile,
      library,
      playlists: profile.playlists.map((playlist) => playlist.id === playlistId && !playlist.songIds.includes(songId)
        ? { ...playlist, songIds: playlist.songIds.concat(songId) }
        : playlist)
    };
    await saveProfile(next);
  }

  async function removeFromPlaylist(playlistId: string, songId: string) {
    await saveProfile({
      ...profile,
      playlists: profile.playlists.map((playlist) => playlist.id === playlistId
        ? { ...playlist, songIds: playlist.songIds.filter((id) => id !== songId) }
        : playlist)
    });
  }

  async function deleteGlobal(song: Song) {
    if (!isMaster) return;
    if (!confirm("Excluir definitivamente " + song.title + " da plataforma?")) return;
    const response = await fetch("/api/catalog/" + song.id + "?actorId=" + encodeURIComponent(currentUserId), { method: "DELETE" });
    await responseData(response,"Não foi possível excluir a música.");
    {
      await onCatalogRefresh();
      await onProfileChange({
        ...profile,
        library: profile.library.filter((entry) => entry.songId !== song.id),
        playlists: profile.playlists.map((playlist) => ({ ...playlist, songIds: playlist.songIds.filter((id) => id !== song.id) }))
      });
    }
  }

  const searchBar = <label className="community-search"><Search size={16}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar música ou artista..."/></label>;

  if (mode === "explore") {
    return <>
      {error&&<div className="notice error" role="alert">{error}</div>}
      <header className="module-head">
        <div><div className="eyebrow">Catálogo global</div><h1>Explorar músicas</h1><p>Tudo que qualquer membro envia aparece aqui uma única vez.</p></div>
        <button className="primary" onClick={() => setImportOpen(true)}><Plus size={17}/> Enviar música</button>
      </header>
      {searchBar}
      <div className="global-song-list">
        {filteredCatalog.map((song) => {
          const saved = entryMap.has(song.id);
          return <article className="global-song-row" key={song.id}>
            {song.cover ? <img src={song.cover} className="global-cover"/> : <div className="global-cover placeholder"><Music2 size={19}/></div>}
            <div className="global-song-main">
              <strong>{song.title}</strong>
              <span>{song.artist}</span>
              <small>Original {song.originalKey}{song.keySource === "detected" ? " · detectado " + String(song.keyConfidence || 0) + "%" : ""}</small>
            </div>
            <div className="global-actions">
              <button className="ghost" onClick={() => onOpenStudio(song)}><Play size={15}/> Abrir</button>
              <button className={saved ? "ghost saved" : "primary"} disabled={saved} onClick={() => runAction(addToLibrary(song))}>{saved ? "Na biblioteca" : "+ Biblioteca"}</button>
              {isMaster && <button className="danger-icon" title="Excluir globalmente" onClick={() => runAction(deleteGlobal(song))}><Trash2 size={16}/></button>}
            </div>
          </article>;
        })}
      </div>
      {importOpen && <ImportSongModal
        actorId={currentUserId}
        onClose={() => setImportOpen(false)}
        onImported={async (song, signal) => { await onCatalogRefresh(); if(signal.aborted)return; setImportOpen(false); onOpenStudio(song); }}
        onDuplicate={(song, signal) => { if(signal.aborted)return; setImportOpen(false); onOpenStudio(song); }}
      />}
    </>;
  }

  if (mode === "library") {
    return <>
      {error&&<div className="notice error" role="alert">{error}</div>}
      <header className="module-head">
        <div><div className="eyebrow">Sua conta</div><h1>Minha biblioteca</h1><p>Organize as músicas do seu jeito. Nada aqui altera a versão global.</p></div>
        <div className="head-actions">
          <button className="secondary" onClick={() => setFolderOpen(true)}><Folder size={16}/> Nova pasta</button>
          <button className="primary" onClick={() => setImportOpen(true)}><Plus size={17}/> Enviar música</button>
        </div>
      </header>
      {searchBar}
      <div className="folder-strip real-folders">
        <button className={"folder " + (activeFolder === "all" ? "active" : "")} onClick={() => setActiveFolder("all")}>Tudo</button>
        <button className={"folder " + (activeFolder === "favorites" ? "active" : "")} onClick={() => setActiveFolder("favorites")}><Heart size={13}/> Favoritas</button>
        {profile.folders.map((folder) => <div className={"folder-wrap " + (activeFolder === folder.id ? "active" : "")} key={folder.id}>
          <button className="folder folder-name" onClick={() => setActiveFolder(folder.id)}>{folder.name}</button>
          <button className="folder-remove" onClick={() => runAction(deleteFolder(folder.id))}><X size={12}/></button>
        </div>)}
      </div>
      <div className="global-song-list library-list">
        {librarySongs.length === 0 && <div className="empty-state"><Music2 size={32}/><strong>Nenhuma música nesta pasta</strong><span>Salve músicas do catálogo ou envie uma nova.</span></div>}
        {librarySongs.map((song) => {
          const entry = entryMap.get(song.id)!;
          return <article className="global-song-row" key={song.id}>
            {song.cover ? <img src={song.cover} className="global-cover"/> : <div className="global-cover placeholder"><Music2 size={19}/></div>}
            <div className="global-song-main">
              <strong>{song.title}</strong><span>{song.artist}</span>
              <small>Meu tom {personalKey(song, entry.preferredShift)} · {entry.preferredInstrument || "Original"} · {String(entry.preferredSpeed || 1)}x</small>
            </div>
            <div className="personal-controls">
              <select value={entry.folderId || ""} onChange={(event) => runAction(updateEntry(song.id, { folderId: event.target.value || undefined }))}>
                <option value="">Sem pasta</option>
                {profile.folders.map((folder) => <option value={folder.id} key={folder.id}>{folder.name}</option>)}
              </select>
              <button className={"heart-btn " + (entry.favorite ? "active" : "")} onClick={() => runAction(updateEntry(song.id, { favorite: !entry.favorite }))}><Heart size={16} fill={entry.favorite ? "currentColor" : "none"}/></button>
              <button className="ghost" onClick={() => onOpenStudio(song)}>Estudar</button>
              <button className="danger-icon" onClick={() => runAction(removeFromLibrary(song.id))}><Trash2 size={15}/></button>
            </div>
          </article>;
        })}
      </div>
      {folderOpen && <NameModal title="Nova pasta" placeholder="Ex.: Culto de domingo" onClose={() => setFolderOpen(false)} onSave={async (name) => { await createFolder(name); setFolderOpen(false); }}/>}
      {importOpen && <ImportSongModal
        actorId={currentUserId}
        onClose={() => setImportOpen(false)}
        onImported={async (song, signal) => { await onCatalogRefresh(); if(signal.aborted)return; await addToLibrary(song); if(signal.aborted)return; setImportOpen(false); onOpenStudio(song); }}
        onDuplicate={async (song, signal) => { await addToLibrary(song); if(signal.aborted)return; setImportOpen(false); onOpenStudio(song); }}
      />}
    </>;
  }

  const selectedPlaylist: Playlist | undefined = profile.playlists.find((playlist) => playlist.id === activePlaylist);
  const playlistSongs = selectedPlaylist ? selectedPlaylist.songIds.map((id) => catalog.find((song) => song.id === id)).filter(Boolean) as Song[] : [];

  if (selectedPlaylist) {
    return <>
      {error&&<div className="notice error" role="alert">{error}</div>}
      <button className="back-button" onClick={() => setActivePlaylist(null)}>← Voltar às playlists</button>
      <header className="module-head">
        <div><div className="eyebrow">Playlist</div><h1>{selectedPlaylist.name}</h1><p>{playlistSongs.length} músicas</p></div>
        <button className="danger-text" onClick={() => runAction(deletePlaylist(selectedPlaylist.id))}><Trash2 size={15}/> Excluir playlist</button>
      </header>
      <div className="playlist-add-box">
        <select defaultValue="" onChange={(event) => { if (event.target.value) { runAction(addToPlaylist(selectedPlaylist.id, event.target.value)); event.currentTarget.value = ""; } }}>
          <option value="" disabled>Adicionar música da biblioteca...</option>
          {catalog.filter((song) => entryMap.has(song.id) && !selectedPlaylist.songIds.includes(song.id)).map((song) => <option value={song.id} key={song.id}>{song.title}</option>)}
        </select>
      </div>
      <div className="global-song-list">
        {playlistSongs.map((song, index) => <article className="global-song-row" key={song.id}>
          <div className="playlist-order">{index + 1}</div>
          {song.cover ? <img src={song.cover} className="global-cover"/> : <div className="global-cover placeholder"><Music2 size={19}/></div>}
          <div className="global-song-main"><strong>{song.title}</strong><span>{song.artist}</span></div>
          <div className="global-actions"><button className="ghost" onClick={() => onOpenStudio(song)}>Estudar</button><button className="danger-icon" onClick={() => runAction(removeFromPlaylist(selectedPlaylist.id, song.id))}><Trash2 size={15}/></button></div>
        </article>)}
      </div>
    </>;
  }

  return <>
      {error&&<div className="notice error" role="alert">{error}</div>}
    <header className="module-head">
      <div><div className="eyebrow">Sua conta</div><h1>Playlists</h1><p>Listas reais, salvas na sua conta e editáveis por você.</p></div>
      <button className="primary" onClick={() => setPlaylistOpen(true)}><Plus size={17}/> Nova playlist</button>
    </header>
    <div className="playlist-grid">
      {profile.playlists.map((playlist) => <button className="playlist-card-real" key={playlist.id} onClick={() => setActivePlaylist(playlist.id)}>
        <div className="playlist-icon"><ListMusic size={25}/></div>
        <strong>{playlist.name}</strong><span>{playlist.songIds.length} músicas</span>
      </button>)}
      {profile.playlists.length === 0 && <div className="empty-state"><ListMusic size={32}/><strong>Nenhuma playlist</strong><span>Crie sua primeira lista de reprodução.</span></div>}
    </div>
    {playlistOpen && <NameModal title="Nova playlist" placeholder="Ex.: Repertório acústico" onClose={() => setPlaylistOpen(false)} onSave={async (name) => { await createPlaylist(name); setPlaylistOpen(false); }}/>}
  </>;
}

function ImportSongModal({actorId,onClose,onImported,onDuplicate}:{
  actorId:string; onClose:()=>void;
  onImported:(song:Song,signal:AbortSignal)=>Promise<void>|void;
  onDuplicate:(song:Song,signal:AbortSignal)=>Promise<void>|void;
}) {
  const [url,setUrl]=useState("");
  const [loading,setLoading]=useState(false);
  const [progress,setProgress]=useState("");
  const [importStarted,setImportStarted]=useState(false);
  const [error,setError]=useState("");
  const [duplicate,setDuplicate]=useState<Song|null>(null);
  const [completedSong,setCompletedSong]=useState<Song|null>(null);
  const requestRef=useRef<AbortController|null>(null);
  const busyRef=useRef(false);

  useEffect(()=>()=>{requestRef.current?.abort();},[]);
  function close(){requestRef.current?.abort();onClose();}
  function begin(){
    if(busyRef.current)return null;
    busyRef.current=true;
    const controller=new AbortController();requestRef.current=controller;
    setLoading(true);setError("");setImportStarted(false);
    return controller;
  }
  function finish(controller:AbortController){
    if(requestRef.current!==controller)return;
    busyRef.current=false;
    if(!controller.signal.aborted){setLoading(false);setProgress("");}
  }

  async function openImported(song:Song,controller:AbortController){
    if(controller.signal.aborted)return;
    try{await onImported(song,controller.signal);}
    catch(issue){
      if(!controller.signal.aborted)setError("A música já foi importada, mas não foi possível atualizar o catálogo ou sua biblioteca. Tente abrir a música novamente. "+importErrorMessage(issue,""));
    }
  }

  async function submit(){
    if(!url.trim()||completedSong)return;
    const controller=begin();if(!controller)return;
    setDuplicate(null);
    try{
      const result=await importSong(url,actorId,{signal:controller.signal,onProgress:({status,message})=>{setProgress(message);if(status!=="submitting")setImportStarted(true);}});
      if(controller.signal.aborted)return;
      if(result.duplicate){setDuplicate(result.song);setError("Essa versão da música já existe na plataforma.");return;}
      setCompletedSong(result.song);
      await openImported(result.song,controller);
    }catch(issue){if(!controller.signal.aborted&&!isImportCancelled(issue))setError(importErrorMessage(issue));}
    finally{finish(controller);}
  }

  async function openDuplicate(){
    if(!duplicate)return;
    const controller=begin();if(!controller)return;
    try{await onDuplicate(duplicate,controller.signal);}
    catch(issue){if(!controller.signal.aborted)setError(importErrorMessage(issue,"Não foi possível salvar esta música."));}
    finally{finish(controller);}
  }

  async function retryOpen(){
    if(!completedSong)return;
    const controller=begin();if(!controller)return;
    try{await openImported(completedSong,controller);}
    finally{finish(controller);}
  }

  return <div className="modal-backdrop" onMouseDown={close}><div className="modal" onMouseDown={(event)=>event.stopPropagation()}>
    <div className="modal-title"><div><div className="eyebrow">Catálogo global</div><h2>Enviar música</h2></div><button className="icon-btn" onClick={close} aria-label="Fechar importação"><X size={17}/></button></div>
    <div className="notice">Antes de baixar, o sistema verifica o vídeo. Se essa versão já existir, nenhuma cópia é criada.</div>
    <label className="field"><span>LINK DO YOUTUBE</span><input autoFocus value={url} disabled={loading||Boolean(completedSong)} onChange={(event)=>{setUrl(event.target.value);setDuplicate(null);setError("");}} placeholder="https://youtube.com/watch?v=..."/></label>
    {progress&&<div className="notice" role="status" style={{marginTop:12}}>{progress}{importStarted&&<p>Você pode fechar esta janela. Depois, atualize o catálogo para conferir a música.</p>}</div>}
    {error&&<div className={"notice "+(duplicate?"":"error")} role="alert" style={{marginTop:12}}>{error}</div>}
    {duplicate&&<button className="duplicate-link" disabled={loading} onClick={()=>void openDuplicate()}>
      {duplicate.cover?<img src={duplicate.cover}/>:<div className="dup-cover"><Music2 size={17}/></div>}
      <div><strong>{duplicate.title}</strong><span>{duplicate.artist}</span><small>Abrir música existente →</small></div>
    </button>}
    <div className="actions">{completedSong?<button className="primary" disabled={loading} onClick={()=>void retryOpen()}>{loading?"Atualizando…":"Abrir música importada"}</button>:<button className="primary" disabled={loading||!url.trim()} onClick={()=>void submit()}>{loading?"Importando…":"Enviar música"}</button>}<button className="ghost" onClick={close}>Fechar</button></div>
  </div></div>;
}

function NameModal({title,placeholder,onClose,onSave}:{title:string;placeholder:string;onClose:()=>void;onSave:(name:string)=>Promise<void>}) {
  const [name,setName]=useState("");
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  async function save(){
    if(saving||!name.trim())return;
    setSaving(true);setError("");
    try{await onSave(name.trim());}
    catch(issue){setError(issue instanceof Error?issue.message:"Não foi possível salvar.");}
    finally{setSaving(false);}
  }
  return <div className="modal-backdrop" onMouseDown={onClose}><div className="modal small-modal" onMouseDown={(event)=>event.stopPropagation()}>
    <div className="modal-title"><h2>{title}</h2><button className="icon-btn" onClick={onClose}><X size={17}/></button></div>
    <label className="field"><span>NOME</span><input autoFocus value={name} onChange={(event)=>setName(event.target.value)} placeholder={placeholder} onKeyDown={(event)=>{if(event.key==="Enter")void save();}}/></label>
    {error&&<div className="notice error" role="alert">{error}</div>}
    <div className="actions"><button className="primary" disabled={saving||!name.trim()} onClick={()=>void save()}>{saving?"Salvando...":"Salvar"}</button></div>
  </div></div>;
}

function personalKey(song:Song,shift:number){
  const keys=["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  const normalized=song.originalKey.replace("Db","C#").replace("Eb","D#").replace("Gb","F#").replace("Ab","G#").replace("Bb","A#");
  const index=keys.indexOf(normalized);
  return index<0?song.originalKey:keys[(index+shift+120)%12];
}
