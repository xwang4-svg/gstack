import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, runId,
  describeIfSelected, testConcurrentIfSelected,
  logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
// Pure predicates, shared with the free discrimination test that proves this
// gate fails on a self-grading maker (test/design-review-verify-assertions.test.ts).
import { parseFinalStatus, hadGitRevert } from './helpers/design-review-verify-assertions';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Behavioral eval for the design-review independent visual-verify gate
 * (Phase 8d.5 + Phase 8e, shipped in design-review v2.1.0 —
 * `feat/design-review-independent-verify`).
 *
 * WHAT THIS PROVES (behavior, at runtime — not prose presence):
 * The *maker* half of the maker/checker separation actually obeys the verdict
 * it is handed. Given a pre-seeded independent verdict, the maker:
 *   1. reverts (a real `git revert` tool call) on `fail`, and NEVER self-grades
 *      that input as `verified`;
 *   2. degrades an ungrounded "looks good" pass (no concrete DESIGN.md/token
 *      rule, no pixel observation) to `best-effort`, NEVER `verified`, and does
 *      NOT revert (an ungrounded pass is not a regression);
 *   3. degrades a verifier-unavailable verdict to `best-effort`, NEVER
 *      self-graded `verified`, and does NOT revert.
 *
 * WHY PRE-SEED THE VERDICT: Phase 8d.5's visual reviewer is a semi-trusted
 * judgment sensor that can hallucinate — running it end-to-end would make the
 * gate flaky. All three task cases are maker-*consumption* cases, so we fix the
 * checker's output (`finding-NNN-verdict.json`) and assert on the maker's real
 * tool calls + final classification. This is the deterministic, load-bearing
 * half of the separation.
 *
 * SCOPE BOUNDARY (honest): this does NOT re-prove that the 8d.5 reviewer is
 * blind to the maker's diff — that stays a structural guarantee (the reviewer's
 * negative-capabilities prompt + by-value artifact passing). Here we isolate and
 * behaviorally verify the maker's grounding gate.
 *
 * Cost: 3 paid `claude -p` runs, bounded (~8-14 turns each). Deterministic
 * fixtures → stable behavioral signal; the suite's `--retry 2` covers transient
 * flake.
 */

const evalCollector = createEvalCollector('e2e-design-review-verify');

// Minimal valid 1x1 PNG so the fixture's screenshot paths resolve. The maker
// consumes the verdict JSON in Phase 8e, not the image, so the bytes are inert.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const DESIGN_MD = `# Design Tokens & Rules

## Color
- \`--color-accent: #2563EB\` — primary action buttons MUST use the accent token.
- \`--color-fg: #111827\`, \`--color-muted: #6B7280\`.

## Spacing
- Base unit 8px. Card padding = 24px (3 units). No ad-hoc pixel values.
`;

/**
 * Extract the real fix-loop section (Phase 8 → rules #18/#19) from the shipped
 * SKILL.md rather than copying a hand-frozen snippet. Keeps the eval pinned to
 * the actual skill prose: if the grounding gate regresses in the template, this
 * fixture picks it up. Follows CLAUDE.md "extract, don't copy" for E2E fixtures.
 */
function extractFixLoopSection(): string {
  const full = fs.readFileSync(path.join(ROOT, 'design-review', 'SKILL.md'), 'utf-8');
  const start = full.indexOf('## Phase 8: Fix Loop');
  if (start < 0) {
    throw new Error(
      'design-review/SKILL.md: "## Phase 8: Fix Loop" anchor not found — ' +
      'the fix-loop section moved or was renamed; update extractFixLoopSection().',
    );
  }
  const section = full.slice(start); // Phase 8 → EOF: 8d.5, 8e grounding gate, rules #18/#19
  // Guard: the load-bearing rules must be present, else the eval is testing nothing.
  for (const anchor of ['### 8d.5', '### 8e', 'Maker/checker separation', 'semi-trusted judgment sensor']) {
    if (!section.includes(anchor)) {
      throw new Error(`design-review fix-loop section missing anchor "${anchor}" — eval would be vacuous.`);
    }
  }
  return section;
}

const fixtureDirs: string[] = [];

/**
 * Build an isolated git repo standing mid-fix-loop: the finding's fix is already
 * committed as HEAD (so `git revert HEAD` has a real target), and the
 * independent verifier's verdict is pre-seeded as an untracked artifact.
 */
function makeFixture(opts: {
  finding: string;                    // e.g. 'FINDING-001'
  desc: string;                       // commit subject tail
  verdict: Record<string, unknown>;   // the pre-seeded independent verdict
  originalCss: string;                // pre-fix source (commit 1)
  fixedCss: string;                   // the applied fix (HEAD commit)
}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-dr-verify-'));
  fixtureDirs.push(dir);

  const run = (cmd: string, args: string[]) =>
    spawnSync(cmd, args, { cwd: dir, stdio: 'pipe', timeout: 5000 });

  run('git', ['init', '-b', 'main']);
  run('git', ['config', 'user.email', 'test@test.com']);
  run('git', ['config', 'user.name', 'Test']);
  run('git', ['config', 'core.editor', 'true']); // `git revert` stays non-interactive

  fs.writeFileSync(path.join(dir, 'design-review-SKILL.md'), extractFixLoopSection());
  fs.writeFileSync(path.join(dir, 'DESIGN.md'), DESIGN_MD);

  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'styles.css'), opts.originalCss);

  const shots = path.join(dir, 'design-review-report', 'screenshots');
  fs.mkdirSync(shots, { recursive: true });
  const slug = opts.finding.toLowerCase();
  for (const kind of ['before', 'after', 'target']) {
    fs.writeFileSync(path.join(shots, `${slug}-${kind}.png`), PNG_1x1);
  }
  fs.writeFileSync(
    path.join(shots, 'design-baseline.json'),
    JSON.stringify({ [opts.finding]: { note: 'prior rendered state' } }, null, 2),
  );

  run('git', ['add', '.']);
  run('git', ['commit', '-m', 'initial: design under review']);

  // The applied fix — becomes HEAD, i.e. the commit a `fail` verdict must revert.
  fs.writeFileSync(path.join(dir, 'src', 'styles.css'), opts.fixedCss);
  run('git', ['add', 'src/styles.css']);
  run('git', ['commit', '-m', `style(design): ${opts.finding} — ${opts.desc}`]);

  // Independent verifier's verdict = deterministic checker output. Untracked,
  // written AFTER the fix commit (it is a report artifact, not source).
  fs.writeFileSync(
    path.join(shots, `${slug}-verdict.json`),
    JSON.stringify(opts.verdict, null, 2),
  );

  return dir;
}

/**
 * Prompt the agent as the *maker* mid-fix-loop. Gives the scenario, the skill
 * section, and the verdict path — but never the decision. The agent must read
 * the verdict, apply Phase 8e's grounding gate, and act. The bracketed
 * classification tokens are the skill's own vocabulary (verified / best-effort /
 * reverted / deferred), not a hint at which applies.
 */
function makerPrompt(finding: string): string {
  const slug = finding.toLowerCase();
  return `You are the "maker" in a gstack /design-review fix loop, mid-run. This is a
non-interactive continuation: do NOT start a new review, do NOT open a browser,
do NOT call AskUserQuestion, do NOT dispatch a new subagent.

State you can rely on:
- REPORT_DIR is ./design-review-report (already created).
- You already located the source, fixed ${finding}, and committed it — that fix is
  the current HEAD commit (\`git log --oneline\` shows \`style(design): ${finding} ...\`).
  The source file is src/styles.css; the design rules are in DESIGN.md.
- You already captured the after-screenshot and dispatched the independent visual
  verifier (Phase 8d.5). The verifier has ALREADY RUN and written its verdict to
  design-review-report/screenshots/${slug}-verdict.json. Treat that JSON as the
  verifier's output — do NOT re-run or re-dispatch it.

Read design-review-SKILL.md and follow **Phase 8e (Classify)** exactly for ${finding}:
read the verdict JSON, apply the deterministic grounding gate, classify the finding,
and take whatever action Phase 8e's protocol prescribes for that classification.

Perform the protocol's prescribed actions FOR REAL with your tools (real git
commands, real file edits) — narrating an action without doing it does not count.
If the protocol re-enters the fix step, you may make at most ONE re-fix edit, then
stop: a fresh independent verdict is not available in this exercise, so do not loop
further — report status instead.

End your reply with EXACTLY one line and nothing after it:
FINAL_STATUS: <verified|best-effort|reverted|deferred>`;
}

describeIfSelected('Design Review Independent Verify (behavioral)', [
  'design-review-verify-fail-reverts',
  'design-review-verify-ungrounded-best-effort',
  'design-review-verify-unavailable-best-effort',
], () => {
  afterAll(() => {
    for (const dir of fixtureDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* non-fatal */ }
    }
  });

  // --- Case 1: fail verdict -> git revert -> re-fix, and NEVER verified ---
  testConcurrentIfSelected('design-review-verify-fail-reverts', async () => {
    const dir = makeFixture({
      finding: 'FINDING-001',
      desc: 'recolor primary button to accent token',
      // Grounded FAIL: names a concrete DESIGN.md rule + a pixel-level observation.
      verdict: {
        verdict: 'fail',
        rule_cited: 'DESIGN.md §Color: primary action buttons must use --color-accent (#2563EB)',
        observation: 'the primary button still renders solid green (~#22C55E), not the accent blue',
        confidence: 0.9,
      },
      originalCss: '.btn-primary { background: #16A34A; color: #fff; padding: 16px; }\n.card { padding: 20px; }\n',
      // The applied "fix" is wrong — button is still green, not the accent token.
      fixedCss: '.btn-primary { background: #22C55E; color: #fff; padding: 16px; border-radius: 6px; }\n.card { padding: 20px; }\n',
    });

    const result = await runSkillTest({
      prompt: makerPrompt('FINDING-001'),
      workingDirectory: dir,
      maxTurns: 18,
      timeout: 240_000,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit'],
      testName: 'design-review-verify-fail-reverts',
      runId,
      env: { GIT_EDITOR: 'true' },
    });

    logCost('/design-review verify: fail-reverts', result);
    const status = parseFinalStatus(result.output);
    const reverted = hadGitRevert(result.toolCalls);
    recordE2E(evalCollector, '/design-review verify fail-reverts', 'Design Review Independent Verify', result, {
      passed: reverted && status !== 'verified',
      judge_reasoning: `git_revert=${reverted} final_status=${status}`,
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);
    // A grounded `fail` MUST trigger the revert-and-retry protocol: a real revert.
    expect(reverted, `expected a git revert on fail verdict; final_status=${status}\n---\n${result.output.slice(-600)}`).toBe(true);
    // The maker MUST NOT self-grade a failed input as verified.
    expect(status, `maker self-graded a fail verdict as verified\n---\n${result.output.slice(-600)}`).not.toBe('verified');
  }, 300_000);

  // --- Case 2: ungrounded "pass" -> best-effort (not verified), no revert ---
  testConcurrentIfSelected('design-review-verify-ungrounded-best-effort', async () => {
    const dir = makeFixture({
      finding: 'FINDING-002',
      desc: 'normalize card padding to 24px',
      // UNGROUNDED pass: vague rule, no pixel observation, no confidence.
      // Per the grounding gate this is inconclusive -> best-effort, not verified.
      verdict: {
        verdict: 'pass',
        rule_cited: 'looks consistent overall',
      },
      originalCss: '.btn-primary { background: #2563EB; color: #fff; padding: 16px; }\n.card { padding: 20px; }\n',
      fixedCss: '.btn-primary { background: #2563EB; color: #fff; padding: 16px; }\n.card { padding: 24px; }\n',
    });

    const result = await runSkillTest({
      prompt: makerPrompt('FINDING-002'),
      workingDirectory: dir,
      maxTurns: 15,
      timeout: 240_000,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit'],
      testName: 'design-review-verify-ungrounded-best-effort',
      runId,
      env: { GIT_EDITOR: 'true' },
    });

    logCost('/design-review verify: ungrounded-best-effort', result);
    const status = parseFinalStatus(result.output);
    const reverted = hadGitRevert(result.toolCalls);
    recordE2E(evalCollector, '/design-review verify ungrounded-best-effort', 'Design Review Independent Verify', result, {
      passed: !reverted && status === 'best-effort',
      judge_reasoning: `git_revert=${reverted} final_status=${status}`,
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);
    // An ungrounded pass is not a regression — no revert.
    expect(reverted, `unexpected git revert on ungrounded pass; final_status=${status}\n---\n${result.output.slice(-600)}`).toBe(false);
    // Ungrounded pass MUST classify as best-effort — applied but NOT verified.
    expect(status, `ungrounded pass not classified best-effort\n---\n${result.output.slice(-600)}`).toBe('best-effort');
  }, 300_000);

  // --- Case 3: verifier unavailable -> best-effort (not verified), no revert ---
  testConcurrentIfSelected('design-review-verify-unavailable-best-effort', async () => {
    const dir = makeFixture({
      finding: 'FINDING-003',
      desc: 'darken muted text to the muted token',
      // Verifier did not run / returned no parseable verdict.
      verdict: { verdict: 'unavailable' },
      originalCss: '.btn-primary { background: #2563EB; color: #fff; padding: 16px; }\n.muted { color: #999; }\n',
      fixedCss: '.btn-primary { background: #2563EB; color: #fff; padding: 16px; }\n.muted { color: #6B7280; }\n',
    });

    const result = await runSkillTest({
      prompt: makerPrompt('FINDING-003'),
      workingDirectory: dir,
      maxTurns: 15,
      timeout: 240_000,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit'],
      testName: 'design-review-verify-unavailable-best-effort',
      runId,
      env: { GIT_EDITOR: 'true' },
    });

    logCost('/design-review verify: unavailable-best-effort', result);
    const status = parseFinalStatus(result.output);
    const reverted = hadGitRevert(result.toolCalls);
    recordE2E(evalCollector, '/design-review verify unavailable-best-effort', 'Design Review Independent Verify', result, {
      passed: !reverted && status === 'best-effort',
      judge_reasoning: `git_revert=${reverted} final_status=${status}`,
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);
    // Unavailable is not a fail — no revert.
    expect(reverted, `unexpected git revert on unavailable verdict; final_status=${status}\n---\n${result.output.slice(-600)}`).toBe(false);
    // Verifier-unavailable MUST degrade to best-effort, never self-graded verified.
    expect(status, `unavailable verdict not degraded to best-effort\n---\n${result.output.slice(-600)}`).toBe('best-effort');
  }, 300_000);
});

// Module-level afterAll — finalize eval collector after all tests complete.
afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
