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
  ['安装与更新', 'Installation and updates',
    '通用安装包同时包含 Intel 和 Apple Silicon 版本，系统兼容信息见随包的 RELEASE.md。将 Markfine.app 拖入“应用程序”后打开。更新前请保存文档并退出应用，再替换应用文件。',
    'The universal package includes Intel and Apple Silicon versions. See the accompanying RELEASE.md for macOS compatibility. Drag Markfine.app to Applications and open it. Before updating, save your documents and quit Markfine, then replace the application.'],
  ['文档与保存', 'Documents and saving',
    '⌘N 新建Markdown文档，⌘O 打开文件或文件夹，⌘S 保存。已有文件保留原编码、BOM、换行和文件权限；新文档首次保存时选择名称和位置。标签上的圆点表示有未保存的修改；关闭时可选择保存、不保存或取消。',
    'Use ⌘N to create a Markdown document, ⌘O to open a file or folder, and ⌘S to save. Existing files retain their encoding, BOM, line endings and permissions. Choose a name and location for a new document. A dot on the tab marks unsaved changes. When closing, choose Save, Don’t Save, or Cancel.'],
  ['排版编辑', 'Live editing',
    '标题、列表、链接和表格按相应样式显示，可直接修改文字。行首输入1–6个#并加空格创建标题；编辑标记时显示淡色前缀。手写Markdown保留输入的换行，格式命令会按需补入分隔。普通空行输入 / 打开格式清单，上下键选择、Return 插入、Esc 关闭，插入后可直接填写。正文Tab插入缩进，列表Tab／⇧Tab调整当前项层级。成对标点默认补齐，Markdown反引号按实际输入保留。⌘Z 可撤销修改。',
    'Edit headings, lists, links and tables in their formatted layout. Start a line with 1–6 # characters and a space for a heading; a faint prefix appears while editing its markers. Manually typed Markdown retains your line breaks; format commands may add separators as needed. On an empty line, type / for formats, use Up or Down to select, Return to insert, and Esc to close, then continue typing. Tab inserts indentation in prose; Tab or ⇧Tab changes a list item’s level. Paired punctuation is completed automatically; Markdown backticks retain the characters you type. Use ⌘Z to undo.'],
  ['有序列表', 'Numbered lists',
    '插入或删除列表项后，后续同级编号自动调整，保留该组起始编号。仅隔空行时，通过 / 插入有序列表会接续前一列表。右键点击序号，可将当前整组从1重新编号，或接续前一组同级有序列表。编号修改可撤销和重做。',
    'Inserting or deleting an item updates later numbers at the same level and preserves the list’s starting number. Across blank lines, inserting a numbered list with / continues the preceding list. Right-click a number to restart the whole current list at 1 or continue the preceding list at the same level. Numbering changes can be undone and redone.'],
  ['复制与章节操作', 'Copying and section actions',
    '正文中按 ⌘C 复制选中文字；没有选区时复制整个段落，光标和滚动位置保持不变。成功后短暂显示“已复制”，无选区复制的可见文字会短暂高亮后淡出。Markdown段落可带格式粘贴回 Markfine 或 Word 等应用。目录标题右键可复制、剪切或删除整章，包含全部子章节；剪切与删除可撤销。',
    'Press ⌘C to copy selected text, or the whole paragraph when there is no selection, keeping the caret and scroll position. A brief Copied message confirms success; copied text without a selection is briefly highlighted, then fades out. Paste Markdown paragraphs with formatting in Markfine or Word. Right-click an outline heading to copy, cut or delete its section and all subsections. Cuts and deletions can be undone.'],
  ['表格选择', 'Table selection',
    '插入表格后从首个表头填写，Tab／⇧Tab切换单元格。逐行输入表格语法，语法成立时即显示网格，可继续填写。单元格支持行内格式，块级格式在表格外设置。无文字选区时，⌘C复制当前单元格文字；源码模式无选区时复制整表。跨单元格拖动或Shift点击可选择矩形区域，右键可复制整表Markdown。',
    'A new table starts in its first header cell. Use Tab or ⇧Tab to move between cells. Typed table syntax appears as an editable grid as soon as it becomes valid. Cells support inline formatting; apply block formats outside the table. With no selection, ⌘C copies the current cell text; in source mode it copies the whole table. Drag across cells or Shift-click to select a rectangle, or copy the whole table Markdown from its context menu.'],
  ['纯文本与代码', 'Plain text and code',
    '纯文本和代码文件提供原文编辑与只读查看，常见语言离线高亮。HTML、SVG及脚本均只显示原文，不预览网页、不执行代码或加载引用资源。支持UTF-8及带BOM的UTF-16/32，文件上限16MiB；无法无损识别编码时保留原文件。纯文本仅粘贴文本。',
    'Edit plain text and code or view the original text read-only, with offline highlighting for common languages. HTML, SVG and scripts remain source text: no web preview, code execution or referenced resources. UTF-8 and BOM-marked UTF-16/32 are supported, up to 16 MiB. Unrecognized encodings leave the file unchanged. Plain text files paste text only.'],
  ['最近打开', 'Recent locations',
    '点击主页返回欢迎页，不关闭文档或文件夹。最近记录可单条或批量移除，清空也包括隐藏记录，不删除文件。首选项可设置合计0–1000条，默认20；调低时移除最旧的超额记录，设为0停止新增。文件夹导航打开的文件默认隐藏，可在最近记录或首选项调整显示。',
    'Click Home to return to the welcome page without closing documents or the folder. Remove recent locations individually or in batches; clearing also removes hidden records, not files. Set the combined limit to 0–1000 in Preferences, default 20. Lowering it removes the oldest excess records; 0 stops recording. Folder-navigation files are hidden by default and can be shown in recent locations or Preferences.'],
  ['源码模式', 'Source mode',
    '点击“源码”、选择“显示 → 源码模式”或按 ⌘/，查看和编辑完整 Markdown 语法。适合检查标记、修改链接地址或调整表格源码。再次切换返回排版编辑，正文、选区和撤销历史保持连续。',
    'Click Source, choose View → Source Mode, or press ⌘/ to view and edit the full Markdown syntax. Use it to check markers, change link destinations or edit table source. Toggle again to return to live editing with the same text, selection and undo history.'],
  ['专注模式', 'Focus mode',
    '专注模式突出当前编辑的内容，并淡化周围内容。普通正文按实际换行分隔，自动折行仍属于同一段；列表突出当前项，代码块与表格保持整体清晰。默认开启，适用于排版编辑和源码模式。通过“显示 → 专注模式”或首选项调整，关闭后全部内容恢复清晰。',
    'Focus mode highlights the content you are editing and dims its surroundings. Explicit newlines separate prose focus areas; wrapped text stays together. Lists focus on the current item, while code blocks and tables stay together. It is enabled by default in live editing and source mode. Change it through View → Focus Mode or Preferences. Turn it off to display all content clearly.'],
  ['阅读模式', 'Reading mode',
    '点击“阅读”或按 ⇧⌘R，以只读方式浏览当前内容。普通段落之间与段内换行使用相同行距。<!-- … --> 注释在编辑时保留，阅读和输出时隐藏；代码中的注释示例正常显示。鼠标移到顶部可显示标签栏；点击目录标题或使用方向键浏览。点击“返回编辑”、文档标题或按 Esc／⇧⌘R 返回编辑。查找打开时，Esc 先关闭查找。',
    'Click Read or press ⇧⌘R to browse the current content read-only. Ordinary paragraphs use the same line spacing as wrapped text. <!-- … --> comments remain editable but are hidden in reading and output; code examples stay visible. Move the pointer to the top to show tabs, and navigate with the outline or arrow keys. Click Back to editing, click the document title, or press Esc or ⇧⌘R to return. When Find is open, Esc closes it first.'],
  ['文档与章节导航', 'Document and section navigation',
    '按住 ⌘ 单击链接可打开目标。本地 Markdown 在应用内打开，章节链接定位标题，网址由默认浏览器打开。文件导航中单击可临时预览，双击文件名或标签名可固定标签。活动或悬停标签的文字过长时横向滚动，文件名端停留约3秒；关闭按钮固定，减少动态效果时静态显示文件名端。',
    'Hold ⌘ and click a link to open it. Local Markdown opens in Markfine, section links locate headings, and web links open in your default browser. Single-click a file to preview it, or double-click its name or tab to keep it open. Overflowing active or hovered tab text scrolls horizontally and pauses at the filename for about 3 seconds. Close buttons stay fixed; reduced motion shows the filename end without animation.'],
  ['外观设置', 'Appearance settings',
    '按 ⌘, 打开首选项，设置界面语言、字体、外观、行号和专注模式。编辑与阅读可分别设置纸张、行距和缩放。欢迎页共用同一纸面，纸质和牛皮纸背景延伸至原生标题栏，深色和护眼不显示纸纹。窗口标题栏的拖动和双击遵循macOS设置。行距提供紧凑、默认、宽松及自定义选项。拖动侧栏靠近正文的边缘可调整宽度。',
    'Press ⌘, to open Preferences and set language, fonts, appearance, line numbers and focus mode. Editing and reading have separate paper, line spacing and zoom settings. The welcome page shares the same paper; paper and kraft textures extend to the native title bar. Dark and soft-green themes have no texture. Title-bar dragging and double-click follow macOS settings. Choose Compact, Default, Relaxed or custom spacing. Drag a sidebar’s inner edge to resize it.'],
  ['图片显示比例', 'Image display size',
    '⌘V 可粘贴图片或从访达复制的单个 PNG、JPEG、TIFF 图片文件。小图默认按原始尺寸显示，大图自动缩小到正文可用宽度。右键图片或点击图片上的比例按钮，可选择相对原图的比例或自定义，显示宽度始终不超过正文宽度。手动尺寸以 Obsidian 图片宽度写法保存，选择“自动适应正文”恢复自动显示。',
    'Paste an image or a single PNG, JPEG or TIFF file copied in Finder with ⌘V. Small images retain their original size; larger images fit the available text width. Right-click an image or use its size button to choose a percentage of the original or a custom value, within the available width. Manual widths are saved using Obsidian image syntax. Choose Automatic fit to restore automatic sizing.'],
  ['图片存储', 'Image storage',
    '首选项的“图片与存储”分组可选择本地或 S3。本地图片保存在同级 <文档名>.assets 文件夹，移动文档时请一并移动。S3 配置保存后用于新粘贴的图片；凭据存入系统钥匙串，读取方式可选凭据读取或公开链接。上传中可取消；上传失败后可重试、改为本地或取消。',
    'Choose Local or S3 in Images & Storage preferences. Local images are stored in a sibling <document-name>.assets folder; move it with the document. Saved S3 settings apply to new pasted images. Credentials are stored in Keychain, with credential-based or public-link image access. Cancel during upload; after an upload fails, retry, use local storage, or cancel.'],
  ['导出与打印', 'Export and printing',
    '通过“文件 → 导出…”或 ⇧⌘E 导出 PDF／Word。默认使用首选项的阅读行间距和中英文字体；成功导出后，PDF 和 Word 分别记住调整过的排版。可在导出面板恢复跟随首选项。PDF 包含可跳转的标题书签，Word 保留标题导航层级；单独一行的图片居中且不缩进。⌘P 打开打印面板。点击导出成功的系统通知可在 Finder 显示文件。',
    'Choose File → Export or press ⇧⌘E to export PDF or Word. Defaults use the reading spacing and Chinese / English fonts from Preferences. PDF and Word remember adjusted layouts separately after a successful export; use Follow Preferences in the export panel to restore the defaults. PDF has navigable heading bookmarks; Word retains heading levels. Images on their own line are centered without indentation. Press ⌘P to print. Click a successful export notification to reveal the file in Finder.'],
  ['Finder 快速查看', 'Finder Quick Look',
    '在 Finder 选中 Markdown 文件并按空格，可通过 Markfine 扩展查看离线排版。Mermaid 显示源码；系统不允许读取的本地图片显示占位，远程图片不会自动加载。macOS 选择可用扩展，必要时可在系统设置中检查快速查看扩展。',
    'Select a Markdown file in Finder and press Space to view its offline formatting with the Markfine extension. Mermaid appears as source; local images unavailable to the system show placeholders, and remote images are not loaded automatically. macOS chooses the extension; check Quick Look extensions in System Settings if needed.'],
  ['隐私与日志', 'Privacy and logs',
    '文档编辑、图表和导出在本机处理。配置 S3 后，图片传输使用指定的存储服务。错误日志仅记录本机运行事件及错误类型。Markfine 菜单中的“缓存清理…”可查看并清理应用运行数据，S3 凭据可在图片与存储设置中单独删除。',
    'Editing, diagrams and export are processed locally. After S3 is configured, image transfers use the specified storage service. Error logs contain only local runtime events and error types. Use Clear App Data in the Markfine menu to review and remove runtime data, and remove S3 credentials separately in Images & Storage.']
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
