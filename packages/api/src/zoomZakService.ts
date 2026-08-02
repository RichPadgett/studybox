import type { ZoomZakStatus } from "@studybox/shared";
import { getZoomConfig } from "./zoomConfig.js";
import { ZoomOAuthClient } from "./zoomOAuthClient.js";
import { ZoomOAuthStore, type ZoomOAuthTokenSet } from "./zoomOAuthStore.js";

export class ZoomZakService {
  constructor(
    private readonly store = new ZoomOAuthStore(),
    private readonly client = new ZoomOAuthClient(getZoomConfig())
  ) {}

  async getZak(): Promise<string> {
    const token = await this.getValidToken();
    return this.client.getZak(token.accessToken, token.apiUrl);
  }

  async getZakStatus(): Promise<ZoomZakStatus> {
    const zak = await this.getZak();
    return {
      available: true,
      tokenLength: zak.length
    };
  }

  private async getValidToken(): Promise<ZoomOAuthTokenSet> {
    const token = this.store.get();
    if (!token) {
      throw new Error("Zoom OAuth token has not been authorized yet.");
    }

    if (new Date(token.expiresAt).getTime() > Date.now() + 60_000) {
      return token;
    }

    const refreshed = await this.client.refreshToken(token.refreshToken);
    refreshed.user = token.user;
    return this.store.save(refreshed);
  }
}
