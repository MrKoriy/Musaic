export type PublicTrack = {
  id: string;
  source: string;
  title: string;
  artist: string;
  album: string | null;
  duration: number;
  cover_url: string | null;
  waveform_url?: string | null;
  mood?: string | null;
  genre?: string | null;
  play_count?: number;
  last_played_at?: number | null;
  updated_at?: number | null;
  created_at?: number | null;
};

/** Convert an internal DB row into a response without filesystem paths. */
export function publicTrack(row: Record<string, unknown>): PublicTrack {
  return {
    id: String(row.id ?? ""),
    source: String(row.source ?? ""),
    title: String(row.title ?? ""),
    artist: String(row.artist ?? ""),
    album: typeof row.album === "string" ? row.album : null,
    duration: Number(row.duration ?? 0),
    cover_url: typeof row.cover_url === "string" ? row.cover_url : null,
    waveform_url: typeof row.waveform_url === "string" ? row.waveform_url : null,
    mood: typeof row.mood === "string" ? row.mood : null,
    genre: typeof row.genre === "string" ? row.genre : null,
    play_count: Number(row.play_count ?? 0),
    last_played_at: row.last_played_at == null ? null : Number(row.last_played_at),
    updated_at: row.updated_at == null ? null : Number(row.updated_at),
    created_at: row.created_at == null ? null : Number(row.created_at),
  };
}

export function publicTracks(rows: Record<string, unknown>[]): PublicTrack[] {
  return rows.map(publicTrack);
}
