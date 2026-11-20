import {
  AlertTriangle,
  CheckCircle2,
  Cookie,
  Download,
  FolderSearch,
  HardDrive,
  KeyRound,
  Loader2,
  RefreshCw,
  Save,
  Shield,
  Smartphone,
  Terminal,
  Trash2,
  Upload,
  UserPlus,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import React, {useCallback, useEffect, useState} from 'react';
import {DirectoryBrowserModal} from '../components/DirectoryBrowserModal';
import {useAuth} from '../context/AuthContext';
import {usePlayer} from '../context/PlayerContext';
import {usePWAInstall} from '../hooks/usePWAInstall';
import {apiFetch, formatBytes, getSSEUrl} from '../lib/api';
import type {AppSettings, MountHealth, ScanProgress, SystemStatus, User} from '../types';

export const SettingsPage: React.FC = () => {
  const {user} = useAuth();
  const {bumpLibraryRefresh} = usePlayer();
  const {isInstallable, isInstalled, isIOS, install} = usePWAInstall();
  const isAdmin = user?.role === 'admin';

  // Admin: Settings & System Status
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [sysStatus, setSysStatus] = useState<SystemStatus | null>(null);
  const [mountInput, setMountInput] = useState('');
  const [mountHealth, setMountHealth] = useState<MountHealth | null>(null);
  const [dirBrowserOpen, setDirBrowserOpen] = useState(false);
  const [savingMount, setSavingMount] = useState(false);
  const [mountMessage, setMountMessage] = useState<string | null>(null);

  // Live Library Scanner SSE state
  const [scanState, setScanState] = useState<ScanProgress>({
    status: 'idle',
    found: 0,
    scanned: 0,
    imported: 0,
    updated: 0,
    removed: 0,
    currentFile: '',
  });

  // Account Password Change
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwFeedback, setPwFeedback] = useState<{ok: boolean; text: string} | null>(null);
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  // Admin: User Management
  const [users, setUsers] = useState<User[]>([]);
  const [newUsername, setNewUsername] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');
  const [newUserRole, setNewUserRole] = useState<'admin' | 'listener'>('listener');
  const [newUserCanDownload, setNewUserCanDownload] = useState(true);
  const [userFeedback, setUserFeedback] = useState<string | null>(null);
  const [resetUserId, setResetUserId] = useState<number | null>(null);
  const [resetPasswordVal, setResetPasswordVal] = useState('');

  // Admin: Cookies & yt-dlp Resilience
  const [cookiesText, setCookiesText] = useState('');
  const [cookiesBusy, setCookiesBusy] = useState(false);
  const [cookiesFeedback, setCookiesFeedback] = useState<{ok: boolean; text: string} | null>(null);
  const [savingResilience, setSavingResilience] = useState(false);
  const [resilienceFeedback, setResilienceFeedback] = useState<string | null>(null);
  const [updatingYtdlp, setUpdatingYtdlp] = useState(false);
  const [ytdlpUpdateLog, setYtdlpUpdateLog] = useState<string | null>(null);

  const loadAdminData = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const [settingsRes, statusRes, usersRes] = await Promise.all([
        apiFetch<{settings: AppSettings}>('/api/admin/settings'),
        apiFetch<SystemStatus>('/api/admin/system-status'),
        apiFetch<{users: User[]}>('/api/admin/users'),
      ]);
      setSettings(settingsRes.settings);
      setMountInput(settingsRes.settings.music_dir || '');
      setSysStatus(statusRes);
      setMountHealth(statusRes.mountHealth);
      setScanState(statusRes.scan);
      setUsers(usersRes.users || []);
    } catch {
      // ignore
    }
  }, [isAdmin]);

  useEffect(() => {
    void loadAdminData();
  }, [loadAdminData]);

  // Subscribe to Library Scan SSE stream (Admin only)
  useEffect(() => {
    if (!isAdmin) return;
    const es = new EventSource(getSSEUrl('/api/admin/scan/events'));
    es.addEventListener('progress', (event) => {
      try {
        const next = JSON.parse((event as MessageEvent).data) as ScanProgress;
        setScanState(next);
        if (next.status === 'done') {
          bumpLibraryRefresh();
          void loadAdminData();
        }
      } catch {
        // ignore
      }
    });
    return () => es.close();
  }, [isAdmin, bumpLibraryRefresh, loadAdminData]);

  const checkPathHealth = async (pathToCheck: string) => {
    if (!pathToCheck.trim()) return;
    try {
      const health = await apiFetch<MountHealth>(
        `/api/admin/mount-health?path=${encodeURIComponent(pathToCheck.trim())}`
      );
      setMountHealth(health);
    } catch {
      // ignore
    }
  };

  const handleSaveMountPath = async () => {
    if (!mountInput.trim()) return;
    setSavingMount(true);
    setMountMessage(null);
    try {
      const res = await apiFetch<{settings: AppSettings; mountHealth: MountHealth}>(
        '/api/admin/settings',
        {
          method: 'PUT',
          body: JSON.stringify({music_dir: mountInput.trim()}),
        }
      );
      setSettings(res.settings);
      setMountInput(res.settings.music_dir);
      setMountHealth(res.mountHealth);
      setMountMessage('Mount path saved. Library scanner and downloader updated immediately.');
    } catch (err) {
      setMountMessage(err instanceof Error ? err.message : 'Failed to save mount path');
    } finally {
      setSavingMount(false);
    }
  };

  const handleTriggerScan = async (fullReindex: boolean) => {
    try {
      const res = await apiFetch<{scan: ScanProgress}>('/api/admin/scan', {
        method: 'POST',
        body: JSON.stringify({fullReindex}),
      });
      setScanState(res.scan);
    } catch (err) {
      setMountMessage(err instanceof Error ? err.message : 'Failed to start library scan');
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwSaving(true);
    setPwFeedback(null);
    try {
      await apiFetch('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({currentPassword, newPassword}),
      });
      setCurrentPassword('');
      setNewPassword('');
      setPwFeedback({ok: true, text: 'Password updated successfully.'});
    } catch (err) {
      setPwFeedback({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to update password',
      });
    } finally {
      setPwSaving(false);
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setUserFeedback(null);
    try {
      await apiFetch('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          username: newUsername.trim(),
          password: newUserPassword,
          role: newUserRole,
          can_download: newUserRole === 'admin' ? true : newUserCanDownload,
        }),
      });
      setNewUsername('');
      setNewUserPassword('');
      setUserFeedback('User created successfully.');
      await loadAdminData();
    } catch (err) {
      setUserFeedback(err instanceof Error ? err.message : 'Could not create user');
    }
  };

  const handleResetUserPassword = async (targetId: number) => {
    if (resetPasswordVal.length < 6) {
      setUserFeedback('Reset password must be at least 6 characters.');
      return;
    }
    try {
      await apiFetch(`/api/admin/users/${targetId}`, {
        method: 'PUT',
        body: JSON.stringify({newPassword: resetPasswordVal}),
      });
      setResetUserId(null);
      setResetPasswordVal('');
      setUserFeedback('User password reset.');
    } catch (err) {
      setUserFeedback(err instanceof Error ? err.message : 'Could not reset password');
    }
  };

  const handleToggleUserDownload = async (u: User) => {
    try {
      await apiFetch(`/api/admin/users/${u.id}`, {
        method: 'PUT',
        body: JSON.stringify({can_download: !u.can_download}),
      });
      await loadAdminData();
    } catch {
      // ignore
    }
  };

  const handleDeleteUser = async (targetId: number) => {
    setUserFeedback(null);
    try {
      await apiFetch(`/api/admin/users/${targetId}`, {method: 'DELETE'});
      await loadAdminData();
    } catch (err) {
      setUserFeedback(err instanceof Error ? err.message : 'Could not delete user');
    }
  };

  const handleSaveCookiesText = async () => {
    if (!cookiesText.trim()) return;
    setCookiesBusy(true);
    setCookiesFeedback(null);
    try {
      await apiFetch('/api/admin/cookies', {
        method: 'POST',
        body: JSON.stringify({content: cookiesText}),
      });
      setCookiesText('');
      setCookiesFeedback({
        ok: true,
        text: 'Cookies saved securely to ./data/secrets/cookies.txt (0600 permissions).',
      });
      await loadAdminData();
    } catch (err) {
      setCookiesFeedback({
        ok: false,
        text: err instanceof Error ? err.message : 'Could not save cookies',
      });
    } finally {
      setCookiesBusy(false);
    }
  };

  const handleCookiesFileUpload = async (file: File) => {
    setCookiesBusy(true);
    setCookiesFeedback(null);
    try {
      const form = new FormData();
      form.append('file', file);
      await apiFetch('/api/admin/cookies', {method: 'POST', body: form});
      setCookiesFeedback({
        ok: true,
        text: 'cookies.txt uploaded and stored securely with 0600 permissions.',
      });
      await loadAdminData();
    } catch (err) {
      setCookiesFeedback({
        ok: false,
        text: err instanceof Error ? err.message : 'Invalid cookies.txt file',
      });
    } finally {
      setCookiesBusy(false);
    }
  };

  const handleTestCookies = async () => {
    setCookiesBusy(true);
    setCookiesFeedback(null);
    try {
      const res = await apiFetch<{ok: boolean; status: string; message: string}>(
        '/api/admin/cookies/test',
        {method: 'POST'}
      );
      setCookiesFeedback({ok: res.ok, text: res.message});
      await loadAdminData();
    } catch (err) {
      setCookiesFeedback({
        ok: false,
        text: err instanceof Error ? err.message : 'Cookies test failed',
      });
    } finally {
      setCookiesBusy(false);
    }
  };

  const handleDeleteCookies = async () => {
    setCookiesBusy(true);
    try {
      await apiFetch('/api/admin/cookies', {method: 'DELETE'});
      setCookiesFeedback({ok: true, text: 'Removed stored cookies.txt.'});
      await loadAdminData();
    } finally {
      setCookiesBusy(false);
    }
  };

  const handleSaveResilience = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setSavingResilience(true);
    setResilienceFeedback(null);
    try {
      const res = await apiFetch<{settings: AppSettings}>('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({
          ytdlp_path: settings.ytdlp_path,
          ffmpeg_path: settings.ffmpeg_path,
          ytdlp_remote_components: settings.ytdlp_remote_components,
          ytdlp_player_client: settings.ytdlp_player_client,
          ytdlp_sleep_interval: settings.ytdlp_sleep_interval,
          ytdlp_max_sleep_interval: settings.ytdlp_max_sleep_interval,
          ytdlp_force_ipv4: settings.ytdlp_force_ipv4,
          ytdlp_crop_cover: settings.ytdlp_crop_cover,
          ytdlp_extra_flags: settings.ytdlp_extra_flags,
        }),
      });
      setSettings(res.settings);
      setResilienceFeedback('yt-dlp resilience settings saved.');
      await loadAdminData();
    } catch (err) {
      setResilienceFeedback(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSavingResilience(false);
    }
  };

  const handleUpdateYtdlp = async () => {
    setUpdatingYtdlp(true);
    setYtdlpUpdateLog(null);
    try {
      const res = await apiFetch<{ok: boolean; output: string; version: string | null}>(
        '/api/admin/ytdlp/update',
        {method: 'POST'}
      );
      setYtdlpUpdateLog(res.output || (res.ok ? 'yt-dlp updated.' : 'Update failed.'));
      await loadAdminData();
    } catch (err) {
      setYtdlpUpdateLog(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setUpdatingYtdlp(false);
    }
  };

  const scanPct =
    scanState.found > 0 ? Math.min(100, Math.round((scanState.scanned / scanState.found) * 100)) : 0;
  const usedDiskPct =
    mountHealth?.totalBytes && mountHealth.freeBytes !== null
      ? Math.min(
          100,
          Math.round(((mountHealth.totalBytes - mountHealth.freeBytes) / mountHealth.totalBytes) * 100)
        )
      : null;

  return (
    <div className="px-4 sm:px-6 lg:px-8 pt-6 max-w-5xl mx-auto space-y-8">
      <div>
        <h1 className="font-display text-2xl sm:text-3xl font-extrabold tracking-tight text-white">
          Settings
        </h1>
        <p className="mt-1 text-sm text-[#B3B3B3]">
          Configure your NAS music mount, library scanner, accounts, PWA installation, and yt-dlp engine.
        </p>
      </div>

      {/* 1. NAS MUSIC MOUNT & LIBRARY SCANNER (ADMIN ONLY — TOP PRIORITY CARD) */}
      {isAdmin && (
        <section className="rounded-xl bg-[#181818] border border-white/[0.08] p-6 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#1DB954]/15 text-[#1DB954]">
                <HardDrive className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-display text-lg font-bold text-white">
                  NAS Music Mount & Library Scanner
                </h2>
                <p className="text-xs text-[#B3B3B3]">
                  Active music mount for streaming, scanning, uploads, and yt-dlp downloads.
                </p>
              </div>
            </div>
            {sysStatus && (
              <div className="text-xs text-[#B3B3B3] font-mono tabular-nums">
                {sysStatus.trackCount} indexed tracks
              </div>
            )}
          </div>

          {/* Mount Path Input + Browse + Save */}
          <div className="space-y-3">
            <label htmlFor="nas-mount-input" className="block text-xs font-semibold text-[#B3B3B3]">
              Music Directory Mount Path (e.g. /mnt/nas/music)
            </label>
            <div className="flex flex-col sm:flex-row gap-2.5">
              <input
                id="nas-mount-input"
                type="text"
                value={mountInput}
                onChange={(e) => setMountInput(e.target.value)}
                onBlur={() => void checkPathHealth(mountInput)}
                placeholder="/mnt/nas/music"
                className="flex-1 rounded-md bg-[#121212] border border-white/10 px-3.5 py-2.5 font-mono text-sm text-white placeholder-[#6A6A6A] focus:border-[#1DB954] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setDirBrowserOpen(true)}
                className="inline-flex items-center justify-center gap-2 rounded-md bg-[#282828] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#333333] transition-colors whitespace-nowrap shrink-0"
              >
                <FolderSearch className="w-4 h-4 text-[#1DB954]" />
                Browse Folders
              </button>
              <button
                type="button"
                disabled={savingMount || !mountInput.trim()}
                onClick={() => void handleSaveMountPath()}
                className="inline-flex items-center justify-center gap-2 rounded-full bg-[#1DB954] px-5 py-2.5 text-sm font-bold text-black hover:bg-[#1ED760] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                {savingMount ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                Save Mount Path
              </button>
            </div>

            {/* Live Mount Health Indicator + Free Disk Space */}
            {mountHealth && (
              <div className="rounded-lg bg-[#121212] border border-white/[0.06] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  {mountHealth.status === 'ok' ? (
                    <CheckCircle2 className="w-5 h-5 text-[#1DB954] shrink-0" />
                  ) : mountHealth.status === 'read-only' ? (
                    <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
                  ) : (
                    <XCircle className="w-5 h-5 text-red-400 shrink-0" />
                  )}
                  <div>
                    <p
                      className={`text-sm font-semibold ${
                        mountHealth.status === 'ok'
                          ? 'text-[#1DB954]'
                          : mountHealth.status === 'read-only'
                            ? 'text-amber-300'
                            : 'text-red-400'
                      }`}
                    >
                      {mountHealth.status === 'ok'
                        ? 'Read & Write OK'
                        : mountHealth.status === 'read-only'
                          ? 'Read-Only Warning (Streaming OK, downloads disabled)'
                          : 'Path Not Found'}
                    </p>
                    <p className="font-mono text-xs text-[#6A6A6A] truncate max-w-md">
                      {mountHealth.path}
                    </p>
                  </div>
                </div>

                {mountHealth.freeBytes !== null && mountHealth.totalBytes !== null && (
                  <div className="sm:w-56 space-y-1.5">
                    <div className="flex items-center justify-between text-xs font-mono tabular-nums">
                      <span className="text-white font-medium">
                        {formatBytes(mountHealth.freeBytes)} free
                      </span>
                      <span className="text-[#6A6A6A]">
                        of {formatBytes(mountHealth.totalBytes)}
                      </span>
                    </div>
                    {usedDiskPct !== null && (
                      <div className="h-1.5 w-full rounded-full bg-[#282828] overflow-hidden">
                        <div
                          className="h-full bg-[#1DB954]"
                          style={{width: `${usedDiskPct}%`}}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {mountMessage && (
              <p className="text-xs text-[#1DB954] font-medium">{mountMessage}</p>
            )}
          </div>

          {/* Library Scanner Controls + Live SSE Progress */}
          <div className="border-t border-white/10 pt-5 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={scanState.status === 'scanning'}
                onClick={() => void handleTriggerScan(false)}
                className="inline-flex items-center gap-2 rounded-full bg-[#1DB954] px-5 py-2.5 text-sm font-bold text-black hover:bg-[#1ED760] disabled:opacity-50 transition-colors"
              >
                <RefreshCw
                  className={`w-4 h-4 ${scanState.status === 'scanning' ? 'animate-spin' : ''}`}
                />
                {scanState.status === 'scanning'
                  ? 'Scanning Library...'
                  : 'Scan Library for New Music'}
              </button>
              <button
                type="button"
                disabled={scanState.status === 'scanning'}
                onClick={() => void handleTriggerScan(true)}
                className="inline-flex items-center gap-2 rounded-full bg-[#282828] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#333333] disabled:opacity-50 transition-colors"
              >
                Full Re-index
              </button>
            </div>

            {scanState.status !== 'idle' && (
              <div className="rounded-lg bg-[#121212] border border-white/[0.06] p-4 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-white">
                    {scanState.status === 'scanning'
                      ? `Scanning... ${scanState.found} files found, ${scanState.imported} new imported, ${scanState.updated} updated`
                      : scanState.status === 'done'
                        ? `Scan complete — ${scanState.found} files found, ${scanState.imported} new tracks imported, ${scanState.removed} missing removed${scanState.playlistsImported ? `, ${scanState.playlistsImported} M3U playlist${scanState.playlistsImported === 1 ? '' : 's'} synced` : ''}`
                        : scanState.error || 'Scan error'}
                  </span>
                  <span className="font-mono tabular-nums text-[#1DB954]">
                    {scanState.status === 'done' ? '100%' : `${scanPct}%`}
                  </span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-[#282828] overflow-hidden">
                  <div
                    className={`h-full transition-[width] duration-200 ${
                      scanState.status === 'error' ? 'bg-red-500' : 'bg-[#1DB954]'
                    }`}
                    style={{
                      width: `${scanState.status === 'done' ? 100 : Math.max(scanPct, scanState.status === 'scanning' ? 6 : 0)}%`,
                    }}
                  />
                </div>
                {scanState.currentFile && scanState.status === 'scanning' && (
                  <p className="font-mono text-[11px] text-[#6A6A6A] truncate">
                    Reading: {scanState.currentFile}
                  </p>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {/* 2. ACCOUNT & PWA INSTALL STATUS (ALL USERS) */}
      <section className="rounded-xl bg-[#181818] border border-white/[0.08] p-6 space-y-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/10 text-white">
            <KeyRound className="w-5 h-5" />
          </div>
          <div>
            <h2 className="font-display text-lg font-bold text-white">Account & PWA App Status</h2>
            <p className="text-xs text-[#B3B3B3]">
              Signed in as <strong className="text-white">{user?.username}</strong> ({user?.role})
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Change Password */}
          <form onSubmit={handleChangePassword} className="space-y-3.5">
            <h3 className="text-sm font-bold text-white">Change Password</h3>
            <div>
              <label className="block text-xs text-[#B3B3B3] mb-1">Current Password</label>
              <input
                type="password"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="w-full rounded-md bg-[#121212] border border-white/10 px-3 py-2 text-sm text-white focus:border-[#1DB954] focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-[#B3B3B3] mb-1">New Password</label>
              <input
                type="password"
                required
                minLength={6}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Minimum 6 characters"
                className="w-full rounded-md bg-[#121212] border border-white/10 px-3 py-2 text-sm text-white placeholder-[#6A6A6A] focus:border-[#1DB954] focus:outline-none"
              />
            </div>
            {pwFeedback && (
              <p className={`text-xs ${pwFeedback.ok ? 'text-[#1DB954]' : 'text-red-400'}`}>
                {pwFeedback.text}
              </p>
            )}
            <button
              type="submit"
              disabled={pwSaving}
              className="rounded-full bg-white px-5 py-2 text-xs font-bold text-black hover:bg-white/90 disabled:opacity-50"
            >
              {pwSaving ? 'Updating...' : 'Update Password'}
            </button>
          </form>

          {/* PWA Install Status Indicator */}
          <div className="rounded-lg bg-[#121212] border border-white/[0.06] p-5 flex flex-col justify-between space-y-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Smartphone className="w-4 h-4 text-[#1DB954]" />
                <h3 className="text-sm font-bold text-white">xlabplayer Progressive Web App</h3>
              </div>
              <p className="text-xs text-[#B3B3B3] leading-relaxed">
                Install xlabplayer to your phone or desktop home screen for standalone full-screen
                playback, lock-screen MediaSession controls, and CarPlay / Bluetooth integration.
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-white/10">
              <div className="flex items-center gap-2 text-xs font-semibold">
                {isInstalled ? (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-[#1DB954]" />
                    <span className="text-[#1DB954]">Installed (Standalone Mode)</span>
                  </>
                ) : isInstallable ? (
                  <>
                    <Download className="w-4 h-4 text-[#1DB954]" />
                    <span className="text-white">Ready to Install</span>
                  </>
                ) : (
                  <>
                    <Smartphone className="w-4 h-4 text-[#B3B3B3]" />
                    <span className="text-[#B3B3B3]">
                      {isIOS ? 'iOS Safari — Use Share Menu' : 'Browser Mode'}
                    </span>
                  </>
                )}
              </div>

              {!isInstalled && isInstallable && (
                <button
                  type="button"
                  onClick={() => void install()}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[#1DB954] px-4 py-1.5 text-xs font-bold text-black hover:bg-[#1ED760]"
                >
                  <Download className="w-3.5 h-3.5" />
                  Install App
                </button>
              )}

              {!isInstalled && isIOS && (
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(true)}
                  className="rounded-full bg-[#282828] px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#333333]"
                >
                  iOS Install Guide
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* 3. USER MANAGEMENT (ADMIN ONLY) */}
      {isAdmin && (
        <section className="rounded-xl bg-[#181818] border border-white/[0.08] p-6 space-y-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/10 text-white">
              <Users className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-display text-lg font-bold text-white">User Management</h2>
              <p className="text-xs text-[#B3B3B3]">
                Manage admin and listener accounts, download permissions, and password resets.
              </p>
            </div>
          </div>

          {/* Users Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-white/10 text-xs text-[#B3B3B3]">
                  <th className="py-2.5 pr-4 font-medium">Username</th>
                  <th className="py-2.5 pr-4 font-medium">Role</th>
                  <th className="py-2.5 pr-4 font-medium">Downloader Access</th>
                  <th className="py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05]">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-white/[0.02]">
                    <td className="py-3 pr-4 font-medium text-white">
                      {u.username}
                      {u.id === user?.id && (
                        <span className="ml-2 text-xs text-[#6A6A6A]">(you)</span>
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      <span
                        className={`inline-flex items-center gap-1 text-xs font-semibold ${
                          u.role === 'admin' ? 'text-[#1DB954]' : 'text-[#B3B3B3]'
                        }`}
                      >
                        {u.role === 'admin' && <Shield className="w-3.5 h-3.5" />}
                        <span className="capitalize">{u.role}</span>
                      </span>
                    </td>
                    <td className="py-3 pr-4">
                      {u.role === 'admin' ? (
                        <span className="text-xs text-[#B3B3B3]">Full access</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void handleToggleUserDownload(u)}
                          className={`text-xs font-semibold underline-offset-2 hover:underline ${
                            u.can_download ? 'text-[#1DB954]' : 'text-[#6A6A6A]'
                          }`}
                        >
                          {u.can_download ? 'Enabled' : 'Disabled'}
                        </button>
                      )}
                    </td>
                    <td className="py-3 text-right">
                      <div className="inline-flex items-center gap-2">
                        {resetUserId === u.id ? (
                          <div className="flex items-center gap-1.5">
                            <input
                              type="password"
                              value={resetPasswordVal}
                              onChange={(e) => setResetPasswordVal(e.target.value)}
                              placeholder="New password"
                              className="w-32 rounded bg-[#121212] border border-white/15 px-2 py-1 text-xs text-white"
                            />
                            <button
                              type="button"
                              onClick={() => void handleResetUserPassword(u.id)}
                              className="rounded bg-[#1DB954] px-2.5 py-1 text-xs font-bold text-black"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setResetUserId(null);
                                setResetPasswordVal('');
                              }}
                              className="text-xs text-[#B3B3B3] hover:text-white"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setResetUserId(u.id);
                              setResetPasswordVal('');
                            }}
                            className="text-xs text-[#B3B3B3] hover:text-white px-2 py-1 rounded hover:bg-[#282828]"
                          >
                            Reset Password
                          </button>
                        )}
                        {u.id !== user?.id && (
                          <button
                            type="button"
                            onClick={() => void handleDeleteUser(u.id)}
                            className="p-1.5 rounded text-[#B3B3B3] hover:text-red-400 hover:bg-[#282828]"
                            aria-label={`Delete ${u.username}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {userFeedback && <p className="text-xs text-[#1DB954]">{userFeedback}</p>}

          {/* Create User Form */}
          <form
            onSubmit={handleCreateUser}
            className="border-t border-white/10 pt-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end"
          >
            <div>
              <label className="block text-xs text-[#B3B3B3] mb-1">Username</label>
              <input
                type="text"
                required
                minLength={3}
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                placeholder="listener1"
                className="w-full rounded-md bg-[#121212] border border-white/10 px-3 py-2 text-sm text-white placeholder-[#6A6A6A] focus:border-[#1DB954] focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-[#B3B3B3] mb-1">Password</label>
              <input
                type="password"
                required
                minLength={6}
                value={newUserPassword}
                onChange={(e) => setNewUserPassword(e.target.value)}
                placeholder="Min 6 chars"
                className="w-full rounded-md bg-[#121212] border border-white/10 px-3 py-2 text-sm text-white placeholder-[#6A6A6A] focus:border-[#1DB954] focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-[#B3B3B3] mb-1">Role</label>
              <select
                value={newUserRole}
                onChange={(e) =>
                  setNewUserRole(e.target.value === 'admin' ? 'admin' : 'listener')
                }
                className="w-full rounded-md bg-[#121212] border border-white/10 px-3 py-2 text-sm text-white focus:border-[#1DB954] focus:outline-none"
              >
                <option value="listener">Listener</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <label className="flex items-center gap-2 py-2 text-xs text-[#B3B3B3] cursor-pointer">
              <input
                type="checkbox"
                checked={newUserRole === 'admin' ? true : newUserCanDownload}
                disabled={newUserRole === 'admin'}
                onChange={(e) => setNewUserCanDownload(e.target.checked)}
                className="h-4 w-4 accent-[#1DB954]"
              />
              <span>Allow Downloads</span>
            </label>
            <button
              type="submit"
              className="inline-flex items-center justify-center gap-2 rounded-full bg-[#1DB954] px-4 py-2 text-sm font-bold text-black hover:bg-[#1ED760] whitespace-nowrap"
            >
              <UserPlus className="w-4 h-4" />
              Create User
            </button>
          </form>
        </section>
      )}

      {/* 4. YT-DLP & COOKIES RESILIENCE ENGINE (ADMIN ONLY) */}
      {isAdmin && settings && (
        <section className="rounded-xl bg-[#181818] border border-white/[0.08] p-6 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#1DB954]/15 text-[#1DB954]">
                <Terminal className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-display text-lg font-bold text-white">
                  yt-dlp & Cookies Resilience Engine
                </h2>
                <p className="text-xs text-[#B3B3B3]">
                  Manage Netscape cookies, YouTube extractor fallbacks, FFmpeg 1:1 cover cropping, and engine updates.
                </p>
              </div>
            </div>

            <button
              type="button"
              disabled={updatingYtdlp}
              onClick={() => void handleUpdateYtdlp()}
              className="inline-flex items-center justify-center gap-2 rounded-full bg-[#282828] px-4 py-2 text-xs font-bold text-white hover:bg-[#333333] disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${updatingYtdlp ? 'animate-spin' : ''}`} />
              Update yt-dlp Engine
            </button>
          </div>

          {/* Installed Binaries Banner */}
          {sysStatus && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-lg bg-[#121212] border border-white/[0.06] p-4 flex items-center justify-between">
                <div>
                  <p className="text-xs text-[#B3B3B3]">yt-dlp Binary</p>
                  <p className="font-mono text-sm font-semibold text-white mt-0.5">
                    {sysStatus.ytdlp.installed
                      ? `v${sysStatus.ytdlp.version}`
                      : 'Not installed on host'}
                  </p>
                </div>
                {sysStatus.ytdlp.installed ? (
                  <CheckCircle2 className="w-5 h-5 text-[#1DB954]" />
                ) : (
                  <AlertTriangle className="w-5 h-5 text-amber-400" />
                )}
              </div>

              <div className="rounded-lg bg-[#121212] border border-white/[0.06] p-4 flex items-center justify-between">
                <div>
                  <p className="text-xs text-[#B3B3B3]">FFmpeg Binary</p>
                  <p className="font-mono text-sm font-semibold text-white mt-0.5">
                    {sysStatus.ffmpeg.installed
                      ? sysStatus.ffmpeg.version
                      : 'Not installed on host'}
                  </p>
                </div>
                {sysStatus.ffmpeg.installed ? (
                  <CheckCircle2 className="w-5 h-5 text-[#1DB954]" />
                ) : (
                  <AlertTriangle className="w-5 h-5 text-amber-400" />
                )}
              </div>
            </div>
          )}

          {ytdlpUpdateLog && (
            <pre className="rounded-lg bg-[#121212] border border-white/10 p-3 font-mono text-xs text-[#B3B3B3] whitespace-pre-wrap overflow-x-auto">
              {ytdlpUpdateLog}
            </pre>
          )}

          {/* Cookies Management */}
          <div className="border-t border-white/10 pt-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Cookie className="w-4 h-4 text-[#1DB954]" />
                <h3 className="text-sm font-bold text-white">Netscape cookies.txt</h3>
                {sysStatus && (
                  <span
                    className={`text-xs font-semibold ml-2 ${
                      sysStatus.cookies.status === 'active'
                        ? 'text-[#1DB954]'
                        : sysStatus.cookies.status === 'expired'
                          ? 'text-red-400'
                          : 'text-[#B3B3B3]'
                    }`}
                  >
                    · Status:{' '}
                    {sysStatus.cookies.status === 'active'
                      ? 'Active'
                      : sysStatus.cookies.status === 'expired'
                        ? 'Expired / Rejected'
                        : sysStatus.cookies.exists
                          ? 'Uploaded (Untested)'
                          : 'Not Configured'}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                <label className="inline-flex items-center gap-1.5 rounded-md bg-[#282828] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#333333] cursor-pointer">
                  <Upload className="w-3.5 h-3.5" />
                  Upload File
                  <input
                    type="file"
                    accept=".txt"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleCookiesFileUpload(f);
                    }}
                  />
                </label>
                <button
                  type="button"
                  disabled={cookiesBusy || !sysStatus?.cookies.exists}
                  onClick={() => void handleTestCookies()}
                  className="rounded-md bg-[#282828] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#333333] disabled:opacity-40"
                >
                  Test Cookies
                </button>
                {sysStatus?.cookies.exists && (
                  <button
                    type="button"
                    disabled={cookiesBusy}
                    onClick={() => void handleDeleteCookies()}
                    className="rounded-md bg-[#282828] px-3 py-1.5 text-xs font-semibold text-red-400 hover:bg-[#333333]"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>

            <p className="text-xs text-[#6A6A6A]">
              Saved to <code className="font-mono text-[#B3B3B3]">./data/secrets/cookies.txt</code>{' '}
              with <code className="font-mono text-[#B3B3B3]">0600</code> permissions. Each download
              uses an isolated temp copy so yt-dlp never corrupts your master file.
            </p>

            <div className="space-y-2">
              <textarea
                rows={4}
                value={cookiesText}
                onChange={(e) => setCookiesText(e.target.value)}
                placeholder="# Netscape HTTP Cookie File&#10;.youtube.com	TRUE	/	TRUE	..."
                className="w-full rounded-md bg-[#121212] border border-white/10 p-3 font-mono text-xs text-white placeholder-[#6A6A6A] focus:border-[#1DB954] focus:outline-none"
              />
              <div className="flex items-center justify-between gap-3">
                <div>
                  {cookiesFeedback && (
                    <p
                      className={`text-xs ${
                        cookiesFeedback.ok ? 'text-[#1DB954]' : 'text-red-400'
                      }`}
                    >
                      {cookiesFeedback.text}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  disabled={cookiesBusy || !cookiesText.trim()}
                  onClick={() => void handleSaveCookiesText()}
                  className="rounded-full bg-white px-4 py-1.5 text-xs font-bold text-black hover:bg-white/90 disabled:opacity-40"
                >
                  Save Pasted Cookies
                </button>
              </div>
            </div>
          </div>

          {/* Resilience Controls Form */}
          <form onSubmit={handleSaveResilience} className="border-t border-white/10 pt-5 space-y-5">
            <h3 className="text-sm font-bold text-white">Extractor & Post-Processing Controls</h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-[#B3B3B3] mb-1">
                  player_client Fallback Order
                </label>
                <input
                  type="text"
                  value={settings.ytdlp_player_client}
                  onChange={(e) =>
                    setSettings({...settings, ytdlp_player_client: e.target.value})
                  }
                  placeholder="web,mweb,android_vr"
                  className="w-full rounded-md bg-[#121212] border border-white/10 px-3 py-2 font-mono text-sm text-white focus:border-[#1DB954] focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#B3B3B3] mb-1">
                    sleep-interval (sec)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={60}
                    value={settings.ytdlp_sleep_interval}
                    onChange={(e) =>
                      setSettings({...settings, ytdlp_sleep_interval: e.target.value})
                    }
                    className="w-full rounded-md bg-[#121212] border border-white/10 px-3 py-2 font-mono text-sm text-white focus:border-[#1DB954] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#B3B3B3] mb-1">
                    max-sleep-interval (sec)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={120}
                    value={settings.ytdlp_max_sleep_interval}
                    onChange={(e) =>
                      setSettings({...settings, ytdlp_max_sleep_interval: e.target.value})
                    }
                    className="w-full rounded-md bg-[#121212] border border-white/10 px-3 py-2 font-mono text-sm text-white focus:border-[#1DB954] focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs text-[#B3B3B3] mb-1">yt-dlp Binary Path</label>
                <input
                  type="text"
                  value={settings.ytdlp_path}
                  onChange={(e) => setSettings({...settings, ytdlp_path: e.target.value})}
                  placeholder="yt-dlp"
                  className="w-full rounded-md bg-[#121212] border border-white/10 px-3 py-2 font-mono text-sm text-white focus:border-[#1DB954] focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs text-[#B3B3B3] mb-1">FFmpeg Binary Path</label>
                <input
                  type="text"
                  value={settings.ffmpeg_path}
                  onChange={(e) => setSettings({...settings, ffmpeg_path: e.target.value})}
                  placeholder="ffmpeg"
                  className="w-full rounded-md bg-[#121212] border border-white/10 px-3 py-2 font-mono text-sm text-white focus:border-[#1DB954] focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs text-[#B3B3B3] mb-1">Custom Extra CLI Flags</label>
              <input
                type="text"
                value={settings.ytdlp_extra_flags}
                onChange={(e) => setSettings({...settings, ytdlp_extra_flags: e.target.value})}
                placeholder="--geo-bypass --concurrent-fragments 4"
                className="w-full rounded-md bg-[#121212] border border-white/10 px-3 py-2 font-mono text-sm text-white placeholder-[#6A6A6A] focus:border-[#1DB954] focus:outline-none"
              />
            </div>

            {/* Boolean Resilience Toggles */}
            <div className="space-y-3 rounded-lg bg-[#121212] border border-white/[0.06] p-4">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.ytdlp_remote_components === 'true'}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      ytdlp_remote_components: e.target.checked ? 'true' : 'false',
                    })
                  }
                  className="mt-0.5 h-4 w-4 accent-[#1DB954]"
                />
                <div>
                  <span className="text-sm font-medium text-white">
                    Enable <code className="font-mono text-[#1DB954]">--remote-components ejs:github</code>
                  </span>
                  <p className="text-xs text-[#6A6A6A]">
                    Fetches up-to-date YouTube JS n-challenge solvers automatically.
                  </p>
                </div>
              </label>

              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.ytdlp_force_ipv4 === 'true'}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      ytdlp_force_ipv4: e.target.checked ? 'true' : 'false',
                    })
                  }
                  className="mt-0.5 h-4 w-4 accent-[#1DB954]"
                />
                <div>
                  <span className="text-sm font-medium text-white">
                    Force IPv4 (<code className="font-mono text-[#1DB954]">--force-ipv4</code>)
                  </span>
                  <p className="text-xs text-[#6A6A6A]">
                    Prevents IPv6 range throttling and 403 errors on homelab ISPs.
                  </p>
                </div>
              </label>

              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.ytdlp_crop_cover === 'true'}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      ytdlp_crop_cover: e.target.checked ? 'true' : 'false',
                    })
                  }
                  className="mt-0.5 h-4 w-4 accent-[#1DB954]"
                />
                <div>
                  <span className="text-sm font-medium text-white">
                    FFmpeg 1:1 Square Album Art Crop Filter
                  </span>
                  <p className="text-xs text-[#6A6A6A]">
                    Applies <code className="font-mono">-vf &quot;crop=&apos;min(iw,ih)&apos;:&apos;min(iw,ih)&apos;&quot;</code> so 16:9 YouTube thumbnails embed as crisp square covers.
                  </p>
                </div>
              </label>
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                {resilienceFeedback && (
                  <p className="text-xs font-medium text-[#1DB954]">{resilienceFeedback}</p>
                )}
              </div>
              <button
                type="submit"
                disabled={savingResilience}
                className="inline-flex items-center gap-2 rounded-full bg-[#1DB954] px-6 py-2.5 text-sm font-bold text-black hover:bg-[#1ED760] disabled:opacity-50"
              >
                {savingResilience ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                Save Resilience Settings
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Directory Browser Modal */}
      <DirectoryBrowserModal
        open={dirBrowserOpen}
        initialPath={mountInput || '/mnt'}
        onClose={() => setDirBrowserOpen(false)}
        onSelect={(selectedPath) => {
          setMountInput(selectedPath);
          void checkPathHealth(selectedPath);
        }}
      />

      {/* iOS Safari Install Guide Modal */}
      {showIOSGuide && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs">
          <div className="w-full max-w-sm rounded-xl bg-[#181818] border border-white/10 p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-lg font-bold text-white">
                Install xlabplayer on iOS
              </h3>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="p-1 text-[#B3B3B3] hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <ol className="list-decimal list-inside space-y-2 text-sm text-[#B3B3B3]">
              <li>
                Tap the <strong className="text-white">Share</strong> button in Safari&apos;s toolbar.
              </li>
              <li>
                Scroll down and tap <strong className="text-white">Add to Home Screen</strong>.
              </li>
              <li>
                Tap <strong className="text-white">Add</strong> to launch xlabplayer as a standalone app.
              </li>
            </ol>
            <button
              type="button"
              onClick={() => setShowIOSGuide(false)}
              className="w-full rounded-full bg-[#1DB954] py-2.5 text-sm font-bold text-black"
            >
              Got It
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
