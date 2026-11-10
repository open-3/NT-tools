import { contextBridge, ipcRenderer } from 'electron';

/**
 * 工具窗口共享的 preload。
 *
 * 能力按需分层：
 *   - 文件：openFile / saveFile / saveFileAs（文本）、readBinaryFile（二进制）
 *   - 系统：scanDir（目录只读扫描，做磁盘占用）、runCmd（受限系统命令）、
 *           envSnapshot（环境变量快照）
 *
 * 纯格式化、编辑、状态管理留在工具自己的渲染层，
 * 主进程只负责「读文件、写文件、查系统」这类必须出 Node 环境才能做的事。
 */
contextBridge.exposeInMainWorld('tool', {
  // 文本文件
  openFile: (defaultPath?: string) => ipcRenderer.invoke('tool:openFile', defaultPath),
  saveFile: (filePath: string, content: string) => ipcRenderer.invoke('tool:saveFile', filePath, content),
  saveFileAs: (defaultName: string, content: string) =>
    ipcRenderer.invoke('tool:saveFileAs', defaultName, content),

  // 二进制文件（图片等），返回 { path, data: Uint8Array | null, error? }
  readBinaryFile: () => ipcRenderer.invoke('tool:readBinaryFile'),

  // 目录只读扫描：返回 { items: [{name, path, isDir, size}] }（size 仅文件）
  scanDir: (dirPath?: string) => ipcRenderer.invoke('tool:scanDir', dirPath),

  // 受限系统命令：只有白名单命令可用，返回 { stdout, stderr, code }
  runCmd: (cmd: string, args: string[]) => ipcRenderer.invoke('tool:runCmd', cmd, args),

  // 端口/进程结构化数据：{ ports:[{address,port,pid,process}], processes:[{pid,name,mb}] }
  netstat: () => ipcRenderer.invoke('tool:netstat'),

  // 环境变量快照（脱敏后）
  envSnapshot: () => ipcRenderer.invoke('tool:envSnapshot'),

  // 屏幕截图（整个主屏），返回 dataURL
  captureScreen: () => ipcRenderer.invoke('tool:captureScreen'),
});
