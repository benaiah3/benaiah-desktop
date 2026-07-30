import { describe, expect, it } from 'vitest'

import { sanitizeBenaiahPublicText } from './benaiah-public-output'

describe('sanitizeBenaiahPublicText', () => {
  it('keeps the full answer while translating private runtime identity', () => {
    expect(
      sanitizeBenaiahPublicText(
        "GM. I'm Hermes Agent from Nous Research. See https://hermes-agent.nousresearch.com/docs."
      )
    ).toBe("GM. I'm Benaiah from Benaiah. See https://benaiah.ai.")
  })

  it('does not corrupt local media paths', () => {
    const path = '/Users/person/.hermes/cache/audio/reply.mp3'

    expect(sanitizeBenaiahPublicText(path)).toBe(path)
  })
})
