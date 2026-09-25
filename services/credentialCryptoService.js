import {
  createCipheriv,
  createDecipheriv,
  randomBytes
} from "node:crypto";

function getEncryptionKey() {
  const keyHex = process.env.DATA_ENCRYPTION_KEY || "";

  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error(
      "DATA_ENCRYPTION_KEY must be 64 hexadecimal characters."
    );
  }

  return Buffer.from(keyHex, "hex");
}

export function encryptCredentials(credentials) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(credentials), "utf8"),
    cipher.final()
  ]);

  return {
    version: 1,
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64")
  };
}

export function decryptCredentials(encryptedCredentials) {
  if (encryptedCredentials?.version !== 1) {
    throw new Error("Unsupported credential encryption version.");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(encryptedCredentials.iv, "base64")
  );

  decipher.setAuthTag(
    Buffer.from(encryptedCredentials.authTag, "base64")
  );

  const decrypted = Buffer.concat([
    decipher.update(
      Buffer.from(encryptedCredentials.data, "base64")
    ),
    decipher.final()
  ]);

  return JSON.parse(decrypted.toString("utf8"));
}