import { execFileSync } from "node:child_process";
import { packageRelease } from "../dist/src/release.js";

if (process.argv.length !== 3) throw new Error("Usage: node scripts/package-release.mjs <new-directory>");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const manifest = await packageRelease(process.argv[2], commit);
process.stdout.write(JSON.stringify({ version: manifest.version, commit }) + "\n");
