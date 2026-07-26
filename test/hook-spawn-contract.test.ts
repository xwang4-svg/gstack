/**
 * Repo-wide PreToolUse hook command contract.
 *
 * Per-skill suites (freeze/tests, careful/tests) each assert their own hook
 * deeply, which is why freeze and careful stayed correct while investigate and
 * guard silently rotted — coverage was organised per skill, but this bug class
 * is distributed per *contract*. This file closes that gap: every skill that
 * declares a `hooks:` block is checked here, so a new hook-declaring skill is
 * covered the day it lands.
 *
 * Three forms are known to be dead on arrival (all verified by execution, not
 * by reading — reading is what produced the wrong verdict originally):
 *
 *   1. `bash $HOME/x.sh`               -> exit 127. Windows spawns hooks via
 *      cmd.exe /d /s /c with verbatim args; cmd.exe does not expand $HOME, so
 *      bash receives the literal string and dies before any check runs.
 *   2. `'bash -c ''S="..."; ...'''`    -> exit 0, hook never runs. cmd.exe
 *      shreds the nested single quotes ("'S' is not recognized"). Worse than
 *      127: it fails *open* and silently, so the skill looks armed.
 *   3. `${CLAUDE_SKILL_DIR}` anywhere in a hook command -> never substituted.
 *      cli.js interpolates it only into skill body text (getPromptForCommand),
 *      and never injects it into the hook process env. In skill *body* text it
 *      is legitimate — see investigate-freeze-path.test.ts.
 *
 * The one surviving form: `bash -c "exec \"$HOME/...\""` — expansion happens
 * inside bash, which works on every platform.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const INSTALL = path.join(os.homedir(), '.claude', 'skills', 'gstack');

interface HookCommand {
  file: string;
  raw: string; // the YAML scalar as written, quoting intact
  cmd: string; // unwrapped shell command
}

/** Split frontmatter off a SKILL.md / SKILL.md.tmpl. Returns null if absent. */
function frontmatter(content: string): string | null {
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  return end === -1 ? null : content.slice(3, end);
}

/** Unwrap a YAML single/double-quoted scalar. */
function unwrap(scalar: string): string {
  const v = scalar.trim();
  if (v.startsWith("'") && v.endsWith("'") && v.length > 1) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v.startsWith('"') && v.endsWith('"') && v.length > 1) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Scan every skill dir for hook commands.
 *
 * A file that opens with `---` but never terminates its frontmatter is recorded
 * as malformed rather than skipped. Skipping is how such a file hides: careful/
 * SKILL.md shipped for a while with `sensitive: true---` (terminator glued onto
 * the last key), which silently dropped it out of this scan entirely — the suite
 * stayed green while covering one fewer skill than it appeared to.
 */
function scanSkills(): { commands: HookCommand[]; malformed: string[] } {
  const commands: HookCommand[] = [];
  const malformed: string[] = [];

  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }
    for (const base of ['SKILL.md', 'SKILL.md.tmpl']) {
      const file = path.join(ROOT, entry.name, base);
      if (!fs.existsSync(file)) continue;

      const content = fs.readFileSync(file, 'utf-8');
      if (!content.startsWith('---')) continue; // not a frontmatter doc at all

      const fm = frontmatter(content);
      if (fm === null) {
        malformed.push(`${entry.name}/${base}`);
        continue;
      }
      if (!/^hooks:/m.test(fm)) continue;

      for (const m of fm.matchAll(/^\s*command:\s*(.+?)\s*$/gm)) {
        commands.push({ file: `${entry.name}/${base}`, raw: m[1], cmd: unwrap(m[1]) });
      }
    }
  }
  return {
    commands: commands.sort((a, b) => a.file.localeCompare(b.file)),
    malformed: malformed.sort(),
  };
}

const { commands: COMMANDS, malformed: MALFORMED } = scanSkills();

describe('hook command contract (static)', () => {
  test('every SKILL.md terminates its frontmatter (a malformed one silently leaves this scan)', () => {
    expect(MALFORMED).toEqual([]);
  });

  test('the repo actually declares hooks somewhere (guards against a silent no-op suite)', () => {
    expect(COMMANDS.length).toBeGreaterThan(0);
  });

  // Pin the covered set. If a hook-declaring skill stops being collected — the
  // failure mode that hid careful/SKILL.md — this drops and fails loudly rather
  // than quietly testing less.
  test('all four hook-declaring skills are covered', () => {
    const skills = [...new Set(COMMANDS.map((c) => c.file.split('/')[0]))].sort();
    expect(skills).toEqual(['careful', 'freeze', 'guard', 'investigate']);
  });

  for (const { file, raw, cmd } of COMMANDS) {
    const label = `${file}: ${cmd.slice(0, 58)}`;

    test(`${label} — no \${CLAUDE_SKILL_DIR} (body-text-only, never in hook commands)`, () => {
      expect(cmd).not.toContain('${CLAUDE_SKILL_DIR}');
    });

    test(`${label} — no bare 'bash $VAR' (cmd.exe leaves it unexpanded, exit 127)`, () => {
      expect(cmd).not.toMatch(/^(bash|sh)\s+["']?\$/);
    });

    test(`${label} — no nested single quotes (cmd.exe shreds them, silent fail-open)`, () => {
      expect(raw.startsWith("'bash -c ''")).toBe(false);
    });

    test(`${label} — any $VAR expansion happens inside bash -c`, () => {
      if (!cmd.includes('$')) return; // absolute path, nothing to expand
      expect(cmd).toMatch(/^(bash|sh)\s+-c\s/);
    });
  }
});

/**
 * The real check: run each declared command the way the harness does and prove
 * it reaches the script. Skipped when gstack is not installed at the path the
 * commands resolve through — the boundary is sandboxed via GSTACK_HOME rather
 * than a fake HOME, because the commands find their script *through* $HOME.
 */
describe('hook command contract (spawn)', () => {
  const installed = fs.existsSync(INSTALL);

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-hookspawn-'));
  fs.writeFileSync(path.join(stateDir, 'freeze-dir.txt'), '/definitely/frozen/\n');

  for (const { file, cmd } of COMMANDS) {
    const isFreeze = cmd.includes('check-freeze');
    const label = `${file}: ${cmd.slice(0, 58)}`;

    test.if(installed)(`${label} — spawns through the harness wrapper`, () => {
      const env = { ...process.env, GSTACK_HOME: stateDir };
      delete env.CLAUDE_PLUGIN_DATA;
      delete env.CLAUDE_PLUGIN_ROOT;

      const input = JSON.stringify(
        isFreeze
          ? {
              hook_event_name: 'PreToolUse',
              tool_name: 'Edit',
              tool_input: { file_path: '/definitely/elsewhere/evil.ts' },
            }
          : {
              hook_event_name: 'PreToolUse',
              tool_name: 'Bash',
              tool_input: { command: 'echo hello' },
            },
      );

      const r =
        process.platform === 'win32'
          ? spawnSync(env.comspec || 'cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], {
              windowsVerbatimArguments: true,
              input,
              encoding: 'utf8',
              env,
            })
          : spawnSync('sh', ['-c', cmd], { input, encoding: 'utf8', env });

      const stdout = (r.stdout || '').trim();
      const stderr = (r.stderr || '').trim();

      // 127 = the command never reached the script (form 1 above).
      expect(`${r.status} ${stderr.slice(0, 120)}`).not.toMatch(/^127/);
      // exit 2 is a legitimate deny channel; otherwise 0 with JSON on stdout.
      expect([0, 2]).toContain(r.status);
      if (r.status === 0) {
        expect(() => JSON.parse(stdout)).not.toThrow();
      }
    });

    // A freeze hook that spawns but returns "allow" for an out-of-boundary path
    // is the silent fail-open (form 2) — it looks armed and blocks nothing.
    test.if(installed && isFreeze)(`${label} — actually DENIES an out-of-boundary edit`, () => {
      const env = { ...process.env, GSTACK_HOME: stateDir };
      delete env.CLAUDE_PLUGIN_DATA;
      delete env.CLAUDE_PLUGIN_ROOT;

      const input = JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: '/definitely/elsewhere/evil.ts' },
      });

      const r =
        process.platform === 'win32'
          ? spawnSync(env.comspec || 'cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], {
              windowsVerbatimArguments: true,
              input,
              encoding: 'utf8',
              env,
            })
          : spawnSync('sh', ['-c', cmd], { input, encoding: 'utf8', env });

      // Replicate the harness dispatch rule: only the nested field is acted on.
      let decision = 'allow';
      if (r.status === 2) decision = 'deny';
      else {
        try {
          const j = JSON.parse((r.stdout || '').trim());
          decision =
            j?.hookSpecificOutput?.permissionDecision ??
            (j?.decision === 'block' ? 'deny' : 'allow');
        } catch {
          decision = 'allow';
        }
      }
      expect(decision).toBe('deny');
    });
  }
});
