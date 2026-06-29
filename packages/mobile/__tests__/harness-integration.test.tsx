/**
 * Integration-test harness for `packages/mobile`.
 *
 * Proves the two mocking layers of the harness (`src/test`) are wired and can
 * drive a real component end-to-end with no device/Metro/network:
 *
 *   1. HTTP — a mounted component fetches gateway config through `GatewayClient`
 *      (backed by `createMockGateway().fetchImpl`) and renders it.
 *   2. Socket.IO — the same component subscribes to a server event via a socket
 *      from the shared core's `createSocket()` (backed by the virtual
 *      `socket.io-client` mock); the test drives the event and the component
 *      re-renders.
 *
 * The single `it` for the headline acceptance criterion asserts BOTH a mocked
 * gateway HTTP response and a mocked Socket.IO event are observed in one mount.
 * The remaining cases exercise the harness's other guarantees (global-fetch
 * interception, Bearer enforcement, client-emission recording / acks).
 */

// Hoisted above imports: route `createSocket()`'s `io()` to our mock socket.
jest.mock('socket.io-client', () => require('../src/test/mockSocket').createSocketIoMock(), {
  virtual: true,
});

import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { act, render, screen } from '@testing-library/react-native';

import { createSocket, SERVER_EVENTS, type SocketLike } from '@vgit2/shared/socket';
import { GatewayClient, GatewayHttpError } from '../src/services/gatewayClient';
import { createMockGateway, type MockSocketIoModule } from '../src/test';

/** The controller backing the single socket the mocked `io()` hands out. */
const socketMock = jest.requireMock('socket.io-client') as MockSocketIoModule;

/**
 * A small component wired through BOTH boundaries: it fetches gateway config
 * (HTTP) and listens for a new-message server event (Socket.IO), rendering each
 * the moment it arrives.
 */
function HarnessProbe({ gateway, socket }: { gateway: GatewayClient; socket: SocketLike }) {
  const [environment, setEnvironment] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    gateway
      .getConfig()
      .then((config) => {
        if (active) setEnvironment(config.environment);
      })
      .catch(() => {
        /* ignore in the probe */
      });

    const onMessage = (...args: unknown[]) => {
      const payload = args[0] as { text?: string } | undefined;
      if (active && payload?.text) setMessage(payload.text);
    };
    socket.on(SERVER_EVENTS.CHAT_NEW_MESSAGE, onMessage);

    return () => {
      active = false;
      socket.off?.(SERVER_EVENTS.CHAT_NEW_MESSAGE, onMessage);
    };
  }, [gateway, socket]);

  return (
    <View>
      {environment && <Text>{`env:${environment}`}</Text>}
      {message && <Text>{`msg:${message}`}</Text>}
    </View>
  );
}

describe('mobile integration-test harness', () => {
  beforeEach(() => {
    socketMock.__controller.reset();
  });

  it('mounts a component and observes BOTH a mocked gateway HTTP response and a mocked Socket.IO event', async () => {
    const gateway = createMockGateway();
    const client = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
    // `createSocket()` resolves to the mocked `io()`, returning the mock socket.
    const socket = createSocket('jwt-token', gateway.baseUrl) as unknown as SocketLike;

    render(<HarnessProbe gateway={client} socket={socket} />);

    // (1) HTTP layer: the mocked /config response is observed and rendered.
    expect(await screen.findByText('env:test')).toBeTruthy();
    expect(gateway.requests.some((r) => r.path.endsWith('/config') && r.method === 'GET')).toBe(
      true
    );

    // (2) Socket.IO layer: drive a server event; the component re-renders.
    act(() => {
      const notified = socketMock.__controller.emitServerEvent(SERVER_EVENTS.CHAT_NEW_MESSAGE, {
        text: 'hello from mock socket',
      });
      expect(notified).toBe(1); // the probe's listener received it
    });
    expect(await screen.findByText('msg:hello from mock socket')).toBeTruthy();
  });

  it('intercepts the GLOBAL fetch after install() and restores it', async () => {
    const original = globalThis.fetch;
    const gateway = createMockGateway();
    gateway.install();
    try {
      // A client given NO fetchImpl falls back to the (now-mocked) global fetch.
      const client = new GatewayClient({ gatewayUrl: gateway.baseUrl });
      const config = await client.getConfig();
      expect(config.environment).toBe('test');
      expect(globalThis.fetch).toBe(gateway.fetchImpl);
    } finally {
      gateway.restore();
    }
    expect(globalThis.fetch).toBe(original);
  });

  it('enforces the gateway Bearer-only contract in its defaults', async () => {
    const gateway = createMockGateway();
    const client = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });

    // No Bearer → 401.
    await expect(client.getMe('')).rejects.toBeInstanceOf(GatewayHttpError);

    // With Bearer → typed payload.
    await client.getMe('jwt-token');
    const last = gateway.requests.at(-1);
    expect(last?.headers.Authorization).toBe('Bearer jwt-token');
    // The contract: cookies are never attached.
    expect(last?.credentials).toBe('omit');
  });

  it('records client→server emissions and acks them through the socket mock', async () => {
    const socket = createSocket(
      'jwt-token',
      'https://gateway.portable.test'
    ) as unknown as SocketLike;
    socketMock.__controller.setAck(SERVER_EVENTS.CHAT_NEW_MESSAGE, {
      success: false,
      error: 'nope',
    });

    let ack: unknown;
    socket.emit('chat:create', { name: 'probe' }, (a: unknown) => {
      ack = a;
    });
    socket.emit(SERVER_EVENTS.CHAT_NEW_MESSAGE, { text: 'x' }, (a: unknown) => {
      ack = a;
    });

    const emissions = socketMock.__controller.emissions;
    expect(emissions).toHaveLength(2);
    expect(emissions[0]).toMatchObject({ event: 'chat:create', hadAck: true });
    expect(emissions[0].args[0]).toEqual({ name: 'probe' });
    // Default ack is { success: true }; the override is honored for the 2nd.
    expect(ack).toEqual({ success: false, error: 'nope' });
  });

  it('lets a handler be overridden per-test via onRn()', async () => {
    const gateway = createMockGateway();
    gateway.onRn('GET', '/config', () => ({
      body: { gatewayUrl: gateway.baseUrl, environment: 'staging', clerkPublishableKey: 'pk_x' },
    }));
    const client = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
    const config = await client.getConfig();
    expect(config.environment).toBe('staging');
  });
});
