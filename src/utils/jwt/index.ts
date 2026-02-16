/**
 * @module
 * JWT utility.
 */

import { clearJwksCache, decode, sign, verify, verifyWithJwks } from './jwt'
export const Jwt = { sign, verify, decode, verifyWithJwks, clearJwksCache }
