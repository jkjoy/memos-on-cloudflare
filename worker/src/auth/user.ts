import { findUserById } from "../db/user";
import type { UserPayload } from "../types";

export async function findActiveUserPayload(
  db: D1Database,
  subject: string | number,
): Promise<UserPayload | undefined> {
  const id = Number(subject);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return undefined;
  }

  const user = await findUserById(db, id);
  if (!user || user.row_status !== "NORMAL") {
    return undefined;
  }

  return {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.row_status,
  };
}
