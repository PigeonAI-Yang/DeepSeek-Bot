import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const dsBotSource = [
  resolve(import.meta.dirname, '../../../ds-bot'),
  resolve(import.meta.dirname, '../../../DeepSeek-Bot-Fork/ds-bot'),
].find(directory => existsSync(resolve(directory, 'test/harness-resolve.mjs')))
if (!dsBotSource) throw new Error('The DS Bot source test bench was not found')
await import(pathToFileURL(resolve(dsBotSource, 'test/harness-resolve.mjs')).href)

const pluginUrl = `${pathToFileURL(resolve(import.meta.dirname, '..')).href}/`
const harnessAnchor = pathToFileURL(resolve(process.env.DSH_HARNESS ?? resolve(dsBotSource, 'dev/harness'), 'package.json')).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier === 'zod' || specifier.startsWith('@deepseek-ai/')) && context.parentURL?.startsWith(pluginUrl)) {
      return nextResolve(specifier, { ...context, parentURL: harnessAnchor })
    }
    return nextResolve(specifier, context)
  },
})
