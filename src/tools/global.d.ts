/**
 * 工具窗口共享的 window.tool 全局类型。
 *
 * 所有工具窗口页面都由同一个 preload（src/tools/preload.ts）注入 window.tool，
 * 所以这里统一声明一份完整接口，各工具代码里直接 `window.tool.xxx()` 调用，
 * 不要再各自 `declare global`（会因类型冲突报 TS2717）。
 */

export {};

export interface ToolOpenResult {
  path: string;
  content: string | null;
  error?: string;
}
export interface ToolSaveResult {
  ok: boolean;
  path?: string;
  error?: string;
}
export interface ToolBinaryResult {
  path: string;
  data: Uint8Array | null;
  name: string;
  error?: string;
}
export interface ToolScanResult {
  path: string;
  items: { name: string; path: string; isDir: boolean; size: number }[];
  error?: string;
}
export interface ToolCmdResult {
  stdout: string;
  stderr: string;
  code: number;
  error?: string;
}
export interface ToolEnvResult {
  entries: { key: string; value: string }[];
  count: number;
}
export interface ToolCaptureResult {
  ok: boolean;
  dataURL?: string;
  error?: string;
}

export interface ToolNetstatResult {
  ports: { address: string; port: number; pid: number; process: string }[];
  processes: { pid: number; name: string; mb: number }[];
  count: { ports: number; processes: number };
  error?: string;
}

export interface ToolApi {
  openFile(): Promise<ToolOpenResult | null>;
  saveFile(filePath: string, content: string): Promise<ToolSaveResult>;
  saveFileAs(defaultName: string, content: string): Promise<ToolSaveResult | null>;
  readBinaryFile(): Promise<ToolBinaryResult | null>;
  scanDir(dirPath?: string): Promise<ToolScanResult | null>;
  runCmd(key: string, args?: string[]): Promise<ToolCmdResult>;
  netstat(): Promise<ToolNetstatResult>;
  envSnapshot(): Promise<ToolEnvResult>;
  captureScreen(): Promise<ToolCaptureResult>;
}

declare global {
  interface Window {
    tool: ToolApi;
  }
}
