import {Router} from 'express';
import {type AuthRequest, requireAuth} from '../auth.ts';
import {
  deviceHub,
  isValidDeviceId,
  sanitizeCommandRequest,
  sanitizeDeviceName,
  sanitizeDevicePlatform,
  sanitizeDeviceStatePayload,
} from '../deviceHub.ts';

export const deviceRouter = Router();

// Per-user sliding-window rate limiter buckets for device endpoints
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, number[]>();

function checkRateLimit(
  bucketKey: string,
  maxPerMin: number
): {allowed: boolean; retryAfterSec: number} {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const prev = rateBuckets.get(bucketKey) || [];
  const active = prev.filter((ts) => ts > cutoff);
  if (active.length >= maxPerMin) {
    const oldest = active[0] ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - now) / 1000));
    rateBuckets.set(bucketKey, active);
    return {allowed: false, retryAfterSec};
  }
  active.push(now);
  rateBuckets.set(bucketKey, active);
  if (rateBuckets.size > 2000) {
    for (const [key, timestamps] of rateBuckets.entries()) {
      if (timestamps.length === 0 || timestamps[timestamps.length - 1] <= cutoff) {
        rateBuckets.delete(key);
      }
    }
  }
  return {allowed: true, retryAfterSec: 0};
}

// 1. SSE stream: GET /api/devices/events?deviceId=&name=&platform=
deviceRouter.get('/devices/events', requireAuth, (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const rate = checkRateLimit(`dev-sse:${userId}`, 30);
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSec));
    res.status(429).json({error: 'Too many device stream connections'});
    return;
  }

  const rawDeviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId.trim() : '';
  if (!isValidDeviceId(rawDeviceId)) {
    res.status(400).json({error: 'Valid deviceId query parameter is required'});
    return;
  }

  const name = sanitizeDeviceName(req.query.name);
  const platform = sanitizeDevicePlatform(req.query.platform);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const cleanup = deviceHub.connectSse({
    userId,
    deviceId: rawDeviceId,
    name,
    platform,
    res,
  });

  req.on('close', cleanup);
});

// 2. List caller's devices: GET /api/devices
deviceRouter.get('/devices', requireAuth, (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const rate = checkRateLimit(`dev-list:${userId}`, 120);
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSec));
    res.status(429).json({error: 'Too many device list requests'});
    return;
  }

  const devices = deviceHub.listDevices(userId);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({devices, serverNowMs: Date.now()});
});

// 3. Publish device playback state: PUT /api/devices/:id/state
deviceRouter.put('/devices/:id/state', requireAuth, (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const rate = checkRateLimit(`dev-state:${userId}`, 240);
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSec));
    res.status(429).json({error: 'Too many device state updates'});
    return;
  }

  const deviceId = String(req.params.id || '').trim();
  if (!isValidDeviceId(deviceId)) {
    res.status(400).json({error: 'Invalid device id'});
    return;
  }

  const parsed = sanitizeDeviceStatePayload(req.body);
  if (!parsed.ok) {
    res.status(400).json({error: parsed.error});
    return;
  }

  const name =
    typeof req.body?.name === 'string' && req.body.name.trim()
      ? sanitizeDeviceName(req.body.name)
      : undefined;
  const platform =
    typeof req.body?.platform === 'string' && req.body.platform.trim()
      ? sanitizeDevicePlatform(req.body.platform)
      : undefined;

  const stamped = deviceHub.publishState({
    userId,
    deviceId,
    state: parsed.value,
    name,
    platform,
  });

  res.setHeader('Cache-Control', 'no-store');
  res.json({ok: true, rev: stamped.rev, serverNowMs: stamped.serverNowMs});
});

// 4. Send command to another device of the same user: POST /api/devices/:id/command
deviceRouter.post('/devices/:id/command', requireAuth, async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const rate = checkRateLimit(`dev-cmd:${userId}`, 180);
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSec));
    res.status(429).json({error: 'Too many remote commands'});
    return;
  }

  const targetDeviceId = String(req.params.id || '').trim();
  if (!isValidDeviceId(targetDeviceId)) {
    res.status(400).json({error: 'Invalid target device id'});
    return;
  }

  const parsed = sanitizeCommandRequest(req.body);
  if (!parsed.ok) {
    res.status(400).json({error: parsed.error});
    return;
  }

  const commandTimeoutMs =
    parsed.cmd === 'transfer' || parsed.cmd === 'playTrack' ? 12_000 : undefined;

  const ack = await deviceHub.sendCommand({
    userId,
    targetDeviceId,
    fromDeviceId: parsed.fromDeviceId,
    cmd: parsed.cmd,
    args: parsed.args,
    commandId: parsed.commandId,
    timeoutMs: commandTimeoutMs,
  });

  res.setHeader('Cache-Control', 'no-store');
  res.json(ack);
});

// 5. Ack a received command: POST /api/devices/:id/ack
deviceRouter.post('/devices/:id/ack', requireAuth, (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const rate = checkRateLimit(`dev-ack:${userId}`, 240);
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSec));
    res.status(429).json({error: 'Too many command acknowledgements'});
    return;
  }

  const deviceId = String(req.params.id || '').trim();
  if (!isValidDeviceId(deviceId)) {
    res.status(400).json({error: 'Invalid device id'});
    return;
  }

  const body =
    req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : null;
  if (!body) {
    res.status(400).json({error: 'Ack payload must be a JSON object'});
    return;
  }

  const commandId = typeof body.commandId === 'string' ? body.commandId.trim() : '';
  if (!commandId || commandId.length > 80) {
    res.status(400).json({error: 'Valid commandId is required'});
    return;
  }

  const status = body.status === 'applied' || body.status === 'rejected' ? body.status : null;
  if (!status) {
    res.status(400).json({error: "status must be 'applied' or 'rejected'"});
    return;
  }

  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 120) : undefined;

  const matched = deviceHub.ackCommand({
    userId,
    deviceId,
    commandId,
    status,
    reason,
  });

  res.setHeader('Cache-Control', 'no-store');
  res.json({ok: true, matched});
});
