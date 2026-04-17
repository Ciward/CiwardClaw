import { readStringValue } from "openclaw/plugin-sdk/text-runtime";

type GoogleOauthApiKeyCredential = {
  type?: string;
  access?: string;
  projectId?: string;
  endpoint?: string;
};

export function parseGoogleOauthApiKey(apiKey: string): {
  token?: string;
  projectId?: string;
  endpoint?: string;
} | null {
  try {
    const parsed = JSON.parse(apiKey) as {
      token?: unknown;
      projectId?: unknown;
      endpoint?: unknown;
    };
    return {
      token: readStringValue(parsed.token),
      projectId: readStringValue(parsed.projectId),
      endpoint: readStringValue(parsed.endpoint),
    };
  } catch {
    return null;
  }
}

export function formatGoogleOauthApiKey(cred: GoogleOauthApiKeyCredential): string {
  if (cred.type !== "oauth" || typeof cred.access !== "string" || !cred.access.trim()) {
    return "";
  }
  return JSON.stringify({
    token: cred.access,
    projectId: cred.projectId,
    endpoint: cred.endpoint,
  });
}

export function parseGoogleUsageToken(apiKey: string): string {
  const parsed = parseGoogleOauthApiKey(apiKey);
  if (parsed?.token) {
    return parsed.token;
  }

  // Keep the raw token when the stored credential is not a project-aware JSON payload.
  return apiKey;
}
