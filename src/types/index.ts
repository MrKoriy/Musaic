export interface Track {
  id: string;
  title: string;
  artist: string;
  album?: string;
  artwork?: string;
  artworkColor?: string;
  url: string;
  duration?: number;
  source: 'local' | 'vk' | 'soundcloud';
}

export interface Album {
  album: string;
  artist: string;
  track_count: number;
  cover_url?: string;
  source?: string;
}

export interface Artist {
  artist: string;
  track_count: number;
  album_count: number;
  cover_url?: string;
}

export interface Playlist {
  id: string;
  name: string;
  description?: string;
  artwork?: string;
  tracks: Track[];
  createdAt: number;
}

export type RepeatMode = 'off' | 'track' | 'queue';

export type RootStackParamList = {
  Onboarding: undefined;
  MainTabs: undefined;
  PlaylistDetail: { playlist: Playlist };
  AlbumDetail: { album: Album };
  ArtistDetail: { artistName: string };
  NowPlaying: undefined;
  AIChat: undefined;
};

export type TabParamList = {
  Home: undefined;
  Search: undefined;
  Library: undefined;
  Profile: undefined;
};
