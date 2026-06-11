#!/usr/bin/env bun
// capture-session-start.ts — Claude Code SessionStart Hook
// Detects context window size, writes a hint file for downstream hooks,
// and creates the initial session document in the vault.

import { writeFileSync } from "node:fs"
import { createSessionDoc } from "./lib/session-doc.ts"

import { PLUGIN_ROOT } from "./lib/types.ts"
import {
  BASES_VERSION,
  contextHintPath,
  debugLog,
  detectCcVersion,
  getProjectName,
  isFirstBasesInstall,
  loadConfig,
  parseModelContextCap,
  syncBases,
} from "./shared.ts"

const DEBUG_LOG = "/tmp/capture-plan-debug.log"

interface SessionStartPayload {
  session_id: string
  hook_event_name?: string
  source?: string
  model?: string
  cwd?: string
  transcript_path?: string
  [key: string]: unknown
}

export { parseModelContextCap } from "./lib/text.ts"
export type { ContextHint } from "./lib/types.ts"

async function main(): Promise<void> {
  let sessionEnabled = false
  let suggestBackfill = false
  try {
    const input = await Bun.stdin.text()
    const envRoot = process.env.CLAUDE_PLUGIN_ROOT ?? "unset"
    debugLog(
      `=== SESSION START ${new Date().toISOString()} ===\nstdin length=${input.length} PLUGIN_ROOT=${PLUGIN_ROOT} CLAUDE_PLUGIN_ROOT=${envRoot}\n`,
      DEBUG_LOG,
    )

    // Try to parse stdin payload (Claude Code may not send one for SessionStart)
    let payload: SessionStartPayload | undefined
    if (input.trim()) {
      try {
        payload = JSON.parse(input) as SessionStartPayload
      } catch {
        debugLog("SessionStart: stdin present but not valid JSON, ignoring\n", DEBUG_LOG)
      }
    }

    const cwd = payload?.cwd ?? process.cwd()
    const config = await loadConfig(cwd)
    debugLog(
      `SessionStart config: vault=${config.vault ?? "undefined"} session.path=${config.session.path}\n`,
      DEBUG_LOG,
    )
    sessionEnabled = config.session.enabled ?? false
    debugLog(`SessionStart session.enabled=${sessionEnabled}\n`, DEBUG_LOG)

    // Full bootstrap requires session_id from stdin — if unavailable,
    // capture-session-event.ts will lazy-init on the first real event.
    const sessionId = payload?.session_id
    if (!sessionId) {
      debugLog("SessionStart: no session_id (empty stdin), deferring bootstrap\n", DEBUG_LOG)
      return
    }

    // Try to detect context cap from model identifier (e.g., "claude-opus-4-6[1m]")
    let detectedCap: number | undefined
    if (payload?.model) {
      detectedCap = parseModelContextCap(payload.model)
      debugLog(
        `SessionStart model=${payload.model} detectedCap=${detectedCap ?? "none"}\n`,
        DEBUG_LOG,
      )
    }

    // Priority: config override > model detection
    const contextCap = config.context_cap ?? detectedCap

    const ccVersion = detectCcVersion()
    debugLog(`SessionStart cc_version=${ccVersion ?? "unknown"}\n`, DEBUG_LOG)

    const hint: ContextHint = {
      session_id: sessionId,
      context_cap: contextCap,
      model: payload?.model,
      cc_version: ccVersion,
      source: payload?.source ?? "unknown",
      session_enabled: sessionEnabled,
      transcript_path: payload?.transcript_path,
    }

    const hintFile = contextHintPath(sessionId)
    writeFileSync(hintFile, JSON.stringify(hint))
    debugLog(`Context hint written: ${hintFile} cap=${contextCap ?? "auto"}\n`, DEBUG_LOG)

    // Reconcile managed .base files with their canonical definitions (authoritative:
    // manual edits are replaced). Once per session — downstream hooks skip via the hint.
    const basesResult = syncBases(config, DEBUG_LOG)
    if (basesResult.synced) {
      hint.bases_synced = BASES_VERSION
      writeFileSync(hintFile, JSON.stringify(hint))
      if (basesResult.written.length > 0) {
        debugLog(`Bases synced: ${basesResult.written.join(", ")}\n`, DEBUG_LOG)
      }
      // First install (all bases net-new): suggest the opt-in backfill commands
      // via the SessionStart context message instead of running anything.
      suggestBackfill = isFirstBasesInstall(basesResult, config)
    }

    // Create session document in the vault if sessions are enabled
    if (sessionEnabled) {
      const now = new Date().toISOString()
      const project = getProjectName(cwd, config.project_name)

      const sessionDocPath = createSessionDoc({
        sessionId,
        session: config.session,
        vault: config.vault,
        project,
        started: now,
        model: payload?.model,
        ccVersion: ccVersion,
      })

      if (sessionDocPath) {
        hint.session_doc_path = sessionDocPath
        writeFileSync(hintFile, JSON.stringify(hint))
        debugLog(`Session doc created at ${sessionDocPath} for ${sessionId}\n`, DEBUG_LOG)
      }

      // Note: createSessionDoc already embeds the start event in the document body.
      // No need to buffer a separate start event here.
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    debugLog(`SessionStart error: ${msg}\n`, DEBUG_LOG)
  } finally {
    // Always output hookSpecificOutput so CC injects the message into session context.
    // Other working plugins (superpowers, context-mode) output unconditionally.
    const status = sessionEnabled ? "ON" : "OFF"
    const detail = sessionEnabled
      ? "Session capture is ON — events will be logged to the vault."
      : "Session capture is OFF."
    const backfillNote = suggestBackfill
      ? " Managed Obsidian bases were created for the first time. Existing notes may predate the current frontmatter standard — suggest the user run /backfill-frontmatter-estimation to scope an upgrade, then /backfill-frontmatter to apply it."
      : ""
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: detail + backfillNote,
        },
      }),
    )
    debugLog(`SessionStart output: status=${status}\n`, DEBUG_LOG)
  }
}

main()
