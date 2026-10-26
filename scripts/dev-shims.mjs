#!/usr/bin/env node
/**
 * Generate the two @deepseek-ai packages this plugin imports peer-style, so the
 * plugin can be loaded and exercised outside DSH (tests, CI, `verify-apply`).
 *
 * They are stand-ins for the real Host packages, which live inside the DSH app
 * bundle: interface-shaped, not behaviour-complete. Never ship them.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const modules = join(root, 'node_modules', '@deepseek-ai')

const DSH_TOOLS = {
  name: '@deepseek-ai/dsh-tools',
  type: 'module',
  main: 'index.js',
  exports: { '.': './index.js' },
}

const DSH_TOOLS_JS = [
  '// Local stand-in for the Host package. Mirrors the shape defineTool returns',
  '// so plugin wiring can be exercised without DSH present.',
  'export function defineTool(definition) {',
  '  if (!definition || typeof definition !== \'object\') throw new Error(\'defineTool needs a definition\')',
  '  if (typeof definition.name !== \'string\' || definition.name.length === 0) throw new Error(\'defineTool: name is required\')',
  '  if (typeof definition.execute !== \'function\') throw new Error(\'defineTool: execute is required\')',
  '  if (!definition.output || typeof definition.output.render !== \'function\') {',
  '    throw new Error(\'defineTool: output.render is required\')',
  '  }',
  '  return definition',
  '}',
  '',
].join('\n')

const SCHEMASTERNY = {
  name: '@deepseek-ai/schemastery',
  type: 'module',
  main: 'index.js',
  exports: { '.': './index.js' },
}

const SCHEMASTERNY_JS = [
  '// Local stand-in for schemastery: enough of the builder surface to construct',
  '// the plugin Config at import time. Not a validator.',
  'class Schema {',
  '  constructor(kind, extra = {}) { this.kind = kind; this.extra = extra; this.meta = {} }',
  '  default(value) { this.meta.default = value; return this }',
  '  description(text) { this.meta.description = text; return this }',
  '  required(value = true) { this.meta.required = value; return this }',
  '  hidden() { return this }',
  '  toString() { return \'schemastery:\' + this.kind }',
  '}',
  'const builder = (kind) => (extra) => new Schema(kind, extra)',
  'const z = {',
  '  string: builder(\'string\'),',
  '  number: builder(\'number\'),',
  '  integer: builder(\'integer\'),',
  '  boolean: builder(\'boolean\'),',
  '  any: builder(\'any\'),',
  '  object: (shape) => new Schema(\'object\', { shape }),',
  '  array: (inner) => new Schema(\'array\', { inner }),',
  '  dict: (inner) => new Schema(\'dict\', { inner }),',
  '  union: (variants) => new Schema(\'union\', { variants }),',
  '  const: (value) => new Schema(\'const\', { value }),',
  '}',
  'export default z',
  'export { z, Schema }',
  '',
].join('\n')

function writePackage(dir, manifest, source) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  writeFileSync(join(dir, 'index.js'), source, 'utf8')
}

writePackage(join(modules, 'dsh-tools'), DSH_TOOLS, DSH_TOOLS_JS)
writePackage(join(modules, 'schemastery'), SCHEMASTERNY, SCHEMASTERNY_JS)
console.log('dev shims written to ' + modules)
