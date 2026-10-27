# Sandboxed Claude Code on macOS

Settings files, shell functions and a `justfile` for running
[Claude Code](https://claude.com/claude-code) inside
[sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)
(`srt`), Anthropic's general-purpose process sandbox. All web egress is
allowed — filesystem restrictions are the primary boundary
([why](DETAILS.md#why-these-design-choices)). Requires a
[patched fork](https://github.com/ubc/sandbox-runtime/tree/ltic-main)
of `srt` ([what it adds and why](DETAILS.md#the-fork)).

This README covers setup and day-to-day use. The reasoning and deep
dives live in [DETAILS.md](DETAILS.md).

## Contents

| File | Purpose |
|---|---|
| `justfile` | `just setup` / `just upgrade` / `just check` — installs and verifies everything below, including `gh`, git-over-SSH and (opt-in) AWS smoke tests |
| `.srt-claude-denyall.json` | Restrictive posture — default-deny reads under `/Users`, explicit allow-list |
| `.srt-claude-allowall.json` | Permissive posture — default-allow reads, explicit deny-list for sensitive paths |
| `.zshrc.example` | Shell functions (`ccx`, `ccx_permissive`, `ccx_exec`, `srtlog`) for zsh |
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
  forked `srt` ([details](DETAILS.md#the-fork)). Covers hostnames
  only: IP literals and `localhost` still need an `allowedDomains`
  entry, and cloud metadata (`169.254.169.254`) and host loopback
  services are refused — including hostnames that *resolve* there.
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
- **`requireHostMatch: true`** — inside a tunnel, a request whose
  `Host` header or TLS server name doesn't match the `CONNECT` target
  gets a `421` and a violation line. Token injection is keyed on the
  `CONNECT` target, so this closes the "connect to github.com, address
  somewhere else" trick. Normal clients always match
  ([details](DETAILS.md#tls-inside-the-sandbox)).
- **`credentials.envVars` masks `GH_TOKEN`** — the sandbox sees a fake
  token; the proxy injects the real one only on egress to
  `github.com` / `*.github.com` ([details](DETAILS.md#gh-and-glab)).
- **`~/.aws` stays denied in both postures.** AWS access is opt-in per
  launch via `CCX_AWS_PROFILES`: the keys are masked like `GH_TOKEN` and
  the proxy re-signs SigV4 requests toward `*.amazonaws.com`
  ([details](DETAILS.md#aws-credentials)).
- **Credential globs in `denyRead`** — `/**/.env*`, `/**/*.pem`,
  `/**/id_rsa*`, … deny reads everywhere, even inside `allowRead`'d
  paths. Patterns need a leading `/` to be global. Known-safe names the
  globs catch by accident — `.env.example` and friends, public keys —
  are carved back out with narrower `allowRead` globs
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
  (sysctl `kern.*`, preferences plists, configd lookups, and the
  `~/.zshenv` read and two Mach probes every sandboxed `ssh` hop emits)
  from the violations the agent sees
  ([details](DETAILS.md#the-violations-pipeline)).
- Cert-pinned / mTLS hosts break under TLS termination — exclude them
  per-domain via `network.tlsTerminate.excludeDomains`; none set here
  ([details](DETAILS.md#tls-inside-the-sandbox)).

## What the shell functions do

`ccx` and `ccx_permissive` launch `claude` through `_ccx_run`;
`ccx_exec` / `ccx_permissive_exec` run any other command the same way
(`ccx_exec gh api user` is the quickest "does X work inside?" test).
On every launch `_ccx_run`:

- **Seeds Claude's credentials** — copies the OAuth credential from the
  Keychain (unreadable inside) to `~/.claude/.credentials.json`, with
  the refresh token nulled so only the short-lived access token touches
  disk ([details](DETAILS.md#credential-plumbing)).
- **Extracts `GH_TOKEN`** via `gh auth token` (the Keychain is
  unreadable inside), then hands it to srt, which **masks** it: the
  sandbox sees a fake token and the proxy injects the real one only
  toward GitHub ([details](DETAILS.md#gh-and-glab)). `glab` needs
  nothing — it reads its own config file.
- **Carries AWS credentials in, masked, when asked** — with
  `CCX_AWS_PROFILES="la-shared la-dev" ccx`, each named profile's
  temporary keys are exported outside (saml2aws and IAM Identity Center
  profiles alike), masked the same way as `GH_TOKEN`, and re-signed by
  the proxy only toward `*.amazonaws.com`; a sandbox-only AWS config
  makes `--profile` work inside while `~/.aws` stays unreadable
  ([details](DETAILS.md#aws-credentials)). Without the variable nothing
  AWS-related enters the sandbox — the outer shell's `AWS_*` credential
  variables are always stripped.
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
- **Gives each session its own `TMPDIR`** (`/tmp/claude/ccx-<pid>`), so
  concurrent sessions are isolated; no cleanup needed.

`srtlog` tails macOS sandbox-exec denials in real time (or pass a
number for "last N minutes" of history).

## Setup

Quick start (everything below, in order, with a verification pass at
the end):

```bash
brew install just
cd sandbox-runtime-config
just setup
```

Every step is also a single recipe (`just install-srt`, `just
install-configs`, …) with the manual equivalent shown here. Run them
from a normal terminal, not from inside a `ccx` session.

### 1. Install the patched `srt` from the fork — `just install-srt`

Upstream `srt` has no allow-all-egress mode; the fork adds
`allowAllDomains` to fix that (upstream PR
[#283](https://github.com/anthropic-experimental/sandbox-runtime/pull/283)),
plus two more deltas: the CLI streams sandbox violations to a file
the agent can be shown
([pipeline](DETAILS.md#the-violations-pipeline)), and unrecognized
settings keys produce a launch-time warning instead of being silently
ignored ([details](DETAILS.md#the-fork)).

Requires Node ≥ 22.12 (`node --version`); an older Node fails at `npm
install` with an `engines` error.

```bash
git clone https://github.com/ubc/sandbox-runtime.git ~/src/sandbox-runtime
cd ~/src/sandbox-runtime
git checkout ltic-main
npm install           # fetch build deps
npm run build         # build dist/
npm install -g .      # install srt globally
```

With nvm, `npm install -g` lands in nvm's node bin, already on `$PATH`.
If your Node isn't from nvm (system Node under `/usr/local`, for
example), the global prefix may not be writable by you: either `sudo
npm install -g .` or point npm at a user prefix first (`npm config set
prefix ~/.local`, and put `~/.local/bin` on `$PATH`). Homebrew Node's
prefix is user-writable and needs neither.

Verify the install — the `-ltic` suffix confirms the patched fork:

```bash
srt --version      # → 0.0.81-ltic.1
```

Also install jq (`just deps`) — the shell functions use it to build
the per-launch config:

```bash
brew install jq
```

### 2. Copy the config files into your home directory — `just install-configs`

```bash
cp .srt-claude-denyall.json .srt-claude-allowall.json ~/
```

### 3. Wire up the shell functions — `just install-shell`

The functions live in `~/.config/srt/ccx.zsh` (or `ccx.bash`) and are
sourced from your rc file, so re-installing after an upgrade just
overwrites that one file:

```bash
mkdir -p ~/.config/srt
cp .zshrc.example ~/.config/srt/ccx.zsh                      # zsh
echo 'source "$HOME/.config/srt/ccx.zsh"' >> ~/.zshrc

cp .bashrc.example ~/.config/srt/ccx.bash                    # bash
echo 'source "$HOME/.config/srt/ccx.bash"' >> ~/.bash_profile   # what macOS login shells source
```

Then `source ~/.zshrc` (or open a new terminal).

**Other shells** — install `ccx.bash` as above and wrap the functions
in entrypoint scripts:

```bash
mkdir -p ~/.local/bin
for f in ccx ccx_permissive ccx_exec srtlog; do
  printf '#!/usr/bin/env bash\nsource ~/.config/srt/ccx.bash\n%s "$@"\n' "$f" > ~/.local/bin/$f
  chmod +x ~/.local/bin/$f
done
```

### 4. Trust the sandbox MITM CA (one-time) — `just trust-ca`

`tlsTerminate` means srt re-signs upstream certificates. PEM-reading
tools (curl, cargo, git, python) trust the re-signed certs via the env
vars srt sets — but tools that verify through the macOS trust store
(`gh` and other Go binaries) ask trustd, which knows nothing about
srt's CA and fail with `x509: certificate signed by unknown
authority`. The wrapper generates a **persistent** CA on first launch
(`~/.config/srt/mitm-ca.{crt,key}`), so you can trust it once in your
login keychain. Run `ccx` (or `ccx_exec true`) once, then:

```bash
security add-trusted-cert -p ssl -k ~/Library/Keychains/login.keychain-db ~/.config/srt/mitm-ca.crt
```

macOS shows an authorization prompt; approving it adds the CA as
SSL-trusted **for your user only**. The private key stays on this
machine, mode 600, and is unreadable inside the sandbox
([details](DETAILS.md#tls-inside-the-sandbox)).

### 5. Install the violations hook — `just install-hook`

The forked `srt` logs each sandbox denial to a file
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
a no-op, so it's safe to leave registered globally. Filesystem denials
arrive with ~1–2 s of log latency; network denials are instant.

### 6. Use it — `just check` first

```bash
just check       # tools, configs, egress, CA trust, hook, gh and git-over-SSH smoke tests
cd ~/src/your-project
ccx              # strict sandbox
ccx_permissive   # deny-list sandbox
```

When something misbehaves, `just check` and `ccx_exec <command>` are
the first two things to reach for.

## Known gotchas

### Run these outside the sandbox

- **Token refresh, every ~8h.** The sandbox can't refresh. Exit, run
  `claude` once in a normal terminal, relaunch `ccx`
  ([details](DETAILS.md#credential-plumbing)).
- **`gh auth login` / `refresh` / `logout`** — no write access to
  `~/.config/gh`. Everything else in `gh` works inside.
- **`cargo install`, `cargo publish`, `rustup`** — `~/.cargo/bin` and
  `~/.rustup` are deliberately read-only; builds and fetches work
  inside ([details](DETAILS.md#cargo-and-rust)).
- **`pnpm add -g`** — writes to `$PNPM_HOME/bin`; project installs work
  inside via the pinned store. uv needs nothing
  ([details](DETAILS.md#pnpm-and-uv)).
- **AWS logins** — `just login` / `just login-all` / `just hc-login`
  (or `saml2aws login`, `aws sso login`, `aws configure`): they write
  `~/.aws`, which is unreadable inside. Credentials are a launch-time
  snapshot, so when a saml2aws session (1 h) runs out: exit, log in
  again, relaunch ([details](DETAILS.md#aws-credentials)).

### Errors decoded

| Symptom | Cause | Fix |
|---|---|---|
| `x509: certificate signed by unknown authority` from `gh` or another Go binary | MITM CA not trusted by trustd | `just trust-ca` (step 4). PEM-based tools work regardless |
| A cert-pinned or mTLS host fails | TLS termination re-signs its cert | Add the host to `network.tlsTerminate.excludeDomains` ([details](DETAILS.md#tls-inside-the-sandbox)) |
| git prints `fatal: failed to store: -60008` but succeeds | osxkeychain helper can't save proxy creds inside | Cosmetic. Silence per repo with the two lines below ([details](DETAILS.md#git-credential-noise)) |
| GitHub auth fails in a tool that bypasses the proxy | It sent the masked (fake) `GH_TOKEN` | Working as designed — the sentinel is worthless. Proxy-aware tools (gh, git, curl) are fine ([details](DETAILS.md#gh-and-glab)) |
| `EPERM` writing under `/tmp/<something>/` | Only `/tmp/claude` and `/private/tmp` are writable | Use `$TMPDIR`; most CLIs already do |
| srt exits 1 at launch | Invalid, empty or unreadable settings file | `just check` (or `jq . ~/.srt-claude-denyall.json`) |
| "unrecognized settings key" warning at launch | A key the current fork no longer knows (e.g. a leftover `denyReadAlways`) | `just install-configs`, or migrate by hand ([upgrade notes](DETAILS.md#upgrade-notes-by-version)) |
| A `.pem` / `.key` / `.env*` file is unreadable — or a whole `.env/` venv or `credentials/` directory | Credential globs deny those names everywhere, folders included | Add a narrower glob or exact path to `allowRead`, or rename (`.venv`, `cert.pem.txt`) ([details](DETAILS.md#filesystem-rule-mechanics)) |
| `aws` says the config profile could not be found, or `Unable to locate credentials` | The sandbox never reads `~/.aws`; only profiles named in `CCX_AWS_PROFILES` exist inside | Relaunch with `CCX_AWS_PROFILES="<profile> …" ccx` ([details](DETAILS.md#aws-credentials)) |
| An S3 upload gets a `403` naming a streaming / aws-chunked signature | The proxy can't re-sign aws-chunked uploads | The wrapper sets `AWS_REQUEST_CHECKSUM_CALCULATION=when_required` so the CLI and SDKs send `UNSIGNED-PAYLOAD`; a tool that overrides that setting needs it too ([details](DETAILS.md#aws-credentials)) |

```bash
git config credential.helper ''
git config --add credential.helper '!gh auth git-credential'
```

### Git, SSH and GitHub

- **git-over-SSH works via the forwarded ssh-agent** — needs keys
  loaded with `ssh-add` (or `ssh-add -c` for per-use confirmation)
  before launching; nothing beyond what macOS ships. Raw keys stay
  unreadable; the agent signs, which also makes `IdentitiesOnly yes`
  setups work as-is (public keys are readable). Plain `ssh` outside
  git: `eval "$GIT_SSH_COMMAND git@github.com"`. A destination refused
  by `deniedDomains` prints its configured reason on ssh's stderr
  (`sandbox proxy: <host>:22: 403 <reason>`), and `git` shows the same
  line. Trade-off: while a session runs, sandboxed code can
  authenticate as you to anything the agent holds keys for
  ([details](DETAILS.md#ssh)).
- **HTTPS remotes work with a one-time credential-helper setup**
  (alternative to SSH):
  ```bash
  git remote set-url origin https://github.com/ORG/REPO.git
  git config credential.helper '!gh auth git-credential'      # GitLab: !glab auth git-credential
  ```
- **`gh` and `glab` work as-is** — the masked `GH_TOKEN` and glab's own
  config file are enough ([details](DETAILS.md#gh-and-glab)).

### AWS

- **Opt in per launch, naming the profiles the task needs:**
  ```bash
  CCX_AWS_PROFILES="la-shared la-dev" ccx                     # space- or comma-separated
  CCX_AWS_PROFILES=la-shared ccx_exec aws sts get-caller-identity
  ```
  Each profile is checked with `sts get-caller-identity` outside first;
  an expired or unknown one aborts the launch naming the login command,
  and each live one prints its role ARN. Inside, `aws --profile <name>`
  and boto3 (`profile_name=`) see exactly those profiles, the first one
  doubling as `[default]`. The sandbox holds only fake keys; the proxy
  signs the real requests toward `*.amazonaws.com`
  ([details](DETAILS.md#aws-credentials)).
- **What the sandbox can do is bounded by the roles, not the wrapper:**
  the agent can run any AWS action the named roles allow until the
  credentials expire. Name non-production profiles unless the task needs
  production, and let Claude Code's permission prompts gate the commands.
- **Uploads** sign `UNSIGNED-PAYLOAD` (the wrapper sets the checksum
  variables) because aws-chunked streaming uploads cannot be re-signed;
  signed bodies are buffered up to 64 MiB. Presigned URLs and SigV4A
  requests made with the masked keys are refused with a `403`.

### Terminal

- **Clipboard copy works only in OSC 52-capable terminals** (Ghostty,
  WezTerm, kitty, Alacritty; iTerm2 needs it enabled). Apple
  Terminal.app silently drops the copy — `pbcopy` is blocked inside;
  wrap the session in `osc52pty` or switch terminals
  ([details](DETAILS.md#clipboard-and-osc-52)).
- **`*.local` hostnames route through the proxy.** Reachable under
  allow-all; remember them if you ever switch to an explicit allowlist.

## Upgrading

```bash
cd sandbox-runtime-config && git pull
just upgrade     # rebuild srt from the fork, re-copy configs, reinstall shell functions + hook, then check
```

Manually: repeat steps 1, 2, 3 and 5. If you customized your configs,
the recipe leaves your previous copy at `~/.srt-claude-*.json.bak` to
diff against. If you set up before the `justfile` existed, your rc file
has the functions pasted inline — delete that block (from the
`# Sandboxed Claude Code` comment through `srtlog` and the trailing
PNPM note) so it doesn't shadow the sourced file; `just install-shell`
warns while it's still there.

What changed in each release, and what to migrate by hand:
[upgrade notes by version](DETAILS.md#upgrade-notes-by-version). Since
0.0.81 socat is no longer used; `brew uninstall socat` is safe if
nothing else needs it.

## More

- [Why these design choices](DETAILS.md#why-these-design-choices) —
  allow-all egress, two postures, why a fork.
- [Using on Linux](DETAILS.md#using-on-linux) — config tweaks for
  bubblewrap/seccomp.
- [Future directions](DETAILS.md#future-directions) — srt primitives
  not exercised yet (URL filtering, egress audit, per-tool policies).
