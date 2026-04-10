export interface Track {
  id: string;
  source: "local" | "vk" | "soundcloud";
  title: string;
  artist: string;
  album?: string;
  duration: number; // seconds
  coverUrl?: string;
  streamUrl?: string;
  localPath?: string;
  waveformUrl?: string;
  mood?: string;
  genre?: string;
  metadata?: Record<string, unknown>;
}

export interface TrackMeta {
  id: string;
  source: "local" | "vk" | "soundcloud";
  title: string;
  artist: string;
  album?: string;
  duration: number;
  coverUrl?: string;
  bitrate?: number;
}

export interface MusicProvider {
  search(query: string): Promise<Track[]>;
  getStreamUrl(trackId: string): Promise<string>;
  getTrackMetadata(trackId: string): Promise<TrackMeta>;
  getArtistTracks(artistId: string): Promise<Track[]>;
}

export interface VKConfig {
  username: string;
  password: string;
  token?: string;
  tokenExpiry?: number;
}

export interface VKAudioUrl {
  url: string;
  fetchedAt: number; // timestamp ms
}
