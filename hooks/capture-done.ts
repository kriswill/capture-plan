#!/usr/bin/env bun
// capture-done.ts — Claude Code Stop Hook
// Captures the "Done" summary after plan execution completes

import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { DONE_SYSTEM_PROMPT, PLAN_SYSTEM_PROMPT, SKILL_SYSTEM_PROMPT } from "./lib/prompts.ts"
import { IS_DEV_MODE, isDevSessionInPluginRepo, PLUGIN_ROOT } from "./lib/types.ts"
import {
  appendEvent,
  appendOrCreateCallout,
  type Config,
  createVaultNote,
  debugLog,
  deleteVaultState,
  detectCcVersion,
  ensureSessionRelocated,
  extractTitle,
  findTranscriptPath,
  formatCcVersionYaml,
  formatDuration,
  formatJournalRevision,
  formatModelLabel,
  formatModelYaml,
  formatSessionYaml,
  formatStopText,
  formatTagsYaml,
  formatToolsLogContent,
  formatToolsNoteContent,
  getDateParts,
  getDayName,
  getJournalPath,
  getPlanDatePath,
  getProjectName,
  getSkillDatePath,
  getVaultPath,
  loadConfig,
  mergeTags,
  nextCounter,
  padCounter,
  readAndClearEvents,
  readContextHintFull,
  resolveContextCap,
  resolveVaultState,
  type SessionState,
  stripTitleLine,
  summarizeWithClaude,
  toSlug,
  updateContextHint,
  updateJournalFrontmatter,
  upsertSessionDoc,
  writeVaultState,
} from "./shared.ts"
import {
  collectExecutionStats,
  collectToolLog,
  collectTranscriptStats,
  computeDurationMs,
  filterSkillInvocations,
  findExitPlanIndex,
  findLastUserPromptIndex,
  findSkillInvocations,
  findSuperpowersBoundary,
  findSuperpowersWrites,
  hasExecutionAfter,
  parseTranscriptFromString,
  type SkillInvocation,
  type SuperpowersWrite,
  selectDoneText,
  type TranscriptEntry,
  type TranscriptStats,
  transcriptContainsPatternInString,
} from "./transcript.ts"

const DEBUG_LOG = join(tmpdir(), "capture-done-debug.log")
const MIN_DONE_LENGTH = 50

interface StopPayload {
  session_id: string
  hook_event_name?: string
  cwd?: string
  transcript_path?: string
  last_assistant_message?: string
  [key: string]: unknown
}

/** Build a SessionState on the fly for a superpowers session, creating the plan vault note. */
async function buildSuperpowersState(
  sessionId: string,
  writes: SuperpowersWrite[],
  entries: TranscriptEntry[],
  payload: StopPayload,
  config: Config,
  sessionDocPath?: string,
): Promise<{ state: SessionState; boundaryIdx: number } | null> {
  // Pick primary: prefer plan over spec
  const plans = writes.filter((w) => w.type === "plan")
  const primary = plans.length > 0 ? plans[plans.length - 1] : writes[writes.length - 1]
  const specs = writes.filter((w) => w.type === "spec")

  const planContent = primary.content
  if (!planContent || planContent.length < 20) return null

  const title = extractTitle(planContent)
  const slug = toSlug(title)
  const dateParts = getDateParts()
  const { dateKey, datetime, ampmTime } = dateParts
  const dateDirRelative = getPlanDatePath(config, dateParts)

  const counter = nextCounter(dateDirRelative, config.vault)

  const { summary, tags: newTags } = await summarizeWithClaude(planContent, PLAN_SYSTEM_PROMPT)
  const planDir = `${dateDirRelative}/${padCounter(counter)}-${slug}`
  const planPath = `${planDir}/plan`
  const journalPath = getJournalPath(config)
  const project = getProjectName(payload.cwd, config.project_name)
  const tagsYaml = formatTagsYaml(newTags)

  // Collect planning-phase stats
  const boundaryIdx = findSuperpowersBoundary(writes)
  let planStats: TranscriptStats | null = null
  try {
    if (boundaryIdx >= 0) {
      planStats = collectTranscriptStats(entries, 0, boundaryIdx)
    }
  } catch {
    /* ignore */
  }

  const contextCap = resolveContextCap(
    planStats?.peakTurnContext ?? 0,
    config.context_cap,
    sessionId,
  )
  const modelYaml = formatModelYaml(planStats, contextCap)
  const spHint = readContextHintFull(sessionId)
  const ccVersion = detectCcVersion() ?? spHint?.cc_version
  const ccVersionYaml = formatCcVersionYaml(ccVersion)

  const spSessionYaml = formatSessionYaml(
    sessionId,
    config.session.enabled ?? false,
    config.session.path,
    sessionDocPath ?? spHint?.session_doc_path,
  )

  const noteContent = `---
created: "[[${journalPath}|${datetime}]]"${project ? `\nproject: ${project}` : ""}${tagsYaml ? `\ntags:\n${tagsYaml}` : ""}${spSessionYaml}${ccVersionYaml}${modelYaml}
source: superpowers${primary.filePath ? `\nspec_file: "${primary.filePath}"` : ""}
---
# ${title}

${stripTitleLine(planContent)}
`

  const createResult = createVaultNote(planPath, noteContent, config.vault)
  if (!createResult.success) {
    debugLog(
      `Failed to create superpowers plan note: stdout=${createResult.stdout} stderr=${createResult.stderr}\n`,
      DEBUG_LOG,
    )
    return null
  }

  // If there's a separate spec, create it as a sibling note
  if (specs.length > 0 && specs[specs.length - 1] !== primary) {
    const spec = specs[specs.length - 1]
    const specTitle = extractTitle(spec.content)
    const specNoteContent = `---
created: "[[${journalPath}|${datetime}]]"${project ? `\nproject: ${project}` : ""}
plan: "[[${planPath}|${title}]]"
source: superpowers
---
# ${specTitle}

${stripTitleLine(spec.content)}
`
    createVaultNote(`${planDir}/spec`, specNoteContent, config.vault)
  }

  // Build journal callout revision and append (grouping by title)
  const spModelLabel = formatModelLabel(planStats?.model, contextCap)
  const spRevision = formatJournalRevision(
    ampmTime,
    planPath,
    "plan",
    spModelLabel,
    summary,
    newTags,
  )
  const spVaultPath = getVaultPath(config.vault)
  await appendOrCreateCallout(
    title,
    spRevision,
    project,
    "superpowers",
    journalPath,
    spVaultPath,
    config.vault,
  )

  updateJournalFrontmatter(
    journalPath,
    { date: dateKey, day: getDayName(), project, tags: newTags },
    config.vault,
  )

  const state: SessionState = {
    session_id: sessionId,
    plan_slug: slug,
    plan_title: title,
    plan_dir: planDir,
    date_key: dateKey,
    timestamp: new Date().toISOString(),
    journal_path: journalPath,
    project,
    tags: newTags,
    model: planStats?.model,
    cc_version: ccVersion,
    planStats: planStats ?? undefined,
    source: "superpowers",
    spec_path: primary.filePath,
  }

  writeVaultState(state, config.vault)
  debugLog(`Superpowers state built: ${title} -> ${planPath}\n`, DEBUG_LOG)
  return { state, boundaryIdx }
}

/** Build a SessionState on the fly for a skill-only session, creating the activity vault note. */
async function buildSkillState(
  sessionId: string,
  invocations: SkillInvocation[],
  entries: TranscriptEntry[],
  payload: StopPayload,
  config: Config,
  sessionDocPath?: string,
): Promise<{ state: SessionState; boundaryIdx: number } | null> {
  if (invocations.length === 0) return null

  // Build narrative from all skill invocations' surrounding context
  const narrative = invocations
    .map((inv) => {
      const parts = [inv.contextBefore, inv.contextAfter].filter(Boolean)
      return parts.join("\n")
    })
    .filter(Boolean)
    .join("\n\n")

  if (narrative.length < 20) return null

  // Summarize with Haiku to get title and tags
  const { summary, tags: newTags } = await summarizeWithClaude(narrative, SKILL_SYSTEM_PROMPT)

  // Use Haiku summary as title, truncated to first sentence or 80 chars
  const rawTitle = extractTitle(summary) || `${invocations[0].skill} session`
  const title = rawTitle.length > 80 ? `${rawTitle.slice(0, 77)}...` : rawTitle
  const slug = toSlug(title)
  const dateParts = getDateParts()
  const { dateKey, datetime, ampmTime } = dateParts
  const dateDirRelative = getSkillDatePath(config, dateParts)

  const counter = nextCounter(dateDirRelative, config.vault)

  const planDir = `${dateDirRelative}/${padCounter(counter)}-${slug}`
  const activityPath = `${planDir}/activity`
  const journalPath = getJournalPath(config)
  const project = getProjectName(payload.cwd, config.project_name)
  const tagsYaml = formatTagsYaml(newTags)

  // Use first skill invocation as boundary
  const boundaryIdx = invocations[0].index

  // Collect planning-phase stats (everything before the first skill)
  let planStats: TranscriptStats | null = null
  try {
    if (boundaryIdx > 0) {
      planStats = collectTranscriptStats(entries, 0, boundaryIdx)
    }
  } catch {
    /* ignore */
  }

  const contextCap = resolveContextCap(
    planStats?.peakTurnContext ?? 0,
    config.context_cap,
    sessionId,
  )
  const modelYaml = formatModelYaml(planStats, contextCap)
  const skillHint = readContextHintFull(sessionId)
  const ccVersion = detectCcVersion() ?? skillHint?.cc_version
  const ccVersionYaml = formatCcVersionYaml(ccVersion)

  // Build skills YAML list
  const skillNames = invocations.map((inv) => inv.skill)
  const uniqueSkills = [...new Set(skillNames)]
  const skillsYaml = uniqueSkills.map((s) => `  - ${s}`).join("\n")

  // Build skills table
  const skillsTable = invocations
    .map((inv) => {
      const ts = entries[inv.index]?.timestamp
      const time = ts
        ? new Date(ts).toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          })
        : "—"
      return `| ${time} | ${inv.skill} | ${inv.args ?? "—"} |`
    })
    .join("\n")

  // Build context section from surrounding text
  const contextText = invocations
    .map((inv) => {
      const parts: string[] = []
      if (inv.contextBefore) parts.push(inv.contextBefore)
      if (inv.contextAfter) parts.push(inv.contextAfter)
      return parts.join("\n\n")
    })
    .filter(Boolean)
    .join("\n\n---\n\n")

  const skillSessionYaml = formatSessionYaml(
    sessionId,
    config.session.enabled ?? false,
    config.session.path,
    sessionDocPath ?? skillHint?.session_doc_path,
  )

  const noteContent = `---
created: "[[${journalPath}|${datetime}]]"${project ? `\nproject: ${project}` : ""}${tagsYaml ? `\ntags:\n${tagsYaml}` : ""}${skillSessionYaml}${ccVersionYaml}${modelYaml}
source: skill
skills:
${skillsYaml}
---
# ${title}

## Skills Used

| Time | Skill | Args |
|------|-------|------|
${skillsTable}

## Context

${contextText || "_No context captured_"}
`

  const createResult = createVaultNote(activityPath, noteContent, config.vault)
  if (!createResult.success) {
    debugLog(
      `Failed to create skill activity note: stdout=${createResult.stdout} stderr=${createResult.stderr}\n`,
      DEBUG_LOG,
    )
    return null
  }

  // Build journal callout revision and append (grouping by title)
  const skillModelLabel = formatModelLabel(planStats?.model, contextCap)
  const skillRevision = formatJournalRevision(
    ampmTime,
    activityPath,
    "activity",
    skillModelLabel,
    summary,
    newTags,
  )
  const skillVaultPath = getVaultPath(config.vault)
  await appendOrCreateCallout(
    title,
    skillRevision,
    project,
    "skill",
    journalPath,
    skillVaultPath,
    config.vault,
  )

  updateJournalFrontmatter(
    journalPath,
    { date: dateKey, day: getDayName(), project, tags: newTags },
    config.vault,
  )

  const state: SessionState = {
    session_id: sessionId,
    plan_slug: slug,
    plan_title: title,
    plan_dir: planDir,
    date_key: dateKey,
    timestamp: new Date().toISOString(),
    journal_path: journalPath,
    project,
    tags: newTags,
    model: planStats?.model,
    cc_version: ccVersion,
    planStats: planStats ?? undefined,
    source: "skill",
    skill_name: uniqueSkills.join(","),
  }

  writeVaultState(state, config.vault)
  debugLog(`Skill state built: ${title} -> ${activityPath}\n`, DEBUG_LOG)
  return { state, boundaryIdx }
}

async function main(): Promise<void> {
  console.error("[capture-done] hook invoked")
  try {
    const input = await Bun.stdin.text()
    debugLog(`=== STOP ${new Date().toISOString()} ===\n${input}\n---\n`, DEBUG_LOG)

    const payload: StopPayload = JSON.parse(input)
    const sessionId = payload.session_id
    if (!sessionId) {
      debugLog("No session_id in payload\n", DEBUG_LOG)
      process.exit(0)
    }

    // Load config early — needed for vault-based state lookup
    const config = await loadConfig(payload.cwd)

    // Capture stop timestamp and last assistant message early — used on all exit paths
    const stopTs = new Date().toISOString()
    const lastMessage = payload.last_assistant_message?.trim() || undefined

    const mainHint = readContextHintFull(sessionId)
    const stopProject = getProjectName(payload.cwd, config.project_name)
    const cachedSessionDocPath = ensureSessionRelocated({
      sessionId,
      cachedDocPath: mainHint?.session_doc_path,
      project: stopProject,
      session: config.session,
      sessionEnabled: config.session.enabled ?? false,
      vault: config.vault,
    })

    /** Append a stop event and flush buffered session events to the vault doc. Called on early-exit paths (the happy path builds an enriched stop event separately). */
    const flushEvents = (opts?: { text?: string; message?: string }): void => {
      if (!(config.session.enabled ?? false)) return
      appendEvent(sessionId, { ts: stopTs, type: "stop", ...opts })
      const events = readAndClearEvents(sessionId)
      if (events.length === 0) return
      upsertSessionDoc({
        sessionId,
        session: config.session,
        vault: config.vault,
        sessionDocPath: cachedSessionDocPath,
        events,
      })
    }

    /** Delete the vault state file and clear the plan_dir hint so subsequent stops skip the vault scan. */
    const consumeVaultState = (planDir: string): void => {
      deleteVaultState(planDir, config.vault)
      updateContextHint(sessionId, { plan_dir: undefined })
    }

    // Find transcript early — needed for both plan-mode and superpowers paths
    let transcriptPath = payload.transcript_path || null
    if (!transcriptPath) {
      transcriptPath = findTranscriptPath(sessionId, payload.cwd)
    }

    // Resolve vault filesystem path (used for state cleanup and journal appends)
    const vaultPath = getVaultPath(config.vault)

    // Gate: look up pending session state via hint (fast path) or vault scan (fallback)
    let state: SessionState | null = resolveVaultState(sessionId, mainHint, config)
    let boundaryIdx = -1
    let entries: TranscriptEntry[] = []
    let isSuperpowers = false

    if (state) {
      debugLog(`Found state for session ${sessionId}: ${state.plan_title}\n`, DEBUG_LOG)

      if (!transcriptPath) {
        debugLog("Cannot find transcript, keeping state for retry\n", DEBUG_LOG)
        flushEvents({ message: lastMessage })
        process.exit(0)
      }

      entries = parseTranscriptFromString(readFileSync(transcriptPath, "utf8"))

      if (state.source === "superpowers") {
        // State was written by a prior superpowers capture — find boundary from transcript
        isSuperpowers = true
        const spWrites = findSuperpowersWrites(
          entries,
          config.superpowers_spec_pattern,
          config.superpowers_plan_pattern,
        )
        boundaryIdx = findSuperpowersBoundary(spWrites)
      } else if (state.source === "skill") {
        // State was written by skill capture — find boundary from skill invocations
        const skillInvocations = findSkillInvocations(entries)
        boundaryIdx = skillInvocations.length > 0 ? skillInvocations[0].index : -1
      } else {
        boundaryIdx = findExitPlanIndex(entries)
      }

      if (boundaryIdx === -1) {
        debugLog("No plan boundary found in transcript\n", DEBUG_LOG)
        consumeVaultState(state.plan_dir)
        flushEvents({ message: lastMessage })
        process.exit(0)
      }
    } else {
      // No state — cheap pre-check before full transcript parse (single file read)
      if (!transcriptPath) {
        flushEvents({ message: lastMessage })
        process.exit(0)
      }

      const rawTranscript = readFileSync(transcriptPath, "utf8")
      const specPat = config.superpowers_spec_pattern || "/superpowers/specs/"
      const planPat = config.superpowers_plan_pattern || "/superpowers/plans/"
      const hasSuperpowers = transcriptContainsPatternInString(rawTranscript, [specPat, planPat])
      const hasSkills = transcriptContainsPatternInString(rawTranscript, [
        '"Skill"',
        "<command-name>",
      ])

      if (!hasSuperpowers && !hasSkills) {
        // Compute per-cycle stats for the stop event
        const cycleEntries = parseTranscriptFromString(rawTranscript)
        const cycleStart = findLastUserPromptIndex(cycleEntries)
        let cycleTurns = 0
        for (let i = cycleStart; i < cycleEntries.length; i++) {
          if (cycleEntries[i].type === "assistant" && !cycleEntries[i].isSidechain) cycleTurns++
        }
        let cycleStats: TranscriptStats | null = null
        try {
          cycleStats = collectTranscriptStats(cycleEntries, cycleStart)
        } catch {
          /* ignore */
        }
        const stopText = formatStopText({
          durationMs: cycleStats?.durationMs,
          turns: cycleTurns,
          totalToolCalls: cycleStats?.totalToolCalls,
          mcpServerCount: cycleStats?.mcpServers.length,
        })
        flushEvents({ text: stopText, message: lastMessage })
        process.exit(0)
      }

      entries = parseTranscriptFromString(rawTranscript)

      if (hasSuperpowers) {
        const spWrites = findSuperpowersWrites(entries, specPat, planPat)
        if (spWrites.length === 0 && !hasSkills) {
          flushEvents({ message: lastMessage })
          process.exit(0)
        }

        if (spWrites.length > 0) {
          isSuperpowers = true
          debugLog(`Superpowers session detected: ${spWrites.length} spec/plan writes\n`, DEBUG_LOG)

          const result = await buildSuperpowersState(
            sessionId,
            spWrites,
            entries,
            payload,
            config,
            cachedSessionDocPath,
          )
          if (!result) {
            debugLog("Failed to build superpowers state\n", DEBUG_LOG)
            flushEvents({ message: lastMessage })
            process.exit(0)
          }

          state = result.state
          boundaryIdx = result.boundaryIdx
        }
      }

      // Skill-only session (no superpowers state was built above)
      if (!state && hasSkills) {
        if (isDevSessionInPluginRepo(payload.cwd, PLUGIN_ROOT, IS_DEV_MODE)) {
          debugLog("Dev session in plugin repo, skipping skill-only capture\n", DEBUG_LOG)
          flushEvents({ message: lastMessage })
          process.exit(0)
        }

        const skillInvocations = filterSkillInvocations(
          findSkillInvocations(entries),
          config.capture_skills,
        )
        if (skillInvocations.length === 0) {
          flushEvents({ message: lastMessage })
          process.exit(0)
        }

        debugLog(
          `Skill session detected: ${skillInvocations.map((s) => s.skill).join(", ")}\n`,
          DEBUG_LOG,
        )

        const result = await buildSkillState(
          sessionId,
          skillInvocations,
          entries,
          payload,
          config,
          cachedSessionDocPath,
        )
        if (!result) {
          debugLog("Failed to build skill state\n", DEBUG_LOG)
          flushEvents({ message: lastMessage })
          process.exit(0)
        }

        state = result.state
        boundaryIdx = result.boundaryIdx
      }

      if (!state) {
        flushEvents({ message: lastMessage })
        process.exit(0)
      }
    }

    // Check for execution activity after the planning boundary
    if (!hasExecutionAfter(entries, boundaryIdx) && state.source !== "skill") {
      debugLog("No execution tools after plan boundary, waiting for next Stop\n", DEBUG_LOG)
      if (!isSuperpowers) {
        // For plan-mode, keep state for retry. For superpowers, state is ephemeral.
        flushEvents({ message: lastMessage })
        process.exit(0)
      }
      // Superpowers: still capture the plan note even without execution
      // (state was already created with vault note in buildSuperpowersState)
      consumeVaultState(state.plan_dir)
      flushEvents({ message: lastMessage })
      process.exit(0)
    }

    // Collect execution stats from transcript
    const stats = collectExecutionStats(entries, boundaryIdx)

    // Collect detailed transcript stats for the execution phase
    let transcriptStats: TranscriptStats | null = null
    try {
      transcriptStats = collectTranscriptStats(entries, boundaryIdx)
      debugLog(
        `Execution stats: ${transcriptStats.totalToolCalls} tool calls, model=${transcriptStats.model}\n`,
        DEBUG_LOG,
      )
    } catch (err) {
      debugLog(`Failed to collect transcript stats: ${err}\n`, DEBUG_LOG)
    }

    // Use payload's last_assistant_message as fallback when transcript text is short
    const payloadMessage = payload.last_assistant_message ?? ""
    const narrativeText =
      stats.allAssistantText.length >= MIN_DONE_LENGTH
        ? stats.allAssistantText
        : payloadMessage.length >= MIN_DONE_LENGTH
          ? payloadMessage
          : stats.allAssistantText || payloadMessage

    if (narrativeText.length < MIN_DONE_LENGTH) {
      debugLog(
        `Done text too short (transcript=${stats.allAssistantText.length}, payload=${payloadMessage.length} chars), keeping state for retry\n`,
        DEBUG_LOG,
      )
      flushEvents({ message: lastMessage })
      process.exit(0) // Keep state — next Stop event can retry
    }

    debugLog(
      `Done text extracted (transcript=${stats.allAssistantText.length}, payload=${payloadMessage.length} chars, using ${stats.allAssistantText.length >= MIN_DONE_LENGTH ? "transcript" : "payload"})\n`,
      DEBUG_LOG,
    )

    // Calculate session duration — prefer transcript timestamps (full session) over wall-clock
    const transcriptDurationMs = computeDurationMs(entries)
    const wallClockMs = Date.now() - new Date(state.timestamp).getTime()
    const durationMs = transcriptDurationMs > 0 ? transcriptDurationMs : wallClockMs
    const duration = formatDuration(durationMs)

    // Build richer context for Haiku summarization
    // Put narrative first so that if Haiku fails, the fallback extracts from the narrative
    // rather than echoing the structured metadata header
    const MAX_HAIKU_INPUT = 8000
    const metadata = [
      `Plan: ${state.plan_title}`,
      `Duration: ${duration}`,
      `Files changed (${stats.filesChanged.length}): ${stats.filesChanged.map((f) => basename(f)).join(", ")}`,
    ].join(" | ")
    let haikuInput = `${metadata}\n\n${narrativeText}`
    if (haikuInput.length > MAX_HAIKU_INPUT) {
      // Truncate from the front of the narrative, keeping the most recent text
      haikuInput = `${metadata}\n\n${narrativeText.slice(-(MAX_HAIKU_INPUT - metadata.length - 2))}`
    }

    // Summarize with Haiku
    const { summary, tags: newTags } = await summarizeWithClaude(haikuInput, DONE_SYSTEM_PROMPT)

    // Select the richest available text for the Summary section body
    const doneText = selectDoneText(payloadMessage, stats, summary)

    // Build the summary note
    const { datetime, ampmTime } = getDateParts()
    const journalPath = getJournalPath(config)

    const summaryPath = `${state.plan_dir}/summary`

    const project = state.project || getProjectName(payload.cwd, config.project_name)
    const planTags = state.tags
      ? state.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : []
    const combinedTagsCsv = mergeTags(planTags, newTags)
    const tagsYaml = formatTagsYaml(combinedTagsCsv)

    const fileList =
      stats.filesChanged.length > 0
        ? stats.filesChanged.map((f) => `- \`${f}\``).join("\n")
        : "_No file changes recorded_"

    const contextCap = resolveContextCap(
      transcriptStats?.peakTurnContext ?? 0,
      config.context_cap,
      sessionId,
    )
    const modelYaml = formatModelYaml(transcriptStats, contextCap)
    const ccVersion = state.cc_version ?? mainHint?.cc_version
    const ccVersionYaml = formatCcVersionYaml(ccVersion)

    const noteContent = `---
created: "[[${journalPath}|${datetime}]]"${project ? `\nproject: ${project}` : ""}${tagsYaml ? `\ntags:\n${tagsYaml}` : ""}
plan: "[[${state.plan_dir}/${state.source === "skill" ? "activity" : "plan"}|${state.plan_title.replace(/"/g, '\\"')}]]"
duration: "${duration}"${ccVersionYaml}${modelYaml}
---
# Done: ${state.plan_title}

## Summary

${doneText}

## Files Changed

${fileList}

---
*Duration: ${duration}*
`

    const createResult = createVaultNote(summaryPath, noteContent, config.vault)
    if (!createResult.success) {
      debugLog(
        `Failed to create summary note: stdout=${createResult.stdout} stderr=${createResult.stderr}\n`,
        DEBUG_LOG,
      )
      consumeVaultState(state.plan_dir)
      flushEvents({ message: lastMessage })
      process.exit(0)
    }

    // Detect skill invocations once — reused for mixed-session notes and stop stats
    const skillInvocations = findSkillInvocations(entries)

    // Create per-skill activity notes for mixed sessions (plan + skills)
    if (state.source !== "skill" && skillInvocations.length > 0) {
      debugLog(
        `Mixed session: ${skillInvocations.length} skill(s) detected alongside ${state.source}\n`,
        DEBUG_LOG,
      )

      const skillCounts = new Map<string, number>()
      for (const inv of skillInvocations) {
        const count = skillCounts.get(inv.skill) ?? 0
        skillCounts.set(inv.skill, count + 1)
        const suffix = count > 0 ? `-${count + 1}` : ""
        const skillNotePath = `${state.plan_dir}/${inv.skill}${suffix}`
        const contextText = [inv.contextBefore, inv.contextAfter].filter(Boolean).join("\n\n")
        const skillNoteContent = `---
created: "[[${journalPath}|${datetime}]]"
plan: "[[${state.plan_dir}/plan|${state.plan_title.replace(/"/g, '\\"')}]]"
source: skill
skill: ${inv.skill}
---
# ${inv.skill}

${contextText || "_No context captured_"}
`
        const skillResult = createVaultNote(skillNotePath, skillNoteContent, config.vault)
        if (!skillResult.success) {
          debugLog(
            `Failed to create skill note: ${skillNotePath} stdout=${skillResult.stdout} stderr=${skillResult.stderr}\n`,
            DEBUG_LOG,
          )
        } else {
          debugLog(`Skill note captured -> ${skillNotePath}.md\n`, DEBUG_LOG)
        }
      }
    }

    // Create tools-stats.md with combined stats from both phases
    const planStats = state.planStats ?? null
    const toolsNoteContent = formatToolsNoteContent({
      planStats,
      execStats: transcriptStats,
      planTitle: state.plan_title,
      planDir: state.plan_dir,
      journalPath,
      datetime,
      project,
      contextCap,
      ccVersion,
    })

    if (toolsNoteContent) {
      const toolsNotePath = `${state.plan_dir}/tools-stats`
      const toolsResult = createVaultNote(toolsNotePath, toolsNoteContent, config.vault)
      if (!toolsResult.success) {
        debugLog(
          `Failed to create tools-stats note: stdout=${toolsResult.stdout} stderr=${toolsResult.stderr}\n`,
          DEBUG_LOG,
        )
      } else {
        debugLog(`Tools stats captured -> ${toolsNotePath}.md\n`, DEBUG_LOG)
      }
    }

    // Create tools-log.md with chronological tool use log
    const planLog = planStats ? collectToolLog(entries, 0, boundaryIdx) : null
    const execLog = transcriptStats ? collectToolLog(entries, boundaryIdx) : null

    const toolsLogResult = formatToolsLogContent({
      planLog,
      execLog,
      planTitle: state.plan_title,
      planDir: state.plan_dir,
      journalPath,
      datetime,
      project,
      contextCap,
      ccVersion,
      model: transcriptStats?.model ?? planStats?.model,
    })

    if (toolsLogResult) {
      // Create agent prompt files
      for (const agentFile of toolsLogResult.agentFiles) {
        const result = createVaultNote(agentFile.path, agentFile.content, config.vault)
        if (!result.success) {
          debugLog(
            `Failed to create agent file: ${agentFile.path} stdout=${result.stdout} stderr=${result.stderr}\n`,
            DEBUG_LOG,
          )
        } else {
          debugLog(`Agent prompt captured -> ${agentFile.path}.md\n`, DEBUG_LOG)
        }
      }

      // Create tools-log.md
      const toolsLogPath = `${state.plan_dir}/tools-log`
      const logResult = createVaultNote(toolsLogPath, toolsLogResult.markdown, config.vault)
      if (!logResult.success) {
        debugLog(
          `Failed to create tools-log note: stdout=${logResult.stdout} stderr=${logResult.stderr}\n`,
          DEBUG_LOG,
        )
      } else {
        debugLog(`Tools log captured -> ${toolsLogPath}.md\n`, DEBUG_LOG)
      }
    }

    // Append summary revision to existing plan callout in journal
    const doneModelLabel = formatModelLabel(transcriptStats?.model, contextCap)
    const doneRevision = formatJournalRevision(
      ampmTime,
      summaryPath,
      "done",
      doneModelLabel,
      summary,
      newTags,
    )
    const journalToModify = state.journal_path || journalPath
    await appendOrCreateCallout(
      state.plan_title,
      doneRevision,
      project,
      state.source || "plan-mode",
      journalToModify,
      vaultPath,
      config.vault,
      journalPath,
    )

    updateJournalFrontmatter(
      journalPath,
      { date: state.date_key, day: getDayName(), project, tags: newTags },
      config.vault,
    )

    // Build enriched stop event with execution stats
    let turnCount = 0
    for (let i = boundaryIdx; i < entries.length; i++) {
      if (entries[i].type === "assistant" && !entries[i].isSidechain) turnCount++
    }
    const stopText = formatStopText({
      durationMs: transcriptStats?.durationMs,
      turns: turnCount,
      totalToolCalls: transcriptStats?.totalToolCalls,
      mcpServerCount: transcriptStats?.mcpServers.length,
      skillCount: skillInvocations.length,
    })
    appendEvent(sessionId, {
      ts: stopTs,
      type: "stop",
      ...(stopText ? { text: stopText } : {}),
      ...(lastMessage ? { message: lastMessage } : {}),
    })

    // Create/update session document with all back-links and flush buffered events
    const planNoteName = state.source === "skill" ? "activity" : "plan"
    const pendingEvents = readAndClearEvents(sessionId)
    upsertSessionDoc({
      sessionId,
      session: config.session,
      vault: config.vault,
      project,
      sessionDocPath: cachedSessionDocPath,
      summaries: [{ path: summaryPath, title: `Done: ${state.plan_title}` }],
      ...(toolsNoteContent
        ? {
            toolsStats: [
              {
                path: `${state.plan_dir}/tools-stats`,
                title: `Session Tools: ${state.plan_title}`,
              },
            ],
          }
        : {}),
      ...(toolsLogResult
        ? {
            toolsLogs: [
              { path: `${state.plan_dir}/tools-log`, title: `Tool Log: ${state.plan_title}` },
            ],
          }
        : {}),
      ...(state.source === "skill"
        ? { activities: [{ path: `${state.plan_dir}/${planNoteName}`, title: state.plan_title }] }
        : { plans: [{ path: `${state.plan_dir}/${planNoteName}`, title: state.plan_title }] }),
      events: pendingEvents,
    })

    // Clean up session state from vault
    consumeVaultState(state.plan_dir)

    console.error(`Done summary captured -> ${summaryPath}.md`)
    debugLog(`Summary captured for ${state.plan_title}\n`, DEBUG_LOG)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[capture-done] Fatal error: ${msg}`)
    debugLog(`Fatal error: ${err}\n`, DEBUG_LOG)
  }

  process.exit(0)
}

main()
