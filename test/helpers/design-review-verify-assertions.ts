/**
 * Pure assertion predicates for the design-review independent-verify behavioral
 * eval (test/skill-e2e-design-review-verify.test.ts).
 *
 * Extracted so a FREE unit test (test/design-review-verify-assertions.test.ts)
 * can prove these predicates DISCRIMINATE — i.e. that the paid E2E gate actually
 * fails on a self-grading maker, and does not merely pass vacuously. Kept
 * dependency-free (no SkillTestResult import) so the free test never drags in the
 * paid `claude -p` harness.
 */

/** Last FINAL_STATUS token the maker emitted (lowercased), or null if none. */
export function parseFinalStatus(output: string): string | null {
  const matches = [...output.matchAll(/FINAL_STATUS:\s*([a-zA-Z-]+)/g)];
  if (matches.length === 0) return null;
  return matches[matches.length - 1][1].toLowerCase();
}

/** True iff the tool-call trace contains a real `git revert` Bash call. */
export function hadGitRevert(toolCalls: Array<{ tool: string; input?: unknown }>): boolean {
  return toolCalls.some(
    (tc) => tc.tool === 'Bash' && /git\s+revert/.test(JSON.stringify(tc.input ?? {})),
  );
}
