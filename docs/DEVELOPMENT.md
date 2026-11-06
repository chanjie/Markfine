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

只做 Web 静态检查可执行 `npm --prefix Web run check`。直接 `swift build` 能编译原生模块，但不会生成完整 Web 资源或 `.app`；运行应用应使用打包结果，不直接运行裸二进制。

版本元数据在 `Config/Build.json`：`version` 为三段版本号，`build` 为递增正整数，`stage` 为 `development` 或 `mvp-candidate`。修改产品后出新包应递增构建号。每次构建计算产品输入摘要，核对包内资源和解压后签名；没有证书/公证时仍需用户按系统提示批准。

## 2. 目录和模块边界

| 路径 | 公共职责 |
| --- | --- |
| `Package.swift` | 仅声明 `Markfine` 和 `MarkfineCore` 产品目标，不依赖本地测试目录 |
| `Sources/Markfine/` | AppKit/WKWebView、菜单/系统面板、剪贴板、关闭协调、资源协议 |
| `Sources/MarkfineCore/` | Foundation/系统 I/O：文件身份/保存基线、图片存储/权限/生命周期、桥接校验、资源定位 |
| `Web/src/` | CodeMirror 编辑态、块级预览、语法/源码映射、保存状态机、查找/格式、图表 |
| `Web/build.mjs` | 本地 bundle、精确依赖核对、许可归属和资源清单；不查找/编译测试 |
| `Scripts/build.py` | 独立构建/打包，不要求任何未共享脚本或测试资产 |
| `docs/REQUIREMENTS.md` | 产品需求与数据/安全/性能边界 |
| `docs/SHORTCUTS.md`、`docs/USAGE.md` | 键位基线与用户说明 |

本地原型、个人 AI 指引、测试驱动/数据、过程交接/决策、构建产物不属于共享工程依赖。删除这些本地目录或换一个全新工作区，不应影响上述构建命令。

## 3. 状态与消息契约

- Web 是正文、选区、历史的事实来源；原生仅持路径、磁盘基线、资源授权和请求元数据。日常输入不向原生同步全文；装载与保存才传正文快照。
- 协议版本为 1，共同字段为 `protocolVersion/sessionID/capability/kind`。原生先校验 WebView、主 frame、应用 URL 与独立 content world，再用 `BridgeGate` 严格校验字段/类型/文档权限。
- 应用初始化/装载使用 `initialize/load/activate/initialReady`；`hostCommand` 传菜单动作。文档消息以 `documentID` 而非标题关联。
- Web 发 `save(documentID,requestID,revision,snapshot)`；原生返回同一文档/请求/版本的 `saveReceipt`，结果为 success/failure/cancelled/conflict/unconfirmed，可携带标题、路径与迁移映射。路径只能由原生已登记的文档或系统面板决定。
- `state` 只传 revision/dirty/pending。保存按文档串行，成功更新对应快照基线，不替换当前正文/历史；超时保持占位和未确认结果，不能当取消。
- 图片 `paste` 绑定文档、请求、revision、anchor/head；`cancelPaste` 与回执验证原任务。文件落盘后才插入，一次可撤销；取消后的回执不能生效。
- 标签关闭使用带 revision 的 `closeDocument/closeReceipt`。全部关闭使用原生请求、Web 逐文档决策、最终短冻结与 `closeAllResult/closeAllReceipt`；保存/图片/新输入均不得绕过确认。
- 新命令必须同时更新原生 schema、Web 发送/接收、失效/重放处理及接口说明，不能允许文档传任意路径或扩展成系统命令通道。

## 4. 文件、图片与安全约束

- `FileDocumentStore` actor 在非主上下文做 I/O；磁盘基线包含设备/inode、内容摘要和元数据，写入同目录独占临时文件、同步、提交前复查及原子替换。首次保存计划检查目标在图片迁移期间是否变更。
- macOS 文件协调不是对任意不配合外部写入的 CAS；最终核对和提交之间仍有边界，不得宣称消除所有外部竞争。提交后无法确认须保留编辑并拒绝自动关闭/重试。
- `ImageStore` actor 管理 `<文档名>.assets` 和应用自身按会话/标签隔离的暂存；会话文件锁证实是否存活。只清理可证实失效的应用管理目录，正式 `.assets` 不自动删。
- 暂存图迁移仅处理保存快照实际图片引用；Web 以语法节点更新目标，正文和当前编辑分别正常化，不全局字符串替换、不清空历史。
- 图片读取需规范化路径并在授权根内以 fd 逐级检查；不以相似字符串前缀判断权限，不让符号链接/路径竞态越权。
- `markfine://app/` 只暴露受控页面/样式/文档图片。app.js 和能力只在独立 content world 注入，页面脚本不可取得；CSP、非持久 WebKit、网络规则及导航拦截共同限制内容。
- 远程图/脚本/字体不自动加载；Mermaid 固定 12.3.0、strict、六类离线，生成 SVG 后清理主动内容。不能因新增语法/图表而放宽以上边界。
- 不擅自修改用户文件、系统剪贴板/默认关联或关闭系统安全限制。任何验证均应使用合成数据/副本，真实交互另行约定。

## 5. 按需求隔离开发

- 每个需求保留明确范围/验收点，使用独立分支或工作树，避免把无关需求的代码、个人工具配置和过程产物混入同一提交。
- 共享提交只包含产品代码、锁文件/必要构建配置、确定性需求和公共接口/开发说明；不要求所有人采用相同 AI 或个人协作流程。
- 需求涉及状态归属、协议、文件/图片或权限时先说明影响并保持上述契约；已有工作未经确认不可重置或删除。
- `main` 保持可独立构建，合入前说明相关验证及未验证项；没有运行的测试、真实输入法、可见呈现或性能不能称为通过。
- 构建目录、缓存、依赖安装结果、签名包/ZIP、测试日志和个人测试代码不作为产品源码提交。
