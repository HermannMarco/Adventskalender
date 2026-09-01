/* crypto.js — Ende-zu-Ende-Verschlüsselung für den Adventskalender.
 *
 * Alle Inhalte werden im Browser mit AES-GCM-256 ver-/entschlüsselt. Der
 * AES-Schlüssel wird per PBKDF2(SHA-256) aus dem geteilten Passwort + einem
 * pro Kalender zufälligen Salt abgeleitet. Der Server (Firestore/Storage)
 * sieht ausschließlich Chiffrat. Das Passwort verlässt nie das Gerät.
 */
(function (global) {
  'use strict';

  const KDF_ITERATIONS = 250000;
  const KDF_HASH = 'SHA-256';
  const IV_BYTES = 12;                 // empfohlene IV-Länge für AES-GCM
  const VERIFIER_TOKEN = 'adventskalender-ok';

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // ---- Base64 <-> Bytes ---------------------------------------------------
  function bytesToB64(bytes) {
    const arr = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
    let bin = '';
    const CHUNK = 0x8000;              // in Blöcken, sonst Stack-Overflow bei großen Dateien
    for (let i = 0; i < arr.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, arr.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function randomBytes(n) {
    return global.crypto.getRandomValues(new Uint8Array(n));
  }

  // ---- Schlüssel-Ableitung ------------------------------------------------
  function newSalt() {
    return bytesToB64(randomBytes(16));
  }

  /** Leitet aus Passwort + Salt (base64) einen AES-GCM-CryptoKey ab. */
  async function deriveKey(password, saltB64, iterations) {
    const baseKey = await global.crypto.subtle.importKey(
      'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
    );
    return global.crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: b64ToBytes(saltB64),
        iterations: iterations || KDF_ITERATIONS,
        hash: KDF_HASH,
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  // ---- Roh-Bytes ver-/entschlüsseln --------------------------------------
  /** bytes: Uint8Array | ArrayBuffer  ->  { iv, ct } (beide base64). */
  async function encryptBytes(key, bytes) {
    const iv = randomBytes(IV_BYTES);
    const ct = await global.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
    return { iv: bytesToB64(iv), ct: bytesToB64(ct) };
  }

  /** { iv, ct } (base64) -> Uint8Array. Wirft bei falschem Passwort/Manipulation. */
  async function decryptBytes(key, box) {
    const pt = await global.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(box.iv) }, key, b64ToBytes(box.ct)
    );
    return new Uint8Array(pt);
  }

  // ---- Text / JSON --------------------------------------------------------
  async function encryptText(key, text) {
    return encryptBytes(key, enc.encode(text));
  }
  async function decryptText(key, box) {
    return dec.decode(await decryptBytes(key, box));
  }
  async function encryptJSON(key, obj) {
    return encryptText(key, JSON.stringify(obj));
  }
  async function decryptJSON(key, box) {
    return JSON.parse(await decryptText(key, box));
  }

  // ---- Dateien ------------------------------------------------------------
  /** File/Blob -> { iv, ct } (base64). Für Inline-Speicherung in Firestore. */
  async function encryptFile(key, file) {
    const buf = await file.arrayBuffer();
    return encryptBytes(key, buf);
  }
  /** File/Blob -> ArrayBuffer der Chiffratbytes (roh) für Storage-Upload.
   *  IV wird vorne angehängt (12 Byte), damit ein einzelnes Blob genügt. */
  async function encryptFileToBlob(key, file) {
    const iv = randomBytes(IV_BYTES);
    const ct = await global.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, await file.arrayBuffer()
    );
    const out = new Uint8Array(IV_BYTES + ct.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ct), IV_BYTES);
    return new Blob([out], { type: 'application/octet-stream' });
  }
  /** Roh-Chiffrat-ArrayBuffer (IV-präfix) -> Blob mit gewünschtem MIME. */
  async function decryptBlob(key, arrayBuffer, mime) {
    const all = new Uint8Array(arrayBuffer);
    const iv = all.subarray(0, IV_BYTES);
    const ct = all.subarray(IV_BYTES);
    const pt = await global.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new Blob([pt], { type: mime || 'application/octet-stream' });
  }

  // ---- Verifier (Passwortprüfung) ----------------------------------------
  async function makeVerifier(key) {
    return encryptText(key, VERIFIER_TOKEN);
  }
  async function checkVerifier(key, box) {
    try {
      return (await decryptText(key, box)) === VERIFIER_TOKEN;
    } catch (_) {
      return false;
    }
  }

  global.AKCrypto = {
    KDF_ITERATIONS, KDF_HASH,
    newSalt, deriveKey,
    encryptBytes, decryptBytes,
    encryptText, decryptText, encryptJSON, decryptJSON,
    encryptFile, encryptFileToBlob, decryptBlob,
    makeVerifier, checkVerifier,
    bytesToB64, b64ToBytes,
  };
})(window);
