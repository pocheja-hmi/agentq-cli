// Tests for computeConfigHash, including TS↔Python parity.
//
// The Python runtime is the one actually called from `agentq plan/apply`.
// The TS implementation exists to keep parity (and to give CI a fast
// language-agnostic check). Drift between the two would make the drift
// detector itself drift — exactly the failure mode we're guarding against.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { computeConfigHash } from './config-hash.js';
const here = dirname(fileURLToPath(import.meta.url));
// dist/lib/<file>.js → repo root is ../..
const repoRoot = join(here, '..', '..');
function mkFixture() {
    const root = mkdtempSync(join(tmpdir(), 'agentq-hash-'));
    const pkg = join(root, 'src', 'demo_pkg');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, '__init__.py'), 'x = 1\n');
    writeFileSync(join(pkg, 'agent.py'), 'VALUE = "v1"\n');
    mkdirSync(join(pkg, 'sub'));
    writeFileSync(join(pkg, 'sub', 'inner.py'), '# inner\n');
    // Pollute with junk that must NOT be hashed.
    mkdirSync(join(pkg, '__pycache__'));
    writeFileSync(join(pkg, '__pycache__', 'a.pyc'), 'JUNK');
    writeFileSync(join(pkg, '.DS_Store'), 'JUNK');
    const cfg = {
        project: { name: 'demo', package: 'demo_pkg', description: '', display_name: 'Demo' },
        agent: { pattern: 'hybrid', entry_module: 'demo_pkg.agent', entry_symbol: 'root_agent', sub_agents: 0 },
        deployment: { gcp_project: 'p', location: 'us-central1', staging_bucket: 'gs://b', service_account: null, resource_name: null },
        runtime: { model: 'gemini-2.5-flash', python_packages: ['google-adk'], extra_packages: [], env_vars: {} },
        knowledge_base: { provider: 'none', datastore_id: null, bucket: null, location: 'global' },
        observability: { tracing: true, level: 'standard' },
        hooks: { pre_deploy: null, post_deploy: null },
        tiers: {},
    };
    return { root, cfg, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
test('source-tree hash: code change flips the hash', () => {
    const { root, cfg, cleanup } = mkFixture();
    try {
        const h1 = computeConfigHash(cfg, null, root);
        writeFileSync(join(root, 'src', 'demo_pkg', 'agent.py'), 'VALUE = "v2"\n');
        const h2 = computeConfigHash(cfg, null, root);
        assert.notEqual(h1, h2, 'source-only change must produce a new hash');
    }
    finally {
        cleanup();
    }
});
test('source-tree hash: junk files (pyc, __pycache__, .DS_Store) are excluded', () => {
    const { root, cfg, cleanup } = mkFixture();
    try {
        const before = computeConfigHash(cfg, null, root);
        writeFileSync(join(root, 'src', 'demo_pkg', '__pycache__', 'a.pyc'), 'ZZZZ');
        writeFileSync(join(root, 'src', 'demo_pkg', '.DS_Store'), 'ZZZZ');
        const after = computeConfigHash(cfg, null, root);
        assert.equal(before, after, 'pyc / __pycache__ / .DS_Store must not affect the hash');
    }
    finally {
        cleanup();
    }
});
test('source-tree hash: omitting projectRoot stays stable (legacy/fixture path)', () => {
    const { cfg } = mkFixture();
    const h1 = computeConfigHash(cfg, null, null);
    const h2 = computeConfigHash(cfg, null);
    assert.equal(h1, h2);
    // Should differ from the same cfg with a real source tree.
    const { root, cfg: cfg2, cleanup } = mkFixture();
    try {
        const h3 = computeConfigHash(cfg2, null, root);
        assert.notEqual(h1, h3, 'absent vs present source tree must differ');
    }
    finally {
        cleanup();
    }
});
test('TS↔Python parity on identical fixture', { skip: !pythonAvailable() }, () => {
    const { root, cfg, cleanup } = mkFixture();
    try {
        const ts = computeConfigHash(cfg, null, root);
        const py = pyHash(root);
        assert.equal(ts, py, `parity mismatch:\n  ts=${ts}\n  py=${py}`);
        writeFileSync(join(root, 'src', 'demo_pkg', 'agent.py'), 'VALUE = "v2"\n');
        const ts2 = computeConfigHash(cfg, null, root);
        const py2 = pyHash(root);
        assert.equal(ts2, py2, 'parity must hold after source change');
        assert.notEqual(ts, ts2);
    }
    finally {
        cleanup();
    }
});
function pythonAvailable() {
    try {
        const r = spawnSync('python3', ['-c', 'import sys'], { stdio: 'ignore' });
        return r.status === 0 && statSync(join(repoRoot, 'python', 'agentq_runtime', 'config_hash.py')).isFile();
    }
    catch {
        return false;
    }
}
function pyHash(projectRoot) {
    const script = `
import sys
sys.path.insert(0, ${JSON.stringify(join(repoRoot, 'python'))})
from pathlib import Path
from agentq_runtime import config as cfgmod, config_hash as ch
cfg = cfgmod.AgentqConfig(
    project=cfgmod.Project(name='demo', package='demo_pkg', description='', display_name='Demo'),
    agent=cfgmod.Agent(pattern='hybrid', entry_module='demo_pkg.agent', entry_symbol='root_agent', sub_agents=0),
    deployment=cfgmod.Deployment(gcp_project='p', location='us-central1', staging_bucket='gs://b'),
    runtime=cfgmod.Runtime(model='gemini-2.5-flash', python_packages=['google-adk'], extra_packages=[], env_vars={}),
    knowledge_base=cfgmod.KnowledgeBase(),
    observability=cfgmod.Observability(),
    hooks=cfgmod.Hooks(),
    project_root=Path(${JSON.stringify(projectRoot)}),
)
print(ch.compute_config_hash(cfg, None))
`;
    const r = spawnSync('python3', ['-c', script], { encoding: 'utf-8' });
    if (r.status !== 0)
        throw new Error('python failed: ' + r.stderr);
    return r.stdout.trim();
}
//# sourceMappingURL=config-hash.test.js.map