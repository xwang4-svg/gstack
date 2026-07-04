/**
 * Periodic behavioral E2E tests for Path A discrimination (qa v2.2.0).
 *
 * Tests that the qa skill correctly consumes pre-seeded testcheck.json verdicts
 * and applies the Phase 8e.5-C label consolidation table:
 *   - verified (deterministic)  → commit test + label correctly
 *   - tautological              → trigger re-author, anchor to fix diff
 *   - inconclusive              → fall back to verified (Path B), commit test
 *
 * These are periodic (not gate) because they use an LLM agent and are
 * non-deterministic quality benchmarks.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, runId,
  describeIfSelected, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-qa-path-a');

// ---------------------------------------------------------------------------
// Helper: set up a minimal git repo with a seeded testcheck verdict
// ---------------------------------------------------------------------------

function setupPathAFixture(opts: {
  baseDir: string;
  verdict: 'verified (deterministic)' | 'tautological' | 'inconclusive';
  fixSha: string;
  parentSha: string;
}) {
  const { baseDir, verdict, fixSha, parentSha } = opts;

  // Minimal project structure
  fs.mkdirSync(path.join(baseDir, '.gstack', 'qa-reports', 'screenshots'), { recursive: true });
  fs.mkdirSync(path.join(baseDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(baseDir, 'test'), { recursive: true });

  // Simple source file (the "fix" is that subtract now exists)
  fs.writeFileSync(
    path.join(baseDir, 'src', 'math.ts'),
    `export function add(a: number, b: number): number { return a + b; }
export function subtract(a: number, b: number): number { return a - b; }
`,
  );

  // Regression test file
  fs.writeFileSync(
    path.join(baseDir, 'test', 'math.regression-001.test.ts'),
    `// Regression: ISSUE-001 — subtract returned wrong value
// Found by /qa on 2026-07-04
import { describe, it, expect, vi } from 'vitest';
import { subtract } from '../src/math';

describe('subtract regression', () => {
  it('subtracts correctly', () => {
    expect(subtract(5, 3)).toBe(2);
  });
});
`,
  );

  // Minimal package.json
  fs.writeFileSync(
    path.join(baseDir, 'package.json'),
    JSON.stringify(
      {
        name: 'qa-path-a-fixture',
        version: '1.0.0',
        scripts: { test: 'vitest run --reporter=json' },
        devDependencies: { vitest: '^1.0.0' },
      },
      null,
      2,
    ),
  );

  // Pre-seeded testcheck.json with the specified verdict
  const testcheckData: Record<string, unknown> = {
    verdict,
    fix_sha: fixSha,
    parent_sha: parentSha,
    fix_runs: [
      { attempt: 1, classification: 'PASS', summary: '1 test passed' },
      { attempt: 2, classification: 'PASS', summary: '1 test passed' },
      { attempt: 3, classification: 'PASS', summary: '1 test passed' },
    ],
  };

  if (verdict === 'verified (deterministic)') {
    testcheckData.parent_runs = [
      { attempt: 1, classification: 'ASSERTION_FAIL', summary: 'subtract returned wrong value', failure_message_excerpt: 'AssertionError: expected 3 to be 2', load_shape_dominated: false },
      { attempt: 2, classification: 'ASSERTION_FAIL', summary: 'subtract returned wrong value', failure_message_excerpt: 'AssertionError: expected 3 to be 2', load_shape_dominated: false },
      { attempt: 3, classification: 'ASSERTION_FAIL', summary: 'subtract returned wrong value', failure_message_excerpt: 'AssertionError: expected 3 to be 2', load_shape_dominated: false },
    ];
    testcheckData.assertion_diff = 'subtract(5,3) returned 3 on parent (bug: missing subtract function), returned 2 on fix';
  } else if (verdict === 'tautological') {
    testcheckData.parent_runs = [
      { attempt: 1, classification: 'PASS', summary: 'all tests passed on parent — test did not detect bug', load_shape_dominated: false },
      { attempt: 2, classification: 'PASS', summary: 'all tests passed on parent', load_shape_dominated: false },
      { attempt: 3, classification: 'PASS', summary: 'all tests passed on parent', load_shape_dominated: false },
    ];
    testcheckData.assertion_diff = null;
  } else {
    // inconclusive
    testcheckData.parent_runs = [
      { attempt: 1, classification: 'LOAD_FAIL', summary: 'TypeError: subtract is not a function', failure_message_excerpt: 'TypeError: subtract is not a function', load_shape_dominated: true },
      { attempt: 2, classification: 'LOAD_FAIL', summary: 'TypeError: subtract is not a function', failure_message_excerpt: 'TypeError: subtract is not a function', load_shape_dominated: true },
      { attempt: 3, classification: 'LOAD_FAIL', summary: 'TypeError: subtract is not a function', failure_message_excerpt: 'TypeError: subtract is not a function', load_shape_dominated: true },
    ];
    testcheckData.assertion_diff = null;
  }

  fs.writeFileSync(
    path.join(baseDir, '.gstack', 'qa-reports', 'screenshots', 'issue-001-testcheck.json'),
    JSON.stringify(testcheckData, null, 2),
  );

  // Path B verdict (grounded pass — this issue is "verified (Path B)" entering Phase 8e.5-C)
  fs.writeFileSync(
    path.join(baseDir, '.gstack', 'qa-reports', 'screenshots', 'issue-001-verdict.json'),
    JSON.stringify({
      verdict: 'pass',
      rule_cited: 'subtract(a,b) must return a-b',
      observation: 'DOM shows correct result after fix',
      confidence: 0.95,
    }),
  );

  // Read the qa SKILL.md sections we need (8e.5-C label consolidation only)
  const skillMd = fs.readFileSync(path.join(ROOT, 'qa', 'SKILL.md'), 'utf-8');
  const start = skillMd.indexOf('### 8e.5-C. Label Consolidation');
  const end = skillMd.indexOf('\n### 8f.', start);
  const section = skillMd.slice(start, end > start ? end : undefined);
  fs.writeFileSync(path.join(baseDir, 'qa-8e5c-excerpt.md'), section);
}

// ---------------------------------------------------------------------------
// Behavioral E2E tests — periodic tier
// ---------------------------------------------------------------------------

describeIfSelected('Path A discrimination consumption (periodic)', ['qa-path-a-discrimination'], () => {
  afterAll(() => {
    finalizeEvalCollector(evalCollector);
  });

  /**
   * Scenario A: testcheck verdict = verified (deterministic)
   * Expected: skill labels the issue "verified (deterministic)" and commits the test
   */
  test('verified-deterministic verdict → correct label + commit intent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-path-a-det-'));
    try {
      setupPathAFixture({ baseDir: dir, verdict: 'verified (deterministic)', fixSha: 'abc1234', parentSha: 'def5678' });

      const result = await runSkillTest({
        prompt: `You are in the middle of a /qa session at Phase 8e.5-C (Label Consolidation).

CONTEXT:
- ISSUE-001 has already received a grounded "verified (Path B)" label from Phase 8e (Path B functional verifier passed).
- A regression test file exists at test/math.regression-001.test.ts and has already been confirmed to pass on the fixed code.
- Path A discrimination ran and produced: .gstack/qa-reports/screenshots/issue-001-testcheck.json

YOUR TASK:
Read .gstack/qa-reports/screenshots/issue-001-testcheck.json.
Read qa-8e5c-excerpt.md for the Phase 8e.5-C label consolidation table.
Apply the table to determine the final label for ISSUE-001.
State the final label clearly (e.g., "Final label: verified (deterministic)").
State what action to take on the test file (commit or delete).
Do NOT run any tests. Do NOT modify any files. Just read and classify.`,
        workingDirectory: dir,
        maxTurns: 12,
        timeout: 90_000,
        testName: 'qa-path-a-discrimination',
        runId,
      });

      logCost('qa-path-a: deterministic', result);
      const output = result.output ?? '';

      recordE2E(evalCollector, 'qa-path-a deterministic', 'Path A discrimination consumption', result, {
        passed: output.toLowerCase().includes('verified (deterministic)'),
      });

      expect(['success', 'error_max_turns']).toContain(result.exitReason);
      // The skill must surface the "verified (deterministic)" label
      expect(output.toLowerCase()).toContain('verified (deterministic)');
      // Must not mislabel as tautological or Path B fallback
      expect(output.toLowerCase()).not.toContain('tautological');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }, 120_000);

  /**
   * Scenario B: testcheck verdict = tautological
   * Expected: skill triggers re-author procedure, reads fix diff
   */
  test('tautological verdict → re-author triggered with fix-diff anchor', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-path-a-tauto-'));
    try {
      setupPathAFixture({ baseDir: dir, verdict: 'tautological', fixSha: 'abc1234', parentSha: 'def5678' });

      const result = await runSkillTest({
        prompt: `You are in the middle of a /qa session at Phase 8e.5-C (Label Consolidation).

CONTEXT:
- ISSUE-001 has a "verified (Path B)" label from Phase 8e.
- A regression test exists at test/math.regression-001.test.ts.
- Path A discrimination produced: .gstack/qa-reports/screenshots/issue-001-testcheck.json

YOUR TASK:
Read .gstack/qa-reports/screenshots/issue-001-testcheck.json.
Read qa-8e5c-excerpt.md for the Phase 8e.5-C label consolidation table and re-author procedure.
Apply the table to determine what to do for ISSUE-001.
Describe clearly: (1) what verdict was found, (2) what action to take, (3) what the re-author procedure requires (reading the fix diff, anchoring to changed lines).
Do NOT modify any files. Just analyze and describe the required action.`,
        workingDirectory: dir,
        maxTurns: 12,
        timeout: 90_000,
        testName: 'qa-path-a-discrimination',
        runId,
      });

      logCost('qa-path-a: tautological', result);
      const output = result.output ?? '';

      recordE2E(evalCollector, 'qa-path-a tautological', 'Path A discrimination consumption', result, {
        passed:
          output.toLowerCase().includes('tautological') &&
          (output.toLowerCase().includes('re-author') || output.toLowerCase().includes('reauthor')),
      });

      expect(['success', 'error_max_turns']).toContain(result.exitReason);
      expect(output.toLowerCase()).toContain('tautological');
      // Must mention re-authoring
      expect(output.toLowerCase()).toMatch(/re.?author/i);
      // Must not incorrectly label as verified
      expect(output.toLowerCase()).not.toContain('verified (deterministic)');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }, 120_000);

  /**
   * Scenario C: testcheck verdict = inconclusive
   * Expected: skill falls back to verified (Path B), commits test as-is
   */
  test('inconclusive verdict → falls back to verified (Path B), commits test', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-path-a-inconcl-'));
    try {
      setupPathAFixture({ baseDir: dir, verdict: 'inconclusive', fixSha: 'abc1234', parentSha: 'def5678' });

      const result = await runSkillTest({
        prompt: `You are in the middle of a /qa session at Phase 8e.5-C (Label Consolidation).

CONTEXT:
- ISSUE-001 has a "verified (Path B)" label from Phase 8e.
- A regression test exists at test/math.regression-001.test.ts.
- Path A discrimination produced: .gstack/qa-reports/screenshots/issue-001-testcheck.json

YOUR TASK:
Read .gstack/qa-reports/screenshots/issue-001-testcheck.json.
Read qa-8e5c-excerpt.md for the Phase 8e.5-C label consolidation table.
Apply the table to determine the final label for ISSUE-001.
State the final label and what action to take on the test file.
Do NOT modify any files. Just analyze and classify.`,
        workingDirectory: dir,
        maxTurns: 12,
        timeout: 90_000,
        testName: 'qa-path-a-discrimination',
        runId,
      });

      logCost('qa-path-a: inconclusive', result);
      const output = result.output ?? '';

      recordE2E(evalCollector, 'qa-path-a inconclusive', 'Path A discrimination consumption', result, {
        passed: output.toLowerCase().includes('verified (path b)'),
      });

      expect(['success', 'error_max_turns']).toContain(result.exitReason);
      // Must fall back to Path B label
      expect(output.toLowerCase()).toContain('verified (path b)');
      // Must mention committing the test (best-available artifact)
      expect(output.toLowerCase()).toMatch(/commit/i);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }, 120_000);
});
