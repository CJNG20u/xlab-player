import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  Cookie,
  Download,
  FolderSearch,
  HardDrive,
  HardDriveDownload,
  KeyRound,
  Loader2,
  LogOut,
  MonitorSpeaker,
  Palette,
  RefreshCw,
  Save,
  Shield,
  Smartphone,
  Sparkles,
  Terminal,
  Trash2,
  Upload,
  UserPlus,
  Users,
  WifiOff,
  X,
  XCircle,
} from 'lucide-react';
import React, {useCallback, useEffect, useState} from 'react';
import {DirectoryBrowserModal} from '../components/DirectoryBrowserModal';
import {useAuth} from '../context/AuthContext';
import {usePlayer} from '../context/PlayerContext';
import {THEME_OPTIONS, useTheme} from '../context/ThemeContext';
import {useOnlineStatus} from '../hooks/useOnlineStatus';
import {usePWAInstall} from '../hooks/usePWAInstall';
import {apiFetch, formatBytes, getSSEUrl} from '../lib/api';
import {
  getDefaultDeviceName,
  getDeviceName,
  setDeviceName,
} from '../lib/deviceIdentity';
import {
  getListeningLearningEnabled,
  setListeningLearningEnabled,
} from '../lib/listeningLearning';
import {useScrollReady} from '../lib/scrollHistory';
import type {AppSettings, MountHealth, ScanProgress, SystemStatus, User} from '../types';
import {
  clearAllOfflineMusic,
  getOfflineStorageUsage,
  isOfflineCachingSupported,
  subscribeOfflineStore,
  type OfflineStorageUsage,
} from '../utils/offlineStore';

export const SettingsPage: React.FC = () => {
  const {user, isOfflineMode, logout} = useAuth();
  const isOnline = useOnlineStatus();
  const offline = !isOnline || isOfflineMode;
  const {bumpLibraryRefresh, autoplayEnabled, setAutoplayEnabled} = usePlayer();
  const {theme, setTheme} = useTheme();
  const {isInstallable, isInstalled, isIOS, install} = usePWAInstall();
  const isAdmin = user?.role === 'admin' && !offline;

  // Admin: Settings & System Status
  const [adminDataLoaded, setAdminDataLoaded] = useState(!isAdmin);
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

  // Offline Storage (All Users)
  const offlineSupported = isOfflineCachingSupported();
  const [offlineUsage, setOfflineUsage] = useState<OfflineStorageUsage | null>(null);
  const [clearingOffline, setClearingOffline] = useState(false);
  const [confirmClearOffline, setConfirmClearOffline] = useState(false);
  const [offlineFeedback, setOfflineFeedback] = useState<string | null>(null);

  // Listening Data Preferences (All Users)
  const [learnFromListening, setLearnFromListening] = useState<boolean>(() =>
    getListeningLearningEnabled(user?.id)
  );
  const [clearingListening, setClearingListening] = useState(false);
  const [confirmClearListening, setConfirmClearListening] = useState(false);
  const [listeningFeedback, setListeningFeedback] = useState<{ok: boolean; text: string} | null>(
    null
  );

  // Device Identity (All Users)
  const [deviceNameInput, setDeviceNameInput] = useState<string>(() => getDeviceName());
  const [deviceNameFeedback, setDeviceNameFeedback] = useState<string | null>(null);

  const handleSaveDeviceName = (e: React.FormEvent) => {
    e.preventDefault();
    const saved = setDeviceName(deviceNameInput);
    setDeviceNameInput(saved);
    setDeviceNameFeedback(`Device name saved as "${saved}".`);
  };

  useEffect(() => {
    setLearnFromListening(getListeningLearningEnabled(user?.id));
  }, [user?.id]);

  const handleToggleLearnFromListening = () => {
    const next = !learnFromListening;
    setLearnFromListening(next);
    setListeningLearningEnabled(user?.id, next);
  };

  const handleClearListeningData = async () => {
    setClearingListening(true);
    setListeningFeedback(null);
    try {
      await apiFetch('/api/listening', {method: 'DELETE'});
      setConfirmClearListening(false);
      setListeningFeedback({
        ok: true,
        text: 'Your listening data has been cleared.',
      });
    } catch (err) {
      setListeningFeedback({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to clear listening data.',
      });
    } finally {
      setClearingListening(false);
    }
  };

  const loadOfflineUsage = useCallback(async () => {
    const usage = await getOfflineStorageUsage();
    setOfflineUsage(usage);
  }, []);

  useEffect(() => {
    void loadOfflineUsage();
    return subscribeOfflineStore(() => {
      void loadOfflineUsage();
    });
  }, [loadOfflineUsage]);

  const handleClearAllOffline = async () => {
    setClearingOffline(true);
    setOfflineFeedback(null);
    try {
      await clearAllOfflineMusic();
      setConfirmClearOffline(false);
      await loadOfflineUsage();
      setOfflineFeedback('All offline music and cached covers have been cleared from this device.');
    } catch (err) {
      setOfflineFeedback(err instanceof Error ? err.message : 'Failed to clear offline storage.');
    } finally {
      setClearingOffline(false);
    }
  };

  // Admin: Cookies & yt-dlp Resilience
  const [cookiesText, setCookiesText] = useState('');
  const [cookiesBusy, setCookiesBusy] = useState(false);
  const [cookiesFeedback, setCookiesFeedback] = useState<{ok: boolean; text: string} | null>(null);
  const [savingResilience, setSavingResilience] = useState(false);
  const [resilienceFeedback, setResilienceFeedback] = useState<string | null>(null);
  const [updatingYtdlp, setUpdatingYtdlp] = useState(false);
  const [ytdlpUpdateLog, setYtdlpUpdateLog] = useState<string | null>(null);

  const loadAdminData = useCallback(async () => {
    if (!isAdmin) {
      setAdminDataLoaded(true);
      return;
    }
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
    } finally {
      setAdminDataLoaded(true);
    }
  }, [isAdmin]);

  useEffect(() => {
    void loadAdminData();
  }, [loadAdminData]);

  useScrollReady(!isAdmin || adminDataLoaded);

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
          ytdlp_download_quality: settings.ytdlp_download_quality || 'ultra',
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
    <div
      className="px-4 sm:px-6 lg:px-8 max-w-5xl mx-auto space-y-8"
      style={{paddingTop: 'calc(1.25rem + env(safe-area-inset-top, 0px))'}}
    >
      <div>
        <h1 className="font-display text-2xl sm:text-3xl font-extrabold tracking-tight text-[var(--text-primary)]">
          Settings
        </h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          Customize appearance, NAS music mount, offline storage, library scanner, accounts, PWA installation, and yt-dlp engine.
        </p>
      </div>

      {offline && (
        <div className="flex items-center gap-3 rounded-xl bg-[var(--warn-bg)] border border-[var(--warn-border)] px-4 py-3 text-xs text-[var(--warn-text)]">
          <WifiOff className="w-4 h-4 shrink-0" />
          <span>
            Offline Mode is active. Server settings require a NAS connection, while Appearance and Offline Storage work anytime.
          </span>
        </div>
      )}

      {/* 0. APPEARANCE / MULTI-THEME SWITCHER (ALL USERS) */}
      <section className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-6 space-y-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
            <Palette className="w-5 h-5" />
          </div>
          <div>
            <h2 className="font-display text-lg font-bold text-[var(--text-primary)]">
              Appearance
            </h2>
            <p className="text-xs text-[var(--text-secondary)]">
              Switch between Spotify Dark, Apple Music Dark, Apple Music Light, and Tidal Dark.
            </p>
          </div>
        </div>

        <div
          role="radiogroup"
          aria-label="App visual theme"
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5"
        >
          {THEME_OPTIONS.map((option) => {
            const isSelected = theme === option.id;
            const p = option.preview;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={isSelected}
                onClick={() => setTheme(option.id)}
                className={`group flex flex-col text-left rounded-xl p-3 border transition-all focus:outline-none ${
                  isSelected
                    ? 'border-[var(--accent)] ring-1 ring-[var(--accent)] bg-[var(--accent-soft)]'
                    : 'border-[var(--border-subtle)] bg-[var(--bg-primary)] hover:border-[var(--border-strong)]'
                }`}
              >
                {/* Miniature UI Preview */}
                <div
                  className="relative w-full h-24 rounded-lg overflow-hidden mb-3 flex flex-col justify-between p-2.5 select-none"
                  style={{
                    backgroundColor: p.bg,
                    border: `1px solid ${p.border}`,
                  }}
                >
                  {/* Top mock header + accent play dot */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="space-y-1 flex-1 min-w-0">
                      <div
                        className="h-2 w-16 rounded-full"
                        style={{backgroundColor: p.text, opacity: 0.9}}
                      />
                      <div
                        className="h-1.5 w-11 rounded-full"
                        style={{backgroundColor: p.muted, opacity: 0.65}}
                      />
                    </div>
                    <div
                      className="h-6 w-6 rounded-full flex items-center justify-center shrink-0 shadow-sm"
                      style={{backgroundColor: p.accent}}
                    >
                      <div
                        className="ml-0.5 w-0 h-0 border-y-[4px] border-y-transparent border-l-[6px]"
                        style={{
                          borderLeftColor:
                            option.id === 'spotify-dark' || option.id === 'tidal-dark'
                              ? '#000000'
                              : '#FFFFFF',
                        }}
                      />
                    </div>
                  </div>

                  {/* Mock surface card row */}
                  <div
                    className="rounded-md px-2 py-1.5 flex items-center gap-2"
                    style={{backgroundColor: p.card}}
                  >
                    <div
                      className="w-4 h-4 rounded-sm shrink-0"
                      style={{backgroundColor: p.elevated}}
                    />
                    <div className="flex-1 space-y-1 min-w-0">
                      <div
                        className="h-1.5 w-14 rounded-full"
                        style={{backgroundColor: p.text, opacity: 0.8}}
                      />
                      <div
                        className="h-1 w-9 rounded-full"
                        style={{backgroundColor: p.muted, opacity: 0.55}}
                      />
                    </div>
                  </div>

                  {/* Frosted bottom bar indicator */}
                  <div
                    className="h-2.5 -mx-2.5 -mb-2.5 px-3 flex items-center justify-around"
                    style={{
                      backgroundColor: p.navBg,
                      borderTop: `1px solid ${p.border}`,
                    }}
                  >
                    <span className="h-1 w-4 rounded-full" style={{backgroundColor: p.accent}} />
                    <span
                      className="h-1 w-4 rounded-full"
                      style={{backgroundColor: p.muted, opacity: 0.45}}
                    />
                    <span
                      className="h-1 w-4 rounded-full"
                      style={{backgroundColor: p.muted, opacity: 0.45}}
                    />
                  </div>
                </div>

                {/* Label & Active Check */}
                <div className="flex items-start justify-between gap-2 w-full">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-[var(--text-primary)] truncate">
                      {option.name}
                    </p>
                    <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-secondary)]">
                      {option.description}
                    </p>
                  </div>
                  <span
                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors ${
                      isSelected
                        ? 'bg-[var(--accent)] border-[var(--accent)] text-[var(--accent-contrast)]'
                        : 'border-[var(--border-strong)] bg-transparent'
                    }`}
                  >
                    {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* 0.5 PLAYBACK / AUTOPLAY PREFERENCES (ALL USERS) */}
      <section className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
              <Sparkles className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="font-display text-lg font-bold text-[var(--text-primary)]">
                Autoplay
              </h2>
              <p className="text-xs text-[var(--text-secondary)]">
                Automatically queue similar songs when your queue runs low (disabled while Repeat or Shuffle is on).
              </p>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoplayEnabled}
            aria-label="Toggle Autoplay"
            onClick={() => setAutoplayEnabled(!autoplayEnabled)}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
              autoplayEnabled
                ? 'bg-[var(--accent)]'
                : 'bg-[var(--bg-elevated)] border border-[var(--border-strong)]'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full transition-transform ${
                autoplayEnabled
                  ? 'translate-x-6 bg-[var(--accent-contrast)]'
                  : 'translate-x-1 bg-[var(--text-secondary)]'
              }`}
            />
          </button>
        </div>
      </section>

      {/* 0.6 LISTENING DATA PREFERENCES (ALL USERS) */}
      <section className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-6 space-y-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
            <Activity className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h2 className="font-display text-lg font-bold text-[var(--text-primary)]">
              Listening data
            </h2>
            <p className="text-xs text-[var(--text-secondary)]">
              Use your plays, completions, and early skips to gently personalize Autoplay, Radio, and Discover.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 pt-1 border-t border-[var(--border-subtle)]">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[var(--text-primary)]">
              Learn from my listening
            </p>
            <p className="text-xs text-[var(--text-secondary)]">
              When turned off, no listening signals are recorded or sent.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={learnFromListening}
            aria-label="Learn from my listening"
            onClick={handleToggleLearnFromListening}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
              learnFromListening
                ? 'bg-[var(--accent)]'
                : 'bg-[var(--bg-elevated)] border border-[var(--border-strong)]'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full transition-transform ${
                learnFromListening
                  ? 'translate-x-6 bg-[var(--accent-contrast)]'
                  : 'translate-x-1 bg-[var(--text-secondary)]'
              }`}
            />
          </button>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-4 border-t border-[var(--border-subtle)]">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[var(--text-primary)]">
              Clear listening data
            </p>
            <p className="text-xs text-[var(--text-secondary)]">
              Remove all saved listening signals for your account. Your library, playlists, and likes stay untouched.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {confirmClearListening ? (
              <>
                <button
                  type="button"
                  disabled={clearingListening || offline}
                  onClick={() => void handleClearListeningData()}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[var(--danger-bg)] border border-[var(--danger-border)] px-4 py-2 text-xs font-bold text-[var(--danger-text)] hover:opacity-90 disabled:opacity-50 transition-opacity"
                >
                  {clearingListening ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="w-3.5 h-3.5" />
                  )}
                  Confirm clear
                </button>
                <button
                  type="button"
                  disabled={clearingListening}
                  onClick={() => setConfirmClearListening(false)}
                  className="rounded-full bg-[var(--bg-elevated)] px-3.5 py-2 text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={offline}
                onClick={() => {
                  setListeningFeedback(null);
                  setConfirmClearListening(true);
                }}
                className="inline-flex items-center gap-2 rounded-full bg-[var(--bg-elevated)] border border-[var(--border-subtle)] px-4 py-2 text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5 text-[var(--danger-text)]" />
                Clear listening data
              </button>
            )}
          </div>
        </div>

        {listeningFeedback && (
          <p
            className={`text-xs font-medium ${
              listeningFeedback.ok ? 'text-[var(--accent)]' : 'text-[var(--danger-text)]'
            }`}
          >
            {listeningFeedback.text}
          </p>
        )}
      </section>

      {/* 0.7 THIS DEVICE NAME FOR MULTI-DEVICE REMOTE (ALL USERS) */}
      <section className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
            <MonitorSpeaker className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h2 className="font-display text-lg font-bold text-[var(--text-primary)]">
              This device
            </h2>
            <p className="text-xs text-[var(--text-secondary)]">
              Choose the name shown in the Devices sheet when controlling playback across your devices.
            </p>
          </div>
        </div>

        <form onSubmit={handleSaveDeviceName} className="flex flex-col sm:flex-row gap-2.5">
          <input
            type="text"
            maxLength={64}
            value={deviceNameInput}
            onChange={(e) => {
              setDeviceNameInput(e.target.value);
              setDeviceNameFeedback(null);
            }}
            placeholder={getDefaultDeviceName()}
            aria-label="Device name"
            className="flex-1 rounded-md bg-[var(--bg-input)] border border-[var(--border-subtle)] px-3.5 py-2.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
          />
          <button
            type="submit"
            className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--accent)] px-5 py-2.5 text-sm font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] transition-colors whitespace-nowrap shrink-0"
          >
            <Save className="w-4 h-4" />
            Save name
          </button>
        </form>

        {deviceNameFeedback && (
          <p className="text-xs font-medium text-[var(--accent)]">{deviceNameFeedback}</p>
        )}
      </section>

      {/* 1. NAS MUSIC MOUNT & LIBRARY SCANNER (ADMIN ONLY — TOP PRIORITY CARD) */}
      {isAdmin && (
        <section className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-6 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
                <HardDrive className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-display text-lg font-bold text-[var(--text-primary)]">
                  NAS Music Mount & Library Scanner
                </h2>
                <p className="text-xs text-[var(--text-secondary)]">
                  Active music mount for streaming, scanning, and yt-dlp downloads.
                </p>
              </div>
            </div>
            {sysStatus && (
              <div className="text-xs text-[var(--text-secondary)] font-mono tabular-nums">
                {sysStatus.trackCount} indexed tracks
              </div>
            )}
          </div>

          {/* Mount Path Input + Browse + Save */}
          <div className="space-y-3">
            <label
              htmlFor="nas-mount-input"
              className="block text-xs font-semibold text-[var(--text-secondary)]"
            >
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
                className="flex-1 rounded-md bg-[var(--bg-input)] border border-[var(--border-subtle)] px-3.5 py-2.5 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setDirBrowserOpen(true)}
                className="inline-flex items-center justify-center gap-2 rounded-md bg-[var(--bg-elevated)] px-4 py-2.5 text-sm font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors whitespace-nowrap shrink-0"
              >
                <FolderSearch className="w-4 h-4 text-[var(--accent)]" />
                Browse Folders
              </button>
              <button
                type="button"
                disabled={savingMount || !mountInput.trim()}
                onClick={() => void handleSaveMountPath()}
                className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--accent)] px-5 py-2.5 text-sm font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
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
              <div className="rounded-lg bg-[var(--bg-primary)] border border-[var(--border-subtle)] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  {mountHealth.status === 'ok' ? (
                    <CheckCircle2 className="w-5 h-5 text-[var(--accent)] shrink-0" />
                  ) : mountHealth.status === 'read-only' ? (
                    <AlertTriangle className="w-5 h-5 text-[var(--warn-text)] shrink-0" />
                  ) : (
                    <XCircle className="w-5 h-5 text-[var(--danger-text)] shrink-0" />
                  )}
                  <div>
                    <p
                      className={`text-sm font-semibold ${
                        mountHealth.status === 'ok'
                          ? 'text-[var(--accent)]'
                          : mountHealth.status === 'read-only'
                            ? 'text-[var(--warn-text)]'
                            : 'text-[var(--danger-text)]'
                      }`}
                    >
                      {mountHealth.status === 'ok'
                        ? 'Read & Write OK'
                        : mountHealth.status === 'read-only'
                          ? 'Read-Only Warning (Streaming OK, downloads disabled)'
                          : 'Path Not Found'}
                    </p>
                    <p className="font-mono text-xs text-[var(--text-muted)] truncate max-w-md">
                      {mountHealth.path}
                    </p>
                  </div>
                </div>

                {mountHealth.freeBytes !== null && mountHealth.totalBytes !== null && (
                  <div className="sm:w-56 space-y-1.5">
                    <div className="flex items-center justify-between text-xs font-mono tabular-nums">
                      <span className="text-[var(--text-primary)] font-medium">
                        {formatBytes(mountHealth.freeBytes)} free
                      </span>
                      <span className="text-[var(--text-muted)]">
                        of {formatBytes(mountHealth.totalBytes)}
                      </span>
                    </div>
                    {usedDiskPct !== null && (
                      <div className="h-1.5 w-full rounded-full bg-[var(--slider-track)] overflow-hidden">
                        <div
                          className="h-full bg-[var(--accent)]"
                          style={{width: `${usedDiskPct}%`}}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {mountMessage && (
              <p className="text-xs text-[var(--accent)] font-medium">{mountMessage}</p>
            )}
          </div>

          {/* Library Scanner Controls + Live SSE Progress */}
          <div className="border-t border-[var(--border-subtle)] pt-5 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={scanState.status === 'scanning'}
                onClick={() => void handleTriggerScan(false)}
                className="inline-flex items-center gap-2 rounded-full bg-[var(--accent)] px-5 py-2.5 text-sm font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
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
                className="inline-flex items-center gap-2 rounded-full bg-[var(--bg-elevated)] px-4 py-2.5 text-sm font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50 transition-colors"
              >
                Full Re-index
              </button>
            </div>

            {scanState.status !== 'idle' && (
              <div className="rounded-lg bg-[var(--bg-primary)] border border-[var(--border-subtle)] p-4 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-[var(--text-primary)]">
                    {scanState.status === 'scanning'
                      ? `Scanning... ${scanState.found} files found, ${scanState.imported} new imported, ${scanState.updated} updated`
                      : scanState.status === 'done'
                        ? `Scan complete — ${scanState.found} files found, ${scanState.imported} new tracks imported, ${scanState.removed} missing removed${scanState.playlistsImported ? `, ${scanState.playlistsImported} M3U playlist${scanState.playlistsImported === 1 ? '' : 's'} synced` : ''}`
                        : scanState.error || 'Scan error'}
                  </span>
                  <span className="font-mono tabular-nums text-[var(--accent)]">
                    {scanState.status === 'done' ? '100%' : `${scanPct}%`}
                  </span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-[var(--slider-track)] overflow-hidden">
                  <div
                    className={`h-full transition-[width] duration-200 ${
                      scanState.status === 'error' ? 'bg-red-500' : 'bg-[var(--accent)]'
                    }`}
                    style={{
                      width: `${scanState.status === 'done' ? 100 : Math.max(scanPct, scanState.status === 'scanning' ? 6 : 0)}%`,
                    }}
                  />
                </div>
                {scanState.currentFile && scanState.status === 'scanning' && (
                  <p className="font-mono text-[11px] text-[var(--text-muted)] truncate">
                    Reading: {scanState.currentFile}
                  </p>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {/* 2. ACCOUNT & PWA INSTALL STATUS (ALL USERS) */}
      <section className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-6 space-y-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--bg-elevated)] text-[var(--text-primary)]">
            <KeyRound className="w-5 h-5" />
          </div>
          <div>
            <h2 className="font-display text-lg font-bold text-[var(--text-primary)]">
              Account & PWA App Status
            </h2>
            <p className="text-xs text-[var(--text-secondary)]">
              Signed in as <strong className="text-[var(--text-primary)]">{user?.username}</strong> ({user?.role})
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Change Password */}
          <form onSubmit={handleChangePassword} className="space-y-3.5">
            <h3 className="text-sm font-bold text-[var(--text-primary)]">Change Password</h3>
            <div>
              <label className="block text-xs text-[var(--text-secondary)] mb-1">
                Current Password
              </label>
              <input
                type="password"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="w-full rounded-md bg-[var(--bg-input)] border border-[var(--border-subtle)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--text-secondary)] mb-1">
                New Password
              </label>
              <input
                type="password"
                required
                minLength={6}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Minimum 6 characters"
                className="w-full rounded-md bg-[var(--bg-input)] border border-[var(--border-subtle)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
              />
            </div>
            {pwFeedback && (
              <p
                className={`text-xs ${
                  pwFeedback.ok ? 'text-[var(--accent)]' : 'text-[var(--danger-text)]'
                }`}
              >
                {pwFeedback.text}
              </p>
            )}
            <button
              type="submit"
              disabled={pwSaving}
              className="rounded-full bg-[var(--btn-contrast-bg)] px-5 py-2 text-xs font-bold text-[var(--btn-contrast-text)] hover:opacity-90 disabled:opacity-50"
            >
              {pwSaving ? 'Updating...' : 'Update Password'}
            </button>
          </form>

          {/* PWA Install Status Indicator */}
          <div className="rounded-lg bg-[var(--bg-primary)] border border-[var(--border-subtle)] p-5 flex flex-col justify-between space-y-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Smartphone className="w-4 h-4 text-[var(--accent)]" />
                <h3 className="text-sm font-bold text-[var(--text-primary)]">
                  xlabplayer Progressive Web App
                </h3>
              </div>
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                Install xlabplayer to your phone or desktop home screen for standalone full-screen
                playback, lock-screen MediaSession controls, and CarPlay / Bluetooth integration.
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[var(--border-subtle)]">
              <div className="flex items-center gap-2 text-xs font-semibold">
                {isInstalled ? (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-[var(--accent)]" />
                    <span className="text-[var(--accent)]">Installed (Standalone Mode)</span>
                  </>
                ) : isInstallable ? (
                  <>
                    <Download className="w-4 h-4 text-[var(--accent)]" />
                    <span className="text-[var(--text-primary)]">Ready to Install</span>
                  </>
                ) : (
                  <>
                    <Smartphone className="w-4 h-4 text-[var(--text-secondary)]" />
                    <span className="text-[var(--text-secondary)]">
                      {isIOS ? 'iOS Safari — Use Share Menu' : 'Browser Mode'}
                    </span>
                  </>
                )}
              </div>

              {!isInstalled && isInstallable && (
                <button
                  type="button"
                  onClick={() => void install()}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)] px-4 py-1.5 text-xs font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
                >
                  <Download className="w-3.5 h-3.5" />
                  Install App
                </button>
              )}

              {!isInstalled && isIOS && (
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(true)}
                  className="rounded-full bg-[var(--bg-elevated)] px-4 py-1.5 text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                >
                  iOS Install Guide
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* 2B. OFFLINE STORAGE (ALL USERS) */}
      <section className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
              <HardDriveDownload className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-display text-lg font-bold text-[var(--text-primary)]">
                Offline Storage
              </h2>
              <p className="text-xs text-[var(--text-secondary)]">
                Audio files and cover art cached locally on this device for Airplane Mode playback.
              </p>
            </div>
          </div>

          <div className="text-left sm:text-right">
            <p className="font-mono text-2xl font-extrabold tabular-nums text-[var(--text-primary)]">
              {offlineUsage ? `${offlineUsage.totalMB.toFixed(1)} MB` : '0.0 MB'}
            </p>
            <p className="text-xs text-[var(--text-muted)] font-mono tabular-nums">
              {offlineUsage ? formatBytes(offlineUsage.totalBytes) : '0 B'} cached
            </p>
          </div>
        </div>

        {!offlineSupported ? (
          <div className="rounded-lg bg-[var(--warn-bg)] border border-[var(--warn-border)] p-4 text-xs text-[var(--warn-text)]">
            Offline music caching requires a secure HTTPS context (or localhost) so the browser Cache Storage API and IndexedDB are available.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="rounded-lg bg-[var(--bg-primary)] border border-[var(--border-subtle)] p-3.5">
                <p className="text-[11px] text-[var(--text-secondary)]">Cached Tracks</p>
                <p className="mt-1 font-mono text-lg font-bold tabular-nums text-[var(--text-primary)]">
                  {offlineUsage?.trackCount ?? 0}
                </p>
              </div>
              <div className="rounded-lg bg-[var(--bg-primary)] border border-[var(--border-subtle)] p-3.5">
                <p className="text-[11px] text-[var(--text-secondary)]">Cached Playlists</p>
                <p className="mt-1 font-mono text-lg font-bold tabular-nums text-[var(--text-primary)]">
                  {offlineUsage?.playlistCount ?? 0}
                </p>
              </div>
              <div className="rounded-lg bg-[var(--bg-primary)] border border-[var(--border-subtle)] p-3.5">
                <p className="text-[11px] text-[var(--text-secondary)]">Audio Cache</p>
                <p className="mt-1 font-mono text-lg font-bold tabular-nums text-[var(--text-primary)]">
                  {offlineUsage ? formatBytes(offlineUsage.audioBytes) : '0 B'}
                </p>
              </div>
              <div className="rounded-lg bg-[var(--bg-primary)] border border-[var(--border-subtle)] p-3.5">
                <p className="text-[11px] text-[var(--text-secondary)]">Artwork & Meta</p>
                <p className="mt-1 font-mono text-lg font-bold tabular-nums text-[var(--text-primary)]">
                  {offlineUsage ? formatBytes(offlineUsage.coverBytes) : '0 B'}
                </p>
              </div>
            </div>

            {offlineUsage?.quotaBytes && offlineUsage.quotaBytes > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs font-mono tabular-nums">
                  <span className="text-[var(--text-secondary)]">
                    Offline audio uses{' '}
                    <span className="text-[var(--text-primary)] font-semibold">
                      {offlineUsage.totalMB.toFixed(1)} MB
                    </span>
                  </span>
                  <span className="text-[var(--text-muted)]">
                    Browser quota: {formatBytes(offlineUsage.quotaBytes)}
                  </span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-[var(--slider-track)] overflow-hidden">
                  <div
                    className="h-full bg-[var(--accent)] transition-[width] duration-300"
                    style={{
                      width: `${Math.min(
                        100,
                        Math.max(
                          offlineUsage.totalBytes > 0 ? 1 : 0,
                          Math.round((offlineUsage.totalBytes / offlineUsage.quotaBytes) * 100)
                        )
                      )}%`,
                    }}
                  />
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[var(--border-subtle)]">
              <div className="text-xs text-[var(--text-secondary)]">
                {offlineFeedback ? (
                  <span className="text-[var(--accent)] font-medium">{offlineFeedback}</span>
                ) : (
                  <span>
                    Stored in Cache Storage (
                    <code className="font-mono text-[var(--text-primary)]">xlabplayer-audio-v1</code>
                    ) and IndexedDB.
                  </span>
                )}
              </div>

              {confirmClearOffline ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={clearingOffline}
                    onClick={() => void handleClearAllOffline()}
                    className="inline-flex items-center gap-1.5 rounded-full bg-red-600 px-4 py-2 text-xs font-bold text-white hover:bg-red-500 disabled:opacity-50 transition-colors"
                  >
                    {clearingOffline ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="w-3.5 h-3.5" />
                    )}
                    Confirm Clear All
                  </button>
                  <button
                    type="button"
                    disabled={clearingOffline}
                    onClick={() => setConfirmClearOffline(false)}
                    className="rounded-full bg-[var(--bg-elevated)] px-3.5 py-2 text-xs font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={clearingOffline || !offlineUsage || offlineUsage.trackCount === 0}
                  onClick={() => setConfirmClearOffline(true)}
                  className="inline-flex items-center gap-2 rounded-full bg-[var(--danger-bg)] border border-[var(--danger-border)] px-4 py-2 text-xs font-semibold text-[var(--danger-text)] hover:opacity-90 disabled:opacity-40 transition-colors whitespace-nowrap"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Clear All Offline Music
                </button>
              )}
            </div>
          </>
        )}
      </section>

      {/* 3. USER MANAGEMENT (ADMIN ONLY) */}
      {isAdmin && (
        <section className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-6 space-y-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--bg-elevated)] text-[var(--text-primary)]">
              <Users className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-display text-lg font-bold text-[var(--text-primary)]">
                User Management
              </h2>
              <p className="text-xs text-[var(--text-secondary)]">
                Manage admin and listener accounts, download permissions, and password resets.
              </p>
            </div>
          </div>

          {/* Users Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--border-subtle)] text-xs text-[var(--text-secondary)]">
                  <th className="py-2.5 pr-4 font-medium">Username</th>
                  <th className="py-2.5 pr-4 font-medium">Role</th>
                  <th className="py-2.5 pr-4 font-medium">Downloader Access</th>
                  <th className="py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-[var(--surface-overlay)]">
                    <td className="py-3 pr-4 font-medium text-[var(--text-primary)]">
                      {u.username}
                      {u.id === user?.id && (
                        <span className="ml-2 text-xs text-[var(--text-muted)]">(you)</span>
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      <span
                        className={`inline-flex items-center gap-1 text-xs font-semibold ${
                          u.role === 'admin' ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'
                        }`}
                      >
                        {u.role === 'admin' && <Shield className="w-3.5 h-3.5" />}
                        <span className="capitalize">{u.role}</span>
                      </span>
                    </td>
                    <td className="py-3 pr-4">
                      {u.role === 'admin' ? (
                        <span className="text-xs text-[var(--text-secondary)]">Full access</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void handleToggleUserDownload(u)}
                          className={`text-xs font-semibold underline-offset-2 hover:underline ${
                            u.can_download ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'
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
                              className="w-32 rounded bg-[var(--bg-input)] border border-[var(--border-strong)] px-2 py-1 text-xs text-[var(--text-primary)]"
                            />
                            <button
                              type="button"
                              onClick={() => void handleResetUserPassword(u.id)}
                              className="rounded bg-[var(--accent)] px-2.5 py-1 text-xs font-bold text-[var(--accent-contrast)]"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setResetUserId(null);
                                setResetPasswordVal('');
                              }}
                              className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
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
                            className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] px-2 py-1 rounded hover:bg-[var(--bg-elevated)]"
                          >
                            Reset Password
                          </button>
                        )}
                        {u.id !== user?.id && (
                          <button
                            type="button"
                            onClick={() => void handleDeleteUser(u.id)}
                            className="p-1.5 rounded text-[var(--text-secondary)] hover:text-[var(--danger-text)] hover:bg-[var(--bg-elevated)]"
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

          {userFeedback && <p className="text-xs text-[var(--accent)]">{userFeedback}</p>}

          {/* Create User Form */}
          <form
            onSubmit={handleCreateUser}
            className="border-t border-[var(--border-subtle)] pt-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end"
          >
            <div>
              <label className="block text-xs text-[var(--text-secondary)] mb-1">Username</label>
              <input
                type="text"
                required
                minLength={3}
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                placeholder="listener1"
                className="w-full rounded-md bg-[var(--bg-input)] border border-[var(--border-subtle)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--text-secondary)] mb-1">Password</label>
              <input
                type="password"
                required
                minLength={6}
                value={newUserPassword}
                onChange={(e) => setNewUserPassword(e.target.value)}
                placeholder="Min 6 chars"
                className="w-full rounded-md bg-[var(--bg-input)] border border-[var(--border-subtle)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--text-secondary)] mb-1">Role</label>
              <select
                value={newUserRole}
                onChange={(e) =>
                  setNewUserRole(e.target.value === 'admin' ? 'admin' : 'listener')
                }
                className="w-full rounded-md bg-[var(--bg-input)] border border-[var(--border-subtle)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
              >
                <option value="listener">Listener</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <label className="flex items-center gap-2 py-2 text-xs text-[var(--text-secondary)] cursor-pointer">
              <input
                type="checkbox"
                checked={newUserRole === 'admin' ? true : newUserCanDownload}
                disabled={newUserRole === 'admin'}
                onChange={(e) => setNewUserCanDownload(e.target.checked)}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              <span>Allow Downloads</span>
            </label>
            <button
              type="submit"
              className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] whitespace-nowrap"
            >
              <UserPlus className="w-4 h-4" />
              Create User
            </button>
          </form>
        </section>
      )}

      {/* 4. YT-DLP & COOKIES RESILIENCE ENGINE (ADMIN ONLY) */}
      {isAdmin && settings && (
        <section className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-6 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
                <Terminal className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-display text-lg font-bold text-[var(--text-primary)]">
                  yt-dlp & Cookies Resilience Engine
                </h2>
                <p className="text-xs text-[var(--text-secondary)]">
                  Manage Netscape cookies, YouTube extractor fallbacks, FFmpeg 1:1 cover cropping, and engine updates.
                </p>
              </div>
            </div>

            <button
              type="button"
              disabled={updatingYtdlp}
              onClick={() => void handleUpdateYtdlp()}
              className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--bg-elevated)] px-4 py-2 text-xs font-bold text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${updatingYtdlp ? 'animate-spin' : ''}`} />
              Update yt-dlp Engine
            </button>
          </div>

          {/* Installed Binaries Banner */}
          {sysStatus && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-lg bg-[var(--bg-primary)] border border-[var(--border-subtle)] p-4 flex items-center justify-between">
                <div>
                  <p className="text-xs text-[var(--text-secondary)]">yt-dlp Binary</p>
                  <p className="font-mono text-sm font-semibold text-[var(--text-primary)] mt-0.5">
                    {sysStatus.ytdlp.installed
                      ? `v${sysStatus.ytdlp.version}`
                      : 'Not installed on host'}
                  </p>
                </div>
                {sysStatus.ytdlp.installed ? (
                  <CheckCircle2 className="w-5 h-5 text-[var(--accent)]" />
                ) : (
                  <AlertTriangle className="w-5 h-5 text-[var(--warn-text)]" />
                )}
              </div>

              <div className="rounded-lg bg-[var(--bg-primary)] border border-[var(--border-subtle)] p-4 flex items-center justify-between">
                <div>
                  <p className="text-xs text-[var(--text-secondary)]">FFmpeg Binary</p>
                  <p className="font-mono text-sm font-semibold text-[var(--text-primary)] mt-0.5">
                    {sysStatus.ffmpeg.installed
                      ? sysStatus.ffmpeg.version
                      : 'Not installed on host'}
                  </p>
                </div>
                {sysStatus.ffmpeg.installed ? (
                  <CheckCircle2 className="w-5 h-5 text-[var(--accent)]" />
                ) : (
                  <AlertTriangle className="w-5 h-5 text-[var(--warn-text)]" />
                )}
              </div>
            </div>
          )}

          {ytdlpUpdateLog && (
            <pre className="rounded-lg bg-[var(--bg-primary)] border border-[var(--border-subtle)] p-3 font-mono text-xs text-[var(--text-secondary)] whitespace-pre-wrap overflow-x-auto">
              {ytdlpUpdateLog}
            </pre>
          )}

          {/* Cookies Management */}
          <div className="border-t border-[var(--border-subtle)] pt-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Cookie className="w-4 h-4 text-[var(--accent)]" />
                <h3 className="text-sm font-bold text-[var(--text-primary)]">
                  Netscape cookies.txt
                </h3>
                {sysStatus && (
                  <span
                    className={`text-xs font-semibold ml-2 ${
                      sysStatus.cookies.status === 'active'
                        ? 'text-[var(--accent)]'
                        : sysStatus.cookies.status === 'expired'
                          ? 'text-[var(--danger-text)]'
                          : 'text-[var(--text-secondary)]'
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
                <label className="inline-flex items-center gap-1.5 rounded-md bg-[var(--bg-elevated)] px-3 py-1.5 text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer">
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
                  className="rounded-md bg-[var(--bg-elevated)] px-3 py-1.5 text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
                >
                  Test Cookies
                </button>
                {sysStatus?.cookies.exists && (
                  <button
                    type="button"
                    disabled={cookiesBusy}
                    onClick={() => void handleDeleteCookies()}
                    className="rounded-md bg-[var(--bg-elevated)] px-3 py-1.5 text-xs font-semibold text-[var(--danger-text)] hover:bg-[var(--bg-hover)]"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>

            <p className="text-xs text-[var(--text-muted)]">
              Saved to{' '}
              <code className="font-mono text-[var(--text-secondary)]">./data/secrets/cookies.txt</code>{' '}
              with <code className="font-mono text-[var(--text-secondary)]">0600</code> permissions. Each download
              uses an isolated temp copy so yt-dlp never corrupts your master file.
            </p>

            <div className="space-y-2">
              <textarea
                rows={4}
                value={cookiesText}
                onChange={(e) => setCookiesText(e.target.value)}
                placeholder="# Netscape HTTP Cookie File&#10;.youtube.com	TRUE	/	TRUE	..."
                className="w-full rounded-md bg-[var(--bg-input)] border border-[var(--border-subtle)] p-3 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
              />
              <div className="flex items-center justify-between gap-3">
                <div>
                  {cookiesFeedback && (
                    <p
                      className={`text-xs ${
                        cookiesFeedback.ok ? 'text-[var(--accent)]' : 'text-[var(--danger-text)]'
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
                  className="rounded-full bg-[var(--btn-contrast-bg)] px-4 py-1.5 text-xs font-bold text-[var(--btn-contrast-text)] hover:opacity-90 disabled:opacity-40"
                >
                  Save Pasted Cookies
                </button>
              </div>
            </div>
          </div>

          {/* Resilience Controls Form */}
          <form
            onSubmit={handleSaveResilience}
            className="border-t border-[var(--border-subtle)] pt-5 space-y-5"
          >
            <h3 className="text-sm font-bold text-[var(--text-primary)]">
              Extractor & Post-Processing Controls
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-[var(--text-secondary)] mb-1">
                  player_client Fallback Order
                </label>
                <input
                  type="text"
                  value={settings.ytdlp_player_client}
                  onChange={(e) =>
                    setSettings({...settings, ytdlp_player_client: e.target.value})
                  }
                  placeholder="web,mweb,android_vr"
                  className="w-full rounded-md bg-[var(--bg-input)] border border-[var(--border-subtle)] px-3 py-2 font-mono text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[var(--text-secondary)] mb-1">
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
                    className="w-full rounded-md bg-[var(--bg-input)] border border-[var(--border-subtle)] px-3 py-2 font-mono text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[var(--text-secondary)] mb-1">
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
                    className="w-full rounded-md bg-[var(--bg-input)] border border-[var(--border-subtle)] px-3 py-2 font-mono text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs text-[var(--text-secondary)] mb-1">
                  yt-dlp Binary Path
                </label>
                <input
                  type="text"
                  value={settings.ytdlp_path}
                  onChange={(e) => setSettings({...settings, ytdlp_path: e.target.value})}
                  placeholder="yt-dlp"
                  className="w-full rounded-md bg-[var(--bg-input)] border border-[var(--border-subtle)] px-3 py-2 font-mono text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs text-[var(--text-secondary)] mb-1">
                  FFmpeg Binary Path
                </label>
                <input
                  type="text"
                  value={settings.ffmpeg_path}
                  onChange={(e) => setSettings({...settings, ffmpeg_path: e.target.value})}
                  placeholder="ffmpeg"
                  className="w-full rounded-md bg-[var(--bg-input)] border border-[var(--border-subtle)] px-3 py-2 font-mono text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs text-[var(--text-secondary)] mb-1">
                Custom Extra CLI Flags
              </label>
              <input
                type="text"
                value={settings.ytdlp_extra_flags}
                onChange={(e) => setSettings({...settings, ytdlp_extra_flags: e.target.value})}
                placeholder="--geo-bypass --concurrent-fragments 4"
                className="w-full rounded-md bg-[var(--bg-input)] border border-[var(--border-subtle)] px-3 py-2 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
              />
            </div>

            {/* Boolean Resilience Toggles */}
            <div className="space-y-3 rounded-lg bg-[var(--bg-primary)] border border-[var(--border-subtle)] p-4">
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
                  className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
                />
                <div>
                  <span className="text-sm font-medium text-[var(--text-primary)]">
                    Enable <code className="font-mono text-[var(--accent)]">--remote-components ejs:github</code>
                  </span>
                  <p className="text-xs text-[var(--text-muted)]">
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
                  className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
                />
                <div>
                  <span className="text-sm font-medium text-[var(--text-primary)]">
                    Force IPv4 (<code className="font-mono text-[var(--accent)]">--force-ipv4</code>)
                  </span>
                  <p className="text-xs text-[var(--text-muted)]">
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
                  className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
                />
                <div>
                  <span className="text-sm font-medium text-[var(--text-primary)]">
                    FFmpeg 1:1 Square Album Art Crop Filter
                  </span>
                  <p className="text-xs text-[var(--text-muted)]">
                    Applies <code className="font-mono">-vf &quot;crop=&apos;min(iw,ih)&apos;:&apos;min(iw,ih)&apos;&quot;</code> so 16:9 YouTube thumbnails embed as crisp square covers.
                  </p>
                </div>
              </label>

              <div className="pt-2 border-t border-[var(--border-subtle)]">
                <label className="block text-sm font-medium text-[var(--text-primary)] mb-1">
                  Default Download Quality Profile
                </label>
                <select
                  value={settings.ytdlp_download_quality || 'ultra'}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      ytdlp_download_quality: e.target.value,
                    })
                  }
                  className="w-full sm:w-72 rounded bg-[var(--bg-input)] border border-[var(--border-subtle)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                >
                  <option value="ultra">Ultra — Best Native Audio (Opus / AAC)</option>
                  <option value="high">High — 320 kbps MP3</option>
                  <option value="standard">Standard — 128 kbps MP3</option>
                </select>
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  Ultra preserves the native audio stream with zero transcoding loss; High and Standard transcode to MP3.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                {resilienceFeedback && (
                  <p className="text-xs font-medium text-[var(--accent)]">{resilienceFeedback}</p>
                )}
              </div>
              <button
                type="submit"
                disabled={savingResilience}
                className="inline-flex items-center gap-2 rounded-full bg-[var(--accent)] px-6 py-2.5 text-sm font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
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

      {/* Account Session & Sign Out */}
      <section className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="font-display text-base font-bold text-[var(--text-primary)]">Account</h2>
            <p className="mt-0.5 text-xs text-[var(--text-secondary)] truncate">
              Signed in as{' '}
              <span className="font-semibold text-[var(--text-primary)]">{user?.username}</span>{' '}
              <span className="capitalize text-[var(--text-muted)]">({user?.role})</span>
            </p>
          </div>
          <button
            type="button"
            onClick={() => void logout()}
            className="inline-flex w-full sm:w-auto items-center justify-center gap-2 rounded-full border border-[var(--danger-border)] bg-[var(--danger-bg)] px-6 py-2.5 text-sm font-semibold text-[var(--danger-text)] hover:opacity-90 transition-opacity"
          >
            <LogOut className="w-4 h-4" />
            <span>Sign Out</span>
          </button>
        </div>
      </section>

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
          <div className="w-full max-w-sm rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-lg font-bold text-[var(--text-primary)]">
                Install xlabplayer on iOS
              </h3>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <ol className="list-decimal list-inside space-y-2 text-sm text-[var(--text-secondary)]">
              <li>
                Tap the <strong className="text-[var(--text-primary)]">Share</strong> button in Safari&apos;s toolbar.
              </li>
              <li>
                Scroll down and tap{' '}
                <strong className="text-[var(--text-primary)]">Add to Home Screen</strong>.
              </li>
              <li>
                Tap <strong className="text-[var(--text-primary)]">Add</strong> to launch xlabplayer as a standalone app.
              </li>
            </ol>
            <button
              type="button"
              onClick={() => setShowIOSGuide(false)}
              className="w-full rounded-full bg-[var(--accent)] py-2.5 text-sm font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
            >
              Got It
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
