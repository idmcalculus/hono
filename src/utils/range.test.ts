import { parseRange, contentRange } from './range'

describe('parseRange', () => {
  describe('valid ranges', () => {
    it('should parse standard range bytes=0-499', () => {
      const result = parseRange('bytes=0-499', 1000)
      expect(result).toEqual({ start: 0, end: 499 })
    })

    it('should parse standard range bytes=500-999', () => {
      const result = parseRange('bytes=500-999', 1000)
      expect(result).toEqual({ start: 500, end: 999 })
    })

    it('should parse open-ended range bytes=500-', () => {
      const result = parseRange('bytes=500-', 1000)
      expect(result).toEqual({ start: 500, end: 999 })
    })

    it('should parse suffix range bytes=-100', () => {
      const result = parseRange('bytes=-100', 1000)
      expect(result).toEqual({ start: 900, end: 999 })
    })

    it('should parse suffix range larger than file size', () => {
      const result = parseRange('bytes=-2000', 1000)
      expect(result).toEqual({ start: 0, end: 999 })
    })

    it('should clamp end to totalSize - 1', () => {
      const result = parseRange('bytes=0-2000', 1000)
      expect(result).toEqual({ start: 0, end: 999 })
    })

    it('should parse range for small file', () => {
      const result = parseRange('bytes=0-10', 100)
      expect(result).toEqual({ start: 0, end: 10 })
    })

    it('should handle range at end of file', () => {
      const result = parseRange('bytes=990-999', 1000)
      expect(result).toEqual({ start: 990, end: 999 })
    })

    it('should handle single byte range', () => {
      const result = parseRange('bytes=0-0', 1000)
      expect(result).toEqual({ start: 0, end: 0 })
    })
  })

  describe('unsatisfiable ranges (return null)', () => {
    it('should return null for start > end', () => {
      const result = parseRange('bytes=500-100', 1000)
      expect(result).toBeNull()
    })

    it('should return null for suffix of zero bytes', () => {
      const result = parseRange('bytes=-0', 1000)
      expect(result).toBeNull()
    })

    it('should return null for start >= totalSize', () => {
      const result = parseRange('bytes=1000-2000', 1000)
      expect(result).toBeNull()
    })

    it('should return null for start > totalSize', () => {
      const result = parseRange('bytes=2000-3000', 1000)
      expect(result).toBeNull()
    })
  })

  describe('ignored ranges (return undefined per RFC 7233)', () => {
    it('should return undefined for non-bytes range unit', () => {
      const result = parseRange('items=0-499', 1000)
      expect(result).toBeUndefined()
    })

    it('should return undefined for multi-range', () => {
      const result = parseRange('bytes=0-499, 500-999', 1000)
      expect(result).toBeUndefined()
    })

    it('should return undefined for missing dash', () => {
      const result = parseRange('bytes=499', 1000)
      expect(result).toBeUndefined()
    })

    it('should return undefined for non-numeric values', () => {
      const result = parseRange('bytes=abc-def', 1000)
      expect(result).toBeUndefined()
    })

    it('should return undefined for empty range header', () => {
      const result = parseRange('', 1000)
      expect(result).toBeUndefined()
    })

    it('should return undefined for bytes=- (empty range spec)', () => {
      const result = parseRange('bytes=-', 1000)
      expect(result).toBeUndefined()
    })

    it('should return undefined for invalid format bytes=-0-100', () => {
      const result = parseRange('bytes=-0-100', 1000)
      expect(result).toBeUndefined()
    })

    it('should return undefined for bytes=--100', () => {
      const result = parseRange('bytes=--100', 1000)
      expect(result).toBeUndefined()
    })
  })
})

describe('contentRange', () => {
  it('should format Content-Range header correctly', () => {
    expect(contentRange(0, 499, 1000)).toBe('bytes 0-499/1000')
  })

  it('should format Content-Range for partial content', () => {
    expect(contentRange(500, 999, 1000)).toBe('bytes 500-999/1000')
  })

  it('should format Content-Range for single byte', () => {
    expect(contentRange(0, 0, 100)).toBe('bytes 0-0/100')
  })

  it('should format Content-Range for full content', () => {
    expect(contentRange(0, 999, 1000)).toBe('bytes 0-999/1000')
  })
})
