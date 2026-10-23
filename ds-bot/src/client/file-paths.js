export function localFilePath(value) {
  if (typeof value !== 'string') return null
  const path = /^("|').*\1$/s.test(value) ? value.slice(1, -1) : value
  if (!/^[a-z]:[\\/]/i.test(path) || /[<>"|?*\p{Cc};`$={}]/u.test(path) || path.slice(2).includes(':')) return null
  if (path.trim() !== path || /[\\/]\s|\s[\\/]/u.test(path)) return null
  if (/\s[+&]\s|\([^)]*\)\s*\./u.test(path)) return null
  const parts = path.slice(3).split(/[\\/]/)
  if (parts.some(part => part === '' || part === '.' || part === '..' || /[. ]$/.test(part))) return null
  return /\.[\p{L}\d_-]{1,16}$/u.test(parts.at(-1) ?? '') ? path : null
}

