// Lets Node resolve the browser path "/shared/..." the same way the server serves it.
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`
  import { pathToFileURL } from "node:url";
  import path from "node:path";
  export async function resolve(specifier, context, next) {
    if (specifier.startsWith("/shared/")) {
      const file = path.resolve(process.cwd(), "src/shared", specifier.slice(8));
      return { url: pathToFileURL(file).href, shortCircuit: true };
    }
    return next(specifier, context);
  }
`), import.meta.url);
