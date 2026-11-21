import React, {createContext, useCallback, useContext, useEffect, useState} from 'react';
import {apiFetch, setStoredToken} from '../lib/api';
import type {User} from '../types';
import {getCachedTrackIds} from '../utils/offlineStore';

const CACHED_USER_KEY = 'xlabplayer_cached_user';

function readCachedUser(): User | null {
  try {
    const raw = localStorage.getItem(CACHED_USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as User;
    if (parsed && typeof parsed.username === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

function writeCachedUser(user: User | null): void {
  try {
    if (user) localStorage.setItem(CACHED_USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(CACHED_USER_KEY);
  } catch {
    // ignore storage errors
  }
}

const FALLBACK_OFFLINE_USER: User = {
  id: 0,
  username: 'Offline Mode',
  role: 'listener',
  can_download: false,
  created_at: '',
};

interface AuthContextValue {
  user: User | null;
  hasUsers: boolean;
  loading: boolean;
  isOfflineMode: boolean;
  login: (username: string, password: string) => Promise<void>;
  setupAdmin: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshStatus: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider: React.FC<{children: React.ReactNode}> = ({children}) => {
  const [user, setUser] = useState<User | null>(null);
  const [hasUsers, setHasUsers] = useState(true);
  const [loading, setLoading] = useState(true);
  const [isOfflineMode, setIsOfflineMode] = useState<boolean>(
    typeof navigator !== 'undefined' ? !navigator.onLine : false
  );

  const bootIntoOfflineFallback = useCallback(async () => {
    const cachedUser = readCachedUser();
    if (cachedUser) {
      setUser(cachedUser);
      setHasUsers(true);
      setIsOfflineMode(true);
      return;
    }

    const cachedIds = await getCachedTrackIds();
    if (cachedIds.size > 0) {
      setUser(FALLBACK_OFFLINE_USER);
      setHasUsers(true);
      setIsOfflineMode(true);
      return;
    }

    setUser(null);
    setIsOfflineMode(true);
  }, []);

  const refreshStatus = useCallback(async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      await bootIntoOfflineFallback();
      setLoading(false);
      return;
    }

    try {
      const data = await apiFetch<{hasUsers: boolean; user: User | null}>('/api/auth/status');
      setHasUsers(data.hasUsers);
      setUser(data.user);
      setIsOfflineMode(false);
      if (data.user) {
        writeCachedUser(data.user);
      } else {
        writeCachedUser(null);
      }
    } catch {
      await bootIntoOfflineFallback();
    } finally {
      setLoading(false);
    }
  }, [bootIntoOfflineFallback]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    const handleOffline = () => {
      setIsOfflineMode(true);
    };
    const handleOnline = () => {
      void refreshStatus();
    };
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, [refreshStatus]);

  const login = useCallback(async (username: string, password: string) => {
    const data = await apiFetch<{user: User; token: string}>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({username, password}),
    });
    setStoredToken(data.token);
    writeCachedUser(data.user);
    setUser(data.user);
    setHasUsers(true);
    setIsOfflineMode(false);
  }, []);

  const setupAdmin = useCallback(async (username: string, password: string) => {
    const data = await apiFetch<{user: User; token: string}>('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({username, password}),
    });
    setStoredToken(data.token);
    writeCachedUser(data.user);
    setUser(data.user);
    setHasUsers(true);
    setIsOfflineMode(false);
  }, []);

  const logout = useCallback(async () => {
    try {
      if (typeof navigator === 'undefined' || navigator.onLine) {
        await apiFetch('/api/auth/logout', {method: 'POST'});
      }
    } catch {
      // ignore network failure during offline sign-out
    } finally {
      setStoredToken(null);
      writeCachedUser(null);
      setUser(null);
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{user, hasUsers, loading, isOfflineMode, login, setupAdmin, logout, refreshStatus}}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
