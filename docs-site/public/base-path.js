(() => {
  if (globalThis.__pilotDocsBasePathFix) return
  globalThis.__pilotDocsBasePathFix = true

  const prefix = '/docs'

  const patchSkipLink = () => {
    const link = document.querySelector('[data-v-skip-to-content]')
    const href = link?.getAttribute('href')
    if (!href || !href.startsWith('/') || href === prefix || href.startsWith(`${prefix}/`)) return
    link.setAttribute('href', `${prefix}${href}`)
  }

  const start = () => {
    patchSkipLink()
    new MutationObserver(patchSkipLink).observe(document.documentElement, {
      attributeFilter: ['href'],
      attributes: true,
      childList: true,
      subtree: true,
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
