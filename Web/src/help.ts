import { t } from './localization';

export function showHelp(dialog: HTMLDialogElement): void {
  dialog.replaceChildren();
  const title = document.createElement('h2'); title.textContent = t('快捷键说明', 'Keyboard shortcuts');
  const table = document.createElement('table');
  const rows: [string, string, string][] = [
    ['新建文档／标签', 'New document / tab', '⌘N / ⌘T'], ['打开／保存', 'Open / Save', '⌘O / ⌘S'],
    ['关闭标签；无标签时退出', 'Close tab; quit when no tabs remain', '⌘W'], ['关闭窗口／退出', 'Close window / Quit', '⇧⌘W / ⌘Q'],
    ['首选项', 'Preferences', '⌘,'], ['阅读／编辑模式', 'Reading / Editing mode', '⇧⌘R · Esc'], ['显示／隐藏目录', 'Show / Hide outline', '⇧⌘L'],
    ['源码／排版编辑', 'Source / Live editing', '⌘/'],
    ['显示／隐藏行号', 'Show / Hide line numbers', '⇧⌘N'], ['放大／缩小内容', 'Zoom in / out', '⌘+ / ⌘−'], ['恢复100%缩放', 'Reset zoom to 100%', '⌥⌘0'],
    ['鼠标／触控板缩放', 'Mouse / Trackpad zoom', t('⌘滚轮 · 双指捏合', '⌘wheel · Pinch')],
    ['下一／上一标签', 'Next / Previous tab', '⌃Tab / ⇧⌃Tab'], ['撤销／重做', 'Undo / Redo', '⌘Z / ⇧⌘Z'],
    ['剪切／复制／粘贴／全选', 'Cut / Copy / Paste / Select all', '⌘X / ⌘C / ⌘V / ⌘A'], ['查找／替换', 'Find / Replace', '⌘F / ⌥⌘F'],
    ['下一个／上一个匹配', 'Next / Previous match', '⌘G / ⇧⌘G'], ['标题1–6／普通段落', 'Heading 1–6 / Paragraph', '⌘1–6 / ⌘0'],
    ['加粗／斜体', 'Bold / Italic', '⌘B / ⌘I'], ['链接／打开链接', 'Link / Open link', t('⌘K / ⌘单击', '⌘K / ⌘click')],
    ['行内代码／代码块', 'Inline code / Code block', '⌥⌘K / ⌥⌘C'], ['删除线', 'Strikethrough', '⌃⇧`'],
    ['引用／图片引用', 'Quote / Image', '⌥⌘Q / ⌃⌘I'], ['有序／无序列表', 'Ordered / Unordered list', '⌥⌘O / ⌥⌘U'],
    ['任务列表／表格', 'Task list / Table', '⌥⌘X / ⌥⌘T'], ['增加／减少缩进', 'Indent / Outdent', '⌘] / ⌘['],
    ['表格下个／上个单元格', 'Next / Previous table cell', 'Tab / ⇧Tab'], ['表格边界进入／离开', 'Enter / Leave table at boundaries', '↑ ↓ ← →'], ['表格下一行／返回正文', 'Next table row / Leave table', 'Return / Esc'],
    ['阅读：按内容滚动', 'Reading: content-aware scrolling', '↑ / ↓'], ['阅读：横向／翻页', 'Reading: horizontal / page scrolling', '← / →'],
    ['阅读：翻页／首尾', 'Reading: page / beginning & end', 'Page Up/Down · Home/End']
  ];
  for (const [zh, en, key] of rows) { const row = table.insertRow(); row.insertCell().textContent = t(zh, en); row.insertCell().textContent = key; }
  const close = document.createElement('button'); close.className = 'primary'; close.textContent = t('完成', 'Done'); close.onclick = () => dialog.close();
  dialog.append(title, table, close); if (!dialog.open) dialog.showModal();
}
