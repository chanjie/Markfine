import { t } from './localization';

type Shortcut = [string, string, string];
export const shortcutGroups: { zh: string; en: string; rows: Shortcut[] }[] = [
  { zh: '文件', en: 'File', rows: [
    ['新建文档／标签', 'New document / tab', '⌘N / ⌘T'], ['打开／保存', 'Open / Save', '⌘O / ⌘S'],
    ['导出 PDF／Word', 'Export PDF / Word', '⇧⌘E'], ['打印', 'Print', '⌘P'],
    ['关闭标签；无标签时退出', 'Close tab; quit when no tabs remain', '⌘W'], ['关闭窗口／退出', 'Close window / Quit', '⇧⌘W / ⌘Q']
  ] },
  { zh: '编辑', en: 'Edit', rows: [
    ['撤销／重做', 'Undo / Redo', '⌘Z / ⇧⌘Z'], ['剪切／复制／粘贴／全选', 'Cut / Copy / Paste / Select all', '⌘X / ⌘C / ⌘V / ⌘A'],
    ['删除整行／整段', 'Delete line / paragraph', '⇧⌘K / ⌥⇧⌘K'], ['查找（点击切换替换）', 'Find (click to switch to Replace)', '⌘F'],
    ['下一个／上一个匹配', 'Next / Previous match', '⌘G / ⇧⌘G']
  ] },
  { zh: '格式', en: 'Format', rows: [
    ['标题1–6／普通段落', 'Heading 1–6 / Paragraph', '⌘1–6 / ⌘0'], ['加粗／斜体', 'Bold / Italic', '⌘B / ⌘I'],
    ['链接／打开链接', 'Link / Open link', '@openLink'], ['行内代码／代码块', 'Inline code / Code block', '⌥⌘K / ⌥⌘C'],
    ['删除线', 'Strikethrough', '⌃⇧`'], ['引用／图片引用', 'Quote / Image', '⌥⌘Q / ⌃⌘I'],
    ['有序／无序列表', 'Ordered / Unordered list', '⌥⌘O / ⌥⌘U'], ['任务列表／表格', 'Task list / Table', '⌥⌘X / ⌥⌘T'],
    ['增加／减少缩进', 'Indent / Outdent', '⌘] / ⌘['], ['表格下个／上个单元格', 'Next / Previous table cell', 'Tab / ⇧Tab'],
    ['表格边界进入／离开', 'Enter / Leave table at boundaries', '↑ ↓ ← →'], ['表格下一行／返回正文', 'Next table row / Leave table', 'Return / Esc']
  ] },
  { zh: '显示', en: 'View', rows: [
    ['阅读／编辑模式', 'Reading / Editing mode', '⇧⌘R · Esc'], ['源码／排版编辑', 'Source / Live editing', '⌘/'],
    ['显示／隐藏目录', 'Show / Hide outline', '⇧⌘L'], ['显示／隐藏行号', 'Show / Hide line numbers', '⇧⌘N'],
    ['放大／缩小内容', 'Zoom in / out', '⌘+ / ⌘−'], ['恢复100%缩放', 'Reset zoom to 100%', '⌥⌘0'],
    ['鼠标／触控板缩放', 'Mouse / Trackpad zoom', '@gestures']
  ] },
  { zh: '窗口与应用', en: 'Window & Application', rows: [
    ['下一／上一标签', 'Next / Previous tab', '⌃Tab / ⇧⌃Tab'], ['首选项', 'Preferences', '⌘,'],
    ['最小化／隐藏应用', 'Minimize / Hide application', '⌘M / ⌘H']
  ] },
  { zh: '阅读导航', en: 'Reading navigation', rows: [
    ['按内容滚动', 'Content-aware scrolling', '↑ / ↓'], ['横向／翻页', 'Horizontal / Page scrolling', '← / →'],
    ['翻页／首尾', 'Page / Beginning & end', 'Page Up/Down · Home/End']
  ] }
];
const guide = [
  ['排版编辑：让内容保持可读', 'Live editing: keep your words readable',
    '日常写作使用排版编辑。标题、列表、链接和表格直接保留排版；正文始终是标准 Markdown。修改不会另存一份专有格式，保存仍使用 ⌘S。',
    'Use live editing for everyday writing. Headings, lists, links and tables retain their layout. The document is still standard Markdown, not a second proprietary copy. Save explicitly with ⌘S.'],
  ['源码模式：看清并掌控语法', 'Source mode: inspect and control the syntax',
    '通过“显示 → 源码模式”、页面“源码”按钮或 ⌘/ 切换，查看和编辑全部 Markdown 标记。适合排查语法、精确调整链接或表格源码；再次切换返回排版编辑。两种模式共享正文、选区和撤销历史。',
    'Choose View → Source Mode, the Source button, or ⌘/ to edit every Markdown marker. Use it to diagnose syntax or adjust links and table source precisely. Toggle again to return. Both modes share text, selection and undo history.'],
  ['专注模式：一次关注一个段落', 'Focus mode: one paragraph at a time',
    '专注模式不是另一份文档，而是排版编辑与源码共用的显示开关。当前语义段落保持清晰，其余内容淡化，减少干扰。默认开启，可在“显示 → 专注模式”或首选项关闭；不改动正文。',
    'Focus is a shared display option for live editing and source mode, not another document. The active semantic paragraph stays clear while surrounding content fades. It is on by default. Toggle View → Focus Mode or Preferences without changing the text.'],
  ['阅读模式：只读地理解全文', 'Reading mode: read the whole document',
    '通过“阅读”按钮或 ⇧⌘R 进入。阅读使用当前正文完整渲染，不必先保存，但无法修改内容。标签栏在顶部悬停时浮出；目录单击跳转，方向键平滑浏览。点击“返回编辑”、文档标题或按 Esc／⇧⌘R 返回；查找打开时 Esc 优先关闭查找。',
    'Use Read or ⇧⌘R. Reading renders your current text without requiring a save and does not allow edits. Hover at the top for tabs; use the outline or arrow keys to navigate. Back to editing, the title, Esc or ⇧⌘R returns. Esc closes Find first when it is open.'],
  ['外观、行距与文件导航', 'Appearance, spacing and navigation',
    '首选项中的编辑／阅读行距分别对所有文档生效。紧凑为原有效果，默认为其 1.3 倍，宽松为 1.5 倍，也可自定义；导出继承当前模式，可单次覆盖。外观默认跟随系统，深色不显示纸纹。侧栏边缘可拖动；进入文件导航显示修改时间，离开约 3 秒隐藏。',
    'Editing and reading spacing preferences apply to all documents independently. Compact preserves the original; Default is 1.3× and Relaxed is 1.5×, with custom values available. Export inherits the current mode and allows a one-time override. Appearance follows the system; dark mode disables paper textures. Drag sidebar edges; hover over files to show modification times, hidden about 3 seconds after leaving.'],
  ['删除、隐私与诊断', 'Deletion, privacy and diagnostics',
    '⇧⌘K 删除整条源逻辑行，⌥⇧⌘K 删除当前语义段落，均可撤销。整段删除不会删除代码块或整表，表格内只清空当前单元格。软件离线工作，不自动请求外部接口；只有主动 ⌘ 单击外链才交给系统浏览器。错误日志仅保存在本机，不记录正文、路径、链接或凭证，可通过“缓存清理…”删除。',
    '⇧⌘K deletes a source logical line; ⌥⇧⌘K deletes the current semantic paragraph. Both are undoable. Paragraph deletion does not remove a code block or whole table; inside a table only the current cell is cleared. The app works offline without automatic external requests. Only your explicit ⌘-click hands a web link to the system browser. Diagnostic logs stay local, omit text, paths, URLs and credentials, and can be removed with Clear App Data.']
];

export function showHelp(dialog: HTMLDialogElement, userGuide = false): void {
  dialog.replaceChildren(); dialog.setAttribute('aria-label', userGuide ? t('Markfine 帮助', 'Markfine Help') : t('快捷键说明', 'Keyboard shortcuts'));
  const header = document.createElement('header'); header.className = 'help-header';
  const title = document.createElement('h2'); title.textContent = userGuide ? t('Markfine 帮助', 'Markfine Help') : t('快捷键说明', 'Keyboard shortcuts'); title.tabIndex = -1; title.autofocus = true;
  const close = document.createElement('button'); close.textContent = t('完成', 'Done'); close.onclick = () => dialog.close(); header.append(title, close); dialog.append(header);
  if (userGuide) for (const [zh, en, textZH, textEN] of guide) {
    const section = document.createElement('section'), heading = document.createElement('h3'), text = document.createElement('p');
    heading.textContent = t(zh, en); text.textContent = t(textZH, textEN); section.append(heading, text); dialog.append(section);
  } else {
    const legend = document.createElement('p'); legend.textContent = '⌘ Command · ⌥ Option · ⇧ Shift · ⌃ Control'; dialog.append(legend);
    for (const group of shortcutGroups) {
      const heading = document.createElement('h3'); heading.textContent = t(group.zh, group.en); const table = document.createElement('table');
      for (const [zh, en, key] of group.rows) { const row = table.insertRow(); row.insertCell().textContent = t(zh, en); row.insertCell().textContent = key === '@openLink' ? t('⌘K / ⌘单击', '⌘K / ⌘click') : key === '@gestures' ? t('⌘滚轮 · 双指捏合', '⌘wheel · Pinch') : key; }
      dialog.append(heading, table);
    }
  }
  if (!dialog.open) dialog.showModal(); title.focus({ preventScroll: true }); dialog.scrollTop = 0;
}
