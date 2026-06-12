#!/usr/bin/env bun
// capture-session-event.ts — Unified handler for session lifecycle hooks
// Handles: UserPromptSubmit, EnterPlanMode, SubagentStart, SubagentStop, PreCompact, PostCompact

import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendEvent,
  type Config,
  contextHintPath,
  createSessionDoc,
  debugLog,
  detectCcVersion,
  ensureSessionRelocated,
  getProjectName,
  loadConfig,
  readAndClearEvents,
  readContextHintFull,
  upsertSessionDoc,
} from "./shared.ts"

const DEBUG_LOG = join(tmpdir(), "capture-plan-debug.log")

/** Hard ceiling on prompt text to prevent pathological payloads. */
const PROMPT_HARD_CEILING = 10_000

interface EventPayload {
  session_id: string
  hook_event_name?: string
  tool_name?: string
  cwd?: string
  /** UserPromptSubmit provides the user's prompt text via the `prompt` field. */
  prompt?: string
  /** SubagentStart may include a description. */
  description?: string
  [key: string]: unknown
}

async function main(): Promise<void> {
  try {
    const input = await Bun.stdin.text()
    const payload: EventPayload = JSON.parse(input)
    const sessionId = payload.session_id
    if (!sessionId) return

    // Load config once — used by lazy-init, prompt truncation, and flush
    const config = await loadConfig(payload.cwd)

    // Fast-path: check cached session_enabled from context hint
    // If hint is missing (SessionStart had no stdin), bootstrap lazily
    let hint = readContextHintFull(sessionId)
    if (!hint) {
      const enabled = config.session.enabled ?? false
      const ccVersion = detectCcVersion()
      hint = {
        session_id: sessionId,
        session_enabled: enabled,
        cc_version: ccVersion,
        source: "lazy-init",
      }
      writeFileSync(contextHintPath(sessionId), JSON.stringify(hint))
      debugLog(`SessionEvent: lazy-init hint for ${sessionId} enabled=${enabled}\n`, DEBUG_LOG)

      if (enabled) {
        const now = new Date().toISOString()
        const project = getProjectName(payload.cwd ?? process.cwd(), config.project_name)
        const sessionDocPath = createSessionDoc({
          sessionId,
          session: config.session,
          vault: config.vault,
          project,
          started: now,
          ccVersion,
        })
        if (sessionDocPath) {
          hint.session_doc_path = sessionDocPath
          writeFileSync(contextHintPath(sessionId), JSON.stringify(hint))
        }
        debugLog(`SessionEvent: lazy-init created session doc for ${sessionId}\n`, DEBUG_LOG)
      }
    }
    if (!hint.session_enabled) return

    const eventName = payload.hook_event_name ?? ""
    const toolName = payload.tool_name ?? ""
    const now = new Date().toISOString()

    debugLog(`SessionEvent: ${eventName} tool=${toolName}\n`, DEBUG_LOG)

    // Dispatch by event type
    if (eventName === "UserPromptSubmit") {
      const rawPrompt = payload.prompt ?? ""
      if (!rawPrompt) return

      const promptText =
        rawPrompt.length > PROMPT_HARD_CEILING
          ? `${rawPrompt.slice(0, PROMPT_HARD_CEILING)}...`
          : rawPrompt

      appendEvent(sessionId, { ts: now, type: "prompt", text: promptText })
      flushToVault(sessionId, config, payload.cwd)
      return
    }

    if (eventName === "PostToolUse" && toolName === "EnterPlanMode") {
      appendEvent(sessionId, { ts: now, type: "mode:plan" })
      // Flush: mode transition is significant
      flushToVault(sessionId, config, payload.cwd, "plan")
      return
    }

    if (eventName === "SubagentStart") {
      const desc = payload.description ?? ""
      appendEvent(sessionId, {
        ts: now,
        type: "agent:start",
        ...(desc ? { text: desc } : {}),
      })
      // Buffer only — no flush
      return
    }

    if (eventName === "SubagentStop") {
      appendEvent(sessionId, { ts: now, type: "agent:stop" })
      // Buffer only — no flush
      return
    }

    if (eventName === "PreCompact") {
      appendEvent(sessionId, { ts: now, type: "compact:pre" })
      // Buffer only — no flush
      return
    }

    if (eventName === "PostCompact") {
      appendEvent(sessionId, { ts: now, type: "compact:post" })
      // Flush: context pressure is significant
      flushToVault(sessionId, config, payload.cwd)
      return
    }

    debugLog(`SessionEvent: unhandled event ${eventName}\n`, DEBUG_LOG)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    debugLog(`SessionEvent error: ${msg}\n`, DEBUG_LOG)
  }
}

/** Flush buffered events to the vault session document. */
function flushToVault(
  sessionId: string,
  config: Config,
  cwd?: string,
  mode?: "normal" | "plan",
): void {
  const events = readAndClearEvents(sessionId)
  if (events.length === 0 && !mode) return

  const hint = readContextHintFull(sessionId)
  const project = getProjectName(cwd ?? process.cwd(), config.project_name)
  const resolvedPath = ensureSessionRelocated({
    sessionId,
    cachedDocPath: hint?.session_doc_path,
    project,
    session: config.session,
    sessionEnabled: config.session.enabled ?? false,
    vault: config.vault,
  })
  if (resolvedPath !== hint?.session_doc_path) {
    debugLog(`SessionEvent: relocated session doc to ${resolvedPath}\n`, DEBUG_LOG)
  }

  upsertSessionDoc({
    sessionId,
    session: config.session,
    vault: config.vault,
    sessionDocPath: resolvedPath,
    ...(mode ? { mode } : {}),
    events,
  })
}

main()
