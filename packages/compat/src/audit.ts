import { readFileSync, readJSONSync } from 'fs-extra';
import { dirname, join, resolve as resolvePath } from 'path';
import { AppMeta, explicitRelative, hbsToJS, Resolver, ResolverOptions } from '@embroider/core';
import { Memoize } from 'typescript-memoize';
import chalk from 'chalk';
import jsdom from 'jsdom';
import groupBy from 'lodash/groupBy';
import fromPairs from 'lodash/fromPairs';
import {
  auditJS,
  CodeFrameStorage,
  ExportAll,
  InternalImport,
  isNamespaceMarker,
  NamespaceMarker,
} from './audit/babel-visitor';
import { AuditBuildOptions, AuditOptions } from './audit/options';
import { buildApp, BuildError, isBuildError } from './audit/build';
import { AuditMessage } from './resolver';

const { JSDOM } = jsdom;

export { AuditOptions, AuditBuildOptions, BuildError, isBuildError };

export interface Finding {
  message: string;
  filename: string;
  detail: string;
  codeFrame?: string;
}

export interface Module {
  consumedFrom: (string | RootMarker)[];
  imports: Import[];
  exports: string[];
  resolutions: { [source: string]: string | null };
}

interface ResolutionFailure {
  isResolutionFailure: true;
}

function isResolutionFailure(result: string | ResolutionFailure | undefined): result is ResolutionFailure {
  return typeof result === 'object' && 'isResolutionFailure' in result;
}

interface InternalModule {
  consumedFrom: (string | RootMarker)[];

  parsed?: {
    imports: InternalImport[];
    exports: Set<string | ExportAll>;
    isCJS: boolean;
    isAMD: boolean;
    dependencies: string[];
  };

  resolved?: Map<string, string | ResolutionFailure>;

  linked?: {
    exports: Set<string>;
  };
}

type ParsedInternalModule = Omit<InternalModule, 'parsed'> & {
  parsed: NonNullable<InternalModule['parsed']>;
};

type ResolvedInternalModule = Omit<ParsedInternalModule, 'resolved'> & {
  resolved: NonNullable<ParsedInternalModule['resolved']>;
};

function isResolved(module: InternalModule | undefined): module is ResolvedInternalModule {
  return Boolean(module?.parsed && module.resolved);
}

type LinkedInternalModule = Omit<ResolvedInternalModule, 'linked'> & {
  linked: NonNullable<ResolvedInternalModule['linked']>;
};

function isLinked(module: InternalModule | undefined): module is LinkedInternalModule {
  return Boolean(module?.parsed && module.resolved && module.linked);
}

export interface Import {
  source: string;
  specifiers: {
    name: string | NamespaceMarker;
    local: string | null; // can be null when re-exporting, because in that case we import `name` from `source` but don't create any local binding for it
  }[];
}

export class AuditResults {
  modules: { [file: string]: Module } = {};
  findings: Finding[] = [];

  static create(baseDir: string, findings: Finding[], modules: Map<string, InternalModule>) {
    let results = new this();
    for (let [filename, module] of modules) {
      let publicModule: Module = {
        consumedFrom: module.consumedFrom.map(entry => {
          if (isRootMarker(entry)) {
            return entry;
          } else {
            return explicitRelative(baseDir, entry);
          }
        }),
        resolutions: module.resolved
          ? fromPairs(
              [...module.resolved].map(([source, target]) => [
                source,
                isResolutionFailure(target) ? null : explicitRelative(baseDir, target),
              ])
            )
          : {},
        imports: module.parsed?.imports
          ? module.parsed.imports.map(i => ({
              source: i.source,
              specifiers: i.specifiers.map(s => ({
                name: s.name,
                local: s.local,
              })),
            }))
          : [],
        exports: module.linked?.exports ? [...module.linked.exports] : [],
      };
      results.modules[explicitRelative(baseDir, filename)] = publicModule;
    }
    for (let finding of findings) {
      let relFinding = Object.assign({}, finding, { filename: explicitRelative(baseDir, finding.filename) });
      results.findings.push(relFinding);
    }
    return results;
  }

  humanReadable(): string {
    let output = [] as string[];
    let findingsByFile = groupBy(this.findings, f => f.filename);
    output.push(`=== Audit Results ===`);
    for (let [filename, findings] of Object.entries(findingsByFile)) {
      output.push(`${chalk.yellow(filename)}`);
      for (let finding of findings) {
        output.push(indent(chalk.red(finding.message) + ': ' + finding.detail, 1));
        if (finding.codeFrame) {
          output.push(indent(finding.codeFrame, 2));
        }
      }
      output.push(indent(chalk.blueBright(`file was included because:`), 1));
      let pointer: string | RootMarker = filename;
      while (!isRootMarker(pointer)) {
        // the zero here means we only display the first path we found. I think
        // that's a fine tradeoff to keep the output smaller.
        let nextPointer: string | RootMarker | undefined = this.modules[pointer]?.consumedFrom[0];
        if (!nextPointer) {
          output.push(
            indent(
              chalk.red(`couldn't figure out why this was included. Please file a bug against @embroider/compat.`),
              2
            )
          );
          break;
        }
        if (isRootMarker(nextPointer)) {
          output.push(indent('packageJSON.ember-addon.assets', 2));
        } else {
          output.push(indent(nextPointer, 2));
        }
        pointer = nextPointer;
      }
    }
    let summaryColor;
    if (this.perfect) {
      summaryColor = chalk.green;
    } else {
      summaryColor = chalk.yellow;
    }
    output.push(summaryColor(`${this.findings.length} issues found`));
    output.push(`=== End Audit Results ===`);
    output.push(''); // always end with a newline because `yarn run` can overwrite our last line otherwise
    return output.join('\n');
  }

  get perfect() {
    return this.findings.length === 0;
  }
}

export class Audit {
  private modules: Map<string, InternalModule> = new Map();
  private moduleQueue = new Set<string>();
  private findings = [] as Finding[];

  private frames = new CodeFrameStorage();

  static async run(options: AuditBuildOptions): Promise<AuditResults> {
    if (!options['reuse-build']) {
      await buildApp(options);
    }
    let dir = await this.findStage2Output(options);

    let audit = new this(dir, options);
    if (options['reuse-build']) {
      if (!audit.meta.babel.isParallelSafe) {
        throw new BuildError(
          `You can't use the ${chalk.red(
            '--reuse-build'
          )} option because some of your babel or HBS plugins are non-serializable`
        );
      }
    }
    return audit.run();
  }

  private static async findStage2Output(options: AuditBuildOptions): Promise<string> {
    try {
      return readFileSync(join(options.app, 'dist/.stage2-output'), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new BuildError(
          `${chalk.yellow(
            'Your build'
          )} did not produce expected Embroider stage2 output.\nMake sure you actually have Embroider configured.`
        );
      }
      throw err;
    }
  }

  constructor(private appDir: string, private options: AuditOptions = {}) {}

  @Memoize()
  private get pkg() {
    return readJSONSync(join(this.appDir, 'package.json'));
  }

  private get meta() {
    return this.pkg['ember-addon'] as AppMeta;
  }

  @Memoize()
  private get babelConfig() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    let config = require(join(this.appDir, this.meta.babel.filename));
    config = Object.assign({}, config);
    config.plugins = config.plugins.filter((p: any) => !isMacrosPlugin(p));

    config.ast = true;
    return config;
  }

  private get resolverParams(): ResolverOptions {
    return readJSONSync(join(this.appDir, '.embroider', 'resolver.json'));
  }

  private resolver = new Resolver(this.resolverParams);

  private debug(message: string, ...args: any[]) {
    if (this.options.debug) {
      console.log(message, ...args);
    }
  }

  private visitorFor(
    filename: string
  ): (
    this: Audit,
    filename: string,
    content: Buffer | string
  ) => Promise<NonNullable<InternalModule['parsed']> | Finding[]> {
    if (filename.endsWith('.html')) {
      return this.visitHTML;
    } else if (filename.endsWith('.hbs')) {
      return this.visitHBS;
    } else if (filename.endsWith('.json')) {
      return this.visitJSON;
    } else {
      return this.visitJS;
    }
  }

  private async drainQueue() {
    while (this.moduleQueue.size > 0) {
      let filename = this.moduleQueue.values().next().value as string;
      this.moduleQueue.delete(filename);
      this.debug('visit', filename);
      let visitor = this.visitorFor(filename);
      let content = readFileSync(filename);
      // cast is safe because the only way to get into the queue is to go
      // through scheduleVisit, and scheduleVisit creates the entry in
      // this.modules.
      let module: InternalModule = this.modules.get(filename)!;
      let visitResult = await visitor.call(this, filename, content);
      if (Array.isArray(visitResult)) {
        // the visitor was unable to figure out the ParseFields and returned
        // some number of Findings to us to explain why.
        for (let finding of visitResult) {
          this.pushFinding(finding);
        }
      } else {
        module.parsed = visitResult;
        let resolved = new Map() as NonNullable<InternalModule['resolved']>;
        for (let dep of visitResult.dependencies) {
          let depFilename = await this.resolve(dep, filename);
          if (depFilename) {
            resolved.set(dep, depFilename);
            if (!isResolutionFailure(depFilename)) {
              this.scheduleVisit(depFilename, filename);
            }
          }
        }
        module.resolved = resolved;
      }
    }
  }

  async run(): Promise<AuditResults> {
    (globalThis as any).embroider_audit = this.handleResolverError.bind(this);

    try {
      this.debug(`meta`, this.meta);
      for (let asset of this.meta.assets) {
        if (asset.endsWith('.html')) {
          this.scheduleVisit(resolvePath(this.appDir, asset), { isRoot: true });
        }
      }
      await this.drainQueue();
      this.linkModules();
      this.inspectModules();
      return AuditResults.create(this.appDir, this.findings, this.modules);
    } finally {
      delete (globalThis as any).embroider_audit;
    }
  }

  private handleResolverError(msg: AuditMessage) {
    this.pushFinding({
      message: msg.message,
      filename: msg.filename,
      detail: msg.detail,
      codeFrame: this.frames.render(this.frames.forSource(msg.source)(msg)),
    });
  }

  private linkModules() {
    for (let module of this.modules.values()) {
      if (isResolved(module)) {
        this.linkModule(module);
      }
    }
  }

  private linkModule(module: ResolvedInternalModule) {
    let exports = new Set<string>();
    for (let exp of module.parsed.exports) {
      if (typeof exp === 'string') {
        exports.add(exp);
      } else {
        let moduleName = module.resolved.get(exp.all)!;
        if (!isResolutionFailure(moduleName)) {
          let target = this.modules.get(moduleName)!;
          if (!isLinked(target) && isResolved(target)) {
            this.linkModule(target);
          }
          if (isLinked(target)) {
            for (let innerExp of target.linked.exports) {
              exports.add(innerExp);
            }
          } else {
            // our module doesn't successfully enter linked state because it
            // depends on stuff that also couldn't
            return;
          }
        }
      }
    }
    module.linked = {
      exports,
    };
  }

  private inspectModules() {
    for (let [filename, module] of this.modules) {
      if (isLinked(module)) {
        this.inspectImports(filename, module);
      }
    }
  }

  private inspectImports(filename: string, module: LinkedInternalModule) {
    for (let imp of module.parsed.imports) {
      let resolved = module.resolved.get(imp.source);
      if (isResolutionFailure(resolved)) {
        this.findings.push({
          filename,
          message: 'unable to resolve dependency',
          detail: imp.source,
          codeFrame: this.frames.render(imp.codeFrameIndex),
        });
      } else if (resolved) {
        let target = this.modules.get(resolved)!;
        for (let specifier of imp.specifiers) {
          if (isLinked(target) && !this.moduleProvidesName(target, specifier.name)) {
            if (specifier.name === 'default') {
              let backtick = '`';
              this.findings.push({
                filename,
                message: 'importing a non-existent default export',
                detail: `"${imp.source}" has no default export. Did you mean ${backtick}import * as ${specifier.local} from "${imp.source}"${backtick}?`,
                codeFrame: this.frames.render(specifier.codeFrameIndex),
              });
            } else {
              this.findings.push({
                filename,
                message: 'importing a non-existent named export',
                detail: `"${imp.source}" has no export named "${specifier.name}".`,
                codeFrame: this.frames.render(specifier.codeFrameIndex),
              });
            }
          }
        }
      }
    }
  }

  private moduleProvidesName(target: LinkedInternalModule, name: string | NamespaceMarker) {
    // any module can provide a namespace.
    // CJS and AMD are too dynamic to be sure exactly what names are available,
    // so they always get a pass
    return isNamespaceMarker(name) || target.parsed.isCJS || target.parsed.isAMD || target.linked.exports.has(name);
  }

  private async visitHTML(filename: string, content: Buffer | string): Promise<ParsedInternalModule['parsed']> {
    let dom = new JSDOM(content);
    let scripts = dom.window.document.querySelectorAll('script[type="module"]') as NodeListOf<HTMLScriptElement>;
    let dependencies = [] as string[];
    for (let script of scripts) {
      let src = script.src;
      if (!src) {
        continue;
      }
      if (new URL(src, 'http://example.com:4321').origin !== 'http://example.com:4321') {
        // src was absolute, we don't handle it
        continue;
      }
      if (src.startsWith(this.meta['root-url'])) {
        // root-relative URLs are actually relative to the appDir
        src = explicitRelative(dirname(filename), resolvePath(this.appDir, src.replace(this.meta['root-url'], '')));
      }
      dependencies.push(src);
    }

    return {
      imports: [],
      exports: new Set(),
      isCJS: false,
      isAMD: false,
      dependencies,
    };
  }

  private async visitJS(
    filename: string,
    content: Buffer | string
  ): Promise<ParsedInternalModule['parsed'] | Finding[]> {
    let rawSource = content.toString('utf8');
    try {
      let result = auditJS(rawSource, filename, this.babelConfig, this.frames);

      for (let problem of result.problems) {
        this.pushFinding({
          filename,
          message: problem.message,
          detail: problem.detail,
          codeFrame: this.frames.render(problem.codeFrameIndex),
        });
      }
      return {
        exports: result.exports,
        imports: result.imports,
        isCJS: result.isCJS,
        isAMD: result.isAMD,
        dependencies: result.imports.map(i => i.source),
      };
    } catch (err) {
      if (['BABEL_PARSE_ERROR', 'BABEL_TRANSFORM_ERROR'].includes(err.code)) {
        return [
          {
            filename,
            message: `failed to parse`,
            detail: err.toString().replace(filename, explicitRelative(this.appDir, filename)),
          },
        ];
      } else {
        throw err;
      }
    }
  }

  private async visitHBS(
    filename: string,
    content: Buffer | string
  ): Promise<ParsedInternalModule['parsed'] | Finding[]> {
    let rawSource = content.toString('utf8');
    let js = hbsToJS(rawSource);
    return this.visitJS(filename, js);
  }

  private async visitJSON(
    filename: string,
    content: Buffer | string
  ): Promise<ParsedInternalModule['parsed'] | Finding[]> {
    let js;
    try {
      let structure = JSON.parse(content.toString('utf8'));
      js = `export default ${JSON.stringify(structure)}`;
    } catch (err) {
      return [
        {
          filename,
          message: `failed to parse JSON`,
          detail: err.toString().replace(filename, explicitRelative(this.appDir, filename)),
        },
      ];
    }
    return this.visitJS(filename, js);
  }

  private async resolve(specifier: string, fromFile: string) {
    let resolution = await this.resolver.nodeResolve(specifier, fromFile);
    if (resolution.type === 'virtual') {
      // nothing to audit
      return undefined;
    }
    if (resolution.type === 'not_found') {
      if (['@embroider/macros', '@ember/template-factory'].includes(specifier)) {
        // the audit process deliberately removes the @embroider/macros babel
        // plugins, so the imports are still present and should be left alone.
        return;
      }
      return { isResolutionFailure: true as true };
    }
    return resolution.filename;
  }

  private pushFinding(finding: Finding) {
    this.findings.push(finding);
  }

  private scheduleVisit(filename: string, parent: string | RootMarker) {
    let record = this.modules.get(filename);
    if (!record) {
      this.debug(`discovered`, filename);
      record = {
        consumedFrom: [parent],
      };
      this.modules.set(filename, record);
      this.moduleQueue.add(filename);
    } else {
      record.consumedFrom.push(parent);
    }
  }
}

function isMacrosPlugin(p: any) {
  return Array.isArray(p) && p[1] && p[1].embroiderMacrosConfigMarker;
}

function indent(str: string, level: number) {
  const spacesPerLevel = 2;
  let spaces = '';
  for (let i = 0; i < level * spacesPerLevel; i++) {
    spaces += ' ';
  }

  return str
    .split('\n')
    .map(line => spaces + line)
    .join('\n');
}

export interface RootMarker {
  isRoot: true;
}

export function isRootMarker(value: string | RootMarker | undefined): value is RootMarker {
  return Boolean(value && typeof value !== 'string' && value.isRoot);
}
