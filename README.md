<div align="center">
  <img src="assets/icon.png" width="96" alt="AI产出管家">
  <h1>AI产出管家 · ai-artifact-manager</h1>
  <p><b>专门管理 AI 生成文件的本地工具</b></p>
  <p>
    <img alt="MIT" src="https://img.shields.io/badge/license-MIT-2563eb">
    <img alt="platform" src="https://img.shields.io/badge/platform-Windows-0ea5e9">
    <img alt="no cloud" src="https://img.shields.io/badge/data-100%25%20local-059669">
  </p>
  <p>免费开源 · 不用额外买 API · 文件不出本机</p>
</div>

> **智维工作室 / Zhiwei Studio** 出品 · 官网 [www.zhiweistudio.com.cn](https://www.zhiweistudio.com.cn)
> 我们承接 AI 应用、桌面工具、自动化脚本的定制开发，欢迎从官网或邮箱找到我们。

---

## 你是不是也有这个问题

用 ChatGPT、Claude、DeepSeek、Cursor 这些工具干活，几个月后文件夹会变成这样：

- `untitled.md`、`未命名 (3).md`、`新建文本文档.txt` 堆满下载目录
- 同一份方案有 v1 / v2 / 最终版 / 最终版(2)，不知道删哪个
- 想找上周那份调研，只记得内容，不记得文件名
- 明知道有一堆东西可以删，但不敢下手，怕删错

通用的文件整理工具不认识 AI 文件。**AI产出管家只干一件事：把 AI 生成的东西认出来、分好类、告诉你哪些该留、哪些该删。**

---

## 它做什么

### 1. 扫描：整个磁盘 / 常用位置 / 单个文件夹

- **扫描整个电脑**：自动识别本机所有磁盘分区（C/D/E…），显示每个盘的容量和可用空间，点哪个扫哪个
- **一键扫常用位置**：只扫桌面 + 下载 + 文档，最快最安全，适合第一次用
- **只选文件夹**：传统方式，扫指定目录
- 按**文件名特征 + 文件头注释 + 导出格式**判断 AI 来源，零算力、离线可用
- 能识别 ChatGPT、Claude、DeepSeek、Cursor、通义、Kimi、文心等主流工具；没把握的归为「疑似 AI 生成」，不硬猜
- **预置白名单**：系统目录、程序目录、AppData、回收站，以及 exe/dll/图片/视频/压缩包等 40 多种类型，默认就不扫；用户还能追加自己的

### 2. 自动分类与留存判断

每个文件归到三类之一，并给一句人话说明：

| 分类 | 说明 | 留存建议 |
| --- | --- | --- |
| **值得留的知识** | 长文、报告、笔记、教程，有标题结构 | 建议长期留存 |
| **能用的工具** | 有函数、CLI、模块化，能复用的脚本 | 建议留存到工具库 |
| **一次性脚本** | 硬编码路径、很短、只适合当前场景 | 可归档或清理 |
| **可以删的** | 乱命名草稿、内容空洞、重复版本 | 建议清理 |

- 每个文件带内容标签（最多 3 个），方便筛选
- **一键整理**：把该留的知识和工具移动到归档目录，把可以删的删进 Windows 回收站，一个按钮完成，不用逐项勾

### 3. 清单 + 多功能区（屏幕都给文件）

- 顶部只留一行统计，图表收进「统计」弹窗，不再占主界面
- 左边清单：文件名 / 来源 / 分类 / 大小 / 路径，支持分类、来源、关键词筛选和四种排序
- 右边多功能区：预览内容、AI 摘要 / 起名 / 标签 / 复核分类、打开、定位、单个归档
- 字号和行高按「看得清、点得中」设计，不堆小字

### 4. 知识库（独立模块）

- 单独视图：只收知识类文件，按主题标签聚合
- 顶部统计：多少份资料、共多少字、常见主题
- 批量归档到「知识库」目录、导出清单
- 标签可搜索，找资料不用记文件名

### 5. 工具库（独立模块）

- 单独视图：只收脚本类文件，分「常用工具」和「一次性脚本」
- 按语言统计（Python / JavaScript / Shell / HTML…）
- 批量归档到「工具库」目录，按类型建子文件夹

### 6. 重复文件清理

- **完全重复**：SHA-256 全文比对
- **高度相似**：文本归一化后 3-gram Jaccard，默认阈值 82%
- 自动推荐保留「更完整、命名更规范」的那份，其余标为冗余版本
- 独立的「重复文件」视图，能看清每组保留哪份、相似度多少
- 删除一律进 Windows 回收站（和右键删除完全一样），不直接永久删除，也不自建任何回收站文件夹

### 7. 接自己的 AI（可选，不接也能用）

AI 能力全部由你自带，**我们不提供算力、不垫付 API 费用**：

- **一键连本地 AI**：自动探测 Ollama（11434）和 LM Studio（1234），点一下就接上，零成本
- **通用 OpenAI 兼容接口**：DeepSeek、GLM、通义、Kimi 等，填自己的地址和密钥
- 密钥只存本机配置文件，不上传、不写进导出清单

接上 AI 后解锁：

- 一句话大白话摘要
- 智能重命名：`untitled.md` → `类型_主题_日期.md`
- 内容标签
- 分类复核
- 两个版本深度比对，告诉你留哪份

### 8. 实用辅助

- **Windows 右键扫描**：资源管理器里右键文件夹直接启动扫描（写 HKCU，不需要管理员）
- **导出清单**：Markdown 表格 / CSV（Excel 直接打开，中文不乱码），带 AI 摘要和标签
- **基础设置**：归档路径、整理方式、预置白名单、扫描深度、文件数上限

### 9. 内置 MCP 服务

软件里手动开关，只监听 `127.0.0.1`，给 Cursor、Claude 等支持 MCP 的 AI 工具调用：

| 工具 | 作用 |
| --- | --- |
| `search_files` | 按文件名、路径、标签、摘要搜索 |
| `get_file_summary` | 看某个文件讲什么 |
| `list_by_category` | 按分类列文件 |
| `archive_files` | 触发归档 |

HTTP 配置（Cursor）：

```json
{
  "mcpServers": {
    "ai-artifact-manager": {
      "url": "http://127.0.0.1:3927/mcp"
    }
  }
}
```

也支持 stdio 方式，配置片段在软件「设置 → MCP 服务」里一键复制。

---

## 三个核心卖点

1. **免费开源**：MIT 协议，核心功能永久免费，代码全部可查
2. **不用额外买 API**：规则引擎离线可用；要 AI 就接你本地的 Ollama / LM Studio，或者你自己的密钥
3. **专门管理 AI 生成文件**：不是通用文件整理，分类逻辑围绕「AI 产出」设计

---

## 快速开始

### 方式一：下载直接运行

到 Releases 下载 `AI产出管家-x.x.x-portable.exe`，双击即用，不用装 Node、不用装 Python。

### 方式二：源码运行

```bash
git clone https://github.com/Aiearn-lab/ai-artifact-manager.git
cd ai-artifact-manager
npm install
npm start
```

打包：

```bash
npm run dist
```

> 需要 Node.js 18+。打包产物在 `dist/`。

### 第一次用建议

1. 先扫「下载」或「桌面」，不要一上来扫整个 C 盘
2. 看分类和留存建议，先不要批量删
3. 配一个归档目录，把知识库沉淀和常用工具归档出去
4. 有 Ollama 的话点「一键检测本地 AI」，试试摘要和重命名

---

## 隐私说明

- **所有扫描、分类、比对都在本机完成**，不联网也能用
- 不上传文件名、文件内容、路径到任何服务器
- API 密钥只存在本机 `config.json`，不会写进日志和导出文件
- MCP 服务只监听 `127.0.0.1`，不对局域网开放
- 归档默认是剪切（整理走），设置里可切回复制；删除重复文件走 Windows 回收站

---

## 技术栈

- Electron 44 + 原生 HTML/CSS/JS（无前端框架，构建简单）
- Node.js 文件系统 API 做扫描与比对
- 手写 MCP JSON-RPC（stdio + Streamable HTTP），零第三方 MCP SDK 依赖
- electron-builder 打包 Windows portable / NSIS

### 目录结构

```
ai-artifact-manager/
├── main.js              # Electron 主进程 + IPC 编排
├── preload.js           # contextBridge 安全桥
├── src/
│   ├── scanner.js       # 扫描 + AI 来源识别规则
│   ├── classifier.js    # 分类 + 留存建议 + 汇总
│   ├── dedupe.js        # 完全重复 + 相似度
│   ├── archiver.js      # 归档 + 重复清理
│   ├── exporter.js      # Markdown / CSV 导出
│   ├── ai.js            # Ollama / LM Studio / OpenAI 兼容
│   ├── config-store.js  # 本地配置 + 预置白名单
│   ├── safe-path.js     # 文件名清洗与路径安全
│   ├── mcp-core.js      # MCP 工具定义与处理
│   ├── mcp-http.js      # 内置 HTTP MCP 服务
│   └── mcp-stdio.js     # stdio MCP 入口
└── renderer/            # 三栏界面
```

### 测试

```bash
node _test/run_test.js
```

覆盖扫描、来源识别、分类、重复检测、导出、归档、MCP 共 8 组断言。

---

## 路线图

第一版（当前 0.2）已经能用：磁盘/常用位置/文件夹扫描、自动分类、清单 + 多功能区、知识库、工具库、重复清理、一键整理、本地 AI、MCP、右键菜单、导出。

Pro 版（后续迭代，界面已留入口）：

- 自然语言语义搜索
- 后台自动监控 + 自动归档
- 批量智能重命名与标签体系
- Obsidian / Logseq 格式导出
- 脚本自动生成使用说明
- 同主题内容整合
- 优先更新与专属支持

---

## 联系与定制

- 官网：[www.zhiweistudio.com.cn](https://www.zhiweistudio.com.cn)
- 邮箱：cqsj6667@agent.qq.com
- 出品方：智维工作室 / Zhiwei Studio

我们承接 AI 应用、桌面工具、自动化脚本、数据处理的定制开发。如果你有类似需求，欢迎联系我们。

## License

[MIT](LICENSE) © 2026 智维工作室 Zhiwei Studio
