# Getting started

This guide takes you from "nothing installed" to "agent deployed and chatting
in AgentQ" in one pass. Targets the **GitOps happy path** (the recommended
mode); if you want laptop-only deploys, follow the "Legacy mode" callouts at
the end.

If you read only one doc, read this one. Everything else is a deeper dive on
something covered here.

---

## What you're about to build

A **Custom Agent** running on Agent Engine on Gemini Enterprise, deployable through
GitHub Actions on every push to `dev` / `staging` / `main`, with:

- One GCS-backed `state.yaml` per tier (no engine state in tracked YAML).
- Per-file diffing of `knowledge/` documents.
- Drift detection — CI fails loudly if the deployed reality doesn't match
  the state file.
- A clear promotion path: dev → staging → prod, with a staging-ancestry gate
  on prod deploys.

The two-repo split:
- **`agentq-cli`** (this repo) — the local CLI that scaffolds projects,
  computes plans, applies them.
- **[`agentq-actions`](https://github.com/HorizonMedia/agentq-actions)** — the
  reusable GitHub Actions workflow your scaffolded projects call into.

---

## 0. Prerequisites

| Tool | Why |
|---|---|
| **Node 18+** | The CLI itself. |
| **Python 3.10+** (any of 3.10/3.11/3.12 on PATH) | The CLI's bundled runtime (Vertex SDK, ADK). Auto-installed into `.agentq/venv` per project. |
| **`gcloud`** authenticated | OIDC bootstrap + ADC for local plans. |
| Two GCP projects | One for the dev tier, one for staging + prod tiers. |
| GitHub repo with admin rights | Branch protections, OIDC bindings. |

Detailed OS-specific install instructions for Node, Python, and gcloud are
in the [main README](../README.md#install-nodejs-18).

Auth, one-time:

```bash
gcloud auth login
gcloud auth application-default login
```

## 1. Install the CLI

Install from the packed tarball attached to a GitHub Release:

```bash
npm install -g https://github.com/HorizonMedia/agentq-cli/releases/download/v0.2.2/agentq-cli-0.2.2.tgz

# Verify
agentq --version
agentq --help
```

> Don't reach for `npm install -g github:HorizonMedia/agentq-cli#vX` —
> that path is broken on npm 11.x + fnm + macOS (the global install drops
> `bin/` and `package.json` silently). The tarball is the reliable path.

## 2. Scaffold a new project

```bash
agentq init
```

Answer the prompts. The ones that matter most:

| Prompt | Pick |
|---|---|
| Project name | kebab-case (`my-agent`). Becomes the state key — don't change it later. |
| Python package | snake-case (`my_agent`). |
| Orchestration pattern | `single` for one LlmAgent; `multi` for orchestrator + sub-agents (LLM routing); `sequential` for deterministic pipelines; `hybrid` for an LlmAgent that hands off to a sequential pipeline. |
| Knowledge base | `vertex-ai-search` if your agent reads documents; `none` otherwise. |
| Enable GitOps? | **`y`** for the path this guide covers. |
| Dev / Prod GCP project IDs | The two GCP projects you have ready. |

Result: a new directory with this structure:

```
my-agent/
├── agentq.config.yaml          # the contract — every command reads this
├── .github/workflows/
│   └── agentq-deploy.yml       # ~25-line caller of agentq-actions@v1
├── docs/CICD_SETUP.md          # project-specific ops checklist
├── src/my_agent/               # your Python code
│   ├── __init__.py
│   ├── agent.py                # exports root_agent
│   ├── config.py
│   ├── observability.py
│   └── tools/
├── knowledge/                  # KB documents (if you picked vertex-ai-search)
├── scripts/deploy_hooks.py     # optional pre/post-deploy hooks
├── tests/test_smoke.py
└── README.md
```

## 3. Bootstrap GCP (ops, once per GCP project)

Run from your laptop with project-level IAM authority. This is the heavy
lifting — but you only do it twice in your lifetime as an org (once per GCP
project, regardless of how many AgentQ projects use them).

**Dev GCP** — gets the dev tier's service accounts:

```bash
agentq setup-cicd \
  --gcp-project <YOUR_DEV_GCP> \
  --github-org   <YOUR_GH_ORG> \
  --github-repo  <YOUR_REPO_NAME> \
  --tiers dev
```

**Prod GCP** — gets staging + prod tiers:

```bash
agentq setup-cicd \
  --gcp-project <YOUR_PROD_GCP> \
  --github-org  <YOUR_GH_ORG> \
  --github-repo <YOUR_REPO_NAME> \
  --tiers staging --tiers prod
```

What this creates per GCP: WIF pool + OIDC provider, 2 SAs per tier (deploy
+ runtime), 1 `agentq-plan` SA, IAM bindings, state bucket. All idempotent —
re-run safely. Full inventory in
[`agentq-actions/docs/SETUP.md`](https://github.com/HorizonMedia/agentq-actions/blob/main/docs/SETUP.md).

The command's output ends with a block like:

```
# workload_identity_provider input for agentq-actions:
#   projects/123456789/locations/global/workloadIdentityPools/agentq-pool/providers/github
```

**Copy that URI** — you need it in the next step.

## 4. Wire the workflow

Open `.github/workflows/agentq-deploy.yml` in your scaffolded project.
Replace `REPLACE_ME_with_value_printed_by_agentq_setup-cicd` with the WIF
URI from step 3.

That's the only manual edit. Commit:

```bash
git add .
git commit -m "Initial AgentQ project"
git push -u origin main
```

## 5. Configure branch protections (GitHub, one-time per repo)

Without these, the GitOps gates are advisory. See
[`agentq-actions/docs/SETUP.md#3-github-branch-protections-manual`](https://github.com/HorizonMedia/agentq-actions/blob/main/docs/SETUP.md#3-github-branch-protections-manual)
for the exact rules per branch.

Short version:
- **`main`**: require PR + status check `agentq-deploy / deploy` (staging
  tier) green + linear history.
- **`staging`**: require PR + status check (dev tier) green.
- **`dev`**: require PR + status check passing.

## 6. Initial KB datastores (only if you picked vertex-ai-search)

The scaffolded `tiers.<t>.kb.datastore_id` references three datastores that
don't exist yet. Create them once. Dev can be done freely:

```bash
cd my-agent
agentq kb create-bucket    --tier dev
agentq kb upload           --tier dev
agentq kb create-datastore --tier dev
agentq kb import           --tier dev
```

Staging + prod need the override flag (because their tiers default to
`allow_freeform_mutation: false`):

```bash
agentq kb create-datastore --tier staging --allow-prod-kb-mutation
agentq kb create-bucket    --tier staging --allow-prod-kb-mutation
agentq kb create-datastore --tier prod    --allow-prod-kb-mutation
agentq kb create-bucket    --tier prod    --allow-prod-kb-mutation
```

After this point, all KB mutations on staging+prod flow through GitOps
merges. No more `--allow-prod-kb-mutation` from your laptop unless
something's broken.

## 7. First deploy

Two paths — pick whichever matches your workflow.

### Path A: Through CI (recommended)

```bash
git checkout -b dev    # or whatever your dev branch is
git push -u origin dev
```

Open a PR `dev` → `staging`. The workflow runs `agentq state plan` and
posts the diff as a PR comment. Merge → it deploys to the dev tier.

### Path B: Manual first deploy from your laptop

Useful for the very first deploy to confirm everything works before
involving CI:

```bash
agentq deploy --tier dev
```

This downloads (empty) state, computes a plan, runs `agent_engines.create`,
uploads the new state to GCS. From this point on, CI takes over.

## 8. Register the deployed engine in Gemini Enterprise → AgentQ

The Reasoning Engine exists, but AgentQ users still need to see it. The
resource name is printed at the end of the deploy:

```
✓ State updated → gs://my-dev-gcp-agentq-state/agentq/my-agent/dev/state.yaml (generation 1715000123456)
✓ Deploy completed.
```

Look up the resource name with `agentq state show --tier dev` and:

1. Open **Gemini Enterprise → Agent Designer → New custom agent**.
2. Choose "Use existing reasoning engine".
3. Paste the resource name.
4. Set display name + allowed user groups.
5. Publish.

Test it: open AgentQ, find your agent in the picker, send a message.

## 9. The promotion flow from now on

```
feature/foo ──PR──▶ dev ──PR──▶ staging ──PR──▶ main
                     │            │              │
                  deploys      deploys        deploys
                  to dev       to staging     to prod
```

Each PR runs a plan and posts the diff. Each merge triggers an apply. The
prod merge is gated: CI verifies that the staging tier was deployed from
an ancestor of the prod HEAD before applying.

Add files to `knowledge/`, edit `src/`, change `agentq.config.yaml` — all of
it diffs through the same plan/apply machinery. Drift between deployed
state and source intent fails the CI loudly.

## 10. Migrating an existing engine

If you already have a deployed engine (e.g. from before GitOps existed),
import it into the appropriate tier's state instead of recreating it:

```bash
agentq state import \
  --tier prod \
  --resource-name projects/.../reasoningEngines/123 \
  --with-kb
```

This stamps the live engine into the state file. The next `agentq state diff`
should show no drift (assuming the live engine's config matches your local
source). Then the first CI run becomes a no-op, and from then on it's
GitOps-managed.

---

## Where to go next

| You want to… | Read |
|---|---|
| Understand WHY the system is shaped this way | [`docs/DESIGN.md`](DESIGN.md) |
| Reference the `agentq.config.yaml` schema field-by-field | [`README.md`](../README.md#agentqconfigyaml--the-contract) |
| See every command and flag | `agentq --help` and each `agentq <cmd> --help` |
| Configure / debug the GitHub workflow | [`agentq-actions/docs/USAGE.md`](https://github.com/HorizonMedia/agentq-actions/blob/main/docs/USAGE.md) |
| Diagnose a CI failure | [`agentq-actions/docs/TROUBLESHOOTING.md`](https://github.com/HorizonMedia/agentq-actions/blob/main/docs/TROUBLESHOOTING.md) |
| Understand the branch model + promotion gates | [`agentq-actions/docs/BRANCH_MODEL.md`](https://github.com/HorizonMedia/agentq-actions/blob/main/docs/BRANCH_MODEL.md) |
| Bootstrap a new GCP project | [`agentq-actions/docs/SETUP.md`](https://github.com/HorizonMedia/agentq-actions/blob/main/docs/SETUP.md) |
| Add a new file format to KB / tool readers | [`docs/PROJECT_STRUCTURE.md`](../README.md#file-handling-uploaded-files-in-agentq) (in scaffolded projects) |

---

## Legacy mode (no GitOps)

If you answered `n` to the GitOps prompt in step 2:

- No `.github/workflows/` or `docs/CICD_SETUP.md` are scaffolded.
- `agentq.config.yaml` uses schema v1 with only the `deployment:` and
  `knowledge_base:` blocks.
- Deploy from your laptop with `agentq deploy` (no `--tier`).
- State persists as `deployment.resource_name` in the tracked YAML.

Skip steps 3, 4, 5, and 9. Everything else still applies. You can opt into
GitOps later by editing the YAML to add `gitops:` and `tiers:`, then
running `agentq state import` to bring the live engine under GitOps.
