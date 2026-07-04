/**
 * Gate-tier free tests for the Path A discrimination classifier.
 *
 * Tests the per-run classification logic in test/helpers/qa-path-a-classifier.ts,
 * which mirrors the rules in qa/SKILL.md Phase 8e.5-B.
 *
 * Fixtures are real Vitest/Jest JSON shapes captured empirically:
 *   - vitest-probe/ (Vitest 4.1.9)
 *   - jest-probe/ (Jest 30.4.2)
 * Ground truth document: scratchpad/runner-json-ground-truth.md
 *
 * All tests are free (no LLM, no API key) and run in <1s.
 */

import { describe, test, expect } from 'bun:test';
import {
  classifyCase,
  classifyRun,
  computeVerdict,
  type RunnerJsonOutput,
} from './helpers/qa-path-a-classifier';

// ---------------------------------------------------------------------------
// Per-case classifier tests
// ---------------------------------------------------------------------------

describe('classifyCase', () => {
  test('AssertionError message → assertion-shaped', () => {
    expect(classifyCase(['AssertionError: expected 3 to be 5'])).toBe('assertion-shaped');
  });

  test('"expected X to be Y" pattern → assertion-shaped', () => {
    expect(classifyCase(['Error: expected 3 to be 5 at Object.<anonymous>'])).toBe('assertion-shaped');
  });

  test('Received:/Expected: lines → assertion-shaped', () => {
    expect(classifyCase(['Expected: 5\nReceived: 3'])).toBe('assertion-shaped');
  });

  test('TypeError: is not a function → load-shaped', () => {
    expect(classifyCase(['TypeError: fn is not a function'])).toBe('load-shaped');
  });

  test('missing named export (killer case) → load-shaped', () => {
    // Exact shape from vitest-loadfail.json probe
    expect(
      classifyCase(['TypeError: __vite_ssr_import_0__.subtractThatDoesNotExistYet is not a function']),
    ).toBe('load-shaped');
  });

  test('ReferenceError → load-shaped', () => {
    expect(classifyCase(['ReferenceError: myVar is not defined'])).toBe('load-shaped');
  });

  test('Cannot find module → load-shaped', () => {
    expect(classifyCase(["Cannot find module './missing' from 'src/math.test.js'"])).toBe('load-shaped');
  });

  test('SyntaxError → load-shaped', () => {
    expect(classifyCase(['SyntaxError: Unexpected token (1:0)'])).toBe('load-shaped');
  });

  test('STACK_TRACE_ERROR (Vitest timeout shape) → load-shaped', () => {
    // Vitest timeout manifests as STACK_TRACE_ERROR, not "timeout" keyword
    expect(classifyCase(['Error: STACK_TRACE_ERROR\n    at task (...)'])).toBe('load-shaped');
  });

  test('empty message → load-shaped (fail-closed default)', () => {
    expect(classifyCase([''])).toBe('load-shaped');
  });

  test('empty failureMessages array → load-shaped (fail-closed default)', () => {
    expect(classifyCase([])).toBe('load-shaped');
  });
});

// ---------------------------------------------------------------------------
// Per-run classifier tests (classifyRun)
// ---------------------------------------------------------------------------

describe('classifyRun', () => {
  test('Scenario 1: real assertion failure → ASSERTION_FAIL', () => {
    // Matches vitest-assertfail.json: numTotalTests=1, assertion error message
    const json: RunnerJsonOutput = {
      numTotalTests: 1,
      testResults: [{
        status: 'failed',
        assertionResults: [{
          status: 'failed',
          failureMessages: ['AssertionError: expected 3 to be 5'],
        }],
      }],
    };
    expect(classifyRun(json)).toBe('ASSERTION_FAIL');
  });

  test('Scenario 2: missing named export (killer case) → LOAD_FAIL', () => {
    // Critical: this is count-IDENTICAL to scenario 1 (numTotalTests=1, status=failed)
    // but failureMessages reveals a load failure. Count alone cannot discriminate.
    // Matches vitest-loadfail.json.
    const json: RunnerJsonOutput = {
      numTotalTests: 1,
      testResults: [{
        status: 'failed',
        assertionResults: [{
          status: 'failed',
          failureMessages: [
            'TypeError: __vite_ssr_import_0__.subtractThatDoesNotExistYet is not a function',
          ],
        }],
      }],
    };
    expect(classifyRun(json)).toBe('LOAD_FAIL');
  });

  test('Scenario 3: missing module (numTotalTests=0) → LOAD_FAIL', () => {
    // Matches vitest-loadfail-module.json: numTotalTests=0, top-level message
    const json: RunnerJsonOutput = {
      numTotalTests: 0,
      message: 'Failed to load url ./src/does-not-exist.js',
      testResults: [{
        status: 'failed',
        assertionResults: [],
        message: 'Failed to load url ./src/does-not-exist.js',
      }],
    };
    expect(classifyRun(json)).toBe('LOAD_FAIL');
  });

  test('Scenario 4: all passing → PASS', () => {
    const json: RunnerJsonOutput = {
      numTotalTests: 1,
      testResults: [{
        status: 'passed',
        assertionResults: [{
          status: 'passed',
          failureMessages: [],
        }],
      }],
    };
    expect(classifyRun(json)).toBe('PASS');
  });

  test('Scenario 5 (BLOCKER): multi-case file with BOTH assertion-shaped AND load-shaped → LOAD_FAIL', () => {
    // This is the j10-mixed / v10-mixed scenario from the test-author blocker finding.
    // A test file has:
    //   case 1: genuine assertion failure (assertion-shaped)
    //   case 2: missing export TypeError (load-shaped)
    //   case 3: passes
    //
    // LOAD_SHAPE_DOMINATES: the presence of case 1 must NOT rescue the run to ASSERTION_FAIL.
    // Without the dominance rule, a naive "any assertion-shaped case → ASSERTION_FAIL" reader
    // would incorrectly classify this run as ASSERTION_FAIL, enabling tautological laundering.
    const json: RunnerJsonOutput = {
      numTotalTests: 3,
      testResults: [{
        status: 'failed',
        assertionResults: [
          {
            status: 'failed',
            // Case 1: genuine assertion failure (would be assertion-shaped in isolation)
            failureMessages: ['AssertionError: expected 4 to be 5'],
          },
          {
            status: 'failed',
            // Case 2: load failure (the fix-related case that exercises the new export)
            failureMessages: ['TypeError: fixedFn is not a function'],
          },
          {
            status: 'passed',
            failureMessages: [],
          },
        ],
      }],
    };
    // MUST be LOAD_FAIL, not ASSERTION_FAIL
    expect(classifyRun(json)).toBe('LOAD_FAIL');
  });

  test('testExecError set → LOAD_FAIL', () => {
    const json: RunnerJsonOutput = {
      numTotalTests: 1,
      testResults: [{
        status: 'failed',
        testExecError: { message: 'SyntaxError: Unexpected token' },
        assertionResults: [],
      }],
    };
    expect(classifyRun(json)).toBe('LOAD_FAIL');
  });

  test('Vitest empty assertionResults + message → LOAD_FAIL', () => {
    const json: RunnerJsonOutput = {
      numTotalTests: 1,
      testResults: [{
        status: 'failed',
        assertionResults: [],
        message: 'Failed to load url ./src/math.ts',
      }],
    };
    expect(classifyRun(json)).toBe('LOAD_FAIL');
  });
});

// ---------------------------------------------------------------------------
// Verdict computation tests (computeVerdict)
// ---------------------------------------------------------------------------

describe('computeVerdict', () => {
  test('all parent ASSERTION_FAIL + all fix PASS → verified (deterministic)', () => {
    const parentRuns = ['ASSERTION_FAIL', 'ASSERTION_FAIL', 'ASSERTION_FAIL'] as const;
    const fixRuns = ['PASS', 'PASS', 'PASS'] as const;
    expect(computeVerdict([...parentRuns], [...fixRuns])).toBe('verified (deterministic)');
  });

  test('any parent PASS → tautological', () => {
    expect(computeVerdict(['PASS', 'ASSERTION_FAIL', 'ASSERTION_FAIL'], ['PASS', 'PASS', 'PASS']))
      .toBe('tautological');
  });

  test('all parent PASS → tautological', () => {
    expect(computeVerdict(['PASS', 'PASS', 'PASS'], ['PASS', 'PASS', 'PASS']))
      .toBe('tautological');
  });

  test('any parent LOAD_FAIL → inconclusive', () => {
    expect(computeVerdict(['LOAD_FAIL', 'ASSERTION_FAIL', 'ASSERTION_FAIL'], ['PASS', 'PASS', 'PASS']))
      .toBe('inconclusive');
  });

  test('any parent TIMEOUT → inconclusive', () => {
    expect(computeVerdict(['TIMEOUT', 'ASSERTION_FAIL', 'ASSERTION_FAIL'], ['PASS', 'PASS', 'PASS']))
      .toBe('inconclusive');
  });

  test('any fix non-PASS → inconclusive (fix-side instability)', () => {
    expect(computeVerdict(['ASSERTION_FAIL', 'ASSERTION_FAIL', 'ASSERTION_FAIL'], ['PASS', 'ASSERTION_FAIL', 'PASS']))
      .toBe('inconclusive');
  });

  test('mixed parent results (ASSERTION_FAIL + LOAD_FAIL) → inconclusive', () => {
    // Multi-case file with LOAD_FAIL on one run and ASSERTION_FAIL on another
    expect(computeVerdict(['ASSERTION_FAIL', 'LOAD_FAIL', 'ASSERTION_FAIL'], ['PASS', 'PASS', 'PASS']))
      .toBe('inconclusive');
  });

  test('2-run variant: 2 parent ASSERTION_FAIL + 2 fix PASS → verified (deterministic)', () => {
    expect(computeVerdict(['ASSERTION_FAIL', 'ASSERTION_FAIL'], ['PASS', 'PASS']))
      .toBe('verified (deterministic)');
  });
});
