/**
 * FindMy key generation using P-224 elliptic curve.
 *
 * Uses @noble/curves low-level APIs to define P-224 (not available in WebCrypto).
 * Key material layout (68 bytes):
 *   [private_key: 28B][symmetric_key: 32B][epoch_secs: 8B LE]
 */

import { createCurve } from "@noble/curves/_shortw_utils";
import { Field } from "@noble/curves/abstract/modular";
import { sha256 } from "@noble/hashes/sha2";

const P224_CURVE = {
  p: BigInt("0xffffffffffffffffffffffffffffffff000000000000000000000001"),
  n: BigInt("0xffffffffffffffffffffffffffff16a2e0b8f03e13dd29455c5c2a3d"),
  h: BigInt(1),
  a: BigInt("0xfffffffffffffffffffffffffffffffefffffffffffffffffffffffe"),
  b: BigInt("0xb4050a850c04b3abf54132565044b0b7d7bfd8ba270b39432355ffb4"),
  Gx: BigInt("0xb70e0cbd6bb4bf7f321390b94a03c1d356c21122343280d6115c1d21"),
  Gy: BigInt("0xbd376388b5f723fb4c22dfe6cd4375a05a07476444d5819985007e34")
};

const p224 = createCurve(
  { ...P224_CURVE, Fp: Field(P224_CURVE.p), lowS: false },
  sha256
);

const PRIVATE_KEY_SIZE = 28;
const SYMMETRIC_KEY_SIZE = 32;
const EPOCH_SIZE = 8;
export const KEY_MATERIAL_SIZE = PRIVATE_KEY_SIZE + SYMMETRIC_KEY_SIZE + EPOCH_SIZE;

export type FindMyKeyBundle = {
  /** 28-byte P-224 private key */
  privateKey: Uint8Array;
  /** Uncompressed P-224 public key (57 bytes: 0x04 || x || y) */
  publicKey: Uint8Array;
  /** 32-byte initial symmetric key SK₀ */
  symmetricKey: Uint8Array;
  /** Unix timestamp epoch (counter=0 reference) */
  epoch: number;
  /** 68-byte packed key material for device provisioning */
  packed: Uint8Array;
};

/** Generate a fresh FindMy key bundle. */
export function generateFindMyKeys(): FindMyKeyBundle {
  const privateKey = p224.utils.randomPrivateKey();
  const publicKey = p224.getPublicKey(privateKey, false);
  const symmetricKey = crypto.getRandomValues(new Uint8Array(SYMMETRIC_KEY_SIZE));
  const epoch = Math.floor(Date.now() / 1000);

  const packed = packKeys(privateKey, symmetricKey, epoch);

  return { privateKey, publicKey, symmetricKey, epoch, packed };
}

/** Pack key material into 68-byte device format. */
function packKeys(privateKey: Uint8Array, symmetricKey: Uint8Array, epoch: number): Uint8Array {
  const buf = new Uint8Array(KEY_MATERIAL_SIZE);
  buf.set(privateKey, 0);
  buf.set(symmetricKey, PRIVATE_KEY_SIZE);
  const epochView = new DataView(buf.buffer, PRIVATE_KEY_SIZE + SYMMETRIC_KEY_SIZE, EPOCH_SIZE);
  epochView.setBigUint64(0, BigInt(epoch), true);
  return buf;
}

/** Unpack 68-byte device format into key bundle. */
export function unpackKeys(data: Uint8Array): FindMyKeyBundle | null {
  if (data.length !== KEY_MATERIAL_SIZE) {
    return null;
  }
  const privateKey = data.slice(0, PRIVATE_KEY_SIZE);
  const symmetricKey = data.slice(PRIVATE_KEY_SIZE, PRIVATE_KEY_SIZE + SYMMETRIC_KEY_SIZE);
  const epochView = new DataView(data.buffer, data.byteOffset + PRIVATE_KEY_SIZE + SYMMETRIC_KEY_SIZE, EPOCH_SIZE);
  const epoch = Number(epochView.getBigUint64(0, true));

  let publicKey: Uint8Array;
  try {
    publicKey = p224.getPublicKey(privateKey, false);
  } catch {
    return null;
  }

  return { privateKey, publicKey, symmetricKey, epoch, packed: new Uint8Array(data) };
}

/** Export key bundle as JSON for backup. */
export function exportKeysAsJson(bundle: FindMyKeyBundle): string {
  return JSON.stringify({
    private_key: bytesToHex(bundle.privateKey),
    public_key: bytesToHex(bundle.publicKey),
    symmetric_key: bytesToHex(bundle.symmetricKey),
    epoch: bundle.epoch,
    epoch_iso: new Date(bundle.epoch * 1000).toISOString()
  }, null, 2);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}
