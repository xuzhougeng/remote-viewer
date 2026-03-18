import { FormEvent, useEffect, useMemo, useState, useTransition } from "react";
import { HtmlPreview } from "./components/HtmlPreview";
import { ImagePreview } from "./components/ImagePreview";
import { PdfPreview } from "./components/PdfPreview";
import { TextPreview } from "./components/TextPreview";
import type {
  ActiveSession,
  ConfiguredSshHost,
  ConnectionConfig,
  ConnectionSessionResponse,
  RemoteEntry,
  ResolvedSshHost
} from "./types";

const defaultForm: ConnectionConfig = {
  authMethod: "key",
  host: "",
  password: "",
  port: "22",
  rememberPassword: true,
  rootPath: "/",
  username: ""
};

const passwordStoragePrefix = "remote-viewer.password.";
const knownTextExtensions = new Set([
  "c",
  "cc",
  "conf",
  "cpp",
  "cst",
  "css",
  "csv",
  "env",
  "go",
  "h",
  "hpp",
  "htm",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsx",
  "log",
  "md",
  "py",
  "r",
  "rs",
  "sh",
  "sql",
  "svg",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
  "zsh"
]);
const knownTextFileNames = new Set([
  ".bashrc",
  ".env",
  ".gitconfig",
  ".gitignore",
  ".npmrc",
  ".zshrc",
  "dockerfile",
  "makefile",
  "readme",
  "readme.md"
]);

function buildSessionQuery(
  session: ActiveSession,
  extra: Record<string, string>
): string {
  const params = new URLSearchParams({
    sessionId: session.sessionId,
    ...extra
  });

  return params.toString();
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(payload?.error || `请求失败: ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function dirname(remotePath: string): string {
  if (remotePath === "/") {
    return "/";
  }

  const normalized = remotePath.endsWith("/")
    ? remotePath.slice(0, -1)
    : remotePath;
  const index = normalized.lastIndexOf("/");

  if (index <= 0) {
    return "/";
  }

  return normalized.slice(0, index);
}

function formatSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) {
    return "-";
  }

  const units = ["B", "KB", "MB", "GB"];
  let current = size;
  let unit = units[0];

  for (const nextUnit of units) {
    unit = nextUnit;

    if (current < 1024 || nextUnit === units[units.length - 1]) {
      break;
    }

    current /= 1024;
  }

  return `${current.toFixed(current >= 100 || unit === "B" ? 0 : 1)} ${unit}`;
}

function createPasswordStorageKey(host: string, username: string): string {
  const normalizedHost = host.trim();
  const normalizedUsername = username.trim();

  if (!normalizedHost || !normalizedUsername) {
    return "";
  }

  return `${passwordStoragePrefix}${normalizedHost}@@${normalizedUsername}`;
}

function readStoredPassword(host: string, username: string): string | null {
  const key = createPasswordStorageKey(host, username);

  if (!key) {
    return null;
  }

  return window.localStorage.getItem(key);
}

function saveStoredPassword(
  host: string,
  username: string,
  password: string
): void {
  const key = createPasswordStorageKey(host, username);

  if (!key) {
    return;
  }

  window.localStorage.setItem(key, password);
}

function removeStoredPassword(host: string, username: string): void {
  const key = createPasswordStorageKey(host, username);

  if (!key) {
    return;
  }

  window.localStorage.removeItem(key);
}

function isTextLikeEntry(entry: RemoteEntry): boolean {
  if (entry.kind !== "file") {
    return false;
  }

  const extension = entry.extension?.toLowerCase();

  if (extension && knownTextExtensions.has(extension)) {
    return true;
  }

  return knownTextFileNames.has(entry.name.toLowerCase());
}

function isHtmlEntry(entry: RemoteEntry): boolean {
  if (entry.kind !== "file") {
    return false;
  }

  const extension = entry.extension?.toLowerCase();
  return extension === "html" || extension === "htm";
}

function buildHtmlPreviewUrl(session: ActiveSession, remotePath: string): string {
  const normalized = remotePath.startsWith("/") ? remotePath : `/${remotePath}`;
  const encodedPath = normalized
    .split("/")
    .map((segment, index) =>
      index === 0 ? "" : encodeURIComponent(segment)
    )
    .join("/");

  return `/api/html-preview/${encodeURIComponent(session.sessionId)}${encodedPath}`;
}

function formatEntryBadge(entry: RemoteEntry): string {
  if (entry.kind === "directory") {
    return "DIR";
  }

  if (!entry.extension) {
    return "FILE";
  }

  return entry.extension.slice(0, 4).toUpperCase();
}

function formatEntrySummary(entry: RemoteEntry): string {
  if (entry.kind === "directory") {
    return "目录";
  }

  if (entry.extension === "pdf") {
    return `PDF · ${formatSize(entry.size)}`;
  }

  if (entry.extension === "png") {
    return `PNG · ${formatSize(entry.size)}`;
  }

  if (isHtmlEntry(entry)) {
    return `网页 · ${formatSize(entry.size)}`;
  }

  if (isTextLikeEntry(entry)) {
    return `文本 · ${formatSize(entry.size)}`;
  }

  return `${entry.extension?.toUpperCase() || "文件"} · ${formatSize(entry.size)}`;
}

export default function App() {
  const [form, setForm] = useState(defaultForm);
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [configuredHosts, setConfiguredHosts] = useState<ConfiguredSshHost[]>([]);
  const [currentDir, setCurrentDir] = useState("");
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<RemoteEntry | null>(null);
  const [selectedAlias, setSelectedAlias] = useState("");
  const [resolvedHost, setResolvedHost] = useState<ResolvedSshHost | null>(null);
  const [error, setError] = useState("");
  const [hostsError, setHostsError] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [isLoadingDir, setIsLoadingDir] = useState(false);
  const [isLoadingHosts, setIsLoadingHosts] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [fitToWidth, setFitToWidth] = useState(true);
  const [pathDraft, setPathDraft] = useState(defaultForm.rootPath);
  const [hideDotFiles, setHideDotFiles] = useState(true);
  const [fileFilter, setFileFilter] = useState("");
  const [isConnectionPanelCollapsed, setIsConnectionPanelCollapsed] =
    useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    void loadConfiguredHosts();
  }, []);

  useEffect(() => {
    if (form.authMethod !== "password") {
      return;
    }

    const storedPassword = readStoredPassword(form.host, form.username) || "";

    setForm((value) => {
      if (
        value.authMethod !== "password" ||
        value.host !== form.host ||
        value.username !== form.username
      ) {
        return value;
      }

      const nextRememberPassword = storedPassword
        ? true
        : value.rememberPassword;

      if (
        value.password === storedPassword &&
        value.rememberPassword === nextRememberPassword
      ) {
        return value;
      }

      return {
        ...value,
        password: storedPassword,
        rememberPassword: nextRememberPassword
      };
    });
  }, [form.authMethod, form.host, form.username]);

  async function loadConfiguredHosts() {
    setIsLoadingHosts(true);
    setHostsError("");

    try {
      const payload = await requestJson<{ hosts: ConfiguredSshHost[] }>(
        "/api/ssh/hosts"
      );
      setConfiguredHosts(payload.hosts);
    } catch (loadError) {
      setHostsError(
        loadError instanceof Error ? loadError.message : "SSH 配置读取失败"
      );
    } finally {
      setIsLoadingHosts(false);
    }
  }

  async function applyConfiguredHost(alias: string) {
    setSelectedAlias(alias);
    setHostsError("");

    if (!alias) {
      setResolvedHost(null);
      return;
    }

    try {
      const payload = await requestJson<ResolvedSshHost>(
        `/api/ssh/resolve?alias=${encodeURIComponent(alias)}`
      );

      setResolvedHost(payload);
      setForm((value) => ({
        ...value,
        host: alias,
        port: payload.port || value.port || "22",
        username: payload.user || value.username
      }));
    } catch (loadError) {
      setHostsError(
        loadError instanceof Error ? loadError.message : "SSH 配置解析失败"
      );
    }
  }

  async function deleteSession(sessionId: string) {
    try {
      await fetch(`/api/session/${encodeURIComponent(sessionId)}`, {
        method: "DELETE"
      });
    } catch {
      // Ignore local cleanup failures.
    }
  }

  async function loadDirectory(
    session: ActiveSession,
    dir: string,
    options?: { clearSelection?: boolean }
  ) {
    setIsLoadingDir(true);
    setError("");

    try {
      const payload = await requestJson<{
        currentDir: string;
        entries: RemoteEntry[];
      }>(`/api/list?${buildSessionQuery(session, { dir })}`);

      startTransition(() => {
        setActiveSession(session);
        setCurrentDir(payload.currentDir);
        setEntries(payload.entries);
        setFileFilter("");
        setPathDraft(payload.currentDir);

        if (options?.clearSelection) {
          setSelectedFile(null);
        }
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "目录读取失败");
    } finally {
      setIsLoadingDir(false);
    }
  }

  async function handleConnect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsConnecting(true);
    setError("");

    const previousSessionId = activeSession?.sessionId;

    try {
      const payload = await requestJson<ConnectionSessionResponse>(
        "/api/session",
        {
          body: JSON.stringify({
            authMethod: form.authMethod,
            host: form.host,
            password:
              form.authMethod === "password" ? form.password : undefined,
            port: form.port,
            username: form.username
          }),
          headers: {
            "Content-Type": "application/json"
          },
          method: "POST"
        }
      );

      if (form.authMethod === "password") {
        if (form.rememberPassword) {
          saveStoredPassword(form.host, payload.username, form.password);
        } else {
          removeStoredPassword(form.host, payload.username);
        }
      }

      const nextSession: ActiveSession = {
        authMethod: payload.authMethod,
        host: form.host,
        hostname: payload.hostname,
        port: String(payload.port),
        rootPath: form.rootPath,
        sessionId: payload.sessionId,
        username: payload.username
      };

      setForm((value) => ({
        ...value,
        password: value.authMethod === "password" ? value.password : "",
        port: String(payload.port),
        username: payload.username
      }));

      startTransition(() => {
        setActiveSession(nextSession);
        setCurrentDir("");
        setEntries([]);
        setFileFilter("");
        setPathDraft(form.rootPath);
        setSelectedFile(null);
      });

      await loadDirectory(nextSession, form.rootPath, { clearSelection: true });
      setIsConnectionPanelCollapsed(true);

      if (previousSessionId && previousSessionId !== nextSession.sessionId) {
        void deleteSession(previousSessionId);
      }
    } catch (connectError) {
      setError(
        connectError instanceof Error ? connectError.message : "连接失败"
      );
    } finally {
      setIsConnecting(false);
    }
  }

  function handlePathSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!activeSession) {
      return;
    }

    const nextDir =
      pathDraft.trim() || currentDir || activeSession.rootPath || "/";

    void loadDirectory(activeSession, nextDir, { clearSelection: true });
  }

  const selectedPreviewKind = !selectedFile
    ? null
    : selectedFile.extension?.toLowerCase() === "pdf"
      ? "pdf"
      : selectedFile.extension?.toLowerCase() === "png"
        ? "image"
        : isHtmlEntry(selectedFile)
          ? "html"
        : "text";
  const viewerUrl = useMemo(() => {
    if (!activeSession || !selectedFile) {
      return "";
    }

    return `/api/file?${buildSessionQuery(activeSession, {
      path: selectedFile.path
    })}`;
  }, [activeSession, selectedFile]);
  const textPreviewUrl = useMemo(() => {
    if (!activeSession || !selectedFile) {
      return "";
    }

    return `/api/text?${buildSessionQuery(activeSession, {
      path: selectedFile.path
    })}`;
  }, [activeSession, selectedFile]);
  const htmlPreviewUrl = useMemo(() => {
    if (!activeSession || !selectedFile) {
      return "";
    }

    return buildHtmlPreviewUrl(activeSession, selectedFile.path);
  }, [activeSession, selectedFile]);
  const normalizedFileFilter = fileFilter.trim().toLowerCase();

  const visibleEntries = useMemo(
    () =>
      entries.filter((entry) => {
        if (hideDotFiles && entry.name.startsWith(".")) {
          return false;
        }

        if (
          normalizedFileFilter &&
          !entry.name.toLowerCase().includes(normalizedFileFilter)
        ) {
          return false;
        }

        return true;
      }),
    [entries, hideDotFiles, normalizedFileFilter]
  );
  const emptyState = !activeSession
    ? "先建立 SSH 会话，再读取远程目录"
    : entries.length && !visibleEntries.length
      ? normalizedFileFilter
        ? "当前筛选条件下没有匹配项"
        : "当前目录只有点文件，关闭“隐藏点文件”后可查看"
      : "当前目录没有文件";
  const selectedConfiguredHost = configuredHosts.find(
    (item) => item.alias === selectedAlias
  );
  const resolvedSummary = resolvedHost
    ? [
        resolvedHost.user ? `${resolvedHost.user}@` : "",
        resolvedHost.hostname || resolvedHost.alias,
        resolvedHost.port ? `:${resolvedHost.port}` : ""
      ].join("")
    : "";
  const sessionSummary = activeSession
    ? `${activeSession.username}@${activeSession.hostname}:${activeSession.port}`
    : "";
  const isBusy = isConnecting || isLoadingDir;
  const connectionSummary = activeSession
    ? sessionSummary
    : "先填写 SSH 连接信息，再读取远程目录";
  const browserPathLabel = currentDir || "-";
  const selectedFilePath = selectedFile ? selectedFile.path : "尚未选择文件";

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-copy">
          <p className="eyebrow">SSH Remote Viewer</p>
            <div className="topbar-headline">
              <h1>远程文件浏览器</h1>
              <div className="topbar-pills">
                <span>SSH2</span>
                <span>Key / Password</span>
                <span>PDF · PNG · HTML · Text</span>
              </div>
            </div>
            <p className="topbar-note">
            通过 `ssh2` 建立远程会话，支持密码或 SSH Key 登录，优先优化图片和 PDF 的缩放体验，同时补充 HTML、文本和 CST 预览。
            </p>
          </div>
        </header>

      <main className="workspace">
        <section className="sidebar">
          <form
            className={`panel connection-panel light-panel ${
              isConnectionPanelCollapsed ? "is-collapsed" : ""
            }`}
            onSubmit={handleConnect}
          >
            <div className="panel-header">
              <div>
                <div className="section-title">连接参数</div>
                <div className="panel-subtitle" title={connectionSummary}>
                  {connectionSummary}
                </div>
              </div>
              <button
                onClick={() =>
                  setIsConnectionPanelCollapsed((value) => !value)
                }
                type="button"
              >
                {isConnectionPanelCollapsed ? "展开" : "收起"}
              </button>
            </div>

            {!isConnectionPanelCollapsed ? (
              <>
                <label>
                  <span>已配置主机</span>
                  <div className="connection-actions">
                    <select
                      onChange={(event) => {
                        void applyConfiguredHost(event.target.value);
                      }}
                      value={selectedAlias}
                    >
                      <option value="">
                        {isLoadingHosts
                          ? "正在读取 ~/.ssh/config"
                          : configuredHosts.length
                            ? "从 ~/.ssh/config 选择 Host"
                            : "未发现可用 Host，仍可手动输入"}
                      </option>
                      {configuredHosts.map((item) => (
                        <option key={item.alias} value={item.alias}>
                          {item.alias}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => {
                        void loadConfiguredHosts();
                      }}
                      type="button"
                    >
                      刷新
                    </button>
                  </div>
                </label>
                <label>
                  <span>Host / SSH Alias</span>
                  <input
                    onChange={(event) => {
                      setSelectedAlias("");
                      setResolvedHost(null);
                      setForm((value) => ({
                        ...value,
                        host: event.target.value
                      }));
                    }}
                    placeholder="server-01"
                    type="text"
                    value={form.host}
                  />
                </label>
                <div className="form-grid">
                  <label>
                    <span>Username</span>
                    <input
                      onChange={(event) =>
                        setForm((value) => ({
                          ...value,
                          username: event.target.value
                        }))
                      }
                      placeholder="root"
                      type="text"
                      value={form.username}
                    />
                  </label>
                  <label>
                    <span>Port</span>
                    <input
                      onChange={(event) =>
                        setForm((value) => ({
                          ...value,
                          port: event.target.value
                        }))
                      }
                      placeholder="22"
                      type="text"
                      value={form.port}
                    />
                  </label>
                </div>
                <label>
                  <span>认证方式</span>
                  <select
                    onChange={(event) =>
                      setForm((value) => ({
                        ...value,
                        authMethod:
                          event.target.value === "password" ? "password" : "key"
                      }))
                    }
                    value={form.authMethod}
                  >
                    <option value="key">SSH Key</option>
                    <option value="password">Password</option>
                  </select>
                </label>
                {form.authMethod === "password" ? (
                  <>
                    <label>
                      <span>Password</span>
                      <input
                        onChange={(event) =>
                          setForm((value) => ({
                            ...value,
                            password: event.target.value
                          }))
                        }
                        placeholder="输入 SSH 密码"
                        type="password"
                        value={form.password}
                      />
                    </label>
                    <label className="checkbox-row">
                      <input
                        checked={form.rememberPassword}
                        onChange={(event) =>
                          setForm((value) => ({
                            ...value,
                            rememberPassword: event.target.checked
                          }))
                        }
                        type="checkbox"
                      />
                      <span>把密码保存在本机浏览器</span>
                    </label>
                  </>
                ) : null}
                <label>
                  <span>Root Path</span>
                  <input
                    onChange={(event) =>
                      setForm((value) => ({
                        ...value,
                        rootPath: event.target.value
                      }))
                    }
                    placeholder="/data/reports"
                    type="text"
                    value={form.rootPath}
                  />
                </label>
                <div className="connection-actions">
                  <button
                    className="primary-button"
                    disabled={isBusy}
                    type="submit"
                  >
                    {isConnecting ? "连接中" : "连接并读取目录"}
                  </button>
                  <button
                    disabled={!activeSession}
                    onClick={() => {
                      if (!activeSession) {
                        return;
                      }

                      void deleteSession(activeSession.sessionId);
                      setActiveSession(null);
                      setCurrentDir("");
                      setEntries([]);
                      setFileFilter("");
                      setPathDraft(form.rootPath);
                      setSelectedFile(null);
                      setIsConnectionPanelCollapsed(false);
                    }}
                    type="button"
                  >
                    断开
                  </button>
                </div>
                <p className="hint">
                  网页会读取本机 `~/.ssh/config` 的 Host Alias。密码模式下可把密码保存在本机浏览器 `localStorage`，共用电脑时不建议开启。
                </p>
              </>
            ) : null}
            {hostsError ? <div className="panel-error">{hostsError}</div> : null}
            {error ? <div className="panel-error">{error}</div> : null}
            {resolvedHost ? (
              <div className="config-summary">
                <strong>{resolvedHost.alias}</strong>
                <span>{resolvedSummary}</span>
                {resolvedHost.identityFiles.length ? (
                  <small>
                    Key: {resolvedHost.identityFiles[0]}
                  </small>
                ) : null}
                {selectedConfiguredHost ? (
                  <small>{selectedConfiguredHost.source}</small>
                ) : null}
              </div>
            ) : null}
            {activeSession ? (
              <div className="session-summary">
                <strong>当前会话</strong>
                <span>{sessionSummary}</span>
                <small>
                  {activeSession.authMethod === "password"
                    ? "Password"
                    : "SSH Key"}
                </small>
              </div>
            ) : null}
          </form>

          <section className="panel browser-panel light-panel">
            <div className="browser-header">
              <div>
                <div className="section-title">远程文件</div>
                <div className="current-path" title={browserPathLabel}>
                  {browserPathLabel}
                </div>
              </div>
              <div className="browser-actions">
                <label className="checkbox-row compact-checkbox">
                  <input
                    checked={hideDotFiles}
                    onChange={(event) => setHideDotFiles(event.target.checked)}
                    type="checkbox"
                  />
                  <span>隐藏点文件</span>
                </label>
                <button
                  disabled={!activeSession || currentDir === "/" || !currentDir}
                  onClick={() => {
                    if (!activeSession) {
                      return;
                    }

                    void loadDirectory(activeSession, dirname(currentDir), {
                      clearSelection: true
                    });
                  }}
                  type="button"
                >
                  返回上级
                </button>
              </div>
            </div>

            <form className="path-bar" onSubmit={handlePathSubmit}>
              <input
                disabled={!activeSession}
                onChange={(event) => setPathDraft(event.target.value)}
                placeholder="/data/reports/project-a"
                type="text"
                value={pathDraft}
              />
              <button disabled={!activeSession || isLoadingDir} type="submit">
                跳转
              </button>
            </form>

            <div className="browser-tools">
              <input
                disabled={!activeSession}
                onChange={(event) => setFileFilter(event.target.value)}
                placeholder="筛选当前路径下的文件"
                type="text"
                value={fileFilter}
              />
              <span className="filter-count">{visibleEntries.length} 项</span>
            </div>

            <div className="file-list">
              {!visibleEntries.length ? (
                <div className="empty-state">{emptyState}</div>
              ) : null}

              {visibleEntries.map((entry) => {
                const isActive =
                  selectedFile?.path === entry.path && entry.kind === "file";

                return (
                  <button
                    className={`file-row ${isActive ? "is-active" : ""}`}
                    key={entry.path}
                    onClick={() => {
                      if (!activeSession) {
                        return;
                      }

                      if (entry.kind === "directory") {
                        void loadDirectory(activeSession, entry.path, {
                          clearSelection: true
                        });
                        return;
                      }

                      setSelectedFile(entry);
                      setZoom(1);
                      setFitToWidth(true);
                    }}
                    type="button"
                  >
                    <span className="file-icon">
                      {formatEntryBadge(entry)}
                    </span>
                    <span className="file-meta">
                      <strong>{entry.name}</strong>
                      <small>{formatEntrySummary(entry)}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        </section>

        <section className="viewer-column">
          <div className="panel viewer-toolbar light-panel">
            <div className="viewer-heading">
              <div className="section-title">预览区</div>
              <div className="viewer-file-name" title={selectedFilePath}>
                {selectedFilePath}
              </div>
            </div>
            <div className="viewer-controls">
              <button
                disabled={!selectedFile}
                onClick={() => setZoom((value) => Math.max(value - 0.1, 0.2))}
                type="button"
              >
                缩小
              </button>
              <button
                disabled={!selectedFile}
                onClick={() => setZoom(1)}
                type="button"
              >
                100%
              </button>
              <button
                disabled={!selectedFile}
                onClick={() => setZoom((value) => Math.min(value + 0.1, 4))}
                type="button"
              >
                放大
              </button>
              <button
                className={fitToWidth ? "is-toggled" : ""}
                disabled={!selectedFile}
                onClick={() => setFitToWidth((value) => !value)}
                type="button"
              >
                {fitToWidth ? "已适配宽度" : "适配宽度"}
              </button>
              <span className="zoom-badge">{Math.round(zoom * 100)}%</span>
            </div>
          </div>

          <section className="panel viewer-panel light-panel">
            {isPending ? <div className="viewer-status">目录状态更新中</div> : null}

            {!selectedFile ? (
              <div className="viewer-placeholder">
                选择左侧文件后，会在这里显示 PDF、PNG、HTML 或文本预览。
              </div>
            ) : selectedPreviewKind === "pdf" ? (
              <PdfPreview
                fileName={selectedFile.name}
                fileUrl={viewerUrl}
                fitToWidth={fitToWidth}
                zoom={zoom}
              />
            ) : selectedPreviewKind === "image" ? (
              <ImagePreview
                alt={selectedFile.name}
                fitToWidth={fitToWidth}
                src={viewerUrl}
                zoom={zoom}
              />
            ) : selectedPreviewKind === "html" ? (
              <HtmlPreview
                fileName={selectedFile.name}
                fileUrl={htmlPreviewUrl}
                fitToWidth={fitToWidth}
                zoom={zoom}
              />
            ) : (
              <TextPreview
                fileName={selectedFile.name}
                fileUrl={textPreviewUrl}
                fitToWidth={fitToWidth}
                zoom={zoom}
              />
            )}
          </section>
        </section>
      </main>
    </div>
  );
}
