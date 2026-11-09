// WebAuthn/CBOR primitives for passkey registration and login.

import crypto from 'crypto';

export function b64uToBuf(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64 + '='.repeat((4 - b64.length % 4) % 4);
  return Buffer.from(pad, 'base64');
}
export function bufToB64u(b) { return Buffer.from(b).toString('base64url'); }

export function parseAuthenticatorData(authData) {
  if (!Buffer.isBuffer(authData) || authData.length < 37) throw new Error('authenticator data too short');
  const rpIdHash = authData.slice(0, 32);
  const flags = authData[32];
  const signCount = authData.readUInt32BE(33);
  const result = { rpIdHash, flags, signCount };
  if (flags & 0x40) {
    if (authData.length < 55) throw new Error('attested credential data too short');
    const aaguid = authData.slice(37, 53);
    const credIdLen = authData.readUInt16BE(53);
    if (credIdLen > 1023 || authData.length < 55 + credIdLen) throw new Error('bad credential id length');
    const credentialId = authData.slice(55, 55 + credIdLen);
    const publicKeyBytes = authData.slice(55 + credIdLen);
    result.aaguid = aaguid;
    result.credentialId = credentialId;
    result.publicKeyBytes = publicKeyBytes;
  }
  return result;
}
// Just enough CBOR for attestation objects and COSE keys. Every read is
// bounds-checked against the buffer, and a count can never exceed the
// bytes left, so a crafted header cannot make the decoder loop or allocate
// without end. Maps have no prototype, so a "__proto__" key is just a key.
export function decodeCBOR(buffer) {
  let offset = 0;
  function need(n) {
    if (offset + n > buffer.length) throw new Error('CBOR truncated');
  }
  function read(depth) {
    if (depth > 16) throw new Error('CBOR nested too deep');
    need(1);
    const first = buffer[offset++];
    const major = first >> 5;
    const additional = first & 0x1f;
    let value;
    if (additional < 24) value = additional;
    else if (additional === 24) { need(1); value = buffer[offset++]; }
    else if (additional === 25) { need(2); value = buffer.readUInt16BE(offset); offset += 2; }
    else if (additional === 26) { need(4); value = buffer.readUInt32BE(offset); offset += 4; }
    else if (additional === 27) { need(8); value = Number(buffer.readBigUInt64BE(offset)); offset += 8; }
    else throw new Error('bad CBOR additional ' + additional);
    switch (major) {
      case 0: return value;
      case 1: return -1 - value;
      case 2: { need(value); const b = buffer.slice(offset, offset + value); offset += value; return b; }
      case 3: { need(value); const t = buffer.slice(offset, offset + value).toString('utf8'); offset += value; return t; }
      case 4: { need(value); const a = []; for (let i = 0; i < value; i++) a.push(read(depth + 1)); return a; }
      case 5: {
        need(value);
        const m = Object.create(null);
        for (let i = 0; i < value; i++) { const k = read(depth + 1); m[k] = read(depth + 1); }
        return m;
      }
      default: throw new Error('bad CBOR major ' + major);
    }
  }
  return read(0);
}
export function coseToPublicKey(coseKey) {
  const kty = coseKey[1], alg = coseKey[3];
  if (kty === 2 && alg === -7) {
    const crv = coseKey[-1], x = coseKey[-2], y = coseKey[-3];
    if (crv !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) {
      throw new Error('COSE key is not a P-256 point');
    }
    return { algorithm: 'ES256', publicKey: Buffer.concat([Buffer.from([0x04]), x, y]) };
  }
  throw new Error(`Unsupported COSE key kty=${kty} alg=${alg}`);
}
export function verifyES256Signature(publicKeyUncompressed, signature, data) {
  const header = Buffer.from([
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00
  ]);
  const derKey = Buffer.concat([header, publicKeyUncompressed]);
  const pem = '-----BEGIN PUBLIC KEY-----\n' +
              derKey.toString('base64').match(/.{1,64}/g).join('\n') +
              '\n-----END PUBLIC KEY-----';
  const verify = crypto.createVerify('SHA256');
  verify.update(data);
  verify.end();
  return verify.verify(pem, signature);
}
