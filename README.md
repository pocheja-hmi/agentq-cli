# agentq-cli

> Scaffold, deploy, and manage **AgentQ** Custom Agents — uniform structure
> across teams, central deploy logic, optional per-project hooks.

`agentq-cli` is the standard tool every AgentQ team uses to start and ship a
new project. It enforces a single project layout so observability,
configuration, deployment, and management can be driven by one common
interface — while still letting each project plug in its own deploy logic
through hooks when needed.

---

## Install

The CLI is distributed as an npm package installed directly from the Git
repository (no public registry). The repository URL is **not** hardcoded —
override it any time with `AGENTQ_CLI_REPO`:

```bash
# Default upstream (current location)
npm install -g github:pocheja-hmi/agentq-cli

# Pin to a tagged release
npm install -g github:pocheja-hmi/agentq-cli#v0.1.0

# Override (e.g. after migration to an org repo)
export AGENTQ_CLI_REPO=github:my-org/agentq-cli#v0.1.0
npm install -g "$AGENTQ_CLI_REPO"

# Verify
agentq --version
agentq --help
```

> When the repository moves to its long-term Org home, update one variable —
> `AGENTQ_CLI_REPO` — across teams. Nothing else changes.

### What gets installed

- A Node CLI (`agentq`) that handles scaffolding, dispatch, and project
  management.
- A bundled Python runtime that handles deploy / list / destroy / KB ops via
  the official Vertex AI SDKs. The first time you run `agentq deploy` (or
  any KB command) inside a project, the CLI creates a `.agentq/venv`
  in that project and installs Python dependencies. You don't manage Python
  manually.

### Prerequisites

You need three things on your machine before installing `agentq-cli`:

| Tool       | Minimum version | Why                                                |
| ---------- | --------------- | -------------------------------------------------- |
| **Node**   | 18+             | Runs the CLI itself.                               |
| **Python** | 3.10+           | Runs the bundled runtime that talks to Vertex AI.  |
| **gcloud** | latest          | Auth + GCP API enablement.                         |

The CLI auto-detects `python3.10`, `python3.11`, `python3.12`, `python3`, or
`python` on PATH — whichever is present. You don't pick one manually.

#### Quick check (run these first)

```bash
node --version       # want v18 or higher
python3 --version    # want 3.10 or higher
gcloud --version
```

If any of those fail or report an old version, follow the matching OS
section below.

---

### Install Node.js (18+)

#### macOS

```bash
# Recommended: Homebrew
brew install node                  # latest LTS

# Or: nvm (best if you switch Node versions across projects)
brew install nvm
mkdir -p ~/.nvm
echo 'export NVM_DIR="$HOME/.nvm"' >> ~/.zshrc
echo '[ -s "$(brew --prefix nvm)/nvm.sh" ] && . "$(brew --prefix nvm)/nvm.sh"' >> ~/.zshrc
source ~/.zshrc
nvm install --lts
nvm use --lts
```

If you don't have Homebrew: install it first from <https://brew.sh>.

#### Windows

The cleanest path is **winget** (built into Windows 10/11) or the official
installer.

```powershell
# winget (recommended)
winget install OpenJS.NodeJS.LTS

# Verify in a NEW PowerShell window
node --version
npm --version
```

Or download the LTS installer from <https://nodejs.org/> and run it. After
installing, **close and reopen** your terminal so PATH is refreshed.

For multiple Node versions on Windows, use **nvm-windows**:
<https://github.com/coreybutler/nvm-windows/releases> (`nvm install lts`).

#### Linux

```bash
# Ubuntu / Debian — NodeSource (avoids the very old apt version)
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs

# Fedora / RHEL
sudo dnf module install nodejs:20/common

# Arch
sudo pacman -S nodejs npm

# Or: nvm (cross-distro, no sudo)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
exec $SHELL
nvm install --lts
```

Verify on every OS:

```bash
node --version
npm --version
```

---

### Install Python (3.10+)

#### macOS

```bash
# Homebrew
brew install python@3.12          # any of 3.10 / 3.11 / 3.12 works

# Verify (might need to use the explicit name)
python3 --version
python3.12 --version
```

The system `python3` shipped by Apple is usually fine version-wise but
Homebrew gives you a writable, isolated install. Either works.

If you manage multiple Python versions, **pyenv** is the best option:

```bash
brew install pyenv
echo 'eval "$(pyenv init -)"' >> ~/.zshrc
source ~/.zshrc
pyenv install 3.12
pyenv global 3.12
```

#### Windows

```powershell
# winget (recommended)
winget install Python.Python.3.12

# Verify in a NEW PowerShell window
python --version
py -3 --version
```

Or download from <https://www.python.org/downloads/windows/>. **Critical:**
on the installer's first screen, tick **"Add python.exe to PATH"** before
clicking Install. Without that the CLI won't find Python.

#### Linux

```bash
# Ubuntu / Debian
sudo apt-get update
sudo apt-get install -y python3 python3-venv python3-pip

# Fedora / RHEL
sudo dnf install -y python3 python3-pip

# Arch
sudo pacman -S python python-pip

# If your distro's python3 is too old, use deadsnakes (Ubuntu) or pyenv:
sudo add-apt-repository -y ppa:deadsnakes/ppa
sudo apt-get install -y python3.12 python3.12-venv
```

> **Important on Debian/Ubuntu:** `python3-venv` is a *separate* package from
> `python3` itself. The CLI uses `python -m venv` to create per-project
> environments — without `python3-venv` installed, the first `agentq deploy`
> fails. The list above already includes it.

Verify on every OS:

```bash
python3 --version            # macOS / Linux
python --version             # Windows
python3 -m venv --help >/dev/null && echo "venv ok"   # macOS / Linux
```

---

### Install gcloud (Google Cloud CLI)

#### macOS

```bash
# Homebrew (cask) — recommended
brew install --cask google-cloud-sdk

# Or interactive installer
curl https://sdk.cloud.google.com | bash
exec -l $SHELL
```

After install:

```bash
gcloud --version
gcloud components install beta              # rarely needed but safe
```

For Apple Silicon Macs the Homebrew cask handles the right architecture
automatically.

#### Windows

```powershell
# winget (recommended)
winget install Google.CloudSDK

# Verify in a NEW PowerShell window
gcloud --version
```

Or download the GoogleCloudSDKInstaller.exe from
<https://cloud.google.com/sdk/docs/install#windows>. After install,
**close and reopen** PowerShell so PATH refreshes.

#### Linux

```bash
# Ubuntu / Debian — apt repo (auto-updates with the system)
sudo apt-get install -y apt-transport-https ca-certificates gnupg curl
curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
    | sudo gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] \
https://packages.cloud.google.com/apt cloud-sdk main" \
    | sudo tee /etc/apt/sources.list.d/google-cloud-sdk.list
sudo apt-get update && sudo apt-get install -y google-cloud-cli

# Fedora / RHEL
sudo tee /etc/yum.repos.d/google-cloud-sdk.repo <<EOF
[google-cloud-cli]
name=Google Cloud CLI
baseurl=https://packages.cloud.google.com/yum/repos/cloud-sdk-el9-x86_64
enabled=1
gpgcheck=1
repo_gpgcheck=0
gpgkey=https://packages.cloud.google.com/yum/doc/rpm-package-key.gpg
EOF
sudo dnf install -y google-cloud-cli

# Arch
yay -S google-cloud-cli            # AUR

# Distro-agnostic (interactive, installs into ~)
curl https://sdk.cloud.google.com | bash
exec -l $SHELL
```

#### Authenticate (all OSes — required once)

After installing gcloud, run **both** of these commands. They open a
browser window — log in with your GCP-enabled work account:

```bash
gcloud auth login                         # CLI session
gcloud auth application-default login     # for SDK calls (Vertex AI, GCS, …)
gcloud config set project <your-project>
```

The second command is the one most people forget, and it's the one that
matters most for `agentq-cli` — the bundled Python runtime uses
Application Default Credentials when calling Vertex AI APIs.

Sanity-check:

```bash
gcloud config list
gcloud auth application-default print-access-token >/dev/null && echo "ADC ok"
```

---

### After installing the prerequisites

Run `agentq doctor` from any directory once the CLI is installed — it
verifies all of the above against your project's `agentq.config.yaml`
(when run from inside a project) and tells you exactly what is missing.

---

## Quick start

```bash
# 1. Create a new project (interactive walkthrough)
agentq init

# 2. Verify your local + cloud setup
cd my-new-project
agentq doctor

# 3. (If KB enabled) provision and load the knowledge base
agentq kb create-bucket
agentq kb upload
agentq kb create-datastore
agentq kb import

# 4. Deploy
agentq deploy
```

The deploy step prints a Reasoning Engine `resource_name` and writes it back
into `agentq.config.yaml`. From now on, `agentq deploy` updates the same
deployment instead of creating a new one.

---

## Commands

Run `agentq <command> --help` on any of these for full flag reference.

| Command                        | Purpose                                                    |
| ------------------------------ | ---------------------------------------------------------- |
| `agentq init [name]`           | Interactive project scaffolding.                           |
| `agentq new <pattern> <name>`  | Non-interactive scaffolding (every option as a flag).      |
| `agentq deploy`                | Create or update the project's Reasoning Engine.           |
| `agentq list`                  | List Reasoning Engines in the configured GCP project.      |
| `agentq destroy <resource>`    | Delete a deployed Reasoning Engine.                        |
| `agentq logs <resource>`       | Tail Cloud Logging for a deployed agent.                   |
| `agentq doctor`                | Diagnose local + cloud setup before deploying.             |
| `agentq kb <subcommand>`       | Manage the project's knowledge base (per provider).        |

Global flags (work on every command): `--help`, `--version`, `--verbose`.

### Orchestration patterns

`agentq init` and `agentq new` both ask for one of these:

| Pattern      | Shape                                                     |
| ------------ | --------------------------------------------------------- |
| `single`     | One `LlmAgent`. The simplest possible scaffold.           |
| `multi`      | Orchestrator `LlmAgent` + N sub-agents (LLM-driven routing). |
| `sequential` | `SequentialAgent` of N stages (deterministic pipeline).   |
| `hybrid`     | `LlmAgent` orchestrator that delegates to a `SequentialAgent` inner pipeline. |

The number of sub-agents / stages is asked for during `init` (or passed as
`--sub-agents`).

### Knowledge-base providers

v1 ships with **Vertex AI Search**. The KB layer is behind a `KBProvider`
interface, so additional providers (Drive, GCS-folder RAG, etc.) can be
added without changing scaffolded projects.

`agentq kb` (no subcommand) prints the help for the configured provider.

---

## Project structure (uniform across all teams)

```
my-project/
├── agentq.config.yaml        ← single source of truth (CLI reads this)
├── .env.example
├── pyproject.toml
├── src/<package>/
│   ├── __init__.py
│   ├── agent.py              ← exports root_agent (ADK discovery)
│   ├── config.py             ← typed env loader (uniform)
│   ├── observability.py      ← tracing + structured logs (uniform)
│   ├── agents/               ← present for multi/sequential/hybrid
│   └── tools/                ← FunctionTool implementations
├── scripts/
│   └── deploy_hooks.py       ← optional pre/post hooks
├── knowledge/                ← (KB-enabled projects only)
└── tests/test_smoke.py
```

Why this matters:

- **One layout means one deploy script.** `agentq deploy` works on every
  project without per-project Python deploy code.
- **One config file means one observability/management surface.** Every team
  exposes `gcp_project`, `location`, `service_account`, `model`, `env_vars`,
  and KB info in the same place — making cross-project tooling possible.
- **Hooks are the escape hatch.** Anything project-specific lives in
  `scripts/deploy_hooks.py` and is referenced under `hooks:` in the config.
  The deployer calls them automatically.

---

## `agentq.config.yaml` — the contract

Every command reads this file. It is written by `agentq init` and validated
on every CLI entry point through one zod schema.

```yaml
schema_version: 1
project:
  name: my-project
  package: my_project
  description: "What this agent does."
  display_name: "My Project"
agent:
  pattern: hybrid
  entry_module: my_project.agent
  entry_symbol: root_agent
  sub_agents: 3
deployment:
  gcp_project: my-gcp-project
  location: us-central1                 # Agent Engine requires regional, NOT 'global'.
  staging_bucket: gs://my-staging-bucket
  service_account: null                 # or 'name@project.iam.gserviceaccount.com'
  resource_name: null                   # set automatically after first deploy
runtime:
  model: gemini-2.5-flash
  python_packages:                      # what gets pip-installed in the container
    - google-adk>=1.27.0
    - google-genai>=1.0.0
  extra_packages:                       # local folders shipped into the container
    - ./src/my_project
  env_vars:                             # injected into os.environ at runtime
    MY_FLAG: "1"
knowledge_base:
  provider: vertex-ai-search            # or 'none'
  datastore_id: my-corpus
  bucket: my-corpus
  location: global
observability:
  tracing: true
  level: standard                        # basic | standard | advanced
hooks:
  pre_deploy: null                      # 'scripts.deploy_hooks:pre_deploy'
  post_deploy: null
```

Reserved env-var names (`GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`,
`K_SERVICE`, `K_REVISION`, `K_CONFIGURATION`, `PORT`,
`GOOGLE_APPLICATION_CREDENTIALS`) are dropped automatically — Agent Engine
sets them itself.

---

## Hybrid deploy model

`agentq deploy` is the **single deploy entry point**. The flow:

```
agentq deploy
  │
  ├─ load and validate agentq.config.yaml
  ├─ ensure .agentq/venv (one-time per project)
  ├─ run hooks.pre_deploy   (if defined)
  ├─ build AdkApp from agent.entry_module:entry_symbol
  ├─ agent_engines.create() or .update()
  ├─ write resource_name back into agentq.config.yaml
  └─ run hooks.post_deploy  (if defined)
```

You **rarely** need to write deploy code. When you do, implement
`scripts/deploy_hooks.py` and reference its callables in
`agentq.config.yaml`. Hooks receive a single `ctx` dict so the signature is
stable as the deployer evolves.

---

## Cross-project management

Because every project shares the same config shape:

- `agentq list` works from any project, against any GCP project (override
  with `--gcp-project`).
- `agentq logs <resource>` works against any deployed Reasoning Engine
  regardless of which team owns it.
- A central tool (e.g. a Cloud Run job) can crawl every team's
  `agentq.config.yaml`, build a registry of all deployments, and drive
  bulk updates / audits — because the schema is uniform.

---

## Versioning

The CLI is versioned with semver. Install a specific tag:

```bash
npm install -g github:pocheja-hmi/agentq-cli#v0.1.0
```

When the upstream repository changes location, update once:

```bash
export AGENTQ_CLI_REPO=github:my-org/agentq-cli#v0.1.0
npm install -g "$AGENTQ_CLI_REPO"
```

Bundled Python dependencies are version-pinned alongside the CLI release;
`.agentq/venv` per project is rebuilt automatically when the lock changes.

---

## Development

```bash
git clone git@github.com:pocheja-hmi/agentq-cli.git
cd agentq-cli
npm install
npm run build
node bin/agentq.js --help
```

Layout:

```
agentq-cli/
├── bin/agentq.js             # tiny shim → dist/cli.js
├── src/                      # TypeScript source
│   ├── cli.ts                # yargs entry point
│   ├── commands/             # one file per command (open/closed)
│   ├── lib/                  # logger, paths, config, scaffolder, gcp, python, …
│   └── providers/            # KB providers (vertex-ai-search…)
├── python/agentq_runtime/    # bundled Python runtime (deploy, kb, etc.)
├── templates/
│   ├── common/               # shared skeleton (always rendered)
│   ├── patterns/             # one folder per orchestration pattern
│   └── kb/                   # one folder per KB provider
└── tsconfig.json
```

The architecture follows SOLID/DRY:

- **One file per command** (open/closed for new commands).
- **All filesystem scaffolding** goes through one `Scaffolder`.
- **Config is validated once** through a single zod schema (DRY).
- **`KBProvider` is a stable interface** — adding a new provider does not
  modify any other module.
- **All gcloud calls** go through `lib/gcp.ts`; all Python through
  `lib/python.ts`. Commands depend on these abstractions, not on shelling
  out directly.
