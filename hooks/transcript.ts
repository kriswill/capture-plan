// transcript.ts — Transcript parsing utilities for capture-done hook

import { readFileSync } from "node:fs"

/** A single content block within a transcript message (text, tool_use, or tool_result). */
export interface ContentBlock {
  type: string
  text?: string
  name?: string
  id?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  is_error?: boolean
  content?: string | ContentBlock[]
}

/** A single line from the JSONL transcript, representing one assistant or human turn. */
export interface TranscriptEntry {
  type: string
  timestamp?: string
  isSidechain?: boolean
  agentId?: string
  model?: string
  message?: {
    role?: string
    model?: string
    content?: string | ContentBlock[]
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
  [key: string]: unknown
}

/** Aggregated token counts across input, output, and cache dimensions. */
export interface TokenUsage {
  input: number
  output: number
  cache_read: number
  cache_create: number
}

/** Summary of a single tool's usage: total calls and error count. */
export interface ToolUseRecord {
  name: string
  calls: number
  errors: number
}

/** Summary of an MCP server's participation: tools used and total call count. */
export interface McpServerInfo {
  name: string
  tools: string[]
  calls: number
}

/** A single tool invocation within a turn, with its sequence number and input arguments. */
export interface ToolLogEntry {
  seq: number
  name: string
  input: Record<string, unknown>
  isError: boolean
  blockId?: string
  /** User's chosen answer from the tool_result content (populated for AskUserQuestion). */
  answer?: string
}

/** A full assistant turn in the tool log: timestamp, tokens, justification text, and tool calls. */
export interface TurnLogEntry {
  turnNumber: number
  timestamp: string
  durationMs: number
  tokensIn: number
  tokensOut: number
  justification: string
  tools: ToolLogEntry[]
  isSidechain: boolean
  agentId?: string
}

/** Chronological log of all tool-using turns with aggregate call and error counts. */
export interface ToolLog {
  turns: TurnLogEntry[]
  totalToolCalls: number
  totalErrors: number
}

/** Aggregate statistics for a transcript range: model, duration, tokens, tools, and MCP servers. */
export interface TranscriptStats {
  model: string
  durationMs: number
  tokens: TokenUsage
  peakTurnContext: number
  subagentCount: number
  tools: ToolUseRecord[]
  mcpServers: McpServerInfo[]
  totalToolCalls: number
  totalErrors: number
}

/** Tool names that indicate real execution activity (not just read-only exploration). */
export const EXECUTION_TOOLS = new Set(["Edit", "Write", "Bash", "NotebookEdit", "MultiEdit"])

/** Extract the content blocks array from an assistant transcript entry. */
export function getContentBlocks(entry: TranscriptEntry): ContentBlock[] {
  if (entry.type !== "assistant") return []
  const content = entry.message?.content
  if (!Array.isArray(content)) return []
  return content
}

/** Check whether a transcript file's raw text contains any of the given substrings. Avoids full JSONL parse. */
export function transcriptContainsPattern(transcriptPath: string, patterns: string[]): boolean {
  const raw = readFileSync(transcriptPath, "utf8")
  return patterns.some((p) => raw.includes(p))
}

/** Check whether a raw transcript string contains any of the given substrings. */
export function transcriptContainsPatternInString(raw: string, patterns: string[]): boolean {
  return patterns.some((p) => raw.includes(p))
}

/** Parse a JSONL transcript file into an array of entries, skipping malformed lines. */
export function parseTranscript(transcriptPath: string): TranscriptEntry[] {
  const raw = readFileSync(transcriptPath, "utf8")
  return parseTranscriptFromString(raw)
}

/** Parse a raw JSONL string into an array of transcript entries, skipping malformed lines. */
export function parseTranscriptFromString(raw: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      /* skip malformed */
    }
  }
  return entries
}

/** Find the index of the last human entry that contains a user prompt (text block, not just tool results). Used to identify the start of the current prompt→stop cycle in multi-turn sessions. Returns 0 if no user prompt is found. */
export function findLastUserPromptIndex(entries: TranscriptEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry.type !== "human") continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    if (content.some((b) => b.type === "text" && b.text)) return i
  }
  return 0
}

/** Find the index of the last ExitPlanMode tool_use in the transcript (handles multiple plans). */
export function findExitPlanIndex(entries: TranscriptEntry[]): number {
  // Find the LAST ExitPlanMode tool_use (in case of multiple plans)
  let lastIdx = -1
  for (let i = 0; i < entries.length; i++) {
    for (const block of getContentBlocks(entries[i])) {
      if (block.type === "tool_use" && block.name === "ExitPlanMode") {
        lastIdx = i
      }
    }
  }
  return lastIdx
}

/** Check whether any execution tools (Edit, Write, Bash, etc.) were used after a given entry index. */
export function hasExecutionAfter(entries: TranscriptEntry[], afterIdx: number): boolean {
  for (let i = afterIdx + 1; i < entries.length; i++) {
    for (const block of getContentBlocks(entries[i])) {
      if (block.type === "tool_use" && block.name && EXECUTION_TOOLS.has(block.name)) {
        return true
      }
    }
  }
  return false
}

/** Walk backwards from the end to find the last assistant text block after a given index. */
export function extractLastAssistantText(entries: TranscriptEntry[], afterIdx: number): string {
  // Walk backwards from end, find last assistant text block
  for (let i = entries.length - 1; i > afterIdx; i--) {
    const blocks = getContentBlocks(entries[i])
    // Collect all text blocks from this assistant message
    const texts: string[] = []
    for (const block of blocks) {
      if (block.type === "text" && block.text) {
        texts.push(block.text)
      }
    }
    if (texts.length > 0) return texts.join("\n\n")
  }
  return ""
}

/** Collect text from the last N assistant entries after a given index, in chronological order. */
export function extractConclusionText(
  entries: TranscriptEntry[],
  afterIdx: number,
  maxEntries = 3,
): string {
  // Walk backwards, collect text from the last N assistant entries that have text
  const collected: string[] = []
  for (let i = entries.length - 1; i > afterIdx && collected.length < maxEntries; i--) {
    const blocks = getContentBlocks(entries[i])
    const texts: string[] = []
    for (const block of blocks) {
      if (block.type === "text" && block.text) {
        texts.push(block.text)
      }
    }
    if (texts.length > 0) collected.push(texts.join("\n\n"))
  }
  // Reverse to chronological order
  collected.reverse()
  return collected.join("\n\n")
}

/** Collect text from the last N assistant entries before a given index, in chronological order. */
export function extractPlanText(
  entries: TranscriptEntry[],
  beforeIdx: number,
  maxEntries = 3,
): string {
  const collected: string[] = []
  for (let i = beforeIdx - 1; i >= 0 && collected.length < maxEntries; i--) {
    const blocks = getContentBlocks(entries[i])
    const texts: string[] = []
    for (const block of blocks) {
      if (block.type === "text" && block.text) {
        texts.push(block.text)
      }
    }
    if (texts.length > 0) collected.push(texts.join("\n\n"))
  }
  collected.reverse()
  return collected.join("\n\n")
}

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])

/** Collect unique file paths modified by file-writing tools (Edit, Write, etc.) after a given index. */
export function collectChangedFiles(entries: TranscriptEntry[], afterIdx: number): string[] {
  const files = new Set<string>()
  for (let i = afterIdx + 1; i < entries.length; i++) {
    for (const block of getContentBlocks(entries[i])) {
      if (block.type !== "tool_use" || !block.name) continue
      if (!FILE_TOOLS.has(block.name)) continue
      const filePath = block.input?.file_path
      if (typeof filePath === "string" && filePath) {
        files.add(filePath)
      }
    }
  }
  return [...files]
}

/** Concatenate all assistant text blocks after a given index into a single narrative string. */
export function collectAllAssistantText(entries: TranscriptEntry[], afterIdx: number): string {
  const texts: string[] = []
  for (let i = afterIdx + 1; i < entries.length; i++) {
    for (const block of getContentBlocks(entries[i])) {
      if (block.type === "text" && block.text) {
        texts.push(block.text)
      }
    }
  }
  return texts.join("\n\n")
}

/** Collected text and file data from the execution phase of a session. */
export interface ExecutionStats {
  filesChanged: string[]
  allAssistantText: string
  lastAssistantText: string
  conclusionText: string
}

/** Select the richest available text for the Summary section body.
 *  Priority: payload (CLI's rendered conclusion) > conclusion (multi-entry tail) >
 *  last single entry > Haiku summary */
export function selectDoneText(
  payloadMessage: string,
  stats: ExecutionStats,
  summary: string,
  minLength = 50,
): string {
  if (payloadMessage.length >= minLength) return payloadMessage
  if (stats.conclusionText.length >= minLength) return stats.conclusionText
  if (stats.lastAssistantText.length >= minLength) return stats.lastAssistantText
  return summary
}

/** Gather all execution phase data (changed files, assistant text, conclusion) after the ExitPlanMode index. */
export function collectExecutionStats(
  entries: TranscriptEntry[],
  afterIdx: number,
): ExecutionStats {
  return {
    filesChanged: collectChangedFiles(entries, afterIdx),
    allAssistantText: collectAllAssistantText(entries, afterIdx),
    lastAssistantText: extractLastAssistantText(entries, afterIdx),
    conclusionText: extractConclusionText(entries, afterIdx),
  }
}

function resolveRange(
  entries: TranscriptEntry[],
  startIdx?: number,
  endIdx?: number,
): [number, number] {
  const start = startIdx ?? 0
  const end = endIdx ?? entries.length - 1
  return [Math.max(0, start), Math.min(entries.length - 1, end)]
}

/** Extract the content blocks array from a human transcript entry. */
export function getUserContentBlocks(entry: TranscriptEntry): ContentBlock[] {
  if (entry.type !== "human") return []
  const content = entry.message?.content
  if (!Array.isArray(content)) return []
  return content
}

/** Find the model identifier from the first assistant entry with a model field, stripping the date suffix. */
export function extractModel(
  entries: TranscriptEntry[],
  startIdx?: number,
  endIdx?: number,
): string {
  const [start, end] = resolveRange(entries, startIdx, endIdx)
  for (let i = start; i <= end; i++) {
    // Real transcripts store model on the API response object (message.model)
    const model = entries[i].message?.model ?? entries[i].model
    if (typeof model === "string" && model) {
      // Strip date suffix: claude-opus-4-6-20250624 → claude-opus-4-6
      return model.replace(/-\d{8}$/, "")
    }
  }
  return "unknown"
}

/** Compute the wall-clock duration in milliseconds between the first and last entries in a range. */
export function computeDurationMs(
  entries: TranscriptEntry[],
  startIdx?: number,
  endIdx?: number,
): number {
  const [start, end] = resolveRange(entries, startIdx, endIdx)
  const first = entries[start]?.timestamp
  const last = entries[end]?.timestamp
  if (!first || !last) return 0
  const diff = new Date(last).getTime() - new Date(first).getTime()
  return Math.max(0, diff)
}

/** Sum all token usage (input, output, cache) across assistant entries in a range. */
export function aggregateTokens(
  entries: TranscriptEntry[],
  startIdx?: number,
  endIdx?: number,
): TokenUsage {
  const [start, end] = resolveRange(entries, startIdx, endIdx)
  const totals: TokenUsage = { input: 0, output: 0, cache_read: 0, cache_create: 0 }
  for (let i = start; i <= end; i++) {
    if (entries[i].type !== "assistant") continue
    const usage = entries[i].message?.usage
    if (!usage) continue
    totals.input += usage.input_tokens ?? 0
    totals.output += usage.output_tokens ?? 0
    totals.cache_read += usage.cache_read_input_tokens ?? 0
    totals.cache_create += usage.cache_creation_input_tokens ?? 0
  }
  return totals
}

/** Find the highest single-turn context usage (input + cache_read tokens) in a range. */
export function peakTurnContext(
  entries: TranscriptEntry[],
  startIdx?: number,
  endIdx?: number,
): number {
  const [start, end] = resolveRange(entries, startIdx, endIdx)
  let peak = 0
  for (let i = start; i <= end; i++) {
    if (entries[i].type !== "assistant") continue
    const usage = entries[i].message?.usage
    if (!usage) continue
    const turnContext = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
    if (turnContext > peak) peak = turnContext
  }
  return peak
}

/** Count distinct subagent IDs (sidechain entries) in a transcript range. */
export function countSubagents(
  entries: TranscriptEntry[],
  startIdx?: number,
  endIdx?: number,
): number {
  const [start, end] = resolveRange(entries, startIdx, endIdx)
  const agentIds = new Set<string>()
  for (let i = start; i <= end; i++) {
    const entry = entries[i]
    if (entry.isSidechain && entry.agentId) {
      agentIds.add(entry.agentId)
    }
  }
  return agentIds.size
}

const MCP_PREFIX = "mcp__"

function parseMcpToolName(toolName: string): { server: string; tool: string } | null {
  if (!toolName.startsWith(MCP_PREFIX)) return null
  const rest = toolName.slice(MCP_PREFIX.length)
  const sepIdx = rest.indexOf("__")
  if (sepIdx === -1) return { server: rest, tool: rest }
  return { server: rest.slice(0, sepIdx), tool: rest }
}

/** Aggregate tool call counts, errors, and MCP server participation across a transcript range. */
export function collectToolUsage(
  entries: TranscriptEntry[],
  startIdx?: number,
  endIdx?: number,
): {
  tools: ToolUseRecord[]
  mcpServers: McpServerInfo[]
  totalCalls: number
  totalErrors: number
} {
  const [start, end] = resolveRange(entries, startIdx, endIdx)

  const toolMap = new Map<string, { calls: number; errors: number }>()
  const mcpMap = new Map<string, { tools: Set<string>; calls: number }>()

  // First pass: collect tool_use blocks and their IDs per assistant entry
  // Second pass on following human entry: match tool_result errors by tool_use_id
  for (let i = start; i <= end; i++) {
    const entry = entries[i]

    // Collect tool_use from assistant entries
    if (entry.type === "assistant") {
      const pendingToolIds = new Map<string, string>() // tool_use_id -> tool_name
      for (const block of getContentBlocks(entry)) {
        if (block.type !== "tool_use" || !block.name) continue
        const name = block.name
        const rec = toolMap.get(name) ?? { calls: 0, errors: 0 }
        rec.calls++
        toolMap.set(name, rec)

        if (block.id) pendingToolIds.set(block.id, name)

        const mcp = parseMcpToolName(name)
        if (mcp) {
          const srv = mcpMap.get(mcp.server) ?? { tools: new Set<string>(), calls: 0 }
          srv.tools.add(mcp.tool)
          srv.calls++
          mcpMap.set(mcp.server, srv)
        }
      }

      // Check the next human entry for tool_result errors
      if (i + 1 <= end && entries[i + 1].type === "human") {
        for (const block of getUserContentBlocks(entries[i + 1])) {
          if (block.type !== "tool_result" || !block.is_error) continue
          const toolName = block.tool_use_id ? pendingToolIds.get(block.tool_use_id) : undefined
          if (toolName) {
            const rec = toolMap.get(toolName)
            if (rec) rec.errors++
          }
        }
      }
    }
  }

  let totalCalls = 0
  let totalErrors = 0
  const tools: ToolUseRecord[] = []
  for (const [name, rec] of toolMap) {
    tools.push({ name, calls: rec.calls, errors: rec.errors })
    totalCalls += rec.calls
    totalErrors += rec.errors
  }
  // Sort by call count descending
  tools.sort((a, b) => b.calls - a.calls)

  const mcpServers: McpServerInfo[] = []
  for (const [name, info] of mcpMap) {
    mcpServers.push({ name, tools: [...info.tools], calls: info.calls })
  }
  mcpServers.sort((a, b) => b.calls - a.calls)

  return { tools, mcpServers, totalCalls, totalErrors }
}

/** Collect all transcript statistics (model, duration, tokens, tools, MCP) for a range of entries. */
export function collectTranscriptStats(
  entries: TranscriptEntry[],
  startIdx?: number,
  endIdx?: number,
): TranscriptStats {
  const model = extractModel(entries, startIdx, endIdx)
  const durationMs = computeDurationMs(entries, startIdx, endIdx)
  const tokens = aggregateTokens(entries, startIdx, endIdx)
  const peak = peakTurnContext(entries, startIdx, endIdx)
  const subagentCount = countSubagents(entries, startIdx, endIdx)
  const { tools, mcpServers, totalCalls, totalErrors } = collectToolUsage(entries, startIdx, endIdx)

  return {
    model,
    durationMs,
    tokens,
    peakTurnContext: peak,
    subagentCount,
    tools,
    mcpServers,
    totalToolCalls: totalCalls,
    totalErrors,
  }
}

/** Build a chronological tool log with per-turn detail (timestamps, tokens, justification, tool args). */
export function collectToolLog(
  entries: TranscriptEntry[],
  startIdx?: number,
  endIdx?: number,
): ToolLog {
  const [start, end] = resolveRange(entries, startIdx, endIdx)

  const turns: TurnLogEntry[] = []
  let seq = 0
  let turnNumber = 0
  let totalErrors = 0

  for (let i = start; i <= end; i++) {
    const entry = entries[i]
    if (entry.type !== "assistant") continue

    const blocks = getContentBlocks(entry)
    const toolBlocks = blocks.filter((b) => b.type === "tool_use" && b.name)
    if (toolBlocks.length === 0) continue

    turnNumber++

    // Collect justification: text blocks before the first tool_use
    const justParts: string[] = []
    for (const block of blocks) {
      if (block.type === "tool_use") break
      if (block.type === "text" && block.text) justParts.push(block.text)
    }

    // Build error map and answer map from next human entry
    const errorIds = new Set<string>()
    const answerMap = new Map<string, string>()
    if (i + 1 <= end && entries[i + 1].type === "human") {
      for (const block of getUserContentBlocks(entries[i + 1])) {
        if (block.type === "tool_result" && block.tool_use_id) {
          if (block.is_error) {
            errorIds.add(block.tool_use_id)
          } else if (typeof block.content === "string" && block.content) {
            answerMap.set(block.tool_use_id, block.content)
          }
        }
      }
    }

    // Build tool log entries
    const tools: ToolLogEntry[] = []
    for (const block of toolBlocks) {
      seq++
      const isError = block.id ? errorIds.has(block.id) : false
      if (isError) totalErrors++
      const answer =
        block.name === "AskUserQuestion" && block.id ? answerMap.get(block.id) : undefined
      tools.push({
        seq,
        name: block.name as string,
        input: block.input ?? {},
        isError,
        blockId: block.id,
        ...(answer !== undefined ? { answer } : {}),
      })
    }

    // Compute duration to next entry
    let durationMs = 0
    const thisTs = entry.timestamp
    const nextTs = i + 1 <= end ? entries[i + 1]?.timestamp : undefined
    if (thisTs && nextTs) {
      durationMs = Math.max(0, new Date(nextTs).getTime() - new Date(thisTs).getTime())
    }

    // Extract token usage
    const usage = entry.message?.usage
    const tokensIn = (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0)
    const tokensOut = usage?.output_tokens ?? 0

    turns.push({
      turnNumber,
      timestamp: entry.timestamp ?? "",
      durationMs,
      tokensIn,
      tokensOut,
      justification: justParts.join("\n\n"),
      tools,
      isSidechain: entry.isSidechain ?? false,
      agentId: entry.agentId,
    })
  }

  return {
    turns,
    totalToolCalls: seq,
    totalErrors,
  }
}

/** A Skill tool_use detected in the transcript. */
export interface SkillInvocation {
  /** Transcript entry index where the Skill tool_use was found. */
  index: number
  /** Skill name from input.skill. */
  skill: string
  /** Optional args from input.args. */
  args?: string
  /** Assistant text from the same turn, before the Skill tool_use block. */
  contextBefore: string
  /** Assistant text from the immediate next assistant turn after the skill completes. */
  contextAfter: string
}

/** Extract the raw text from a user-entry message.content, which can be a string or array of blocks. */
function getUserEntryText(entry: TranscriptEntry): string {
  if (entry.type !== "user" && entry.type !== "human") return ""
  const content = entry.message?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const texts: string[] = []
  for (const b of content) {
    if (b.type === "text" && b.text) texts.push(b.text)
  }
  return texts.join("\n")
}

const SLASH_COMMAND_NAME_RE = /<command-name>\/?([^<\s]+)<\/command-name>/
const SLASH_COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/

/** Find the next assistant turn's text after entry index `i`. */
function nextAssistantText(entries: TranscriptEntry[], i: number): string {
  for (let j = i + 1; j < entries.length; j++) {
    const nextBlocks = getContentBlocks(entries[j])
    if (nextBlocks.length === 0) continue
    const texts: string[] = []
    for (const b of nextBlocks) {
      if (b.type === "text" && b.text) texts.push(b.text)
    }
    if (texts.length > 0) return texts.join("\n\n")
  }
  return ""
}

/** Scan transcript for skill invocations: assistant `Skill` tool_use blocks AND user-typed `<command-name>` slash commands. */
export function findSkillInvocations(entries: TranscriptEntry[]): SkillInvocation[] {
  const results: SkillInvocation[] = []
  const seen = new Set<string>()

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]

    // Path A: assistant Skill tool_use block
    const blocks = getContentBlocks(entry)
    for (const block of blocks) {
      if (block.type !== "tool_use" || block.name !== "Skill") continue

      const skill = block.input?.skill
      if (typeof skill !== "string") continue

      const args = typeof block.input?.args === "string" ? block.input.args : undefined

      // Collect text blocks before the Skill block in this same turn
      const textsBefore: string[] = []
      for (const b of blocks) {
        if (b === block) break
        if (b.type === "text" && b.text) textsBefore.push(b.text)
      }

      results.push({
        index: i,
        skill,
        args,
        contextBefore: textsBefore.join("\n\n"),
        contextAfter: nextAssistantText(entries, i),
      })
      seen.add(`${i}:${skill}`)
    }

    // Path B: user-typed slash command — `<command-name>X</command-name>` in a user/human turn
    if (entry.type === "user" || entry.type === "human") {
      const text = getUserEntryText(entry)
      if (!text) continue
      const nameMatch = text.match(SLASH_COMMAND_NAME_RE)
      if (!nameMatch) continue
      const skill = nameMatch[1]
      if (!skill) continue
      const key = `${i}:${skill}`
      if (seen.has(key)) continue

      const argsMatch = text.match(SLASH_COMMAND_ARGS_RE)
      const rawArgs = argsMatch?.[1]?.trim()
      const args = rawArgs ? rawArgs : undefined

      results.push({
        index: i,
        skill,
        args,
        contextBefore: "",
        contextAfter: nextAssistantText(entries, i),
      })
      seen.add(key)
    }
  }

  return results
}

/** Filter skill invocations against a whitelist. undefined = pass all, [] = pass none. */
export function filterSkillInvocations(
  invocations: SkillInvocation[],
  captureSkills?: string[],
): SkillInvocation[] {
  if (!captureSkills) return invocations
  if (captureSkills.length === 0) return []
  const allowSet = new Set(captureSkills)
  return invocations.filter((inv) => allowSet.has(inv.skill))
}

const DEFAULT_SPEC_PATTERN = "/superpowers/specs/"
const DEFAULT_PLAN_PATTERN = "/superpowers/plans/"

/** A Write tool_use targeting a superpowers spec or plan path. */
export interface SuperpowersWrite {
  index: number
  type: "spec" | "plan"
  filePath: string
  title: string
  content: string
}

/** Scan transcript for Write tool_use blocks targeting superpowers spec/plan paths. */
export function findSuperpowersWrites(
  entries: TranscriptEntry[],
  specPattern?: string,
  planPattern?: string,
): SuperpowersWrite[] {
  const sp = specPattern || DEFAULT_SPEC_PATTERN
  const pp = planPattern || DEFAULT_PLAN_PATTERN
  const results: SuperpowersWrite[] = []

  for (let i = 0; i < entries.length; i++) {
    for (const block of getContentBlocks(entries[i])) {
      if (block.type !== "tool_use" || block.name !== "Write") continue
      const filePath = block.input?.file_path
      if (typeof filePath !== "string") continue

      let type: "spec" | "plan" | null = null
      if (filePath.includes(pp)) type = "plan"
      else if (filePath.includes(sp)) type = "spec"
      if (!type) continue

      const content = typeof block.input?.content === "string" ? block.input.content : ""
      const titleMatch = content.match(/^#\s+(.+)/m)
      const title = titleMatch
        ? titleMatch[1].trim()
        : (filePath.split("/").pop() ?? "").replace(/\.md$/, "").replace(/^\d{4}-\d{2}-\d{2}-/, "")
      results.push({ index: i, type, filePath, title, content })
    }
  }

  return results
}

/** Return the transcript index of the last superpowers Write (planning/execution boundary).
 *  Prefers plan writes over spec writes. Returns -1 if no writes found. */
export function findSuperpowersBoundary(writes: SuperpowersWrite[]): number {
  if (writes.length === 0) return -1
  const plans = writes.filter((w) => w.type === "plan")
  if (plans.length > 0) return plans[plans.length - 1].index
  return writes[writes.length - 1].index
}
