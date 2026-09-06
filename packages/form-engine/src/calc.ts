import type { CalcNode } from './field-types/calculated';
import type { SubmissionData } from './types';
import { ageInYears } from './minor';

/**
 * Interprets a calculated field's formula against the current answers.
 *
 * Returns `null` rather than throwing when an input is missing or unusable —
 * a calculated field is shown live as the worker types, so most of the time it
 * is legitimately incomplete and a partial form must not blow up.
 */
export function evaluateCalc(node: CalcNode, data: SubmissionData): number | null {
  switch (node.op) {
    case 'const':
      return node.value;

    case 'field': {
      const raw = data[node.key];
      if (raw === null || raw === undefined || raw === '') return null;
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    }

    case 'add':
    case 'subtract':
    case 'multiply':
    case 'divide': {
      const left = evaluateCalc(node.left, data);
      const right = evaluateCalc(node.right, data);
      if (left === null || right === null) return null;
      if (node.op === 'add') return left + right;
      if (node.op === 'subtract') return left - right;
      if (node.op === 'multiply') return left * right;
      // Guard division separately: a zero denominator is a data condition here
      // (an empty household, a zero-day period), not a programming error.
      return right === 0 ? null : left / right;
    }

    case 'round': {
      const value = evaluateCalc(node.value, data);
      if (value === null) return null;
      const factor = 10 ** node.decimals;
      return Math.round(value * factor) / factor;
    }

    case 'age_years': {
      // `age_years` reads a date answer, so it bypasses the numeric coercion
      // that `field` applies.
      const key = node.date.op === 'field' ? node.date.key : null;
      if (!key) return null;
      const raw = data[key];
      if (typeof raw !== 'string' || raw === '') return null;
      // Shared with `resolveMinorStatus`, not copied. A second implementation
      // is off by one across a birthday, and the people it would be wrong
      // about are exactly the ones on the eighteenth-birthday boundary that
      // decides whether guardian consent is required.
      return ageInYears(new Date(raw), new Date());
    }

    default: {
      const exhaustive: never = node;
      throw new Error(`Unsupported calculation: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Field keys a formula reads — used to recompute only when an input changes. */
export function calcDependencies(node: CalcNode, into = new Set<string>()): Set<string> {
  switch (node.op) {
    case 'field':
      into.add(node.key);
      break;
    case 'add':
    case 'subtract':
    case 'multiply':
    case 'divide':
      calcDependencies(node.left, into);
      calcDependencies(node.right, into);
      break;
    case 'round':
      calcDependencies(node.value, into);
      break;
    case 'age_years':
      calcDependencies(node.date, into);
      break;
    case 'const':
      break;
  }
  return into;
}
