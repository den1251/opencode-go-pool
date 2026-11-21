# opencode-go-pool

Multi-account pool for **OpenCode Go** in OpenCode 2.x (CLI and Desktop).

License: MIT

- Rotates between accounts in a persistent order: one account is used until its Go allowance is drained, then the next.
- Reads the exact account-level usage percentage from OpenCode's own Go API: `GET https://opencode.ai/zen/go/v1/usage` (`rolling` / `weekly` / `monthly`, each with `status`, `percent`, `resetsAt`). This is an API call, not page scraping.
- Tracks local tokens and cost per person, per account and per model, stored only on the machine where the plugin runs.
- Shows the data as a terminal table and an optional local dashboard.
- Supports clearing and exporting local usage.

## What is exact

| Measurement | Exact? | Source |
|---|---|---|
| Account quota used (5h / week / month) | Yes | Go usage API |
| Tokens used by this OpenCode installation | Yes | `usage.opencode.tokens` in the HTTP response, with `session.step.ended` as fallback |
| Exact list cost for a request | Yes | `usage.opencode.list_cost` |
| Exact amount charged | Yes | `usage.cost` (`0` inside a Go allowance) |
| Go plan allowance consumed | Yes | `usage.opencode.allowance` |
| Billing source | Yes | `usage.opencode.billing_source` |
| Cost for a response with no `opencode` block | Estimate | model catalog price × tokens |

The plugin reads the raw response body for every successful `opencode-go` request. It handles a plain JSON body and a streaming SSE body, taking the final usage object. For a stream, this does not delay the response: the original body is returned to OpenCode and a clone is parsed in the background.

When the exact `opencode.list_cost` is present, it is used as the entry's `cost`, and `estimated` is `false`. The catalog estimate is only a fallback for responses that do not report OpenCode-specific usage.

`opencode.allowance` is the plan-dollar amount the request counted toward the Go limit. Summing it per machine gives that machine's exact consumed share for captured requests. The account-wide `/usage` percentages remain the authoritative account total.

## Install

Requires OpenCode 2.x. V1 is not supported. Node 20 or newer is needed for the CLI; the plugin itself runs inside OpenCode.

### Recommended: install from npm

```bash
npx opencode-go-pool install
```

The installer gives you an interactive menu:

1. install the plugin into OpenCode
2. uninstall it
3. show the installation status
4. quit

After installation, restart OpenCode. The plugin is added to OpenCode's global `plugins` list, which is required for HTTP hooks in OpenCode 2.2.6. Do not use a plugin-directory symlink: auto-discovered plugin directories run commands and events, but do not receive the `http.request` / `http.response` hooks this plugin needs.

Non-interactive:

```bash
npx opencode-go-pool install --yes
```

If OpenCode is already running as a background service, restart it:

```bash
opencode service restart
```

Desktop reads the same global config; restart the desktop app instead.

### Install the CLI globally

Installing the plugin through OpenCode puts it in OpenCode's plugin cache, not in the global npm prefix, so it does not add `opencode-go-pool` to `PATH`. Install the CLI separately:

```bash
npm install -g opencode-go-pool
# or
bun add -g opencode-go-pool

opencode-go-pool install
opencode-go-pool uninstall
```

Without a global install, use `npx opencode-go-pool status` instead.

If npm's global prefix is system-owned (for example `/usr`), install into a user prefix and make sure its `bin` directory is on `PATH`:

```bash
npm install -g --prefix ~/.local opencode-go-pool
```

### Update

The plugin and the CLI are installed separately and update separately:

```bash
opencode plugin check opencode-go-pool
opencode plugin update opencode-go-pool

bun add -g opencode-go-pool@latest
```

Restart OpenCode after updating the plugin.

### Local development

```bash
git clone https://github.com/den1251/opencode-go-pool.git
cd opencode-go-pool
bun install
bun run build
```

Point OpenCode at the checkout while developing:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-go-pool"]
}
```

A configured absolute directory works; an auto-discovered `~/.config/opencode/plugin` symlink does not provide the HTTP hooks on OpenCode 2.2.6.

## Accounts

The plugin does not ask for or store keys itself. It discovers credentials already known to OpenCode:

- `opencode-go` API-key connections, and
- `opencode` Console OAuth connections (the normal OpenCode Console login used for Go).

Add accounts with OpenCode's own UI or CLI:

```bash
opencode auth login opencode-go
```

In Desktop, use the provider's **Add account** flow. The plugin notices new credentials through `credential.updated` / `integration.updated` and begins using them without a restart.

Accounts with the same Console workspace (`orgID`) are treated as one account, because the Go allowance is workspace-wide. Different workspaces and different API keys are separate accounts.

The first usable account in the persistent order is active. New accounts are discovered newest-first, so the account currently active in OpenCode is preferred on first run. `opencode-go-pool use <n|id|label>` changes it. When the active account reaches 100% in any window (or Go returns `429`), the next usable account is selected and persisted.

## Display

```bash
opencode-go-pool status          # table
opencode-go-pool status --json   # machine-readable
opencode-go-pool accounts        # account list
opencode-go-pool url             # dashboard URL
opencode-go-pool open            # open the dashboard
```

Inside OpenCode, the plugin works without any command. Run the CLI in a terminal for status.

The table lists every model separately for today and for the current month, with requests, input/output tokens, list cost and Go plan usage per model. Today's model table is omitted when its totals are identical to the month's.

Each `status` run recomputes today's and the month's usage from `events/`, so it stays correct when several OpenCode processes or plugin instances write events at the same time.

### OpenCode TUI

The TUI part is on demand and adds no persistent footer or status text. Run `/go-pool` or pick **Go pool usage** in the command palette to open the usage table.

### OpenCode Desktop

The GUI part is on demand and adds no composer pill or other always-visible indicator. Open the **Go Pool** side panel from the session panel **+** menu or with `/go-pool`. The panel shows account quotas, today and month totals, per-model usage, and a **Refresh** button.

Both views fetch usage when opened; there is no background polling and no passive usage text.

The server, TUI and GUI parts ship in one package; installing the plugin is enough. The GUI part loads only in OpenCode Desktop, not in the browser client.

The optional dashboard is a local HTTP page on `127.0.0.1` with a random token in the URL. It is off by default; enable it with `"dashboard": true` in the plugin options. It shows account quota bars, active account, per-model tokens, list cost and Go plan usage, and recent switches. It is read-only except for **Refresh quota** and **Clear all local usage**.

## Local-only data

This is a per-PC ledger. There is no account splitting, user profile or upload. All usage files stay in the local data directory; the dashboard is opt-in and binds to `127.0.0.1` only.

The ledger is stored only on this PC. It is not uploaded anywhere, and there is no per-person split or account-sharing calculation. `clear` without a filter clears all local usage on this PC.

## Clear local usage

```bash
opencode-go-pool clear                     # all local usage on this PC (asks for confirmation)
opencode-go-pool clear --today             # today
opencode-go-pool clear --month 2026-11     # November 2026
opencode-go-pool clear --account 2         # one account
opencode-go-pool clear --all --yes         # every local entry on this machine
```

The dashboard's **Clear my usage** button deletes all local usage on this PC. Clearing local usage never changes the account's Go quota.

## Export

```bash
opencode-go-pool export --json
opencode-go-pool export --csv --out /tmp/opencode/go-pool-usage.csv
opencode-go-pool export --month 2026-11 --csv
```

Each machine exports its own ledger. There is no central server and no upload.

## Where data lives

The data directory is native per OS:

| OS | Default |
|---|---|
| Linux | `~/.local/share/opencode-go-pool/` (or `$XDG_DATA_HOME/opencode-go-pool/`) |
| macOS | `~/Library/Application Support/opencode-go-pool/` |
| Windows | `%APPDATA%\opencode-go-pool\` |

Set `OPENCODE_GO_POOL_DIR` or the `dataDir` option to override it.

```
status.json       current snapshot (accounts, quota, aggregates)
accounts.json     persistent account order and active account
quota.json        last quota response per account
cooldown.json     429 cooldowns
events/           one JSON file per usage event
machine.json      stable machine ID included in exports
dashboard.json    dashboard URL/token/pid
plugin.log        plugin log
switches.json     recent account switches
```

All files are created with owner-only permissions.

## How it works

1. `session.hook("http.request")` runs for `opencode-go` requests. It selects an account, rewrites `Authorization` (and the org header for Console accounts), and stores a replayable request template.
2. `session.hook("http.response")` returns every successful response unchanged, but clones its body and parses the final usage object. For a `429` it marks the account, selects the next one, retries the same request, and captures the retry response's usage on the successful account. If every account fails, it returns a `429` with a clear message.
3. Quota is refreshed on demand: before a request when the cached snapshot is older than `refreshSeconds`, and after a successful response. There is no background quota polling loop.
4. `session.step.ended` supplies the step boundary and a fallback `cost` / `tokens`. The raw response provides the exact `list_cost`, `allowance`, `billing_source` and billed tokens. The event itself does not carry a model, so the model and account come from the matching HTTP request context, shared across plugin instances by data directory.
5. The raw response is matched to the step by session, request kind and model. A global claim ensures one event is written once even when OpenCode activates several plugin locations.
6. A response whose raw cost fields are absent falls back to OpenCode's reported cost, then to the model catalog estimate.

## Usage accounting

Each completed step writes one JSON file to `events/`, named `<UTC day>__<event ID>.json`:

```json
{
  "id": "evt_...",
  "ts": 1794322562184,
  "day": "2026-11-10",
  "machineID": "mch_...",
  "accountID": "cred_...",
  "accountLabel": "Personal",
  "providerID": "opencode-go",
  "model": "deepseek-v4.1-flash",
  "modelName": "DeepSeek V4.1 Flash 1017",
  "cost": 0.00412,
  "listCost": 0.00412,
  "allowance": 0.003,
  "charged": 0,
  "billingSource": "go",
  "metering": "response",
  "estimated": false,
  "tokens": {
    "input": 17300,
    "output": 3,
    "reasoning": 0,
    "cacheRead": 0,
    "cacheWrite": 0
  },
  "sessionID": "ses_..."
}
```

Token meanings follow OpenCode's `TokenUsage.Info`:

| Field | Meaning |
|---|---|
| `input` | non-cached input tokens |
| `output` | visible output tokens |
| `reasoning` | reasoning tokens, reported separately from visible output |
| `cacheRead` | prompt-cache read tokens |
| `cacheWrite` | prompt-cache write tokens |

The total token count is the sum of all five. The compact status line shows only `input in / output out`; use `status --json` or `export` for the complete breakdown.

The fields have these meanings:

| Field | Meaning |
|---|---|
| `modelName` | Human-readable model name from the OpenCode model catalog; older entries keep the model ID until migrated |
| `cost` | Best available value: `listCost`, then a positive `charged` amount, then the catalog estimate |
| `listCost` | Exact list value from `usage.opencode.list_cost` |
| `allowance` | Go plan dollars counted by this request |
| `charged` | Exact amount charged from `usage.cost`; `0` for Go usage inside its allowance |
| `billingSource` | `free`, `balance`, `go`, `go-plus` or `byok` |
| `metering` | `response`, `event` or `estimate`: which source produced `cost` |

`opencode.tokens.output` includes reasoning tokens, while the stored `tokens.output` is visible output only. The parser subtracts `reasoning` so the two are not double-counted.

Cost fallback order:

1. exact `listCost`
2. positive `charged`
3. catalog estimate

The catalog estimate is:

```
input × inputPrice
+ (output + reasoning) × outputPrice
+ cacheRead × cacheReadPrice
+ cacheWrite × cacheWritePrice
```

Prices are USD per million tokens from the `opencode-go` model catalog. The pricing tier is selected by the request context size (`input + cacheRead + cacheWrite`). The entry is marked `estimated: true` only when this fallback is used.

Aggregation scans the event files for the requested UTC day or month prefix, then sums cost, list cost, allowance and all five token counters per account and model. `status.json` is only a derived snapshot; the event files are the source of truth. Events older than 120 days are pruned at startup.

Known limits on OpenCode 2.2.6:

- Only successful `session.step.ended` events are recorded. `session.step.failed` is ignored.
- `session.usage.recorded` is not exposed by 2.2.6, so title, compaction and generate calls are not in the ledger.
- Day and month buckets are UTC, not the machine's local timezone.

## Configuration

Plugin options are passed through the OpenCode config entry:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-go-pool",
      "options": {
        "switchAtPercent": 100,
        "refreshSeconds": 60,
        "dashboard": false,
        "dashboardPort": 0
      }
    }
  ]
}
```

| Option | Default | Meaning |
|---|---|---|
| `switchAtPercent` | `100` | Switch when any window reaches this used percentage |
| `refreshSeconds` | `60` | Quota cache lifetime |
| `dashboard` | `false` | Start the optional local dashboard |
| `dashboardPort` | `0` | Dashboard port; `0` chooses a free port |
| `dataDir` | native per-OS directory | Local state directory |
| `requestTimeoutMs` | `5000` | Quota request timeout |
| `debug` | `false` | Also print log lines to stderr |
| `usageURL` | official Go usage URL | Override for tests |
| `upstream` | `https://opencode.ai` | Override for tests |

## Publishing

For maintainers:

1. Bump `version` in `package.json`.
2. Run `bun run typecheck` and `bun test`.
3. Run `bun run build`.
4. Check the package contents with `npm pack --dry-run`.
5. Log in to npm and confirm the account:

```bash
npm login
npm whoami
```

6. Publish with 2FA. A direct publish prompts for the 2FA challenge:

```bash
npm publish
```

Non-interactive, with a current one-time code:

```bash
npm publish --otp=123456
```

If the CLI cannot complete your security-key challenge, use staged publishing instead. Staging does not require 2FA; approving does:

```bash
npm stage publish
npm stage list
npm stage approve <stage-id>
```

You can also approve the staged version in the browser on npmjs.com under **Staged Packages**.

For automated releases, configure trusted publishing (OIDC) instead of a bypass-2FA token.

`publishConfig.access` is already `public`.

After publishing:

```bash
npm view opencode-go-pool version
opencode plugin update opencode-go-pool
bun add -g opencode-go-pool@latest
```

Restart OpenCode to load the new plugin version. If the OpenCode config points at a local checkout, replace that path with `opencode-go-pool` before updating.

## License

MIT. See [LICENSE](LICENSE).
