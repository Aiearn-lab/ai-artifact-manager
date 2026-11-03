<div align="center">
  <img src="assets/icon.png" width="96" alt="AI产出管家">
  <h1>AI产出管家 · ai-artifact-manager</h1>
  <p><b>把 AI 生成的东西认出来、分好类、告诉你哪些该留、哪些该删</b></p>
  <p>
    <img alt="MIT" src="https://img.shields.io/badge/license-MIT-2563eb">
    <img alt="platform" src="https://img.shields.io/badge/platform-Windows-0ea5e9">
    <img alt="no cloud" src="https://img.shields.io/badge/data-100%25%20local-059669">
  </p>
  <p><b>中文</b> · <a href="README.en.md">English</a></p>
</div>

用 ChatGPT、Claude、DeepSeek、Cursor 干活，几个月后电脑里会堆满 `untitled.md`、`方案_v3_终稿(2).md` 和说不清来路的文件——每个 AI 工具都在往你电脑里塞东西，通用清理工具不认识它们。这个工具专管这件事：**离线、免费、文件不出本机。**

![主界面](docs/screenshots/main.png)

## 下载

**[⬇ 下载最新版（Windows 64 位，约 95 MB）](https://github.com/Aiearn-lab/ai-artifact-manager/releases/latest)** —— 双击即用，不用安装、不用注册、不用装 Node。

也可以从源码跑（见文末）。

## 它做什么

- **扫描**：整个电脑 / 桌面+下载+文档 / 指定文件夹。系统目录、程序目录、常见 AI 工具的缓存目录默认不碰
- **识别**：按文件名、文件头、导出格式判断是不是 AI 产出的。来源只分**「AI 工具 / 未识别」**两类——猜错一个厂商名比不猜更误事
- **分类**：知识库沉淀 / 能用的工具 / 一次性脚本 / 可清理，每个文件一句人话说明为什么
- **重复清理**：完全重复（SHA-256）+ 高度相似（3-gram 相似度）都能找出来，推荐保留哪份；删除进 Windows 回收站，可还原
- **整理**：一键把该留的移动到归档目录（只移动，没有复制，越整越少）；该删的进回收站
- **搜内容**：想不起文件名，搜正文里的词，命中那句直接高亮
- **自动监控**：盯住指定文件夹，AI 新写出的文件几秒内认出来、分好类（只提示，不动手）
- **接自己的 AI（可选）**：一键连 Ollama / LM Studio，或填自己的 API 密钥，解锁摘要、智能重命名、两版比对。不接也全能用

![统计](docs/screenshots/stats.png)

## 安全机制

- 全部在本机完成，离线可用，不上传任何东西
- AI 工具自身的依赖、记忆、缓存目录**在扫描层就直接跳过**，想碰都碰不到
- 删除只进 Windows 回收站（和右键删除一样），从不永久删除
- 归档一律移动，没有复制——整理工具不该越整越多
- 密钥只存本机配置文件，不写进日志和导出

## 给 AI 助手用：内置 MCP 服务

软件里一键开启后，Cursor、Claude 等 MCP 客户端可以直接检索和整理你的文件库：

| 工具 | 作用 |
| --- | --- |
| `search_files` | 按文件名、路径、标签、分类搜索 |
| `get_file_summary` | 看某个文件讲什么 |
| `list_by_category` | 按分类列文件 |
| `archive_files` | 移动归档（原位置不再保留） |

```json
{
  "mcpServers": {
    "ai-artifact-manager": {
      "url": "http://127.0.0.1:3927/mcp"
    }
  }
}
```

只监听 `127.0.0.1`。也支持 stdio，配置片段在「设置 → MCP 服务」里一键复制。

## 从源码运行

```bash
git clone https://github.com/Aiearn-lab/ai-artifact-manager.git
cd ai-artifact-manager
npm install
npm start        # 需要 Node.js 18+
npm run dist     # 打包 Windows portable
node _test/run_test.js   # 测试
```

## 免费 + 联系

MIT 协议，全部功能免费，没有 Pro。觉得有用就点个 star。

**智维工作室 / Zhiwei Studio** · [www.zhiweistudio.com.cn](https://www.zhiweistudio.com.cn) · cqsj6667@agent.qq.com
承接 AI 应用、桌面工具、自动化脚本的定制开发。

## License

[MIT](LICENSE) © 2026 智维工作室 Zhiwei Studio
