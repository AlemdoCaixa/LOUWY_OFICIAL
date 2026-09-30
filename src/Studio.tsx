import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import * as Tone from "tone";
import {
  BookOpen, ChevronLeft, ChevronRight, Mic2, Music2, Pause, Play,
  Radio, Repeat2, SlidersHorizontal, Square, Trash2, Upload, Volume2
} from "lucide-react";
import { responseData } from "./api";
import { resumeAudioContext, setAudioSessionType } from "./audioSession";
import type { LibraryEntry, LyricLine, Song, UserProfile } from "./types";

const KEYS = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const FLAT_KEYS = ["C","Db","D","Eb","E","F","Gb","G","Ab","A","Bb","B"];
const MIN_PITCH = -12;
const MAX_PITCH = 12;
const STEM_LABELS: Record<string,string> = {
  vocals:"Voz", drums:"Bateria", bass:"Baixo", guitar:"Guitarra", piano:"Piano/Teclado", other:"Outros"
};
const fmt = (seconds = 0) => Math.floor(seconds / 60) + ":" + String(Math.floor(seconds % 60)).padStart(2, "0");

function shiftKey(key:string,shift:number){
  const normalized=key.replace("Db","C#").replace("Eb","D#").replace("Gb","F#").replace("Ab","G#").replace("Bb","A#");
  const index=KEYS.indexOf(normalized);
  if(index<0||shift===0)return key;
  const notation=shift<0?FLAT_KEYS:KEYS;
  return notation[(index+shift+120)%12];
}

function preferredRecorderMimeType(){
  if(typeof MediaRecorder==="undefined"||typeof MediaRecorder.isTypeSupported!=="function")return "";
  const safari=/^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  const candidates=safari
    ? ["audio/mp4","audio/webm;codecs=opus","audio/webm"]
    : ["audio/webm;codecs=opus","audio/webm","audio/mp4"];
  return candidates.find((type)=>MediaRecorder.isTypeSupported(type))||"";
}

function microphoneErrorMessage(error:unknown){
  const name=error instanceof DOMException?error.name:"";
  if(name==="NotAllowedError"||name==="SecurityError")return "O acesso ao microfone foi bloqueado. Clique no cadeado do navegador e permita o microfone para o Louwy.";
  if(name==="NotFoundError"||name==="DevicesNotFoundError")return "Nenhum microfone foi encontrado neste aparelho.";
  if(name==="NotReadableError"||name==="TrackStartError")return "O microfone está ocupado por outro aplicativo. Feche o outro aplicativo e tente novamente.";
  if(name==="OverconstrainedError")return "O navegador não conseguiu usar a configuração solicitada do microfone.";
  if(name==="AbortError")return "O navegador interrompeu a abertura do microfone. Tente novamente.";
  return error instanceof Error?error.message:"Não foi possível iniciar a gravação.";
}

type Props = {
  song: Song | null;
  profile: UserProfile;
  currentUserId: string;
  isMaster: boolean;
  onChoose: () => void;
  onProfileChange: (profile: UserProfile) => Promise<void>;
  onSongUpdate: (song: Pick<Song,"id"> & Partial<Song>) => void;
};

export default function Studio({
  song, profile, currentUserId, isMaster, onChoose, onProfileChange, onSongUpdate
}: Props) {
  const playerRef=useRef<Tone.GrainPlayer|null>(null);
  const startedAtRef=useRef(0);
  const offsetRef=useRef(0);
  const playbackRateRef=useRef(1);
  const playerPlayingRef=useRef(false);
  const playAttemptRef=useRef(0);
  const startingPlaybackRef=useRef(false);
  const recordingSessionRef=useRef(false);
  const mountedRef=useRef(true);
  const recordingSpeedRef=useRef(1);
  const recorderRef=useRef<MediaRecorder|null>(null);
  const chunksRef=useRef<Blob[]>([]);
  const microphoneStreamRef=useRef<MediaStream|null>(null);
  const recordingTimerRef=useRef<number|null>(null);
  const recordingStartedAtRef=useRef(0);
  const takeUrlRef=useRef("");
  const takeAudioRef=useRef<HTMLAudioElement|null>(null);
  const mixVoiceRef=useRef<HTMLAudioElement|null>(null);

  const entry=song?profile.library.find((item)=>item.songId===song.id):undefined;
  const [ready,setReady]=useState(false);
  const [playing,setPlaying]=useState(false);
  const [startingPlayback,setStartingPlayback]=useState(false);
  const [audioLoadAttempt,setAudioLoadAttempt]=useState(0);
  const [position,setPosition]=useState(0);
  const [duration,setDuration]=useState(song?.duration||0);
  const [pitch,setPitch]=useState(entry?.preferredShift||0);
  const [speed,setSpeed]=useState(entry?.preferredSpeed||1);
  const [loopA,setLoopA]=useState(0);
  const [loopB,setLoopB]=useState(song?.duration||0);
  const [looping,setLooping]=useState(false);
  const [loadError,setLoadError]=useState("");
  const [recording,setRecording]=useState(false);
  const [preparingRecorder,setPreparingRecorder]=useState(false);
  const [stoppingRecorder,setStoppingRecorder]=useState(false);
  const [recorderError,setRecorderError]=useState("");
  const [recordingSeconds,setRecordingSeconds]=useState(0);
  const [recordedBytes,setRecordedBytes]=useState(0);
  const [recorderMimeType,setRecorderMimeType]=useState("");
  const [takeUrl,setTakeUrl]=useState("");
  const [takeOffset,setTakeOffset]=useState(0);
  const [mixing,setMixing]=useState(false);
  const [latencyMs,setLatencyMs]=useState(()=>{
    try{const value=Number(localStorage.getItem("louvelab-latency")??80);return Number.isFinite(value)?Math.max(0,Math.min(300,value)):80;}
    catch{return 80;}
  });

  const [stems,setStems]=useState<Record<string,string>>(song?.stems||{});
  const [stemStatus,setStemStatus]=useState<"idle"|"processing"|"ready"|"error">(song?.stems?"ready":"idle");
  const [stemProgress,setStemProgress]=useState(song?.stems?100:0);
  const [stemError,setStemError]=useState("");
  const [sourceMode,setSourceMode]=useState(()=>{
    const preferred=entry?.preferredInstrument||"original";
    return song?.stems?.[preferred]?preferred:"original";
  });

  const [lyrics,setLyrics]=useState<LyricLine[]>(song?.lyrics||[]);
  const [lyricsStatus,setLyricsStatus]=useState<"idle"|"processing"|"ready"|"error">(song?.lyrics?.length?"ready":"idle");
  const [lyricsError,setLyricsError]=useState("");
  const [detectingKey,setDetectingKey]=useState(false);

  const sourceUrl=sourceMode==="original"?song?.audioUrl:stems[sourceMode];


  useEffect(()=>{
    let cancelled=false;
    const old=playerRef.current;
    if(old){try{old.stop();old.dispose();}catch{}}
    playerRef.current=null;
    playerPlayingRef.current=false;
    playAttemptRef.current+=1;startingPlaybackRef.current=false;setStartingPlayback(false);
    offsetRef.current=0;
    mixVoiceRef.current?.pause();mixVoiceRef.current=null;
    setMixing(false);setPlaying(false);setPosition(0);setReady(false);setLoadError("");
    setDuration(song?.duration||0);
    if(!sourceUrl)return;
    const player=new Tone.GrainPlayer({
      url:sourceUrl,grainSize:.16,overlap:.08,detune:pitch*100,playbackRate:speed,loop:false,
      onload:()=>{if(cancelled)return;const d=player.buffer.duration||song?.duration||0;setDuration(d);setLoopB(d);setReady(true);},
      onerror:()=>{if(!cancelled)setLoadError("Não consegui abrir esse áudio.");}
    }).toDestination();
    playerRef.current=player;
    return()=>{
      cancelled=true;playerPlayingRef.current=false;playAttemptRef.current+=1;
      if(playerRef.current===player)playerRef.current=null;
      try{player.stop();player.dispose();}catch{}
    };
  },[song?.id,sourceUrl,audioLoadAttempt]);

  useEffect(()=>{if(playerRef.current)playerRef.current.detune=pitch*100;},[pitch]);
  useEffect(()=>{try{localStorage.setItem("louvelab-latency",String(latencyMs));}catch{}},[latencyMs]);
  useEffect(()=>{
    mountedRef.current=true;
    return()=>{
    mountedRef.current=false;
    mixVoiceRef.current?.pause();mixVoiceRef.current=null;
    takeAudioRef.current?.pause();
    if(recordingTimerRef.current!==null)window.clearInterval(recordingTimerRef.current);
    const recorder=recorderRef.current;
    recorderRef.current=null;
    if(recorder){
      recorder.onstart=null;recorder.ondataavailable=null;recorder.onstop=null;recorder.onerror=null;
      if(recorder.state!=="inactive"){try{recorder.stop();}catch{}}
    }
    microphoneStreamRef.current?.getTracks().forEach((track)=>track.stop());
    recordingSessionRef.current=false;
    setAudioSessionType("auto");
    if(takeUrlRef.current)URL.revokeObjectURL(takeUrlRef.current);
    };
  },[]);

  const handleAudioStateChange=useEffectEvent(()=>{
    if(Tone.getContext().state!=="running"&&playerPlayingRef.current){
      stopPlayer();
      setLoadError("O áudio foi interrompido pelo aparelho. Toque em reproduzir para continuar.");
    }
  });
  useEffect(()=>{
    const context=Tone.getContext();
    context.on("statechange",handleAudioStateChange);
    return()=>{context.off("statechange",handleAudioStateChange);};
  },[]);

  useEffect(()=>{
    const songId=song?.id||"";
    if(!songId||songId.startsWith("demo-"))return;
    let cancelled=false;
    async function check(){
      try{
        const response=await fetch("/api/stems/"+songId);
        if(!response.ok)return;
        const data=await response.json();
        if(cancelled)return;
        setStemStatus(data.status||"idle");
        setStemProgress(Number(data.progress||(data.status==="ready"?100:0)));
        if(data.status==="ready"&&data.stems){
          setStems(data.stems);
          onSongUpdate({id:songId,stems:data.stems});
        }
        if(data.status==="error")setStemError(data.error||"Falha ao separar instrumentos.");
      }catch{}
    }
    void check();
    const timer=window.setInterval(()=>{if(stemStatus==="processing")void check();},1800);
    return()=>{cancelled=true;clearInterval(timer);};
  },[song?.id,stemStatus,onSongUpdate]);

  useEffect(()=>{
    const songId=song?.id||"";
    if(!songId||songId.startsWith("demo-"))return;
    let cancelled=false;
    async function syncLyrics(startIfIdle=false){
      try{
        let response=await fetch("/api/lyrics/"+songId);
        let data=await responseData<{status?:"idle"|"processing"|"ready"|"error";lyrics?:LyricLine[];model?:string;error?:string}>(response,"Não consegui consultar a transcrição.");
        if(cancelled)return;
        if(data.status==="idle"&&startIfIdle){
          response=await fetch("/api/lyrics/"+songId,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
          data=await responseData<typeof data>(response,"Não consegui iniciar a transcrição.");
        }
        if(cancelled)return;
        setLyricsStatus(data.status||"idle");
        if(data.status==="ready"&&Array.isArray(data.lyrics)){
          setLyrics(data.lyrics);setLyricsError("");
          onSongUpdate({id:songId,lyrics:data.lyrics,lyricsModel:data.model||song?.lyricsModel});
        }else if(data.status==="error")setLyricsError(data.error||"Não consegui transcrever a letra.");
      }catch(issue){if(!cancelled){setLyricsStatus("error");setLyricsError(issue instanceof Error?issue.message:"Não consegui consultar a transcrição.");}}
    }
    void syncLyrics(true);
    const timer=window.setInterval(()=>{if(lyricsStatus==="processing")void syncLyrics(false);},2200);
    return()=>{cancelled=true;clearInterval(timer);};
  },[song?.id,lyricsStatus,song?.lyricsModel,onSongUpdate]);

  useEffect(()=>{
    const player=playerRef.current;if(!player)return;
    if(playerPlayingRef.current){offsetRef.current=getPosition();startedAtRef.current=Tone.now();}
    playbackRateRef.current=speed;
    player.playbackRate=speed;
    if(mixVoiceRef.current)mixVoiceRef.current.playbackRate=speed/recordingSpeedRef.current;
  },[speed]);

  const loopEnabled=looping&&loopB>loopA+.05;
  useEffect(()=>{
    const player=playerRef.current;if(!player)return;
    player.loop=loopEnabled;
    player.loopStart=loopA;
    player.loopEnd=Math.max(loopA+.05,loopB||duration);
  },[loopEnabled,loopA,loopB,duration,ready]);

  useEffect(()=>{
    const timer=window.setInterval(()=>{
      if(!playing||!playerRef.current)return;
      let next=getPosition();
      if(loopEnabled&&next>=loopB){next=loopA+((next-loopA)%(loopB-loopA));offsetRef.current=next;startedAtRef.current=Tone.now();}
      if(!loopEnabled&&next>=duration){stopPlayer();setPosition(duration);return;}
      setPosition(Math.max(0,Math.min(duration,next)));
    },100);
    return()=>clearInterval(timer);
  },[playing,speed,loopEnabled,loopA,loopB,duration]);

  function getPosition(){return playerPlayingRef.current?offsetRef.current+(Tone.now()-startedAtRef.current)*playbackRateRef.current:offsetRef.current;}

  function preparePlaybackSession(){
    setAudioSessionType(recordingSessionRef.current?"play-and-record":"playback");
  }

  function restoreAudioSession(){
    const audible=playerPlayingRef.current||Boolean(takeAudioRef.current&&!takeAudioRef.current.paused)||Boolean(mixVoiceRef.current&&!mixVoiceRef.current.paused);
    setAudioSessionType(recordingSessionRef.current?"play-and-record":audible?"playback":"auto");
  }

  async function playPlayer(at=position){
    const player=playerRef.current;
    if(!player||!ready||startingPlaybackRef.current)return false;
    const attempt=++playAttemptRef.current;
    startingPlaybackRef.current=true;setStartingPlayback(true);
    preparePlaybackSession();
    try{
      await resumeAudioContext(Tone.getContext());
      if(!mountedRef.current||playerRef.current!==player||playAttemptRef.current!==attempt)return false;
      if(player.state==="started")player.stop();
      const startAt=at>=duration?0:Math.max(0,at);
      player.detune=pitch*100;player.playbackRate=speed;player.loop=loopEnabled;player.loopStart=loopA;player.loopEnd=Math.max(loopA+.05,loopB||duration);
      player.start(undefined,startAt);
      offsetRef.current=startAt;startedAtRef.current=Tone.now();playbackRateRef.current=speed;playerPlayingRef.current=true;
      setPosition(startAt);setPlaying(true);setLoadError("");
      return true;
    }catch(issue){
      if(mountedRef.current&&playAttemptRef.current===attempt){
        setLoadError(issue instanceof Error?issue.message:"Não foi possível iniciar o áudio.");
        setPlaying(false);playerPlayingRef.current=false;restoreAudioSession();
      }
      return false;
    }finally{
      if(mountedRef.current&&playAttemptRef.current===attempt){startingPlaybackRef.current=false;setStartingPlayback(false);}
    }
  }

  function stopPlayer(){
    const stoppedAt=Math.min(duration,getPosition());
    playAttemptRef.current+=1;startingPlaybackRef.current=false;setStartingPlayback(false);
    playerPlayingRef.current=false;offsetRef.current=stoppedAt;
    try{playerRef.current?.stop();}catch{}
    if(mixVoiceRef.current){mixVoiceRef.current.pause();mixVoiceRef.current=null;}
    restoreAudioSession();
    setPosition(stoppedAt);setPlaying(false);setMixing(false);
  }

  function seek(value:number){setPosition(value);offsetRef.current=value;if(playing)void playPlayer(value);}
  function changePitch(step:number){setPitch((current)=>Math.max(MIN_PITCH,Math.min(MAX_PITCH,current+step)));}
  function localAudio(file:File){if(song)onSongUpdate(Object.assign({},song,{audioUrl:URL.createObjectURL(file)}));}

  async function savePersonal(patch:Partial<LibraryEntry>){
    if(!song)return;
    const current=profile.library.find((item)=>item.songId===song.id);
    const updated=current?{...current,...patch}:{songId:song.id,preferredShift:0,preferredSpeed:1,preferredInstrument:"original",favorite:false,...patch};
    const next:UserProfile={...profile,library:current?profile.library.map((item)=>item.songId===song.id?updated:item):profile.library.concat(updated)};
    try{await onProfileChange(next);setLoadError("");}
    catch(issue){setLoadError(issue instanceof Error?issue.message:"Não foi possível salvar sua preferência.");}
  }

  async function redetectKey(){
    if(!song||song.id.startsWith("demo-")||!isMaster)return;
    setDetectingKey(true);setLoadError("");
    try{
      const response=await fetch("/api/detect-key/"+song.id,{method:"POST"});
      const data=await response.json();
      if(!response.ok)throw new Error(data.error||"Falha ao detectar o tom.");
      onSongUpdate(data as Song);setPitch(0);
    }catch(error){setLoadError(error instanceof Error?error.message:"Falha ao detectar o tom.");}
    finally{setDetectingKey(false);}
  }

  async function updateGlobalKey(key:string){
    if(!song||!isMaster)return;
    try{
      const response=await fetch("/api/catalog/"+song.id,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({actorId:currentUserId,originalKey:key})});
      const data=await responseData<Song>(response,"Não foi possível salvar o tom.");
      onSongUpdate(data);setPitch(0);setLoadError("");
    }catch(issue){setLoadError(issue instanceof Error?issue.message:"Não foi possível salvar o tom.");}
  }

  async function prepareStems(){
    if(!song||song.id.startsWith("demo-")){setStemError("Importe uma faixa do YouTube antes de separar os instrumentos.");return;}
    setStemStatus("processing");setStemProgress(0);setStemError("");
    try{
      const response=await fetch("/api/stems/"+song.id,{method:"POST"});
      const data=await response.json();
      if(!response.ok&&response.status!==202)throw new Error(data.error||"Falha ao iniciar separação.");
      setStemStatus(data.status||"processing");
      if(data.stems){setStems(data.stems);setStemProgress(100);setStemStatus("ready");onSongUpdate({id:song.id,stems:data.stems});}
    }catch(error){setStemStatus("error");setStemError(error instanceof Error?error.message:"Falha ao separar instrumentos.");}
  }

  async function retranscribeLyrics(){
    if(!song||song.id.startsWith("demo-"))return;
    setLyricsStatus("processing");setLyricsError("");setLyrics([]);
    try{
      const response=await fetch("/api/lyrics/"+song.id,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({force:true})});
      const data=await response.json();
      if(!response.ok&&response.status!==202)throw new Error(data.error||"Falha ao iniciar transcrição.");
      setLyricsStatus(data.status||"processing");
    }catch(error){setLyricsStatus("error");setLyricsError(error instanceof Error?error.message:"Falha ao transcrever a letra.");}
  }

  const lyricIndex=useMemo(()=>{let found=-1;lyrics.forEach((line,index)=>{if(line.time!==null&&line.time<=position)found=index;});return found;},[lyrics,position]);

  async function playTakeMix(){
    if(!takeUrl||!ready)return;
    stopPlayer();
    const voice=new Audio(takeUrl);mixVoiceRef.current=voice;voice.preload="auto";voice.onended=()=>stopPlayer();
    try{
      preparePlaybackSession();
      await resumeAudioContext(Tone.getContext());
      await new Promise<void>((resolve,reject)=>{
        const timer=window.setTimeout(()=>finish(new Error("A gravação demorou demais para carregar.")),10000);
        function finish(error?:Error){window.clearTimeout(timer);voice.oncanplay=null;voice.onerror=null;if(error)reject(error);else resolve();}
        if(voice.readyState>=2)finish();
        else{voice.oncanplay=()=>finish();voice.onerror=()=>finish(new Error("Não foi possível reproduzir esta gravação."));}
      });
      if(!mountedRef.current||mixVoiceRef.current!==voice)return;
      voice.currentTime=Math.min(Math.max(0,latencyMs/1000),Math.max(0,voice.duration-.05));
      voice.playbackRate=speed/recordingSpeedRef.current;
      if(!await playPlayer(takeOffset)){voice.pause();restoreAudioSession();return;}
      setMixing(true);await voice.play();
    }catch(issue){
      voice.pause();
      if(mountedRef.current){stopPlayer();setRecorderError(issue instanceof Error?issue.message:"Não foi possível ouvir o mix.");}
    }
  }

  function deleteTake(){
    if(!takeUrl)return;
    if(!window.confirm("Excluir esta gravação?"))return;
    stopPlayer();
    takeAudioRef.current?.pause();
    if(takeAudioRef.current)takeAudioRef.current.currentTime=0;
    if(takeUrlRef.current)URL.revokeObjectURL(takeUrlRef.current);
    takeUrlRef.current="";
    chunksRef.current=[];
    setTakeUrl("");
    setRecordedBytes(0);
    setRecordingSeconds(0);
    setRecorderMimeType("");
    setRecorderError("");
  }

  function stopRecordingClock(){
    if(recordingTimerRef.current!==null){window.clearInterval(recordingTimerRef.current);recordingTimerRef.current=null;}
  }

  function releaseMicrophone(){
    microphoneStreamRef.current?.getTracks().forEach((track)=>track.stop());
    microphoneStreamRef.current=null;
    recordingSessionRef.current=false;restoreAudioSession();
  }

  async function requestMicrophone(){
    const detailed={echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:1};
    try{return await navigator.mediaDevices.getUserMedia({audio:detailed});}
    catch(error){
      if(error instanceof DOMException&&(error.name==="OverconstrainedError"||error.name==="TypeError"))return navigator.mediaDevices.getUserMedia({audio:true});
      throw error;
    }
  }

  async function toggleRecording(){
    const activeRecorder=recorderRef.current;
    if(recording||activeRecorder?.state==="recording"){
      setStoppingRecorder(true);stopPlayer();
      try{activeRecorder?.stop();}catch(error){setRecorderError(microphoneErrorMessage(error));setStoppingRecorder(false);}
      return;
    }
    if(preparingRecorder||stoppingRecorder)return;
    setRecorderError("");setRecordedBytes(0);
    if(!window.isSecureContext){setRecorderError("O microfone só funciona em conexão segura. Abra o Louwy por HTTPS ou em localhost.");return;}
    if(!navigator.mediaDevices?.getUserMedia){setRecorderError("Este navegador não disponibilizou acesso ao microfone. Verifique a permissão e atualize o navegador.");return;}
    if(typeof MediaRecorder==="undefined"){setRecorderError("Este navegador não oferece gravação de áudio compatível.");return;}
    if(!ready||!sourceUrl){setRecorderError("Aguarde o playback terminar de carregar antes de gravar.");return;}

    setPreparingRecorder(true);recordingSessionRef.current=true;
    setAudioSessionType("play-and-record");
    // Unlock audio in this click before the microphone permission prompt can consume the gesture.
    const audioReady=resumeAudioContext(Tone.getContext()).catch(()=>{});
    try{
      const stream=await requestMicrophone();
      if(!mountedRef.current){stream.getTracks().forEach((track)=>track.stop());return;}
      microphoneStreamRef.current=stream;
      await audioReady;
      if(!mountedRef.current)return;
      const selectedMimeType=preferredRecorderMimeType();
      setRecorderMimeType(selectedMimeType||"formato automático");
      let recorder:MediaRecorder;
      try{recorder=new MediaRecorder(stream,selectedMimeType?{mimeType:selectedMimeType,audioBitsPerSecond:128000}:{audioBitsPerSecond:128000});}
      catch{recorder=new MediaRecorder(stream);}
      chunksRef.current=[];recorderRef.current=recorder;
      recorder.ondataavailable=(event)=>{if(mountedRef.current&&recorderRef.current===recorder&&event.data.size>0)chunksRef.current.push(event.data);};
      recorder.onerror=(event)=>{
        if(!mountedRef.current||recorderRef.current!==recorder)return;
        const issue=(event as Event&{error?:DOMException}).error;
        setRecorderError(microphoneErrorMessage(issue||new Error("Falha durante a gravação.")));
      };
      recorder.onstart=()=>{
        if(!mountedRef.current||recorderRef.current!==recorder)return;
        recordingStartedAtRef.current=performance.now();setRecordingSeconds(0);
        recordingTimerRef.current=window.setInterval(()=>setRecordingSeconds(Math.floor((performance.now()-recordingStartedAtRef.current)/1000)),250);
        setPreparingRecorder(false);setStoppingRecorder(false);setRecording(true);
      };
      recorder.onstop=()=>{
        if(!mountedRef.current||recorderRef.current!==recorder)return;
        recorderRef.current=null;
        const elapsed=Math.max(1,Math.round((performance.now()-recordingStartedAtRef.current)/1000));
        setRecordingSeconds(elapsed);stopRecordingClock();releaseMicrophone();setRecording(false);setPreparingRecorder(false);setStoppingRecorder(false);
        const chunks=chunksRef.current.filter((chunk)=>chunk.size>0);
        const size=chunks.reduce((total,chunk)=>total+chunk.size,0);
        if(!size){setRecorderError("A gravação terminou sem áudio. Verifique se o microfone correto está selecionado e tente novamente.");return;}
        const type=recorder.mimeType||selectedMimeType||chunks[0]?.type||"audio/webm";
        const blob=new Blob(chunks,{type});
        if(takeUrlRef.current)URL.revokeObjectURL(takeUrlRef.current);
        const url=URL.createObjectURL(blob);takeUrlRef.current=url;setTakeUrl(url);setRecordedBytes(blob.size);setRecorderError("");
      };
      const startAt=getPosition();recordingSpeedRef.current=speed;setTakeOffset(startAt);recorder.start(250);
      if(!playing&&!await playPlayer(startAt))setRecorderError("O microfone está gravando, mas o playback não conseguiu iniciar. Toque em reproduzir para tentar novamente.");
    }catch(error){
      if(!mountedRef.current)return;
      stopRecordingClock();releaseMicrophone();setPreparingRecorder(false);setStoppingRecorder(false);setRecording(false);
      setRecorderError(microphoneErrorMessage(error));
    }
  }

  if(!song)return <div className="panel"><h2>Nenhuma música selecionada</h2><button className="primary" onClick={onChoose}>Escolher música</button></div>;
  const activeKey=shiftKey(song.originalKey,pitch);

  return <>
    <div className="section-head"><div><div className="eyebrow">Ensaio</div><h1>Estúdio</h1></div><button className="secondary" onClick={onChoose}><BookOpen size={16}/> Escolher música</button></div>
    <div className="studio-shell">
      <section className="player-card">
        <div className="now">
          {song.cover?<img className="big-cover" src={song.cover}/>:<div className="big-cover"><Music2 size={30}/></div>}
          <div><div className="eyebrow">{song.source==="youtube"?"YouTube importado":"Biblioteca"}</div><h2 style={{margin:"3px 0 5px"}}>{song.title}</h2><div className="muted">{song.artist}</div>
            <div className="song-meta-row">{isMaster?<label className="key-edit">Tom original <select className="notranslate" translate="no" value={song.originalKey} onChange={(event)=>void updateGlobalKey(event.target.value)}>{KEYS.map((key)=><option key={key} value={key}>{key}</option>)}</select></label>:<span className="detect-badge notranslate" translate="no">Original {song.originalKey}</span>}
              {song.keySource==="detected"&&<span className="detect-badge">Detectado {song.keyConfidence||0}%</span>}
              {isMaster&&song.source==="youtube"&&<button className="mini-link" disabled={detectingKey} onClick={()=>void redetectKey()}>{detectingKey?"Analisando...":"Detectar novamente"}</button>}
              {sourceMode!=="original"&&<span className="source-badge">Ouvindo {STEM_LABELS[sourceMode]||sourceMode}</span>}
            </div>
          </div>
        </div>

        {!song.audioUrl&&<div className="notice" style={{marginBottom:16}}>Esta música ainda não tem áudio.<label className="ghost" style={{display:"inline-flex",marginLeft:10}}><Upload size={14}/> Arquivo local<input type="file" accept="audio/*" hidden onChange={(event)=>event.target.files?.[0]&&localAudio(event.target.files[0])}/></label></div>}
        {sourceUrl&&!ready&&!loadError&&<div className="notice" role="status" style={{marginBottom:16}}>Carregando áudio…</div>}
        {loadError&&<div className="notice error" role="alert" style={{marginBottom:16}}>{loadError}{!ready&&sourceUrl&&<button className="mini-link" onClick={()=>setAudioLoadAttempt((attempt)=>attempt+1)}>Tentar carregar novamente</button>}</div>}
        {startingPlayback&&<div className="notice" role="status" style={{marginBottom:16}}>Ativando áudio…</div>}

        <input className="timeline" type="range" min={0} max={duration||1} step=".05" value={Math.min(position,duration||0)} onChange={(event)=>seek(Number(event.target.value))}/>
        <div className="time-line"><span>{fmt(position)}</span><span>{fmt(duration)}</span></div>
        <div className="transport"><button className="icon-btn" onClick={()=>seek(Math.max(0,position-10))}><ChevronLeft size={19}/></button><button className="play" disabled={!ready||startingPlayback} aria-label={playing?"Pausar":"Reproduzir"} onClick={()=>playing?stopPlayer():void playPlayer()}>{playing?<Pause/>:<Play fill="currentColor"/>}</button><button className="icon-btn" onClick={()=>seek(Math.min(duration,position+10))}><ChevronRight size={19}/></button></div>

        <div className="control-block pitch-control-block">
          <div className="control-title"><span>Tom <small>meio em meio tom</small></span><span className="key-pill notranslate" translate="no">{activeKey}</span></div>
          <div className="pitch-stepper">
            <button className="pitch-step-button" disabled={pitch<=MIN_PITCH} onClick={()=>changePitch(-1)} aria-label="Abaixar meio tom"><b>−</b><span>½ tom</span></button>
            <div className="pitch-current">
              <strong className="notranslate" translate="no">{activeKey}</strong>
              <span>{pitch===0?`Original (${song.originalKey})`:`${pitch>0?"+":""}${pitch} ${Math.abs(pitch)===1?"semitom":"semitons"}`}</span>
              <button className="mini-link" disabled={pitch===0} onClick={()=>setPitch(0)}>Voltar ao original</button>
            </div>
            <button className="pitch-step-button" disabled={pitch>=MAX_PITCH} onClick={()=>changePitch(1)} aria-label="Subir meio tom"><b>+</b><span>½ tom</span></button>
          </div>
          <input className="pitch-range" type="range" min={MIN_PITCH} max={MAX_PITCH} step={1} value={pitch} onChange={(event)=>setPitch(Number(event.target.value))}/>
          <div className="pitch-range-labels"><span>−12</span><span>Original</span><span>+12</span></div>
          <div className="pitch-help">Cada toque sobe ou desce exatamente <strong>1 semitom (meio tom)</strong>.</div>
          <div className="actions"><button className="ghost" onClick={()=>void savePersonal({preferredShift:pitch,preferredKey:activeKey})}>Salvar {activeKey} como meu tom</button></div>
        </div>
        <div className="control-block"><div className="control-title"><span>Velocidade</span><span className="muted">{speed.toFixed(2)}x</span></div><div className="speed-row">{[.7,.8,.9,1,1.1,1.2].map((value)=><button key={value} className={"pitch-btn "+(speed===value?"active":"")} onClick={()=>setSpeed(value)}>{value}x</button>)}</div><div className="actions"><button className="ghost" onClick={()=>void savePersonal({preferredSpeed:speed})}>Salvar velocidade</button></div></div>
        <div className="control-block"><div className="control-title"><span>Loop A/B</span><Repeat2 size={17}/></div><div className="loop-row"><button className="loop-point" onClick={()=>setLoopA(position)}><strong>A</strong><br/><span className="muted">{fmt(loopA)}</span></button><button className="loop-point" onClick={()=>setLoopB(position)}><strong>B</strong><br/><span className="muted">{fmt(loopB)}</span></button><button className={loopEnabled?"primary":"ghost"} disabled={!loopEnabled&&loopB<=loopA+.05} onClick={()=>setLooping(!loopEnabled)}>{loopEnabled?"Loop ativo":"Ativar loop"}</button></div></div>
      </section>

      <aside className="side-stack">
        <section className="feature-panel recorder-panel">
          <div className="control-title">
            <span><Mic2 size={17} style={{marginRight:7}}/>Gravar minha voz</span>
            {preparingRecorder&&<span className="recorder-badge preparing">Preparando...</span>}
            {recording&&<span className="recorder-badge recording"><i/> REC {fmt(recordingSeconds)}</span>}
          </div>
          <p>Use fone. O playback toca no fone enquanto o microfone grava somente a sua voz.</p>
          {preparingRecorder&&<div className="recorder-preparing"><span className="recorder-spinner"/><div><strong>Abrindo o microfone...</strong><small>Se o navegador pedir permissão, clique em Permitir.</small></div></div>}
          {recording&&<div className="recorder-live"><span className="recorder-live-dot"/><div><strong>Gravação em andamento</strong><small>{fmt(recordingSeconds)} · fale ou cante normalmente</small></div></div>}
          <button className={recording?"secondary":"primary"} style={{width:"100%"}} disabled={preparingRecorder||stoppingRecorder||(!recording&&!ready)} onClick={()=>void toggleRecording()}>
            {stoppingRecorder?<><span className="recorder-spinner small"/> Finalizando gravação...</>:recording?<><Square size={16}/> Parar e gerar take</>:preparingRecorder?<><span className="recorder-spinner small"/> Preparando microfone...</>:<><Mic2 size={16}/> Gravar voz</>}
          </button>
          {!ready&&<small className="recorder-hint">Aguarde o playback carregar para começar.</small>}
          {recorderError&&<div className="notice error recorder-error">{recorderError}<button className="mini-link" onClick={()=>setRecorderError("")}>Fechar</button></div>}
          {takeUrl&&<div className="take">
            <div className="take-head"><div><strong>Take 1 · começa em {fmt(takeOffset)}</strong><span>{fmt(recordingSeconds)} · {Math.max(1,Math.round(recordedBytes/1024))} KB</span></div><button className="take-delete" onClick={deleteTake}><Trash2 size={14}/> Excluir gravação</button></div>
            <audio ref={takeAudioRef} src={takeUrl} controls preload="metadata" onPlay={preparePlaybackSession} onPause={restoreAudioSession} onEnded={restoreAudioSession}/>
            <button className="secondary" onClick={()=>mixing?stopPlayer():void playTakeMix()}>{mixing?<><Square size={15}/> Parar mix</>:<><Play size={15}/> Ouvir voz + instrumental</>}</button>
            <label className="latency">Compensação de latência <strong>{latencyMs} ms</strong><input type="range" min="0" max="300" step="5" value={latencyMs} onChange={(event)=>setLatencyMs(Number(event.target.value))}/></label>
            <small className="take-format">Formato: {recorderMimeType||"automático"}</small>
          </div>}
        </section>

        <section className="feature-panel"><div className="control-title"><span><Radio size={17} style={{marginRight:7}}/>Karaokê</span>{lyricsStatus==="ready"&&<span className="ready-dot">● transcrito</span>}</div>{(lyricsStatus==="idle"||lyricsStatus==="processing")&&<div className="karaoke-loading"><div className="karaoke-pulse">♪</div><strong>{lyricsStatus==="processing"?"Transcrevendo a letra...":"Preparando transcrição..."}</strong><span>O sistema identifica e sincroniza as palavras automaticamente.</span></div>}{lyricsStatus==="error"&&<><div className="notice error">{lyricsError||"Não consegui transcrever esta música."}</div><button className="secondary" style={{width:"100%",marginTop:10}} onClick={()=>void retranscribeLyrics()}>Tentar novamente</button></>}{lyricsStatus==="ready"&&lyrics.length>0&&<><div className="karaoke"><div><div className="karaoke-current">{lyricIndex>=0?(lyrics[lyricIndex].words?.length?lyrics[lyricIndex].words!.map((word,index)=><span key={index} className={position>=word.start&&position<=word.end?"karaoke-word active":position>word.end?"karaoke-word done":"karaoke-word"}>{word.text} </span>):lyrics[lyricIndex].text):"♪ Prepare-se..."}</div><div className="karaoke-next">{lyrics[lyricIndex+1]?.text||""}</div></div></div><button className="mini-link" style={{marginTop:8}} onClick={()=>void retranscribeLyrics()}>Transcrever novamente</button></>}</section>

        <section className="feature-panel"><div className="control-title"><span><Volume2 size={17} style={{marginRight:7}}/>Instrumentos</span>{stemStatus==="ready"&&<span className="ready-dot">● pronto</span>}</div>{stemStatus==="idle"&&<><p>A IA separa voz, bateria, baixo, guitarra, piano/teclado e outros.</p><button className="primary" style={{width:"100%"}} onClick={()=>void prepareStems()}><SlidersHorizontal size={15}/> Separar instrumentos</button></>}{stemStatus==="processing"&&<><p>Separando instrumentos...</p><div className="stem-progress"><span style={{width:Math.max(4,stemProgress)+"%"}}/></div></>}{stemStatus==="error"&&<><div className="notice error">{stemError}</div><button className="secondary" style={{width:"100%",marginTop:10}} onClick={()=>void prepareStems()}>Tentar novamente</button></>}{stemStatus==="ready"&&<><p>Escolha uma pista. Tom, velocidade e loop continuam funcionando.</p><div className="stem-grid"><button className={sourceMode==="original"?"stem-btn active":"stem-btn"} onClick={()=>{setSourceMode("original");void savePersonal({preferredInstrument:"original"});}}>🎵 Original</button>{Object.entries(STEM_LABELS).map(([key,label])=>stems[key]?<button key={key} className={sourceMode===key?"stem-btn active":"stem-btn"} onClick={()=>{setSourceMode(key);void savePersonal({preferredInstrument:key});}}>{key==="vocals"?"🎤":key==="drums"?"🥁":key==="piano"?"🎹":"🎸"} {label}</button>:null)}</div></>}</section>
      </aside>
    </div>
  </>;
}
