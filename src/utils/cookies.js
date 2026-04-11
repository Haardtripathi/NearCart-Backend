function parseCookies(headerValue = '') {
  return headerValue
    .split(';')
    .map((cookie) => cookie.trim())
    .filter(Boolean)
    .reduce((cookies, cookie) => {
      const separatorIndex = cookie.indexOf('=')

      if (separatorIndex === -1) {
        return cookies
      }

      const key = cookie.slice(0, separatorIndex).trim()
      const value = cookie.slice(separatorIndex + 1).trim()

      if (!key) {
        return cookies
      }

      cookies[key] = decodeURIComponent(value)

      return cookies
    }, {})
}

module.exports = {
  parseCookies,
}
