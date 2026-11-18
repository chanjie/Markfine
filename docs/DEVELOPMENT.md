# Markfine 公共开发说明

本文件面向接手需求的开发者，记录公共工程约束，不规定个人使用的编辑器、AI、测试工具或工作习惯。

## 1. 环境和构建

- macOS 构建环境；Swift tools ≥6.0，Node.js 24，npm 11，Python 3.9+。现有 Apple Silicon／Command Line Tools 环境用于交叉编译 arm64 与 x86_64，不强制安装完整 Xcode。
- 当前实机基线为 macOS 26.7.2 / Swift 6.4 / SDK 27。`Package.swift` 的 macOS 13 是编译部署目标，不是兼容承诺；Web 目标为 Safari 26。
- 应用运行只依赖系统 AppKit/WebKit 等框架与包内资源，不要求用户安装 Node/Python/Swift。

在仓库根目录：

```sh
python3 Scripts/build.py install       # 按锁文件安装构建依赖，禁用 lifecycle scripts
python3 Scripts/build.py               # 默认 Release Universal .app、ad-hoc 签名、ZIP 和 SHA-256
python3 Scripts/build.py --configuration debug
```

构建不会启动或安装应用，不会改默认文件关联。Swift scratch/cache 和 Web 输出位于 `Build/Product/`，包位于 `Dist/<版本-构建-输入摘要>/<本次构建>/`；历史输出不覆盖。`BUILD.json` 只记录构建/架构/资源/签名事实，不表示功能或性能验收通过。

主程序分别在 `Build/Product/Swift/arm64` 与 `x86_64` 编译；Quick Look 扩展使用 Command Line Tools 的 `swiftc` 和系统扩展入口分别编译两种架构，再各自由 `lipo` 合成通用可执行文件。Web 资源只构建一次。扩展先独立以沙盒权限签名，再签名主程序；构建检查两种架构的系统运行时依赖、签名、扩展元数据及解压后的资源一致性。`BUILD.json` 中 `architecture` 为 `universal`，`architectures` 为 `arm64`／`x86_64`。可用已有 Rosetta 做独立的 Intel 转译检查，报告单独列出 Intel 真机与其他系统版本的验证状态。

每批需求完成验证后，将选定的最终 Release 包整理为易找的交付入口（中途构建不自动发布）：

```sh
python3 Scripts/release.py Dist/<最终构建目录>/<本次构建> --notes <本批变更说明.md>
```

该步骤复制并核对已签名应用到 `release/<版本号>/Markfine.app`，不重新构建、不安装、不启动。`release/CHANGELOG.md` 持续保留历次变更，新交付追加在顶部；每版另有 `RELEASE.md` 和构建元数据。重复执行同一交付不重复日志，同版本不同内容拒绝覆盖，需递增版本。`release/` 已由 `.gitignore` 排除，不提交 Git；`Dist/` 仍是历史构建归档，不要求用户从中寻找安装包。

交付验证须区分源码／插桩回归与最终包验证：后者明确指定 `.app` 路径、版本及输入摘要，核对包内资源并可用独立无窗口 WebKit host 检查排版／DOM 交互和渲染快照，不修改已交付应用或给产品增加测试模式。无窗口 host 不激活应用、不请求系统键鼠或剪贴板，不伪造原生焦点来获得“通过”。原生菜单、输入法、系统面板和依赖原生焦点的精确输入必须单独标注验证范围，不能由 DOM 或快照测试推导已验收。

只做 Web 静态检查可执行 `npm --prefix Web run check`。直接 `swift build` 能编译原生模块，但不会生成完整 Web 资源或 `.app`；运行应用应使用打包结果，不直接运行裸二进制。

版本元数据在 `Config/Build.json`：`version` 为三段版本号，`build` 为递增正整数，`stage` 为 `development` 或 `mvp-candidate`。修改产品后出新包应递增构建号。每次构建计算产品输入摘要，核对包内资源和解压后签名；没有证书/公证时仍需用户按系统提示批准。

## 2. 目录和模块边界

| 路径 | 公共职责 |
| --- | --- |
| `Package.swift` | 仅声明 `Markfine` 和 `MarkfineCore` 产品目标，不依赖本地测试目录 |
| `Sources/Markfine/` | AppKit/WKWebView、菜单/系统面板、剪贴板、关闭协调、资源协议 |
| `Sources/Markfine/ClipboardReader.swift` | 用户主动粘贴时读取剪贴板表示，区分 Finder 文件引用和文件图标 |
| `Sources/MarkfineCore/` | Foundation/系统 I/O：文件身份/保存基线、图片存储/权限/生命周期、桥接校验、资源定位 |
| `Web/src/` | CodeMirror 编辑态、块级预览、语法/源码映射、保存状态机、查找/格式、图表 |
| `Web/src/table-editor.ts` | 表格单元格视图／Markdown UTF-16 区间映射；编辑提交父文档，撤销／保存不使用独立历史 |
| `Web/src/table-construction.ts`、`markdown-input-state.ts` | 新表及旧表外延输入的瞬时源范围、原文本节点上的表格网格与位置映射；显式单元格写回与构造输入分开 |
| `Web/src/outline.ts`、`editor-preferences.ts`、`localization.ts` | 标题树、受校验的用户设置与中英文界面，均不修改正文 |
| `Web/src/inline-presentation.ts`、`motion.ts`、`ui-tools.ts` | 段落／表格共用行内排版、光标居中与内容结构滚动、目录尺寸与瞬时滚动条 |
| `Sources/MarkfineCore/ApplicationSettings.swift`、`ExternalLink.swift` | 用户设置白名单／持久化与外部目标解析，不调用外部程序 |
| `Sources/MarkfineCore/TextDocument.swift`、`Web/src/text-document.ts` | 无损Unicode编码、类型路由、有界纯文本呈现、逐换行保留及原文输出 |
| `Web/src/paired-punctuation.ts` | 默认成对标点输入、跳过与删除；不接管组词和粘贴 |
| `Web/src/markdown-input.ts`、`markdown-input-state.ts` | 新列表前缀的短暂输入状态、必要分隔事务、正文Tab与列表项结构缩进；状态声明独立于格式命令，不增加正文副本 |
| `Sources/Markfine/PreferencesController.swift`、`NativeStrings.swift` | 原生首选项与中英文菜单；外链仅原生用户动作处理器打开 |
| `Sources/MarkfineCore/WorkspaceStore.swift`、`RecentLocations.swift` | 用户选定文件夹的描述符／ID／代次登记、按层枚举与可调整的最近记录；不扩展图片授权 |
| `Sources/MarkfineQuickLook/PreviewProvider.swift`、`Web/src/quicklook.ts` | 只读沙盒中的系统 Quick Look 静态预览、离线 Markdown 与文档范围内的有界图片读取 |
| `Sources/MarkfineCore/LocationOpenQueue.swift`、`Web/src/preview-state.ts` | 串行完成用户打开操作至文档登记；回执时复核预览、组词、编辑与任务状态 |
| `Sources/MarkfineCore/ReadingPositions.swift`、`RuntimeDataStore.swift` | 全局路径哈希导航元数据；描述符相对运行缓存清理与活跃会话锁，不管理文档资源 |
| `Sources/MarkfineCore/DocumentExport.swift`、`Sources/Markfine/DocumentOutputController.swift` | 离线 OOXML ZIP 写出、独立静态排版 WebView、系统导出／打印面板 |
| `Sources/Markfine/CacheCleanupController.swift`、`Web/src/tab-navigation.ts`、`search-highlights.ts` | 分类清理确认、标签导航与非侵入式匹配高亮 |
| `Web/src/copy-highlight.ts` | 无选区复制成功后的可见文字覆盖层；只读DOM坐标，不改选区或正文 |
| `Web/src/workspace-browser.ts`、`code-highlighting.ts`、`diagram-viewer.ts` | 文件树／临时预览交互、精确版本离线高亮、独立图表查看层 |
| `Web/src/offline-policy.ts`、`file-icons.ts`、`deletion.ts`、`help.ts` | 依赖联网接口禁用、本地图标、源单位删除、分类快捷键与离线帮助 |
| `Web/src/document-transition.ts` | 跨文档链接的短暂呈现动画；独立于章节滚动，响应用户取消与系统减少动态效果 |
| `Web/src/content-fragment.ts`、`context-menu.ts`、`slash-menu.ts` | 章节范围与选择格式语义、共享菜单、普通空行的快捷格式插入 |
| `Web/src/image-syntax.ts`、`image-controls.ts` | Obsidian宽度、图片真实可见视口上限与原图比例；显示约束不修改文档 |
| `Sources/MarkfineCore/S3Storage.swift`、`KeychainVault.swift` | 非秘密配置、受保护的服务绑定、SigV4、受限HTTPS传输及系统钥匙串 |
| `Sources/Markfine/S3ImageService.swift`、`ImageStoragePreferences.swift` | 串行图片读取／暂存复用、原生S3表单与配置操作票据 |
| `Sources/Markfine/RichClipboard.swift`、`Sources/MarkfineCore/ClipboardArchive.swift` | 原生富文本编码、受限自包含Markdown副本；剪贴板仅明确用户复制／粘贴时访问 |
| `Sources/MarkfineCore/DiagnosticLog.swift`、`Sources/Markfine/ExportNotifications.swift` | 内容最小化结构化本地日志与本地系统通知；不注册远程推送 |
| `Sources/Markfine/FinderReveal.swift` | 通知点击后的 Finder 文件定位与一次性应用焦点交接请求；系统决定是否置前 |
| `Config/Markfine.png`、`Markfine.icns` | 原创 AI 主题图标；本地离屏绘制源为 `Scripts/draw-icon.swift`，构建摘要包含图标 |
| `Web/textures/*.png`、`Scripts/draw-paper.py` | 原创无缝2x纸浆／纤维静态材质及可复现绘制源；PNG随包校验，绘制不在运行时执行 |
| `Web/build.mjs` | 本地 bundle、精确依赖核对、许可归属和资源清单；不查找/编译测试 |
| `Web/codemirror-view-compatibility.mjs` | 锁定来源摘要的组件构造兼容变换；在DOM构造前保存原参数，不重写已安装依赖 |
| `Scripts/build.py` | 独立构建/打包，不要求任何未共享脚本或测试资产 |
| `docs/REQUIREMENTS.md` | 产品需求与数据/安全/性能边界 |
| `docs/SHORTCUTS.md`、`docs/USAGE.md` | 键位基线与用户说明 |

本地原型、个人 AI 指引、测试驱动/数据、过程交接/决策、构建产物不属于共享工程依赖。删除这些本地目录或换一个全新工作区，不应影响上述构建命令。

## 3. 状态与消息契约

- Web 是正文、选区、历史的事实来源；原生仅持路径、磁盘基线、资源授权和请求元数据。日常输入不向原生同步全文；装载、保存或用户主动输出才传对应正文／排版快照。
- 协议版本为 1，共同字段为 `protocolVersion/sessionID/capability/kind`。原生先校验 WebView、主 frame、应用 URL 与独立 content world，再用 `BridgeGate` 严格校验字段/类型/文档权限。
- 应用初始化/装载使用 `initialize/load/activate/initialReady`；`hostCommand` 传菜单动作。文档消息以 `documentID` 而非标题关联。
- 原生菜单动作在当前事件内直接排入现有WebKit消息通道，避免首个后续按键越过格式动作；不新增全局键监听或第二套正文。格式事务只改变必要的标记／分隔并映射原选区；表格行内格式在实际单元格视图执行，沿既有父事务写回正文和历史。延后写回在提交时重新取得当前单元格源区间，并核验原子视图身份，不复用先前事务的过期边界；列对齐按分隔行应用。命令所有者以实际子视图焦点判断，不以展示用CSS类判断；编辑器拥有的空Undo/Redo仍消费命令，不回退WebKit DOM历史。源码快捷键在父／子编辑器均优先于语言默认注释动作。
- 手输Markdown的短暂呈现状态不向正文注入分隔换行；未完成的列表标记不能触发额外空行。模板分隔只由明确的格式命令事务处理，不能把命令模板规则施加于逐字符输入。
- 新表格或旧表外延输入刚被语法树识别时，以同一EditorState中的短暂源范围保持原生插入节点，在该文本上用行／字符装饰呈现网格；空行结束或选区离开后解除。单元格写回使用独立事务标注，不误判为重新构造。Tab和命中映射使用权威源区间；显式右键请求可交接给既有表格控件。不要在分隔行只输入了一部分时替换整块DOM，也不通过重写正文补偿已丢失的DOM光标。
- 普通正文专注按显式源换行划分，自动折行仍同属一段；列表项及代码／表格保留结构范围。空标题与前缀编辑位置不能使用零字号隐藏插入点；原生caret规则须覆盖CodeMirror默认主题，并共用于单元格。滚动条样式按空闲隐藏、滚动时显示设计，并保留固定滚动留白；用户反馈实际界面仍会常驻，问题未解决。
- 长标签文字通过独立裁切窗口移动，关闭／未保存控件不移动。仅对溢出的活动／悬停标签运行动画；标签未变化时保持DOM身份，避免每个字符重启滚动。后台及系统减少动态效果均有静态处理，不新增持续JavaScript帧循环。
- 原生 `initialize` 附带 `preferences`：`shortcutHints/focusMode/lineNumbers` 布尔值，`language(system/zh-Hans/en)` 与解析后的 `locale`，`timeZone(local/UTC)`、两个字体 PostScript 名、`editTheme/readTheme(paper/kraft/eye)`、`appearance(system/light/dark)`、`leftWidth/rightWidth(180…360)`、`editLineSpacing/readLineSpacing(0.75…2.5)`、`editZoom/readZoom(0.5…2)`。旧 `outlineWidth` 仅作宽度迁移兼容。行距为旧包各模式实际行高的相对倍数，默认1.3：排版编辑基准1.4，源码／阅读1.85；代码与表格分别沿用自身旧基准。根编辑器规则必须以足够CSS优先级覆盖CodeMirror，否则普通编辑仍会固定1.4。导出使用当前模式乘算后的实际值，不能把1.3直接当CSS行高。原生 UserDefaults 按系统用户持久化，Web 全字段校验并更新显示，不改文档历史。阅读模式为当前窗口的临时状态，不持久化。
- Web `setPreference(key,value)` 仅接受固定白名单及严格布尔／数值／枚举类型；目录拖动结束、缩放去抖提交；原生只持久化 Web 已验证的变更，不回传整套旧偏好覆盖进行中的手势。原生设置／恢复默认仍发送 `preferences`，Web 只更新有差异的编辑选项和字体规则。恢复默认只移除偏好白名单，不清整个 UserDefaults domain；最近记录上限恢复为20时按新上限裁减。
- `readingMode(enabled)` 仅控制应用内窗口样式，不修改 NSApp presentation options、Dock、系统菜单或窗口大小。菜单新增 `toggleSource`，排版／源码通过 StateEffect 和 Compartment 在同一 EditorView 上重配置，不能重建正文／选区／撤销历史。
- 链接打开或激活另一文档时，在同一编辑状态切换后先完成章节的即时定位，再以约200ms淡入及14px横移呈现；同文档继续使用原滚动动画。动画只改变正文容器及标题的呈现，不克隆文档DOM、不重建历史、不推迟原生文档登记。新切页／输入／滚轮及减少动态效果设置变化取消旧动画；后台测量暂停时有定时恢复可见性的保护。
- 阅读 DOM 是当前正文的临时完整渲染，不保存第二份编辑状态。进入时保留 CodeMirror 正文／选区／历史，隐藏编辑 DOM 并禁用修改动作；退出恢复同一视图。源文档行号与阅读块起始行号明确区分。
- 标签编辑视口用CodeMirror公开坐标API捕获真实可见文本的源位置、相对纵向偏移及横向位置，再以其 `scrollIntoView` 恢复；无法定位的巨大控件保留原 `scrollSnapshot` 回退。不把估算逻辑行顶直接当作可见折行，不另维护正文或高度图。后台正文变更通过CodeMirror的changes映射锚点。捕获／恢复完成待处理测量，隐藏编辑器不反向覆盖阅读时保留的编辑位置。查找先用 `scrollIntoView` 请求正确源区间，`scrollHandler` 在测量后接续平滑动画并取代旧目标；回调校验活动文档、光标头及导航代次，新的输入／选区、目录、滚轮或模式切换优先。不调用CodeMirror私有测量方法。
- 光标居中由实际编辑／选区改变触发，不在ResizeObserver或仅焦点变化／标签激活时触发；滚轮浏览取消尚未执行的居中帧。关闭查找只清高亮，不取消已请求的滚动目的地；CodeMirror高度图重排后的第二次定位仍需完成，完成回调不得在关闭查找后重新亮起高亮。
- 滚动条／边栏的指针操作不视为正文选区；正文指针松开仅在选区确有变化时触发居中。视口装饰优先由渲染帧刷新，帧调度暂停时使用短定时器兜底。图片装饰保留在高度图中，实际 DOM 仍由可见范围生成；用户反馈实际长图滚动仍会回跳，问题未解决。
- Web `openLink(documentID,href)` 只从显式可信 `⌘`＋左键事件发送；原生校验文档身份、协议、目标类型。HTTP(S) 交默认浏览器；本地路径相对已登记文档解析，文件交系统默认应用，拒绝可执行／脚本／包和危险协议。WebView 导航一律取消。该操作不扩大图片读取权限。
- 源码模式的链接按点击坐标定位 Markdown Link／Autolink 语法节点，复用文档引用定义与相同的目标解析；代码、图片及图片替代文字不作为可打开链接。内联章节定位和跨文档回执继续共用原导航流程，外部目标仍要求可信用户事件。
- `closeEmptyWindow` 只能在原生确认文档集合为空、没有保存／图片任务时走既有 close-all 协调后退出，不能绕过未保存保护。
- Web 发 `save(documentID,requestID,revision,snapshot)`；原生返回同一文档/请求/版本的 `saveReceipt`，结果为 success/failure/cancelled/conflict/unconfirmed，可携带标题、路径与迁移映射。路径只能由原生已登记的文档或系统面板决定。
- `state` 只传 revision/dirty/pending。保存按文档串行，成功更新对应快照基线，不替换当前正文/历史；超时保持占位和未确认结果，不能当取消。
- 图片 `paste` 绑定文档、请求、revision、anchor/head；`cancelPaste` 与回执验证原任务。文件落盘后才插入，一次可撤销；取消后的回执不能生效。
- `beginCopy(documentID,requestID)` 在Web异步快照生成前取得原生票据，记录文档、内部代次与系统剪贴板changeCount；`copyFragment`须携带票据、revision、Markdown与结构化快照，写入前复核票据及changeCount。`abortCopy`和失败释放占位，剪切只在写入成功且原正文仍一致时执行一次删除。复制会锁定目标的编辑／保存／关闭，其他标签可继续操作。
- 富文本通过受控语义树生成HTML、RTF／RTFD，图片全部内嵌，不解析外部HTML作为原生富文本输入。自有副本上限8MiB正文、512个资源、64MiB原始图片，编码总量160MiB；本地原始图片字节随副本携带，粘贴按语法节点改目标引用，S3图片保留链接。此能力不启用普通外部HTML／RTF格式化粘贴。
- 原生发送`imageStorage`只包含粘贴位置和已配置图片根地址，不传凭据。S3配置只能原生表单写入；`resolvePaste(retry|local)`仅能处理已失败待决的同一图片任务。待决任务保留原剪贴板图片数据，重试不重新读取系统剪贴板；运行中配置变化取消旧上传，迟到回执按代次拒绝。
- 标签关闭使用带 revision 的 `closeDocument/closeReceipt`。全部关闭使用原生请求、Web 逐文档决策、最终短冻结与 `closeAllResult/closeAllReceipt`；保存/图片/新输入均不得绕过确认。
- 新命令必须同时更新原生 schema、Web 发送/接收、失效/重放处理及接口说明，不能允许文档传任意路径或扩展成系统命令通道。
- 导航消息 `rememberPosition(documentID,mode,line,fraction)` 只存行／块比例，路径由原生登记文档提供，批准关闭后持久化；装载 `resume` 供5秒显式跳转。最近记录由原生发送 `recentLocations` 带不透明条目ID，`openRecent(entryID)`、`removeRecent(entryIDs)` 不接受路径；`clearRecent` 清除两类来源，`home` 清空活动标题但不关闭文档或文件夹；清除位置记录发送 `clearPositions`。
- `exportDocument(documentID,printing,mode)` 只由菜单／用户动作触发，`mode`仅接受edit／source／read以选择当前呈现对应的全局行距基准，不能接收任意排版值或路径。原生系统面板决定输出URL。原生调用 `exportSnapshot(id)` 获取 `{html,resources}`，图片仍经同文档 ImageStore 授权读取并经ImageIO尺寸预检和后台有界转换；独立非持久静态WebView通过DOM属性替换内嵌资源，不能正则扫描／全局替换文档文字。等待字体／图片／图表完成后输出。
- DOCX以语义树生成OOXML和去重内嵌图片，只跨进程回传短图片ID及各图片的一份编码；编号先写全部abstractNum再写num。PDF不生成Word对象树，按可见文字行、图片／图表及表格行计算有限分页边界，再由WebKit逐区域生成保留文本的PDF、CoreGraphics合成带页边距的A4，并以PDFKit按标题和分页坐标生成书签；不用整页截图替代正文。系统打印使用生成的PDF经PDFKit呼出面板，不直接循环WebKit的NSPrintOperation。
- 输出安全上限：512图片引用、64MiB输入图片、96MiB转换PNG／32M累计像素、源图预检100M像素、输出栅格最长边2400px；PDF最多1000页、捕获128MiB、最终200MiB。不以截断内容冒充成功；超限或资源失败保护当前编辑及已有输出，输出原子写入。
- `filesSide(left/right)` 与 `outlineSide` 独立。原生窗口自创建起使用固定的标准AppKit标题栏，不启用 `fullSizeContentView`，不在阅读切换中修改styleMask／窗口外框。Web内容始终位于原生标题栏下方，不再模拟32px标题栏或发送 `zoomWindow`；拖窗及双击系统偏好由AppKit处理。正文列宽直接按实际滚动视口用CSS约束，保留稳定滚动条留白，避免长短文档的滚动条切换改变宽度；根内容列的flex-basis固定为auto，避免CodeMirror保留的窄视口测量在滚动重绘后覆盖应用列宽。不缓存JS视口宽度、不增加布局containment。两侧导航可临时收窄但不自动重写已存宽度。
- 文件夹消息：原生 `workspace({generation,root})` 登记一次用户选择；Web `workspaceChildren(folderID,generation,showAll,requestID)`，原生返回同字段及 `entries`；Web `openWorkspaceEntry(entryID,generation,requestID)` 仅请求已登记条目。原生返回 `load/activate` 携带 `openRequestID` 与 `preview`，仅最新请求可激活。临时替换经原 closeDocument revision 协调，编辑／保存／任务中页面不自动替换。
- 所有普通文件先经有界读取及无损Unicode文本识别；`load` 附带原生决定的 `textFile/language/encoding`。非Markdown的文本不安装Markdown解析／格式／图片扩展，提供原文编辑及只读原文。无法识别的二进制／编码仍用占位标签；`openUnsupported(documentID)`只交原生安全目标校验器，不接受Web路径。
- 打开队列覆盖读取与注册回执，不仅串行磁盘 I/O；新读入的工作区文档在注册前再次验证根身份／选定 inode。旧 `load` 可以暂存为不可见预览状态，以便最新同文件请求复用其身份；最新请求成功或 `openFailed(openRequestID)` 后再经关闭协调回收旧预览，不能先销毁即将复用的文档身份。
- WorkspaceStore 固定根描述符并验证磁盘身份，子目录逐层 `openat(O_NOFOLLOW)`；枚举使用独立 open file description，不以 dup 共享目录游标。目录代次、符号链接、失败及旧回执均要校验，不能把打开文件夹等同于所有文档图片可读整个根。
- 文件树保留原条目路径至描述符检查，不先解析符号链接。`fileSelection`返回原生URL与已核对身份，`FileDocumentStore.open(expectedIdentity:)`在读取正文前核对descriptor的设备／inode，读取后仍复查根与代次。
- 文本支持UTF-8与BOM标记的UTF-16/32；解码往返验证，不丢弃字节。打开／原编码保存上限16MiB，包含BOM；Web按装载时原生登记的编码预检，原生编码器仍作最终限制。保存桥接快照的UTF-8传输上限为24MiB，以容纳合法UTF-16文本的展开，不扩大磁盘文件上限。换行位置在同一EditorState字段随changes与undo映射，不建第二份正文。纯文本原生会话不登记ImageStore，保存不迁移图片，复制／粘贴仅文本，导出按转义原文处理。
- `RecentLocations`按来源保存有界元数据：两类来源合计最多 `recentLimit` 条（默认20、范围0–1000），按时间裁减后再应用 `showWorkspaceRecents` 过滤。旧URL数组惰性迁移为直接／未知来源，不回扫文件夹推断历史；启动和降低上限均裁减超额旧记录，0停止新增。原生菜单与主页共用已过滤的不透明ID列表，单条／批量移除不访问文件；恢复默认上限时也裁减超额记录。
- Quick Look 数据扩展在独立沙盒中使用 JavaScriptCore 生成静态 HTML，不授予网络客户端权限，不依赖主程序启动或读取主程序偏好；CSP 禁止脚本和网络。文档及本地图片有大小／像素预算，图片相对文档目录逐层 `openat` 且不跟随符号链接，系统拒绝时占位。Mermaid 输出源码。扩展由 macOS 注册和选择，不代替 Finder 或改变默认文件关联。
- 复制范围不通过改变选区来生成；进度及成功反馈采用独立fixed覆盖层，只有原生成功回执才短暂显示成功。无选区复制成功时，以CodeMirror公开源位置与单元格视图读取可见文本的DOM Range坐标，合并同一行的重叠框，裁切到滚动视口后短暂覆盖；不创建选区、不在编辑DOM插入标记。约1秒自动清理，滚动／输入／调窗／切页取消；减少动态效果时保留静态短暂反馈。正文右键使用受控复制／剪切／粘贴菜单，阻止WebKit原生菜单自动选词；右键与Control单击不进入正文拖选。菜单焦点使用preventScroll，不把DOM事件检查视为物理右键验收。
- `WorkspaceEntry.modified` 是无跟随 stat 得到的毫秒时间。进入文件导航可请求 `workspaceMetadata(entryIDs,generation,requestID)`，每批最多4096个已登记UUID；回执同代次／请求加 `dates`，只刷新现有DOM时间，不重建点击目标、不读文件正文、不递归遍历。左右栏各有贯穿可用高度的键盘／指针分隔条，同侧目录与文件树共享宽度。
- `diagnostic(event)` 只接受固定事件枚举，不允许正文、URL、路径、堆栈或任意消息字段。Web同类事件5秒节流；原生捕获到的Error只提取类型、白名单错误域和码，绝不序列化NSError.userInfo／localizedDescription；POSIX失败保留真正errno而非Swift枚举序号。`RuntimeDataStore.record` 与清理共用管理锁，每次通过 `openat(O_NOFOLLOW)` 重新打开固定文件，拒绝符号链接／硬链接和特殊文件，五份约2MiB轮转。不能因日志写入失败递归产生日志。
- 导出控制器返回明确 `cancelled/exported/printed`，只有系统保存面板确认后才申请本地通知权限；成功原子写入后发送一次通知，失败保留编辑并通知，取消不发送失败通知。前台通知通过本地UNUserNotificationCenter委托申请横幅／列表呈现，OS权限或勿扰可能抑制；没有远程推送注册或请求。

## 4. 文件、图片与安全约束

- `FileDocumentStore` actor 在非主上下文做 I/O；磁盘基线包含设备/inode、内容摘要和元数据，写入同目录独占临时文件、同步、提交前复查及原子替换。首次保存计划检查目标在图片迁移期间是否变更。
- 保存基线核对创建时间、权限、所有者／组、标志、硬链接数、ACL与扩展属性。LaunchServices仅更新有效且前进的`com.apple.lastuseddate#PS`时可保留正常保存；该例外要求其他受检内容与元数据全部一致，不普遍忽略ctime或外部变更。读取遇到元数据竞争时最多完整重读三次，只有严格稳定的快照才用于比较；提交后读回目标，核对身份与字节，不确认时保留编辑。扩展属性最多256项、累计16MiB，超预算拒绝而非跳过检查。
- macOS 文件协调不是对任意不配合外部写入的 CAS；最终核对和提交之间仍有边界，不得宣称消除所有外部竞争。提交后无法确认须保留编辑并拒绝自动关闭/重试。
- `ImageStore` actor 管理 `<文档名>.assets` 和应用自身按会话/标签隔离的暂存；会话文件锁证实是否存活。只清理可证实失效的应用管理目录，正式 `.assets` 不自动删。
- 暂存图迁移仅处理保存快照实际图片引用；Web 以语法节点更新目标，正文和当前编辑分别正常化，不全局字符串替换、不清空历史。
- 图片读取需规范化路径并在授权根内以 fd 逐级检查；不以相似字符串前缀判断权限，不让符号链接/路径竞态越权。
- `markfine://app/` 只暴露受控页面/样式/文档图片。app.js 和能力只在独立 content world 注入，页面脚本不可取得；CSP、非持久 WebKit、网络规则及导航拦截共同限制内容。
- 远程图/脚本/字体不自动加载；Mermaid 固定 12.3.0、strict、六类离线，生成 SVG 后清理主动内容。不能因新增语法/图表而放宽以上边界。
- 两个可信JS入口在依赖初始化之前先加载 `offline-policy.ts`〔重复加载幂等〕，禁用 fetch、XHR、WebSocket、EventSource、Beacon、WebRTC、WebTransport、Worker／SharedWorker及脚本window.open。CSP同时禁止connect／frame／child／worker／manifest与远程图片、字体、样式；只用JS包装不能替代CSP及原生资源／导航限制。
- 所有应用自建的离线WebView显式关闭可涉及在线查询的网站信誉警告服务，仍保留CSP、网络规则与原生导航限制，不改变系统浏览器或macOS全局安全策略。资源根与资源读取函数在读取任何元数据前拒绝非本地file URL，不能把Foundation通用URL读取能力变成隐性联网入口。
- 每次交付前清点全部产品／构建输入、锁文件和直接／传递依赖，结合实际esbuild metafile核对真实随包引用及嵌套依赖版本。可用本地缓存tarball按锁文件SHA-512验证来源，再逐文件比较安装内容，避免只相信package.json版本。无网络环境不能声称完成线上漏洞库查询；类型声明、数学词amplitude、解析器方法fetch、XML命名空间等扫描命中须分类，不能当作真实上报。
- 检查所有实际出站入口与触发条件，并验证已知JS／DOM／CSS通道的拒绝行为；报告中明确主动系统浏览器／打印／通知交接、操作系统闭源框架及未覆盖执行路径。静态检查与回归并非对任意恶意代码或系统行为的形式化证明。不得新增自动统计、更新检测、远程字体／纹理／图标或“无敏感内容”外部请求。
- 不擅自修改用户文件、系统剪贴板/默认关联或关闭系统安全限制。任何验证均应使用合成数据/副本，真实交互另行约定。

### S3的限定联网与凭据边界

S3是用户主动配置的图片传输能力，限定HTTPS服务地址、存储桶、图片目录及可选公开根地址；`markfine://app/remote-image/<documentID>/<opaqueURL>`经原生解码、profile匹配及canonical对象键重建请求，不直接访问Markdown提供的任意URL。公开访问不发送S3认证，重定向与额外认证挑战拒绝，系统TLS验证保持。其他文档远程资源及可信Web联网入口继续禁用。

配置中的opaque credentialID仅为索引。完整服务绑定（含地址、桶、区域、路径方式、目录、访问方式及公开根地址）与AK／SK／临时令牌一起保存为钥匙串私密值，签名前／公开读取前均核对绑定。配置保存票据在原生按钮事件同步登记，本地选择、重置及删除使旧票据失效；未提交的新条目可追踪清理，删除仅限应用管理的条目ID。当前ad-hoc签名更新后的授权连续性独立验证，不能通过放宽钥匙串ACL绕过系统要求。

图片读取将传输、校验和暂存串行化，队列最多32个请求，单响应最多64MiB；URL别名按canonical key复用同一文档中的文件，内存只保留一个最近资源。ImageStore管理暂存为单文档256MiB／会话512MiB，失败清理仍占预算，正式附件不自动删除。新对象使用随机UUID，文档路径和原文件名不进入对象键；错误日志仍只记录固定事件及错误类型／域／码，不记录请求头、凭据、URL或正文。

## 5. 按需求隔离开发

- 每个需求保留明确范围/验收点，使用独立分支或工作树，避免把无关需求的代码、个人工具配置和过程产物混入同一提交。
- 共享提交只包含产品代码、锁文件/必要构建配置、确定性需求和公共接口/开发说明；不要求所有人采用相同 AI 或个人协作流程。
- 需求涉及状态归属、协议、文件/图片或权限时先说明影响并保持上述契约；已有工作未经确认不可重置或删除。
- `main` 保持可独立构建，合入前说明相关验证及未验证项；没有运行的测试、真实输入法、可见呈现或性能不能称为通过。
- 构建目录、缓存、依赖安装结果、签名包/ZIP、测试日志和个人测试代码不作为产品源码提交。

## 6. 公开文档

根目录 `README.md` 为中文公开介绍，`README.en.md` 为内容对应的英文版；顶部相互链接，产品与隐私说明同步维护。

## 许可

自有代码与文档使用根 `LICENSE` 的 MIT 许可；构建输入摘要包含许可证，包内复制到 `Contents/Resources/LICENSE.txt`。第三方许可归属保持独立，不能以本项目 MIT 替换传递依赖的 EPL／Apache 等要求。
