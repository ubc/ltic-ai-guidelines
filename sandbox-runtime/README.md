# Sandboxed Claude Code on macOS

Settings files and shell functions for running
[Claude Code](https://claude.com/claude-code) inside
[sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)
(`srt`), Anthropic's general-purpose process sandbox. All web egress is
allowed — filesystem restrictions are the primary boundary
([why](DETAILS.md#why-these-design-choices)). Requires a
[patched fork](https://github.com/ubc/sandbox-runtime/tree/ltic-main)
of `srt` ([what it adds and why](DETAILS.md#the-fork)).

This README covers setup and day-to-day use. The reasoning, history,
and deep dives live in [DETAILS.md](DETAILS.md).

## Contents

| File | Purpose |
|---|---|
| `.srt-claude-denyall.json` | Restrictive posture — default-deny reads under `/Users`, explicit allow-list |
| `.srt-claude-allowall.json` | Permissive posture — default-allow reads, explicit deny-list for sensitive paths |
| `.zshrc.example` | Shell functions (`ccx`, `ccx_permissive`, `srtlog`) for zsh |
| `.bashrc.example` | Same functions ported to bash |
| `srt-violations.mjs` | Claude Code hook that surfaces sandbox denials into the agent's context |
| `DETAILS.md` | Design notes and deep dives behind the callouts here |

## The two postures

### `ccx` — restrictive (uses `.srt-claude-denyall.json`)

Denies reads under `/Users` and re-allows only the specific paths Claude
needs (`~/src`, `~/.config/gh`, `~/.gitconfig`, `~/.ssh/config`, etc).
Anything you forget to allow stays blocked. Use this when you're not
sure what Claude needs to touch and you'd rather be told.

### `ccx_permissive` — permissive (uses `.srt-claude-allowall.json`)

Allows reads broadly under `/Users` but blocks an enumerated set of
sensitive paths: `~/.aws`, `~/.gnupg`, `~/.docker/config.json`, shell
histories, browser data, Slack/Signal/iMessage caches,
`~/Documents`/`~/Desktop`/`~/Downloads`, `/Volumes`, and
enterprise/Cisco paths. Use this when the strict posture is generating
too much friction.

### Shared between both

- **`allowAllDomains: true`** — no domain allow-list; requires the
  forked `srt` ([details](DETAILS.md#the-fork)).
- **`deniedDomains`** — explicit denies beat allow-all:
  `gist.github.com` closes one easy exfil channel, and the port-scoped
  `*:25` / `*:587` / `*:465` entries block direct SMTP (a quiet exfil
  protocol) without giving up default-allow. Each entry has a
  **`deniedDomainReasons`** string that replaces the generic deny text
  on the violation line the agent sees
  ([details](DETAILS.md#the-violations-pipeline)).
- **`tlsTerminate: {}`** — srt's MITM proxy terminates TLS, builds its
  own trust bundle (MITM CA + host roots), and sets `SSL_CERT_FILE`,
  `CURL_CA_BUNDLE`, `CARGO_HTTP_CAINFO`, `GIT_SSL_CAINFO`,
  `REQUESTS_CA_BUNDLE` for the sandboxed process — no manual CA
  staging needed ([details](DETAILS.md#tls-inside-the-sandbox)).
- **`credentials.envVars` masks `GH_TOKEN`** — the sandbox sees a fake
  token; the proxy injects the real one only on egress to
  `github.com` / `*.github.com` ([details](DETAILS.md#gh-and-glab)).
- **`denyReadAlways`** — credential globs (`/**/.env*`, `/**/*.pem`,
  `/**/id_*`, …) that deny reads everywhere, even inside `allowRead`'d
  paths. Fork-only field; patterns need a leading `/` to be global.
  Known-safe names the globs catch by accident — `.env.example` and
  friends, `id_*.pub` — are carved back out via
  **`denyReadAlwaysExcept`** (denyall; fork `0.0.70-ltic.5`) / glob
  `allowRead` entries (allowall)
  ([details](DETAILS.md#filesystem-rule-mechanics)).
- **`denyWrite`** for `~/.claude/settings*.json` and
  `~/.claude/CLAUDE.md` — closes hook-installation persistence vectors
  ([details](DETAILS.md#filesystem-rule-mechanics)).
- **`allowWrite`** uses `/private/tmp`, not `/tmp` — Seatbelt doesn't
  resolve the symlink ([details](DETAILS.md#filesystem-rule-mechanics)).
- **`enableWeakerNetworkIsolation: true`** — required for trustd-based
  TLS verification (`gh`, Go binaries, etc.), and for the masking
  setup above ([details](DETAILS.md#tls-inside-the-sandbox)).
- **`ignoreViolations`** — suppresses benign macOS violation noise
  (sysctl `kern.*`, preferences plists, configd lookups) from the
  violations the agent sees
  ([details](DETAILS.md#the-violations-pipeline)).
- Cert-pinned / mTLS hosts break under TLS termination — exclude them
  per-domain via `network.tlsTerminate.excludeDomains`; none set here
  ([details](DETAILS.md#tls-inside-the-sandbox)).

## Setup

### 1. Install the patched `srt` from the fork

Upstream `srt` has no allow-all-egress mode and ignores glob denies
inside `allowRead` regions; the fork adds `allowAllDomains` and
`denyReadAlways` to fix both (upstream PRs
[#283](https://github.com/anthropic-experimental/sandbox-runtime/pull/283)
and [#284](https://github.com/anthropic-experimental/sandbox-runtime/pull/284)),
plus three more deltas: the CLI streams sandbox violations to a file
the agent can be shown
([pipeline](DETAILS.md#the-violations-pipeline)), unrecognized
settings keys produce a launch-time warning instead of being silently
ignored, and git-over-SSH works on macOS via an auth-capable socat
ProxyCommand ([details](DETAILS.md#the-fork)).

```bash
git clone https://github.com/ubc/sandbox-runtime.git
cd sandbox-runtime
git checkout ltic-main
npm install           # fetch build deps
npm run build         # build dist/
npm install -g .      # install srt globally (goes in nvm's node bin, already on $PATH)
```

Verify the install:

```bash
which srt          # → ~/.nvm/versions/node/<ver>/bin/srt
srt --version      # → 0.0.70-ltic.5   (the -ltic suffix confirms the patched fork)
```

Also install socat — it's what carries sandboxed SSH through the
authenticated proxy (without it srt falls back to `nc`, which can't
authenticate, and git-over-SSH stays broken):

```bash
brew install socat
```

Functional check that `allowAllDomains` is honored — stock `srt`
silently drops the unknown key (needs the configs from step 2;
`tlsTerminate` makes srt point curl at its own CA bundle, so no
`--cacert` staging is needed, [details](DETAILS.md#the-fork)):

```bash
srt --settings ~/.srt-claude-denyall.json -- \
  curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 https://example.com/
# 200          → patched srt: allowAllDomains is honored
# 000 / hang   → stock srt: the connection was blocked at the proxy
```

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

**other shells** — reuse the bashrc example via entrypoint scripts:
```bash
cp .bashrc.example ~/.claude-sandbox.bash

printf '#!/usr/bin/env bash\n source ~/.claude-sandbox.bash\n ccx "$@"\n' > ~/.local/bin/ccx
printf '#!/usr/bin/env bash\n source ~/.claude-sandbox.bash\n ccx_permissive "$@"\n' > ~/.local/bin/ccx_permissive
printf '#!/usr/bin/env bash\n source ~/.claude-sandbox.bash\n srtlog "$@"\n' > ~/.local/bin/srtlog
chmod +x ~/.local/bin/ccx ~/.local/bin/ccx_permissive ~/.local/bin/srtlog
```

### 4. Trust the sandbox MITM CA (one-time)

`tlsTerminate` means srt re-signs upstream certificates. PEM-reading
tools (curl, cargo, git, python) trust the re-signed certs via the env
vars srt sets — but tools that verify through the macOS trust store
(`gh` and other Go binaries) ask trustd, which knows nothing about
srt's CA and fails with `x509: certificate signed by unknown
authority`. Fix: `_ccx_run` generates a **persistent** CA on first
launch (`~/.config/srt/mitm-ca.{crt,key}`) and points srt at it, so
you can trust it once in your login keychain:

Run `ccx` once (any short session — the wrapper generates the CA on
first launch), then:

```bash
security add-trusted-cert -p ssl -k ~/Library/Keychains/login.keychain-db ~/.config/srt/mitm-ca.crt
```

macOS shows an authorization prompt; approving it adds the CA as
SSL-trusted **for your user only**. The private key stays on this
machine, mode 600, and is unreadable inside the sandbox (the
`/**/*.key` deny glob) — only host processes running as you could
misuse it, and those could install their own CA anyway
([details](DETAILS.md#tls-inside-the-sandbox)).

### 5. Install the violations hook

Sandbox denials are logged by the forked `srt` to a file
(`~/.local/state/srt/violations-<pid>.log`, advertised via
`$SRT_VIOLATIONS_FILE`). This Claude Code hook feeds new lines into the
agent's context after each Bash command, so a policy block reads as
policy — with its configured reason — instead of a mysterious
403/EPERM ([details](DETAILS.md#the-violations-pipeline)):

```bash
mkdir -p ~/.claude/hooks
cp srt-violations.mjs ~/.claude/hooks/
```

Then merge into the `hooks` key of `~/.claude/settings.json`:

```json
"hooks": {
  "PostToolUse": [
    {
      "matcher": "Bash",
      "hooks": [
        {
          "type": "command",
          "command": "node \"$HOME/.claude/hooks/srt-violations.mjs\"",
          "timeout": 10
        }
      ]
    }
  ]
}
```

Outside an srt sandbox `$SRT_VIOLATIONS_FILE` is unset and the hook is
a no-op, so it's safe to leave registered globally.

### 6. Use it

```bash
cd ~/src/your-project
ccx              # strict sandbox
ccx_permissive   # deny-list sandbox
```

`srtlog` tails macOS sandbox-exec denials in real time (or pass a
number for "last N minutes" of history). Useful when something inside
the sandbox fails with EPERM and you want to know why.

## Upgrading from 0.0.62

If you set this up when the fork was at `0.0.62-ltic.1`, four things
have changed since: the `srt` binary, both config files, the shell
functions, and two new one-time setup steps. In order:

1. **Rebuild and reinstall `srt`** from your existing clone of the fork:

   ```bash
   cd path/to/sandbox-runtime   # your clone of github.com/ubc/sandbox-runtime
   git checkout ltic-main
   git pull
   npm install
   npm run build
   npm install -g .
   srt --version                # → 0.0.70-ltic.5
   ```

2. **Install socat** (new dependency — carries sandboxed SSH through
   the authenticated proxy; `jq` is also used by the new shell
   functions if you don't already have it):

   ```bash
   brew install socat jq
   ```

3. **Replace both config files.** The new versions add `tlsTerminate`,
   `GH_TOKEN` masking (`credentials.envVars`), `denyReadAlways` /
   `denyReadAlwaysExcept`, `deniedDomainReasons`, and
   `ignoreViolations`. If you customized your copies (extra `allowRead`
   paths, etc.), re-apply those edits on top of the new files:

   ```bash
   cp .srt-claude-denyall.json .srt-claude-allowall.json ~/
   ```

4. **Replace the shell functions.** The wrapper now generates a
   persistent MITM CA, writes a per-launch config (ssh-agent socket +
   CA paths), and pins pnpm's store — the old block won't work with the
   new configs. Delete the old `ccx`/`ccx_permissive`/`srtlog` block
   from your `~/.zshrc` (or `~/.bash_profile`), then re-append and
   reload:

   ```bash
   cat .zshrc.example >> ~/.zshrc
   source ~/.zshrc
   ```

5. **Do the two setup steps that didn't exist in 0.62:** trust the
   MITM CA in your login keychain ([setup step 4](#4-trust-the-sandbox-mitm-ca-one-time))
   and install the violations hook ([setup step 5](#5-install-the-violations-hook)).

Then launch `ccx` as before. Quick smoke test: `gh api user` inside
the session exercises the proxy, TLS termination, keychain trust, and
token masking all at once.

## What the shell functions do

`_ccx_run` handles several pieces of plumbing on every launch:

- **Seeds Claude's credentials** — copies the OAuth credential from the
  Keychain (unreadable inside) to `~/.claude/.credentials.json`, with
  the refresh token nulled so only the short-lived access token touches
  disk ([details](DETAILS.md#credential-plumbing)).
- **Extracts `GH_TOKEN`** via `gh auth token` (the Keychain is
  unreadable inside), then hands it to srt, which **masks** it: the
  sandbox sees a fake token and the proxy injects the real one only
  toward GitHub ([details](DETAILS.md#gh-and-glab)). `glab` needs
  nothing — it reads its own config file.
- **Maintains the persistent MITM CA** — generates
  `~/.config/srt/mitm-ca.{crt,key}` on first launch so srt signs with
  the same CA every session (trusted once in the keychain, setup
  step 4) ([details](DETAILS.md#tls-inside-the-sandbox)).
- **Forwards the ssh-agent socket** so git-over-SSH and `ssh` work
  through the agent while raw private keys stay unreadable: passes
  `SSH_AUTH_SOCK` through and writes a per-launch config copy that
  injects the session's socket path (`network.allowUnixSockets` — the
  launchd path changes every login) and the CA paths
  ([details](DETAILS.md#ssh)).
- **Pins pnpm's global store** via `pnpm_config_store_dir`, preventing
  silent per-project `.pnpm-store/` fallback
  ([details](DETAILS.md#pnpm-and-uv)).
- **Per-PID `TMPDIR`** (`/tmp/claude/ccx-<pid>`) so concurrent sessions
  don't trample each other.

## Known gotchas

Each item is labelled *(both)*, *(denyall)*, or *(allowall)* for which
posture it affects.

- **Access token expires every ~8h.** *(both)* The sandbox can't
  refresh. Exit, run `claude` once in a normal terminal, relaunch
  `ccx` ([details](DETAILS.md#credential-plumbing)).

- **`.pem`/`.key` files are blocked everywhere — including non-secret
  ones.** *(both)* The system CA bundle is handled automatically
  (`tlsTerminate` injects srt's own bundle), and known-safe names are
  already excepted: `.env.example`/`.env.sample`/`.env.template`/
  `.env.dist` and `id_*.pub` are readable. For anything else, add it
  to the exception list or rename/copy to `.crt`/`.pem.txt`
  ([details](DETAILS.md#filesystem-rule-mechanics)).

- **Sandbox denials are explained in-session.** *(both)* The
  violations hook surfaces each denial — with its configured reason —
  into the agent's context after the next Bash command. Filesystem
  denials arrive with ~1–2 s of log latency; network denials are
  instant ([details](DETAILS.md#the-violations-pipeline)).

- **Tools that bypass the proxy see a fake `GH_TOKEN` and fail GitHub
  auth.** *(both)* That's the masking working — the sentinel is
  worthless, so it's a functionality caveat, not a leak. Anything
  going through the proxy (gh, git-over-HTTPS, curl) authenticates
  fine ([details](DETAILS.md#gh-and-glab)).

- **`gh` fails with `x509: certificate signed by unknown authority`?**
  *(both)* The MITM CA isn't trusted yet — run setup step 4. PEM-based
  tools (curl, cargo, git) work either way; only trustd-verifying
  tools (Go binaries) need the keychain trust.

- **Cert-pinned or mTLS hosts fail under TLS termination.** *(both)*
  The proxy re-signs certificates with srt's MITM CA, which pinning
  rejects. Add the offending host to
  `network.tlsTerminate.excludeDomains` rather than turning
  termination off ([details](DETAILS.md#tls-inside-the-sandbox)).

- **cargo works inside; `cargo install`, `cargo publish`, and `rustup`
  run outside.** *(both)* Registry/git caches are writable;
  `~/.cargo/bin` and `~/.rustup` deliberately aren't
  ([details](DETAILS.md#cargo-and-rust)).

- **pnpm works via the pinned global store; `pnpm add -g` runs
  outside.** *(both)* Without the pin it silently creates a per-project
  `.pnpm-store/`. uv needs nothing
  ([details](DETAILS.md#pnpm-and-uv)).

- **git prints `fatal: failed to store: -60008` noise but succeeds.**
  *(both)* The osxkeychain helper can't save proxy credentials inside;
  harmless. Silence per repo ([details](DETAILS.md#git-credential-noise)):
  ```bash
  git config credential.helper ''
  git config --add credential.helper '!gh auth git-credential'
  ```

- **git-over-SSH works — needs `brew install socat` and keys loaded
  via `ssh-add`.** *(both)* Auth goes through the forwarded ssh-agent
  socket (raw keys stay unreadable; run `ssh-add`, or `ssh-add -c`
  for per-use confirmation, before launching) and the connection
  tunnels through the proxy via srt's socat `ProxyCommand`.
  `IdentitiesOnly yes` setups work as-is — public keys are readable
  via the `id_*.pub` exception, and the agent signs.
  Plain `ssh` outside git: `eval "$GIT_SSH_COMMAND git@github.com"`
  ([details](DETAILS.md#ssh)). While a session runs, sandboxed code
  can authenticate as you to anything the agent holds keys for —
  mitigate with `ssh-add -c` or hardware-backed keys.

- **`git push`/`git pull` over HTTPS works with a one-time credential
  helper setup** (alternative to SSH remotes). *(both)*
  ```bash
  # GitHub — one-time setup per repo
  git remote set-url origin https://github.com/ORG/REPO.git
  git config credential.helper '!gh auth git-credential'

  # GitLab — one-time setup per repo
  git remote set-url origin https://gitlab.com/ORG/REPO.git
  git config credential.helper '!glab auth git-credential'
  ```

- **`gh api`, `gh pr`, `gh issue`, etc. work as-is.** *(both)* The
  injected `$GH_TOKEN` is enough.

- **`gh auth login` from inside fails.** *(both)* No write access to
  `~/.config/gh`. Auth outside, run `gh` inside.

- **Clipboard copy works only in OSC 52-capable terminals** (Ghostty,
  WezTerm, kitty, Alacritty; iTerm2 needs it enabled). *(both)* Apple
  Terminal.app silently drops the copy — `pbcopy` is blocked inside;
  wrap the session in `osc52pty` or switch terminals
  ([details](DETAILS.md#clipboard-and-osc-52)).

- **Writes to `/tmp/<not-claude>/…` hit EPERM.** *(both)* Most CLIs
  respect `$TMPDIR` (overridden to `/tmp/claude`), so rare in practice.

- **Concurrent `ccx` sessions are isolated** *(both)* via per-PID
  TMPDIRs; no cleanup needed.

- **`*.local` hostnames route through the proxy** (as of srt
  [#349](https://github.com/anthropic-experimental/sandbox-runtime/pull/349)).
  *(both)* Reachable under allow-all; remember them if you ever switch
  to an explicit allowlist.

## More

- [Why these design choices](DETAILS.md#why-these-design-choices) —
  allow-all egress, two postures, why a fork.
- [Using on Linux](DETAILS.md#using-on-linux) — config tweaks for
  bubblewrap/seccomp.
- [Future directions](DETAILS.md#future-directions) — srt primitives
  not exercised yet (URL filtering, egress audit, per-tool policies).
