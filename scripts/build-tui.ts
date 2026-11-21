import solidPlugin from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["./src/tui.tsx"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  external: ["@opencode/*", "@opentui/*", "solid-js", "solid-js/*"],
  plugins: [solidPlugin],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
