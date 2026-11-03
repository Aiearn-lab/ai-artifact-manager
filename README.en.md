<div align="center">
  <img src="assets/icon.png" width="96" alt="AI Artifact Manager">
  <h1>AI Artifact Manager</h1>
  <p><b>Find what AI tools left on your disk, sort it, and see what's safe to delete</b></p>
  <p>
    <img alt="MIT" src="https://img.shields.io/badge/license-MIT-2563eb">
    <img alt="platform" src="https://img.shields.io/badge/platform-Windows-0ea5e9">
    <img alt="no cloud" src="https://img.shields.io/badge/data-100%25%20local-059669">
  </p>
  <p>
    <a href="README.md">中文</a> · <b>English</b>
  </p>
</div>

If you work with ChatGPT, Claude, DeepSeek or Cursor, your disk fills up with `untitled.md`, `proposal_v3_final(2).md` and files you can't even attribute — every AI tool dumps its output somewhere, and generic cleanup tools have no idea what any of it is. This app does that one job: **offline, free, nothing leaves your machine.**

![Main window](docs/screenshots/en/main.png)

## Download

**[⬇ Latest release (Windows 64-bit, ~95 MB)](https://github.com/Aiearn-lab/ai-artifact-manager/releases/latest)** — portable, double-click and it runs. No installer, no account, no Node required.

Or run from source (bottom of this page).

## What it does

- **Scan** the whole PC, common locations, or a folder. System folders, program folders and known AI-tool cache directories (.accio, Coze, .qoder…) are skipped by default
- **Detect AI output** by filename patterns, header comments and export formats. Exactly two labels: **AI tool / Unknown** — guessing a wrong vendor name costs more trust than not guessing at all
- **Categorize**: Knowledge / Reusable script / One-off script / Disposable, each with a one-line reason
- **Deduplicate**: SHA-256 for identical files, 3-gram similarity for near-identical ones; recommends which copy to keep. Deletions go to the **Windows Recycle Bin**, always restorable
- **Tidy up** with one click: keepers are **moved** (never copied — a tidying tool must not leave you with more files) into an archive folder sorted by category
- **Search inside files** when you remember what you wrote but not what you named it; matches are highlighted inline
- **Auto watch** folders — new AI output is recognized and categorized within seconds (notify only, it never touches files)
- **Bring your own AI (optional)**: one-click Ollama / LM Studio, or any OpenAI-compatible key — unlocks summaries, smart renames, side-by-side compare. Everything works without it

![Stats](docs/screenshots/en/stats.png)

## Safety

- Everything runs locally, works offline, uploads nothing
- AI tools' own dependencies, memory and caches are **skipped at the scan layer** — they can't be touched even by mistake
- Deletions only ever go to the **Windows Recycle Bin**, same as right-click → Delete
- Archiving is always a move, never a copy
- API keys stay in local config, never in logs or exports

## For AI assistants: built-in MCP server

Flip one switch and Cursor, Claude Desktop or any MCP client can search and organize your library:

| Tool | What it does |
| --- | --- |
| `search_files` | Search by name, path, tags, category |
| `get_file_summary` | What a file is about |
| `list_by_category` | List files by category |
| `archive_files` | Move files into the archive (originals don't stay) |

```json
{
  "mcpServers": {
    "ai-artifact-manager": {
      "url": "http://127.0.0.1:3927/mcp"
    }
  }
}
```

Listens on `127.0.0.1` only. stdio is also supported — copy the snippet from Settings → MCP.

## Run from source

```bash
git clone https://github.com/Aiearn-lab/ai-artifact-manager.git
cd ai-artifact-manager
npm install
npm start        # Node.js 18+
npm run dist     # build Windows portable
node _test/run_test.js   # tests
```

## Free

MIT licensed, every feature free, no Pro tier. If it saves you time, a star is the best thanks.

**Zhiwei Studio** · [www.zhiweistudio.com.cn](https://www.zhiweistudio.com.cn) · cqsj6667@agent.qq.com
We build AI apps, desktop tools and automation for clients — get in touch if you need something custom.

## License

MIT © 2026 Zhiwei Studio
