/** A short entrance for a linked document, independent of chapter scrolling. */
export class DocumentTransition {
  private generation = 0;
  private timer = 0;
  private animations: Animation[] = [];

  constructor(private readonly content: HTMLElement, private readonly title: HTMLElement) {}

  cancel(): void {
    this.generation++;
    clearTimeout(this.timer); this.timer = 0;
    for (const animation of this.animations) animation.cancel();
    this.animations = [];
    this.content.style.removeProperty('opacity');
  }

  begin(): () => void {
    this.cancel();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};
    const generation = this.generation;
    let revealed = false;
    // Hide the initial viewport until the editor has measured the target chapter.
    // Only opacity changes: layout and the editor's own scroll measurements stay intact.
    this.content.style.opacity = '0';
    const reveal = () => {
      if (revealed || this.generation !== generation) return;
      revealed = true; clearTimeout(this.timer); this.timer = 0;
      this.content.style.removeProperty('opacity');
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      this.animations = [
        this.content.animate([{ opacity: 0, transform: 'translateX(14px)' }, { opacity: 1, transform: 'none' }],
          { duration: 200, easing: 'cubic-bezier(.16,1,.3,1)' }),
        this.title.animate([{ opacity: .35 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' })
      ];
      // WebKit may suspend the animation clock as well as requestAnimationFrame.
      this.timer = window.setTimeout(() => { if (this.generation === generation) this.cancel(); }, 240);
    };
    // A background WebView may defer measurement/animation frames; never leave a page hidden.
    this.timer = window.setTimeout(reveal, 180);
    return reveal;
  }
}
