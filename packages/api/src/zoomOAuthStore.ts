import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ZoomOAuthStatus, ZoomUserProfile } from "@studybox/shared";
import { projectPath } from "./paths.js";

const tokenPath = projectPath("data/zoom-oauth.json");

export interface ZoomOAuthTokenSet {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAt: string;
  scopes: string[];
  apiUrl: string;
  user?: ZoomUserProfile;
}

export class ZoomOAuthStore {
  get(): ZoomOAuthTokenSet | undefined {
    if (!existsSync(tokenPath)) {
      return undefined;
    }

    return JSON.parse(readFileSync(tokenPath, "utf8")) as ZoomOAuthTokenSet;
  }

  getStatus(): ZoomOAuthStatus {
    const token = this.get();
    if (!token) {
      return { authorized: false };
    }

    return {
      authorized: new Date(token.expiresAt).getTime() > Date.now(),
      expiresAt: token.expiresAt,
      scopes: token.scopes,
      user: token.user
    };
  }

  async save(token: ZoomOAuthTokenSet): Promise<ZoomOAuthTokenSet> {
    await mkdir(dirname(tokenPath), { recursive: true });
    await writeFile(tokenPath, JSON.stringify(token, null, 2));
    return token;
  }
}
