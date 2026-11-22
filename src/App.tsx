import {Loader2} from 'lucide-react';
import React from 'react';
import {BrowserRouter, Navigate, Route, Routes} from 'react-router-dom';
import {AppShell} from './components/AppShell';
import {AuthProvider, useAuth} from './context/AuthContext';
import {PlayerProvider} from './context/PlayerContext';
import {AuthPage} from './pages/AuthPage';
import {NowPlayingPage} from './pages/NowPlayingPage';
import {PlaylistsLibraryPage} from './pages/PlaylistsLibraryPage';
import {SearchPage} from './pages/SearchPage';
import {SettingsPage} from './pages/SettingsPage';

const AuthenticatedRoutes: React.FC = () => {
  const {user, loading} = useAuth();

  if (loading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#121212] text-[#B3B3B3] gap-3">
        <Loader2 className="w-6 h-6 animate-spin text-[#1DB954]" />
        <span className="font-display text-sm font-medium">Loading xlabplayer...</span>
      </div>
    );
  }

  if (!user) {
    return <AuthPage />;
  }

  return (
    <PlayerProvider>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<PlaylistsLibraryPage />} />
          <Route path="/playlists" element={<PlaylistsLibraryPage />} />
          <Route path="/playlists/:id" element={<PlaylistsLibraryPage />} />
          <Route path="/now-playing" element={<NowPlayingPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/download" element={<Navigate to="/search" replace />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </PlayerProvider>
  );
};

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AuthenticatedRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
