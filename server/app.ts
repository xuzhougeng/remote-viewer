import express from "express";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import * as ssh2 from "ssh2";
import type {
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
  port?: string;
  username?: string;
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

class AppError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
  }
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

  if (!host) {
    throw new AppError("缺少 SSH 主机信息", 400);
  }

  if (authMethod === "password" && !password) {
    throw new AppError("密码登录需要填写密码", 400);
  }

  return {
    authMethod,
    host,
    password: password || undefined,
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
  const resolvedHost = await resolveConfiguredHostSafely(connection.host);
  const hostname = resolvedHost?.hostname || connection.host;
  const username = connection.username || resolvedHost?.user || "";
  const port = resolvePort(connection.port || resolvedHost?.port);

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
    Object.assign(connectConfig, resolvePrivateKey(resolvedHost));
  }

  return {
    alias: resolvedHost ? connection.host : undefined,
    authMethod: connection.authMethod,
    connectConfig,
    hostname,
    password: connection.password,
    port,
    username
  };
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
      fail(new Error(error.message || "SSH 连接失败"));
    });

    client.on("close", () => {
      if (!settled) {
        fail(new Error("SSH 连接已关闭"));
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

  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.get("/api/ssh/hosts", (_request, response) => {
    response.json({
      hosts: readConfiguredSshHosts()
    });
  });

  app.get("/api/ssh/resolve", async (request, response) => {
    try {
      const alias = String(request.query.alias || "").trim();

      if (!alias) {
        throw new AppError("缺少 SSH Host Alias", 400);
      }

      response.json(await resolveConfiguredHost(alias));
    } catch (error) {
      const appError = asAppError(error, "SSH 配置解析失败");
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
        `inline; filename="${encodeURIComponent(filename)}"`
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
