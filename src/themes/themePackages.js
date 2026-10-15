import defaultDark from './default-dark.json'
import defaultLight from './default-light.json'
import { createThemeCatalog } from './themeCatalog.mjs'

export const {
  THEME_FORMAT,
  THEME_SCHEMA_VERSION,
  MAX_THEME_FILE_BYTES,
  MAX_INSTALLED_THEMES,
  BUILTIN_THEMES,
  THEME_TOKEN_NAMES,
  normalizeThemePackage,
  parseThemePackage,
  serializeThemePackage,
  listThemePackages,
  getThemePackage
} = createThemeCatalog(defaultDark, defaultLight)
