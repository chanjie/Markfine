# Markfine 公共开发说明

本文件面向接手需求的开发者，记录公共工程约束，不规定个人使用的编辑器、AI、测试工具或工作习惯。

## 1. 环境和构建

- macOS Apple Silicon；Swift tools ≥6.0，Node.js 24，npm 11，Python 3.9+。已使用 Command Line Tools 构建，不强制安装完整 Xcode。
- 当前实机基线为 macOS 26.7.2 / Swift 6.4 / SDK 27。`Package.swift` 的 macOS 13 是编译部署目标，不是兼容承诺；Web 目标为 Safari 26。
- 应用运行只依赖系统 AppKit/WebKit 等框架与包内资源，不要求用户安装 Node/Python/Swift。

在仓库根目录：

```sh
python3 Scripts/build.py install       # 按锁文件安装构建依赖，禁用 lifecycle scripts
python3 Scripts/build.py               # 默认 Release arm64 .app、ad-hoc 签名、ZIP 和 SHA-256
python3 Scripts/build.py --configuration debug
```

构建不会启动或安装应用，不会改默认文件关联。Swift scratch/cache 和 Web 输出位于 `Build/Product/`，包位于 `Dist/<版本-构建-输入摘要>/<本次构建>/`；历史输出不覆盖。`BUILD.json` 只记录构建/架构/资源/签名事实，不表示功能或性能验收通过。

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
| `Sources/MarkfineCore/` | Foundation/系统 I/O：文件身份/保存基线、图片存储/权限/生命周期、桥接校验、资源定位 |
| `Web/src/` | CodeMirror 编辑态、块级预览、语法/源码映射、保存状态机、查找/格式、图表 |
| `Web/src/table-editor.ts` | 表格单元格视图／Markdown UTF-16 区间映射；编辑提交父文档，撤销／保存不使用独立历史 |
| `Web/src/outline.ts`、`editor-preferences.ts`、`localization.ts` | 标题树、受校验的用户设置与中英文界面，均不修改正文 |
| `Web/src/inline-presentation.ts`、`motion.ts`、`ui-tools.ts` | 段落／表格共用行内排版、光标居中与内容结构滚动、目录尺寸与瞬时滚动条 |
| `Sources/MarkfineCore/ApplicationSettings.swift`、`ExternalLink.swift` | 用户设置白名单／持久化与外部目标解析，不调用外部程序 |
| `Sources/Markfine/PreferencesController.swift`、`NativeStrings.swift` | 原生首选项与中英文菜单；外链仅原生用户动作处理器打开 |
| `Sources/MarkfineCore/WorkspaceStore.swift`、`RecentLocations.swift` | 用户选定文件夹的描述符／ID／代次登记、按层枚举与最近20条记录；不扩展图片授权 |
| `Sources/MarkfineCore/LocationOpenQueue.swift`、`Web/src/preview-state.ts` | 串行完成用户打开操作至文档登记；回执时复核预览、组词、编辑与任务状态 |
| `Sources/MarkfineCore/ReadingPositions.swift`、`RuntimeDataStore.swift` | 全局路径哈希导航元数据；描述符相对运行缓存清理与活跃会话锁，不管理文档资源 |
| `Sources/MarkfineCore/DocumentExport.swift`、`Sources/Markfine/DocumentOutputController.swift` | 离线 OOXML ZIP 写出、独立静态排版 WebView、系统导出／打印面板 |
| `Sources/Markfine/CacheCleanupController.swift`、`Web/src/tab-navigation.ts`、`search-highlights.ts` | 分类清理确认、标签导航与非侵入式匹配高亮 |
| `Web/src/workspace-browser.ts`、`code-highlighting.ts`、`diagram-viewer.ts` | 文件树／临时预览交互、精确版本离线高亮、独立图表查看层 |
| `Web/src/offline-policy.ts`、`file-icons.ts`、`deletion.ts`、`help.ts` | 依赖联网接口禁用、本地图标、源单位删除、分类快捷键与离线帮助 |
| `Sources/MarkfineCore/DiagnosticLog.swift`、`Sources/Markfine/ExportNotifications.swift` | 内容最小化结构化本地日志与本地系统通知；不注册远程推送 |
| `Config/Markfine.png`、`Markfine.icns` | 原创 AI 主题图标；本地离屏绘制源为 `Scripts/draw-icon.swift`，构建摘要包含图标 |
| `Web/build.mjs` | 本地 bundle、精确依赖核对、许可归属和资源清单；不查找/编译测试 |
| `Scripts/build.py` | 独立构建/打包，不要求任何未共享脚本或测试资产 |
| `docs/REQUIREMENTS.md` | 产品需求与数据/安全/性能边界 |
| `docs/SHORTCUTS.md`、`docs/USAGE.md` | 键位基线与用户说明 |

本地原型、个人 AI 指引、测试驱动/数据、过程交接/决策、构建产物不属于共享工程依赖。删除这些本地目录或换一个全新工作区，不应影响上述构建命令。

## 3. 状态与消息契约

- Web 是正文、选区、历史的事实来源；原生仅持路径、磁盘基线、资源授权和请求元数据。日常输入不向原生同步全文；装载、保存或用户主动输出才传对应正文／排版快照。
- 协议版本为 1，共同字段为 `protocolVersion/sessionID/capability/kind`。原生先校验 WebView、主 frame、应用 URL 与独立 content world，再用 `BridgeGate` 严格校验字段/类型/文档权限。
- 应用初始化/装载使用 `initialize/load/activate/initialReady`；`hostCommand` 传菜单动作。文档消息以 `documentID` 而非标题关联。
- 原生 `initialize` 附带 `preferences`：`shortcutHints/focusMode/lineNumbers` 布尔值，`language(system/zh-Hans/en)` 与解析后的 `locale`，`timeZone(local/UTC)`、两个字体 PostScript 名、`editTheme/readTheme(paper/kraft/eye)`、`appearance(system/light/dark)`、`leftWidth/rightWidth(180…360)`、`editLineSpacing/readLineSpacing(0.75…2.5)`、`editZoom/readZoom(0.5…2)`。旧 `outlineWidth` 仅作宽度迁移兼容。行距为旧包各模式实际行高的相对倍数，默认1.3：排版编辑基准1.4，源码／阅读1.85；代码与表格分别沿用自身旧基准。根编辑器规则必须以足够CSS优先级覆盖CodeMirror，否则普通编辑仍会固定1.4。导出使用当前模式乘算后的实际值，不能把1.3直接当CSS行高。原生 UserDefaults 按系统用户持久化，Web 全字段校验并更新显示，不改文档历史。阅读模式为当前窗口的临时状态，不持久化。
- Web `setPreference(key,value)` 仅接受固定白名单及严格布尔／数值／枚举类型；新增 `outlineSide(left/right)`、`showAllFiles`。目录拖动结束、缩放去抖提交；原生只持久化 Web 已验证的变更，不回传整套旧偏好覆盖进行中的手势。原生设置／恢复默认仍发送 `preferences`，Web 只更新有差异的编辑选项和字体规则。恢复默认只移除偏好白名单，不能清整个 UserDefaults domain 或最近记录。
- `readingMode(enabled)` 仅控制应用内窗口样式，不修改 NSApp presentation options、Dock、系统菜单或窗口大小。菜单新增 `toggleSource`，排版／源码通过 StateEffect 和 Compartment 在同一 EditorView 上重配置，不能重建正文／选区／撤销历史。
- 阅读 DOM 是当前正文的临时完整渲染，不保存第二份编辑状态。进入时保留 CodeMirror 正文／选区／历史，隐藏编辑 DOM 并禁用修改动作；退出恢复同一视图。源文档行号与阅读块起始行号明确区分。
- Web `openLink(documentID,href)` 只从显式可信 `⌘`＋左键事件发送；原生校验文档身份、协议、目标类型。HTTP(S) 交默认浏览器；本地路径相对已登记文档解析，文件交系统默认应用，拒绝可执行／脚本／包和危险协议。WebView 导航一律取消。该操作不扩大图片读取权限。
- `closeEmptyWindow` 只能在原生确认文档集合为空、没有保存／图片任务时走既有 close-all 协调后退出，不能绕过未保存保护。
- Web 发 `save(documentID,requestID,revision,snapshot)`；原生返回同一文档/请求/版本的 `saveReceipt`，结果为 success/failure/cancelled/conflict/unconfirmed，可携带标题、路径与迁移映射。路径只能由原生已登记的文档或系统面板决定。
- `state` 只传 revision/dirty/pending。保存按文档串行，成功更新对应快照基线，不替换当前正文/历史；超时保持占位和未确认结果，不能当取消。
- 图片 `paste` 绑定文档、请求、revision、anchor/head；`cancelPaste` 与回执验证原任务。文件落盘后才插入，一次可撤销；取消后的回执不能生效。
- 标签关闭使用带 revision 的 `closeDocument/closeReceipt`。全部关闭使用原生请求、Web 逐文档决策、最终短冻结与 `closeAllResult/closeAllReceipt`；保存/图片/新输入均不得绕过确认。
- 新命令必须同时更新原生 schema、Web 发送/接收、失效/重放处理及接口说明，不能允许文档传任意路径或扩展成系统命令通道。
- 导航消息 `rememberPosition(documentID,mode,line,fraction)` 只存行／块比例，路径由原生登记文档提供，批准关闭后持久化；装载 `resume` 供5秒显式跳转。最近记录由原生发送 `recentLocations` 带不透明条目ID，`openRecent(entryID)` 不接受路径；清除位置记录发送 `clearPositions`。
- `exportDocument(documentID,printing,mode)` 只由菜单／用户动作触发，`mode`仅接受edit／source／read以选择当前呈现对应的全局行距基准，不能接收任意排版值或路径。原生系统面板决定输出URL。原生调用 `exportSnapshot(id)` 获取 `{html,resources}`，图片仍经同文档 ImageStore 授权读取并经ImageIO尺寸预检和后台有界转换；独立非持久静态WebView通过DOM属性替换内嵌资源，不能正则扫描／全局替换文档文字。等待字体／图片／图表完成后输出。
- DOCX以语义树生成OOXML和去重内嵌图片，只跨进程回传短图片ID及各图片的一份编码；编号先写全部abstractNum再写num。PDF不生成Word对象树，按可见文字行、图片／图表及表格行计算有限分页边界，再由WebKit逐区域生成保留文本的PDF、CoreGraphics合成带页边距的A4，不用整页截图替代正文。系统打印使用生成的PDF经PDFKit呼出面板，不直接循环WebKit的NSPrintOperation。
- 输出安全上限：512图片引用、64MiB输入图片、96MiB转换PNG／32M累计像素、源图预检100M像素、输出栅格最长边2400px；PDF最多1000页、捕获128MiB、最终200MiB。不以截断内容冒充成功；超限或资源失败保护当前编辑及已有输出，输出原子写入。
- `filesSide(left/right)` 与 `outlineSide` 独立；`zoomWindow` 只允许原生阅读状态执行窗口缩放。原生窗口自创建起保持同一 `fullSizeContentView`，不在阅读切换中来回修改 styleMask；编辑Web布局预留标题栏安全区，模式切换不改变窗口外框。
- 文件夹消息：原生 `workspace({generation,root})` 登记一次用户选择；Web `workspaceChildren(folderID,generation,showAll,requestID)`，原生返回同字段及 `entries`；Web `openWorkspaceEntry(entryID,generation,requestID)` 仅请求已登记条目。原生返回 `load/activate` 携带 `openRequestID` 与 `preview`，仅最新请求可激活。临时替换经原 closeDocument revision 协调，编辑／保存／任务中页面不自动替换。
- 非 Markdown 只登记原生 URL 与不可编辑占位标签，不进入 FileDocumentStore 的 UTF-8 解码／保存路径；`openUnsupported(documentID)` 只交由原生安全目标校验器处理，不接受 Web 路径。
- 打开队列覆盖读取与注册回执，不仅串行磁盘 I/O；新读入的工作区文档在注册前再次验证根身份／选定 inode。旧 `load` 可以暂存为不可见预览状态，以便最新同文件请求复用其身份；最新请求成功或 `openFailed(openRequestID)` 后再经关闭协调回收旧预览，不能先销毁即将复用的文档身份。
- WorkspaceStore 固定根描述符并验证磁盘身份，子目录逐层 `openat(O_NOFOLLOW)`；枚举使用独立 open file description，不以 dup 共享目录游标。目录代次、符号链接、失败及旧回执均要校验，不能把打开文件夹等同于所有文档图片可读整个根。
- `WorkspaceEntry.modified` 是无跟随 stat 得到的毫秒时间。进入文件导航可请求 `workspaceMetadata(entryIDs,generation,requestID)`，每批最多4096个已登记UUID；回执同代次／请求加 `dates`，只刷新现有DOM时间，不重建点击目标、不读文件正文、不递归遍历。左右栏各有贯穿可用高度的键盘／指针分隔条，同侧目录与文件树共享宽度。
- `diagnostic(event)` 只接受固定事件枚举，不允许正文、URL、路径、堆栈或任意消息字段。Web同类事件5秒节流；原生捕获到的Error只提取类型、白名单错误域和码，绝不序列化NSError.userInfo／localizedDescription；POSIX失败保留真正errno而非Swift枚举序号。`RuntimeDataStore.record` 与清理共用管理锁，每次通过 `openat(O_NOFOLLOW)` 重新打开固定文件，拒绝符号链接／硬链接和特殊文件，五份约2MiB轮转。不能因日志写入失败递归产生日志。
- 导出控制器返回明确 `cancelled/exported/printed`，只有系统保存面板确认后才申请本地通知权限；成功原子写入后发送一次通知，失败保留编辑并通知，取消不发送失败通知。前台通知通过本地UNUserNotificationCenter委托申请横幅／列表呈现，OS权限或勿扰可能抑制；没有远程推送注册或请求。

## 4. 文件、图片与安全约束

- `FileDocumentStore` actor 在非主上下文做 I/O；磁盘基线包含设备/inode、内容摘要和元数据，写入同目录独占临时文件、同步、提交前复查及原子替换。首次保存计划检查目标在图片迁移期间是否变更。
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

## 5. 按需求隔离开发

- 每个需求保留明确范围/验收点，使用独立分支或工作树，避免把无关需求的代码、个人工具配置和过程产物混入同一提交。
- 共享提交只包含产品代码、锁文件/必要构建配置、确定性需求和公共接口/开发说明；不要求所有人采用相同 AI 或个人协作流程。
- 需求涉及状态归属、协议、文件/图片或权限时先说明影响并保持上述契约；已有工作未经确认不可重置或删除。
- `main` 保持可独立构建，合入前说明相关验证及未验证项；没有运行的测试、真实输入法、可见呈现或性能不能称为通过。
- 构建目录、缓存、依赖安装结果、签名包/ZIP、测试日志和个人测试代码不作为产品源码提交。

## 许可

自有代码与文档使用根 `LICENSE` 的 MIT 许可；构建输入摘要包含许可证，包内复制到 `Contents/Resources/LICENSE.txt`。第三方许可归属保持独立，不能以本项目 MIT 替换传递依赖的 EPL／Apache 等要求。
