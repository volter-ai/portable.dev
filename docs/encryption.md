# End-to-end encryption & the relay trust model

_This document describes what travels between the mobile app, the relay, and your PC —
and exactly what each party can see. Everything here is implemented in the open-source
packages (`packages/shared`, `packages/api`, `packages/launcher`, `packages/mobile`);
file pointers below are to that code._

## The three parties

```
┌────────────┐   TLS    ┌────────────┐   TLS (cloudflared)   ┌──────────────┐
│ mobile app │ ───────▶ │   relay    │ ────────────────────▶ │  your PC     │
│ (Expo RN)  │ ◀─────── │ (gateway)  │ ◀──────────────────── │ (portable)   │
└────────────┘          └────────────┘                       └──────────────┘
        └────────────── E2E: XChaCha20-Poly1305, key never leaves QR ─────┘
```

- **Your PC** runs the Portable runtime (`portable` / `bun run portable`). It holds all
  data: repos, chats, credentials, the AI session.
- **The relay** (the hosted one at `app.portable.dev`, or one you run yourself) does two
  small jobs: it accepts the PC's `pcId`-keyed tunnel registration, and it
  reverse-proxies app traffic to the PC's cloudflared tunnel. It is a router, not a
  datastore for your content.
- **The mobile app** talks to the relay over TLS, but the payloads it exchanges with the
  PC are sealed end-to-end — the relay forwards ciphertext it cannot read.

## The pre-shared key (PSK)

On first boot the launcher generates a random 32-byte key and persists it
(`packages/launcher/src/PairingIdentity.ts`, `ensureE2ePsk`). You can pin your own via
`PORTABLE_E2E_PSK` (base64, 32 bytes).

The key travels to the phone **only inside the pairing QR code** — the QR payload is
`{ gatewayBase, pcId, token, e2eKey }`. It is never sent over the network, so the relay
never learns it. This makes **QR confidentiality the trust root**: anyone who can scan
your QR while it is displayed can pair; nobody who merely observes network traffic can.

## The protocol

1. **Handshake.** The app performs a PSK-authenticated X25519 key exchange with the PC
   (`packages/shared/src/e2e/handshake.ts`, served by the api's public
   `POST /api/e2e/handshake` route). The PSK authenticates the exchange (MAC), the
   ephemeral X25519 keys give each session fresh keys.
2. **Sealed envelopes.** HTTP request/response bodies are wrapped in
   XChaCha20-Poly1305 envelopes (`packages/shared/src/e2e/envelope.ts`, `wire.ts`).
3. **Sealed sockets.** Socket.IO frames are sealed the same way
   (`packages/shared/src/e2e/socketFrame.ts`, `packages/shared/src/socket/e2eSocket.ts`).
4. **Plaintext rejection.** E2E is mandatory, not opportunistic: the PC's api rejects
   un-sealed data-path requests with **HTTP 426 `e2e_required`** and refuses un-sealed
   socket sessions (`packages/api/src/middleware/e2eEnforcement.ts`). The exempt list is
   defined in that middleware: health/version endpoints, the handshake itself, and a few
   binary/media surfaces fetched directly by native loaders (video, uploads,
   workspace files) — the latter are a **documented plaintext gap**, noted in the code.

## What the relay can and cannot see

| The relay sees                                            | The relay cannot see                       |
| --------------------------------------------------------- | ------------------------------------------ |
| That a PC with a given `pcId` is registered and online    | Request/response bodies (sealed envelopes) |
| Connection metadata: timing, sizes, IPs                   | Chat content, code, file contents          |
| Exempt-path traffic (health, handshake, binary/media gap) | Credentials stored on the PC               |
|                                                           | The PSK (it is only ever in the QR)        |

One deliberate, opt-in exception exists for App Store review: the launcher's
reviewer-publish mode (default **off**, intended for a disposable review-only PC)
registers its pairing token and E2E key with the relay so Apple's reviewer can skip the
QR scan. A normal PC's registration carries neither.

## Self-hosting

The E2E layer means you don't have to trust the hosted relay with content — but you can
also run your own relay to control the routing metadata path. Point the PC at it with
`PORTABLE_RELAY_URL` and re-pair; the QR carries the relay address, so the app follows
automatically. Any relay only needs to implement the pcId-keyed registration endpoint
and blind reverse-proxying — it needs no knowledge of the E2E layer at all.

## Key rotation

The PSK is per-PC, not per-session. To rotate it, delete the persisted key (or change
`PORTABLE_E2E_PSK`), restart the runtime, and re-pair by scanning the new QR. Session
keys are already ephemeral per connection via the X25519 exchange.
