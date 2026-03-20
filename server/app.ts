import express from "express";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import * as ssh2 from "ssh2";
import type {
  ClientChannel,
  ConnectConfig,
  FileEntryWithStats,
  SFTPWrapper,
  Stats
} from "ssh2";

type AuthMethod = "key" | "password";

type ConnectionConfig = {
  authMethod: AuthMethod;
  host: string;
  password?: string;
  privateKey?: string;
  port?: string;
  username?: string;
};

type TerminalExecRequest = {
  command: string;
  cwd: string;
  sessionId: string;
};

type TerminalExecResult = {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  stderr: string;
  stderrTruncated: boolean;
  stdout: string;
  stdoutTruncated: boolean;
  timedOut: boolean;
};

type RemoteEntry = {
  extension?: string;
  kind: "directory" | "file";
  name: string;
  path: string;
  size: number;
};

type ConfiguredSshHost = {
  alias: string;
  source: string;
};

type ResolvedSshHost = {
  alias: string;
  hostname?: string;
  identityFiles: string[];
  port?: string;
  user?: string;
};

type ResolvedConnectionTarget = {
  alias?: string;
  authMethod: AuthMethod;
  connectConfig: ConnectConfig;
  hostname: string;
  port: number;
  username: string;
  password?: string;
};

type SavedConnectionProfile = {
  authMethod: AuthMethod;
  createdAt: number;
  host: string;
  id: string;
  name: string;
  port: string;
  privateKey: string;
  rootPath: string;
  updatedAt: number;
  username: string;
};

type ServerOptions = {
  clientDist?: string | null;
  host?: string;
  port?: number;
};

type SessionRecord = {
  authMethod: AuthMethod;
  client: ssh2.Client;
  createdAt: number;
  hostname: string;
  id: string;
  lastUsedAt: number;
  port: number;
  username: string;
};

const defaultClientDist = path.resolve(process.cwd(), "dist");
const sessions = new Map<string, SessionRecord>();
const sessionTtlMs = 30 * 60 * 1000;
const largeTextPreviewThresholdBytes = 10 * 1024 * 1024;
const largeTextPreviewMaxBytes = 256 * 1024;
const largeTextPreviewMaxLines = 120;
const tablePreviewMaxRows = 10;
const appStorageDir = path.join(os.homedir(), ".remote-viewer");
const savedProfilesFilePath = path.join(appStorageDir, "profiles.json");
const terminalExecTimeoutMs = 20 * 1000;
const terminalOutputLimitBytes = 128 * 1024;

class AppError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
  }
}

function ensureAppStorageDir() {
  fs.mkdirSync(appStorageDir, {
    mode: 0o700,
    recursive: true
  });
}

function writeJsonFile(targetPath: string, content: unknown) {
  ensureAppStorageDir();
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;

  fs.writeFileSync(tempPath, `${JSON.stringify(content, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  fs.renameSync(tempPath, targetPath);
}

function readSavedConnectionProfiles(): SavedConnectionProfile[] {
  if (!fs.existsSync(savedProfilesFilePath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(savedProfilesFilePath, "utf8");
    const payload = JSON.parse(raw) as { profiles?: SavedConnectionProfile[] };
    const profiles = Array.isArray(payload.profiles) ? payload.profiles : [];

    return profiles.sort((left, right) =>
      left.name.localeCompare(right.name, "zh-CN", {
        numeric: true,
        sensitivity: "base"
      })
    );
  } catch (error) {
    throw asAppError(error, "应用内 SSH 配置读取失败");
  }
}

function writeSavedConnectionProfiles(profiles: SavedConnectionProfile[]) {
  writeJsonFile(savedProfilesFilePath, {
    profiles
  });
}

function normalizeSavedConnectionProfile(
  body: unknown
): Omit<SavedConnectionProfile, "createdAt" | "id" | "updatedAt"> & {
  id?: string;
} {
  const payload =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const authMethod =
    String(payload.authMethod || "key").trim() === "password"
      ? "password"
      : "key";
  const name = String(payload.name || "").trim();
  const host = String(payload.host || "").trim();
  const port = String(payload.port || "22").trim() || "22";
  const username = String(payload.username || "").trim();
  const rootPath = String(payload.rootPath || "/").trim() || "/";
  const privateKey = String(payload.privateKey || "");
  const id = String(payload.id || "").trim() || undefined;

  if (!name) {
    throw new AppError("请填写配置名称", 400);
  }

  if (!host) {
    throw new AppError("请填写 SSH 主机地址", 400);
  }

  if (!username) {
    throw new AppError("请填写 SSH 用户名", 400);
  }

  if (authMethod === "key" && !privateKey.trim()) {
    throw new AppError("SSH Key 配置需要填写私钥内容", 400);
  }

  return {
    authMethod,
    host,
    id,
    name,
    port,
    privateKey: authMethod === "key" ? privateKey : "",
    rootPath,
    username
  };
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();

  for (const session of sessions.values()) {
    if (now - session.lastUsedAt <= sessionTtlMs) {
      continue;
    }

    sessions.delete(session.id);
    session.client.end();
  }
}, 5 * 60 * 1000);

cleanupTimer.unref();

function resolveSshBinary(): string {
  if (process.platform !== "win32") {
    return "ssh";
  }

  const windowsDir = process.env.WINDIR || "C:\\Windows";
  const builtinPath = path.win32.join(
    windowsDir,
    "System32",
    "OpenSSH",
    "ssh.exe"
  );

  if (fs.existsSync(builtinPath)) {
    return builtinPath;
  }

  return "ssh";
}

function explainProcessError(error: Error): Error {
  const nodeError = error as NodeJS.ErrnoException;

  if (nodeError.code === "ENOENT") {
    if (process.platform === "win32") {
      return new Error(
        "未找到 ssh 客户端。Windows 请先启用 OpenSSH Client，或安装 OpenSSH/Git 并加入 PATH。"
      );
    }

    return new Error("未找到 ssh 客户端，请确认本机已安装 ssh。");
  }

  return error;
}

function asAppError(error: unknown, fallbackMessage: string): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof Error) {
    return new AppError(error.message || fallbackMessage, 502);
  }

  return new AppError(fallbackMessage, 502);
}

function stripInlineComment(line: string): string {
  let result = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (const character of line) {
    if (character === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (character === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    } else if (character === "#" && !inSingleQuote && !inDoubleQuote) {
      break;
    }

    result += character;
  }

  return result.trim();
}

function tokenizeConfigLine(line: string): string[] {
  const tokens: string[] = [];
  const matcher = /"([^"]*)"|'([^']*)'|(\S+)/g;

  for (const match of line.matchAll(matcher)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }

  return tokens;
}

function expandHomePath(targetPath: string): string {
  if (targetPath === "~") {
    return os.homedir();
  }

  if (targetPath.startsWith("~/") || targetPath.startsWith("~\\")) {
    return path.join(os.homedir(), targetPath.slice(2));
  }

  return targetPath;
}

function hasGlobPattern(value: string): boolean {
  return value.includes("*") || value.includes("?");
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  return new RegExp(`^${escaped}$`);
}

function expandIncludePattern(pattern: string, baseDir: string): string[] {
  const expandedPath = expandHomePath(pattern);
  const resolvedPath = path.isAbsolute(expandedPath)
    ? expandedPath
    : path.resolve(baseDir, expandedPath);

  if (!hasGlobPattern(resolvedPath)) {
    return fs.existsSync(resolvedPath) ? [resolvedPath] : [];
  }

  const includeDir = path.dirname(resolvedPath);

  if (!fs.existsSync(includeDir)) {
    return [];
  }

  const matcher = globToRegExp(path.basename(resolvedPath));

  return fs
    .readdirSync(includeDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && matcher.test(entry.name))
    .map((entry) => path.join(includeDir, entry.name))
    .sort((left, right) =>
      left.localeCompare(right, "en", { sensitivity: "base" })
    );
}

function collectConfiguredSshHosts(
  configPath: string,
  visited: Set<string>,
  hosts: Map<string, ConfiguredSshHost>
) {
  const resolvedConfigPath = path.resolve(configPath);

  if (visited.has(resolvedConfigPath) || !fs.existsSync(resolvedConfigPath)) {
    return;
  }

  visited.add(resolvedConfigPath);
  const baseDir = path.dirname(resolvedConfigPath);
  const lines = fs.readFileSync(resolvedConfigPath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmedLine = stripInlineComment(line);

    if (!trimmedLine) {
      continue;
    }

    const tokens = tokenizeConfigLine(trimmedLine);

    if (tokens.length < 2) {
      continue;
    }

    const keyword = tokens[0].toLowerCase();
    const values = tokens.slice(1);

    if (keyword === "include") {
      for (const pattern of values) {
        for (const includePath of expandIncludePattern(pattern, baseDir)) {
          collectConfiguredSshHosts(includePath, visited, hosts);
        }
      }

      continue;
    }

    if (keyword !== "host") {
      continue;
    }

    for (const alias of values) {
      if (!alias || alias.startsWith("!") || hasGlobPattern(alias)) {
        continue;
      }

      if (!hosts.has(alias)) {
        hosts.set(alias, {
          alias,
          source: resolvedConfigPath
        });
      }
    }
  }
}

function readConfiguredSshHosts(): ConfiguredSshHost[] {
  const hosts = new Map<string, ConfiguredSshHost>();
  const defaultConfigPath = path.join(os.homedir(), ".ssh", "config");

  collectConfiguredSshHosts(defaultConfigPath, new Set<string>(), hosts);

  return [...hosts.values()].sort((left, right) =>
    left.alias.localeCompare(right.alias, "zh-CN", {
      numeric: true,
      sensitivity: "base"
    })
  );
}

function collectLocalProcessOutput(
  command: string,
  args: string[]
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (error) => reject(explainProcessError(error)));
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(stderr || `本地 SSH 配置读取失败，退出码 ${String(code)}`)
      );
    });
  });
}

function parseResolvedSshHost(output: Buffer, alias: string): ResolvedSshHost {
  const resolved: ResolvedSshHost = {
    alias,
    identityFiles: []
  };

  for (const line of output.toString("utf8").split(/\r?\n/)) {
    const trimmedLine = line.trim();

    if (!trimmedLine) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf(" ");

    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).toLowerCase();
    const value = trimmedLine.slice(separatorIndex + 1).trim();

    if (!value) {
      continue;
    }

    if (key === "hostname") {
      resolved.hostname = value;
      continue;
    }

    if (key === "user") {
      resolved.user = value;
      continue;
    }

    if (key === "port") {
      resolved.port = value;
      continue;
    }

    if (
      key === "identityfile" &&
      value.toLowerCase() !== "none" &&
      !resolved.identityFiles.includes(value)
    ) {
      resolved.identityFiles.push(value);
    }
  }

  return resolved;
}

async function resolveConfiguredHost(alias: string): Promise<ResolvedSshHost> {
  const { stdout } = await collectLocalProcessOutput(resolveSshBinary(), [
    "-G",
    alias
  ]);

  return parseResolvedSshHost(stdout, alias);
}

async function resolveConfiguredHostSafely(
  alias: string
): Promise<ResolvedSshHost | null> {
  try {
    return await resolveConfiguredHost(alias);
  } catch {
    return null;
  }
}

function normalizeConnection(body: unknown): ConnectionConfig {
  const payload =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const authMethod =
    String(payload.authMethod || "key").trim() === "password"
      ? "password"
      : "key";
  const host = String(payload.host || "").trim();
  const port = String(payload.port || "").trim();
  const username = String(payload.username || "").trim();
  const password = String(payload.password || "");
  const privateKey = String(payload.privateKey || "");

  if (!host) {
    throw new AppError("缺少 SSH 主机信息", 400);
  }

  if (authMethod === "password" && !password) {
    throw new AppError("密码登录需要填写密码", 400);
  }

  if (authMethod === "key" && !privateKey.trim()) {
    throw new AppError("SSH Key 登录需要提供私钥内容", 400);
  }

  return {
    authMethod,
    host,
    password: password || undefined,
    privateKey: privateKey || undefined,
    port: port || undefined,
    username: username || undefined
  };
}

function resolvePort(portValue: string | undefined): number {
  const port = Number(portValue || 22);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new AppError("SSH 端口不合法", 400);
  }

  return port;
}

function resolvePrivateKey(
  resolvedHost: ResolvedSshHost | null
): Pick<ConnectConfig, "agent" | "privateKey"> {
  for (const candidate of resolvedHost?.identityFiles || []) {
    const expandedPath = expandHomePath(candidate);

    if (!fs.existsSync(expandedPath)) {
      continue;
    }

    return {
      privateKey: fs.readFileSync(expandedPath, "utf8")
    };
  }

  if (process.env.SSH_AUTH_SOCK) {
    return {
      agent: process.env.SSH_AUTH_SOCK
    };
  }

  throw new AppError(
    "未找到可用的 SSH 私钥。请在 ~/.ssh/config 中配置 IdentityFile，或切换到密码登录。",
    400
  );
}

async function resolveConnectionTarget(
  connection: ConnectionConfig
): Promise<ResolvedConnectionTarget> {
  const hostname = connection.host;
  const username = connection.username || "";
  const port = resolvePort(connection.port);

  if (!username) {
    throw new AppError("缺少 SSH 用户名", 400);
  }

  const connectConfig: ConnectConfig = {
    host: hostname,
    keepaliveCountMax: 3,
    keepaliveInterval: 10_000,
    port,
    readyTimeout: 15_000,
    username
  };

  if (connection.authMethod === "password") {
    connectConfig.password = connection.password;
    connectConfig.tryKeyboard = true;
  } else {
    connectConfig.privateKey = connection.privateKey;
  }

  return {
    authMethod: connection.authMethod,
    connectConfig,
    hostname,
    password: connection.password,
    port,
    username
  };
}

function escapePosixShellArgument(value: string): string {
  return "'".concat(value.replace(/'/g, "'\"'\"'"), "'");
}

function normalizeTerminalExecRequest(body: unknown): TerminalExecRequest {
  const payload =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const sessionId = String(payload.sessionId || "").trim();
  const command = String(payload.command || "").trim();
  const cwd = String(payload.cwd || ".").trim() || ".";

  if (!sessionId) {
    throw new AppError("缺少会话 ID", 400);
  }

  if (!command) {
    throw new AppError("请输入要执行的命令", 400);
  }

  return {
    command,
    cwd,
    sessionId
  };
}

type CapturedStreamState = {
  chunks: Buffer[];
  size: number;
  truncated: boolean;
};

function appendCapturedChunk(
  target: CapturedStreamState,
  chunk: Buffer | string,
  limit: number
) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

  if (!buffer.length) {
    return;
  }

  if (target.size >= limit) {
    target.truncated = true;
    return;
  }

  const remaining = limit - target.size;

  if (buffer.length > remaining) {
    target.chunks.push(buffer.subarray(0, remaining));
    target.size += remaining;
    target.truncated = true;
    return;
  }

  target.chunks.push(buffer);
  target.size += buffer.length;
}

function executeRemoteCommand(
  session: SessionRecord,
  request: TerminalExecRequest
): Promise<TerminalExecResult> {
  return new Promise((resolve, reject) => {
    const shellCommand = `cd -- ${escapePosixShellArgument(
      request.cwd
    )} && ${request.command}`;
    const stdoutState: CapturedStreamState = {
      chunks: [],
      size: 0,
      truncated: false
    };
    const stderrState: CapturedStreamState = {
      chunks: [],
      size: 0,
      truncated: false
    };
    let channel: ClientChannel | null = null;
    let exitCode: number | null = null;
    let signal: string | null = null;
    let settled = false;
    let timedOut = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      callback();
    };

    const timeout = setTimeout(() => {
      timedOut = true;

      if (!channel) {
        return;
      }

      try {
        channel.signal("TERM");
      } catch {
        // Ignore unsupported signal failures.
      }

      try {
        channel.close();
      } catch {
        // Ignore close failures triggered by closed channels.
      }
    }, terminalExecTimeoutMs);

    session.client.exec(
      `sh -lc ${escapePosixShellArgument(shellCommand)}`,
      (error, stream) => {
        if (error || !stream) {
          finish(() => reject(error || new Error("远程命令执行失败")));
          return;
        }

        channel = stream;
        stream.on("data", (chunk: Buffer | string) => {
          appendCapturedChunk(stdoutState, chunk, terminalOutputLimitBytes);
        });
        stream.stderr.on("data", (chunk: Buffer | string) => {
          appendCapturedChunk(stderrState, chunk, terminalOutputLimitBytes);
        });
        stream.on("exit", (...args: unknown[]) => {
          if (typeof args[0] === "number") {
            exitCode = args[0];
            signal = null;
            return;
          }

          exitCode = null;
          signal =
            typeof args[1] === "string"
              ? args[1]
              : typeof args[0] === "string"
                ? args[0]
                : null;
        });
        stream.on("error", (streamError: Error) => {
          finish(() => reject(streamError));
        });
        stream.on("close", () => {
          finish(() => {
            resolve({
              command: request.command,
              cwd: request.cwd,
              exitCode,
              signal,
              stderr: Buffer.concat(stderrState.chunks).toString("utf8"),
              stderrTruncated: stderrState.truncated,
              stdout: Buffer.concat(stdoutState.chunks).toString("utf8"),
              stdoutTruncated: stdoutState.truncated,
              timedOut
            });
          });
        });
      }
    );
  });
}

function openSftp(client: ssh2.Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error || !sftp) {
        reject(error || new Error("SFTP 初始化失败"));
        return;
      }

      resolve(sftp);
    });
  });
}

function sftpRealpath(sftp: SFTPWrapper, remotePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(remotePath, (error, absolutePath) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(absolutePath);
    });
  });
}

function sftpStat(sftp: SFTPWrapper, remotePath: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (error, stats) => {
      if (error || !stats) {
        reject(error || new Error("远程文件状态读取失败"));
        return;
      }

      resolve(stats);
    });
  });
}

function sftpReadDir(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<FileEntryWithStats[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (error, list) => {
      if (error || !list) {
        reject(error || new Error("远程目录读取失败"));
        return;
      }

      resolve(list);
    });
  });
}

function sftpUnlink(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(remotePath, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function isSftpNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { code?: number | string; message?: string };
  const message = candidate.message || "";

  return (
    candidate.code === 2 ||
    candidate.code === "ENOENT" ||
    /no such file/i.test(message)
  );
}

async function sftpPathExists(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<boolean> {
  try {
    await sftpStat(sftp, remotePath);
    return true;
  } catch (error) {
    if (isSftpNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}

function parseDirectoryListing(
  currentDir: string,
  entries: FileEntryWithStats[]
): RemoteEntry[] {
  const parsedEntries: RemoteEntry[] = [];

  for (const entry of entries) {
    if (entry.attrs.isDirectory()) {
      parsedEntries.push({
        kind: "directory",
        name: entry.filename,
        path: path.posix.join(currentDir, entry.filename),
        size: entry.attrs.size || 0
      });
      continue;
    }

    if (!entry.attrs.isFile()) {
      continue;
    }

    parsedEntries.push({
      extension: path.extname(entry.filename).toLowerCase().replace(/^\./, ""),
      kind: "file",
      name: entry.filename,
      path: path.posix.join(currentDir, entry.filename),
      size: entry.attrs.size || 0
    });
  }

  return parsedEntries.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "directory" ? -1 : 1;
    }

    return left.name.localeCompare(right.name, "zh-CN", {
      numeric: true,
      sensitivity: "base"
    });
  });
}

function readRemoteFileSlice(
  sftp: SFTPWrapper,
  remotePath: string,
  maxBytes: number
): Promise<Buffer> {
  if (maxBytes <= 0) {
    return Promise.resolve(Buffer.alloc(0));
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const stream = sftp.createReadStream(remotePath, {
      end: maxBytes - 1,
      start: 0
    });

    stream.on("data", (chunk: Buffer) => {
      total += chunk.length;
      chunks.push(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks, total)));
  });
}

function looksLikeBinaryContent(buffer: Buffer): boolean {
  if (!buffer.length) {
    return false;
  }

  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  let suspiciousBytes = 0;

  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }

    if (byte < 7 || (byte > 14 && byte < 32)) {
      suspiciousBytes += 1;
    }
  }

  return suspiciousBytes / sample.length > 0.1;
}

function takeLeadingLines(
  content: string,
  maxLines: number
): { content: string; truncated: boolean } {
  const lines = content.split(/\r?\n/);

  if (lines.length <= maxLines) {
    return {
      content,
      truncated: false
    };
  }

  return {
    content: lines.slice(0, maxLines).join("\n"),
    truncated: true
  };
}

function splitDelimitedLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === '"') {
      const nextCharacter = line[index + 1];

      if (inQuotes && nextCharacter === '"') {
        current += '"';
        index += 1;
        continue;
      }

      inQuotes = !inQuotes;
      continue;
    }

    if (character === delimiter && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }

    current += character;
  }

  cells.push(current);
  return cells;
}

function buildDelimitedPreview(
  content: string,
  delimiter: "," | "\t",
  maxRows: number
): { rows: string[][]; truncated: boolean } {
  const allLines = content.replace(/\r\n/g, "\n").split("\n");
  const previewLines = allLines.slice(0, maxRows);

  return {
    rows: previewLines.map((line) => splitDelimitedLine(line, delimiter)),
    truncated: allLines.length > maxRows
  };
}

function normalizeRemoteRoutePath(routePath: string): string {
  const normalized = routePath.startsWith("/")
    ? routePath
    : `/${routePath}`;

  return path.posix.normalize(normalized);
}

function normalizeUploadFileName(rawFileName: string): string {
  const normalized = rawFileName.trim().replace(/\\/g, "/");
  const fileName = path.posix.basename(normalized);

  if (!fileName || fileName === "." || fileName === "..") {
    throw new AppError("上传文件名不合法", 400);
  }

  return fileName;
}

function buildContentDispositionHeader(
  filename: string,
  dispositionType: "attachment" | "inline"
): string {
  const fallback = filename
    .replace(/[^\x20-\x7E]+/g, "_")
    .replace(/["\\]/g, "_")
    .trim();
  const safeFallback = fallback || "download";

  return `${dispositionType}; filename="${safeFallback}"; filename*=UTF-8''${encodeURIComponent(
    filename
  )}`;
}

function encodeRemotePathForPreview(remotePath: string): string {
  return normalizeRemoteRoutePath(remotePath)
    .split("/")
    .map((segment, index) =>
      index === 0 ? "" : encodeURIComponent(segment)
    )
    .join("/");
}

function buildHtmlPreviewProxyPath(
  sessionId: string,
  remotePath: string
): string {
  return `/api/html-preview/${encodeURIComponent(
    sessionId
  )}${encodeRemotePathForPreview(remotePath)}`;
}

function isSpecialUrlReference(value: string): boolean {
  return (
    !value ||
    value.startsWith("#") ||
    value.startsWith("//") ||
    /^[a-z][a-z\d+\-.]*:/i.test(value)
  );
}

function rewriteHtmlAbsoluteReference(
  value: string,
  sessionId: string
): string {
  if (!value.startsWith("/") || value.startsWith("//")) {
    return value;
  }

  return buildHtmlPreviewProxyPath(sessionId, value);
}

function rewriteHtmlBaseReference(
  value: string,
  sessionId: string,
  currentDir: string
): string {
  if (isSpecialUrlReference(value)) {
    return value;
  }

  const trailingSlash = value.endsWith("/") ? "/" : "";
  const resolvedPath = value.startsWith("/")
    ? normalizeRemoteRoutePath(value)
    : path.posix.normalize(path.posix.join(currentDir, value));

  const proxiedPath = buildHtmlPreviewProxyPath(sessionId, resolvedPath);
  return trailingSlash && !proxiedPath.endsWith("/")
    ? `${proxiedPath}/`
    : proxiedPath;
}

function rewriteHtmlSrcset(value: string, sessionId: string): string {
  return value
    .split(",")
    .map((entry) => {
      const trimmedEntry = entry.trim();

      if (!trimmedEntry) {
        return trimmedEntry;
      }

      const [rawUrl, ...descriptors] = trimmedEntry.split(/\s+/);

      if (!rawUrl.startsWith("/") || rawUrl.startsWith("//")) {
        return trimmedEntry;
      }

      return [rewriteHtmlAbsoluteReference(rawUrl, sessionId), ...descriptors]
        .join(" ")
        .trim();
    })
    .join(", ");
}

function rewriteHtmlPreviewDocument(
  content: string,
  sessionId: string,
  remotePath: string
): string {
  const currentDir = path.posix.dirname(remotePath);

  return content
    .replace(
      /<base\b([^>]*?)href=(["'])(.*?)\2([^>]*)>/gi,
      (_match, before, quote, href, after) =>
        `<base${before}href=${quote}${rewriteHtmlBaseReference(
          href,
          sessionId,
          currentDir
        )}${quote}${after}>`
    )
    .replace(/\bsrcset=(["'])(.*?)\1/gi, (_match, quote, value) => {
      return `srcset=${quote}${rewriteHtmlSrcset(value, sessionId)}${quote}`;
    })
    .replace(
      /\b(src|href|poster|action)=(["'])(.*?)\2/gi,
      (_match, attribute, quote, value) =>
        `${attribute}=${quote}${rewriteHtmlAbsoluteReference(
          value,
          sessionId
        )}${quote}`
    )
    .replace(
      /url\((["']?)\/(?!\/)([^)"']*)\1\)/gi,
      (_match, quote, relativePath) =>
        `url(${quote}${buildHtmlPreviewProxyPath(
          sessionId,
          `/${relativePath}`
        )}${quote})`
    );
}

function getRemoteContentType(remotePath: string): string {
  const extension = path.extname(remotePath).toLowerCase();

  switch (extension) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".csv":
      return "text/csv; charset=utf-8";
    case ".gif":
      return "image/gif";
    case ".htm":
    case ".html":
      return "text/html; charset=utf-8";
    case ".ico":
      return "image/x-icon";
    case ".jpeg":
    case ".jpg":
      return "image/jpeg";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".tsv":
      return "text/tab-separated-values; charset=utf-8";
    case ".txt":
    case ".log":
      return "text/plain; charset=utf-8";
    case ".wasm":
      return "application/wasm";
    case ".webp":
      return "image/webp";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".xml":
      return "application/xml; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function explainSshConnectError(
  error: Error,
  authMethod: AuthMethod
): Error {
  const rawMessage = error.message || "SSH 连接失败";
  const normalizedMessage = rawMessage.toLowerCase();

  if (
    authMethod === "password" &&
    (normalizedMessage.includes("all configured authentication methods failed") ||
      normalizedMessage.includes("authentication failed") ||
      normalizedMessage.includes("permission denied") ||
      normalizedMessage.includes("unable to authenticate"))
  ) {
    return new Error("用户名或密码错误，SSH 认证失败，请检查后重试。");
  }

  if (
    normalizedMessage.includes("timed out") ||
    normalizedMessage.includes("timeout")
  ) {
    return new Error("SSH 连接超时，请确认主机、端口和网络是否可达。");
  }

  if (
    normalizedMessage.includes("econnrefused") ||
    normalizedMessage.includes("connection refused")
  ) {
    return new Error("SSH 连接被拒绝，请确认端口是否正确且远端 SSH 服务已启动。");
  }

  if (
    normalizedMessage.includes("ehostunreach") ||
    normalizedMessage.includes("enetunreach") ||
    normalizedMessage.includes("getaddrinfo") ||
    normalizedMessage.includes("not known")
  ) {
    return new Error("无法连接到目标主机，请检查主机地址、DNS 和网络配置。");
  }

  return new Error(rawMessage);
}

function createSession(
  target: ResolvedConnectionTarget
): Promise<SessionRecord> {
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client();
    const sessionId = crypto.randomUUID();
    let settled = false;

    const fail = (error: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      client.end();
      reject(error);
    };

    client.on(
      "keyboard-interactive",
      (_name, _instructions, _lang, prompts, finish) => {
        if (target.authMethod !== "password" || !target.password) {
          finish([]);
          return;
        }

        finish(prompts.map(() => target.password || ""));
      }
    );

    client.on("ready", () => {
      if (settled) {
        return;
      }

      settled = true;
      const now = Date.now();
      const session: SessionRecord = {
        authMethod: target.authMethod,
        client,
        createdAt: now,
        hostname: target.hostname,
        id: sessionId,
        lastUsedAt: now,
        port: target.port,
        username: target.username
      };

      client.on("close", () => {
        if (sessions.get(sessionId)?.client === client) {
          sessions.delete(sessionId);
        }
      });

      sessions.set(sessionId, session);
      resolve(session);
    });

    client.on("error", (error) => {
      fail(explainSshConnectError(error, target.authMethod));
    });

    client.on("close", () => {
      if (!settled) {
        fail(
          target.authMethod === "password"
            ? new Error(
                "SSH 连接已关闭，可能是用户名或密码错误，也可能是远端直接拒绝了认证。"
              )
            : new Error("SSH 连接已关闭")
        );
      }
    });

    client.connect(target.connectConfig);
  });
}

function touchSession(session: SessionRecord) {
  session.lastUsedAt = Date.now();
}

function requireSession(sessionId: string): SessionRecord {
  const normalizedSessionId = sessionId.trim();

  if (!normalizedSessionId) {
    throw new AppError("缺少会话 ID", 400);
  }

  const session = sessions.get(normalizedSessionId);

  if (!session) {
    throw new AppError("SSH 会话不存在或已过期，请重新连接", 401);
  }

  touchSession(session);
  return session;
}

function destroySession(sessionId: string) {
  const session = sessions.get(sessionId);

  if (!session) {
    return;
  }

  sessions.delete(sessionId);
  session.client.end();
}

export function createRemoteViewerApp(
  clientDist: string | null = defaultClientDist
) {
  const app = express();

  app.post("/api/upload", async (request, response) => {
    let sftp: SFTPWrapper | null = null;
    let targetPath = "";
    let shouldCleanupPartial = false;

    try {
      const session = requireSession(String(request.query.sessionId || ""));
      const remoteDir = String(request.query.dir || "").trim();
      const requestedFileName = String(request.query.filename || "").trim();
      const overwrite = String(request.query.overwrite || "").trim() === "1";

      if (!remoteDir) {
        throw new AppError("缺少上传目录", 400);
      }

      if (!requestedFileName) {
        throw new AppError("缺少上传文件名", 400);
      }

      const fileName = normalizeUploadFileName(requestedFileName);

      sftp = await openSftp(session.client);

      const resolvedDir = await sftpRealpath(sftp, remoteDir);
      const dirStats = await sftpStat(sftp, resolvedDir);

      if (!dirStats.isDirectory()) {
        throw new AppError("目标不是可写目录", 400);
      }

      targetPath = path.posix.join(resolvedDir, fileName);

      if (!overwrite && (await sftpPathExists(sftp, targetPath))) {
        throw new AppError(`远程已存在同名文件: ${fileName}`, 409);
      }

      const remoteStream = sftp.createWriteStream(targetPath, {
        flags: "w",
        mode: 0o644
      });
      let transferredBytes = 0;

      request.on("data", (chunk: Buffer) => {
        transferredBytes += chunk.length;
      });

      shouldCleanupPartial = true;
      await pipeline(request, remoteStream);
      shouldCleanupPartial = false;

      response.status(201).json({
        fileName,
        path: targetPath,
        size: transferredBytes
      });
    } catch (error) {
      if (sftp && targetPath && shouldCleanupPartial) {
        try {
          await sftpUnlink(sftp, targetPath);
        } catch {
          // Ignore best-effort cleanup failures.
        }
      }

      const appError = asAppError(error, "远程文件上传失败");
      response.status(appError.statusCode).json({
        error: appError.message
      });
    } finally {
      sftp?.end();
    }
  });

  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.get("/api/ssh/hosts", (_request, response) => {
    response.status(410).json({
      error: "已停用本机 SSH 配置读取，请改用应用内保存的连接配置。"
    });
  });

  app.get("/api/ssh/resolve", (_request, response) => {
    response.status(410).json({
      error: "已停用本机 SSH 配置解析，请直接填写主机地址，或使用应用内保存的连接配置。"
    });
  });

  app.get("/api/profiles", (_request, response) => {
    response.json({
      profiles: readSavedConnectionProfiles()
    });
  });

  app.post("/api/profiles", (request, response) => {
    try {
      const draft = normalizeSavedConnectionProfile(request.body);
      const now = Date.now();
      const profiles = readSavedConnectionProfiles();
      const existingIndex = draft.id
        ? profiles.findIndex((profile) => profile.id === draft.id)
        : -1;

      const nextProfile: SavedConnectionProfile =
        existingIndex >= 0
          ? {
              ...profiles[existingIndex],
              ...draft,
              id: profiles[existingIndex].id,
              updatedAt: now
            }
          : {
              ...draft,
              createdAt: now,
              id: crypto.randomUUID(),
              updatedAt: now
            };

      if (existingIndex >= 0) {
        profiles.splice(existingIndex, 1, nextProfile);
      } else {
        profiles.push(nextProfile);
      }

      writeSavedConnectionProfiles(profiles);

      response.status(existingIndex >= 0 ? 200 : 201).json({
        profile: nextProfile
      });
    } catch (error) {
      const appError = asAppError(error, "应用内 SSH 配置保存失败");
      response.status(appError.statusCode).json({
        error: appError.message
      });
    }
  });

  app.delete("/api/profiles/:profileId", (request, response) => {
    try {
      const profileId = String(request.params.profileId || "").trim();

      if (!profileId) {
        throw new AppError("缺少配置 ID", 400);
      }

      const profiles = readSavedConnectionProfiles();
      const nextProfiles = profiles.filter((profile) => profile.id !== profileId);

      if (nextProfiles.length === profiles.length) {
        throw new AppError("应用内 SSH 配置不存在", 404);
      }

      writeSavedConnectionProfiles(nextProfiles);
      response.status(204).end();
    } catch (error) {
      const appError = asAppError(error, "应用内 SSH 配置删除失败");
      response.status(appError.statusCode).json({
        error: appError.message
      });
    }
  });

  app.post("/api/session", async (request, response) => {
    try {
      const connection = normalizeConnection(request.body);
      const target = await resolveConnectionTarget(connection);
      const session = await createSession(target);

      response.json({
        alias: target.alias,
        authMethod: target.authMethod,
        hostname: session.hostname,
        port: session.port,
        sessionId: session.id,
        username: session.username
      });
    } catch (error) {
      const appError = asAppError(error, "SSH 会话创建失败");
      response.status(appError.statusCode).json({
        error: appError.message
      });
    }
  });

  app.delete("/api/session/:sessionId", (request, response) => {
    destroySession(String(request.params.sessionId || "").trim());
    response.status(204).end();
  });

  app.post("/api/terminal/exec", async (request, response) => {
    try {
      const commandRequest = normalizeTerminalExecRequest(request.body);
      const session = requireSession(commandRequest.sessionId);
      const payload = await executeRemoteCommand(session, commandRequest);

      response.json(payload);
    } catch (error) {
      const appError = asAppError(error, "远程命令执行失败");
      response.status(appError.statusCode).json({
        error: appError.message
      });
    }
  });

  app.get("/api/list", async (request, response) => {
    let sftp: SFTPWrapper | null = null;

    try {
      const session = requireSession(String(request.query.sessionId || ""));
      const remoteDir = String(request.query.dir || "").trim() || ".";

      sftp = await openSftp(session.client);

      const currentDir = await sftpRealpath(sftp, remoteDir);
      const entries = await sftpReadDir(sftp, currentDir);

      response.json({
        currentDir,
        entries: parseDirectoryListing(currentDir, entries)
      });
    } catch (error) {
      const appError = asAppError(error, "目录读取失败");
      response.status(appError.statusCode).json({
        error: appError.message
      });
    } finally {
      sftp?.end();
    }
  });

  app.get("/api/file", async (request, response) => {
    let sftp: SFTPWrapper | null = null;

    try {
      const session = requireSession(String(request.query.sessionId || ""));
      const remotePath = String(request.query.path || "").trim();

      if (!remotePath) {
        throw new AppError("缺少文件路径", 400);
      }

      sftp = await openSftp(session.client);
      const resolvedPath = await sftpRealpath(sftp, remotePath);
      const fileStats = await sftpStat(sftp, resolvedPath);

      if (!fileStats.isFile()) {
        throw new AppError("目标不是可读取文件", 400);
      }

      const extension = path.extname(resolvedPath).toLowerCase();

      if (extension !== ".pdf" && extension !== ".png") {
        throw new AppError("仅支持 PDF 和 PNG 文件", 400);
      }

      const filename = path.basename(resolvedPath);
      const contentType =
        extension === ".pdf" ? "application/pdf" : "image/png";
      const fileStream = sftp.createReadStream(resolvedPath);
      let finished = false;

      const cleanup = () => {
        if (finished) {
          return;
        }

        finished = true;
        fileStream.destroy();
        sftp?.end();
      };

      response.setHeader("Content-Type", contentType);
      response.setHeader(
        "Content-Disposition",
        buildContentDispositionHeader(filename, "inline")
      );
      response.setHeader("Cache-Control", "no-store");

      fileStream.on("error", (error: Error) => {
        if (!response.headersSent) {
          const appError = asAppError(error, "远程文件读取失败");
          response.status(appError.statusCode).json({
            error: appError.message
          });
        } else {
          response.destroy(error);
        }

        cleanup();
      });

      response.on("close", cleanup);
      fileStream.on("close", cleanup);
      fileStream.pipe(response);
    } catch (error) {
      sftp?.end();

      const appError = asAppError(error, "远程文件读取失败");
      response.status(appError.statusCode).json({
        error: appError.message
      });
    }
  });

  app.get("/api/download", async (request, response) => {
    let sftp: SFTPWrapper | null = null;

    try {
      const session = requireSession(String(request.query.sessionId || ""));
      const remotePath = String(request.query.path || "").trim();

      if (!remotePath) {
        throw new AppError("缺少文件路径", 400);
      }

      sftp = await openSftp(session.client);
      const resolvedPath = await sftpRealpath(sftp, remotePath);
      const fileStats = await sftpStat(sftp, resolvedPath);

      if (!fileStats.isFile()) {
        throw new AppError("目标不是可下载文件", 400);
      }

      const filename = path.basename(resolvedPath);
      const fileStream = sftp.createReadStream(resolvedPath);
      let finished = false;

      const cleanup = () => {
        if (finished) {
          return;
        }

        finished = true;
        fileStream.destroy();
        sftp?.end();
      };

      response.setHeader("Content-Type", getRemoteContentType(resolvedPath));
      response.setHeader(
        "Content-Disposition",
        buildContentDispositionHeader(filename, "attachment")
      );
      response.setHeader("Content-Length", String(fileStats.size));
      response.setHeader("Cache-Control", "no-store");

      fileStream.on("error", (error: Error) => {
        if (!response.headersSent) {
          const appError = asAppError(error, "远程文件下载失败");
          response.status(appError.statusCode).json({
            error: appError.message
          });
        } else {
          response.destroy(error);
        }

        cleanup();
      });

      response.on("close", cleanup);
      fileStream.on("close", cleanup);
      fileStream.pipe(response);
    } catch (error) {
      sftp?.end();

      const appError = asAppError(error, "远程文件下载失败");
      response.status(appError.statusCode).json({
        error: appError.message
      });
    }
  });

  app.get("/api/text", async (request, response) => {
    let sftp: SFTPWrapper | null = null;

    try {
      const session = requireSession(String(request.query.sessionId || ""));
      const remotePath = String(request.query.path || "").trim();

      if (!remotePath) {
        throw new AppError("缺少文件路径", 400);
      }

      sftp = await openSftp(session.client);
      const resolvedPath = await sftpRealpath(sftp, remotePath);
      const fileStats = await sftpStat(sftp, resolvedPath);
      const extension = path
        .extname(resolvedPath)
        .toLowerCase()
        .replace(/^\./, "");

      if (!fileStats.isFile()) {
        throw new AppError("目标不是可读取文件", 400);
      }

      const isLargeText = fileStats.size > largeTextPreviewThresholdBytes;
      const bytesToRead = isLargeText
        ? largeTextPreviewMaxBytes
        : fileStats.size;
      const previewBuffer = await readRemoteFileSlice(
        sftp,
        resolvedPath,
        bytesToRead
      );

      if (looksLikeBinaryContent(previewBuffer)) {
        response.json({
          kind: "binary",
          message: "二进制文件不支持预览",
          totalSize: fileStats.size
        });
        return;
      }

      const rawText = previewBuffer.toString("utf8");

      if (extension === "csv" || extension === "tsv") {
        const tablePreview = buildDelimitedPreview(
          rawText,
          extension === "csv" ? "," : "\t",
          tablePreviewMaxRows
        );

        response.json({
          kind: "table",
          notice: `${
            extension.toUpperCase()
          } 预览仅显示前 ${tablePreviewMaxRows} 行`,
          previewedBytes: previewBuffer.length,
          rows: tablePreview.rows,
          totalSize: fileStats.size,
          truncated: isLargeText || tablePreview.truncated
        });
        return;
      }

      const textPreview = isLargeText
        ? takeLeadingLines(rawText, largeTextPreviewMaxLines)
        : { content: rawText, truncated: false };

      response.json({
        content: textPreview.content,
        kind: "text",
        notice: isLargeText
          ? `文件超过 10 MB，仅展示前 ${largeTextPreviewMaxLines} 行`
          : "",
        previewedBytes: previewBuffer.length,
        totalSize: fileStats.size,
        truncated: isLargeText || textPreview.truncated
      });
    } catch (error) {
      const appError = asAppError(error, "远程文本预览失败");
      response.status(appError.statusCode).json({
        error: appError.message
      });
    } finally {
      sftp?.end();
    }
  });

  app.options("/api/html-preview/:sessionId/*", (_request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.status(204).end();
  });

  app.get("/api/html-preview/:sessionId/*", async (request, response) => {
    let sftp: SFTPWrapper | null = null;

    try {
      const params = request.params as { sessionId?: string; 0?: string };
      const session = requireSession(String(params.sessionId || ""));
      const requestedPath = String(params[0] || "").trim();

      if (!requestedPath) {
        throw new AppError("缺少 HTML 预览路径", 400);
      }

      sftp = await openSftp(session.client);

      const remotePath = normalizeRemoteRoutePath(requestedPath);
      const resolvedPath = await sftpRealpath(sftp, remotePath);
      const fileStats = await sftpStat(sftp, resolvedPath);

      if (!fileStats.isFile()) {
        throw new AppError("目标不是可读取文件", 400);
      }

      const extension = path.extname(resolvedPath).toLowerCase();

      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      response.setHeader("Cache-Control", "no-store");

      if (extension === ".html" || extension === ".htm") {
        const htmlBuffer = await readRemoteFileSlice(
          sftp,
          resolvedPath,
          fileStats.size
        );
        const htmlContent = htmlBuffer.toString("utf8");

        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.send(
          rewriteHtmlPreviewDocument(htmlContent, session.id, resolvedPath)
        );
        return;
      }

      const fileStream = sftp.createReadStream(resolvedPath);
      let finished = false;

      const cleanup = () => {
        if (finished) {
          return;
        }

        finished = true;
        fileStream.destroy();
        sftp?.end();
      };

      response.setHeader("Content-Type", getRemoteContentType(resolvedPath));

      fileStream.on("error", (error: Error) => {
        if (!response.headersSent) {
          const appError = asAppError(error, "HTML 资源读取失败");
          response.status(appError.statusCode).json({
            error: appError.message
          });
        } else {
          response.destroy(error);
        }

        cleanup();
      });

      response.on("close", cleanup);
      fileStream.on("close", cleanup);
      fileStream.pipe(response);
    } catch (error) {
      sftp?.end();

      const appError = asAppError(error, "HTML 资源读取失败");
      response.status(appError.statusCode).json({
        error: appError.message
      });
    }
  });

  if (clientDist && fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get("*", (request, response, next) => {
      if (request.path.startsWith("/api/")) {
        next();
        return;
      }

      response.sendFile(path.join(clientDist, "index.html"));
    });
  }

  return app;
}

export function startRemoteViewerServer(options: ServerOptions = {}) {
  const app = createRemoteViewerApp(options.clientDist ?? defaultClientDist);
  const host = options.host || "127.0.0.1";
  const port = options.port ?? Number(process.env.PORT || 4173);

  return new Promise<http.Server>((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.on("error", reject);
  });
}
