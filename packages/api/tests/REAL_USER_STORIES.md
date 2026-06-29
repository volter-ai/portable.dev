# Tool Testing - Real User Stories

**Purpose:** Test tools through actual user workflows, not abstract function testing

## Philosophy

**Real Stories, Not Function Coverage:**

- ✅ Test complete user journeys from start to finish
- ✅ Use REAL services (TunnelService, GenerationsTracker)
- ✅ Only mock external APIs (Claude SDK, Replicate)
- ✅ Each test tells a story of what a real user would do
- ❌ NO testing tools in isolation for coverage
- ❌ NO chat tools (Portable SDK handles that)

## Tools We're Testing

**Tunnels (2):** `create-tunnel`, `show-tunnel`
**AI Media (5):** `image-generation`, `video-generation`, `generations-tracker`, `utility-tools`, `model-validation`
**Analysis (3):** `image-analysis`, `video-analysis`, `display-video`
**Utilities (4):** `request-user-secrets`, `portable-execute`, `link-issue-to-chat`, `request-user-connection`

**Total: 14 tools, ~3,483 lines**

---

## Story 1: Local Dev with Browser Testing

**User:** Sarah, frontend developer
**Goal:** Test Next.js app with Playwright

### The Journey

```
1. Sarah starts Next.js dev server on port 3000

2. Sarah: "Create a tunnel so I can test with Playwright"
   → create_tunnel(port=3000, name="frontend")
   → Returns: https://tunnel-3000.example.com

3. Sarah: "Show me all tunnels"
   → show_tunnel()
   → Shows: Port 3000 → https://tunnel-3000.example.com

4. Sarah: "I'm also running backend on 8080, create tunnel"
   → create_tunnel(port=8080, name="backend")
   → Returns: https://tunnel-8080.example.com

5. Sarah: "Mark frontend as main"
   → create_tunnel(port=3000, name="frontend", main=true)
   → Frontend marked as MAIN

6. Sarah: "Show tunnels again"
   → show_tunnel()
   → Shows both tunnels, port 3000 marked MAIN
```

**What We're Testing:**

- Tunnel creation for multiple ports
- Tunnel listing
- Main tunnel flag
- Idempotency (same port twice)
- Real TunnelService state

**File:** `tests/integration/tools/tunnel-workflow.test.ts`

---

## Story 2: Marketing Image Generation

**User:** Alex, designer
**Goal:** Generate product marketing images

### The Journey

```
1. Alex: "Generate a futuristic laptop product shot"
   → image-generation(prompt="futuristic laptop", model="flux")
   → Image saved: workspace/generations/img-001.png
   → Tracked in database

2. Alex: "Show me all my generated images"
   → list_generations()
   → Shows: 1 image with metadata

3. Alex: "Make it more cyberpunk, neon colors"
   → image-generation(prompt="cyberpunk laptop neon")
   → Image saved: img-002.png
   → Second generation tracked

4. Alex: "Delete the first one"
   → delete_generation(id="img-001")
   → File deleted from filesystem
   → Database record removed

5. Alex: "Show what's left"
   → list_generations()
   → Shows only img-002

6. Alex: "Get details on that image"
   → get_generation(id="img-002")
   → Returns: prompt, model, timestamp, path
```

**What We're Testing:**

- Image generation end-to-end
- File persistence
- Database tracking
- List/get/delete operations

**File:** `tests/integration/tools/image-generation-workflow.test.ts`

---

## Story 3: Video Generation for Social Media

**User:** Jordan, content creator
**Goal:** Generate TikTok video clips

### The Journey

```
1. Jordan: "Generate 3-second video of cat playing piano"
   → video-generation(prompt="cat piano", duration=3)
   → Polling for completion (mocked)
   → Video saved: workspace/generations/vid-001.mp4
   → Tracked in database

2. Jordan: "List all my video generations"
   → list_generations(type_filter="video")
   → Shows: vid-001.mp4, status="completed"

3. Jordan: "Display that video"
   → display-video(video_url="workspace/generations/vid-001.mp4")
   → Event emitted: display:video
   → Video shows in UI

4. Jordan: "Generate another, make it 5 seconds"
   → video-generation(prompt="cat piano", duration=5)
   → vid-002.mp4 created and tracked

5. Jordan: "Show all generations, including images"
   → list_generations() (no filter)
   → Shows all generations (images + videos)
```

**What We're Testing:**

- Video generation with polling
- File storage
- Generation type filtering
- Display video functionality
- Mock Replicate API

**File:** `tests/integration/tools/video-generation-workflow.test.ts`

---

## Story 4: Analyzing Screen Recordings

**User:** Sam, developer debugging UI
**Goal:** Understand bug in screen recording

### The Journey

```
1. Sam has bug screen recording at ~/recordings/bug.mp4

2. Sam: "Analyze this video and tell me what's happening"
   → video-analysis(video_url="~/recordings/bug.mp4")
   → Extracts frames
   → Sends to Claude Vision (mocked)
   → Returns: "User clicks login, spinner appears, error 'Invalid token'"

3. Sam: "Look at frame 15, what's in console?"
   → image-analysis(image_url="frame-15.png")
   → Claude Vision analyzes (mocked)
   → Returns: "Console shows: TypeError: Cannot read property 'id' of undefined"

4. Sam: "Display the original video"
   → display-video(video_url="~/recordings/bug.mp4")
   → Video displayed in UI
```

**What We're Testing:**

- Video frame extraction
- Claude Vision integration (mocked)
- Image analysis on frames
- Local file handling
- Display functionality

**File:** `tests/integration/tools/media-analysis-workflow.test.ts`

---

## Story 5: Multi-Service Dev Environment

**User:** Morgan, full-stack developer
**Goal:** Run frontend + backend + database admin

### The Journey

```
1. Morgan: "Start React frontend on 5173"
   → Server starts

2. Morgan: "Create tunnel for 5173"
   → create_tunnel(port=5173, name="react")
   → Returns tunnel URL

3. Morgan: "Start Express backend on 3001"
   → Server starts

4. Morgan: "Create tunnel for 3001"
   → create_tunnel(port=3001, name="backend")
   → Returns tunnel URL

5. Morgan: "Start pgAdmin on 8080"
   → Server starts

6. Morgan: "Create tunnel for 8080"
   → create_tunnel(port=8080, name="pgadmin")
   → Returns tunnel URL

7. Morgan: "Show all tunnels"
   → show_tunnel()
   → Shows all 3 tunnels with ports and URLs

8. Morgan: "Mark frontend as main"
   → create_tunnel(port=5173, main=true)
   → React tunnel marked MAIN

9. Morgan: "Show tunnels"
   → show_tunnel()
   → Shows all 3, port 5173 marked MAIN
```

**What We're Testing:**

- Multiple simultaneous tunnels
- Port tracking
- Main tunnel designation
- Tunnel state persistence
- Real multi-service scenario

**File:** `tests/integration/tools/multi-service-workflow.test.ts`

---

## Story 6: Accessibility Image Audit

**User:** Casey, accessibility specialist
**Goal:** Audit images for WCAG compliance

### The Journey

```
1. Casey: "Analyze this screenshot for accessibility issues"
   → image-analysis(
       image_url="screenshot.png",
       prompt="Identify accessibility problems"
     )
   → Claude Vision analyzes (mocked)
   → Returns: "Low contrast text, missing alt, no focus indicators"

2. Casey: "Check this button specifically, is contrast sufficient?"
   → image-analysis(
       image_url="button-crop.png",
       prompt="Check color contrast"
     )
   → Returns: "Contrast ratio 2.8:1, fails WCAG AA (needs 4.5:1)"

3. Casey: "Analyze redesign, are issues fixed?"
   → image-analysis(image_url="new-screenshot.png")
   → Returns: "Improved: contrast 5.2:1, focus indicators present"
```

**What We're Testing:**

- Image analysis with specific prompts
- Claude Vision integration
- Multiple analyses
- Response parsing

**File:** `tests/integration/tools/accessibility-workflow.test.ts`

---

## Story 7: Secrets Management for API

**User:** Taylor, integrating Stripe
**Goal:** Store and use API keys securely

### The Journey

```
1. Taylor: "I need to call Stripe API"
   → request-user-secrets(secret_name="STRIPE_API_KEY")
   → Frontend shows secrets form
   → User enters key (mocked)
   → Secret stored in SecretsService

2. Taylor: "Make Stripe API call"
   → portable-execute(code="stripe.charges.create(...)")
   → Secret retrieved from SecretsService
   → Code executes with secret available

3. Taylor: "I also need Twilio key"
   → request-user-secrets(secret_name="TWILIO_API_KEY")
   → User enters second key
   → Both keys stored

4. Taylor: "Execute code using both APIs"
   → portable-execute(code="...")
   → Both secrets retrieved
   → Code runs with both secrets
```

**What We're Testing:**

- Secret request flow
- Secret storage/retrieval
- Multiple secrets management
- portable-execute integration
- Secret caching (no re-prompt)

**File:** `tests/integration/tools/secrets-workflow.test.ts`

---

## Implementation Pattern

```typescript
/**
 * Tunnel Workflow - Real User Story
 *
 * STORY: "Local Dev with Browser Testing"
 * User: Sarah testing Next.js with Playwright
 */

describe('Tunnel Workflow - Sarah tests Next.js', () => {
  let tunnelService: TunnelService; // REAL service
  let toolContext: ToolExecutionContext;
  let events: any[];

  beforeEach(async () => {
    // Setup REAL services
    const { userId, authToken } = await createTestUser();
    tunnelService = new TunnelService();
    events = [];

    toolContext = {
      userId,
      authToken,
      tokenAdapter: new TokenAdapter(authToken),
      tunnelService,
      emitEvent: (event, data) => events.push({ event, data }),
    };
  });

  it('Sarah creates tunnels for Next.js and backend', async () => {
    // Step 1: Create tunnel for Next.js
    const tunnel1 = await createTunnelTool.execute(
      {
        port: 3000,
        name: 'frontend',
        description: 'Next.js dev server',
      },
      toolContext
    );

    const t1Data = JSON.parse(tunnel1.content[0].text);
    expect(t1Data.success).toBe(true);
    expect(t1Data.url).toContain('3000');

    // Step 2: List tunnels
    const list1 = await showTunnelTool.execute({}, toolContext);
    const l1Data = JSON.parse(list1.content[0].text);
    expect(l1Data.tunnels).toHaveLength(1);
    expect(l1Data.tunnels[0].port).toBe(3000);

    // Step 3: Create backend tunnel
    const tunnel2 = await createTunnelTool.execute(
      {
        port: 8080,
        name: 'backend',
      },
      toolContext
    );

    expect(JSON.parse(tunnel2.content[0].text).success).toBe(true);

    // Step 4: List both tunnels
    const list2 = await showTunnelTool.execute({}, toolContext);
    const l2Data = JSON.parse(list2.content[0].text);
    expect(l2Data.tunnels).toHaveLength(2);

    // Step 5: Mark frontend as main
    await createTunnelTool.execute(
      {
        port: 3000,
        name: 'frontend',
        main: true,
      },
      toolContext
    );

    // Step 6: Verify main marked
    const list3 = await showTunnelTool.execute({}, toolContext);
    const l3Data = JSON.parse(list3.content[0].text);
    const mainTunnel = l3Data.tunnels.find((t) => t.is_main);
    expect(mainTunnel.port).toBe(3000);
  });
});
```

## Test File Structure

```
tests/integration/tools/
├── tunnel-workflow.test.ts              # Stories 1, 5
├── image-generation-workflow.test.ts    # Story 2
├── video-generation-workflow.test.ts    # Story 3
├── media-analysis-workflow.test.ts      # Story 4, 6
└── secrets-workflow.test.ts             # Story 7
```

## Coverage Goals

| Story          | Tools                             | Target |
| -------------- | --------------------------------- | ------ |
| 1, 5: Tunnels  | create_tunnel, show_tunnel        | 80%    |
| 2: Images      | image-generation, utilities       | 75%    |
| 3: Videos      | video-generation, display         | 75%    |
| 4, 6: Analysis | image/video-analysis              | 70%    |
| 7: Secrets     | request-secrets, portable-execute | 65%    |

**Overall: 75% coverage (from 0%)**

## Implementation Checklist

### Phase 1: Tunnels (HIGH PRIORITY)

- [ ] `tunnel-workflow.test.ts` created
- [ ] Story 1: Local dev browser testing
- [ ] Story 5: Multi-service environment
- [ ] 80%+ coverage

### Phase 2: Image Generation (HIGH PRIORITY)

- [ ] `image-generation-workflow.test.ts` created
- [ ] Story 2: Marketing images
- [ ] 75%+ coverage

### Phase 3: Video Generation (MEDIUM)

- [ ] `video-generation-workflow.test.ts` created
- [ ] Mock Replicate API
- [ ] Story 3: TikTok videos
- [ ] 75%+ coverage

### Phase 4: Media Analysis (MEDIUM)

- [ ] `media-analysis-workflow.test.ts` created
- [ ] Mock Claude Vision API
- [ ] Story 4: Bug analysis
- [ ] Story 6: Accessibility
- [ ] 70%+ coverage

### Phase 5: Secrets (LOW)

- [ ] `secrets-workflow.test.ts` created
- [ ] Mock Portable SDK
- [ ] Story 7: API integration
- [ ] 65%+ coverage

## Success Criteria

✅ Each test = complete user story
✅ Every tool used in realistic context
✅ No orphan tests for coverage
✅ Real services, mocked external APIs
✅ State verified after each action
