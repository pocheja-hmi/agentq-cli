// Single class responsible for materialising a scaffold on disk.
// Open/closed: adding a new pattern means adding a template directory, not
// editing this class. This is the only file that touches fs for project
// creation — every command depends on it (DRY).
import path from 'node:path';
import fs from 'fs-extra';
import { paths } from './paths.js';
import { render, TemplateContext } from './template.js';
import { log } from './logger.js';
import { AgentqError } from './errors.js';

export interface ScaffoldOptions {
  destination: string;
  context: TemplateContext;
  /** Sources are template directories applied in order; later sources may overwrite earlier files. */
  sources: string[];
  overwrite: boolean;
  /** Replace this token in filenames with context.project.package. */
  packageToken?: string;
}

export class Scaffolder {
  async run(opts: ScaffoldOptions): Promise<string[]> {
    const { destination, context, sources, overwrite, packageToken = '__pkg__' } = opts;
    const stages = (context.stages as Array<Record<string, unknown>> | undefined) ?? [];

    if (await fs.pathExists(destination)) {
      const entries = await fs.readdir(destination);
      if (entries.length > 0 && !overwrite) {
        throw new AgentqError(
          `Destination already exists and is not empty: ${destination}`,
          'Pick a different name, or pass --force to overwrite.',
        );
      }
    }

    await fs.ensureDir(destination);
    const written: string[] = [];

    for (const source of sources) {
      const srcAbs = path.isAbsolute(source) ? source : path.join(paths.templates, source);
      if (!(await fs.pathExists(srcAbs))) {
        throw new AgentqError(`Template source missing: ${srcAbs}`);
      }
      await this.copyTree(srcAbs, destination, context, packageToken, written, stages);
    }

    return written;
  }

  /**
   * Files named `__stage__.<ext>.hbs` are expanded once per entry in
   * context.stages. Inside each rendered file, the loop variables (name,
   * index, isFirst, isLast) are merged into the top-level context.
   */
  private async copyTree(
    src: string,
    dst: string,
    ctx: TemplateContext,
    packageToken: string,
    written: string[],
    stages: Array<Record<string, unknown>>,
  ): Promise<void> {
    const stat = await fs.stat(src);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(src);
      for (const entry of entries) {
        const childSrc = path.join(src, entry);
        const renamed = entry === packageToken
          ? String((ctx.project as { package: string }).package)
          : entry;
        const childDst = path.join(dst, renamed);
        await fs.ensureDir(path.dirname(childDst));
        await this.copyTree(childSrc, childDst, ctx, packageToken, written, stages);
      }
      return;
    }

    const base = path.basename(src);
    const isHbs = src.endsWith('.hbs');
    const isStageStub = base.startsWith('__stage__');
    if (isStageStub && isHbs) {
      const raw = await fs.readFile(src, 'utf-8');
      for (const stage of stages) {
        const stageName = String(stage.name);
        const childName = base.replace(/__stage__/, stageName).slice(0, -4);
        const finalDst  = path.join(path.dirname(dst), childName);
        const merged: TemplateContext = { ...ctx, stage, ...stage };
        const out = render(raw, merged);
        await fs.writeFile(finalDst, out, 'utf-8');
        log.debug(`wrote ${path.relative(process.cwd(), finalDst)}`);
        written.push(finalDst);
      }
      return;
    }

    const finalDst = isHbs ? dst.slice(0, -4) : dst;
    if (isHbs) {
      const raw = await fs.readFile(src, 'utf-8');
      const out = render(raw, ctx);
      await fs.writeFile(finalDst, out, 'utf-8');
    } else {
      await fs.copy(src, finalDst, { overwrite: true });
    }
    log.debug(`wrote ${path.relative(process.cwd(), finalDst)}`);
    written.push(finalDst);
  }
}
