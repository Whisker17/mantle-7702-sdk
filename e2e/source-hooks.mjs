// Lets plain Node run the workspace's TypeScript sources without a build step, for scripts that are
// not test suites (e2e/sepolia.ts): `@mantle-aa/<pkg>` resolves to `packages/<pkg>/src/index.ts`
// (as the root tsconfig paths and the vitest alias do), and a relative `./x.js` import that does
// not exist resolves to `./x.ts`. Use with `node --experimental-transform-types --import`.
import { registerHooks } from "node:module";

const root = new URL("../", import.meta.url);

registerHooks({
  resolve(specifier, context, next) {
    const pkg = /^@mantle-aa\/(sdk|sponsor|cli)$/.exec(specifier)?.[1];
    if (pkg) {
      return { url: new URL(`packages/${pkg}/src/index.ts`, root).href, shortCircuit: true };
    }
    try {
      return next(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".") || !specifier.endsWith(".js")) throw error;
      return next(`${specifier.slice(0, -3)}.ts`, context);
    }
  },
});
