const DEVICE_ID_STORAGE_KEY = 'xlabplayer_device_id_v1';
const DEVICE_NAME_STORAGE_KEY = 'xlabplayer_device_name_v1';

const nameListeners = new Set<() => void>();

function generateUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function detectDevicePlatform(): 'mobile' | 'tablet' | 'desktop' {
  if (typeof navigator === 'undefined') return 'desktop';
  const ua = navigator.userAgent || '';
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) {
    return 'tablet';
  }
  if (/iPhone|iPod|Android.*Mobile|Windows Phone|Mobile/i.test(ua)) {
    return 'mobile';
  }
  if (/Android/i.test(ua)) return 'tablet';
  return 'desktop';
}

export function getDefaultDeviceName(): string {
  if (typeof navigator === 'undefined') return 'Web Browser';
  const ua = navigator.userAgent || '';

  let os = 'Web';
  if (/iPhone/i.test(ua)) os = 'iPhone';
  else if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) os = 'iPad';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/CrOS/i.test(ua)) os = 'ChromeOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  let browser = 'Browser';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
  else if (/CriOS|Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/FxiOS|Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua)) browser = 'Safari';

  return `${os} · ${browser}`;
}

export function getOrCreateDeviceId(): string {
  try {
    if (typeof localStorage !== 'undefined') {
      const existing = localStorage.getItem(DEVICE_ID_STORAGE_KEY)?.trim();
      if (existing && /^[A-Za-z0-9._-]{8,64}$/.test(existing)) {
        return existing;
      }
      const created = generateUuid();
      localStorage.setItem(DEVICE_ID_STORAGE_KEY, created);
      return created;
    }
  } catch {
    // ignore storage quota / private browsing restrictions
  }
  return generateUuid();
}

export function getDeviceName(): string {
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem(DEVICE_NAME_STORAGE_KEY)?.trim();
      if (saved) return saved.slice(0, 64);
    }
  } catch {
    // ignore
  }
  return getDefaultDeviceName();
}

export function setDeviceName(name: string): string {
  const cleaned = name.trim().replace(/\s+/g, ' ').slice(0, 64);
  const next = cleaned || getDefaultDeviceName();
  try {
    if (typeof localStorage !== 'undefined') {
      if (cleaned) {
        localStorage.setItem(DEVICE_NAME_STORAGE_KEY, cleaned);
      } else {
        localStorage.removeItem(DEVICE_NAME_STORAGE_KEY);
      }
    }
  } catch {
    // ignore
  }
  for (const listener of nameListeners) {
    listener();
  }
  return next;
}

export function subscribeDeviceName(listener: () => void): () => void {
  nameListeners.add(listener);
  return () => {
    nameListeners.delete(listener);
  };
}
