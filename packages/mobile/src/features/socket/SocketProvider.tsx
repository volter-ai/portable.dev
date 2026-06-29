/**
 * SocketProvider — mounts the RN Socket.IO ViewModel and exposes the live socket
 * + emit helpers to the authenticated tree via `useSocket()`.
 *
 * Connection STATE is read from `useSocketStore` (Zustand), not this context, so
 * any screen can subscribe without prop-drilling. The context carries only the
 * imperative surface (emitters, `joinChat`, `reconnectAndSync`).
 *
 * The app-shell wires this around the authenticated tree.
 */

import { createContext, useContext, type ReactNode } from 'react';

import { ReconnectingBanner } from './ReconnectingBanner';
import { SystemWarnings, type SystemWarningsProps } from './SystemWarnings';
import { useNativeSocket, type NativeSocket, type NativeSocketDeps } from './useNativeSocket';

const SocketContext = createContext<NativeSocket | null>(null);

export interface SocketProviderProps extends NativeSocketDeps, SystemWarningsProps {
  children: ReactNode;
}

export function SocketProvider({
  children,
  onExtendSession,
  onReprovision,
  ...deps
}: SocketProviderProps) {
  const socket = useNativeSocket(deps);
  return (
    <SocketContext.Provider value={socket}>
      {children}
      {/* System lifecycle warnings + reconnecting banner + the re-provision/
          loading overlay — driven by the socket stores, so they render wherever
          the socket lives. The app-shell wires `onReprovision` to the session
          boundary's death handler. */}
      <SystemWarnings onExtendSession={onExtendSession} onReprovision={onReprovision} />
      <ReconnectingBanner />
    </SocketContext.Provider>
  );
}

/** Access the socket emit helpers / lifecycle controls. Throws outside the provider. */
export function useSocket(): NativeSocket {
  const ctx = useContext(SocketContext);
  if (!ctx) throw new Error('useSocket must be used within a SocketProvider');
  return ctx;
}

/**
 * Like {@link useSocket} but returns `null` outside a provider instead of
 * throwing — for screens (e.g. the active-chat screen) that can render before
 * the app-shell mounts the socket, degrading to a no-stream state.
 */
export function useOptionalSocket(): NativeSocket | null {
  return useContext(SocketContext);
}
