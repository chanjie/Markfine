# 第三方依赖与许可

Markfine 自有代码与文档采用根 `LICENSE` 的 MIT 许可，随应用提供 `Contents/Resources/LICENSE.txt`。下列第三方组件保留其各自许可，不因项目采用 MIT 而被重新许可。

精确依赖及 integrity 见 `Web/package.json`、`Web/package-lock.json`。修改版本需显式更新锁文件，不在运行时下载或自动升级依赖。

| 直接依赖 | 版本 | 包声明许可 |
| --- | --- | --- |
| @codemirror/commands | 6.11.1 | MIT |
| @codemirror/lang-markdown | 6.5.2 | MIT |
| @codemirror/language | 6.13.1 | MIT |
| @codemirror/state | 6.7.6 | MIT |
| @codemirror/view | 6.43.15 | MIT |
| markdown-it | 15.0.3 | MIT |
| mermaid（标准版） | 12.3.0 | MIT |
| highlight.js（仅打包选定语言） | 11.12.0 | BSD-3-Clause |
| @types/markdown-it（开发） | 14.2.0 | MIT |
| esbuild（开发） | 0.28.2 | MIT |
| typescript（开发） | 7.0.2 | Apache-2.0 |

`Web/build.mjs` 按编辑器与 Mermaid 两个 bundle 的实际输入生成 `dependencies.json`、`ThirdPartyNotices.txt` 和 `.LEGAL.txt`，随 `.app` 打包，并校验实际安装版本与锁文件一致。运行时不分发 Node/npm/Swift 工具链。

传递依赖不全是 MIT。例如 `elkjs` 的双许可中选择 EPL-2.0，DOMPurify 的双许可中选择 Apache-2.0；具体版本、选择与 LICENSE/NOTICE 原文在每次包内记录。`khroma` 的 MIT 许可来自包内 license 原文核对，不从缺失的元数据推断。

上述自动归属清单不替代独立法律/安全评审。
