# Obsidian CLI Reference

> **Sources**: Official docs at <https://obsidian.md/help/cli>, `obsidian --help` output, and project experience.
> **Requires**: Obsidian 1.12+ installer, CLI enabled in Settings > General. Obsidian app must be running.
> **Maintained**: Update the [Learned Behaviors & Workarounds](#learned-behaviors--workarounds) section when encountering new CLI quirks.

---

## Quick Reference (Commands Used by This Project)

| Command | Purpose |
|---------|---------|
| `create` | Create a new file |
| `read` | Read file contents |
| `append` | Append content to a file |
| `move` | Move or rename a file |
| `delete` | Delete a file |
| `file` | Show file info / check existence |
| `files` | List files in a folder |
| `folder` | Show folder info / check existence |
| `folders` | List folders |
| `property:read` | Read a frontmatter property |
| `property:set` | Set a frontmatter property |
| `vault` | Show vault info (name, path, etc.) |

---

## Usage Fundamentals

```
obsidian <command> [options]
```

- **Vault targeting**: `vault=<name>` must be the first parameter before any command.
  ```shell
  obsidian vault=Notes create path="test.md" content="hello"
  ```
- **File targeting**: Two ways to specify a file:
  - `file=<name>` — resolves by name like wikilinks (ambiguous if multiple files share a name)
  - `path=<path>` — exact path from vault root, e.g. `folder/note.md`
  - If neither provided, defaults to the active file in Obsidian
- **Parameters**: `key=value`. Quote values with spaces: `name="My Note"`
- **Flags**: Boolean switches with no value. Include to turn on: `permanent`, `overwrite`, `silent`
- **Content escaping**: Use `\n` for newline, `\t` for tab in content values
- **Clipboard**: Add `--copy` to any command to copy output to clipboard
- **TUI mode**: Run `obsidian` with no command to enter interactive terminal with autocomplete and history

---

## File Operations

### `create`

Create or overwrite a file.

```
name=<name>        # file name
path=<path>        # file path
content=<text>     # initial content
template=<name>    # template to use

overwrite          # overwrite if file exists
open               # open file after creating
newtab             # open in new tab
silent             # suppress UI notification (undocumented, see Mismatches)
```

### `read`

Read file contents (default: active file).

```
file=<name>        # file name
path=<path>        # file path
```

### `append`

Append content to a file (default: active file).

```
file=<name>        # file name
path=<path>        # file path
content=<text>     # (required) content to append

inline             # append without newline
```

### `prepend`

Prepend content after frontmatter (default: active file).

```
file=<name>        # file name
path=<path>        # file path
content=<text>     # (required) content to prepend

inline             # prepend without newline
```

### `move`

Move or rename a file (default: active file). Automatically updates internal links if enabled in vault settings.

```
file=<name>        # file name
path=<path>        # file path
to=<path>          # (required) destination folder or path
```

### `rename`

Rename a file (default: active file). File extension is preserved automatically if omitted. Use `move` to rename and relocate simultaneously. Automatically updates internal links if enabled in vault settings.

```
file=<name>        # file name
path=<path>        # file path
name=<name>        # (required) new file name
```

### `delete`

Delete a file (default: active file, moves to trash by default).

```
file=<name>        # file name
path=<path>        # file path

permanent          # skip trash, delete permanently
```

### `open`

Open a file in Obsidian.

```
file=<name>        # file name
path=<path>        # file path

newtab             # open in new tab
```

### `file`

Show file info (default: active file). Returns path, name, extension, size, created, modified.

```
file=<name>        # file name
path=<path>        # file path
```

### `files`

List files in the vault.

```
folder=<path>      # filter by folder
ext=<extension>    # filter by extension

total              # return file count
```

### `folder`

Show folder info.

```
path=<path>              # (required) folder path
info=files|folders|size  # return specific info only
```

### `folders`

List folders in the vault.

```
folder=<path>      # filter by parent folder

total              # return folder count
```

---

## Properties

### `aliases`

List aliases in the vault. Use `active` or `file`/`path` for a specific file.

```
file=<name>        # file name
path=<path>        # file path

total              # return alias count
verbose            # include file paths
active             # show aliases for active file
```

### `properties`

List properties in the vault. Use `active` or `file`/`path` for a specific file.

```
file=<name>        # show properties for file
path=<path>        # show properties for path
name=<name>        # get specific property count
sort=count         # sort by count (default: name)
format=yaml|json|tsv  # output format (default: yaml)

total              # return property count
counts             # include occurrence counts
active             # show properties for active file
```

### `property:read`

Read a property value from a file (default: active file).

```
name=<name>        # (required) property name
file=<name>        # file name
path=<path>        # file path
```

### `property:set`

Set a property on a file (default: active file).

```
name=<name>                                    # (required) property name
value=<value>                                  # (required) property value
type=text|list|number|checkbox|date|datetime   # property type
file=<name>                                    # file name
path=<path>                                    # file path
```

### `property:remove`

Remove a property from a file (default: active file).

```
name=<name>        # (required) property name
file=<name>        # file name
path=<path>        # file path
```

---

## Daily Notes

### `daily`

Open today's daily note (creates it if needed).

### `daily:read`

Read daily note contents.

### `daily:path`

Get daily note path.

### `daily:append`

Append content to daily note.

```
content=<text>     # (required) content to append
paneType=tab|split|window    # pane type to open in

inline             # append without newline
open               # open file after adding
```

### `daily:prepend`

Prepend content to daily note.

```
content=<text>     # (required) content to prepend
paneType=tab|split|window    # pane type to open in

inline             # prepend without newline
open               # open file after adding
```

---

## Search

### `search`

Search vault for text. Returns matching file paths.

```
query=<text>       # (required) search query
path=<folder>      # limit to folder
limit=<n>          # max files
format=text|json   # output format (default: text)

total              # return match count
case               # case sensitive
```

### `search:context`

Search with matching line context. Returns grep-style `path:line: text` output.

```
query=<text>       # (required) search query
path=<folder>      # limit to folder
limit=<n>          # max files
format=text|json   # output format (default: text)

case               # case sensitive
```

### `search:open`

Open search view.

```
query=<text>       # initial search query
```

---

## Tags & Tasks

### `tags`

List tags in the vault. Use `active` or `file`/`path` for a specific file.

```
file=<name>        # file name
path=<path>        # file path
sort=count         # sort by count (default: name)
format=json|tsv|csv  # output format (default: tsv)

total              # return tag count
counts             # include tag counts
active             # show tags for active file
```

### `tag`

Get tag info.

```
name=<tag>         # (required) tag name

total              # return occurrence count
verbose            # include file list and count
```

### `tasks`

List tasks in the vault.

```
file=<name>        # filter by file name
path=<path>        # filter by file path
status="<char>"    # filter by status character
format=json|tsv|csv  # output format (default: text)

total              # return task count
done               # show completed tasks
todo               # show incomplete tasks
verbose            # group by file with line numbers
active             # show tasks for active file
daily              # show tasks from daily note
```

### `task`

Show or update a task.

```
ref=<path:line>    # task reference (path:line)
file=<name>        # file name
path=<path>        # file path
line=<n>           # line number
status="<char>"    # set status character

toggle             # toggle task status
daily              # daily note
done               # mark as done
todo               # mark as todo
```

Examples:
```shell
task file=Recipe line=8            # show task info
task ref="Recipe.md:8" toggle      # toggle completion
task daily line=3 done             # mark daily note task done
task file=Recipe line=8 status=-   # set custom status [-]
```

---

## Links & Graph

### `backlinks`

List backlinks to a file (default: active file).

```
file=<name>        # target file name
path=<path>        # target file path

counts             # include link counts
total              # return backlink count
format=json|tsv|csv  # output format (default: tsv)
```

### `links`

List outgoing links from a file (default: active file).

```
file=<name>        # file name
path=<path>        # file path

total              # return link count
```

### `links:unresolved`

List unresolved links.

```
total              # return unresolved link count
counts             # include link counts
verbose            # include source files
format=json|tsv|csv  # output format (default: tsv)
```

### `orphans`

List files with no incoming links.

```
total              # return orphan count
```

### `deadends`

List files with no outgoing links.

```
total              # return dead-end count
```

---

## Bookmarks

### `bookmarks`

List bookmarks.

```
total              # return bookmark count
verbose            # include bookmark types
format=json|tsv|csv  # output format (default: tsv)
```

### `bookmark`

Add a bookmark.

```
file=<path>        # file to bookmark
subpath=<subpath>  # subpath (heading or block) within file
folder=<path>      # folder to bookmark
search=<query>     # search query to bookmark
url=<url>          # URL to bookmark
title=<title>      # bookmark title
```

---

## Templates

### `templates`

List templates.

```
total              # return template count
```

### `template:read`

Read template content.

```
name=<template>    # (required) template name

resolve            # resolve template variables
title=<title>      # title for variable resolution
```

### `template:insert`

Insert template into active file.

```
name=<template>    # (required) template name
```

---

## Sync & File History

### `diff`

List or compare versions from local file recovery and Sync. Versions numbered newest to oldest.

```
file=<name>          # file name
path=<path>          # file path
from=<n>             # version number to diff from
to=<n>               # version number to diff to
filter=local|sync    # filter by version source
```

Examples:
```shell
diff file=Recipe                  # list all versions
diff file=Recipe from=1           # compare latest to current
diff file=Recipe from=2 to=1      # compare two versions
diff filter=sync                  # only sync versions
```

### `history`

List versions from file recovery only.

```
file=<name>        # file name
path=<path>        # file path
```

### `history:list`

List files with history.

### `history:read`

Read a file history version.

```
file=<name>        # file name
path=<path>        # file path
version=<n>        # version number (default: 1)
```

### `history:restore`

Restore a file history version.

```
file=<name>        # file name
path=<path>        # file path
version=<n>        # (required) version number
```

### `history:open`

Open file recovery UI.

```
file=<name>        # file name
path=<path>        # file path
```

### `sync:status`

Show sync status and usage.

### `sync:history`

List sync version history.

```
file=<name>        # file name
path=<path>        # file path

total              # return version count
```

### `sync:read`

Read a sync version.

```
file=<name>        # file name
path=<path>        # file path
version=<n>        # (required) version number
```

### `sync:restore`

Restore a sync version.

```
file=<name>        # file name
path=<path>        # file path
version=<n>        # (required) version number
```

### `sync:open`

Open sync history UI.

```
file=<name>        # file name
path=<path>        # file path
```

---

## Plugins

### `plugins`

List installed plugins.

```
filter=core|community  # filter by plugin type

versions               # include version numbers
format=json|tsv|csv    # output format (default: tsv)
```

### `plugins:enabled`

List enabled plugins.

```
filter=core|community  # filter by plugin type

versions               # include version numbers
format=json|tsv|csv    # output format (default: tsv)
```

### `plugins:restrict`

Toggle or check restricted mode.

```
on                 # enable restricted mode
off                # disable restricted mode
```

### `plugin`

Get plugin info.

```
id=<plugin-id>     # (required) plugin ID
```

### `plugin:enable`

Enable a plugin.

```
id=<id>            # (required) plugin ID
```

### `plugin:disable`

Disable a plugin.

```
id=<id>            # (required) plugin ID
filter=core|community  # plugin type
```

### `plugin:install`

Install a community plugin.

```
id=<id>            # (required) plugin ID
```

### `plugin:uninstall`

Uninstall a community plugin.

```
id=<id>            # (required) plugin ID
```

### `plugin:reload`

Reload a plugin (useful for development).

```
id=<id>            # (required) plugin ID
```

---

## Vault

### `vault`

Show vault info.

```
info=name|path|files|folders|size  # return specific info only
```

### `vaults`

List known vaults.

```
total              # return vault count
verbose            # include vault paths
```

### `vault:open`

Switch to a different vault (TUI only).

```
name=<name>        # (required) vault name
```

---

## Other Commands

### Command Palette & Hotkeys

```
commands                     # list available command IDs
  filter=<prefix>            #   filter by ID prefix

command id=<command-id>      # execute an Obsidian command

hotkeys                      # list hotkeys
  total                      #   return hotkey count
  verbose                    #   show if hotkey is custom
  format=json|tsv|csv        #   output format (default: tsv)
  all                        #   include commands without hotkeys

hotkey id=<command-id>       # get hotkey for a command
  verbose                    #   show if custom or default
```

### Outline

```
outline                      # show headings for current file
  file=<name>                #   file name
  path=<path>                #   file path
  format=tree|md|json        #   output format (default: tree)
  total                      #   return heading count
```

### Random Notes

```
random                       # open a random note
  folder=<path>              #   limit to folder
  newtab                     #   open in new tab

random:read                  # read a random note (includes path)
  folder=<path>              #   limit to folder
```

### Unique Notes

```
unique                       # create unique note
  name=<text>                #   note name
  content=<text>             #   initial content
  paneType=tab|split|window  #   pane type
  open                       #   open after creating
```

### Web Viewer

```
web url=<url>                # open URL in web viewer
  newtab                     #   open in new tab
```

### Publish

```
publish:site                 # show publish site info
publish:list                 # list published files
publish:open                 # open file on published site
  file=<name>
  path=<path>
```

### Snippets

```
snippets                     # list CSS snippets
snippet:enable name=<name>   # enable a CSS snippet
snippet:disable name=<name>  # disable a CSS snippet
```

### Themes

```
themes                       # list available themes
theme                        # show active theme
  name=<name>                #   get theme details
theme:install name=<name>    # install a community theme
theme:uninstall name=<name>  # uninstall a theme
```

### App Control

```
reload                       # reload the vault
restart                      # restart the app
version                      # show Obsidian version
recents                      # list recently opened files
  total                      #   return count
```

### Developer Commands

```
devtools                     # toggle Electron dev tools

eval code=<javascript>       # execute JavaScript in app console

dev:debug on|off             # attach/detach Chrome DevTools Protocol debugger

dev:cdp                      # run a CDP command
  method=<CDP.method>        #   (required) CDP method
  params=<json>              #   method parameters as JSON

dev:screenshot               # take screenshot (returns base64 PNG)
  path=<filename>            #   save to file

dev:console                  # show captured console messages
  limit=<n>                  #   max messages (default: 50)
  level=log|warn|error|info|debug  # filter by level
  clear                      #   clear buffer

dev:errors                   # show captured JavaScript errors
  clear                      #   clear buffer

dev:css selector=<css>       # inspect CSS with source locations
  prop=<name>                #   filter by property

dev:dom selector=<css>       # query DOM elements
  total                      #   return element count
  text                       #   return text content
  inner                      #   return innerHTML
  all                        #   return all matches
  attr=<name>                #   get attribute value
  css=<prop>                 #   get CSS property value

dev:mobile on|off            # toggle mobile emulation
```

### Base (Database) Commands

```
bases                        # list all base files
base:views                   # list views in current base
base:create                  # create item in a base
  file=<name>                #   base file name
  path=<path>                #   base file path
  view=<name>                #   view name
  name=<name>                #   new file name
  content=<text>             #   initial content
  open                       #   open after creating
  newtab                     #   open in new tab

base:query                   # query a base
  file=<name>                #   base file name
  path=<path>                #   base file path
  view=<name>                #   view to query
  format=json|csv|tsv|md|paths  # output format (default: json)
```

---

## Mismatches: Web Docs vs `--help` Output

| Item | Web Docs | `--help` | Notes |
|------|----------|----------|-------|
| `silent` flag on `create` | Not listed | Not listed | **Undocumented but works.** Suppresses UI file-open notification. Used by this project. |
| `--copy` flag | Documented | Not shown | Works on any command to copy output to clipboard. |
| `recents` command | Not found | Listed | Lists recently opened files. |
| `restart` command | Not found | Listed | Restarts the Obsidian app. |
| `reload` command | Not found | Listed | Reloads the vault. |

---

## Learned Behaviors & Workarounds

Hard-won knowledge from this project's production use of the Obsidian CLI. **Maintain this section** — add entries whenever a new quirk or workaround is discovered.

### Error Detection

The CLI returns `exitCode=0` even on errors. Errors appear in stdout as `"Error: ..."`. You must check `stdout.startsWith("Error:")` to detect failures, not just the exit code.

```typescript
// hooks/lib/obsidian.ts:19-20
const exitCode = result.exitCode !== 0 || stdout.startsWith("Error:") ? 1 : 0
```

### File Replacement: Use `overwrite` Flag

Use `create` with the `overwrite` flag to replace existing vault files:

```typescript
// hooks/lib/obsidian.ts — createVaultNote()
runObsidian(["create", `path=${path}`, `content=${escaped}`, "overwrite", "silent"], vault)
```

**Why not `delete` + `create`?** Race condition with the async vault indexer — the indexer hasn't processed the delete before the create arrives, producing numbered duplicates (e.g. `"summary 1.md"`).

**Why not `move` + `create` + `delete`?** The `move` command triggers Obsidian's "Auto-update internal links" feature, which rewrites all wikilinks across the vault that reference the moved file. This corrupts frontmatter links (e.g. `created`, `session`) in other notes with the backup filename suffix.

### Content Escaping

**For `create`**: Newlines in the `content=` parameter must be escaped as literal `\\n`.

```typescript
const escaped = content.replace(/\n/g, "\\n")
```

**For `append`**: Same newline escaping, plus pipes inside wikilinks must be backslash-escaped to prevent the CLI from interpreting them as display-text separators:

```typescript
// hooks/lib/text.ts:274-276 — escapeForObsidianAppend()
content.replace(/\n/g, "\\n").replace(/\[\[([^\]]*?)\|([^\]]*?)\]\]/g, "[[$1\\|$2]]")
```

### Append to Non-Existent File

`append` on a file that doesn't exist returns `Error: File "..." not found.` in stdout (with exitCode 0 from the CLI). It does not create the file.

**Workaround**: Create the file first with minimal content, then append:

```typescript
// hooks/lib/obsidian.ts:189-192
runObsidian(["create", `path=${pathWithExt}`, "content= "], vault)
runObsidian(["append", `path=${pathWithExt}`, `content=${escaped}`], vault)
```

### No `mkdir` Command

There is no command to create directories. The `create` command creates parent directories automatically.

**Workaround**: Create a placeholder file (auto-creates parent dirs), then delete it:

```typescript
// hooks/lib/obsidian.ts:152-155 — ensureVaultDir()
runObsidian(["create", `path=${dirRel}/placeholder.md`, "content=placeholder", "silent"], vault)
runObsidian(["delete", `path=${dirRel}/placeholder.md`, "permanent"], vault)
```

### No Directory Deletion

The CLI can only delete files, not directories. After deleting all files in a folder, empty directories remain on the filesystem. Empty dirs are not tracked by the vault index, so they are safe to remove directly with `rmSync`.

```typescript
// hooks/e2e-test.ts:957-961
// Clean up empty directory shell left after CLI file deletions
if (existsSync(planDirAbsolute)) {
  rmSync(planDirAbsolute, { recursive: true })
}
```

### `folders` and `files` Return All Descendants

Both commands return the full recursive tree, not just immediate children. You must filter by path depth to get only direct children.

```typescript
// hooks/lib/obsidian.ts:80-88 — listVaultFolders()
const depth = folderRel.split("/").length + 1
return result.stdout.split("\n").filter((line) => {
  if (!line?.startsWith(prefix)) return false
  return line.split("/").length === depth
})
```

### Always Use `path=` for Programmatic Access

The `file=` parameter resolves by name like wikilinks. If multiple files share the same name in different folders, resolution is ambiguous. Always use `path=` with the full vault-relative path for deterministic behavior.

### `property:set` List Values

When setting a `type=list` property, provide values as comma-separated. When reading back with `property:read`, values are returned newline-separated.

```typescript
// Setting: comma-separated
setVaultProperty(path, "tags", "tag1,tag2,tag3", "list", vault)

// Reading: newline-separated
const raw = readVaultProperty(path, "tags", vault)
const tags = raw.split("\n").filter((l) => l.trim())
```

### Non-`.md` Files (`.base`) Work With `create`/`read`/`delete`

The file-operation commands are not limited to markdown. Verified against `.base` files (Obsidian Bases):

```
obsidian vault=V create path=Claude/Bases/foo.base content=... silent      # creates the .base file verbatim
obsidian vault=V create path=Claude/Bases/foo.base content=... overwrite   # replaces it
obsidian vault=V read   path=Claude/Bases/foo.base                          # returns content
obsidian vault=V delete path=Claude/Bases/foo.base permanent                # deletes it
obsidian vault=V files  folder=Claude/Bases                                 # lists it
```

The `create` command does not append `.md` when the path already has an extension. Used by `lib/bases.ts` to manage plugin-owned `.base` files. Note that `read` output passes through `runObsidian`, which trims whitespace — compare trimmed content when checking for drift.
