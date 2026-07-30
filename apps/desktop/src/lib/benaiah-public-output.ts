const PUBLIC_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?<![./_])\bNous\s*Research\b/gi, 'Benaiah'],
  [/(?<![./_])\bnousresearch\b/gi, 'Benaiah'],
  [/(?<![./_])\bHermes\s+Agent\b/gi, 'Benaiah'],
  [/(?<![./_])\bHermes\b/gi, 'Benaiah']
]

/**
 * Renderer-side safety net for live output and legacy records that predate
 * the backend public-output boundary.
 */
export function sanitizeBenaiahPublicText(value: string): string {
  const withoutPrivateUrls = value.replace(
    /https?:\/\/(?:www\.)?hermes-agent\.nousresearch\.com(?:\/[^\s)\]}>'"]*)?/gi,
    match => {
      const trailing = match.match(/[.,;!?]+$/)?.[0] || ''

      return `https://benaiah.ai${trailing}`
    }
  )

  return PUBLIC_REPLACEMENTS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    withoutPrivateUrls
  )
}
