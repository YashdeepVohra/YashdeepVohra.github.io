/**
 * One file for the browser, many files in the repo.
 *
 * The source stays exactly as it is — js/ with a module per concern,
 * which is what you edit and what GitHub shows. This script bundles it
 * into dist/app.js (plus a source map, so errors in the console still
 * point at the real file and line), and that one file is what
 * index.html loads.
 *
 * Why: a phone on a weak signal was fetching 33 files, and a browser
 * only learns about a module when it has parsed the one that imports
 * it. One file is one request. It is also minified (roughly a third of
 * the size), and syntax newer than an iPhone on iOS 13 understands is
 * rewritten so it still runs there.
 *
 *   npm install        # once, fetches esbuild
 *   npm run build      # after ANY change under js/, before committing
 *
 * dist/ is committed on purpose: the site is served straight from the
 * repo with no build step on the host. test/smoke.mjs fails if dist/ is
 * older than js/, so a forgotten build cannot ship.
 */
import { build } from "esbuild";

export const OPTIONS = {
  entryPoints: ["js/app.js"],
  bundle: true,
  format: "esm",
  minify: true,
  sourcemap: true,
  // The map points at js/…, which is served too, so it need not carry
  // a second copy of every file.
  sourcesContent: false,
  target: ["es2019", "safari13"],
  legalComments: "none",
  banner: { js: "/* GENERATED from js/ by build.mjs — do not edit. Run: npm run build */" },
  outfile: "dist/app.js",
  logLevel: "warning"
};

if (import.meta.url === `file://${process.argv[1]}`) {
  await build(OPTIONS);
  console.log("built dist/app.js");
}
