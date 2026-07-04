import { describe, test, expect } from 'bun:test';
import { parseFinalStatus, hadGitRevert } from './helpers/design-review-verify-assertions';

/**
 * FREE, deterministic discrimination proof for the design-review independent
 * visual-verify gate.
 *
 * The paid E2E (test/skill-e2e-design-review-verify.test.ts) runs a real
 * `claude -p` maker against the shipped skill and asserts on its tool calls +
 * FINAL_STATUS. That proves the gate PASSES on correct behavior — but a gate
 * that can never fail is worthless. This unpaid test closes that hole: it feeds
 * the SAME predicates the E2E asserts on (`hadGitRevert`, `parseFinalStatus`)
 * synthetic transcripts of a SELF-GRADING maker (the exact regression the
 * feature guards against) and shows the gate would REJECT them.
 *
 * Runs under free `bun test` (no ANTHROPIC_API_KEY, no spend). The end-to-end
 * GREEN (real model obeys the real skill) and end-to-end RED (real model against
 * a de-fanged skill) run under EVALS=1 where a key is available — see the eval
 * file header for the command.
 */
describe('design-review verify gate — assertion discrimination (free)', () => {
  const readVerdict = { tool: 'Read', input: { file_path: 'design-review-report/screenshots/finding-001-verdict.json' } };
  const revertHead = { tool: 'Bash', input: { command: 'git revert --no-edit HEAD' } };
  const reFix = { tool: 'Edit', input: { file_path: 'src/styles.css' } };

  test('GOOD maker on fail verdict (reverts, not verified) → passes the case-1 gate', () => {
    const toolCalls = [readVerdict, revertHead, reFix];
    const output = 'Verdict is fail. Reverted HEAD, carrying rule_cited into a re-fix.\nFINAL_STATUS: reverted';
    // Case-1 gate = hadGitRevert === true AND status !== 'verified'
    expect(hadGitRevert(toolCalls)).toBe(true);
    expect(parseFinalStatus(output)).not.toBe('verified');
  });

  test('BAD maker on fail verdict (self-grades verified, never reverts) → case-1 gate REJECTS', () => {
    const toolCalls = [readVerdict]; // read the fail verdict, then ignored it
    const output = 'The button looks fine to me, calling it done.\nFINAL_STATUS: verified';
    // The two things the case-1 test asserts must both flip on this regression:
    expect(hadGitRevert(toolCalls)).toBe(false);   // case-1 asserts .toBe(true) → FAILS ✓
    expect(parseFinalStatus(output)).toBe('verified'); // case-1 asserts .not.toBe('verified') → FAILS ✓
  });

  test('BAD maker on ungrounded pass (self-grades verified) → case-2 gate REJECTS', () => {
    const output = 'Verdict says pass; looks consistent to me.\nFINAL_STATUS: verified';
    // Case-2 gate = status === 'best-effort'. A 'verified' here fails that.
    expect(parseFinalStatus(output)).not.toBe('best-effort'); // case-2 asserts === 'best-effort' → FAILS ✓
    expect(parseFinalStatus(output)).toBe('verified');
  });

  test('BAD maker on unavailable verdict (self-grades verified) → case-3 gate REJECTS', () => {
    const output = 'No verifier ran, but the fix is applied, marking done.\nFINAL_STATUS: verified';
    // Case-3 gate = status === 'best-effort'. 'verified' fails that.
    expect(parseFinalStatus(output)).not.toBe('best-effort'); // case-3 asserts === 'best-effort' → FAILS ✓
  });

  test('parseFinalStatus: last token wins, case-insensitive, null when absent', () => {
    expect(parseFinalStatus('FINAL_STATUS: reverted\nnoise\nFINAL_STATUS: Best-Effort')).toBe('best-effort');
    expect(parseFinalStatus('FINAL_STATUS:verified')).toBe('verified');
    expect(parseFinalStatus('the model forgot the status line')).toBeNull();
  });

  test('hadGitRevert: matches only a real revert, not other git calls', () => {
    expect(hadGitRevert([{ tool: 'Bash', input: { command: 'git log --oneline' } }])).toBe(false);
    expect(hadGitRevert([{ tool: 'Bash', input: { command: 'git status' } }])).toBe(false);
    expect(hadGitRevert([{ tool: 'Bash', input: { command: 'git revert HEAD' } }])).toBe(true);
    // A maker only *saying* "I would revert" (no Bash call) does not count.
    expect(hadGitRevert([{ tool: 'Read', input: { file_path: 'x' } }])).toBe(false);
  });
});
