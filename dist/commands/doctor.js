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
    builder: (y) => y.option('project-dir', { type: 'string' }),
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