import assert from 'node:assert/strict';
import test from 'node:test';
import {DESKTOP_LAYOUT_MEDIA_QUERY, getLayoutMode} from './useLayoutMode.ts';

interface SimulatedMediaEnv {
  width: number;
  hover?: boolean;
  anyHover?: boolean;
  pointerFine?: boolean;
  anyPointerFine?: boolean;
}

/**
 * Evaluates a CSS Media Queries Level 4 query string (supporting comma OR lists,
 * parenthesized sub-expressions, `and`, `or`, `min-width`, `hover`, `any-hover`,
 * `pointer`, and `any-pointer`) against a simulated viewport/pointer environment.
 */
function evaluateMediaQueryList(queryList: string, env: SimulatedMediaEnv): boolean {
  const branches = splitTopLevel(queryList, ',');
  return branches.some((branch) => evaluateExpr(branch.trim(), env));
}

function splitTopLevel(input: string, separator: ',' | 'and' | 'or'): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth < 0) throw new Error(`Unbalanced parentheses in media query: ${input}`);
    } else if (depth === 0) {
      if (separator === ',' && ch === ',') {
        parts.push(input.slice(start, i));
        start = i + 1;
      } else if (separator !== ',') {
        const prev = i === 0 ? ' ' : input[i - 1];
        const next = input[i + separator.length] ?? ' ';
        if (
          input.slice(i, i + separator.length).toLowerCase() === separator &&
          /[\s)]/.test(prev) &&
          /[\s(]/.test(next)
        ) {
          parts.push(input.slice(start, i));
          i += separator.length - 1;
          start = i + 1;
        }
      }
    }
  }

  if (depth !== 0) throw new Error(`Unbalanced parentheses in media query: ${input}`);
  parts.push(input.slice(start));
  return parts;
}

function stripOuterParens(expr: string): string {
  let current = expr.trim();
  while (current.startsWith('(') && current.endsWith(')')) {
    let depth = 0;
    let wrapsWhole = true;
    for (let i = 0; i < current.length; i++) {
      if (current[i] === '(') depth++;
      else if (current[i] === ')') depth--;
      if (depth === 0 && i < current.length - 1) {
        wrapsWhole = false;
        break;
      }
    }
    if (!wrapsWhole) break;
    current = current.slice(1, -1).trim();
  }
  return current;
}

function evaluateExpr(rawExpr: string, env: SimulatedMediaEnv): boolean {
  const expr = stripOuterParens(rawExpr);

  const orParts = splitTopLevel(expr, 'or');
  if (orParts.length > 1) {
    return orParts.some((part) => evaluateExpr(part, env));
  }

  const andParts = splitTopLevel(expr, 'and');
  if (andParts.length > 1) {
    return andParts.every((part) => evaluateExpr(part, env));
  }

  const minWidthMatch = /^min-width\s*:\s*(\d+(?:\.\d+)?)px$/i.exec(expr);
  if (minWidthMatch) {
    return env.width >= Number(minWidthMatch[1]);
  }

  const featureMatch = /^(hover|any-hover|pointer|any-pointer)\s*:\s*([a-z]+)$/i.exec(expr);
  if (featureMatch) {
    const feature = featureMatch[1].toLowerCase();
    const value = featureMatch[2].toLowerCase();
    if (feature === 'hover') return value === 'hover' ? Boolean(env.hover) : !env.hover;
    if (feature === 'any-hover') return value === 'hover' ? Boolean(env.anyHover) : !env.anyHover;
    if (feature === 'pointer')
      return value === 'fine' ? Boolean(env.pointerFine) : !env.pointerFine;
    if (feature === 'any-pointer')
      return value === 'fine' ? Boolean(env.anyPointerFine) : !env.anyPointerFine;
  }

  throw new Error(`Unsupported media feature in test evaluator: "${expr}"`);
}

function withSimulatedWindow<T>(env: SimulatedMediaEnv, fn: () => T): T {
  const prevWindow = (globalThis as {window?: unknown}).window;
  let observedQuery: string | null = null;
  (globalThis as {window?: unknown}).window = {
    matchMedia: (query: string) => {
      observedQuery = query;
      return {
        media: query,
        matches: evaluateMediaQueryList(query, env),
      };
    },
  };
  try {
    const result = fn();
    assert.equal(observedQuery, DESKTOP_LAYOUT_MEDIA_QUERY);
    return result;
  } finally {
    if (prevWindow === undefined) {
      delete (globalThis as {window?: unknown}).window;
    } else {
      (globalThis as {window?: unknown}).window = prevWindow;
    }
  }
}

test('DESKTOP_LAYOUT_MEDIA_QUERY matches expected media query list', () => {
  assert.equal(
    DESKTOP_LAYOUT_MEDIA_QUERY,
    '(min-width: 1600px), ((min-width: 1024px) and ((hover: hover) or (any-hover: hover) or (any-pointer: fine)))'
  );
});

test('2877 px with no hover/pointer -> desktop', () => {
  const mode = withSimulatedWindow(
    {width: 2877, hover: false, anyHover: false, pointerFine: false, anyPointerFine: false},
    () => getLayoutMode()
  );
  assert.equal(mode, 'desktop');
});

test('1280 px with hover and fine pointer -> desktop', () => {
  const mode = withSimulatedWindow(
    {width: 1280, hover: true, anyHover: true, pointerFine: true, anyPointerFine: true},
    () => getLayoutMode()
  );
  assert.equal(mode, 'desktop');
});

test('1280 px touch only -> mobile', () => {
  const mode = withSimulatedWindow(
    {width: 1280, hover: false, anyHover: false, pointerFine: false, anyPointerFine: false},
    () => getLayoutMode()
  );
  assert.equal(mode, 'mobile');
});

test('1366 px touch only (iPad Pro landscape) -> mobile', () => {
  const mode = withSimulatedWindow(
    {width: 1366, hover: false, anyHover: false, pointerFine: false, anyPointerFine: false},
    () => getLayoutMode()
  );
  assert.equal(mode, 'mobile');
});

test('390 px -> mobile (with or without hover/pointer)', () => {
  assert.equal(
    withSimulatedWindow(
      {width: 390, hover: false, anyHover: false, pointerFine: false, anyPointerFine: false},
      () => getLayoutMode()
    ),
    'mobile'
  );
  assert.equal(
    withSimulatedWindow(
      {width: 390, hover: true, anyHover: true, pointerFine: true, anyPointerFine: true},
      () => getLayoutMode()
    ),
    'mobile'
  );
});

test('boundary and hybrid pointer cases', () => {
  // 1600 px with no hover/pointer -> desktop
  assert.equal(
    withSimulatedWindow(
      {width: 1600, hover: false, anyHover: false, pointerFine: false, anyPointerFine: false},
      () => getLayoutMode()
    ),
    'desktop'
  );
  // 1599 px touch-only -> mobile
  assert.equal(
    withSimulatedWindow(
      {width: 1599, hover: false, anyHover: false, pointerFine: false, anyPointerFine: false},
      () => getLayoutMode()
    ),
    'mobile'
  );
  // 1280 px touch-primary laptop with mouse/trackpad (any-pointer: fine) -> desktop
  assert.equal(
    withSimulatedWindow(
      {width: 1280, hover: false, anyHover: false, pointerFine: false, anyPointerFine: true},
      () => getLayoutMode()
    ),
    'desktop'
  );
  // 1280 px with any-hover: hover -> desktop
  assert.equal(
    withSimulatedWindow(
      {width: 1280, hover: false, anyHover: true, pointerFine: false, anyPointerFine: false},
      () => getLayoutMode()
    ),
    'desktop'
  );
  // SSR guard (window undefined) -> mobile
  const prevWindow = (globalThis as {window?: unknown}).window;
  delete (globalThis as {window?: unknown}).window;
  try {
    assert.equal(getLayoutMode(), 'mobile');
  } finally {
    if (prevWindow !== undefined) {
      (globalThis as {window?: unknown}).window = prevWindow;
    }
  }
});
