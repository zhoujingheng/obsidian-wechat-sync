"use strict";
var obsidian = require("obsidian");
var Plugin = obsidian.Plugin;
var PluginSettingTab = obsidian.PluginSettingTab;
var Setting = obsidian.Setting;
var Notice = obsidian.Notice;
var TFile = obsidian.TFile;
var normalizePath = obsidian.normalizePath;

// Try to load Node.js modules for directory scanning
var nodeFS = null;
var nodePath = null;
try { nodeFS = require("fs"); } catch (e) { /* not available */ }
try { nodePath = require("path"); } catch (e) { /* not available */ }

var DEFAULT_SETTINGS = {
    exportDir: "",
    outputFolder: "微信聊天记录",
    orgMode: "per-contact",
    includeSystemMsg: false,
    includeMediaRef: true,
    autoSync: false,
    autoSyncInterval: 30,
    contactsBlacklist: "",
    splitThreshold: 5000,
};

var MSG_TYPE_MAP = {
    1: "文本",
    3: "图片",
    34: "语音",
    43: "视频",
    47: "表情",
    49: "链接/分享",
    10000: "系统消息",
    10002: "群系统消息",
};

// ============ Plugin ============
var WeChatSyncPlugin = (function (_Plugin) {
    function WeChatSyncPlugin(app, manifest) {
        _Plugin.call(this, app, manifest);
        var s = DEFAULT_SETTINGS;
        this.settings = {
            exportDir: s.exportDir,
            outputFolder: s.outputFolder,
            orgMode: s.orgMode,
            includeSystemMsg: s.includeSystemMsg,
            includeMediaRef: s.includeMediaRef,
            autoSync: s.autoSync,
            autoSyncInterval: s.autoSyncInterval,
            contactsBlacklist: s.contactsBlacklist,
            splitThreshold: s.splitThreshold,
        };
        this.syncState = {};
        this.autoSyncTimer = null;
        this.fs = nodeFS;
        this.pathModule = nodePath;
    }

    if (_Plugin) WeChatSyncPlugin.prototype = Object.create(_Plugin.prototype);
    WeChatSyncPlugin.prototype.constructor = WeChatSyncPlugin;

    WeChatSyncPlugin.prototype.onload = function () {
        var self = this;
        console.log("[WeChat Sync] Loading plugin, fs:", !!self.fs);

        Promise.resolve(self.loadData()).then(function (data) {
            if (data) {
                var s = self.settings;
                if (typeof data.exportDir === "string") s.exportDir = data.exportDir;
                if (typeof data.outputFolder === "string") s.outputFolder = data.outputFolder;
                if (typeof data.orgMode === "string") s.orgMode = data.orgMode;
                if (typeof data.includeSystemMsg === "boolean") s.includeSystemMsg = data.includeSystemMsg;
                if (typeof data.includeMediaRef === "boolean") s.includeMediaRef = data.includeMediaRef;
                if (typeof data.autoSync === "boolean") s.autoSync = data.autoSync;
                if (typeof data.autoSyncInterval === "number") s.autoSyncInterval = data.autoSyncInterval;
                if (typeof data.contactsBlacklist === "string") s.contactsBlacklist = data.contactsBlacklist;
                if (typeof data.splitThreshold === "number") s.splitThreshold = data.splitThreshold;
            }
            self.loadSyncState();

            // Ribbon icon
            self.addRibbonIcon("message-circle", "同步微信聊天记录", function () {
                self.runSync();
            });

            // Status bar
            self.statusBarItem = self.addStatusBarItem();
            self.statusBarItem.setText("微信同步: 就绪");
            self.statusBarItem.addClass("wechat-sync-status idle");

            // Settings tab
            self.addSettingTab(new WeChatSyncSettingTab(self.app, self));

            // Commands
            self.addCommand({
                id: "sync-wechat",
                name: "同步微信聊天记录（扫描目录）",
                callback: function () { self.runSync(); },
            });

            self.addCommand({
                id: "sync-wechat-file",
                name: "导入微信聊天记录（选择文件）",
                callback: function () { self.importFromFiles(); },
            });

            // Auto sync
            if (self.settings.autoSync) {
                self.startAutoSync();
            }
        });
    };

    WeChatSyncPlugin.prototype.onunload = function () {
        if (this.autoSyncTimer) {
            clearInterval(this.autoSyncTimer);
            this.autoSyncTimer = null;
        }
    };

    // ============ Core Sync ============
    WeChatSyncPlugin.prototype.runSync = function () {
        var self = this;
        if (!self.settings.exportDir) {
            new Notice("请先在设置中配置 WeChatMsg 导出目录");
            return;
        }
        if (!self.fs || !self.pathModule) {
            new Notice("⚠️ 无法访问文件系统，请使用「选择文件导入」方式");
            return;
        }
        self.updateStatus("正在扫描...", "syncing");
        new Notice("开始同步微信聊天记录...");

        try {
            var files = self.scanExportDir(self.settings.exportDir);
            if (files.length === 0) {
                self.updateStatus("未找到导出文件", "idle");
                new Notice("未在导出目录中找到 JSON/TXT 文件");
                return;
            }
            self.ensureOutputFolder().then(function () {
                return self.processFilePaths(files);
            });
        } catch (e) {
            console.error("[WeChat Sync] Sync error:", e);
            self.updateStatus("同步失败", "error");
            new Notice("❌ 同步失败: " + (e.message || String(e)));
        }
    };

    WeChatSyncPlugin.prototype.importFromFiles = function () {
        var self = this;
        self.ensureOutputFolder();

        var input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,.txt,.csv";
        input.multiple = true;

        input.onchange = function () {
            if (!input.files || input.files.length === 0) return;
            self.updateStatus("正在导入...", "syncing");
            new Notice("开始导入...");

            var total = input.files.length;
            var done = 0;
            var allContent = [];

            function readNext() {
                if (done >= total) {
                    self.processContent(allContent).then(function () {
                        self.updateStatus("导入完成", "success");
                        new Notice("✅ 导入完成");
                    }).catch(function (e) {
                        console.error("[WeChat Sync] Import error:", e);
                        self.updateStatus("导入失败", "error");
                        new Notice("❌ 导入失败: " + (e.message || String(e)));
                    });
                    return;
                }

                var file = input.files[done];
                var reader = new FileReader();
                reader.onload = function () {
                    allContent.push({ name: file.name, content: reader.result });
                    done++;
                    readNext();
                };
                reader.onerror = function () {
                    console.warn("[WeChat Sync] Read fail:", file.name);
                    done++;
                    readNext();
                };
                reader.readAsText(file, "UTF-8");
            }

            readNext();
        };

        input.click();
    };

    // ============ File Helpers ============
    WeChatSyncPlugin.prototype.ensureOutputFolder = function () {
        var fp = normalizePath(this.settings.outputFolder);
        var self = this;
        return this.app.vault.adapter.exists(fp).then(function (exists) {
            if (!exists) return self.app.vault.createFolder(fp);
            return Promise.resolve();
        });
    };

    WeChatSyncPlugin.prototype.processFilePaths = function (files) {
        var all = [];
        for (var i = 0; i < files.length; i++) {
            try {
                all.push({ name: files[i], content: this.readFileContent(files[i]) });
            } catch (e) {
                console.warn("[WeChat Sync] Read fail:", files[i], e);
            }
        }
        return this.processContent(all);
    };

    WeChatSyncPlugin.prototype.processContent = function (items) {
        var self = this;
        var allConvs = [];
        for (var i = 0; i < items.length; i++) {
            try {
                var parsed = self.parseWeChatExport(items[i].content);
                allConvs = allConvs.concat(parsed);
            } catch (e) {
                console.warn("[WeChat Sync] Parse fail:", items[i].name, e);
            }
        }

        if (allConvs.length === 0) {
            self.updateStatus("解析失败", "error");
            new Notice("未能解析任何聊天记录，请检查文件格式");
            return Promise.resolve();
        }

        var grouped = self.groupConversations(allConvs);
        var created = 0;
        var updated = 0;
        var blacklist = self.settings.contactsBlacklist
            .split("\n")
            .map(function (s) { return s.trim(); })
            .filter(Boolean);

        var contacts = Object.keys(grouped);
        var contactIndex = 0;

        function processNext() {
            if (contactIndex >= contacts.length) {
                return self.saveSyncState().then(function () {
                    self.updateStatus("完成 (新增" + created + " 更新" + updated + ")", "success");
                    new Notice("✅ 同步完成：新增 " + created + " 个，更新 " + updated + " 个");
                });
            }

            var contact = contacts[contactIndex];
            var msgs = grouped[contact];

            // Blacklist filter
            var skip = false;
            for (var b = 0; b < blacklist.length; b++) {
                if (contact.indexOf(blacklist[b]) >= 0) { skip = true; break; }
            }
            if (skip) { contactIndex++; processNext(); return; }

            var sorted = msgs.sort(function (a, b) { return a.create_time - b.create_time; });
            var lastMsgTime = sorted[sorted.length - 1] && sorted[sorted.length - 1].create_time || 0;
            var lastMsgId = sorted[sorted.length - 1] && sorted[sorted.length - 1].msgSvrId;

            // Incremental sync check
            var state = self.syncState[contact];
            if (state && state.lastMsgId === lastMsgId) {
                contactIndex++; processNext(); return;
            }

            var newMsgs = state
                ? sorted.filter(function (m) { return m.create_time > state.lastSyncTime; })
                : sorted;

            if (newMsgs.length === 0) {
                contactIndex++; processNext(); return;
            }

            var md = self.formatToMarkdown(contact, newMsgs);
            var fp = self.getFilePath(contact, sorted[0] && sorted[0].create_time || 0);

            var existing = self.app.vault.getAbstractFileByPath(fp);
            var writePromise;

            if (existing instanceof TFile) {
                writePromise = self.app.vault.read(existing).then(function (cur) {
                    return self.app.vault.modify(existing, cur + "\n\n---\n\n" + md);
                });
                updated++;
            } else {
                var fm = self.generateFrontmatter(contact, msgs);
                writePromise = self.app.vault.create(fp, fm + md);
                created++;
            }

            return writePromise.catch(function (e) {
                console.error("[WeChat Sync] Write fail:", fp, e);
            }).then(function () {
                self.syncState[contact] = {
                    lastSyncTime: lastMsgTime,
                    messageCount: sorted.length,
                    lastMsgId: lastMsgId,
                };
                contactIndex++;
                processNext();
            });
        }

        return processNext();
    };

    // ============ File System ============
    WeChatSyncPlugin.prototype.scanExportDir = function (dir) {
        var results = [];
        var fs = this.fs;
        var p = this.pathModule;
        if (!fs || !p) return results;

        var stack = [dir];
        while (stack.length > 0) {
            var cur = stack.pop();
            try {
                var entries = fs.readdirSync(cur, { withFileTypes: true });
                for (var i = 0; i < entries.length; i++) {
                    var entry = entries[i];
                    var fp = p.join(cur, entry.name);
                    if (entry.isDirectory()) {
                        stack.push(fp);
                    } else if (entry.name.slice(-5) === ".json" || entry.name.slice(-4) === ".txt" || entry.name.slice(-4) === ".csv") {
                        results.push(fp);
                    }
                }
            } catch (e) {
                console.warn("[WeChat Sync] Scan fail:", cur, e);
            }
        }
        return results;
    };

    WeChatSyncPlugin.prototype.readFileContent = function (fp) {
        var fs = this.fs;
        if (!fs) throw new Error("No FS");
        try {
            return fs.readFileSync(fp, "utf-8");
        } catch (e) {
            var buf = fs.readFileSync(fp);
            if (typeof buf === "string") {
                if (buf.charCodeAt(0) === 0xFEFF) buf = buf.slice(1);
                return buf;
            }
            throw e;
        }
    };

    // ============ Parsing ============
    WeChatSyncPlugin.prototype.parseWeChatExport = function (content) {
        if (!content || content.trim() === "") return [];

        // JSON format
        try {
            var data = JSON.parse(content);
            if (Array.isArray(data)) {
                if (data.length > 0 && data[0].talker && data[0].msg) return data;
                if (data.length > 0 && data[0].talker && data[0].create_time) {
                    return this.groupFromFlat(data);
                }
            }
            if (typeof data === "object" && data !== null) {
                var convs = [];
                var keys = Object.keys(data);
                for (var i = 0; i < keys.length; i++) {
                    var t = keys[i];
                    var m = data[t];
                    if (Array.isArray(m)) convs.push({ talker: t, msg: m });
                }
                if (convs.length > 0) return convs;
            }
        } catch (e) {
            // Not JSON
        }

        return this.parseCSV(content);
    };

    WeChatSyncPlugin.prototype.parseCSV = function (content) {
        var lines = content.split("\n").filter(Boolean);
        if (lines.length < 2) return [];

        var sep = lines[0].indexOf("\t") >= 0 ? "\t" : ",";
        var headers = lines[0].split(sep).map(function (h) { return h.trim().replace(/^"|"$/g, ""); });
        var msgs = [];

        for (var i = 1; i < lines.length; i++) {
            var vals = lines[i].split(sep).map(function (v) { return v.trim().replace(/^"|"$/g, ""); });
            if (vals.length < 3) continue;

            var msg = { type: 1, is_sender: 0, msg_content: "", create_time: 0, talker: "" };
            for (var j = 0; j < headers.length; j++) {
                var h = headers[j];
                var val = vals[j] || "";
                if (h === "talker" || h === "sender" || h === "发言人" || h === "联系人") msg.talker = val;
                else if (h === "content" || h === "message" || h === "消息内容" || h === "内容") msg.msg_content = val;
                else if (h === "time" || h === "create_time" || h === "时间") msg.create_time = parseInt(val) || Date.parse(val) / 1000 || 0;
                else if (h === "is_sender" || h === "isSend" || h === "是否发送") msg.is_sender = parseInt(val) || (val === "true" ? 1 : 0);
                else if (h === "type" || h === "消息类型") msg.type = parseInt(val) || 1;
                else if (h === "msgSvrId" || h === "msgId") msg.msgSvrId = val;
            }
            if (msg.talker && msg.msg_content) msgs.push(msg);
        }
        return this.groupFromFlat(msgs);
    };

    WeChatSyncPlugin.prototype.groupFromFlat = function (msgs) {
        var map = {};
        for (var i = 0; i < msgs.length; i++) {
            var k = msgs[i].talker || "未知联系人";
            if (!map[k]) map[k] = [];
            map[k].push(msgs[i]);
        }
        var result = [];
        var keys = Object.keys(map);
        for (var k2 = 0; k2 < keys.length; k2++) {
            var tk = keys[k2];
            result.push({ talker: tk, msg: map[tk] });
        }
        return result;
    };

    WeChatSyncPlugin.prototype.groupConversations = function (convs) {
        var result = {};
        for (var i = 0; i < convs.length; i++) {
            var c = convs[i];
            var k = this.safeName(c.talker);
            if (!result[k]) result[k] = [];
            result[k] = result[k].concat(c.msg);
        }
        return result;
    };

    WeChatSyncPlugin.prototype.safeName = function (n) {
        return (n || "").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim();
    };

    WeChatSyncPlugin.prototype.getFilePath = function (contact, firstTime) {
        var sn = this.safeName(contact);
        var d = firstTime ? new Date(firstTime * 1000).toISOString().slice(0, 10) : "unknown";
        if (this.settings.orgMode === "daily") {
            return normalizePath(this.settings.outputFolder + "/" + d + "/" + sn + ".md");
        }
        return normalizePath(this.settings.outputFolder + "/" + sn + ".md");
    };

    WeChatSyncPlugin.prototype.generateFrontmatter = function (contact, msgs) {
        var dr = this.getDateRange(msgs);
        var types = {};
        for (var i = 0; i < msgs.length; i++) {
            types[msgs[i].type] = true;
        }
        var tk = Object.keys(types);
        var tn = [];
        for (var t = 0; t < tk.length; t++) {
            tn.push(MSG_TYPE_MAP[parseInt(tk[t])] || "类型" + tk[t]);
        }
        return [
            "---",
            'contact: "' + contact + '"',
            "message_count: " + msgs.length,
            "date_range: " + dr,
            'message_types: "' + tn.join(", ") + '"',
            'sync_time: "' + new Date().toISOString() + '"',
            "---",
            "",
            "# " + contact,
            "",
            "> 共 " + msgs.length + " 条消息 | " + dr,
            "> 消息类型: " + tn.join(", "),
            "",
            "",
        ].join("\n");
    };

    WeChatSyncPlugin.prototype.getDateRange = function (msgs) {
        if (msgs.length === 0) return "N/A";
        var minT = Infinity;
        var maxT = -Infinity;
        for (var i = 0; i < msgs.length; i++) {
            var t = msgs[i].create_time * 1000;
            if (t < minT) minT = t;
            if (t > maxT) maxT = t;
        }
        function fmt(ts) { return new Date(ts).toISOString().slice(0, 10); }
        return fmt(minT) + " ~ " + fmt(maxT);
    };

    // ============ Formatting ============
    WeChatSyncPlugin.prototype.formatToMarkdown = function (contact, msgs) {
        var self = this;
        var lines = [];
        var lastDate = "";
        for (var i = 0; i < msgs.length; i++) {
            var m = msgs[i];
            if (!self.settings.includeSystemMsg && (m.type === 10000 || m.type === 10002)) continue;
            var time = new Date(m.create_time * 1000);
            var ds = time.toISOString().slice(0, 10);
            var ts = self.pad(time.getHours()) + ":" + self.pad(time.getMinutes()) + ":" + self.pad(time.getSeconds());
            if (ds !== lastDate) {
                lines.push("");
                lines.push("### " + ds);
                lines.push("");
                lastDate = ds;
            }
            lines.push(self.fmtMsg(m, ts, contact));
        }
        return lines.join("\n");
    };

    WeChatSyncPlugin.prototype.pad = function (n) {
        return n < 10 ? "0" + n : String(n);
    };

    WeChatSyncPlugin.prototype.fmtMsg = function (m, ts, contact) {
        var time = "`" + ts + "`";
        var sender = m.is_sender === 1 ? "**我**" : "**" + contact + "**";

        if (m.type === 10000 || m.type === 10002) {
            return "> 📢 *" + (m.msg_content || "").replace(/\n/g, " ") + "* " + time;
        }

        if (this.settings.includeMediaRef) {
            switch (m.type) {
                case 3: return "> 🖼️ **[图片]** " + time + " " + sender;
                case 34: return "> 🎤 **[语音]** " + time + " " + sender;
                case 43: return "> 🎬 **[视频]** " + time + " " + sender;
                case 47: return "> 😊 **[表情]** " + time + " " + sender;
                case 49:
                    var lm = (m.msg_content || "").match(/(https?:\/\/[^\s,]+)/);
                    return "> 🔗 **[链接分享]** " + time + " " + sender + (lm ? " - " + lm[1] : "");
            }
        } else if (m.type !== 1) {
            return "*[" + (MSG_TYPE_MAP[m.type] || "其他消息") + "]* " + time;
        }

        var content = (m.msg_content || "").replace(/\n/g, "\n> ").replace(/\r/g, "");
        return "> " + content + "  " + time + "  " + sender;
    };

    // ============ UI ============
    WeChatSyncPlugin.prototype.updateStatus = function (text, cls) {
        if (this.statusBarItem) {
            this.statusBarItem.setText(text);
            this.statusBarItem.className = "wechat-sync-status " + (cls || "idle");
        }
    };

    // ============ Auto Sync ============
    WeChatSyncPlugin.prototype.startAutoSync = function () {
        var self = this;
        if (this.autoSyncTimer) clearInterval(this.autoSyncTimer);
        this.autoSyncTimer = setInterval(function () {
            self.runSync();
        }, this.settings.autoSyncInterval * 60000);
    };

    // ============ Persistence ============
    WeChatSyncPlugin.prototype.saveSettings = function () {
        var self = this;
        return this.saveData(this.settings).then(function () {
            if (self.settings.autoSync) {
                self.startAutoSync();
            } else {
                if (self.autoSyncTimer) {
                    clearInterval(self.autoSyncTimer);
                    self.autoSyncTimer = null;
                }
            }
        });
    };

    WeChatSyncPlugin.prototype.loadSyncState = function () {
        try {
            var raw = window.localStorage.getItem("wechat-sync-state");
            if (raw) {
                this.syncState = JSON.parse(raw);
            }
        } catch (e) {
            this.syncState = {};
        }
    };

    WeChatSyncPlugin.prototype.saveSyncState = function () {
        try {
            window.localStorage.setItem("wechat-sync-state", JSON.stringify(this.syncState));
        } catch (e) {
            // storage not available
        }
        return Promise.resolve();
    };

    return WeChatSyncPlugin;
})(Plugin);

// ============ Settings Tab ============
var WeChatSyncSettingTab = (function (_PluginSettingTab) {
    function WeChatSyncSettingTab(app, plugin) {
        _PluginSettingTab.call(this, app, plugin);
        this.plugin = plugin;
    }

    if (_PluginSettingTab) WeChatSyncSettingTab.prototype = Object.create(_PluginSettingTab.prototype);
    WeChatSyncSettingTab.prototype.constructor = WeChatSyncSettingTab;

    WeChatSyncSettingTab.prototype.display = function () {
        var containerEl = this.containerEl;
        var plugin = this.plugin;
        containerEl.empty();
        containerEl.addClass("wechat-sync-settings");

        containerEl.createEl("h2", { text: "微信聊天记录同步" });

        var info = containerEl.createEl("div", { cls: "wechat-sync-summary" });
        info.createEl("p", { text: "📋 两种导入方式：" });
        var ol = info.createEl("ol");
        ol.createEl("li", { text: "选择文件导入：直接从文件选择器选取 WeChatMsg 导出的 JSON 文件" });
        ol.createEl("li", { text: "扫描目录同步：配置导出目录路径，自动扫描并增量同步（需桌面端）" });
        info.createEl("p", { text: "💡 推荐使用 WeChatMsg (github.com/LC044/WeChatMsg) 导出 JSON 格式" });

        // Export directory
        var self = this;
        new Setting(containerEl)
            .setName("WeChatMsg 导出目录（可选）")
            .setDesc("存放 WeChatMsg 导出 JSON 文件的文件夹路径。留空则仅使用文件选择方式。")
            .addText(function (text) {
                return text.setPlaceholder("D:/wechat-export/")
                    .setValue(plugin.settings.exportDir)
                    .onChange(function (value) {
                        plugin.settings.exportDir = value;
                        plugin.saveSettings();
                    });
            });

        // Output folder
        new Setting(containerEl)
            .setName("输出文件夹")
            .setDesc("在 Obsidian 库中存储聊天记录的文件夹名称")
            .addText(function (text) {
                return text.setPlaceholder("微信聊天记录")
                    .setValue(plugin.settings.outputFolder)
                    .onChange(function (value) {
                        plugin.settings.outputFolder = value || "微信聊天记录";
                        plugin.saveSettings();
                    });
            });

        // Organization mode
        new Setting(containerEl)
            .setName("组织模式")
            .setDesc("聊天记录的文件组织方式")
            .addDropdown(function (dropdown) {
                return dropdown
                    .addOption("per-contact", "按联系人（每人一个文件）")
                    .addOption("daily", "按日期（每天一个文件夹）")
                    .setValue(plugin.settings.orgMode)
                    .onChange(function (value) {
                        plugin.settings.orgMode = value;
                        plugin.saveSettings();
                    });
            });

        containerEl.createEl("div", { cls: "wechat-sync-setting-header" }).createEl("h2", { text: "同步设置" });

        // Include system messages
        new Setting(containerEl)
            .setName("包含系统消息")
            .setDesc("是否同步群聊的进群/退群等系统消息")
            .addToggle(function (toggle) {
                return toggle.setValue(plugin.settings.includeSystemMsg).onChange(function (value) {
                    plugin.settings.includeSystemMsg = value;
                    plugin.saveSettings();
                });
            });

        // Include media references
        new Setting(containerEl)
            .setName("包含媒体引用")
            .setDesc("在笔记中标注图片、语音、视频等媒体消息")
            .addToggle(function (toggle) {
                return toggle.setValue(plugin.settings.includeMediaRef).onChange(function (value) {
                    plugin.settings.includeMediaRef = value;
                    plugin.saveSettings();
                });
            });

        // Auto sync
        new Setting(containerEl)
            .setName("自动同步")
            .setDesc("定时扫目录检查新记录并同步")
            .addToggle(function (toggle) {
                return toggle.setValue(plugin.settings.autoSync).onChange(function (value) {
                    plugin.settings.autoSync = value;
                    plugin.saveSettings();
                });
            });

        // Sync interval
        new Setting(containerEl)
            .setName("同步间隔（分钟）")
            .setDesc("自动同步的间隔时间")
            .addSlider(function (slider) {
                return slider
                    .setLimits(5, 120, 5)
                    .setValue(plugin.settings.autoSyncInterval)
                    .setDynamicTooltip()
                    .onChange(function (value) {
                        plugin.settings.autoSyncInterval = value;
                        plugin.saveSettings();
                    });
            });

        // Blacklist
        new Setting(containerEl)
            .setName("联系人黑名单")
            .setDesc("不同步的联系人或群聊名称，每行一个")
            .addTextArea(function (text) {
                text.setPlaceholder("文件传输助手\n微信团队\n腾讯新闻")
                    .setValue(plugin.settings.contactsBlacklist)
                    .onChange(function (value) {
                        plugin.settings.contactsBlacklist = value;
                        plugin.saveSettings();
                    });
                text.inputEl.rows = 4;
                text.inputEl.style.width = "100%";
                return text;
            });

        // Sync state
        containerEl.createEl("div", { cls: "wechat-sync-setting-header" }).createEl("h2", { text: "同步状态" });

        var ss = plugin.syncState;
        var kk = Object.keys(ss);
        var total = 0;
        var times = [];
        for (var i = 0; i < kk.length; i++) {
            total += ss[kk[i]].messageCount || 0;
            times.push(ss[kk[i]].lastSyncTime || 0);
        }

        var summary = containerEl.createEl("div", { cls: "wechat-sync-summary" });
        summary.createEl("p", { text: "已同步 " + kk.length + " 个联系人，共 " + total + " 条消息" });
        if (kk.length > 0) {
            var last = Math.max.apply(null, times);
            if (last > 0) {
                summary.createEl("p", { text: "最近同步: " + new Date(last * 1000).toLocaleString("zh-CN") });
            }
        }
    };

    return WeChatSyncSettingTab;
})(PluginSettingTab);

module.exports = WeChatSyncPlugin;
