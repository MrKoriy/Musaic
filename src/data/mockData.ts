import { Track } from '../types';

// Extended track with UI-only fields (artworkColor used for placeholder art)
export interface MockTrack extends Track {
  artworkColor: string;
}

export const MOOD_TAGS = [
  'Energise', 'Feel good', 'Relax', 'Workout',
  'Sad', 'Party', 'Focus', 'Romance', 'Sleep',
];

export const GENRE_COLORS: Record<string, readonly [string, string]> = {
  'Energise':   ['#e91e8c', '#ff6b6b'],
  'Feel good':  ['#22c55e', '#4ade80'],
  'Relax':      ['#3b82f6', '#60a5fa'],
  'Workout':    ['#f97316', '#fb923c'],
  'Sad':        ['#6366f1', '#818cf8'],
  'Party':      ['#ec4899', '#f472b6'],
  'Focus':      ['#14b8a6', '#2dd4bf'],
  'Romance':    ['#e11d48', '#fb7185'],
  'Sleep':      ['#1d4ed8', '#3b82f6'],
};

export const MOCK_TRACKS: MockTrack[] = [
  { id: '1', title: 'Havana', artist: 'Arnie Lennox', album: 'Playlist of the Day', duration: 218, artworkColor: '#8B4513', url: '', source: 'local' },
  { id: '2', title: 'Love Story', artist: 'John Lennon', album: 'Playlist of the Day', duration: 752, artworkColor: '#2E4057', url: '', source: 'local' },
  { id: '3', title: 'Morning Energy Boost', artist: 'Roxy Riversong', album: 'Playlist of the Day', duration: 1115, artworkColor: '#1A6B4A', url: '', source: 'local' },
  { id: '4', title: 'Acoustic Escape', artist: 'Finn Cloverwood', album: 'Playlist of the Day', duration: 2682, artworkColor: '#4A3728', url: '', source: 'local' },
  { id: '5', title: 'Free Mind', artist: 'Teara', album: 'Playlist of the Day', duration: 3862, artworkColor: '#5C2D91', url: '', source: 'local' },
];

export const RECENT_TRACKS: MockTrack[] = [
  { id: 'r1', title: 'Perfect', artist: 'Ed Sheeran', album: 'Divide', duration: 263, artworkColor: '#8B0000', url: '', source: 'local' },
  { id: 'r2', title: 'Roman Picisan', artist: 'Heim Dhiya', album: 'Roman', duration: 241, artworkColor: '#2E4A1A', url: '', source: 'local' },
  { id: 'r3', title: 'Tittle (Deluxe)', artist: 'Meghan Trainor', album: 'Title', duration: 198, artworkColor: '#6B2D91', url: '', source: 'local' },
  { id: 'r4', title: 'Shiver', artist: 'Meghan Trainor', album: "Takin' It Back", duration: 189, artworkColor: '#2D4A6B', url: '', source: 'local' },
  { id: 'r5', title: 'Feel Something', artist: 'Benson Boone', album: 'Fireworks', duration: 217, artworkColor: '#4A1A2E', url: '', source: 'local' },
  { id: 'r6', title: 'Shape of You', artist: 'Ed Sheeran', album: 'Divide', duration: 234, artworkColor: '#1A4A3A', url: '', source: 'local' },
  { id: 'r7', title: 'Bad Habits', artist: 'Ed Sheeran', album: 'Bad Habits', duration: 231, artworkColor: '#4A2D1A', url: '', source: 'local' },
];

export function formatDuration(seconds: number): string {
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ':' + s.toString().padStart(2, '0');
}
