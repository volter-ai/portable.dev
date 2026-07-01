import 'express-session';

declare module 'express-session' {
  interface SessionData {
    userEmail?: string;
    userId?: string;
    username?: string;
    onWaitlist?: boolean;

    // GitHub authentication (primary auth provider - kept in session)
    githubToken?: string;
    githubUser?: any;

    // Temporary OAuth state
    oauthState?: string;
    returnTo?: string;
    upgradeScopes?: boolean;
    internal?: boolean;

    // Auth token (JWT)
    authToken?: string;
  }
}
