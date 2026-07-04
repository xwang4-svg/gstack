/**
 * Reference implementation of the Path A per-run classifier.
 *
 * Mirrors the classification rules in qa/SKILL.md Phase 8e.5-B exactly.
 * Used by the free gate-tier classifier tests and as a reference for
 * the blind discrimination subagent.
 *
 * Key invariant: LOAD_FAIL dominates. If ANY case in a multi-case test file
 * is load-shaped, the entire run is LOAD_FAIL — even if other cases are
 * assertion-shaped. This prevents the "tautological laundering via adjacent
 * case" failure class (confirmed empirically: j10-mixed.test.js).
 */

export type RunClassification = 'ASSERTION_FAIL' | 'LOAD_FAIL' | 'PASS' | 'TIMEOUT';

export type DiscriminationVerdict =
  | 'verified (deterministic)'
  | 'tautological'
  | 'inconclusive';

// Patterns indicating an assertion-shaped failure (matcher-level assertion failed)
const ASSERTION_PATTERNS: RegExp[] = [
  /AssertionError/i,
  /expected .* to/i,
  /^Received:/m,
  /^Expected:/m,
  /\bto be\b/i,
  /\bto equal\b/i,
  /\bto match\b/i,
  /\bto throw\b/i,
  /\bto have been called\b/i,
  /\btoEqual\b/,
  /\btoStrictEqual\b/,
  /\btoBe\b/,
];

// Patterns indicating a load/infrastructure-shaped failure (not a real assertion)
// These take priority over assertion patterns (LOAD_FAIL dominates).
const LOAD_PATTERNS: RegExp[] = [
  /TypeError:/i,
  /\bis not a function\b/i,
  /\bis not defined\b/i,
  /ReferenceError:/i,
  /Cannot find module/i,
  /SyntaxError:/i,
  /Failed to load/i,
  /Cannot read/i,
  /STACK_TRACE_ERROR/i,
  /does not provide an export named/i,
  /\bimport\b.+\bfailed\b/i,
];

/** Shape of a Vitest/Jest --reporter=json output (subset we care about). */
export interface RunnerJsonOutput {
  numTotalTests?: number;
  status?: string;
  message?: string;
  testResults?: Array<{
    status?: string;
    message?: string;
    testExecError?: unknown;
    assertionResults?: Array<{
      status: string;
      failureMessages: string[];
    }>;
  }>;
}

/**
 * Classify a single assertionResult case entry.
 *
 * Returns 'load-shaped' for ANY match against LOAD_PATTERNS,
 * 'assertion-shaped' for ASSERTION_PATTERNS, and 'load-shaped' for ambiguous
 * (fail-closed default).
 */
export function classifyCase(
  failureMessages: string[],
): 'assertion-shaped' | 'load-shaped' {
  const msg = failureMessages[0] ?? '';

  // Check load patterns first — they take priority (fail-closed)
  for (const pat of LOAD_PATTERNS) {
    if (pat.test(msg)) return 'load-shaped';
  }

  // Check assertion patterns
  for (const pat of ASSERTION_PATTERNS) {
    if (pat.test(msg)) return 'assertion-shaped';
  }

  // Ambiguous → load-shaped (pessimistic default, prevents false verified)
  return 'load-shaped';
}

/**
 * Classify a complete test runner JSON output into one RunClassification.
 *
 * Evaluation order (earlier supersedes later):
 *   1. Suite-level load check (numTotalTests=0, testExecError, empty assertionResults + message)
 *   2. Per-case classification with LOAD_SHAPE_DOMINATES roll-up
 *   3. PASS if all cases passed
 */
export function classifyRun(json: RunnerJsonOutput): RunClassification {
  // Step 1 — Suite-level load check (primary signal for whole-suite failures)
  if (json.numTotalTests === 0) return 'LOAD_FAIL';

  const fileResult = json.testResults?.[0];

  // Jest: testExecError set (when present — absent on some versions, so not primary)
  if (fileResult?.testExecError != null) return 'LOAD_FAIL';

  // Vitest: file-level status=failed + empty assertionResults + error message
  if (
    fileResult?.status === 'failed' &&
    (!fileResult.assertionResults || fileResult.assertionResults.length === 0) &&
    fileResult.message
  ) {
    return 'LOAD_FAIL';
  }

  // Step 2+3 — Per-case classification with LOAD_SHAPE_DOMINATES roll-up
  const cases = fileResult?.assertionResults ?? [];

  // Safety: empty cases after step 1 guards passed — treat as PASS (no failures)
  if (cases.length === 0) return 'PASS';

  let hasLoadShaped = false;
  let hasAssertionShaped = false;

  for (const c of cases) {
    if (c.status === 'passed') continue;
    // pending/skipped/todo → load-shaped (test didn't actually run)
    if (c.status === 'pending' || c.status === 'todo' || c.status === 'skipped') {
      hasLoadShaped = true;
      continue;
    }
    if (c.status === 'failed') {
      const shape = classifyCase(c.failureMessages);
      if (shape === 'load-shaped') hasLoadShaped = true;
      else hasAssertionShaped = true;
    }
  }

  // LOAD_SHAPE_DOMINATES: load-shaped in ANY case → whole run = LOAD_FAIL.
  // This is the critical invariant: an adjacent assertion-shaped case
  // does NOT rescue the run to ASSERTION_FAIL.
  if (hasLoadShaped) return 'LOAD_FAIL';

  if (hasAssertionShaped) return 'ASSERTION_FAIL';

  // No failures → PASS
  return 'PASS';
}

/**
 * Compute the discrimination verdict from classified runs.
 *
 * parentRuns: 2-3 classifications from the parent (buggy) worktree
 * fixRuns: 2-3 classifications from the fix (current) state
 */
export function computeVerdict(
  parentRuns: RunClassification[],
  fixRuns: RunClassification[],
): DiscriminationVerdict {
  // Any fix-side non-PASS → inconclusive (fix-side instability or regression)
  if (fixRuns.some(r => r !== 'PASS')) return 'inconclusive';

  // Any parent LOAD_FAIL or TIMEOUT → inconclusive (couldn't execute against parent)
  if (parentRuns.some(r => r === 'LOAD_FAIL' || r === 'TIMEOUT')) return 'inconclusive';

  // Any parent PASS → tautological (test ran cleanly but didn't detect the bug)
  if (parentRuns.some(r => r === 'PASS')) return 'tautological';

  // All parent ASSERTION_FAIL + all fix PASS → verified
  if (parentRuns.every(r => r === 'ASSERTION_FAIL') && fixRuns.every(r => r === 'PASS')) {
    return 'verified (deterministic)';
  }

  // Mixed or unexpected → inconclusive
  return 'inconclusive';
}
