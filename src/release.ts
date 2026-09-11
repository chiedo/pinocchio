import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ToolError } from "./memory-protocol.js";

export const PUBLIC_HOST = "1.0.83";
export const PUBLIC_NODE = "22.18.0";
export const PUBLIC_SDK = "1.0.13";
export const releaseRoot = fileURLToPath(new URL("../../", import.meta.url));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const releaseSchema = z.object({
  format: z.literal(1), version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  platform: z.literal("linux"), arch: z.literal("x64"), node: z.literal(PUBLIC_NODE),
  cli: z.literal(PUBLIC_HOST), sdk: z.literal(PUBLIC_SDK), storageSchema: z.literal(1),
  liveCertification: z.literal("unvalidated"),
  files: z.record(z.string(), digest),
}).strict();
export type Release = z.infer<typeof releaseSchema>;
export function sha256(data: Buffer | string) {
  return createHash("sha256").update(data).digest("hex");
}
async function files(root: string, directory = root): Promise<string[]> {
  const result: string[] = [];
  for (const name of (await readdir(directory)).sort()) {
    if (directory === root && name === "node_modules") continue;
    const path = join(directory, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new ToolError("RELEASE_SYMLINK");
    if (info.isDirectory()) result.push(...await files(root, path));
    else if (info.isFile() && info.nlink === 1) result.push(relative(root, path));
    else throw new ToolError("RELEASE_FILE_INVALID");
  }
  return result;
}
const payload = ["package.json", "package-lock.json", "LICENSE", "README.md", "PRIVACY.md",
  "docs", "semantic", "dist/src", "dist/test/support/provider.js"];

export async function packageRelease(destination: string, commit: string) {
  destination = resolve(destination);
  await mkdir(destination, { mode: 0o700 });
  for (const path of payload) {
    await mkdir(dirname(join(destination, path)), { recursive: true, mode: 0o700 });
    await cp(join(releaseRoot, path), join(destination, path), { recursive: true, errorOnExist: true, force: false });
  }
  const pkg = JSON.parse(await readFile(join(destination, "package.json"), "utf8")) as { version: string };
  const hashes: Record<string, string> = {};
  for (const path of await files(destination)) hashes[path] = sha256(await readFile(join(destination, path)));
  const manifest = releaseSchema.parse({
    format: 1, version: pkg.version, commit, platform: "linux", arch: "x64",
    node: PUBLIC_NODE, cli: PUBLIC_HOST, sdk: PUBLIC_SDK, storageSchema: 1,
    liveCertification: "unvalidated", files: hashes,
  });
  await writeFile(join(destination, "release.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return manifest;
}
export async function verifyRelease(root: string): Promise<Release> {
  const manifest = releaseSchema.parse(JSON.parse(await readFile(join(root, "release.json"), "utf8")));
  const found = (await files(root)).filter((path) => path !== "release.json");
  if (JSON.stringify(found.sort()) !== JSON.stringify(Object.keys(manifest.files).sort())) {
    throw new ToolError("RELEASE_CONTENT_MISMATCH");
  }
  for (const path of found) {
    if (sha256(await readFile(join(root, path))) !== manifest.files[path]) throw new ToolError("RELEASE_HASH_MISMATCH");
  }
  return manifest;
}
