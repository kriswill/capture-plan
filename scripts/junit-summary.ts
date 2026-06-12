#!/usr/bin/env bun
// junit-summary.ts — Render bun test JUnit XML as a nested GitHub step summary.
//
// Mirrors the local `bun test` TTY layout: one section per test file, with
// describe blocks as nested sub-lists and individual tests as ✅/❌/⏭️ leaves.
//
// Usage: bun scripts/junit-summary.ts <test-results.xml>
// Appends to $GITHUB_STEP_SUMMARY when set, otherwise prints to stdout.

import { appendFileSync, readFileSync } from "node:fs"

/** A single <testcase> result parsed from JUnit XML. */
interface TestCase {
  kind: "case"
  name: string
  timeMs: number
  status: "pass" | "fail" | "skip"
  message?: string
}

/** A <testsuite> node: a test file or a nested describe block. */
interface TestSuite {
  kind: "suite"
  name: string
  children: (TestSuite | TestCase)[]
}

/** Decode the XML entities bun's JUnit reporter emits. */
function decodeEntities(s: string): string {
  return s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
}

/** Extract an attribute value from a raw XML tag string. */
function attr(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`))
  const value = match?.[1]
  return value === undefined ? undefined : decodeEntities(value)
}

/**
 * Parse bun's JUnit output into a tree of suites and cases.
 * A stack-based tag scanner is enough: the XML is machine-generated with
 * double-quoted attributes and no mixed content.
 */
export function parseJunit(xml: string): TestSuite[] {
  const root: TestSuite = { kind: "suite", name: "", children: [] }
  const stack: TestSuite[] = [root]
  let currentCase: TestCase | undefined

  const tags = xml.matchAll(/<\/?[a-zA-Z][^>]*>/g)
  for (const [tag] of tags) {
    const top = stack[stack.length - 1]
    if (tag.startsWith("<testsuite ") || tag === "<testsuite>") {
      const suite: TestSuite = { kind: "suite", name: attr(tag, "name") ?? "?", children: [] }
      top.children.push(suite)
      if (!tag.endsWith("/>")) stack.push(suite)
    } else if (tag === "</testsuite>") {
      stack.pop()
    } else if (tag.startsWith("<testcase")) {
      currentCase = {
        kind: "case",
        name: attr(tag, "name") ?? "?",
        timeMs: Number(attr(tag, "time") ?? 0) * 1000,
        status: "pass",
      }
      top.children.push(currentCase)
      if (tag.endsWith("/>")) currentCase = undefined
    } else if (tag === "</testcase>") {
      currentCase = undefined
    } else if (currentCase && (tag.startsWith("<failure") || tag.startsWith("<error"))) {
      currentCase.status = "fail"
      currentCase.message = attr(tag, "message")
    } else if (currentCase && tag.startsWith("<skipped")) {
      currentCase.status = "skip"
    }
  }
  return root.children.filter((c): c is TestSuite => c.kind === "suite")
}

/** Aggregate pass/fail/skip counts for a suite subtree. */
function tally(suite: TestSuite): { pass: number; fail: number; skip: number } {
  const totals = { pass: 0, fail: 0, skip: 0 }
  for (const child of suite.children) {
    if (child.kind === "case") {
      totals[child.status === "pass" ? "pass" : child.status === "fail" ? "fail" : "skip"]++
    } else {
      const sub = tally(child)
      totals.pass += sub.pass
      totals.fail += sub.fail
      totals.skip += sub.skip
    }
  }
  return totals
}

const ICONS = { pass: "✅", fail: "❌", skip: "⏭️" } as const

/** Render one suite child (nested describe or test case) as a markdown list item. */
function renderNode(node: TestSuite | TestCase, depth: number, lines: string[]): void {
  const indent = "  ".repeat(depth)
  if (node.kind === "case") {
    const time = node.timeMs >= 1 ? ` <sub>${node.timeMs.toFixed(1)}ms</sub>` : ""
    lines.push(`${indent}- ${ICONS[node.status]} ${node.name}${time}`)
    if (node.message) lines.push(`${indent}  - \`${node.message}\``)
  } else {
    lines.push(`${indent}- **${node.name}**`)
    for (const child of node.children) renderNode(child, depth + 1, lines)
  }
}

/** Render the full suite tree as collapsible per-file markdown sections. */
export function renderSummary(files: TestSuite[]): string {
  const lines: string[] = []
  const grand = { pass: 0, fail: 0, skip: 0 }

  for (const file of files) {
    const t = tally(file)
    grand.pass += t.pass
    grand.fail += t.fail
    grand.skip += t.skip
    const icon = t.fail > 0 ? ICONS.fail : ICONS.pass
    const counts = [
      `${t.pass} passed`,
      t.fail > 0 ? `${t.fail} failed` : "",
      t.skip > 0 ? `${t.skip} skipped` : "",
    ]
      .filter(Boolean)
      .join(", ")
    // Files with failures start expanded; green files stay collapsed.
    lines.push(`<details${t.fail > 0 ? " open" : ""}>`)
    lines.push(`<summary>${icon} <code>${file.name}</code> — ${counts}</summary>`)
    lines.push("")
    for (const child of file.children) renderNode(child, 0, lines)
    lines.push("")
    lines.push("</details>")
  }

  const total = grand.pass + grand.fail + grand.skip
  const headline =
    grand.fail > 0
      ? `### ❌ ${grand.fail} of ${total} tests failed`
      : `### ✅ ${grand.pass} tests passed${grand.skip > 0 ? ` (${grand.skip} skipped)` : ""}`
  return [headline, "", ...lines, ""].join("\n")
}

if (import.meta.main) {
  const xmlPath = process.argv[2]
  if (!xmlPath) {
    console.error("usage: bun scripts/junit-summary.ts <test-results.xml>")
    process.exit(1)
  }
  const markdown = renderSummary(parseJunit(readFileSync(xmlPath, "utf8")))
  const summaryFile = process.env.GITHUB_STEP_SUMMARY
  if (summaryFile) {
    appendFileSync(summaryFile, markdown, "utf8")
  } else {
    console.log(markdown)
  }
}
