import {AlertCircle, ArrowRight, Loader2, Lock, ShieldCheck, User} from 'lucide-react';
import React, {useState} from 'react';
import {BrandLogo} from '../components/BrandLogo';
import {useAuth} from '../context/AuthContext';

export const AuthPage: React.FC = () => {
  const {hasUsers, login, setupAdmin} = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isSetup = !hasUsers;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (isSetup && password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setSubmitting(true);
    try {
      if (isSetup) {
        await setupAdmin(username.trim(), password);
      } else {
        await login(username.trim(), password);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen w-full bg-[var(--bg-primary)] flex flex-col items-center justify-center p-4 pt-safe pb-safe relative overflow-hidden">
      {/* Subtle accent radial glow at top */}
      <div
        className="pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 w-[720px] h-[340px] opacity-20 blur-3xl"
        style={{
          background: 'radial-gradient(ellipse at center, var(--accent) 0%, transparent 70%)',
        }}
        aria-hidden="true"
      />

      <div className="relative z-10 w-full max-w-md rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-8 shadow-2xl">
        <div className="flex flex-col items-center text-center mb-8">
          <BrandLogo size="lg" />
          <h1 className="font-display mt-5 text-2xl font-bold tracking-tight text-[var(--text-primary)]">
            {isSetup ? 'Create Admin Account' : 'Sign in to xlabplayer'}
          </h1>
          <p className="mt-2 text-sm text-[var(--text-secondary)] max-w-xs">
            {isSetup
              ? 'First-run setup. Create the primary administrator account to configure your NAS mount and music library.'
              : 'Stream and manage your self-hosted NAS music collection.'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="auth-username" className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5">
              Username
            </label>
            <div className="relative">
              <User className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
              <input
                id="auth-username"
                type="text"
                required
                autoFocus
                autoComplete="username"
                minLength={3}
                maxLength={32}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={isSetup ? 'admin' : 'Enter your username'}
                className="w-full rounded-md bg-[var(--bg-input)] pl-10 pr-3.5 py-2.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] border border-[var(--border-subtle)] focus:border-[var(--accent)] focus:outline-none transition-colors"
              />
            </div>
          </div>

          <div>
            <label htmlFor="auth-password" className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5">
              Password
            </label>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
              <input
                id="auth-password"
                type="password"
                required
                autoComplete={isSetup ? 'new-password' : 'current-password'}
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={isSetup ? 'Minimum 6 characters' : 'Enter your password'}
                className="w-full rounded-md bg-[var(--bg-input)] pl-10 pr-3.5 py-2.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] border border-[var(--border-subtle)] focus:border-[var(--accent)] focus:outline-none transition-colors"
              />
            </div>
          </div>

          {isSetup && (
            <div>
              <label htmlFor="auth-confirm" className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5">
                Confirm Password
              </label>
              <div className="relative">
                <ShieldCheck className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
                <input
                  id="auth-confirm"
                  type="password"
                  required
                  autoComplete="new-password"
                  minLength={6}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter password"
                  className="w-full rounded-md bg-[var(--bg-input)] pl-10 pr-3.5 py-2.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] border border-[var(--border-subtle)] focus:border-[var(--accent)] focus:outline-none transition-colors"
                />
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2.5 rounded-md bg-[var(--danger-bg)] border border-[var(--danger-border)] px-3.5 py-2.5 text-sm text-[var(--danger-text)]">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-full bg-[var(--accent)] py-3 text-sm font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] active:scale-[0.99] disabled:opacity-60 transition-all"
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>{isSetup ? 'Creating Account...' : 'Signing In...'}</span>
              </>
            ) : (
              <>
                <span>{isSetup ? 'Create Admin & Continue' : 'Log In'}</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
};
