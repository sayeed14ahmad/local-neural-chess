import { describe, it, expect } from 'vitest'
import { SCHEMA_VERSION, STORAGE_KEY } from '../utils/gameStorage.js'

describe('test runner smoke check', () => {
  it('loads gameStorage constants', () => {
    expect(STORAGE_KEY).toBe('maia_chess_saved_game_v1')
    expect(SCHEMA_VERSION).toBe(1)
  })
})
