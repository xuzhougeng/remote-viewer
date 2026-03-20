import {
  ChangeEvent,
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition
} from "react";
import { HtmlPreview } from "./components/HtmlPreview";
import { ImagePreview } from "./components/ImagePreview";
import { PdfPreview } from "./components/PdfPreview";
import { TextPreview } from "./components/TextPreview";
import type {
  ActiveSession,
  ConnectionConfig,
  ConnectionSessionResponse,
  RemoteEntry,
  SavedConnectionProfile
} from "./types";

type ThemeMode = "light" | "dark";

const defaultForm: ConnectionConfig = {
  authMethod: "key",
  host: "",
  password: "",
  privateKey: "",
  port: "22",
  rememberPassword: true,
  rootPath: "/",
  username: ""
};

const passwordStoragePrefix = "remote-viewer.password.";
const themeStorageKey = "remote-viewer.theme";
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

function buildDownloadUrl(session: ActiveSession, remotePath: string): string {
  return `/api/download?${buildSessionQuery(session, {
    path: remotePath
  })}`;
}

function isPasswordRelatedError(message: string): boolean {
  return /密码|认证|authentication|permission denied/i.test(message);
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

function readStoredTheme(): ThemeMode {
  const storedTheme = window.localStorage.getItem(themeStorageKey);
  return storedTheme === "dark" ? "dark" : "light";
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const privateKeyFileInputRef = useRef<HTMLInputElement | null>(null);
  const [form, setForm] = useState(defaultForm);
  const [theme, setTheme] = useState<ThemeMode>(() => readStoredTheme());
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [savedProfiles, setSavedProfiles] = useState<SavedConnectionProfile[]>(
    []
  );
  const [currentDir, setCurrentDir] = useState("");
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<RemoteEntry | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [error, setError] = useState("");
  const [profilesError, setProfilesError] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [isLoadingDir, setIsLoadingDir] = useState(false);
  const [isLoadingProfiles, setIsLoadingProfiles] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [fitToWidth, setFitToWidth] = useState(true);
  const [pathDraft, setPathDraft] = useState(defaultForm.rootPath);
  const [hideDotFiles, setHideDotFiles] = useState(true);
  const [fileFilter, setFileFilter] = useState("");
  const [transferNotice, setTransferNotice] = useState("");
  const [transferError, setTransferError] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [isConnectionPanelCollapsed, setIsConnectionPanelCollapsed] =
    useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    void loadSavedProfiles();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(themeStorageKey, theme);
  }, [theme]);

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

  async function loadSavedProfiles(nextSelectedProfileId?: string) {
    setIsLoadingProfiles(true);
    setProfilesError("");

    try {
      const payload = await requestJson<{ profiles: SavedConnectionProfile[] }>(
        "/api/profiles"
      );
      setSavedProfiles(payload.profiles);

      if (typeof nextSelectedProfileId === "string") {
        setSelectedProfileId(
          payload.profiles.some((profile) => profile.id === nextSelectedProfileId)
            ? nextSelectedProfileId
            : ""
        );
      }
    } catch (loadError) {
      setProfilesError(
        loadError instanceof Error ? loadError.message : "应用内 SSH 配置读取失败"
      );
    } finally {
      setIsLoadingProfiles(false);
    }
  }

  function applySavedProfile(profileId: string) {
    setSelectedProfileId(profileId);
    setProfilesError("");

    const profile = savedProfiles.find((item) => item.id === profileId);

    if (!profile) {
      return;
    }

    setForm((value) => ({
      ...value,
      authMethod: profile.authMethod,
      host: profile.host,
      password:
        profile.authMethod === "password"
          ? readStoredPassword(profile.host, profile.username) || ""
          : "",
      privateKey: profile.privateKey,
      port: profile.port,
      rootPath: profile.rootPath,
      username: profile.username
    }));
    setPathDraft(profile.rootPath);
  }

  async function saveCurrentProfile() {
    const suggestedName =
      savedProfiles.find((profile) => profile.id === selectedProfileId)?.name ||
      (form.username && form.host
        ? `${form.username}@${form.host}`
        : form.host || "新连接");
    const name = window.prompt("给这条连接配置起个名字", suggestedName)?.trim();

    if (!name) {
      return;
    }

    setProfilesError("");

    try {
      const payload = await requestJson<{ profile: SavedConnectionProfile }>(
        "/api/profiles",
        {
          body: JSON.stringify({
            authMethod: form.authMethod,
            host: form.host,
            id: selectedProfileId || undefined,
            name,
            port: form.port,
            privateKey: form.authMethod === "key" ? form.privateKey : "",
            rootPath: form.rootPath,
            username: form.username
          }),
          headers: {
            "Content-Type": "application/json"
          },
          method: "POST"
        }
      );

      await loadSavedProfiles(payload.profile.id);
    } catch (saveError) {
      setProfilesError(
        saveError instanceof Error ? saveError.message : "应用内 SSH 配置保存失败"
      );
    }
  }

  async function deleteSavedProfile() {
    const targetProfile = savedProfiles.find(
      (profile) => profile.id === selectedProfileId
    );

    if (!targetProfile) {
      return;
    }

    if (!window.confirm(`删除应用内配置“${targetProfile.name}”？`)) {
      return;
    }

    setProfilesError("");

    try {
      await requestJson(
        `/api/profiles/${encodeURIComponent(targetProfile.id)}`,
        {
          method: "DELETE"
        }
      );

      await loadSavedProfiles("");
    } catch (deleteError) {
      setProfilesError(
        deleteError instanceof Error ? deleteError.message : "应用内 SSH 配置删除失败"
      );
    }
  }

  async function handlePrivateKeyFileChange(
    event: ChangeEvent<HTMLInputElement>
  ) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    try {
      const privateKey = await file.text();
      setForm((value) => ({
        ...value,
        privateKey
      }));
      setError("");
    } finally {
      event.target.value = "";
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
  ): Promise<{ currentDir: string; entries: RemoteEntry[] } | null> {
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

      return payload;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "目录读取失败");
      return null;
    } finally {
      setIsLoadingDir(false);
    }
  }

  async function uploadRemoteFile(
    session: ActiveSession,
    dir: string,
    file: File,
    overwrite = false
  ): Promise<void> {
    const response = await fetch(
      `/api/upload?${buildSessionQuery(session, {
        dir,
        filename: file.name,
        overwrite: overwrite ? "1" : "0"
      })}`,
      {
        body: file,
        headers: file.type
          ? {
              "Content-Type": file.type
            }
          : undefined,
        method: "POST"
      }
    );

    if (response.ok) {
      return;
    }

    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    const uploadError = new Error(
      payload?.error || `上传失败: ${response.status}`
    ) as Error & { status?: number };

    uploadError.status = response.status;
    throw uploadError;
  }

  async function handleConnect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsConnecting(true);
    setError("");
    setTransferNotice("");
    setTransferError("");

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
            privateKey:
              form.authMethod === "key" ? form.privateKey : undefined,
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

  async function handleUploadChange(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files || [])];

    if (!activeSession || !currentDir || !files.length) {
      event.target.value = "";
      return;
    }

    setIsUploading(true);
    setTransferError("");
    setTransferNotice("");

    try {
      for (const [index, file] of files.entries()) {
        setTransferNotice(
          `正在上传 ${file.name} (${index + 1}/${files.length})`
        );

        try {
          await uploadRemoteFile(activeSession, currentDir, file);
        } catch (error) {
          const candidate = error as Error & { status?: number };

          if (
            candidate.status === 409 &&
            window.confirm(`远程已存在 ${file.name}，是否覆盖？`)
          ) {
            await uploadRemoteFile(activeSession, currentDir, file, true);
            continue;
          }

          throw error;
        }
      }

      const refreshed = await loadDirectory(activeSession, currentDir);

      if (files.length === 1 && refreshed) {
        const uploadedEntry = refreshed.entries.find(
          (entry) => entry.kind === "file" && entry.name === files[0].name
        );

        if (uploadedEntry) {
          setSelectedFile(uploadedEntry);
        }
      }

      setTransferNotice(
        files.length === 1
          ? `已上传 ${files[0].name}`
          : `已上传 ${files.length} 个文件`
      );
    } catch (uploadError) {
      setTransferError(
        uploadError instanceof Error ? uploadError.message : "文件上传失败"
      );
      setTransferNotice("");
    } finally {
      event.target.value = "";
      setIsUploading(false);
    }
  }

  function handleDownloadSelectedFile() {
    if (!activeSession || !selectedFile) {
      return;
    }

    const link = document.createElement("a");
    link.href = buildDownloadUrl(activeSession, selectedFile.path);
    link.download = selectedFile.name;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
    setTransferError("");
    setTransferNotice(`已开始下载 ${selectedFile.name}`);
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
  const selectedProfile = savedProfiles.find(
    (profile) => profile.id === selectedProfileId
  );
  const sessionSummary = activeSession
    ? `${activeSession.username}@${activeSession.hostname}:${activeSession.port}`
    : "";
  const isBusy = isConnecting || isLoadingDir;
  const connectionSummary = activeSession
    ? sessionSummary
    : selectedProfile
      ? `已选择配置：${selectedProfile.name}`
      : "先填写 SSH 连接信息，再读取远程目录";
  const browserPathLabel = currentDir || "-";
  const selectedFilePath = selectedFile ? selectedFile.path : "尚未选择文件";
  const passwordStatus = form.authMethod !== "password"
    ? ""
    : isConnecting
      ? "正在校验用户名和密码…"
      : error && isPasswordRelatedError(error)
        ? error
        : form.password
          ? "点击“连接并读取目录”后会立即校验密码。"
          : "请输入 SSH 密码。";
  const isPasswordStatusError =
    !isConnecting && Boolean(error) && isPasswordRelatedError(error);

  return (
    <div className={`shell theme-${theme}`}>
      <header className="topbar">
        <div className="topbar-copy">
          <p className="eyebrow">SSH Remote Viewer</p>
            <div className="topbar-headline">
              <h1>远程文件浏览器</h1>
              <div className="topbar-controls">
                <div className="topbar-pills">
                  <span>SSH2</span>
                  <span>Key / Password</span>
                  <span>上传 · 下载 · 预览</span>
                </div>
                <button
                  className="theme-toggle"
                  onClick={() =>
                    setTheme((value) => (value === "light" ? "dark" : "light"))
                  }
                  type="button"
                >
                  {theme === "light" ? "切到深色" : "切到浅色"}
                </button>
              </div>
            </div>
            <p className="topbar-note">
            通过 `ssh2` 建立远程会话，连接配置和 SSH Key 由应用自己管理，不再依赖本机 `.ssh` 配置；同时支持上传、下载和多种文件预览。
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
                  <span>应用内配置</span>
                  <div className="connection-actions">
                    <select
                      onChange={(event) => {
                        applySavedProfile(event.target.value);
                      }}
                      value={selectedProfileId}
                    >
                      <option value="">
                        {isLoadingProfiles
                          ? "正在读取应用内配置"
                          : savedProfiles.length
                            ? "选择已保存连接配置"
                            : "还没有保存的连接配置"}
                      </option>
                      {savedProfiles.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => {
                        void loadSavedProfiles(selectedProfileId);
                      }}
                      type="button"
                    >
                      刷新
                    </button>
                  </div>
                </label>
                <div className="connection-actions">
                  <button onClick={() => void saveCurrentProfile()} type="button">
                    保存配置
                  </button>
                  <button
                    disabled={!selectedProfileId}
                    onClick={() => void deleteSavedProfile()}
                    type="button"
                  >
                    删除配置
                  </button>
                </div>
                <label>
                  <span>Host</span>
                  <input
                    onChange={(event) =>
                      setForm((value) => ({
                        ...value,
                        host: event.target.value
                      }))
                    }
                    placeholder="server-01.example.com"
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
                      <small
                        className={`field-note ${
                          isPasswordStatusError ? "is-error" : ""
                        }`}
                      >
                        {passwordStatus}
                      </small>
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
                ) : (
                  <>
                    <label>
                      <span>Private Key</span>
                      <textarea
                        className="multiline-input"
                        onChange={(event) =>
                          setForm((value) => ({
                            ...value,
                            privateKey: event.target.value
                          }))
                        }
                        placeholder="粘贴 OpenSSH 私钥内容"
                        rows={8}
                        value={form.privateKey}
                      />
                      <div className="connection-actions">
                        <button
                          onClick={() => privateKeyFileInputRef.current?.click()}
                          type="button"
                        >
                          导入私钥文件
                        </button>
                        <button
                          disabled={!form.privateKey}
                          onClick={() =>
                            setForm((value) => ({
                              ...value,
                              privateKey: ""
                            }))
                          }
                          type="button"
                        >
                          清空
                        </button>
                      </div>
                      <small className="field-note">
                        只使用应用内维护的 SSH Key，不再读取本机
                        `~/.ssh/config`、IdentityFile 或 SSH Agent。
                      </small>
                    </label>
                    <input
                      className="hidden-file-input"
                      onChange={handlePrivateKeyFileChange}
                      ref={privateKeyFileInputRef}
                      type="file"
                    />
                  </>
                )}
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
                      setTransferNotice("");
                      setTransferError("");
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
                  应用内配置会单独保存在 `~/.remote-viewer/profiles.json`，
                  与本机 `.ssh` 配置隔离。密码模式下仍可把密码保存在本机浏览器
                  `localStorage`，共用电脑时不建议开启。
                </p>
              </>
            ) : null}
            {profilesError ? <div className="panel-error">{profilesError}</div> : null}
            {error ? <div className="panel-error">{error}</div> : null}
            {selectedProfile ? (
              <div className="config-summary">
                <strong>{selectedProfile.name}</strong>
                <span>
                  {selectedProfile.username}@{selectedProfile.host}:
                  {selectedProfile.port}
                </span>
                <small>
                  {selectedProfile.authMethod === "password"
                    ? "Password"
                    : "SSH Key"}
                </small>
                <small>{selectedProfile.rootPath}</small>
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
                <button
                  disabled={!activeSession || !currentDir || isUploading}
                  onClick={() => fileInputRef.current?.click()}
                  type="button"
                >
                  {isUploading ? "上传中" : "上传文件"}
                </button>
              </div>
            </div>

            <input
              className="hidden-file-input"
              multiple
              onChange={handleUploadChange}
              ref={fileInputRef}
              type="file"
            />

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

            {transferError ? (
              <div className="panel-error transfer-feedback">{transferError}</div>
            ) : null}
            {!transferError && transferNotice ? (
              <div className="transfer-feedback">{transferNotice}</div>
            ) : null}

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
                onClick={handleDownloadSelectedFile}
                type="button"
              >
                下载
              </button>
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
