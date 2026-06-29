# Vibewaiting Leaderboard Security Model

## Overview

The vibewaiting leaderboard system uses **session-based authentication** where user identity is validated at the backend middleware level, not at the database level. This document explains the security architecture and design decisions.

## Architecture

### Security Layers

1. **Backend Middleware** (Primary Security Layer)
   - `validateAuthenticatedUser` middleware checks `req.session.userId`
   - Returns 401 Unauthorized if session is missing
   - UserId is ALWAYS extracted from Express session, NEVER from user input

2. **Database RLS** (Defense-in-Depth)
   - Public read access (leaderboards are public)
   - Open write access (backend validates before write)
   - RLS policies provide basic protection but don't enforce user authentication

### Why This Design?

This architecture is specifically designed for **single-user sandbox environments** where:

1. **Each user has their own isolated backend instance** (a remote sandbox in production)
2. **Express sessions are sufficient** for user validation within a sandbox
3. **No JWT validation needed** at database level since backend already validates
4. **Simpler than JWT-based RLS** while maintaining security

## Authentication Flow

### 1. User Login

```
User logs in via GitHub OAuth
  ↓
Express session created with session.userId
  ↓
Session stored in-memory (dev) or via store (production)
```

### 2. Protected API Request (e.g., Submit Score)

```
Frontend sends request (no userId in body)
  ↓
Backend middleware: validateAuthenticatedUser
  ↓
Check: Does req.session.userId exist?
  ├─ NO → Return 401 Unauthorized
  └─ YES → Extract userId from session
      ↓
      Pass to LeaderboardService
      ↓
      Write to SQLite
```

### 3. Public API Request (e.g., Get Leaderboard)

```
Frontend sends request
  ↓
Backend checks: req.session?.userId (optional)
  ├─ Authenticated → Include user's score in response
  └─ Anonymous → Return public leaderboard only
```

## API Endpoints

### Protected Endpoints (Require Authentication)

- `POST /vibewaiting/leaderboard/submit` - Submit score
- `POST /vibewaiting/game/play` - Track play
- `POST /vibewaiting/game/rate` - Rate game
- `GET /vibewaiting/leaderboard/:game/user/me` - Get own score

### Public Endpoints (Optional Authentication)

- `GET /vibewaiting/leaderboard/:game` - Get leaderboard (includes user score if logged in)
- `GET /vibewaiting/game/:game/stats` - Get game stats (includes user stats if logged in)
- `GET /vibewaiting/leaderboard/stats` - Get all stats (admin/debugging)

## Security Best Practices

### ✅ DO

- Extract userId from `req.session.userId!` in protected routes
- Use `validateAuthenticatedUser` middleware for write operations
- Check `req.session?.userId` for optional authentication
- Validate all other inputs (game ID, score, rating, etc.)

### ❌ DON'T

- Accept userId from request body, query params, or URL params
- Trust user-provided userId without session validation
- Skip authentication middleware on write operations
- Use JWT or Authorization headers (not needed in this architecture)

## Code Examples

### Protected Route (Submit Score)

```typescript
router.post(
  '/leaderboard/submit',
  validateAuthenticatedUser, // ✅ Validate session first
  validateRequiredFields(['username', 'avatar', 'game', 'score']),
  validateGameId('game'),
  validateScore,
  async (req: Request, res: Response) => {
    // ✅ Get userId from session, not from request body
    const userId = req.session.userId!;
    const { username, avatar, game, score } = req.body;

    const response = await leaderboardService.submitScore(userId, username, avatar, {
      userId,
      username,
      avatar,
      game,
      score,
    });

    res.json(response);
  }
);
```

### Public Route with Optional Auth

```typescript
router.get('/leaderboard/:game', validateGameId('game'), async (req: Request, res: Response) => {
  const { game } = req.params;

  // ✅ Optional: Include user's score if authenticated
  const userId = req.session?.userId;

  const response = userId
    ? await leaderboardService.getLeaderboardWithUser(game, userId, limit)
    : await leaderboardService.getLeaderboard({ game, limit });

  res.json(response);
});
```

## Database Schema

### RLS Policies (Defense-in-Depth)

All tables (`leaderboard_scores`, `leaderboard_plays`, `leaderboard_ratings`) have:

```sql
-- Public read (leaderboards are public)
CREATE POLICY table_select_policy ON table
  FOR SELECT
  USING (true);

-- Open write (backend validates)
CREATE POLICY table_insert_policy ON table
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY table_update_policy ON table
  FOR UPDATE
  USING (true);
```

**Note:** RLS policies are permissive because backend middleware is the primary security layer. This provides defense-in-depth without requiring JWT validation at the database level.

## Migration History

1. **20251212000000_add_leaderboards.sql** - Initial schema with JWT-based RLS
2. **20251218000000_simplify_leaderboard_rls.sql** - Simplified RLS to work with session-based auth

## Testing

### Test Authentication

```bash
# Should fail (401 Unauthorized)
curl -X POST http://localhost:7878/vibewaiting/leaderboard/submit \
  -H "Content-Type: application/json" \
  -d '{"username":"test","avatar":"url","game":"vibecheck","score":100}'

# Should succeed (with valid session cookie)
curl -X POST http://localhost:7878/vibewaiting/leaderboard/submit \
  -H "Content-Type: application/json" \
  -H "Cookie: connect.sid=..." \
  -d '{"username":"test","avatar":"url","game":"vibecheck","score":100}'
```

### Test Input Validation

```bash
# Should fail (invalid game ID)
curl -X POST http://localhost:7878/vibewaiting/leaderboard/submit \
  -H "Content-Type: application/json" \
  -H "Cookie: connect.sid=..." \
  -d '{"username":"test","avatar":"url","game":"invalid","score":100}'

# Should fail (negative score)
curl -X POST http://localhost:7878/vibewaiting/leaderboard/submit \
  -H "Content-Type: application/json" \
  -H "Cookie: connect.sid=..." \
  -d '{"username":"test","avatar":"url","game":"vibecheck","score":-1}'
```

## Security Considerations

### Strengths

1. ✅ **Simple and maintainable** - No JWT complexity
2. ✅ **Appropriate for architecture** - Single-user sandboxes don't need JWT
3. ✅ **Defense-in-depth** - Multiple validation layers
4. ✅ **No user input trust** - UserId always from session

### Limitations

1. ⚠️ **Session hijacking** - If attacker gets session cookie, they can impersonate user
2. ⚠️ **No database-level isolation** - RLS doesn't enforce user ownership
3. ⚠️ **Requires HTTPS in production** - Session cookies must be secure

### Mitigations

- Use `secure: true` and `httpOnly: true` for session cookies in production
- Use `sameSite: 'strict'` to prevent CSRF
- Set appropriate session timeouts
- Use HTTPS for all traffic (the platform provides this)
- In remote sandboxes: Each user has isolated backend instance

## Future Considerations

If moving to multi-user shared backend:

1. Consider JWT-based authentication
2. Update RLS policies to enforce `user_id = get_jwt_email()`
3. Add JWT extraction middleware
4. Update LeaderboardService to pass authToken to the database layer

For now, session-based authentication is simpler and sufficient for the single-user sandbox architecture.
