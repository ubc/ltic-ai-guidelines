#!/usr/bin/env node
// Claude Code hook: surface srt sandbox violations to the agent.
//
// When a Claude Code session runs inside an srt sandbox (ccx), the srt CLI
// streams denial lines to $SRT_VIOLATIONS_FILE (host-written, sandbox-
// readable). Registered twice:
//
// - SessionStart, with `--mark`: records the file's current size as the
//   read offset and prints nothing. Everything Claude Code itself denies
//   while starting up (Keychain probes, browser-profile probes, FSEvents,
//   its own state file) lands before the first tool call; without the mark
//   the first Bash command would carry that whole backlog into the agent's
//   context. Filesystem denials reach the file with ~1-2 s of log latency,
//   so a few late startup lines can still slip past the mark.
// - PostToolUse(Bash): reads any lines added since the last run and injects
//   them as additionalContext, so a command that failed due to sandbox
//   policy is explained instead of looking like a broken tool or network.
//
// Outside an srt sandbox $SRT_VIOLATIONS_FILE is unset and the hook is a
// no-op. State (read offset) lives under ~/.cache/srt-hook, which the
// sandbox can write; the violations file itself must NOT be sandbox-
// writable, so forged lines can't be injected from inside.

import { readFileSync, writeFileSync, mkdirSync, openSync, readSync, fstatSync, closeSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

const file = process.env.SRT_VIOLATIONS_FILE
if (!file) process.exit(0)
const mark = process.argv.includes('--mark')

let fd
try {
  fd = openSync(file, 'r')
} catch {
  process.exit(0)
}

try {
  const size = fstatSync(fd).size
  const stateDir = join(homedir(), '.cache', 'srt-hook')
  const offsetFile = join(stateDir, basename(file) + '.offset')

  if (mark) {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(offsetFile, String(size))
    process.exit(0)
  }

  let offset = 0
  try {
    offset = parseInt(readFileSync(offsetFile, 'utf8'), 10) || 0
  } catch {
    // No mark and no earlier run: report everything so far.
  }
  if (offset > size) offset = 0 // File was recreated; start over.
  if (size <= offset) process.exit(0)

  const buf = Buffer.alloc(size - offset)
  const read = readSync(fd, buf, 0, buf.length, offset)
  const fresh = buf.toString('utf8', 0, read).trim()

  mkdirSync(stateDir, { recursive: true })
  writeFileSync(offsetFile, String(offset + read))

  if (!fresh) process.exit(0)

  const context =
    'This session is running inside an external srt sandbox. The following ' +
    'sandbox denials were recorded since the last command — failures they ' +
    'explain are policy blocks, not tool or network errors, so do not ' +
    'retry the same access; use the suggested alternative or a different ' +
    'approach:\n<sandbox_violations>\n' +
    fresh +
    '\n</sandbox_violations>'

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: context,
      },
    }),
  )
} finally {
  closeSync(fd)
}
