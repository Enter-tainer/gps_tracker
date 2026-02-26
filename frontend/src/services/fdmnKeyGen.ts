/**
 * Google FMDN (Find My Device Network) EIK key generation.
 *
 * The EIK (Ephemeral Identity Key) is a 32-byte random key used for
 * EID (Ephemeral Identifier) computation via AES-ECB-256 + SECP160R1.
 */

export const FMDN_EIK_SIZE = 32;

export type FmdnEikBundle = {
  /** 32-byte Ephemeral Identity Key */
  eik: Uint8Array;
};

/** Generate a fresh 32-byte EIK. */
export function generateFmdnEik(): FmdnEikBundle {
  const eik = crypto.getRandomValues(new Uint8Array(FMDN_EIK_SIZE));
  return { eik };
}

/** Export EIK as JSON for backup. */
export function exportEikAsJson(bundle: FmdnEikBundle): string {
  return JSON.stringify({
    eik: bytesToHex(bundle.eik),
    generated_at: new Date().toISOString()
  }, null, 2);
}

/** Import EIK from JSON backup. */
export function importEikFromJson(json: string): FmdnEikBundle | null {
  try {
    const obj = JSON.parse(json);
    if (typeof obj.eik !== "string") {
      return null;
    }
    const eik = hexToBytes(obj.eik);
    if (eik.length !== FMDN_EIK_SIZE) {
      return null;
    }
    return { eik };
  } catch {
    return null;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
