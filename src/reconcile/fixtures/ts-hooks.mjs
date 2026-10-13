// Test-only ESM resolve hook: lets a child `node --experimental-transform-types` process load the TypeScript sources,
// whose relative imports use `.js` specifiers (NodeNext style), by retrying them as `.ts`.
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (specifier.endsWith(".js") && (specifier.startsWith(".") || specifier.startsWith("file:"))) {
      return next(`${specifier.slice(0, -3)}.ts`, context);
    }
    throw err;
  }
}
