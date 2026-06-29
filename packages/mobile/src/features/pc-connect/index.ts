/**
 * pc-connect (QR pairing) — the post-Clerk-sign-in QR-connect gate.
 *
 * After Clerk sign-in the device connects to a PC by scanning the pairing QR
 * shown in the launcher's terminal (or its loopback page). The QR carries the
 * PC-minted data-path JWT (`QrLinkPayload.token`), which the app stores per `pcId`
 * (save-only — no `/link-pc` round-trip, no `/my-pcs` discovery) and then
 * reconnects to the stable `<gatewayBase>/t/<pcId>` relay without re-scanning.
 */

export { PcConnectGate, type PcConnectGateProps } from './PcConnectGate';
export { PcConnectLanding, type PcConnectLandingProps } from './PcConnectLanding';
export { QRScannerGate, type QRScannerGateProps } from './QRScannerGate';
export { parseQrPayload } from './parseQrPayload';
export {
  hasDeviceToken,
  getDeviceToken,
  saveDeviceToken,
  clearDeviceToken,
  DEVICE_TOKEN_KEY_PREFIX,
} from './deviceTokenStore';
export {
  relayBaseForPc,
  saveConnectedPcId,
  getConnectedPcId,
  clearConnectedPcId,
  CONNECTED_PC_KEY,
} from './connectedPcStore';
export { resolveDataPathToken, persistRenewedDataPathToken } from './dataPathToken';
export { linkPc, type LinkPcInput, type LinkPcDeps, type LinkPcResult } from './linkPc';
export {
  connectToPc,
  type ConnectToPcDeps,
  type ConnectToPcResult,
  type ConnectToPcReason,
} from './connectToPc';
export {
  verifyTunnelAddress,
  relayHealthUrl,
  relayAuthCheckUrl,
  type VerifyTunnelAddressDeps,
} from './verifyTunnelAddress';
export { buildPcConnectConfig, type PcConnectConfig } from './pcConnectConfig';
export { PcConnectModal, type PcConnectModalProps } from './PcConnectModal';
export { usePcConnectionStore, type PcConnectionState } from './pcConnectionStore';
export {
  disconnectPc,
  clearPcPairing,
  type DisconnectPcDeps,
  type ClearPcPairingDeps,
} from './disconnectPc';
