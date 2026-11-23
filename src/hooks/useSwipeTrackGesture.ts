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
  /** Optional ref for call sites where pointer handlers and animated element are separate DOM nodes. */
  ref: (node: HTMLElement | null) => void;
  style: React.CSSProperties;
  handlers: {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void;
  };
}

const SPRING_BACK_TRANSITION =
  'transform 250ms cubic-bezier(0.22, 1, 0.36, 1), opacity 250ms ease-out';
const EXITING_TRANSITION =
  'transform 170ms cubic-bezier(0.22, 1, 0.36, 1), opacity 160ms ease-out';
const ENTERING_TRANSITION =
  'transform 320ms cubic-bezier(0.22, 1, 0.36, 1), opacity 260ms ease-out';

function getPhaseTransition(phase: AnimationPhase): string {
  if (phase === 'spring-back') return SPRING_BACK_TRANSITION;
  if (phase === 'exiting') return EXITING_TRANSITION;
  if (phase === 'entering') return ENTERING_TRANSITION;
  return 'none';
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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

  const phaseRef = useRef<AnimationPhase>('idle');
  const offsetXRef = useRef(0);
  const opacityRef = useRef(1);
  const explicitElRef = useRef<HTMLElement | null>(null);
  const fallbackElRef = useRef<HTMLElement | null>(null);

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
  const dragRafRef = useRef<number | null>(null);
  const raf1Ref = useRef<number | null>(null);
  const raf2Ref = useRef<number | null>(null);

  const ref = useCallback((node: HTMLElement | null) => {
    explicitElRef.current = node;
  }, []);

  const getTargetEl = useCallback((): HTMLElement | null => {
    return explicitElRef.current ?? fallbackElRef.current;
  }, []);

  const applyElementStyles = useCallback(
    (dx: number, opacity: number, nextPhase: AnimationPhase) => {
      const el = getTargetEl();
      if (!el) return;
      const rotation = dx * rotationFactor;
      el.style.transition = getPhaseTransition(nextPhase);
      el.style.transform = `translateX(${dx}px) rotate(${rotation}deg)`;
      el.style.opacity = String(opacity);
      el.style.willChange = nextPhase === 'idle' ? 'auto' : 'transform, opacity';
    },
    [getTargetEl, rotationFactor]
  );

  const commitPhase = useCallback((nextPhase: AnimationPhase) => {
    if (phaseRef.current !== nextPhase) {
      phaseRef.current = nextPhase;
      setPhase(nextPhase);
    }
  }, []);

  const clearTimers = useCallback(() => {
    if (exitTimerRef.current !== null) {
      window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    if (dragRafRef.current !== null) {
      window.cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = null;
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

  const scheduleDragVisuals = useCallback(() => {
    if (dragRafRef.current !== null) return;
    dragRafRef.current = window.requestAnimationFrame(() => {
      dragRafRef.current = null;
      applyElementStyles(offsetXRef.current, opacityRef.current, phaseRef.current);
    });
  }, [applyElementStyles]);

  const resetPointerTracking = useCallback(() => {
    pointerIdRef.current = null;
    axisLockRef.current = 'none';
    velocityXRef.current = 0;
  }, []);

  const triggerSpringBack = useCallback(() => {
    clearTimers();
    offsetXRef.current = 0;
    opacityRef.current = 1;

    if (prefersReducedMotion()) {
      applyElementStyles(0, 1, 'idle');
      commitPhase('idle');
      return;
    }

    applyElementStyles(0, 1, 'spring-back');
    commitPhase('spring-back');
    settleTimerRef.current = window.setTimeout(() => {
      applyElementStyles(0, 1, 'idle');
      commitPhase('idle');
      settleTimerRef.current = null;
    }, 260);
  }, [applyElementStyles, clearTimers, commitPhase]);

  const triggerSlideSkip = useCallback(
    (direction: 'next' | 'prev') => {
      clearTimers();
      suppressClickUntilRef.current = Date.now() + 350;

      if (prefersReducedMotion()) {
        offsetXRef.current = 0;
        opacityRef.current = 1;
        applyElementStyles(0, 1, 'idle');
        commitPhase('idle');
        if (direction === 'next') {
          onSwipeNext();
        } else {
          onSwipePrev();
        }
        return;
      }

      // Slide current cover out toward the swipe direction
      const exitX = direction === 'next' ? -slideDistance : slideDistance;
      const enterStartX = direction === 'next' ? slideDistance * 0.75 : -slideDistance * 0.75;

      offsetXRef.current = exitX;
      opacityRef.current = 0;
      applyElementStyles(exitX, 0, 'exiting');
      commitPhase('exiting');

      exitTimerRef.current = window.setTimeout(() => {
        exitTimerRef.current = null;

        if (direction === 'next') {
          onSwipeNext();
        } else {
          onSwipePrev();
        }

        // Jump instantaneously to the opposite edge with transition disabled
        offsetXRef.current = enterStartX;
        opacityRef.current = 0;
        applyElementStyles(enterStartX, 0, 'entering-prep');
        commitPhase('entering-prep');

        // Wait two frames so the browser commits the starting transform before animating in
        raf1Ref.current = window.requestAnimationFrame(() => {
          raf1Ref.current = null;
          raf2Ref.current = window.requestAnimationFrame(() => {
            raf2Ref.current = null;
            offsetXRef.current = 0;
            opacityRef.current = 1;
            applyElementStyles(0, 1, 'entering');
            commitPhase('entering');
            settleTimerRef.current = window.setTimeout(() => {
              applyElementStyles(0, 1, 'idle');
              commitPhase('idle');
              settleTimerRef.current = null;
            }, 340);
          });
        });
      }, 170);
    },
    [applyElementStyles, clearTimers, commitPhase, onSwipeNext, onSwipePrev, slideDistance]
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      // Only track primary mouse button; always allow touch/pen
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // Ignore gestures starting inside explicitly excluded interactive controls
      const target = e.target as HTMLElement | null;
      if (target && target.closest('[data-no-swipe="true"]')) return;
      // Ignore if an exit/enter skip animation is already running
      if (phaseRef.current === 'exiting' || phaseRef.current === 'entering-prep') return;

      fallbackElRef.current = e.currentTarget;
      clearTimers();
      pointerIdRef.current = e.pointerId;
      startXRef.current = e.clientX;
      startYRef.current = e.clientY;
      lastXRef.current = e.clientX;
      lastTimeRef.current = performance.now();
      velocityXRef.current = 0;
      axisLockRef.current = 'none';
    },
    [clearTimers]
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

      if (prefersReducedMotion()) {
        offsetXRef.current = 0;
        opacityRef.current = 1;
        commitPhase('dragging');
        return;
      }

      offsetXRef.current = dx;
      opacityRef.current = 1 - Math.min(absDx / 500, 0.25);
      commitPhase('dragging');
      scheduleDragVisuals();
    },
    [commitPhase, deadZone, scheduleDragVisuals]
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
  const currentOffsetX = offsetXRef.current;
  const rotation = currentOffsetX * rotationFactor;
  const transition = getPhaseTransition(phase);

  const pendingDirection: 'next' | 'prev' | null = isDragging
    ? currentOffsetX <= -threshold
      ? 'next'
      : currentOffsetX >= threshold
        ? 'prev'
        : null
    : null;

  const style: React.CSSProperties = {
    touchAction: 'pan-y',
    transform: `translateX(${currentOffsetX}px) rotate(${rotation}deg)`,
    opacity: opacityRef.current,
    transition,
    willChange: phase === 'idle' ? 'auto' : 'transform, opacity',
  };

  return {
    isDragging,
    deltaX: currentOffsetX,
    pendingDirection,
    shouldSuppressClick,
    ref,
    style,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
    },
  };
}
