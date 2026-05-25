const registry = new Map();
export function registerProvider(p) {
    registry.set(p.id, p);
}
export function getProvider(id) {
    return registry.get(id);
}
export function listProviders() {
    return [...registry.values()];
}
//# sourceMappingURL=kb-provider.js.map