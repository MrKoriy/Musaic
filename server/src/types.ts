export interface Track {
  id: string;
  source: "local" | "vk" | "soundcloud" | "yandex" | "youtube";
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
  source: "local" | "vk" | "soundcloud" | "yandex" | "youtube";
  title: string;
  artist: string;
  album?: string;
  duration: number;
  coverUrl?: string;
  bitrate?: number;
}

export interface ProviderSearchOptions {
  limit?: number;
  offset?: number;
}

export interface ProviderStreamOptions {
  bitrate?: number;
  codec?: "mp3" | "aac";
}

export interface ProviderMetadataOptions {
  quality?: "standard" | "high";
}

export interface ProviderArtistOptions {
  limit?: number;
}

export interface MusicProvider {
  search(query: string, options?: ProviderSearchOptions): Promise<Track[]>;
  getStreamUrl(trackId: string, options?: ProviderStreamOptions): Promise<string>;
  getTrackMetadata(trackId: string, options?: ProviderMetadataOptions): Promise<TrackMeta>;
  getArtistTracks(artistId: string, options?: ProviderArtistOptions): Promise<Track[]>;
}

/**
 * Normalize the options accepted by provider implementations. The numeric
 * form is retained for existing server callers and older integrations.
 */
export function resolveProviderSearchOptions(
  optionsOrLimit: ProviderSearchOptions | number | undefined,
  legacyOffset = 0,
  defaultLimit = 50,
): Required<ProviderSearchOptions> {
  if (typeof optionsOrLimit === "number") {
    return {
      limit: optionsOrLimit,
      offset: legacyOffset,
    };
  }
  return {
    limit: optionsOrLimit?.limit ?? defaultLimit,
    offset: optionsOrLimit?.offset ?? 0,
  };
}

export function resolveProviderArtistOptions(
  optionsOrLimit: ProviderArtistOptions | number | undefined,
  defaultLimit = 150,
): Required<ProviderArtistOptions> {
  return {
    limit: typeof optionsOrLimit === "number"
      ? optionsOrLimit
      : optionsOrLimit?.limit ?? defaultLimit,
  };
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
