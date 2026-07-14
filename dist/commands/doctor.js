// `agentq doctor` — preflight checks. Anything that can be diagnosed before
// the user wastes 5 minutes on a broken deploy.
import path from 'node:path';
import fs from 'fs-extra';
import chalk from 'chalk';
import { findProjectRoot, projectPaths, paths } from '../lib/paths.js';
import { loadConfig } from '../lib/config.js';
import { findSystemPython } from '../lib/python.js';
import { gcloud, checkAdcAuth, activeAccount, checkApisEnabled } from '../lib/gcp.js';
import { log } from '../lib/logger.js';
function fmt(c) {
    const icon = c.status === 'ok' ? chalk.green('✓')
        : c.status === 'warn' ? chalk.yellow('⚠')
            : chalk.red('✗');
    const label = `  ${icon} ${c.name}`;
    return c.detail ? `${label} ${chalk.gray('— ' + c.detail)}` : label;
}
const REQUIRED_APIS = [
    'aiplatform.googleapis.com',
    'storage.googleapis.com',
    'discoveryengine.googleapis.com',
];
export const doctorCommand = {
    command: 'doctor',
    describe: 'Diagnose local + cloud setup before deploying.',
    builder: (y) => y.option('project-dir', { type: 'string' })
        .option('tier', { type: 'string', describe: 'Verify a specific tier (dev|staging|prod): its project, runtime SA, and secret access.' }),
    handler: async (argv) => {
        log.banner('agentq doctor');
        const checks = [];
        // Node / package
        checks.push({ name: `Node ${process.version}`, status: 'ok' });
        // gcloud
        try {
            const r = await gcloud(['--version']);
            const first = r.stdout.split('\n')[0];
            checks.push({ name: 'gcloud installed', status: 'ok', detail: first });
        }
        catch (err) {
            checks.push({ name: 'gcloud installed', status: 'fail', detail: err.message });
        }
        // Active account
        const acct = await activeAccount();
        checks.push(acct
            ? { name: 'gcloud account', status: 'ok', detail: acct }
            : { name: 'gcloud account', status: 'warn', detail: 'no account configured (gcloud auth login)' });
        // ADC
        const adc = await checkAdcAuth();
        checks.push(adc.ok
            ? { name: 'application-default credentials', status: 'ok' }
            : { name: 'application-default credentials', status: 'fail', detail: 'run: gcloud auth application-default login' });
        // Python
        try {
            const py = await findSystemPython();
            checks.push({ name: 'system Python', status: 'ok', detail: py });
        }
        catch (err) {
            checks.push({ name: 'system Python', status: 'fail', detail: err.message });
        }
        // Project config
        const root = argv['project-dir']
            ? path.resolve(argv['project-dir'])
            : (await findProjectRoot()) ?? null;
        if (!root) {
            checks.push({ name: 'agentq.config.yaml', status: 'warn', detail: 'not in an AgentQ project' });
            checks.forEach((c) => log.raw(fmt(c)));
            return;
        }
        try {
            const cfg = await loadConfig(path.join(root, 'agentq.config.yaml'));
            checks.push({ name: 'agentq.config.yaml', status: 'ok', detail: cfg.project.name });
            const pp = projectPaths(root, cfg.project.package);
            checks.push({
                name: 'src/<package>/ exists',
                status: (await fs.pathExists(pp.packageDir)) ? 'ok' : 'fail',
                detail: pp.packageDir,
            });
            // APIs
            const apiStatus = await checkApisEnabled(cfg.deployment.gcp_project, REQUIRED_APIS);
            for (const [api, on] of Object.entries(apiStatus)) {
                checks.push({
                    name: `API: ${api}`,
                    status: on ? 'ok' : 'fail',
                    detail: on ? undefined : `enable: gcloud services enable ${api} --project=${cfg.deployment.gcp_project}`,
                });
            }
            // Region sanity
            checks.push(cfg.deployment.location !== 'global'
                ? { name: 'Agent Engine location is regional', status: 'ok', detail: cfg.deployment.location }
                : { name: 'Agent Engine location is regional', status: 'fail', detail: '"global" is not allowed; use a regional id like us-central1' });
            // Python runtime bundle
            checks.push({
                name: 'bundled Python runtime',
                status: (await fs.pathExists(path.join(paths.pythonRuntime, 'agentq_runtime'))) ? 'ok' : 'fail',
            });
            // Venv presence (informational)
            const venvOk = await fs.pathExists(pp.venv);
            checks.push({
                name: '.agentq/venv',
                status: venvOk ? 'ok' : 'warn',
                detail: venvOk ? undefined : 'will be created on first deploy',
            });
            // Secret Manager preflight — catches the "works in dev, denied in
            // staging/prod" class of failures BEFORE the engine ships broken. For
            // every *_SECRET_REF in env_vars, resolve {project} to the target tier's
            // project, then verify the secret exists and the runtime SA can read it.
            const envVars = (cfg.runtime.env_vars ?? {});
            const secretRefs = Object.entries(envVars).filter(([k]) => k.endsWith('_SECRET_REF'));
            if (secretRefs.length > 0) {
                const tierName = argv.tier;
                const tierCfg = tierName && cfg.tiers ? cfg.tiers[tierName] : undefined;
                if (tierName && !tierCfg) {
                    checks.push({ name: `tier: ${tierName}`, status: 'fail', detail: 'not defined in tiers.* — check the spelling' });
                }
                const secretProject = tierCfg?.gcp_project ?? cfg.deployment.gcp_project;
                const runtimeSa = tierCfg?.runtime_service_account ?? null;
                for (const [key, rawRef] of secretRefs) {
                    const ref = rawRef.split('{project}').join(secretProject);
                    const secretName = ref.match(/secrets\/([^/]+)/)?.[1] ?? ref;
                    const where = `${secretName} (${secretProject})`;
                    let exists = true;
                    try {
                        await gcloud(['secrets', 'describe', secretName, `--project=${secretProject}`]);
                    }
                    catch {
                        exists = false;
                    }
                    if (!exists) {
                        checks.push({ name: `secret ${key}`, status: 'fail', detail: `${where} not found — create it and add the value` });
                        continue;
                    }
                    if (!runtimeSa) {
                        checks.push({ name: `secret ${key}`, status: 'warn', detail: `${where} exists; pass --tier <t> to verify the runtime SA can read it` });
                        continue;
                    }
                    let hasAccess = false;
                    try {
                        const r = await gcloud(['secrets', 'get-iam-policy', secretName, `--project=${secretProject}`, '--format=json']);
                        const policy = JSON.parse(r.stdout || '{}');
                        hasAccess = (policy.bindings ?? []).some((b) => b.role === 'roles/secretmanager.secretAccessor' && (b.members ?? []).includes(`serviceAccount:${runtimeSa}`));
                    }
                    catch {
                        hasAccess = false;
                    }
                    checks.push(hasAccess
                        ? { name: `secret ${key}`, status: 'ok', detail: `${where} readable by ${runtimeSa}` }
                        : { name: `secret ${key}`, status: 'fail', detail: `grant roles/secretmanager.secretAccessor on ${where} to ${runtimeSa}` });
                }
            }
        }
        catch (err) {
            checks.push({ name: 'agentq.config.yaml', status: 'fail', detail: err.message });
        }
        log.raw('');
        checks.forEach((c) => log.raw(fmt(c)));
        log.raw('');
        const failed = checks.filter((c) => c.status === 'fail').length;
        if (failed > 0) {
            log.error(`${failed} check(s) failed. Fix the items above before deploying.`);
            process.exitCode = 1;
        }
        else {
            log.success('All clear.');
        }
    },
};
//# sourceMappingURL=doctor.js.map