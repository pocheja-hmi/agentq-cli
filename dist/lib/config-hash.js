// `config_hash` is the single drift token.
//
// We hash a CANONICAL serialization of the subset of agentq.config.yaml that
// actually affects deployed shape. Any change to those fields produces a new
// hash → state.engine.config_hash mismatches → drift is detected → plan runs.
//
// Fields deliberately EXCLUDED:
//   - schema_version  (a YAML format detail, not a deploy concern)
//   - observability   (callbacks attached at runtime; not part of the engine spec)
//   - hooks           (project-local; the hook IMPLEMENTATION can mutate state but
//                      changing the *path* shouldn't trigger an engine update)
//   - history         (it's the audit log; not source intent)
//   - runtime_version (CLI version; this is metadata about who deployed,
//                      not what was deployed. Bumping the CLI shouldn't
//                      mark every deployed engine as drifted.)
//   - For the resolved env_vars block: KB_DATASTORE, MODEL, and
//     GOOGLE_GENAI_USE_VERTEXAI are auto-injected by config.py from the
//     same source values that ARE hashed (kb.datastore_id, runtime.model).
//     Including them would double-count, so they're stripped.
//
// The Python side has a mirror in agentq_runtime/config_hash.py. A unit test
// in tests/ feeds the same fixture into both and asserts identical output.
// If they diverge, drift detection becomes asymmetric and plan/apply
// behavior depends on which side computed the hash — a class of bug we want
// to prevent entirely.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, posix, relative } from 'node:path';
const AUTO_INJECTED_ENV_KEYS = new Set([
    'MODEL',
    'GOOGLE_GENAI_USE_VERTEXAI',
    'KB_DATASTORE',
]);
const SRC_EXCLUDED_DIRS = new Set([
    '__pycache__', '.git', '.mypy_cache', '.pytest_cache', '.ruff_cache',
    '.tox', '.venv', 'node_modules',
]);
const SRC_EXCLUDED_SUFFIXES = ['.pyc', '.pyo'];
const SRC_EXCLUDED_FILENAMES = new Set(['.DS_Store']);
function isDir(p) {
    try {
        return statSync(p).isDirectory();
    }
    catch {
        return false;
    }
}
/** Walk a package directory and return sorted (relpath, sha256) pairs.
 *  `relpath` is rooted at the package's parent so it begins with `<pkg>/...`. */
function iterPackageFiles(root) {
    if (!isDir(root))
        return [];
    const base = join(root, '..');
    const out = [];
    const stack = [root];
    while (stack.length) {
        const dir = stack.pop();
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        // Sort for determinism (the hash doesn't care, but iteration order does
        // matter for memory locality on huge trees).
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entries) {
            if (e.isDirectory()) {
                if (SRC_EXCLUDED_DIRS.has(e.name))
                    continue;
                stack.push(join(dir, e.name));
                continue;
            }
            if (!e.isFile())
                continue;
            if (SRC_EXCLUDED_FILENAMES.has(e.name))
                continue;
            if (SRC_EXCLUDED_SUFFIXES.some((s) => e.name.endsWith(s)))
                continue;
            const full = join(dir, e.name);
            let data;
            try {
                data = readFileSync(full);
            }
            catch {
                continue;
            }
            const sha = createHash('sha256').update(data).digest('hex');
            // posix-style relpath matches the Python side (`.as_posix()`).
            const rel = relative(base, full).split(/[\\/]/g).join(posix.sep);
            out.push([rel, sha]);
        }
    }
    return out;
}
/** Resolve the set of package roots that will ship in the deploy tarball.
 *  Mirrors Python's _source_roots / deploy.py::_normalize_extra_packages. */
function sourceRoots(cfg, projectRoot) {
    const srcDir = join(projectRoot, 'src');
    const roots = [];
    const seen = new Set();
    const mainPkg = (cfg.project.package ?? '').trim();
    if (mainPkg) {
        const mainRoot = join(srcDir, mainPkg);
        if (isDir(mainRoot)) {
            roots.push(mainRoot);
            seen.add(mainPkg);
        }
    }
    for (const epRaw of cfg.runtime.extra_packages ?? []) {
        let s = (epRaw ?? '').trim();
        if (!s)
            continue;
        let p;
        let key;
        if (isAbsolute(s)) {
            p = s;
            key = p;
        }
        else {
            if (s.startsWith('./'))
                s = s.slice(2);
            if (s.startsWith('src/'))
                s = s.slice(4);
            p = join(srcDir, s);
            key = basename(s.replace(/\/+$/, '')) || s;
        }
        if (seen.has(key))
            continue;
        if (isDir(p)) {
            roots.push(p);
            seen.add(key);
        }
    }
    return roots;
}
function sourceTreeHash(cfg, projectRoot) {
    if (!projectRoot)
        return '';
    const entries = [];
    for (const r of sourceRoots(cfg, projectRoot)) {
        for (const e of iterPackageFiles(r))
            entries.push(e);
    }
    if (entries.length === 0)
        return '';
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const payload = entries.map(([p, s]) => ({ path: p, sha256: s }));
    const serial = canonical(payload);
    return 'sha256:' + createHash('sha256').update(serial, 'utf-8').digest('hex');
}
/** Stable JSON serialization: keys sorted, nulls excluded, no whitespace. */
function canonical(value) {
    if (value === null || value === undefined)
        return 'null';
    if (typeof value === 'string')
        return JSON.stringify(value);
    if (typeof value === 'number' || typeof value === 'boolean')
        return JSON.stringify(value);
    if (Array.isArray(value)) {
        return '[' + value.map(canonical).join(',') + ']';
    }
    if (typeof value === 'object') {
        const keys = Object.keys(value).sort();
        const parts = keys.map((k) => {
            const v = value[k];
            if (v === undefined || v === null)
                return null;
            return JSON.stringify(k) + ':' + canonical(v);
        }).filter((p) => p !== null);
        return '{' + parts.join(',') + '}';
    }
    // Functions, symbols, bigints — should never appear in our config.
    throw new Error(`canonical: unsupported value type ${typeof value}`);
}
/**
 * Build the "what we deployed" view of a config for hashing.
 *
 * For GitOps projects, `tier` selects which tiers.<t> branch to bake into
 * the hash. For legacy projects, `tier` is ignored and the legacy deployment
 * block is used.
 */
function deployedView(cfg, tier, projectRoot) {
    const envClean = {};
    for (const [k, v] of Object.entries(cfg.runtime.env_vars ?? {})) {
        if (AUTO_INJECTED_ENV_KEYS.has(k))
            continue;
        envClean[k] = v;
    }
    let tierBlock = null;
    if (tier && cfg.tiers && cfg.tiers[tier]) {
        const t = cfg.tiers[tier];
        tierBlock = {
            gcp_project: t.gcp_project,
            location: t.location,
            runtime_service_account: t.runtime_service_account,
            display_name_suffix: t.display_name_suffix,
            labels: t.labels,
            kb: {
                datastore_id: t.kb.datastore_id,
                bucket: t.kb.bucket,
                location: t.kb.location,
            },
        };
    }
    return {
        project: {
            name: cfg.project.name,
            package: cfg.project.package,
            display_name: cfg.project.display_name,
        },
        // Folds the package source tree into the drift token so a code-only
        // change (no YAML edit) still produces a fresh hash and triggers a
        // redeploy. Empty string when no projectRoot is supplied.
        source_tree_hash: sourceTreeHash(cfg, projectRoot),
        agent: {
            pattern: cfg.agent.pattern,
            entry_module: cfg.agent.entry_module,
            entry_symbol: cfg.agent.entry_symbol,
            sub_agents: cfg.agent.sub_agents,
        },
        runtime: {
            model: cfg.runtime.model,
            python_packages: [...cfg.runtime.python_packages].sort(),
            extra_packages: [...cfg.runtime.extra_packages].sort(),
            env_vars: envClean,
        },
        tier,
        tier_block: tierBlock,
        legacy_deployment: tierBlock ? null : {
            gcp_project: cfg.deployment.gcp_project,
            location: cfg.deployment.location,
            service_account: cfg.deployment.service_account,
        },
        legacy_kb: tierBlock ? null : {
            provider: cfg.knowledge_base.provider,
            datastore_id: cfg.knowledge_base.datastore_id,
            bucket: cfg.knowledge_base.bucket,
            location: cfg.knowledge_base.location,
        },
    };
}
/** Compute the sha256 drift token. Format: `sha256:<64-hex>`.
 *
 *  `projectRoot` lets the hash incorporate a fingerprint of the package
 *  source tree under `<projectRoot>/src/<package>/`. Pass `null` to skip
 *  the source-tree fold (fixtures / tests with no real layout on disk). */
export function computeConfigHash(cfg, tier, projectRoot = null) {
    const view = deployedView(cfg, tier, projectRoot);
    const serial = canonical(view);
    const digest = createHash('sha256').update(serial, 'utf-8').digest('hex');
    return `sha256:${digest}`;
}
/**
 * Hash a sorted document set. Used for `kb.docset_hash` — the cheap top-level
 * "did the corpus change?" check before per-file diffing.
 */
export function computeDocsetHash(documents) {
    const sorted = [...documents].sort((a, b) => a.filename.localeCompare(b.filename));
    const serial = canonical(sorted.map((d) => ({ filename: d.filename, sha256: d.sha256 })));
    const digest = createHash('sha256').update(serial, 'utf-8').digest('hex');
    return `sha256:${digest}`;
}
//# sourceMappingURL=config-hash.js.map