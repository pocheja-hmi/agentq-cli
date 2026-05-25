// Thin wrapper around gcloud. Anything that talks to gcloud goes through here
// so we have a single place to add JSON parsing, retries, or auth flows later.
import { execa } from 'execa';
import { AgentqError } from './errors.js';
export async function gcloud(args) {
    try {
        const { stdout, stderr } = await execa('gcloud', args);
        return { stdout, stderr };
    }
    catch (err) {
        const e = err;
        if (e.code === 'ENOENT') {
            throw new AgentqError('The `gcloud` command was not found on PATH.', 'Install the Google Cloud CLI: https://cloud.google.com/sdk/docs/install');
        }
        throw new AgentqError(`gcloud failed: ${e.stderr || e.message || 'unknown error'}`);
    }
}
export async function checkAdcAuth() {
    try {
        const { stdout } = await execa('gcloud', [
            'auth', 'application-default', 'print-access-token',
        ]);
        return { ok: stdout.trim().length > 0 };
    }
    catch {
        return { ok: false };
    }
}
export async function activeAccount() {
    try {
        const { stdout } = await execa('gcloud', [
            'config', 'list', 'account', '--format=value(core.account)',
        ]);
        return stdout.trim() || null;
    }
    catch {
        return null;
    }
}
export async function checkApisEnabled(project, apis) {
    const out = {};
    for (const api of apis) {
        try {
            const { stdout } = await execa('gcloud', [
                'services', 'list', '--enabled',
                `--filter=name:${api}`,
                `--project=${project}`,
                '--format=value(name)',
            ]);
            out[api] = stdout.trim().length > 0;
        }
        catch {
            out[api] = false;
        }
    }
    return out;
}
//# sourceMappingURL=gcp.js.map