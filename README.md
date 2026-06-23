# WeChat Sync

Import and sync WeChat chat history into Obsidian from [WeChatMsg](https://github.com/LC044/WeChatMsg) JSON exports with incremental sync support.

> 将微信聊天记录导入 Obsidian，支持 WeChatMsg 导出的 JSON 格式，增量同步不重复。

## Features

- **Two import modes** — File picker (works on any platform) or auto-scan export directory (desktop only)
- **Incremental sync** — Only imports new messages, never duplicates
- **Multiple formats** — Supports WeChatMsg JSON arrays, keyed objects, and CSV/TXT exports
- **Per-contact notes** — Each chat becomes its own Markdown file with YAML frontmatter
- **Media annotations** — Images, voice, video, emoji, and shared links are labeled in output
- **Auto sync** — Configurable interval to periodically check for new exports
- **Blacklist** — Exclude specific contacts or group chats

## Usage

### Step 1: Export WeChat data

Use [WeChatMsg](https://github.com/LC044/WeChatMsg) to export your chat history as **JSON** format.

### Step 2: Import into Obsidian

**Option A — File picker (any platform)**

1. Open command palette (`Ctrl+P` / `Cmd+P`)
2. Run **Import WeChat chat history (select files)**
3. Select the exported JSON files

**Option B — Directory scan (desktop only)**

1. Go to **Settings > WeChat Sync**
2. Set the **Export directory** to your WeChatMsg output folder
3. Click the ribbon icon or run **Sync WeChat chat history**

### Output format

```markdown
---
contact: "John"
message_count: 1523
date_range: 2024-01-15 ~ 2024-06-20
---

# John

> Hello!  `14:30:22`  **John**
> Hi, how are you?  `14:31:05`  **Me**
> 🖼️ **[Image]** `14:32:10` **John**
```

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Export directory | WeChatMsg JSON export folder path | — |
| Output folder | Vault folder for generated notes | `微信聊天记录` |
| Organization | Per-contact file or daily subfolders | Per-contact |
| Include system messages | Group join/leave notifications | Off |
| Include media references | Label images, voice, video in notes | On |
| Auto sync | Periodic directory scan | Off |
| Sync interval | Minutes between auto-scans | 30 |
| Contacts blacklist | Names to skip (one per line) | — |

## Requirements

- Obsidian **v1.5.0** or later
- [WeChatMsg](https://github.com/LC044/WeChatMsg) to export chat data
- Desktop Obsidian for directory scanning (file picker works on all platforms)

## Installation

### From Obsidian Community Plugins (coming soon)

1. Open Obsidian **Settings > Community Plugins**
2. Search for "WeChat Sync"
3. Install and enable

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from [Releases](https://github.com/zhoujingheng/obsidian-wechat-sync/releases)
2. Copy them into `.obsidian/plugins/wechat-sync/` in your vault
3. Restart Obsidian and enable the plugin

## License

MIT
