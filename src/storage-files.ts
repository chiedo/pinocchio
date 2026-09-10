import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { hasCode, privateDirectory } from "./binding-registry.js";
import { MemoryError } from "./memory-types.js";

export interface StoreFileIdentity { device: number; inode: number }
export async function privateStoreFile(path: string): Promise<StoreFileIdentity> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
    throw new MemoryError("INSECURE_STORE");
  }
  return { device: info.dev, inode: info.ino };
}
export async function storePath(configRoot: string, namespace: string, create: boolean) {
  if (!/^[a-z0-9-]+--[a-f0-9]{64}$/.test(namespace)) throw new MemoryError("SCOPE_MISMATCH");
  const root = join(configRoot, "agent-memories");
  const directory = join(root, namespace);
  await privateDirectory(root, create);
  await privateDirectory(directory, create);
  const path = join(directory, "memories.sqlite");
  if (create) {
    try {
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT |
        constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.sync(); } finally { await file.close(); }
      const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await parent.sync(); } finally { await parent.close(); }
    } catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
  }
  await privateStoreFile(path);
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    try { await privateStoreFile(path + suffix); }
    catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
  }
  return path;
}
