import type { UserRole } from "@clipforge/shared";
import type { Types } from "mongoose";

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        role: UserRole;
      };
      project?: {
        _id: Types.ObjectId;
        userId: Types.ObjectId;
      };
      uploadStorageKey?: string;
    }

    namespace Multer {
      interface File {
        storageKey?: string;
      }
    }
  }
}

export {};
