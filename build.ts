#!/usr/bin/env bun
// Bundles the channel server to a self-contained Node ESM entry point.
// Dev still runs the .ts directly under Bun; npm ships dist/.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, chmodSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const out = join(import.meta.dir, "dist", "lopecode-channel.mjs");
mkdirSync(join(import.meta.dir, "dist"), { recursive: true });

const result = await build({
  entryPoints: [join(import.meta.dir, "src", "lopecode-channel.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // playwright is not shipped; the qa_* tools import it lazily and report if it is missing.
  external: ["playwright"],
  // Bundled CJS deps expect `require`; ESM output has none.
  banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" },
  logLevel: "info",
  metafile: true,
});

// esbuild preserves the entry's `#!/usr/bin/env bun` shebang; dist runs under node.
const bundled = readFileSync(out, "utf8");
if (!bundled.startsWith("#!/usr/bin/env bun\n")) throw new Error("expected bun shebang at head of bundle");
writeFileSync(out, "#!/usr/bin/env node\n" + bundled.slice("#!/usr/bin/env bun\n".length));

copyFileSync(join(import.meta.dir, "src", "fakefs-init.js"), join(import.meta.dir, "dist", "fakefs-init.js"));
chmodSync(out, 0o755);

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`built dist/lopecode-channel.mjs (${(bytes / 1024).toFixed(0)} KB)`);
