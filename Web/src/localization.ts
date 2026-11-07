let language: 'zh-Hans' | 'en' = 'zh-Hans';
export const setLanguage = (value: 'zh-Hans' | 'en') => { language = value; };
export const t = (chinese: string, english: string): string => (typeof document === 'undefined' ? language === 'en' : document.documentElement.lang.startsWith('en')) ? english : chinese;
export function formatTimestamp(timestamp: number, timeZone: 'local' | 'UTC'): string {
  return new Intl.DateTimeFormat(language === 'en' ? 'en-GB' : 'zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZone: timeZone === 'UTC' ? 'UTC' : undefined, timeZoneName: 'short'
  }).format(new Date(timestamp));
}
export function localizePage(): void {
  document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
  for (const element of document.querySelectorAll<HTMLElement>('[data-zh]')) element.textContent = t(element.dataset.zh!, element.dataset.en!);
  for (const element of document.querySelectorAll<HTMLElement>('[data-title-zh]')) element.title = t(element.dataset.titleZh!, element.dataset.titleEn!);
  for (const element of document.querySelectorAll<HTMLElement>('[data-label-zh]')) element.setAttribute('aria-label', t(element.dataset.labelZh!, element.dataset.labelEn!));
  for (const element of document.querySelectorAll<HTMLInputElement>('[data-placeholder-zh]')) element.placeholder = t(element.dataset.placeholderZh!, element.dataset.placeholderEn!);
}
