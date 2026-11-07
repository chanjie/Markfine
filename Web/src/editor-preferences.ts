import { StateEffect, StateField } from '@codemirror/state';

export interface EditorPreferences { shortcutHints: boolean; focusMode: boolean; lineNumbers?: boolean }
export const defaultPreferences: EditorPreferences = { shortcutHints: true, focusMode: true };
export type PageTheme = 'paper' | 'kraft' | 'eye';
export interface ApplicationPreferences extends EditorPreferences {
  language: 'system' | 'zh-Hans' | 'en'; locale: 'zh-Hans' | 'en'; timeZone: 'local' | 'UTC';
  fontChinese: string; fontEnglish: string; editTheme: PageTheme; readTheme: PageTheme;
  lineNumbers: boolean; showAllFiles: boolean; outlineSide: 'left' | 'right'; outlineWidth: number; editZoom: number; readZoom: number;
}
export const defaultApplicationPreferences: ApplicationPreferences = {
  ...defaultPreferences, language: 'system', locale: 'zh-Hans', timeZone: 'local',
  fontChinese: 'PingFangSC-Regular', fontEnglish: 'PingFangSC-Regular', editTheme: 'paper', readTheme: 'paper',
  lineNumbers: false, showAllFiles: false, outlineSide: 'left', outlineWidth: 220, editZoom: 1, readZoom: 1
};
export function normalizePreferences(value: unknown, previous = defaultApplicationPreferences): ApplicationPreferences {
  const result = { ...previous };
  if (!value || typeof value !== 'object') return result;
  const input = value as Record<string, unknown>;
  for (const key of ['shortcutHints', 'focusMode', 'lineNumbers', 'showAllFiles'] as const) if (typeof input[key] === 'boolean') result[key] = input[key];
  if (input.outlineSide === 'left' || input.outlineSide === 'right') result.outlineSide = input.outlineSide;
  for (const key of ['editTheme', 'readTheme'] as const) if (['paper', 'kraft', 'eye'].includes(String(input[key]))) result[key] = input[key] as PageTheme;
  if (['system', 'zh-Hans', 'en'].includes(String(input.language))) result.language = input.language as ApplicationPreferences['language'];
  if (['zh-Hans', 'en'].includes(String(input.locale))) result.locale = input.locale as ApplicationPreferences['locale'];
  else if (result.language !== 'system') result.locale = result.language;
  if (input.timeZone === 'local' || input.timeZone === 'UTC') result.timeZone = input.timeZone;
  for (const key of ['fontChinese', 'fontEnglish'] as const) if (typeof input[key] === 'string' && input[key].length <= 128 && !/[\u0000-\u001f]/.test(input[key])) result[key] = input[key] || 'PingFangSC-Regular';
  for (const [key, min, max] of [['outlineWidth', 180, 360], ['editZoom', .5, 2], ['readZoom', .5, 2]] as const) {
    if (typeof input[key] === 'number' && Number.isFinite(input[key])) result[key] = Math.max(min, Math.min(max, input[key]));
  }
  return result;
}
export const preferencesEffect = StateEffect.define<EditorPreferences>();
export const sourceModeEffect = StateEffect.define<boolean>();
export const sourceMode = StateField.define<boolean>({ create: () => false, update: (value, transaction) => {
  for (const effect of transaction.effects) if (effect.is(sourceModeEffect)) value = effect.value;
  return value;
} });
export const editorPreferences = StateField.define<EditorPreferences>({
  create: () => defaultPreferences,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(preferencesEffect)) value = effect.value;
    return value;
  }
});
