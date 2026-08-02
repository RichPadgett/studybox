import type { ZoomDeviceAuthorization, ZoomUserProfile } from "@studybox/shared";
import type { ZoomConfig } from "./zoomConfig.js";
import type { ZoomOAuthTokenSet } from "./zoomOAuthStore.js";

interface ZoomDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface ZoomTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  api_url?: string;
}

interface ZoomUserResponse {
  id: string;
  account_id?: string;
  display_name?: string;
  email?: string;
}

export class ZoomOAuthClient {
  constructor(private readonly config: ZoomConfig) {}

  async requestDeviceAuthorization(): Promise<ZoomDeviceAuthorization> {
    const clientId = this.requireClientId();
    const response = await fetch(`https://zoom.us/oauth/devicecode?client_id=${encodeURIComponent(clientId)}`, {
      method: "POST",
      headers: {
        Authorization: this.basicAuthHeader()
      }
    });

    const body = await parseZoomResponse<ZoomDeviceCodeResponse>(response);
    return {
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      verificationUriComplete: body.verification_uri_complete,
      expiresIn: body.expires_in,
      interval: body.interval,
      expiresAt: new Date(Date.now() + body.expires_in * 1000).toISOString()
    };
  }

  async pollDeviceToken(deviceCode: string): Promise<ZoomOAuthTokenSet> {
    const params = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode
    });

    const response = await fetch("https://zoom.us/oauth/token", {
      method: "POST",
      headers: {
        Authorization: this.basicAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params
    });

    const body = await parseZoomResponse<ZoomTokenResponse>(response);
    return this.toTokenSet(body);
  }

  async refreshToken(refreshToken: string): Promise<ZoomOAuthTokenSet> {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken
    });

    const response = await fetch("https://zoom.us/oauth/token", {
      method: "POST",
      headers: {
        Authorization: this.basicAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params
    });

    const body = await parseZoomResponse<ZoomTokenResponse>(response);
    return this.toTokenSet(body);
  }

  async getCurrentUser(accessToken: string, apiUrl = "https://api.zoom.us"): Promise<ZoomUserProfile> {
    const response = await fetch(`${apiUrl}/v2/users/me`, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    const body = await parseZoomResponse<ZoomUserResponse>(response);
    return {
      id: body.id,
      accountId: body.account_id,
      displayName: body.display_name,
      email: body.email
    };
  }

  async getZak(accessToken: string, apiUrl = "https://api.zoom.us"): Promise<string> {
    const response = await fetch(`${apiUrl}/v2/users/me/zak`, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    const body = await parseZoomResponse<{ token: string }>(response);
    return body.token;
  }

  private toTokenSet(body: ZoomTokenResponse): ZoomOAuthTokenSet {
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      tokenType: body.token_type,
      expiresAt: new Date(Date.now() + body.expires_in * 1000).toISOString(),
      scopes: body.scope?.split(" ").filter(Boolean) ?? [],
      apiUrl: body.api_url ?? "https://api.zoom.us"
    };
  }

  private requireClientId(): string {
    if (!this.config.clientId) {
      throw new Error("ZOOM_CLIENT_ID is required for Zoom Device OAuth.");
    }

    return this.config.clientId;
  }

  private basicAuthHeader(): string {
    if (!this.config.clientId || !this.config.clientSecret) {
      throw new Error("ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET are required for Zoom OAuth.");
    }

    return `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`;
  }
}

async function parseZoomResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const body = text ? JSON.parse(text) as Record<string, unknown> : {};

  if (!response.ok) {
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    const message = typeof body.message === "string" ? body.message : undefined;
    const error = typeof body.error === "string" ? body.error : undefined;
    throw new Error(reason ?? message ?? error ?? `Zoom request failed with HTTP ${response.status}`);
  }

  return body as T;
}
