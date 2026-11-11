import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { Readable, Writable } from "node:stream";

export interface StorageProvider {
  createWriteStream(userId: string, key: string): Promise<Writable>;
  createReadStream(userId: string, key: string, options?: { start?: number; end?: number }): Readable;
  move(userId: string, sourceKey: string, destinationKey: string): Promise<void>;
  delete(userId: string, key: string): Promise<void>;
  cleanupExpiredStaging(olderThan: Date): Promise<number>;
}

export class LocalDiskStorage implements StorageProvider {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async createWriteStream(userId: string, key: string) {
    const path = this.resolvePath(userId, key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    return createWriteStream(path, { flags: "wx", mode: 0o600 });
  }

  async createEmptyFile(userId: string, key: string) {
    const path = this.resolvePath(userId, key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(path, "wx", 0o600);
    await file.close();
  }

  createReadStream(userId: string, key: string, options?: { start?: number; end?: number }) {
    return createReadStream(this.resolvePath(userId, key), options);
  }

  async move(userId: string, sourceKey: string, destinationKey: string) {
    const sourcePath = this.resolvePath(userId, sourceKey);
    const destinationPath = this.resolvePath(userId, destinationKey);
    await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
    await rename(sourcePath, destinationPath);
  }

  async delete(userId: string, key: string) {
    await rm(this.resolvePath(userId, key), { force: true });
  }

  pathFor(userId: string, key: string) {
    return this.resolvePath(userId, key);
  }

  async cleanupExpiredStaging(olderThan: Date) {
    const usersRoot = resolve(this.root, "users");
    let userDirectories;
    try {
      userDirectories = await readdir(usersRoot, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return 0;
      throw error;
    }

    let removed = 0;
    for (const entry of userDirectories) {
      if (!entry.isDirectory() || !/^[a-f\d]{24}$/i.test(entry.name)) continue;
      const stagingRoot = resolve(usersRoot, entry.name, "tmp", "uploads");
      let stagedFiles;
      try {
        stagedFiles = await readdir(stagingRoot, { withFileTypes: true });
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") continue;
        throw error;
      }

      for (const file of stagedFiles) {
        if (!file.isFile()) continue;
        const key = `tmp/uploads/${file.name}`;
        const path = this.resolvePath(entry.name, key);
        const fileStats = await stat(path);
        if (fileStats.mtime < olderThan) {
          await rm(path, { force: true });
          removed += 1;
        }
      }
    }
    return removed;
  }

  private resolvePath(userId: string, key: string) {
    if (!/^[a-f\d]{24}$/i.test(userId) || isAbsolute(key) || key.includes("\\") || key.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("Invalid storage path");
    }

    const userRoot = resolve(this.root, "users", userId);
    const path = resolve(userRoot, key);
    if (path !== userRoot && !path.startsWith(`${userRoot}${sep}`)) {
      throw new Error("Storage path escapes the user directory");
    }
    return path;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
