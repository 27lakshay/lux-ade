// A module resolve hook for the worker-thread viewer: Node strips the types from the desktop
// adapter's `.ts` source itself, but that source imports its siblings without an extension, as a
// bundler allows. This adds `.ts` when the bare path does not exist.
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context)
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !/^\.\.?\//.test(specifier)) throw error
    return next(`${specifier}.ts`, context)
  }
}
