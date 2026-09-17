import { defaultOrgPolicy, evaluateCommand } from '../vendor/qm/command-policy.ts';
import type { PermissionDecision } from '../jcode/protocol.ts';

/**
 * Shell gate (TODO §0.3 absorb + §9 enforcement): the vendored hard-deny
 * list applied to shell text an agent wants to run.
 *
 * Mapping for agents (humans are not in this path): `deny` stays deny;
 * `require_approval` is also deny, because an agent has no one to approve
 * it — "needs approval" for an agent means a human must take the keyboard.
 * The value over a blanket deny is the *reason*: the matched rule names
 * exactly what was wrong, and it is a logged Ledger event either way.
 */

export interface ShellScreen {
  decision: PermissionDecision;
  reason: string;
  actionClass: string;
  matched?: string;
}

const SHELL_TOOLS = new Set(['bash', 'sh', 'shell', 'exec', 'run_command']);

export function isShellTool(toolName: string): boolean {
  return SHELL_TOOLS.has(toolName);
}

/** Screen shell text. `command` is the literal text; empty text is refused, not waved through. */
export function screenShellCommand(command: string): ShellScreen {
  if (!command.trim()) {
    return {
      decision: 'deny',
      reason: 'empty shell command is refused, not waved through',
      actionClass: 'ACT_IRREVERSIBLE',
    };
  }
  const ev = evaluateCommand(command, defaultOrgPolicy());
  if (ev.decision === 'deny') {
    return {
      decision: 'deny',
      reason: `hard-deny: ${ev.reason ?? 'forbidden command'}${ev.matched ? ` (matched "${ev.matched}")` : ''}`,
      actionClass: 'ACT_IRREVERSIBLE',
      matched: ev.matched,
    };
  }
  if (ev.decision === 'require_approval') {
    return {
      decision: 'deny',
      reason: `tool requires human approval; agents may not self-approve (${ev.reason ?? 'approval-gated command'})`,
      actionClass: 'ACT_IRREVERSIBLE',
      matched: ev.matched,
    };
  }
  return { decision: 'allow', reason: 'no hard-deny rule matched', actionClass: 'READ' };
}
