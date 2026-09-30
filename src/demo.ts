import type { Playlist, Song } from "./types";

export const demoSongs: Song[] = [
  { id: "demo-1", title: "Santo Pra Sempre", artist: "Catálogo da comunidade", originalKey: "F", duration: 381, source: "demo", uses: 184 },
  { id: "demo-2", title: "Bondade de Deus", artist: "Catálogo da comunidade", originalKey: "G", duration: 368, source: "demo", uses: 241 },
  { id: "demo-3", title: "Yeshua", artist: "Catálogo da comunidade", originalKey: "D", duration: 422, source: "demo", uses: 119 },
  { id: "demo-4", title: "Lugar Secreto", artist: "Catálogo da comunidade", originalKey: "C", duration: 437, source: "demo", uses: 156 }
];

export const initialPlaylists: Playlist[] = [
  { id: "pl-1", name: "Domingo • 19h", songIds: ["demo-1", "demo-2", "demo-3"], public: false },
  { id: "pl-2", name: "Para estudar voz", songIds: ["demo-2", "demo-4"], public: false }
];
