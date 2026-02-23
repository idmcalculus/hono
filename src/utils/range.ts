/**
 * @module
 * HTTP Range request utilities.
 */

/**
 * Represents a parsed byte range.
 */
export type ByteRange = {
  start: number
  end: number
}

/**
 * Result of parsing a Range header.
 * - ByteRange: Valid, satisfiable range
 * - null: Syntactically valid bytes range but unsatisfiable (416 response)
 * - undefined: Not a bytes range or multi-range (ignore, serve full content)
 */
export type ParseRangeResult = ByteRange | null | undefined

// Matches: bytes=<start>-<end>, bytes=<start>-, bytes=-<suffix>
const RANGE_SPEC_REGEX = /^bytes=(\d*)-(\d*)$/

/**
 * Parses an HTTP Range header for a single byte range.
 *
 * @param rangeHeader - The value of the Range header (e.g., "bytes=0-499")
 * @param totalSize - The total size of the resource in bytes
 * @returns A ByteRange object if valid, null if unsatisfiable, undefined if not applicable
 *
 * @example
 * ```ts
 * // Standard range: bytes 0-499
 * parseRange('bytes=0-499', 1000) // { start: 0, end: 499 }
 *
 * // Suffix range: last 100 bytes
 * parseRange('bytes=-100', 1000) // { start: 900, end: 999 }
 *
 * // Open-ended range: from byte 500 to end
 * parseRange('bytes=500-', 1000) // { start: 500, end: 999 }
 *
 * // Unsatisfiable range
 * parseRange('bytes=1000-2000', 500) // null
 *
 * // Non-bytes or multi-range (ignore per RFC 7233)
 * parseRange('items=0-5', 1000) // undefined
 * parseRange('bytes=0-5, 10-15', 1000) // undefined
 * ```
 */
export const parseRange = (rangeHeader: string, totalSize: number): ParseRangeResult => {
  const match = RANGE_SPEC_REGEX.exec(rangeHeader)
  if (!match) {
    // Not a valid single bytes range - ignore per RFC 7233
    return undefined
  }

  const [, startStr, endStr] = match
  let start: number
  let end: number

  if (startStr === '' && endStr === '') {
    // bytes=- is invalid
    return undefined
  } else if (startStr === '') {
    // Suffix range: bytes=-N (last N bytes)
    const suffixLength = parseInt(endStr, 10)
    if (suffixLength === 0) {
      return null
    }
    start = Math.max(0, totalSize - suffixLength)
    end = totalSize - 1
  } else if (endStr === '') {
    // Open-ended range: bytes=N- (from N to end)
    start = parseInt(startStr, 10)
    end = totalSize - 1
  } else {
    // Standard range: bytes=N-M
    start = parseInt(startStr, 10)
    end = parseInt(endStr, 10)
    if (end < start) {
      return null
    }
    // Clamp end to totalSize - 1
    end = Math.min(end, totalSize - 1)
  }

  // Check if range is satisfiable
  if (start >= totalSize) {
    return null
  }

  return { start, end }
}

/**
 * Creates a Content-Range header value.
 *
 * @param start - The start byte position
 * @param end - The end byte position (inclusive)
 * @param totalSize - The total size of the resource
 * @returns The Content-Range header value (e.g., "bytes 0-499/1000")
 */
export const contentRange = (start: number, end: number, totalSize: number): string => {
  return `bytes ${start}-${end}/${totalSize}`
}
