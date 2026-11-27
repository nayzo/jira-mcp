import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";

export function generateZephyrJwt(
  method: string,
  apiPath: string,
  queryParams: Record<string, string> = {},
  expirationSec: number = 3600
): string {
  const canonicalQuery = Object.keys(queryParams)
    .sort()
    .map((key) => `${key}=${queryParams[key as keyof typeof queryParams]}`)
    .join("&");

  const canonical = `${method.toUpperCase()}&${apiPath}&${canonicalQuery}`;

  const qsh = createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex");

  const now = Math.floor(Date.now() / 1000);
  const exp = now + expirationSec;

  const payload = {
    sub: process.env.ZAPI_ACCOUNT_ID,
    iss: process.env.ZAPI_ACCESS_KEY,
    qsh, // query-string hash
    iat: now,
    exp,
  };

  return jwt.sign(payload, process.env.ZAPI_SECRET_KEY || "", {
    algorithm: "HS256",
  });
}
