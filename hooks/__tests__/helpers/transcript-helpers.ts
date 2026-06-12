import type { ContentBlock, TranscriptEntry } from "../../transcript.ts"

/** Factory for building assistant transcript entries in tests. */
export function assistantEntry(
  overrides: Partial<TranscriptEntry> & { tools?: { name: string; id?: string }[] } = {},
): TranscriptEntry {
  const { tools, model, message: msgOverride, ...rest } = overrides
  const content = tools
    ? tools.map((t) => ({ type: "tool_use" as const, name: t.name, id: t.id ?? t.name }))
    : [{ type: "text" as const, text: "some response" }]
  const message = msgOverride
    ? { model, ...msgOverride }
    : {
        role: "assistant" as const,
        model,
        content,
        usage: { input_tokens: 100, output_tokens: 50 },
      }
  return {
    type: "assistant",
    timestamp: "2026-03-30T14:00:00.000Z",
    message,
    ...rest,
  }
}

/** Factory for an assistant entry containing a Write tool_use. */
export function writeEntry(
  filePath: string,
  content = "# Test Content\n\nBody text.",
  overrides: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  const block: ContentBlock = {
    type: "tool_use",
    name: "Write",
    id: `write-${filePath.split("/").pop()}`,
    input: { file_path: filePath, content },
  }
  return {
    type: "assistant",
    timestamp: "2026-03-30T14:00:00.000Z",
    message: {
      role: "assistant",
      content: [block],
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    ...overrides,
  }
}

/** Factory for an assistant entry containing a Skill tool_use. */
export function skillEntry(
  skill: string,
  args?: string,
  overrides: Partial<TranscriptEntry> & { textBefore?: string } = {},
): TranscriptEntry {
  const { textBefore, ...rest } = overrides
  const content: ContentBlock[] = []
  if (textBefore) {
    content.push({ type: "text", text: textBefore })
  }
  content.push({
    type: "tool_use",
    name: "Skill",
    id: `skill-${skill}`,
    input: { skill, ...(args ? { args } : {}) },
  })
  return {
    type: "assistant",
    timestamp: "2026-03-30T14:00:00.000Z",
    message: {
      role: "assistant",
      content,
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    ...rest,
  }
}

/** Factory for a user-typed slash command entry (e.g. `/code-review 2931142`). */
export function slashCommandEntry(
  skill: string,
  args = "",
  overrides: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  const content = `<command-name>/${skill}</command-name>\n            <command-message>${skill}</command-message>\n            <command-args>${args}</command-args>`
  return {
    type: "user",
    timestamp: "2026-03-30T14:01:00.000Z",
    message: { role: "user", content },
    ...overrides,
  }
}

/** Factory for building human transcript entries in tests. */
export function humanEntry(
  overrides: Partial<TranscriptEntry> & {
    toolResults?: { tool_use_id: string; is_error?: boolean; content?: string }[]
  } = {},
): TranscriptEntry {
  const { toolResults, ...rest } = overrides
  const content = toolResults
    ? toolResults.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.tool_use_id,
        ...(r.is_error ? { is_error: true as const } : {}),
        ...(typeof r.content === "string" ? { content: r.content } : {}),
      }))
    : [{ type: "text" as const, text: "user message" }]
  return {
    type: "human",
    timestamp: "2026-03-30T14:01:00.000Z",
    message: { role: "user", content },
    ...rest,
  }
}
