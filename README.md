<div align="center">
  <img src="assets/icon.png" width="96" alt="AI产出管家">
  <h1>AI产出管家 · ai-artifact-manager</h1>
  <p>
    <img alt="license" src="https://img.shields.io/badge/license-MIT-2563eb">
    <img alt="platform" src="https://img.shields.io/badge/platform-Windows-0ea5e9">
    <img alt="version" src="https://img.shields.io/badge/version-1.0.0-6366f1">
    <img alt="local" src="https://img.shields.io/badge/data-100%25%20local-059669">
  </p>
  <p><b>中文</b> · <a href="README.en.md">English</a></p>
</div>

管理 AI 工具在电脑上堆积的文件。离线、免费，数据不出本机；删除的文件进 Windows 回收站，可以还原。

![主界面](docs/screenshots/main.png)

## 下载

[最新版（Windows 64 位）](https://github.com/Aiearn-lab/ai-artifact-manager/releases/latest) —— 解压双击，不用安装、不用注册。首次启动会在桌面放一个快捷方式（只放一次，不覆盖你已有的）；若提示「已保护你的电脑」，点「更多信息 → 仍要运行」。

## 三步上手

1. 打开就是「清理硬盘」。点一块盘、再点「开始体检」，十几秒后看到三档：**能安全清掉 / 占地方的大件 / 不用管**，三个数字相加正好等于实际占用，点「打开」直接跳到那个目录
2. 「AI 文件」页认出 AI 产出的文件并分类；「一键瘦身」按把握大小分档处理
3. 「回收箱」里的文件随时放回；「小报」看本月做了什么

![清理硬盘：这块盘被什么吃掉了](docs/screenshots/disk.png)

## 功能

- **清理硬盘（空间体检）**：只统计体积、不动文件，指出哪块最大、在哪个目录；回收站压着多少空间也算出来
- **一键清理**：只清「能安全清掉」档（缓存、字节码、构建产物），删除进回收站可还原；动手前先看清单。程序自带的依赖和虚拟环境不会自动清——删了程序会出错，宁可少清不可错清
- **看看里面**：对大目录一层层往里看，弄清 177GB 到底是什么
- **重复的文件**：逐字比对找完全相同、相似度找近似；逐行标明「会自动清」还是「需你判断」，项目里的同名文件只提示不动手
- **整理与搜索**：归档只移动不复制；可按正文内容搜索；可选接本地模型或自己的密钥做摘要和改名

## 安全

- 全本机运行，零遥测；AI 工具自身的依赖、记忆和缓存目录在扫描层直接跳过
- 来源不明的文件、你标记「这是我写的」、项目内代码（含 package.json / .git 的目录），任何档位都不自动碰
- 删除只进 Windows 回收站，和右键删除一样；归档只移动不复制
- 密钥只存本机配置文件，不写进日志和导出

## 让 AI 接手

软件里开启 MCP 后，Cursor、Claude 等 AI 可以直接问「我的盘为什么满」「帮我清掉缓存」。AI 会先给出清单，你点头才删。工具列表、权限边界和连接配置见 [AI-SKILL.md](AI-SKILL.md)。

## 从源码运行

```bash
git clone https://github.com/Aiearn-lab/ai-artifact-manager.git
cd ai-artifact-manager
npm install
npm start        # Node.js 18+
npm run dist     # 打包 Windows portable
node _test/run_test.js        # 单元自测，其余专项同在 _test/ 下
node _test/run_word_gate.js   # 小白术语闸，出黑话即红
```

## 联系

**智维工作室 / Zhiwei Studio** · [www.zhiweistudio.com.cn](https://www.zhiweistudio.com.cn) · 7388603@qq.com
承接 AI 应用、桌面工具、自动化脚本的定制开发。

## License

[MIT](LICENSE) © 2026 智维工作室 Zhiwei Studio
