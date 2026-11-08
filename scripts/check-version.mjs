// CI: on a pull request that changes the plugin, plugin.json's version must be bumped, and
// package.json must match it. Installed copies only update when the version string changes.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const plugin = JSON.parse(fs.readFileSync(".claude-plugin/plugin.json", "utf8"));
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
if (plugin.version !== pkg.version) {
  console.error(`plugin.json ${plugin.version} != package.json ${pkg.version}`);
  process.exit(1);
}
const base = process.argv[2];
if (!base) {
  console.log(`version ${plugin.version} (no base ref; bump check skipped)`);
  process.exit(0);
}
const changed = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" }).split("\n").filter(Boolean);
const shipped = changed.filter((f) => /^(agents|skills|lib|bin|\.claude-plugin)\//.test(f));
if (!shipped.length) {
  console.log("no shipped files changed; bump not required");
  process.exit(0);
}
let before;
try {
  before = JSON.parse(execFileSync("git", ["show", `${base}:.claude-plugin/plugin.json`], { encoding: "utf8" })).version;
} catch {
  process.exit(0);
}
if (before === plugin.version) {
  console.error(`shipped files changed (${shipped.slice(0, 5).join(", ")}) but version is still ${before}: bump .claude-plugin/plugin.json and package.json`);
  process.exit(1);
}
console.log(`version ${before} -> ${plugin.version}`);
