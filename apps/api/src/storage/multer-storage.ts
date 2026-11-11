import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { pipeline } from "node:stream";
import type { Request } from "express";
import type { StorageEngine } from "multer";
import { AppError } from "../errors.js";
import type { StorageProvider } from "@clipforge/shared/storage";

export class ProviderMulterStorage implements StorageEngine {
  constructor(private readonly provider: StorageProvider) {}

  _handleFile(
    req: Request,
    file: Express.Multer.File,
    callback: (error?: unknown, info?: Partial<Express.Multer.File>) => void
  ) {
    const userId = req.auth?.userId;
    if (!userId) {
      callback(new AppError(401, "Authentication required"));
      return;
    }
    const key = `tmp/uploads/${randomUUID()}${extname(file.originalname).toLowerCase()}`;
    req.uploadStorageKey = key;

    void this.provider.createWriteStream(userId, key).then(
      (output) => {
        let size = 0;
        file.stream.on("data", (chunk: Buffer | string) => {
          size += Buffer.byteLength(chunk);
        });
        pipeline(file.stream, output, (error) => {
          if (error) {
            void this.provider.delete(userId, key).then(
              () => callback(error),
              (cleanupError: Error) => callback(new AggregateError([error, cleanupError], "Upload failed and partial storage could not be removed"))
            );
            return;
          }
          callback(null, { storageKey: key, size });
        });
      },
      (error: Error) => callback(error)
    );
  }

  _removeFile(req: Request, file: Express.Multer.File, callback: (error: Error | null) => void) {
    const userId = req.auth?.userId;
    const key = file.storageKey;
    if (!userId || !key) {
      callback(null);
      return;
    }
    void this.provider.delete(userId, key).then(
      () => callback(null),
      (error: Error) => callback(error)
    );
  }
}
