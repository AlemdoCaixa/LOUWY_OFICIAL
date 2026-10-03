import { useEffect, useRef, type ChangeEvent } from "react";

const MAX_MP3_BYTES = 50 * 1024 * 1024;

function mp3FileError(file: File): string {
  if (!/\.mp3$/i.test(file.name)) return "Selecione um arquivo MP3.";
  if (!file.size) return "O arquivo está vazio. Selecione outro MP3.";
  if (file.size > MAX_MP3_BYTES) return "O MP3 pode ter no máximo 50 MB.";
  return "";
}

type Props = {
  file: File | null;
  title: string;
  artist: string;
  disabled: boolean;
  onFile: (file: File | null) => void;
  onTitle: (value: string) => void;
  onArtist: (value: string) => void;
  onError: (message: string) => void;
};

export default function Mp3UploadFields({file,title,artist,disabled,onFile,onTitle,onArtist,onError}:Props) {
  const inputRef=useRef<HTMLInputElement|null>(null);
  useEffect(()=>{if(!file&&inputRef.current)inputRef.current.value="";},[file]);
  function select(event:ChangeEvent<HTMLInputElement>){
    const selected=event.target.files?.[0]||null;
    const error=selected?mp3FileError(selected):"";
    onError(error);
    if(error){event.target.value="";onFile(null);return;}
    onFile(selected);
    if(selected)onTitle(selected.name.replace(/\.mp3$/i,""));
  }
  return <>
    <label className="field"><span>ARQUIVO MP3</span><input ref={inputRef} type="file" accept=".mp3,audio/mpeg" disabled={disabled} onChange={select}/><small>Até 50 MB · até 2 horas de duração</small></label>
    {file&&<div className="form-grid two">
      <label className="field"><span>NOME DA MÚSICA</span><input value={title} maxLength={160} disabled={disabled} onChange={(event)=>onTitle(event.target.value)} placeholder="Nome da música"/></label>
      <label className="field"><span>ARTISTA (OPCIONAL)</span><input value={artist} maxLength={160} disabled={disabled} onChange={(event)=>onArtist(event.target.value)} placeholder="Nome do artista"/></label>
    </div>}
  </>;
}
