/**
 * @module
 * Cryptographic utilities for secure session middleware.
 * Implements seal/unseal functions using AES-256-GCM with HKDF (legacy PBKDF2 supported).
 */

import { encodeBase64Url, decodeBase64Url } from '../../utils/encode'

/**
 * Secret key configuration supporting rotation.
 * - Single string: Simple secret (minimum 32 characters)
 * - Array of strings: First element encrypts new data, all elements decrypt
 *   - secrets[0] is used for new seals
 *   - All secrets are tried for unsealing (first to last)
 */
export type SecretConfig = string | string[]

/**
 * Result of sealing operation
 */
export interface SealResult {
  /** Base64url-encoded sealed data */
  sealed: string
  /** Key index used for sealing (always 0) */
  keyIndex: number
}

/**
 * Result of unsealing operation
 */
export interface UnsealResult<T> {
  /** Decoded payload */
  payload: T
  /** Key index that successfully unsealed */
  keyIndex: number
}

type Bytes = Uint8Array

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  if (data.buffer instanceof ArrayBuffer) {
    if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
      return data.buffer
    }
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  }
  return new Uint8Array(data).buffer
}

// AES-256-GCM configuration
const ALGORITHM = 'AES-GCM'
const KEY_LENGTH = 256
const IV_LENGTH = 12 // 96 bits for GCM (NIST recommended)
const TAG_LENGTH = 128 // Authentication tag bits
const SALT_LENGTH = 16 // 128 bits for per-message key derivation info

// PBKDF2 configuration
const PBKDF2_ITERATIONS = 100000
const PBKDF2_HASH = 'SHA-256'

// HKDF configuration
const HKDF_HASH = 'SHA-256'
const HKDF_SALT_LABEL = 'hono-secure-session-v2'

// Seal format version (for future compatibility)
const SEAL_VERSION = 3 // Bumped for HKDF-based seals

// Minimum header size: version(1) + flags(1) + keyIndex(1) + salt(16) + iv(12) + min ciphertext(16)
const MIN_SEALED_LENGTH = 1 + 1 + SALT_LENGTH + IV_LENGTH + 16

let hkdfSaltPromise: Promise<ArrayBuffer> | null = null

async function getHkdfSalt(): Promise<ArrayBuffer> {
  if (!hkdfSaltPromise) {
    const encoder = new TextEncoder()
    hkdfSaltPromise = crypto.subtle.digest(
      'SHA-256',
      toArrayBuffer(encoder.encode(HKDF_SALT_LABEL))
    )
  }
  return hkdfSaltPromise
}

/**
 * Derive a CryptoKey from a password string using PBKDF2
 */
async function deriveKeyPBKDF2(password: string, salt: Bytes): Promise<CryptoKey> {
  const encoder = new TextEncoder()
  const passwordBuffer = encoder.encode(password)

  // Import password as raw key material
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(passwordBuffer),
    'PBKDF2',
    false,
    ['deriveKey']
  )

  // Derive AES-256-GCM key
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt.buffer as ArrayBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    keyMaterial,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  )
}

/**
 * Derive a CryptoKey from strong key material using HKDF
 */
async function deriveKeyHKDF(secret: string, info: Bytes): Promise<CryptoKey> {
  const encoder = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(encoder.encode(secret)),
    'HKDF',
    false,
    ['deriveBits']
  )

  const hkdfSalt = await getHkdfSalt()
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: HKDF_HASH,
      salt: hkdfSalt,
      info: toArrayBuffer(info),
    },
    keyMaterial,
    KEY_LENGTH
  )

  return crypto.subtle.importKey(
    'raw',
    derivedBits,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  )
}

/**
 * Normalize secrets to array format
 */
function normalizeSecrets(secrets: SecretConfig): string[] {
  return typeof secrets === 'string' ? [secrets] : secrets
}

/**
 * Compress data using CompressionStream if available, otherwise return original
 */
export async function compress(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    return data
  }

  try {
    const stream = new CompressionStream('deflate')
    const writer = stream.writable.getWriter()
    void writer.write(toArrayBuffer(data))
    void writer.close()

    const chunks: Uint8Array[] = []
    const reader = stream.readable.getReader()

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value as Uint8Array)
    }

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const result = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.length
    }

    // Only use compressed version if it's actually smaller
    if (result.length < data.length) {
      return result
    }
    return data
  } catch {
    return data
  }
}

/**
 * Decompress data using DecompressionStream if available
 */
export async function decompress(data: Uint8Array, isCompressed: boolean): Promise<Uint8Array> {
  if (!isCompressed || typeof DecompressionStream === 'undefined') {
    return data
  }

  try {
    const stream = new DecompressionStream('deflate')
    const writer = stream.writable.getWriter()
    void writer.write(toArrayBuffer(data))
    void writer.close()

    const chunks: Uint8Array[] = []
    const reader = stream.readable.getReader()

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value as Uint8Array)
    }

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const result = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.length
    }

    return result
  } catch {
    // If decompression fails, return original data
    return data
  }
}

/**
 * Seal (encrypt + authenticate) data using AES-256-GCM
 *
 * Sealed format: version(1) | flags(1) | keyIndex(1) | salt(16) | iv(12) | ciphertext+tag(variable)
 * All base64url encoded
 *
 * Flags byte:
 * - bit 0: compressed (1 = yes, 0 = no)
 *
 * @param data - The data to seal (will be JSON serialized)
 * @param secrets - Secret configuration (string or array)
 * @param enableCompression - Whether to attempt compression (default: true)
 * @returns Promise resolving to sealed data and key index used
 */
export async function seal<T>(
  data: T,
  secrets: SecretConfig,
  enableCompression = true
): Promise<SealResult> {
  const secretArray = normalizeSecrets(secrets)

  if (secretArray.length === 0) {
    throw new Error('No secrets provided')
  }

  const password = secretArray[0]
  const keyIndex = 0

  if (!password) {
    throw new Error('No valid secret found for sealing')
  }

  // Generate random salt and IV
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH)) as Bytes
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH)) as Bytes

  // Derive key from password
  const key = await deriveKeyHKDF(password, salt)

  // Serialize data
  const encoder = new TextEncoder()
  let plaintext = encoder.encode(JSON.stringify(data)) as Uint8Array

  // Try compression if enabled
  let isCompressed = false
  if (enableCompression) {
    const compressed = await compress(plaintext)
    if (compressed.length < plaintext.length) {
      plaintext = compressed as Uint8Array
      isCompressed = true
    }
  }

  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv: iv.buffer as ArrayBuffer, tagLength: TAG_LENGTH },
    key,
    plaintext.buffer as ArrayBuffer
  )

  // Flags byte
  const flags = isCompressed ? 0x01 : 0x00

  // Combine: version(1) | flags(1) | keyIndex(1) | salt(16) | iv(12) | ciphertext
  const sealed = new Uint8Array(1 + 1 + 1 + SALT_LENGTH + IV_LENGTH + ciphertext.byteLength)
  let offset = 0

  // Version byte
  sealed[offset++] = SEAL_VERSION

  // Flags byte
  sealed[offset++] = flags

  // Key index (8-bit)
  sealed[offset++] = keyIndex & 0xff

  // Salt
  sealed.set(salt, offset)
  offset += SALT_LENGTH

  // IV
  sealed.set(iv, offset)
  offset += IV_LENGTH

  // Ciphertext (includes auth tag)
  sealed.set(new Uint8Array(ciphertext), offset)

  return {
    sealed: encodeBase64Url(sealed.buffer as ArrayBuffer),
    keyIndex,
  }
}

/**
 * Unseal (decrypt + verify) data using AES-256-GCM
 *
 * Tries all available keys in order (first to last).
 *
 * @param sealed - Base64url-encoded sealed data
 * @param secrets - Secret configuration (string or array)
 * @returns Promise resolving to decrypted payload and key index used
 * @throws Error if decryption fails with all keys
 */
export async function unseal<T>(sealed: string, secrets: SecretConfig): Promise<UnsealResult<T>> {
  const secretArray = normalizeSecrets(secrets)

  if (secretArray.length === 0) {
    throw new Error('No valid secrets available for unsealing')
  }

  // Decode sealed data
  let data: Uint8Array
  try {
    data = decodeBase64Url(sealed) as Uint8Array
  } catch {
    throw new Error('Invalid sealed data: failed to decode base64url')
  }

  if (data.length < MIN_SEALED_LENGTH) {
    throw new Error('Invalid sealed data: too short')
  }

  let offset = 0

  // Check version
  const version = data[offset++]
  if (version === 1) {
    return unsealV1<T>(data, secretArray)
  }

  if (version === 2) {
    return unsealV2<T>(data, secretArray)
  }

  if (version !== SEAL_VERSION) {
    throw new Error(`Unsupported seal version: ${version}`)
  }

  return unsealV3<T>(data, secretArray)
}

type KeyDeriver = (secret: string, info: Bytes) => Promise<CryptoKey>

async function unsealV2OrV3<T>(
  data: Uint8Array,
  secretArray: string[],
  deriveKeyFn: KeyDeriver
): Promise<UnsealResult<T>> {
  let offset = 1

  const flags = data[offset++]
  const isCompressed = (flags & 0x01) !== 0

  // Skip embedded key index (informational only, we try all keys)
  offset++

  // Extract salt
  const salt = data.slice(offset, offset + SALT_LENGTH) as Bytes
  offset += SALT_LENGTH

  // Extract IV
  const iv = data.slice(offset, offset + IV_LENGTH) as Bytes
  offset += IV_LENGTH

  // Extract ciphertext
  const ciphertext = data.slice(offset) as Bytes

  let lastError: Error | null = null

  for (let keyIndex = 0; keyIndex < secretArray.length; keyIndex++) {
    try {
      const password = secretArray[keyIndex]
      const key = await deriveKeyFn(password, salt)

      const plaintext = await crypto.subtle.decrypt(
        { name: ALGORITHM, iv: iv.buffer as ArrayBuffer, tagLength: TAG_LENGTH },
        key,
        ciphertext.buffer as ArrayBuffer
      )

      // Decompress if needed
      const decompressed = await decompress(new Uint8Array(plaintext) as Uint8Array, isCompressed)

      const decoder = new TextDecoder()
      const payload = JSON.parse(decoder.decode(decompressed)) as T

      return { payload, keyIndex }
    } catch (e) {
      lastError = e as Error
      continue
    }
  }

  throw new Error(`Failed to unseal data: ${lastError?.message || 'decryption failed'}`)
}

/**
 * Unseal version 2 format (legacy PBKDF2)
 */
async function unsealV2<T>(data: Uint8Array, secretArray: string[]): Promise<UnsealResult<T>> {
  return unsealV2OrV3<T>(data, secretArray, deriveKeyPBKDF2)
}

/**
 * Unseal version 3 format (HKDF)
 */
async function unsealV3<T>(data: Uint8Array, secretArray: string[]): Promise<UnsealResult<T>> {
  return unsealV2OrV3<T>(data, secretArray, deriveKeyHKDF)
}

/**
 * Unseal version 1 format (legacy compatibility)
 */
async function unsealV1<T>(data: Uint8Array, secretArray: string[]): Promise<UnsealResult<T>> {
  // Skip version byte and legacy key ID (16-bit big endian)
  let offset = 3

  // Extract salt
  const salt = data.slice(offset, offset + SALT_LENGTH) as Bytes
  offset += SALT_LENGTH

  // Extract IV
  const iv = data.slice(offset, offset + IV_LENGTH) as Bytes
  offset += IV_LENGTH

  // Extract ciphertext
  const ciphertext = data.slice(offset) as Bytes

  let lastError: Error | null = null

  for (let keyIndex = 0; keyIndex < secretArray.length; keyIndex++) {
    try {
      const password = secretArray[keyIndex]
      const key = await deriveKeyPBKDF2(password, salt)

      const plaintext = await crypto.subtle.decrypt(
        { name: ALGORITHM, iv: iv.buffer as ArrayBuffer, tagLength: TAG_LENGTH },
        key,
        ciphertext.buffer as ArrayBuffer
      )

      const decoder = new TextDecoder()
      const payload = JSON.parse(decoder.decode(plaintext)) as T

      return { payload, keyIndex }
    } catch (e) {
      lastError = e as Error
      continue
    }
  }

  throw new Error(`Failed to unseal data: ${lastError?.message || 'decryption failed'}`)
}
