/**
 * Ambient declarations for DSH packages that ship NO type definitions.
 *
 * Verified: the DSH Desktop distribution contains zero `.d.ts` files under
 * `@deepseek-ai/*` (only `.d.ts.map` leftovers). With `noImplicitAny: false`
 * an untyped import is `any`, but an *unresolved* import is still TS2307, so
 * the modules this plugin actually imports at runtime are declared here.
 *
 * Declaring them (rather than installing `@types`) is deliberate: the packages
 * come from DSH's own runtime module resolver, never from the registry — an
 * npm-installed copy would shadow the host runtime (the issue #6 failure mode).
 */

declare module '@deepseek-ai/dsh-tools' {
  /**
   * Normalises the DSH parameter DSL into JSON Schema and validates arguments.
   * Passing a raw object to `ctx.tools.register` instead of this helper is what
   * produces `type: null` schemas that break every model request.
   */
  export function defineTool(options: {
    name: string
    description: string
    parameters: unknown
    output: {
      schema: unknown
      render: (args: unknown, value: unknown) => unknown
      presentationMeta?: (args: unknown, value: unknown) => unknown
    }
    execute: (args: any, exec: any) => Promise<unknown>
    timeoutMs?: number
    isConcurrencySafe?: (args: unknown) => boolean
    deferLoading?: boolean
    presentCall?: (args: unknown) => unknown
    presentResult?: (args: unknown, result: unknown) => unknown
    projectContent?: (exec: unknown, result: unknown) => unknown
    finalizeContent?: (exec: unknown, result: unknown) => unknown
  }): unknown

  export const JsonSchemaError: new (...args: any[]) => Error
  export function assertObjectJsonSchema(schema: unknown): void
  export function assertSupportedJsonSchema(schema: unknown): void
}
