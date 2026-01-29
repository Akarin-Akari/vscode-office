import { adjustImgPath, getWorkspacePath, writeFile } from '@/common/fileUtil';
import { readFileSync, writeFileSync } from 'fs';
import { basename, isAbsolute, parse, resolve } from 'path';
import * as vscode from 'vscode';
import { Handler } from '../common/handler';
import { Util } from '../common/util';
import { Holder } from '../service/markdown/holder';
import { MarkdownService } from '../service/markdownService';
import { Global } from '@/common/global';
import { platform } from 'os';

/**
 * Custom document for markdown files
 * Used with CustomReadonlyEditorProvider for Cursor compatibility
 */
class MarkdownDocument implements vscode.CustomDocument {
    public readonly uri: vscode.Uri;
    private _content: string;
    private _disposables: vscode.Disposable[] = [];

    constructor(uri: vscode.Uri) {
        this.uri = uri;
        this._content = '';
    }

    get content(): string {
        return this._content;
    }

    set content(value: string) {
        this._content = value;
    }

    async load(): Promise<void> {
        try {
            const data = await vscode.workspace.fs.readFile(this.uri);
            this._content = Buffer.from(data).toString('utf8');
        } catch (e) {
            // Fallback to sync read for local files
            try {
                this._content = readFileSync(this.uri.fsPath, 'utf8');
            } catch {
                this._content = '';
            }
        }
    }

    dispose(): void {
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
    }
}

/**
 * Support view and edit markdown files.
 * Uses CustomReadonlyEditorProvider for better compatibility with Cursor and other VSCode forks.
 */
export class MarkdownEditorProvider implements vscode.CustomReadonlyEditorProvider<MarkdownDocument> {

    private extensionPath: string;
    private countStatus: vscode.StatusBarItem;
    private state: vscode.Memento;
    private fileWatchers: Map<string, vscode.Disposable> = new Map();

    constructor(private context: vscode.ExtensionContext) {
        this.extensionPath = context.extensionPath;
        this.countStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.state = context.globalState;
    }

    private getFolders(): vscode.Uri[] {
        const data = [];
        for (let i = 65; i <= 90; i++) {
            data.push(vscode.Uri.file(`${String.fromCharCode(i)}:/`));
        }
        return data;
    }

    public async openCustomDocument(
        uri: vscode.Uri,
        openContext: vscode.CustomDocumentOpenContext,
        token: vscode.CancellationToken
    ): Promise<MarkdownDocument> {
        const document = new MarkdownDocument(uri);
        await document.load();
        return document;
    }

    public resolveCustomEditor(
        document: MarkdownDocument,
        webviewPanel: vscode.WebviewPanel,
        token: vscode.CancellationToken
    ): void | Thenable<void> {
        const uri = document.uri;
        const webview = webviewPanel.webview;
        const folderPath = vscode.Uri.joinPath(uri, '..');
        webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file("/"), ...this.getFolders()]
        };
        const handler = Handler.bind(webviewPanel, uri);
        this.handleMarkdown(document, handler, folderPath, webviewPanel);
        handler.on('developerTool', () => vscode.commands.executeCommand('workbench.action.toggleDevTools'));
    }

    private handleMarkdown(
        document: MarkdownDocument,
        handler: Handler,
        folderPath: vscode.Uri,
        webviewPanel: vscode.WebviewPanel
    ) {
        const uri = document.uri;
        const webview = handler.panel.webview;

        let content = document.content;
        const contextPath = `${this.extensionPath}/resource/vditor`;
        const rootPath = webview.asWebviewUri(vscode.Uri.file(`${contextPath}`)).toString();

        // Update Holder for compatibility
        Holder.activeUri = uri;
        Holder.activeContent = content;
        Holder.activeDocument = null; // Not using TextDocument anymore

        handler.panel.onDidChangeViewState(e => {
            if (e.webviewPanel.visible) {
                Holder.activeUri = uri;
                Holder.activeContent = content;
                this.updateCount(content);
                this.countStatus.show();
            } else {
                this.countStatus.hide();
            }
        });

        // Watch for external file changes
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(folderPath, basename(uri.fsPath))
        );

        let lastManualSaveTime: number;

        const handleExternalChange = async () => {
            if (lastManualSaveTime && Date.now() - lastManualSaveTime < 800) return;
            try {
                const data = await vscode.workspace.fs.readFile(uri);
                const updatedText = Buffer.from(data).toString('utf8').replace(/\r/g, '');
                if (content === updatedText) return;
                content = updatedText;
                document.content = content;
                Holder.activeContent = content;
                this.updateCount(content);
                handler.emit("update", updatedText);
            } catch (e) {
                // File might be deleted or inaccessible
            }
        };

        watcher.onDidChange(handleExternalChange);

        // Store watcher for cleanup
        const watcherKey = uri.toString();
        if (this.fileWatchers.has(watcherKey)) {
            this.fileWatchers.get(watcherKey)?.dispose();
        }
        this.fileWatchers.set(watcherKey, watcher);

        // Cleanup on panel dispose
        webviewPanel.onDidDispose(() => {
            const w = this.fileWatchers.get(watcherKey);
            if (w) {
                w.dispose();
                this.fileWatchers.delete(watcherKey);
            }
        });

        const config = vscode.workspace.getConfiguration("vscode-office");
        handler.on("init", () => {
            const scrollTop = this.state.get(`scrollTop_${uri.fsPath}`, 0);
            handler.emit("open", {
                title: basename(uri.fsPath),
                config, scrollTop,
                language: vscode.env.language,
                rootPath, content
            });
            this.updateCount(content);
            this.countStatus.show();
        }).on("externalUpdate", async () => {
            // Reload from file
            await handleExternalChange();
        }).on("command", (command) => {
            vscode.commands.executeCommand(command);
        }).on("openLink", (linkUri: string) => {
            const resReg = /https:\/\/file.*\.net/i;
            if (linkUri.match(resReg)) {
                const localPath = linkUri.replace(resReg, '');
                vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(localPath));
            } else {
                vscode.env.openExternal(vscode.Uri.parse(linkUri));
            }
        }).on("scroll", ({ scrollTop }) => {
            this.state.update(`scrollTop_${uri.fsPath}`, scrollTop);
        }).on("img", async (img) => {
            const { relPath, fullPath } = adjustImgPath(uri);
            const imagePath = isAbsolute(fullPath) ? fullPath : `${resolve(uri.fsPath, "..")}/${relPath}`.replace(/\\/g, "/");
            writeFileSync(imagePath, Buffer.from(img, 'binary'));
            const fileName = parse(relPath).name;
            const adjustRelPath = await MarkdownService.imgExtGuide(imagePath, relPath);
            vscode.env.clipboard.writeText(`![${fileName}](${adjustRelPath})`);
            vscode.commands.executeCommand("editor.action.clipboardPasteAction");
        }).on("quickOpen", () => {
            vscode.commands.executeCommand('workbench.action.quickOpen');
        }).on("editInVSCode", (full: boolean) => {
            const side = full ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
            vscode.commands.executeCommand('vscode.openWith', uri, "default", side);
        }).on("save", async (newContent) => {
            if (lastManualSaveTime && Date.now() - lastManualSaveTime < 800) return;
            content = newContent;
            document.content = content;
            Holder.activeContent = content;
            await this.saveFile(uri, newContent);
            this.updateCount(content);
        }).on("doSave", async (newContent) => {
            lastManualSaveTime = Date.now();
            content = newContent;
            document.content = content;
            Holder.activeContent = content;
            await this.saveFile(uri, newContent);
            this.updateCount(content);
        }).on("export", (option) => {
            new MarkdownService(this.context).exportMarkdown(uri, option);
        }).on("theme", async (theme) => {
            if (!theme) {
                const themes = [
                    "Auto", "|",
                    "Light", "Solarized", "Warm Light", "Dim Light", "|",
                    "One Dark", "Github Dark",
                    "Nord", "Monokai", "Dracula",
                ];
                const editorTheme = Global.getConfig('editorTheme');
                const themeItems: vscode.QuickPickItem[] = themes.map(t => {
                    if (t === '|') return { label: '|', kind: vscode.QuickPickItemKind.Separator };
                    return { label: t, description: t === editorTheme ? 'Current' : undefined };
                });
                theme = await vscode.window.showQuickPick(themeItems, { placeHolder: "Select Editor Theme" });
                if (!theme) return;
            }
            handler.emit('theme', theme.label);
            Global.updateConfig('editorTheme', theme.label);
        }).on("saveOutline", (enable) => {
            config.update("openOutline", enable, true);
        }).on('developerTool', () => {
            vscode.commands.executeCommand('workbench.action.toggleDevTools');
        });

        const basePath = Global.getConfig('workspacePathAsImageBasePath') ?
            vscode.Uri.file(getWorkspacePath(folderPath)) : folderPath;
        const baseUrl = webview.asWebviewUri(basePath).toString().replace(/\?.+$/, '').replace('https://git', 'https://file');
        webview.html = Util.buildPath(
            readFileSync(`${this.extensionPath}/resource/vditor/index.html`, 'utf8')
                .replace("{{rootPath}}", rootPath)
                .replace("{{baseUrl}}", baseUrl)
                .replace(`{{configs}}`, JSON.stringify({
                    platform: platform()
                })),
            webview, contextPath);
    }

    private updateCount(content: string) {
        this.countStatus.text = `Line ${content.split(/\r\n|\r|\n/).length}    Count ${content.length}`;
    }

    private async saveFile(uri: vscode.Uri, content: string): Promise<void> {
        try {
            const encoder = new TextEncoder();
            await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
        } catch (e) {
            // Fallback to sync write for local files
            try {
                writeFileSync(uri.fsPath, content, 'utf8');
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to save file: ${err}`);
            }
        }
    }
}
