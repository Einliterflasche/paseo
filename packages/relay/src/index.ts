export type { ConnectionRole, RelaySessionAttachment } from "./types.js";

export {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSharedKey,
  encrypt,
  decrypt,
} from "./crypto.js";

export {
  base64EncryptedWireByteLength,
  createClientChannel,
  createDaemonChannel,
  EncryptedChannel,
  maxBase64EncryptedPlaintextByteLength,
  RELAY_MAX_FRAME_BYTES,
} from "./encrypted-channel.js";
export type { Transport, EncryptedChannelEvents } from "./encrypted-channel.js";
