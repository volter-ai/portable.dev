/**
 * Per-socket broadcast helpers — E2E-seal-correct room/namespace emits
 * (portable.dev#13).
 *
 * The server-side E2E seal (`installServerSocketE2e`) is installed as an override
 * of each socket's low-level `.packet()` method. But socket.io room/namespace
 * broadcasts (`io.to(room).emit(...)`, `io.emit(...)`) do NOT go through
 * `socket.packet`: the ADAPTER encodes the packet ONCE and writes the bytes
 * straight to each client's engine (`socket.client.writeToEngine`), bypassing the
 * per-socket seal. So a broadcast reaches an E2E client as PLAINTEXT, which the
 * client's `wrapSocketE2e` then drops (an unsealed frame is a protocol
 * violation) — silently losing the live chat stream, `user_message`, metrics, etc.
 *
 * These helpers fan a broadcast out to each target socket via per-socket
 * `socket.emit`, so every frame passes through the sealed `.packet()` chokepoint.
 * With E2E OFF the socket's `.packet()` is un-overridden and still emits plaintext
 * — byte-for-byte the old broadcast — so this is safe whether or not E2E is
 * active. Only local `Socket` instances (which carry the seal override) are
 * iterated; there is no multi-node adapter (local-first, single process).
 *
 * ALWAYS route a client-facing broadcast through one of these (never a bare
 * `io.to(room).emit` / `io.emit`) or E2E clients will silently drop it.
 */
import type { Server } from 'socket.io';

/** Emit `event` to every socket currently joined to `room`, per-socket (E2E-sealed). */
export function emitToRoom(io: Server, room: string, event: string, data: unknown): void {
  for (const socket of io.sockets.sockets.values()) {
    if (socket.rooms.has(room)) socket.emit(event, data);
  }
}

/** Emit `event` to every connected socket, per-socket (E2E-sealed). The `io.emit` sibling. */
export function emitToAllSockets(io: Server, event: string, data: unknown): void {
  for (const socket of io.sockets.sockets.values()) {
    socket.emit(event, data);
  }
}
