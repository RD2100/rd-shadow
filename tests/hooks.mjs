/**
 * Module resolution hook for the offline test harness: map the runtime-owned
 * `@deepseek-ai/dsh-tools` specifier onto the local validation stub.
 */
const STUB = new URL('./dsh-tools-stub.mjs', import.meta.url).href

/**
 * Redirect one bare specifier; every other import resolves normally.
 * @param specifier - the requested specifier.
 * @param context - the importing context.
 * @param next - the default resolver.
 * @returns the resolved module.
 */
export async function resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-tools') return { url: STUB, shortCircuit: true }
  return next(specifier, context)
}
