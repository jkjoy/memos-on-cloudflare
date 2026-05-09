export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  CACHE?: KVNamespace;
  AI: Ai;
  JWT_SECRET: string;
  INSTANCE_NAME: string;
  APP_VERSION: string;
}

export interface UserPayload {
  id: number;
  username: string;
  role: string;
  status: string;
}

export interface JWTClaims {
  sub: string;
  iss: string;
  aud: string;
  name: string;
  role: string;
  status: string;
  exp: number;
  iat: number;
  tid?: string;
}
