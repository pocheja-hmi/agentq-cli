// Tiny mustache-style renderer. Supports {{var}} and {{#section}}…{{/section}}.
// Kept intentionally minimal — adding a real template engine would invert the
// dependency graph and force every template to opt out of its features.
//
// Section semantics:
//   {{#truthy}}…{{/truthy}}    rendered when ctx[truthy] is truthy
//   {{^falsy}}…{{/falsy}}      rendered when ctx[falsy] is falsy
//   {{#list}}…{{/list}}        rendered once per item in ctx[list], with each
//                              item's keys exposed inside the block.
//
// No partials, no helpers — by design. Composition happens at the file level.

export type TemplateContext = Record<string, unknown>;

const SECTION = /\{\{([#^])\s*([\w.]+)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/g;
const VAR     = /\{\{\s*([\w.]+)\s*\}\}/g;

function lookup(ctx: TemplateContext, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, ctx);
}

function isTruthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(v);
}

export function render(template: string, ctx: TemplateContext): string {
  // Sections first (so variables inside dropped sections aren't substituted).
  let out = template.replace(SECTION, (_match, marker: string, key: string, body: string) => {
    const val = lookup(ctx, key);
    const truthy = isTruthy(val);
    if (marker === '^') return truthy ? '' : render(body, ctx);
    if (Array.isArray(val)) {
      return val.map((item) => render(body, { ...ctx, ...(typeof item === 'object' ? item as TemplateContext : { '.': item }) })).join('');
    }
    return truthy ? render(body, ctx) : '';
  });
  // Then plain variables.
  out = out.replace(VAR, (_match, key: string) => {
    const v = lookup(ctx, key);
    return v === undefined || v === null ? '' : String(v);
  });
  return out;
}
