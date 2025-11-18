import { build } from "esbuild";
const watch = process.argv.includes("--watch");
const ctx = await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  sourcemap: watch ? "inline" : false,
  outfile: "main.js",
  format: "cjs",
  platform: "browser",
  target: ["es2020"],
  external: ["obsidian"],
  logLevel: "info"
});
if (watch) {
  const { host, port } = await ctx.serve({
    servedir: ".",
    port: 0,
    host: "127.0.0.1"
  });
  console.log(`watching (dev server at ${host}:${port})`);
}