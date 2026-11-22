import React, {useCallback, useEffect, useRef, useState} from 'react';

export interface UseSwipeTrackGestureOptions {
  onSwipeNext: () => void;
  onSwipePrev: () => void;
  /** Horizontal distance (px) required to trigger a track skip (default: 75). */
  threshold?: number;
  /** Minimum movement (px) before locking into horizontal drag (default: 10). */
  deadZone?: number;
  /** Fast flick velocity threshold in px/ms (default: 0.55). */
  velocityThreshold?: number;
  /** Degrees of rotation per px of horizontal drag (default: 0.03; use 0 for flat mini-player). */
  rotationFactor?: number;
  /** Distance (px) to slide out/in during track transition (default: 360). */
  slideDistance?: number;
}

type AnimationPhase = 'idle' | 'dragging' | 'spring-back' | 'exiting' | 'entering-prep' | 'entering';

export interface SwipeTrackGestureResult {
  isDragging: boolean;
  deltaX: number;
  /** Visual direction hint when user has dragged past the threshold: 'next' | 'prev' | null */
  pendingDirection: 'next' | 'prev' | null;
  /** Returns true if a swipe just completed (use to suppress click-to-navigate on mini-player). */
  shouldSuppressClick: () => boolean;
  style: React.CSSProperties;
  handlers: {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void;
  };
}

export function useSwipeTrackGesture({
  onSwipeNext,
  onSwipePrev,
  threshold = 75,
  deadZone = 10,
  velocityThreshold = 0.55,
  rotationFactor = 0.03,
  slideDistance = 360,
}: UseSwipeTrackGestureOptions): SwipeTrackGestureResult {
  const [phase, setPhase] = useState<AnimationPhase>('idle');
  const [offsetX, setOffsetX] = useState(0);
  const [opacity, setOpacity] = useState(1);

  const pointerIdRef = useRef<number | null>(null);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const lastXRef = useRef(0);
  const lastTimeRef = useRef(0);
  const velocityXRef = useRef(0);
  const axisLockRef = useRef<'none' | 'horizontal' | 'vertical'>('none');
  const suppressClickUntilRef = useRef(0);
  const exitTimerRef = useRef<number | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  const raf1Ref = useRef<number | null>(null);
  const raf2Ref = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (exitTimerRef.current !== null) {
      window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    if (raf1Ref.current !== null) {
      window.cancelAnimationFrame(raf1Ref.current);
      raf1Ref.current = null;
    }
    if (raf2Ref.current !== null) {
      window.cancelAnimationFrame(raf2Ref.current);
      raf2Ref.current = null;
    }
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const resetPointerTracking = useCallback(() => {
    pointerIdRef.current = null;
    axisLockRef.current = 'none';
    velocityXRef.current = 0;
  }, []);

  const triggerSpringBack = useCallback(() => {
    clearTimers();
    setPhase('spring-back');
    setOffsetX(0);
    setOpacity(1);
    settleTimerRef.current = window.setTimeout(() => {
      setPhase('idle');
      settleTimerRef.current = null;
    }, 260);
  }, [clearTimers]);

  const triggerSlideSkip = useCallback(
    (direction: 'next' | 'prev') => {
      clearTimers();
      suppressClickUntilRef.current = Date.now() + 350;

      // Slide current cover out toward the swipe direction
      const exitX = direction === 'next' ? -slideDistance : slideDistance;
      const enterStartX = direction === 'next' ? slideDistance * 0.75 : -slideDistance * 0.75;

      setPhase('exiting');
      setOffsetX(exitX);
      setOpacity(0);

      exitTimerRef.current = window.setTimeout(() => {
        exitTimerRef.current = null;

        if (direction === 'next') {
          onSwipeNext();
        } else {
          onSwipePrev();
        }

        // Jump instantaneously to the opposite edge with transition disabled
        setPhase('entering-prep');
        setOffsetX(enterStartX);
        setOpacity(0);

        // Wait two frames so the browser commits the starting transform before animating in
        raf1Ref.current = window.requestAnimationFrame(() => {
          raf1Ref.current = null;
          raf2Ref.current = window.requestAnimationFrame(() => {
            raf2Ref.current = null;
            setPhase('entering');
            setOffsetX(0);
            setOpacity(1);
            settleTimerRef.current = window.setTimeout(() => {
              setPhase('idle');
              settleTimerRef.current = null;
            }, 340);
          });
        });
      }, 170);
    },
    [clearTimers, onSwipeNext, onSwipePrev, slideDistance]
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      // Only track primary mouse button; always allow touch/pen
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // Ignore gestures starting inside explicitly excluded interactive controls
      const target = e.target as HTMLElement | null;
      if (target && target.closest('[data-no-swipe="true"]')) return;
      // Ignore if an exit/enter skip animation is already running
      if (phase === 'exiting' || phase === 'entering-prep') return;

      clearTimers();
      pointerIdRef.current = e.pointerId;
      startXRef.current = e.clientX;
      startYRef.current = e.clientY;
      lastXRef.current = e.clientX;
      lastTimeRef.current = performance.now();
      velocityXRef.current = 0;
      axisLockRef.current = 'none';
    },
    [clearTimers, phase]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (pointerIdRef.current !== e.pointerId) return;

      const dx = e.clientX - startXRef.current;
      const dy = e.clientY - startYRef.current;
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);

      if (axisLockRef.current === 'vertical') return;

      if (axisLockRef.current === 'none') {
        // Ignore small accidental taps below deadZone
        if (absDx < deadZone && absDy < deadZone) return;

        // Ignore gesture if vertical movement exceeds horizontal movement
        if (absDy > absDx) {
          axisLockRef.current = 'vertical';
          return;
        }

        axisLockRef.current = 'horizontal';
        suppressClickUntilRef.current = Date.now() + 350;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // Ignore if pointer capture is unavailable
        }
      }

      // Compute instantaneous horizontal velocity (px/ms) smoothed with previous sample
      const now = performance.now();
      const dt = Math.max(now - lastTimeRef.current, 1);
      const instantVx = (e.clientX - lastXRef.current) / dt;
      velocityXRef.current = velocityXRef.current * 0.35 + instantVx * 0.65;
      lastXRef.current = e.clientX;
      lastTimeRef.current = now;

      setPhase('dragging');
      setOffsetX(dx);
      setOpacity(1 - Math.min(absDx / 500, 0.25));
    },
    [deadZone]
  );

  const finishGesture = useCallback(
    (e: React.PointerEvent<HTMLElement>, cancelled: boolean) => {
      if (pointerIdRef.current !== e.pointerId) return;

      const wasHorizontal = axisLockRef.current === 'horizontal';
      const dx = e.clientX - startXRef.current;
      const vx = velocityXRef.current;

      try {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore
      }

      resetPointerTracking();

      if (!wasHorizontal) return;

      suppressClickUntilRef.current = Date.now() + 300;

      if (cancelled) {
        triggerSpringBack();
        return;
      }

      const isFastLeftFlick = dx < -28 && vx < -velocityThreshold;
      const isFastRightFlick = dx > 28 && vx > velocityThreshold;

      if (dx < -threshold || isFastLeftFlick) {
        triggerSlideSkip('next');
      } else if (dx > threshold || isFastRightFlick) {
        triggerSlideSkip('prev');
      } else {
        triggerSpringBack();
      }
    },
    [resetPointerTracking, threshold, triggerSlideSkip, triggerSpringBack, velocityThreshold]
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      finishGesture(e, false);
    },
    [finishGesture]
  );

  const onPointerCancel = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      finishGesture(e, true);
    },
    [finishGesture]
  );

  const shouldSuppressClick = useCallback(() => {
    return Date.now() < suppressClickUntilRef.current;
  }, []);

  const isDragging = phase === 'dragging';
  const rotation = offsetX * rotationFactor;

  let transition = 'none';
  if (phase === 'spring-back') {
    transition = 'transform 250ms cubic-bezier(0.22, 1, 0.36, 1), opacity 250ms ease-out';
  } else if (phase === 'exiting') {
    transition = 'transform 170ms cubic-bezier(0.22, 1, 0.36, 1), opacity 160ms ease-out';
  } else if (phase === 'entering') {
    transition = 'transform 320ms cubic-bezier(0.22, 1, 0.36, 1), opacity 260ms ease-out';
  }

  const pendingDirection: 'next' | 'prev' | null = isDragging
    ? offsetX <= -threshold
      ? 'next'
      : offsetX >= threshold
        ? 'prev'
        : null
    : null;

  const style: React.CSSProperties = {
    touchAction: 'pan-y',
    transform: `translateX(${offsetX}px) rotate(${rotation}deg)`,
    opacity,
    transition,
    willChange: phase === 'idle' ? 'auto' : 'transform, opacity',
  };

  return {
    isDragging,
    deltaX: offsetX,
    pendingDirection,
    shouldSuppressClick,
    style,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
    },
  };
}
