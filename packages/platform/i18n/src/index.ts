export { AppError } from './app-error';
export { checkParity, findLocalesDir, loadCatalog } from './catalog';
export type { Catalog } from './catalog';
export { I18nModule } from './i18n.module';
export { I18nService } from './i18n.service';
export type { I18nOptions, MessageParams } from './i18n.service';
export {
  CLS_LOCALE_KEY,
  CurrentLocale,
  LOCALE_HEADER,
  LOCALE_PREFERENCE_PROVIDER,
  LOCALE_QUERY_PARAM,
  LocaleResolver,
  pickFromAcceptLanguage,
} from './locale-resolver';
export type { LocalePreferenceProvider } from './locale-resolver';
