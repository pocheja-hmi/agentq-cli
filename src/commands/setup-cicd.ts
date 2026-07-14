// `agentq setup-cicd` — one-shot WIF + SA + state-bucket bootstrap.
//
// Provisions everything needed for GitHub Actions to deploy AgentQ projects
// into a GCP project via OIDC + Workload Identity Federation. Run ONCE per
// GCP project (not per AgentQ project) by an ops user with project-level
// IAM authority.
//
// Resources created (all idempotent):
//   1. Required APIs enabled.
//   2. Workload Identity Pool 'agentq-pool'.
//   3. OIDC Provider 'github' on that pool, attribute-restricted to the
//      caller's GitHub repo(s).
//   4. Service accounts:
//        agentq-deploy-<tier>   per tier listed in --tiers
//        agentq-runtime-<tier>  per tier listed in --tiers
//        agentq-plan            (one per GCP, used for PR plans)
//   5. IAM bindings on each SA per the topology defined in the GitOps plan.
//   6. State bucket gs://<gcp-project>-agentq-state (versioning + 30-day
//      noncurrent retention) — or a custom name via --state-bucket.
//
// Re-running is safe: every step checks for existence first. Outputs a
// summary block at the end with the values to paste into tiers.* and the
// scaffolded workflow's inputs.
import { execa } from 'execa';
import type { CommandModule, Argv } from 'yargs';
import { gcloud } from '../lib/gcp.js';
import { log } from '../lib/logger.js';
import { AgentqError } from '../lib/errors.js';

interface Args {
  'gcp-project': string;
  'github-org': string;
  'github-repo': string[];
  'state-bucket'?: string;
  'staging-bucket'?: string;
  tiers: string[];
  secret: string[];
  'pool-id': string;
  'provider-id': string;
  'dry-run': boolean;
}

const REQUIRED_APIS = [
  'aiplatform.googleapis.com',
  'discoveryengine.googleapis.com',
  'iam.googleapis.com',
  'iamcredentials.googleapis.com',
  'sts.googleapis.com',
  'storage.googleapis.com',
  'cloudresourcemanager.googleapis.com',
];

/** Per-SA project-level IAM roles. */
const DEPLOY_SA_ROLES = [
  'roles/aiplatform.user',
  'roles/storage.objectAdmin',
  'roles/discoveryengine.editor',
  'roles/iam.serviceAccountUser',     // to impersonate the runtime SA at deploy time
  'roles/iam.serviceAccountTokenCreator',
];

const RUNTIME_SA_ROLES = [
  // Minimal — the runtime SA is the identity Agent Engine assumes. Add
  // app-specific roles per project as needed; out of scope for the bootstrap.
  'roles/aiplatform.user',
];

const PLAN_SA_ROLES = [
  'roles/aiplatform.viewer',
  'roles/storage.objectViewer',
  'roles/discoveryengine.viewer',
];

export const setupCicdCommand: CommandModule<{}, Args> = {
  command: 'setup-cicd',
  describe: 'One-shot bootstrap: WIF + service accounts + state bucket for a GCP project. Run once per GCP project.',
  builder: (y: Argv) =>
    y.option('gcp-project',  { type: 'string', demandOption: true, describe: 'GCP project ID to bootstrap (e.g. my-dev-gcp).' })
     .option('github-org',   { type: 'string', demandOption: true, describe: 'GitHub org or user that owns the agentq projects.' })
     .option('github-repo',  { type: 'array', string: true, demandOption: true, describe: 'GitHub repo names (without org prefix). Repeatable: --github-repo foo --github-repo bar.' })
     .option('state-bucket',   { type: 'string', describe: 'GCS bucket for state files (default: gs://<gcp-project>-agentq-state).' })
     .option('staging-bucket', { type: 'string', describe: 'GCS bucket for Vertex Agent Engine staging tarballs (default: gs://<gcp-project>-agentq-staging). Vertex requires storage.buckets.get + objects.create on this bucket.' })
     .option('tiers',          { type: 'array', string: true, default: ['dev'], describe: 'Which tiers to create deploy + runtime SAs for. Pass --tiers dev for dev GCPs; --tiers staging --tiers prod for prod GCPs.' })
     .option('secret',         { type: 'array', string: true, default: [], describe: 'App secret name(s) to provision in this GCP: creates an (empty) Secret Manager secret and grants every runtime SA roles/secretmanager.secretAccessor. Repeatable. Populate the VALUE separately (never via this flag): printf %s "$VAL" | gcloud secrets versions add <name> --project=<gcp> --data-file=-' })
     .option('pool-id',      { type: 'string', default: 'agentq-pool' })
     .option('provider-id',  { type: 'string', default: 'github' })
     .option('dry-run',      { type: 'boolean', default: false, describe: 'Print every gcloud command without executing.' }) as Argv<Args>,
  handler: async (argv) => {
    const project = argv['gcp-project'];
    const githubOrg = argv['github-org'];
    const repos = argv['github-repo'];
    const tiers = argv.tiers;
    const secrets = argv.secret;

    // Validate --github-repo values: must be bare repo names (no org prefix,
    // no slashes). A slash here would produce a WIF attribute condition like
    // `assertion.repository == 'org/sub/repo'` that no GitHub OIDC token can
    // ever satisfy — the deploy would later fail with `unauthorized_client`,
    // far from this command, with no obvious cause.
    for (const r of repos) {
      if (r.includes('/')) {
        const guessOrg = r.split('/')[0];
        const guessRepo = r.split('/').slice(1).join('/');
        throw new AgentqError(
          `--github-repo must be a bare repo name (no slashes). Got: '${r}'.`,
          `Did you mean --github-org ${guessOrg} --github-repo ${guessRepo}? ` +
          `The flag expects just the repo name; the org is already provided via --github-org.`,
        );
      }
      if (!/^[A-Za-z0-9._-]+$/.test(r)) {
        throw new AgentqError(
          `--github-repo '${r}' has invalid characters. Use only letters, digits, '.', '-', and '_'.`,
        );
      }
    }
    if (githubOrg.includes('/')) {
      throw new AgentqError(
        `--github-org must be a bare org/user name (no slashes). Got: '${githubOrg}'.`,
      );
    }
    const stateBucket = argv['state-bucket']
      ?? `gs://${project}-agentq-state`;
    const stagingBucket = argv['staging-bucket']
      ?? `gs://${project}-agentq-staging`;
    const dryRun = argv['dry-run'];
    const poolId = argv['pool-id'];
    const providerId = argv['provider-id'];

    log.banner(`Bootstrapping ${project} for AgentQ GitOps`);
    log.info(`GitHub org:       ${githubOrg}`);
    log.info(`GitHub repos:     ${repos.join(', ')}`);
    log.info(`Tiers in this GCP: ${tiers.join(', ')}`);
    log.info(`WIF pool / prov:  ${poolId} / ${providerId}`);
    log.info(`State bucket:     ${stateBucket}`);
    log.info(`Staging bucket:   ${stagingBucket}`);
    if (dryRun) log.warn('[DRY RUN] No changes will be made.');

    // Look up the numeric project number — needed for the WIF provider URI.
    const projectNumber = await fetchProjectNumber(project);
    log.info(`Project number:   ${projectNumber}`);

    // 1. Enable APIs.
    log.banner('Step 1/6 — enable APIs');
    for (const api of REQUIRED_APIS) {
      await idempotent(dryRun, `enable ${api}`, ['services', 'enable', api, `--project=${project}`]);
    }

    // 2. WIF pool.
    log.banner('Step 2/6 — Workload Identity Pool');
    await idempotent(
      dryRun,
      `create pool ${poolId}`,
      [
        'iam', 'workload-identity-pools', 'create', poolId,
        '--location=global',
        '--display-name=AgentQ GitHub Actions',
        `--project=${project}`,
      ],
      ['ALREADY_EXISTS'],
    );

    // 3. WIF provider.
    //
    // "Ensure exists, then ensure desired state." `create-oidc` swallows
    // ALREADY_EXISTS as success — without a follow-up `update-oidc`, a
    // re-run with new --github-org / --github-repo would silently leave the
    // OLD attribute-condition in place.
    //
    // Symptom of the older shape (OR'd repo list): WIF auth from CI failed
    // with `unauthorized_client` because the persisted condition's
    // `assertion.repository == 'org/repo'` literal didn't match what the
    // live GitHub OIDC token actually claimed — typically because the
    // condition was written for a previous repo/org combination.
    //
    // Fix: condition is now ORG-equality (`assertion.repository_owner`),
    // not a per-repo OR list. Adding a new repo no longer requires
    // re-running setup-cicd to update the provider; the IAM binding on
    // each SA is the per-repo gate instead. Also follow create with an
    // update so condition + mapping always reflect current desired state.
    log.banner('Step 3/6 — OIDC provider for GitHub');
    const attrCondition = `assertion.repository_owner == '${githubOrg}' && (assertion.ref.startsWith('refs/heads/') || assertion.ref.startsWith('refs/pull/'))`;
    // attribute.repository_owner is required for the org-wide principalSet
    // binding pattern (Pattern C, see bindWifToSA opts). Without it the
    // principal `attribute.repository_owner/<org>` never matches anything.
    const attrMapping = 'google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner,attribute.ref=assertion.ref,attribute.actor=assertion.actor,attribute.environment=assertion.environment';

    await idempotent(
      dryRun,
      `create provider ${providerId}`,
      [
        'iam', 'workload-identity-pools', 'providers', 'create-oidc', providerId,
        `--workload-identity-pool=${poolId}`,
        '--location=global',
        '--issuer-uri=https://token.actions.githubusercontent.com',
        `--attribute-mapping=${attrMapping}`,
        `--attribute-condition=${attrCondition}`,
        `--project=${project}`,
      ],
      ['ALREADY_EXISTS'],
    );

    // Sync condition + mapping to the current desired state regardless of
    // whether the provider was just created or already existed. Retries on
    // transient (e.g. provider not yet fully propagated right after create).
    await idempotent(
      dryRun,
      `sync provider ${providerId} attribute-condition`,
      [
        'iam', 'workload-identity-pools', 'providers', 'update-oidc', providerId,
        `--workload-identity-pool=${poolId}`,
        '--location=global',
        `--attribute-mapping=${attrMapping}`,
        `--attribute-condition=${attrCondition}`,
        `--project=${project}`,
      ],
      [],
      { retryOnTransient: true },
    );

    // 4. Service accounts + IAM.
    log.banner('Step 4/6 — service accounts');
    const saEmails: Record<string, string> = {};

    for (const tier of tiers) {
      const deployEmail = `agentq-deploy-${tier}@${project}.iam.gserviceaccount.com`;
      const runtimeEmail = `agentq-runtime-${tier}@${project}.iam.gserviceaccount.com`;
      saEmails[`deploy-${tier}`] = deployEmail;
      saEmails[`runtime-${tier}`] = runtimeEmail;

      await ensureSA(project, `agentq-deploy-${tier}`, `AgentQ CI deployer (${tier})`, dryRun);
      await ensureSA(project, `agentq-runtime-${tier}`, `AgentQ engine runtime (${tier})`, dryRun);

      for (const role of DEPLOY_SA_ROLES) {
        await addProjectIamBinding(project, deployEmail, role, dryRun);
      }
      for (const role of RUNTIME_SA_ROLES) {
        await addProjectIamBinding(project, runtimeEmail, role, dryRun);
      }

      // Deploy SA needs to impersonate the runtime SA.
      await addServiceAccountIamBinding(
        project, runtimeEmail, deployEmail,
        'roles/iam.serviceAccountUser', dryRun,
      );
      await addServiceAccountIamBinding(
        project, runtimeEmail, deployEmail,
        'roles/iam.serviceAccountTokenCreator', dryRun,
      );

      // Bind WIF principalSet for this repo + branch to the deploy SA.
      //
      // Pattern C (hybrid scope):
      //   - dev tier: ORG-wide binding. Any new repo under the org can
      //     deploy to dev without re-running setup-cicd. Lower-stakes
      //     environment, so the broader scope is fine.
      //   - staging / prod: PER-REPO binding. Each repo must be explicitly
      //     allowed to deploy to higher tiers. Adding a new repo requires
      //     re-running setup-cicd for those projects — by design.
      const branchRef = branchRefForTier(tier);
      const scope: WifScope = tier === 'dev' ? 'org' : 'repo';
      if (scope === 'org') {
        // One binding covers every repo under the org for this SA.
        await bindWifToSA(
          project, projectNumber, poolId, githubOrg, repos[0], branchRef,
          deployEmail, dryRun, { scope: 'org', refMatch: 'exact' },
        );
      } else {
        for (const repo of repos) {
          await bindWifToSA(
            project, projectNumber, poolId, githubOrg, repo, branchRef,
            deployEmail, dryRun, { scope: 'repo', refMatch: 'exact' },
          );
        }
      }
    }

    // Plan SA: one per GCP, used for PR runs across every repo in the org.
    // Org-wide binding (same logic as dev) so new repos can run plans
    // without re-running setup-cicd.
    const planEmail = `agentq-plan@${project}.iam.gserviceaccount.com`;
    saEmails['plan'] = planEmail;
    await ensureSA(project, 'agentq-plan', 'AgentQ PR-plan (read-only)', dryRun);
    for (const role of PLAN_SA_ROLES) {
      await addProjectIamBinding(project, planEmail, role, dryRun);
    }
    await bindWifToSA(
      project, projectNumber, poolId, githubOrg, repos[0], 'refs/pull/*',
      planEmail, dryRun, { scope: 'org', refMatch: 'pr-prefix' },
    );

    // 5. State + staging buckets.
    //
    // Vertex Agent Engine's create() does a `storage.buckets.get` on the
    // staging bucket BEFORE uploading the tarball, which requires
    // `storage.buckets.get` — not granted by `roles/storage.objectAdmin`.
    // Project-level `roles/storage.objectAdmin` is therefore insufficient
    // for the deploy SA. Granting `roles/storage.admin` scoped to just
    // these two buckets gives Vertex what it needs without granting
    // project-wide storage admin.
    log.banner('Step 5/6 — state + staging buckets');
    await ensureStateBucket(project, stateBucket, dryRun);
    await ensureStateBucket(project, stagingBucket, dryRun);

    for (const tier of tiers) {
      const deployEmail = saEmails[`deploy-${tier}`];
      // Deploy SA: full admin on staging (for Vertex tarball upload + the
      // pre-upload bucket-metadata read) and on state (for read/write of
      // state.yaml + versioning operations).
      await addBucketIamBinding(stagingBucket, deployEmail, 'roles/storage.admin', dryRun);
      await addBucketIamBinding(stateBucket,   deployEmail, 'roles/storage.admin', dryRun);
    }
    // Plan SA: read-only on state so PR-time plans can compare against
    // the last applied state without modifying it.
    await addBucketIamBinding(stateBucket, planEmail, 'roles/storage.objectViewer', dryRun);
    // Plan SA also needs bucket-metadata read on staging for any
    // `agentq doctor`-style checks that hit Vertex APIs with the plan SA.
    await addBucketIamBinding(stagingBucket, planEmail, 'roles/storage.legacyBucketReader', dryRun);

    // Application secrets (opt-in via --secret). Provisions the Secret Manager
    // SHELL only — the value is never passed through this command. Each secret
    // must exist in EVERY tier's GCP with the runtime SA granted accessor, so
    // config can use a project-relative ref (projects/{project}/secrets/<n>/…)
    // that resolves to each tier's own project. This is the fix for the
    // "works in dev, denied in staging/prod" runtime-secret failure mode.
    if (secrets.length > 0) {
      log.banner('Extra — application secrets');
      const runtimeEmails = tiers.map((t) => saEmails[`runtime-${t}`]);
      for (const secretName of secrets) {
        await ensureSecret(project, secretName, dryRun);
        for (const rt of runtimeEmails) {
          await addSecretIamBinding(project, secretName, rt, dryRun);
        }
      }
    }

    // 6. Summary.
    log.banner('Step 6/6 — done — copy these into your project configs');
    const wifProviderUri = `projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`;

    // Which workflow placeholder does THIS GCP's provider fill? A GCP that
    // hosts staging/prod is the "prod GCP"; a dev-only GCP is the "dev GCP".
    // When one GCP hosts every tier, both placeholders resolve to it (the
    // scaffold emits the same token for both, so a single replace covers it).
    const hostsProdTier = tiers.some((t) => t === 'staging' || t === 'prod');
    const providerToken = hostsProdTier
      ? 'REPLACE_ME_prod_gcp_wif_provider'
      : 'REPLACE_ME_dev_gcp_wif_provider';

    log.raw('');
    log.raw(`# workload_identity_provider for this GCP (${project}):`);
    log.raw(`#   ${wifProviderUri}`);
    log.raw(`# In .github/workflows/agentq-deploy.yml, replace this token with the URI above:`);
    log.raw(`#   ${providerToken}`);
    log.raw('');
    log.raw(`# Service accounts (paste into tiers.<t> blocks of agentq.config.yaml):`);
    for (const tier of tiers) {
      log.raw(`tiers.${tier}.deployer_service_account: ${saEmails[`deploy-${tier}`]}`);
      log.raw(`tiers.${tier}.runtime_service_account:  ${saEmails[`runtime-${tier}`]}`);
    }
    log.raw('');
    log.raw(`# Plan SA (used for PR runs across ALL tiers in this GCP):`);
    log.raw(`plan_service_account: ${planEmail}`);
    log.raw('');
    log.raw(`# State bucket (paste into tiers.<t>.state_bucket OR the workflow's state_bucket input):`);
    log.raw(`state_bucket: ${stateBucket}`);
    log.raw('');
    log.raw(`# Staging bucket (paste into tiers.<t>.staging_bucket of agentq.config.yaml):`);
    log.raw(`staging_bucket: ${stagingBucket}`);
    if (secrets.length > 0) {
      log.raw('');
      log.raw(`# Secrets provisioned in ${project} (shells only — now add the VALUE):`);
      for (const s of secrets) {
        log.raw(`#   printf %s "$VALUE" | gcloud secrets versions add ${s} --project=${project} --data-file=-`);
      }
      log.raw(`# Reference them project-relatively in runtime.env_vars so every tier reads its own project:`);
      for (const s of secrets) {
        log.raw(`#   <KEY>_SECRET_REF: projects/{project}/secrets/${s}/versions/latest`);
      }
      log.raw(`# Verify per tier: agentq doctor --tier <t>`);
    }
    log.raw('');
    log.success('CI/CD bootstrap complete.');
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

async function fetchProjectNumber(project: string): Promise<string> {
  const r = await gcloud(['projects', 'describe', project, '--format=value(projectNumber)']);
  const num = r.stdout.trim();
  if (!num) throw new AgentqError(`Could not fetch projectNumber for ${project}.`);
  return num;
}

/** Substrings that indicate a transient eventual-consistency error — the
 *  resource WILL exist after a brief wait. SA creation propagation is the
 *  classic case: gcloud iam SA create returns success, but adding an IAM
 *  binding to that SA can fail for ~5s with "does not exist". */
const TRANSIENT_ERROR_PATTERNS = [
  /does not exist/i,
  /\bnot found\b/i,
  /resource was not found/i,
];

async function idempotent(
  dryRun: boolean,
  label: string,
  args: string[],
  okExitMarkers: string[] = ['already exists'],
  opts: { retryOnTransient?: boolean } = {},
): Promise<void> {
  if (dryRun) {
    log.info(`[DRY] gcloud ${args.join(' ')}  # ${label}`);
    return;
  }
  const maxAttempts = opts.retryOnTransient ? 8 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await execa('gcloud', args);
      log.success(label);
      return;
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const out = (e.stderr || e.message || '').toLowerCase();
      if (okExitMarkers.some((m) => out.includes(m.toLowerCase()))) {
        log.info(`${label} — already present`);
        return;
      }
      const transient = TRANSIENT_ERROR_PATTERNS.some((p) => p.test(out));
      if (transient && attempt < maxAttempts) {
        const delayMs = Math.min(1000 * Math.pow(1.5, attempt - 1), 8000);
        log.debug(`${label} — transient error (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms`);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw new AgentqError(`${label} failed: ${e.stderr || e.message}`);
    }
  }
}

async function ensureSA(project: string, name: string, displayName: string, dryRun: boolean): Promise<void> {
  await idempotent(
    dryRun,
    `create SA ${name}`,
    [
      'iam', 'service-accounts', 'create', name,
      `--display-name=${displayName}`,
      `--project=${project}`,
    ],
    ['ALREADY_EXISTS', 'already exists'],
  );
}

async function addProjectIamBinding(
  project: string, member: string, role: string, dryRun: boolean,
): Promise<void> {
  await idempotent(
    dryRun,
    `grant ${role} to ${member}`,
    [
      'projects', 'add-iam-policy-binding', project,
      `--member=serviceAccount:${member}`,
      `--role=${role}`,
      '--condition=None',
      '--no-user-output-enabled',
    ],
    [],
    // Retry on transient "service account does not exist" — fresh SA
    // creation takes a few seconds to propagate to IAM.
    { retryOnTransient: true },
  );
}

async function addServiceAccountIamBinding(
  project: string, saEmail: string, memberSa: string, role: string, dryRun: boolean,
): Promise<void> {
  await idempotent(
    dryRun,
    `bind ${role} on ${saEmail} → ${memberSa}`,
    [
      'iam', 'service-accounts', 'add-iam-policy-binding', saEmail,
      `--member=serviceAccount:${memberSa}`,
      `--role=${role}`,
      `--project=${project}`,
      '--no-user-output-enabled',
    ],
    [],
    { retryOnTransient: true },
  );
}

export type WifScope = 'org' | 'repo';
export type WifRefMatch = 'exact' | 'pr-prefix';

interface WifBindOpts {
  /** `org` = any repo under the org may impersonate.
   *  `repo` = only the named repo may impersonate. */
  scope: WifScope;
  /** `exact` = only the given branch ref (`<ref>`) may impersonate.
   *  `pr-prefix` = only pull-request events may impersonate. */
  refMatch: WifRefMatch;
}

/**
 * Build the WIF member string that restricts WHO may impersonate the SA.
 *
 * WHY NOT AN IAM CONDITION: earlier versions gated the branch/PR via a CEL
 * condition on the binding (`request.auth.claims.ref == ...`). That does not
 * work — IAM policy-binding conditions on `roles/iam.workloadIdentityUser`
 * cannot read the federated token's claims, so the condition is always false
 * and every impersonation is denied (403 getAccessToken). The restriction
 * MUST be encoded in the principal/principalSet itself, using attributes that
 * the provider maps (google.subject, attribute.ref, attribute.repository_owner).
 *
 * GitHub's default `sub` (mapped to google.subject) encodes repo + trigger:
 *   push:         repo:<org>/<repo>:ref:refs/heads/<branch>
 *   pull_request: repo:<org>/<repo>:pull_request
 * so a single-identity `principal://.../subject/<sub>` pins repo AND branch/PR
 * with no condition. Org-wide scopes fall back to a principalSet on a mapped
 * attribute (attribute.ref pins the branch; attribute.repository_owner pins
 * only the org — acceptable for the read-only plan SA).
 */
function wifMember(
  projectNumber: string, poolId: string,
  githubOrg: string, githubRepo: string, ref: string,
  opts: WifBindOpts,
): string {
  const res = `iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}`;
  if (opts.scope === 'repo') {
    // Pin this exact repo + trigger via google.subject.
    const sub = opts.refMatch === 'pr-prefix'
      ? `repo:${githubOrg}/${githubRepo}:pull_request`
      : `repo:${githubOrg}/${githubRepo}:ref:${ref}`;
    return `principal://${res}/subject/${sub}`;
  }
  // Org-wide.
  if (opts.refMatch === 'exact') {
    // Any repo in the org, but only on the given branch ref.
    return `principalSet://${res}/attribute.ref/${ref}`;
  }
  // Org-wide + pull requests: no principalSet can express "PR-only across the
  // org" (the PR subject is per-repo). The provider's attribute-condition
  // already limits tokens to this org on refs/heads|refs/pull, and the only
  // caller (the plan SA) is read-only, so scope to the org.
  return `principalSet://${res}/attribute.repository_owner/${githubOrg}`;
}

async function bindWifToSA(
  project: string, projectNumber: string, poolId: string,
  githubOrg: string, githubRepo: string, ref: string,
  saEmail: string, dryRun: boolean,
  opts: WifBindOpts = { scope: 'repo', refMatch: 'exact' },
): Promise<void> {
  const principal = wifMember(projectNumber, poolId, githubOrg, githubRepo, ref, opts);

  const scopeLabel = opts.scope === 'org' ? `${githubOrg}/*` : `${githubOrg}/${githubRepo}`;
  const refLabel = opts.refMatch === 'pr-prefix' ? 'PRs' : ref;
  await idempotent(
    dryRun,
    `bind WIF ${scopeLabel}@${refLabel} → ${saEmail}`,
    [
      'iam', 'service-accounts', 'add-iam-policy-binding', saEmail,
      `--member=${principal}`,
      `--role=roles/iam.workloadIdentityUser`,
      // No IAM condition — restriction is encoded in the principal (see
      // wifMember). Conditions on workloadIdentityUser can't see token claims.
      `--condition=None`,
      `--project=${project}`,
      '--no-user-output-enabled',
    ],
    [],
    { retryOnTransient: true },
  );
}

async function addBucketIamBinding(
  bucket: string, saEmail: string, role: string, dryRun: boolean,
): Promise<void> {
  // Bucket-scoped binding (gs://name) — does NOT grant project-wide access.
  // gcloud is idempotent on add-iam-policy-binding (no-op if binding exists).
  if (dryRun) {
    log.info(`[DRY] add ${role} on ${bucket} → ${saEmail}`);
    return;
  }
  try {
    await execa('gcloud', [
      'storage', 'buckets', 'add-iam-policy-binding', bucket,
      `--member=serviceAccount:${saEmail}`,
      `--role=${role}`,
      '--quiet',
    ]);
    log.info(`bound ${role} on ${bucket} → ${saEmail}`);
  } catch (err) {
    throw new AgentqError(
      `Failed to grant ${role} on ${bucket} to ${saEmail}: ${(err as Error).message}`,
    );
  }
}

async function ensureSecret(project: string, name: string, dryRun: boolean): Promise<void> {
  await idempotent(
    dryRun,
    `create secret ${name}`,
    [
      'secrets', 'create', name,
      '--replication-policy=automatic',
      `--project=${project}`,
    ],
    ['ALREADY_EXISTS', 'already exists'],
  );
}

async function addSecretIamBinding(
  project: string, secretName: string, member: string, dryRun: boolean,
): Promise<void> {
  await idempotent(
    dryRun,
    `grant secretAccessor on ${secretName} → ${member}`,
    [
      'secrets', 'add-iam-policy-binding', secretName,
      `--member=serviceAccount:${member}`,
      '--role=roles/secretmanager.secretAccessor',
      `--project=${project}`,
      '--no-user-output-enabled',
    ],
    [],
    { retryOnTransient: true },
  );
}

function branchRefForTier(tier: string): string {
  const map: Record<string, string> = {
    dev: 'refs/heads/dev',
    staging: 'refs/heads/staging',
    prod: 'refs/heads/main',
  };
  return map[tier] ?? `refs/heads/${tier}`;
}

async function ensureStateBucket(project: string, stateBucket: string, dryRun: boolean): Promise<void> {
  const name = stateBucket.replace(/^gs:\/\//, '').replace(/\/$/, '');
  // 1. Create bucket if absent.
  if (dryRun) {
    log.info(`[DRY] gsutil mb gs://${name}`);
    log.info(`[DRY] gsutil versioning set on gs://${name}`);
    return;
  }
  try {
    await execa('gcloud', ['storage', 'buckets', 'describe', `gs://${name}`, '--project', project]);
    log.info(`bucket gs://${name} — already exists`);
  } catch {
    try {
      await execa('gcloud', ['storage', 'buckets', 'create', `gs://${name}`, '--project', project, '--uniform-bucket-level-access']);
      log.success(`created gs://${name}`);
    } catch (err) {
      throw new AgentqError(`Failed to create state bucket: ${(err as Error).message}`);
    }
  }

  // 2. Enable versioning (idempotent).
  try {
    await execa('gcloud', ['storage', 'buckets', 'update', `gs://${name}`, '--versioning', '--project', project]);
    log.info(`versioning enabled on gs://${name}`);
  } catch (err) {
    log.warn(`Could not enable versioning: ${(err as Error).message}`);
  }
}
