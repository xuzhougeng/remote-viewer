export type AuthMethod = "key" | "password";

export type ConnectionConfig = {
  authMethod: AuthMethod;
  host: string;
  password: string;
  port: string;
  rememberPassword: boolean;
  rootPath: string;
  username: string;
};

export type ActiveSession = {
  authMethod: AuthMethod;
  host: string;
  hostname: string;
  port: string;
  rootPath: string;
  sessionId: string;
  username: string;
};

export type ConnectionSessionResponse = {
  alias?: string;
  authMethod: AuthMethod;
  hostname: string;
  port: number;
  sessionId: string;
  username: string;
};

export type ConfiguredSshHost = {
  alias: string;
  source: string;
};

export type RemoteEntry = {
  extension?: string;
  kind: "directory" | "file";
  name: string;
  path: string;
  size: number;
};

export type ResolvedSshHost = {
  alias: string;
  hostname?: string;
  identityFiles: string[];
  port?: string;
  user?: string;
};

export type TextPreviewPayload =
  | {
      kind: "binary";
      message: string;
      totalSize: number;
    }
  | {
      kind: "table";
      notice: string;
      previewedBytes: number;
      rows: string[][];
      totalSize: number;
      truncated: boolean;
    }
  | {
      content: string;
      kind: "text";
      notice: string;
      previewedBytes: number;
      totalSize: number;
      truncated: boolean;
    };
