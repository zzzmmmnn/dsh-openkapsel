# dsh-openkapsel

[![CI](https://github.com/zzzmmmnn/dsh-openkapsel/actions/workflows/tests.yml/badge.svg)](https://github.com/zzzmmmnn/dsh-openkapsel/actions/workflows/tests.yml)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/zzzmmmnn/dsh-openkapsel)

OpenKapsel workspace bridge for the **DeepSeek Harness**. It turns a remote
OpenKapsel workspace into model-visible tools: supply the read-only workspace
URL ending in `/w/<READ_TOKEN>` and its matching control token, and the agent
can list/read/write files, run Shell tasks, and call the other OpenKapsel REST
surfaces. The model has no host filesystem or host Shell tool in the bundled
remote-only preset.

The bridge reuses the workspace-published `openkapsel-rest` skill's Python
helpers (`openkapsel_http.py` and `openkapsel_config.py`), vendored under
`skill/`. Each `kapsel_*` tool invokes one of those two fixed scripts through
the harness host Shell service. The model cannot choose the script or use that
service as a Shell tool. Authentication, Context attribution
(`plan_id`/`taskname`/`message`), REST error decoding, and credential renewal
stay owned by the maintained skill code. Every helper subprocess receives an
explicit DSH `workspace-write` policy rooted at that agent's private state
directory; the executor also controls any platform temporary-directory access.

## Compatibility and permissions

| Area | Requirements and scope |
|---|---|
| DSH | Tested with DSH `0.1.2-rc.1`, the `web` profile, and the bundled **OpenKapsel Remote** preset. The preset's persona field was updated for DSH `0.1.5-rc.2`; an existing session's command picker was confirmed working after the update. Other profiles are not verified. |
| Node.js | Package declares `>=18`; the test matrix covers Node.js 22 and 24. Use a version supported by your DSH installation; Node.js 18 is not covered by this project's CI. |
| Python | Python 3.10+ on the Host's `PATH`: `python` on Windows, `python3` on macOS/Linux. The test matrix covers 3.10 and 3.14. |
| Host platform | macOS/Linux use DSH's Bash executor; Windows uses DSH's PowerShell executor without Bash. GitHub installation and Host startup verified on macOS. Windows installation and actual plugin use confirmed by user testing (2026-09-09). Linux/Windows automated tests are configured in CI. |
| External service | Requires a reachable, user-selected OpenKapsel Server and its Workspace URL/control token. Requests and their supplied file contents or commands are sent to that server. |
| Local access | Runs fixed Python helpers through DSH's Shell service and writes session credentials under `$DSH_HOME/state/dsh-openkapsel` (default `~/.dsh/state/dsh-openkapsel`). Model-facing host file/Shell tools and `run_code` are denied. |
| Credentials | Stores the read URL and control token under the user's DSH state directory. Unix uses `0600` files and `0700` directories; Windows relies on the containing user directory's ACL (chmod does not enforce Unix permissions there). Automatic renewal may replace stored credentials. |
| Remote permissions | Can read, modify, and run Shell commands within the remote token's grants. Typed tools are conveniences; the server enforces authorization for generic REST calls too. |
| DSH policy | `read-only` denies remote mutations and Shell; a one-call approval may authorize a retry. `workspace-write` and `danger-full-access` both remain bounded by the remote token. |
| License | [MIT](LICENSE). This is a community plugin, not an official DeepSeek product. |

## Why the internal transport remains Python

An installed Cordis package could implement the transport in Node. This bridge
keeps Python because the existing helpers already own renewal, authentication,
error decoding, and Context merging. Reusing them avoids a second protocol
implementation that could drift as OpenKapsel evolves. This does not grant the
model a local Shell: script paths are plugin-owned constants and arguments
travel as JSON on stdin to a fixed Python bootstrap.

Requires `python` on Windows or `python3` on macOS/Linux on `PATH`.

## Layout

```text
index.js                Host-side Cordis plugin and typed remote tools
bundle.js               Profile bootstrap that installs only the preset
cordis.patch.yml        DSH bundle entry point (no global tool guard)
preset-install.js       Shared, update-safe preset installer
skill/openkapsel-rest/  Vendored REST skill and fixed Python helpers
preset/kapsel/          Remote-only agent preset shown in DSH's mode picker
bin/install-preset.js   Installs the preset into the DSH user preset root
cordis.example.yml      Annotated bridge row
tests/                  Tool-catalog and remote-isolation tests
```

## Install

Install from GitHub into the DSH `web` profile:

```bash
dsh plugin --profile web add github:zzzmmmnn/dsh-openkapsel
```

No manual symlink or local source checkout is required. DSH manages the package
as a profile dependency. Its `dsh.bundle` patch loads a lightweight bootstrap
when the profile starts. The bootstrap installs the OpenKapsel Remote preset;
it does not register tools, enable the remote-only guard, or change the default
preset. Tools and the guard load only when you select OpenKapsel Remote.

Untouched package-managed presets update automatically on startup. Existing
identical manual installations are adopted. Locally modified presets are
preserved and reported instead of overwritten. To explicitly replace one:

```bash
dsh plugin --profile web exec dsh-openkapsel-install-preset --force
```

The target is `$DSH_HOME/.agent-presets/kapsel`, or
`~/.dsh/.agent-presets/kapsel` when `DSH_HOME` is unset. Restart DSH. New sessions can then
select **OpenKapsel Remote** beside the shipped modes. Existing non-empty
sessions keep their original preset. Supply your OpenKapsel Workspace URL and
matching control token through `kapsel_config` to connect the remote workspace.

The installer command without `--force` remains available for manual setup.
Removing the package does not delete the copied preset or session credentials.
After uninstalling, remove `$DSH_HOME/.agent-presets/kapsel` if no other profile
uses it. The preset root is shared by profiles using the same `DSH_HOME`.

Version 0.7.1 changes the bundled preset's persona field from `text` to
`prefix`, as required by DSH `0.1.5-rc.2`. The old field can prevent existing
OpenKapsel sessions from mounting after a DSH upgrade. Restart DSH after
updating the plugin so the bootstrap can refresh an untouched installed preset;
if you customized that preset, use the `--force` installer command above only
when you intend to replace your changes.

Version 0.7.0's packed bundle was installed into a fresh temporary DSH profile
on macOS: profile composition, Web Host startup, and automatic preset creation
passed without changing the default `standard` preset. The new bootstrap also
has automated installation, update, customization-preservation, and isolation tests.

The earlier GitHub installation and profile-scoped installer were verified locally;
the installed package passed its tests and the DSH web Host started
successfully on macOS. Windows installation and actual plugin use were also
confirmed by user testing on 2026-09-09. On Windows, run these same commands from PowerShell;
ensure `python --version` resolves to Python 3.10 or newer. Bash is not required.

## Remote-only preset

Select **OpenKapsel Remote** in the DSH preset picker:

<img src="screen_shot.png" alt="DSH preset picker with OpenKapsel Remote selected and its English description visible" width="600">

Do not add `dsh-openkapsel` to `standard` or `minimal`: both expose host-local
tools. The bundled preset intentionally omits host Bash/PowerShell,
filesystem/search/editor, job control, local `AGENTS.md` discovery, and local
skill discovery. It retains only the OpenKapsel bridge plus `skill`,
`ask_user_question`, and `todo_write`.

The plugin also installs a fail-closed tool guard. Accidentally composing an
undeclared or local tool therefore causes execution to be denied even if a
future preset edit makes that tool visible to the model. DSH's optional
`run_code` presentation transport is denied. Remote-only mode explicitly selects
native tools, so model-authored code is not executed through a host code runtime.

### DSH sandbox-mode mapping

The bridge resolves the current policy from `ctx.sandboxPolicy` for every tool
call:

| DSH mode | Remote OpenKapsel behavior |
|---|---|
| `read-only` | Allows configuration, status, Discovery, filesystem reads, and generic `GET`/`HEAD`; denies remote mutations and Shell execution |
| `workspace-write` | Allows every capability granted by the OpenKapsel token |
| `danger-full-access` | Same bridge behavior as `workspace-write`; it never widens the OpenKapsel token |

A denied mutation can be retried with a one-call approval request:

```json
{
  "sandbox_permissions": "workspace-write",
  "justification": "Update the requested remote configuration file once."
}
```

The plugin delegates the request to DSH's approval service before contacting
the remote mutation endpoint. Approval does not change the session's durable
sandbox mode. Rejection, cancellation, a missing approval channel, malformed
fields, and non-widening requests all fail closed.

The bridge row inside the bundled preset is:

```yaml
- id: tool-kapsel
  name: 'dsh-openkapsel'
  config:
    taskname: dsh
    enforceRemoteOnly: true
```

`dsh-openkapsel` consumes the host `shell`, `tools`, `skills`, and `sandboxPolicy` services and
publishes none. Mount it in the dedicated agent preset, not globally.

## Usage

1. `kapsel_config(workspace_url, control_token)` stores credentials in this
   DSH session's private plugin state, then selects or creates an active root
   Plan for mutation attribution. Re-run it to switch workspaces or rotate
   credentials.
2. `skill("openkapsel-rest")` loads the authoritative REST reference before
   nontrivial operations.
3. Operate through the remote tools:

| Tool | Purpose |
|---|---|
| `kapsel_config` / `kapsel_status` | Configure or inspect the active workspace |
| `kapsel_plan_update` | Update, reparent, cancel, or complete a Plan with a structured debrief |
| `kapsel_fs_list` / `kapsel_fs_read` / `kapsel_fs_stat` | Read-side filesystem |
| `kapsel_fs_write` / `kapsel_fs_replace` | Remote text write/edit |
| `kapsel_shell_exec` / `kapsel_task_output` | Run a Shell task on the server or a mapped client and poll its output |
| `kapsel_mappings` | List mapped client directories, online status, and advertised execution/RPC capabilities |
| `kapsel_archive` | Browse ZIP/tar archives or read a bounded member without extracting; mapped archives use client RPC |
| `kapsel_rpc` | Unified dynamic mapping RPC entry: inspect each operation's schema, `write`, and `execution`; sync returns directly, task returns a persistent client task id; writes use DSH approval + Plan/Context and require a writable mapping |
| `kapsel_fs_copy` / `kapsel_fs_move` / `kapsel_transfer` | Copy or move across workspace and client storage, then inspect/cancel/resume asynchronous transfers |
| `kapsel_recycle` | List, restore, or explicitly purge an item in the selected storage root |
| `kapsel_client_task` | List/start legacy client Shell tasks and inspect/interrupt/kill unified client task ids returned by `kapsel_rpc`/`kapsel_shell_exec`; RPC tasks do not accept stdin |
| `kapsel_http` | Context, Memory, sharing, preview, schedules, and other REST surfaces |

For client mappings, first call `kapsel_mappings` and inspect the client's reported platform and sandbox mode. `kapsel_client_task` takes an `argv` array and a client export-relative `cwd`; it does not use the server Shell. Client task output is returned as base64 with a `next_offset` cursor. An unsandboxed client task has that client's OS-account permissions. Mutating actions use the same DSH approval and OpenKapsel Plan attribution as the existing write tools. The bundled skill's `references/mappings.md` details the REST responses and failure states.

`kapsel_shell_exec` accepts `target: "auto"` (default), `"server"`, or
`"client"`. Auto selects a connected client when `cwd` is inside its mapping
(for example `laptop/project`), otherwise the server. A missing/denied client
fails without server fallback. The client needs OpenKapsel 1.60.0+ and an
enabled writable execution mapping. Its own OS, sandbox, and limits apply;
server `/env` settings are not injected. The returned task ID works with
`kapsel_task_output` and the standard `/tasks` controls via `kapsel_http`.
Client stdout/stderr are combined in stdout; client stdin chunks are at most
16 KiB. Use `kapsel_client_task` when literal client `argv` is needed.

`kapsel_http.json` is always a JSON object. Endpoint fields belong inside it,
not beside it. Context-management endpoints are handled specially because
their `plan_id` fields describe the Context graph rather than ordinary
operation attribution; prefer `kapsel_plan_update` for Plan changes.

Each DSH agent is keyed separately by `agent.id`. Credentials live under
`$DSH_HOME/state/dsh-openkapsel/<sha256(agent.id)>/.openkapsel.env`; active Plan and
taskname values are held in an agent-keyed `WeakMap`. The local project cwd is
not used for credentials or remote-workspace selection. An absolute `stateDir`
plugin option can replace the default private state root.

For a recorded mutation, `taskname` is resolved from the current tool call,
then the selected active Plan/session value, then the value set by
`kapsel_config`, then the plugin's preset configuration, and finally `dsh`.
Empty and whitespace-only values do not suppress this fallback. The active
Plan is selected automatically when `plan_id` is omitted; selecting a
persisted Plan after a Host restart also restores that Plan's taskname. A
missing or blank `message` receives a short default operation message.

## Security notes

Typed tools are convenience wrappers, not an additional permission boundary.
`kapsel_http` exposes the REST surfaces available to the selected credential;
the remote server enforces endpoint, path, and capability authorization. DSH
read-only mode additionally denies mutating HTTP methods and Shell execution.
This assumes that GET/HEAD endpoints honor read semantics; project application
routes implement their own behavior and authorization.

The current DSH Shell service accepts a command string, not an argv array.
The bridge sends helper paths and arguments as ASCII JSON on stdin to a fixed
Python bootstrap. Model input never enters the Host Shell command text. NUL
arguments are rejected. Generated tests round-trip quotes, newlines,
substitutions, backslashes, empty strings, and Unicode through Bash on Unix and
PowerShell 7/Windows PowerShell 5.1 on Windows. Helpers retain their DSH sandbox
policy, and their exit codes propagate through PowerShell.

Version 0.5.0 renames the package, installer command, and default state directory
to `dsh-openkapsel`. Reinstall the preset and initialize credentials again after
upgrading. To reuse an existing private state directory, explicitly configure
`stateDir` to that directory. Tool names (`kapsel_*`) and the `kapsel` preset ID
remain stable.

## Development checks

Run `npm ci` and `npm test`. GitHub Actions checks Node.js 22/24 with Python
3.10/3.14 on Linux and Windows, including helper argument round-trip and remote
permission tests.

## Operational notes

- The control token is stored only in the session-private credential file with
  Unix mode `0600` (Windows uses inherited directory ACLs). Neither the token nor its host-private path is returned in tool
  results.
- The read token in the workspace URL is read-only; the control token unlocks
  writes, Shell, Context, Memory, and sharing.
- Every mutation is attributed to an active Plan with a `taskname` and
  `message`.
- Tokens go only to the workspace origin or documented transfer paths, never to
  preview or public-share URLs.
- The model-facing guard permits only `kapsel_*`, `skill`,
  `ask_user_question`, and `todo_write`.

## Verification

```bash
npm test
```

The tests assert that the bundled preset contains no local Shell/filesystem
provider and run two simulated DSH agents against separate HTTP workspaces. The
integration test verifies that each remote workspace receives only its own
write, the local sentinel remains unchanged, and credentials exist only under
the private state root.

## Read-only RPC tools

Version 0.9.0 adds `kapsel_git` (status/diff/diff_stat/log/show/ls_files),
`kapsel_fs_read_many`, `kapsel_fs_manifest`, and `kapsel_fs_search`.
Requires OpenKapsel with RPC-plugin task support (commit `95392b5` or a later
release) for this contract. Git read operations remain independent of
Shell/client execution permission and use bounded sanitized snapshots. Git
`add`, `commit`, `restore`, and `checkout` are advertised as
`write=true, execution=task`; Archive `create` and `extract` use the same
persistent task model. `kapsel_rpc` is the single dynamic mapping-RPC entry
point: `kapsel_mappings` publishes each family description plus each operation's
`description`, JSON `input_schema`, boolean `write`, and `execution`
(`sync` or `task`). A task operation returns a unified
`client.<mapping>.<task>` id immediately; poll it with `kapsel_task_output`
or inspect/control it with `kapsel_client_task`. The task survives provider
disconnect/reconnect while the client process stays alive. Never replay an
uncertain write-task start; reconnect and query/list the returned or candidate
task id instead. `write=true` still uses DSH approval plus OpenKapsel
Plan/Context and requires the mapping to be administratively writable.
`kapsel_archive` remains a read-preview convenience tool for local or mapped
archives; Archive create/extract use `kapsel_rpc`.

The generic HTTP tool recognizes POST `fs/read_many` and `fs/manifest` as
read-only. For `mappings/<24-char-id>/rpc/<family>/<operation>`, it consults
the live operation `write` metadata: reads bypass mutation approval, while writes
use approval and Plan attribution. Archive preview uses GET `archive/list` and
`archive/read`. Other POST operations retain their existing guard. Query values
may be arrays to send
repeated parameters, e.g. `include: ["*.py", "*.js"]` or `file: ["a", "b"]`.
The vendored REST skill is synchronized with the main OpenKapsel project. Mapping RPC replies default to a 90-second server deadline; the bundled HTTP helper waits 120 seconds and the DSH helper process budget is 130 seconds, so the wrapper does not normally time out before the server.

## Client reconnects and portable text

The bundled REST references track OpenKapsel 1.60.1. Reconnect persistence needs
client 1.58.0+; explicit text codecs and literal newline handling need server
1.59.0+ and client file API v3 for direct mapped RPC.

A network disconnect does not stop tasks in the running client process.
Reconnect and list/query the original task IDs to retrieve output and exit
status, including tasks that completed offline, or to send stdin/interrupt/kill.
Deadlines continue offline. Uncollected results remain in bounded client memory;
the registry limit is max_tasks + 4. Reading through completed output marks a
result collected; collected results have one-hour/four-record retention and may
be evicted earlier for capacity. Client process restarts do not restore tasks.
Do not automatically replay a start whose response was lost.

Text APIs default to UTF-8 without using the host locale. For a non-default
encoding use `kapsel_http`: pass `encoding` in the `query` for GET `fs/read`,
in `json` for POST `fs/read_many`, `fs/write`, or `fs/replace`, and in each
`json.items[]` entry for `fs/replace/batch`. Typed file tools still use their
existing default encoding; they do not expose this new field.

Supported codecs include UTF-8/BOM, explicit-endian UTF-16, Big5, GBK/GB18030,
Windows-1252, Latin-1, ASCII, and Shift-JIS. See the bundled files reference for
exact codec names and BOM rules. There is no guessing or lossy conversion.
LF, CRLF, and CR remain literal: exact replacements must match original endings,
and new text chooses its own endings. UTF-8-only byte cursors and search retain
their existing restrictions.

## RPC-first mappings (OpenKapsel 1.61.0+)

`kapsel_mappings` may report `online: true` and `mounted: false`: this is normal.
Use file, search, copy/transfer, archive and RPC tools directly; never mount a
mapping or run a Shell command just to make those interfaces work. Static preview
also uses RPC. Keep the default `target: "auto"`: a mapped cwd executes on its
client without a server mount; other working directories execute on the server.

For intentional server execution, the cwd mapping is automatic. Declare other
native filesystem dependencies with the optional `mount_mappings` array of at
most 256 non-empty workspace mapping names or IDs:

```json
{
  "command": "python laptop/project/main.py",
  "cwd": ".",
  "target": "server",
  "mount_mappings": ["laptop"]
}
```

Pass this to `kapsel_shell_exec`, or put it in `kapsel_http.json` for POST
`shell/exec`. The field does not change auto placement, and non-empty dependencies
are invalid for client execution. Both routes retain normal write approval and
Plan/Context attribution. Do not parse commands to guess dependencies or default
to mounting every mapping.

FastAPI's extra native dependencies belong in the application's
`api/mappings.json`, for example `{"mount_mappings":["datasets"]}`. Its containing
mapping is automatic. Mount leases follow the task or API worker, not one HTTP
request; ordinary file operations never use FUSE fallback. A server may disable
native mounts while leaving file/RPC and client execution available.

Current clients always enable core file RPC: **rpc.file has been removed**;
remove that key from older client configurations. Upgrade both client and server
for `file_stream` metadata. Treat `unavailable_mappings`, `truncated`, and
unavailable tree/manifest nodes as incomplete results, not missing files. After
a timeout, cancellation or lost write/start response, inspect existing tasks and
affected paths; never automatically replay the command or RPC mutation.

The bundled skill's mappings, Shell and web/application references document the
contract. Runtime Discovery remains authoritative for server-version differences.

### Shell startup request timeout

The plugin setting `shellRequestTimeoutSeconds` controls the HTTP wait for the
initial Shell-start response, including lazy native-mount setup. It defaults to
120 seconds and accepts finite numbers from 1 to 3600. Configure it in the DSH
composition row, not in the tool's request JSON:

```yaml
- id: tool-kapsel
  name: 'dsh-openkapsel'
  config:
    taskname: dsh
    enforceRemoteOnly: true
    shellRequestTimeoutSeconds: 300
```

Both `kapsel_shell_exec` and generic POST `shell/exec` calls use this setting.
The Python HTTP request uses that timeout; the host helper watchdog adds 10
seconds (130 seconds by default). Credential discovery/renewal and harness or
reverse-proxy limits may impose their own bounds; this is not a guarantee that
every setup completes within the configured time. Other endpoint budgets are
unchanged. A tool's `timeout_seconds` is the remote task execution deadline and
is deliberately independent. A failed startup request is never automatically
retried; its error reminds the model that timeout/cancellation does not prove the
remote task stopped and that `/tasks` must be inspected before any retry.

## Structured configuration and large tables

Use `kapsel_mappings` to inspect the client's `structured` and `tabular` schemas,
then call `kapsel_rpc`. Structured JSON/YAML/TOML edits use conditional atomic
write/patch tasks; CSV/Excel operations are read-only, including asynchronous
`tabular.scan`. CSV pages use authenticated seek cursors, not repeated row-offset
scans. Segment scans return explicit progress/continuation and must not be
mistaken for complete whole-file aggregates. Format availability depends on
optional libraries installed on the mapping client. No FUSE is needed.

The bundled `openkapsel-rest` skill includes `references/data-rpc.md`.

## Atomic plan batches

On a server advertising `capabilities.context.plan_creation.atomic_subplans`,
use `kapsel_http` once with `method: "POST"`, `endpoint: "context"` and `json`
containing `type: "plan"`, `taskname`, `content`, optional `request_id`, and
`subplans: [{"ref":"code","content":"Implement"},{"ref":"tests","content":"Verify"}]`.
The response returns the parent `id` and every child's `id`/`plan_id`/`ref`.
Pass a returned child ID to subsequent mutation tools; no extra Plan creation is
necessary. Do not put endpoint fields beside `json`.

The server creates the complete batch atomically. Reuse the same `request_id`
and request only to recover an uncertain response, not to start new work. The
plugin does not automatically replay failed writes or change its approval policy.
See the bundled Context reference for direct-child limits and idempotency rules.

## OAuth browser consent is separate from this REST bridge

OpenKapsel OAuth-capable MCP clients use the independent browser consent page. A user verifies ownership there with the current control token for the exact linked configuration; administrator login is not required. This plugin continues using its existing REST credentials and never submits them to a browser form or client callback. OAuth access/refresh credentials remain separate from REST credentials. Updating server consent does not require a new plugin transport or new tool.
