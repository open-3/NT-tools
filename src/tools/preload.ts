import { contextBridge, ipcRenderer } from 'electron';

/**
 * 工具窗口共享的 preload。
 *
 * 只暴露三个最小能力，够所有小工具用：
 *   openFile / saveFile / saveFileAs
 *
 * 格式化、编辑、状态管理等纯逻辑全部留在工具自己的渲染层，
 * 主进程只负责「把文件读进来、把内容写出去」。
 */
contextBridge.exposeInMainWorld('tool', {
  openFile: () => ipcRenderer.invoke('tool:openFile'),
  saveFile: (filePath: string, content: string) => ipcRenderer.invoke('tool:saveFile', filePath, content),
  saveFileAs: (defaultName: string, content: string) =>
    ipcRenderer.invoke('tool:saveFileAs', defaultName, content),
});
