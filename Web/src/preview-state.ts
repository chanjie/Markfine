export interface PreviewCandidate {
  preview: boolean; imageLocked: boolean; closeLocked: boolean;
  saves: { dirty: boolean; pending: unknown };
}
/** Re-check at receipt time: typing, IME or an asynchronous operation may have begun after the click. */
export function replaceablePreview(item: PreviewCandidate | undefined, composing = false): boolean {
  return !!item && item.preview && !composing && !item.saves.dirty && !item.saves.pending && !item.imageLocked && !item.closeLocked;
}
