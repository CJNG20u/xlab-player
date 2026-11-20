import React, {createContext, useCallback, useContext, useEffect, useState} from 'react';
import {apiFetch, setStoredToken} from '../lib/api';
import type {User} from '../types';

interface AuthContextValue {
  user: User | null;
  hasUsers: boolean;
  loading: boolean;
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

  const refreshStatus = useCallback(async () => {
    try {
      const data = await apiFetch<{hasUsers: boolean; user: User | null}>('/api/auth/status');
      setHasUsers(data.hasUsers);
      setUser(data.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const login = useCallback(async (username: string, password: string) => {
    const data = await apiFetch<{user: User; token: string}>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({username, password}),
    });
    setStoredToken(data.token);
    setUser(data.user);
    setHasUsers(true);
  }, []);

  const setupAdmin = useCallback(async (username: string, password: string) => {
    const data = await apiFetch<{user: User; token: string}>('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({username, password}),
    });
    setStoredToken(data.token);
    setUser(data.user);
    setHasUsers(true);
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiFetch('/api/auth/logout', {method: 'POST'});
    } finally {
      setStoredToken(null);
      setUser(null);
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{user, hasUsers, loading, login, setupAdmin, logout, refreshStatus}}
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
