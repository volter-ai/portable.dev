/**
 * Slack API Client
 * Handles Slack OAuth and API calls
 */

export interface SlackOAuthTokenResponse {
  ok: boolean;
  access_token?: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  app_id?: string;
  team?: {
    id: string;
    name: string;
  };
  authed_user?: {
    id: string;
    access_token?: string;
    scope?: string;
  };
  error?: string;
  error_description?: string;
}

export class SlackClient {
  constructor(
    private clientId: string,
    private clientSecret: string
  ) {}

  /**
   * Exchange OAuth code for access token
   */
  async exchangeOAuthCode(code: string, redirectUri: string): Promise<SlackOAuthTokenResponse> {
    const response = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    return (await response.json()) as SlackOAuthTokenResponse;
  }
}
