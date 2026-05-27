# Sandboxed Claude Code on macOS

Settings files and shell functions for running
[Claude Code](https://claude.com/claude-code) inside a sandbox provided
by [sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)
— Anthropic's general-purpose process sandbox; `srt` is its CLI. These
configs require a [patched
fork](https://github.com/ubc/sandbox-runtime/tree/gs/allow-all-domains)
that adds an `allowAllDomains` flag (see *Setup* for why). All web
egress is allowed — filesystem restrictions are the primary boundary.

## Contents

| File | Purpose |
|---|---|
| `.srt-claude-denyall.json` | Restrictive posture — default-deny reads under `/Users`, explicit allow-list |
| `.srt-claude-allowall.json` | Permissive posture — default-allow reads, explicit deny-list for sensitive paths |
| `.zshrc.example` | Shell functions (`ccx`, `ccx_permissive`, `srtlog`) for zsh |
| `.bashrc.example` | Same functions ported to bash |

## The two postures

### `ccx` — restrictive (uses `.srt-claude-denyall.json`)

Denies reads under `/Users` and re-allows only the specific paths Claude
needs (`~/src`, `~/.config/gh`, `~/.gitconfig`, `~/.ssh/config`, etc).
Anything you forget to allow stays blocked. Use this when you're not
sure what Claude needs to touch and you'd rather be told.

### `ccx_permissive` — permissive (uses `.srt-claude-allowall.json`)

Allows reads broadly under `/Users` but blocks an enumerated set of
sensitive paths: `~/.aws`, `~/.gnupg`, `~/.docker/config.json`, shell
histories (`.zsh_history`, `.viminfo`, …), browser data, Slack/Signal/
iMessage caches, `~/Documents`/`~/Desktop`/`~/Downloads`, all mounted
volumes (`/Volumes`), and the enterprise/Cisco paths
(`/opt/cisco`, `/etc/krb5.conf`, …). Use this when the strict posture is
generating too much friction.

### Shared between both

- **`allowAllDomains: true`** — no DNS allow-list; everything except
  explicit denies is reachable. Requires the forked `srt` (see *Setup*
  below).
- **`deniedDomains: ["gist.github.com"]`** — explicit denies still take
  precedence over allow-all, closing one easy exfil channel via the
  general `github.com` reachability.
- **`denyWrite`** for `~/.claude/settings.json` and
  `~/.claude/settings.local.json` — closes a sandbox-escape: writes
  there install Claude Code hooks that execute *outside* the sandbox on
  the next Claude start. The auto-deny list in upstream `srt` does not
  cover this file.
- **`allowWrite`** uses `/private/tmp`, not `/tmp` — Seatbelt does not
  resolve the `/tmp → /private/tmp` symlink in `(subpath …)` allow
  rules, so a bare `/tmp` allow grants nothing. (`/tmp/claude` is
  always granted by `srt` itself regardless.)
- **`enableWeakerNetworkIsolation: true`** — needed for `gh` and other
  Go binaries to use macOS trustd for TLS verification through the
  MITM proxy.

## Setup

### 1. Install the patched `srt` from the fork

Upstream `srt` does not allow `"*"` in the domain allowlist and has no
flag to disable network filtering from a config file. Our fork adds an
`allowAllDomains: true` schema field that short-circuits the allowlist
**after** `deniedDomains` is checked.

```bash
git clone https://github.com/ubc/sandbox-runtime.git
cd sandbox-runtime
git checkout gs/allow-all-domains
npm install           # fetch build deps
npm build             # build dist/
npm install -g .      # install srt globally (goes in nvm's node bin, already on $PATH)
```

Verify the install:

```bash
which srt          # → ~/.nvm/versions/node/<ver>/bin/srt
srt --version      # → 1.0.0
```

(After step 2 below installs the config files) confirm the patched
fork is actually what got installed — upstream stock `srt` will
*silently drop* the unknown `allowAllDomains` key during schema
validation, so the only reliable test is functional:

```bash
srt --settings ~/.srt-claude-denyall.json -- \
  curl -sI --max-time 5 https://example.com/ | head -1
# HTTP/2 200 ...   → patched srt: allowAllDomains is honored
# (no output / hang) → stock srt: example.com isn't in allowedDomains,
#                       so the connection was blocked at the proxy
```

PR tracking the patch upstream:
[anthropic-experimental/sandbox-runtime#283](https://github.com/anthropic-experimental/sandbox-runtime/pull/283).
Once merged, you can skip the fork step and install the published
package: `npm install -g @anthropic-ai/sandbox-runtime`.

### 2. Copy the config files into your home directory

```bash
cp .srt-claude-denyall.json .srt-claude-allowall.json ~/
```

### 3. Wire up the shell functions

**zsh** — append the example to your `~/.zshrc`:
```bash
cat .zshrc.example >> ~/.zshrc
```

**bash** — append to `~/.bashrc` (or `~/.bash_profile` on macOS, which
is what login shells source by default):
```bash
cat .bashrc.example >> ~/.bash_profile
```

Then `source ~/.zshrc` (or open a new terminal).

### 4. Use it

```bash
cd ~/src/your-project
ccx              # strict sandbox
ccx_permissive   # deny-list sandbox
```

`srtlog` tails macOS sandbox-exec denials in real time (or pass a
number for "last N minutes" of history). Useful when something inside
the sandbox fails with EPERM and you want to know why.

## What the shell functions do

Two non-obvious things `_ccx_run` handles:

**Claude OAuth token plumbing.** Claude Code's OAuth token lives in the
macOS Keychain. The sandbox denies `~/Library/Keychains`, so Claude
can't read its own credentials from inside. The function reads the
token *outside* the sandbox, pipes it through a named FIFO into the
sandboxed shell on file descriptor 3, and Claude picks it up via the
`CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR` env var. The token bytes
never touch disk.

**`gh` token injection.** `gh` also stores its token in the Keychain.
The function extracts it via `gh auth token` outside the sandbox and
passes it as `$GH_TOKEN`. This makes read-only `gh` operations work
inside the sandbox (PR lists, issue comments, API calls). Re-auth
flows — `gh auth login`, `gh auth refresh`, `gh auth logout` — still
need to be run *outside* the sandbox, since write access to
`~/.config/gh` is intentionally not granted.

## Known gotchas

- **`gh auth login` from inside the sandbox fails.** Expected. Auth
  outside, run gh inside.
- **Tools that write directly to `/tmp/<not-claude>/...`** will hit
  EPERM despite `/tmp` (canonically `/private/tmp`) being in
  `allowWrite`. Most CLIs respect `$TMPDIR` which `srt` overrides to
  `/tmp/claude`, so this is rare in practice.
- **Bare `/tmp` in `allowWrite` is a no-op** in upstream `srt` — the
  symlink isn't resolved for subpath allows. The configs in this repo
  use `/private/tmp` to work around this. Tracked / could be a
  separate upstream patch.
- **Concurrent `ccx` sessions are isolated** via per-PID
  `/tmp/claude/ccx-<pid>` TMPDIRs. No cleanup required — `/tmp` is
  wiped on reboot.

## Using on Linux

These configs and shell functions are tested on macOS. `srt` itself
runs on Linux (via bubblewrap + seccomp), so the same patterns work
there with a few tweaks to the settings files:

- **Drop macOS-specific paths** from `denyRead`: `~/Library/*` entries,
  `/private/var/folders`, `/private/var/log/jamf.log`, `/opt/cisco`,
  `/etc/krb5.conf` (location may differ).
- **Add Linux equivalents** for the things you care about: browser/app
  data is typically under `~/.config/*` and `~/.mozilla/firefox`,
  shell histories are the same, secret stores may include `~/.config/keepassxc`,
  `~/.password-store` (pass), `~/.gnupg` (already in the list), etc.
- **`/private/tmp` → `/tmp` in `allowWrite`** — Linux has no symlink
  redirect, so the macOS-only workaround isn't needed.
- **Drop `enableWeakerNetworkIsolation` and `allowMachLookup`** — both
  are macOS-only and ignored on Linux.

For the shell functions: the `security find-generic-password` block is
macOS Keychain-specific. Claude Code on Linux stores credentials
elsewhere, so the FIFO/FD trick may not be required at all — try
running `claude` from inside `srt` first, and only add token plumbing
if it actually fails to authenticate. `srtlog` uses macOS unified
logging; replace with `journalctl -k` or your distro's audit log
viewer to see seccomp/bubblewrap denials.

A maintained Linux variant would be a welcome addition to this repo.

## Rationale for the design choices

**Why allow all egress?** Enumerating every domain Claude might need to
hit (npm, MDN, Stack Overflow, docs.rs, pkg.go.dev, every random blog
post linked from search results) is whack-a-mole. The threat model
treats *what Claude can read off disk* as the higher-value boundary;
once that's locked down, egress matters less because there's not much
sensitive to send. The explicit `deniedDomains` list catches the
specific exfil channels worth blocking.

**Why two postures instead of one?** Deny-by-default is the
theoretically-correct posture but in practice everyone's `~/` has
unexpected paths Claude wants to peek at. Having `ccx_permissive` as a
"loosen if it's getting annoying" option means people actually use the
sandbox instead of giving up and running Claude unsandboxed.

**Why fork instead of using upstream as-is?** Upstream rejects `"*"` in
the allowlist and `getDefaultConfig()` gives an empty allowlist that
means "deny all", so there is no path through the CLI to "no network
restrictions." The fork's `allowAllDomains: true` is the minimum change
needed and is additive — existing configs are unaffected.

## Future directions

`srt` has primitives this config doesn't exercise yet. Worth exploring
if/when the current posture isn't enough:

- **URL/path-level filtering.** Allow/deny today is host-only. `srt`'s
  MITM TLS termination layer (`src/sandbox/tls-terminate-proxy.ts`)
  sees full request URLs, so a future schema could block on path
  patterns — e.g. allow `github.com` but block `*/raw/*` to close a
  class of exfil the bare-domain deny misses.
- **Egress audit logging.** Even with allow-all-domains, the proxy
  observes every destination and URL passing through. Routing that to
  a log file outside the sandbox would give an after-the-fact audit
  trail of what Claude actually reached out to during a session.
- **External policy via the MITM socket.** `MitmProxyConfigSchema`
  already supports routing specific domains through an upstream MITM
  proxy over a Unix socket. A separate policy engine — secret
  detection in request bodies, keyword filtering, response inspection
  — could plug in there without modifying `srt` itself.
- **Per-tool egress policies.** `ignoreViolations` lets filesystem
  rules vary by command. Extending that idea to network would let you
  say "npm can reach `*.npmjs.org`, claude can reach everywhere" —
  tightening exfil scope where you can without losing the
  no-enumeration ergonomics elsewhere.
