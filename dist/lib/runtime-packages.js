// Packages every AgentQ deployment needs in its container.
// The Agent Engine SDK validates these are present at deploy time and warns
// if they are missing. Keep this list in sync with REQUIRED_RUNTIME_PACKAGES
// in python/agentq_runtime/deploy.py — that file performs a defensive merge
// at deploy time so projects scaffolded before this change still work.
const BASE = [
    'google-adk>=1.27.0',
    'google-genai>=1.0.0',
    'google-cloud-aiplatform[adk]>=1.95.0',
    'cloudpickle>=3.0.0',
    'pydantic>=2.5.0',
];
const KB_VERTEX = [
    'google-cloud-discoveryengine>=0.13.0',
    'google-cloud-storage>=2.14.0',
];
const FILE_TOOLS = [
    'pypdf>=4.0.0',
    'python-docx>=1.1.0',
    'openpyxl>=3.1.0',
];
export function buildRuntimePackages(opts) {
    const out = [...BASE];
    if (opts.kb === 'gemini-enterprise-search')
        out.push(...KB_VERTEX);
    if (opts.files)
        out.push(...FILE_TOOLS);
    return out;
}
//# sourceMappingURL=runtime-packages.js.map