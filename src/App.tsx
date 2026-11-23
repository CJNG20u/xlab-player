import {Loader2} from 'lucide-react';
import React, {Suspense, lazy} from 'react';
import {BrowserRouter, Navigate, Route, Routes} from 'react-router-dom';
import {AppShell} from './components/AppShell';
import {AuthProvider, useAuth} from './context/AuthContext';
import {PlayerProvider} from './context/PlayerContext';
import {ThemeProvider} from './context/ThemeContext';
import {PlaylistsLibraryPage} from './pages/PlaylistsLibraryPage';

const AuthPage = lazy(() => import('./pages/AuthPage').then((m) => ({default: m.AuthPage})));
const DiscoverPage = lazy(() =>
  import('./pages/DiscoverPage').then((m) => ({default: m.DiscoverPage}))
);
const NowPlayingPage = lazy(() =>
  import('./pages/NowPlayingPage').then((m) => ({default: m.NowPlayingPage}))
);
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((m) => ({default: m.SettingsPage}))
);

const FullScreenLoader: React.FC = () => (
  <div className="flex h-screen w-screen items-center justify-center bg-[var(--bg-primary)] text-[var(--text-secondary)] gap-3">
    <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
    <span className="font-display text-sm font-medium">Loading xlabplayer...</span>
  </div>
);

const AuthenticatedRoutes: React.FC = () => {
  const {user, loading} = useAuth();

  if (loading) {
    return <FullScreenLoader />;
  }

  if (!user) {
    return (
      <Suspense fallback={<FullScreenLoader />}>
        <AuthPage />
      </Suspense>
    );
  }

  return (
    <PlayerProvider>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<PlaylistsLibraryPage />} />
          <Route path="/playlists" element={<PlaylistsLibraryPage />} />
          <Route path="/playlists/:id" element={<PlaylistsLibraryPage />} />
          <Route path="/now-playing" element={<NowPlayingPage />} />
          <Route path="/discover" element={<DiscoverPage />} />
          <Route path="/search" element={<Navigate to="/discover" replace />} />
          <Route path="/download" element={<Navigate to="/discover" replace />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </PlayerProvider>
  );
};

export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <AuthenticatedRoutes />
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}
