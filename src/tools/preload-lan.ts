import { contextBridge, ipcRenderer } from 'electron';

/**
 * lanchat 工具窗口专属 preload：暴露 window.lan。
 *
 * 与通用 preload（src/tools/preload.ts 的 window.tool）不同，这里只有局域网
 * 通信能力，避免给所有工具窗口都挂 lan。lan:event 是主进程 push 的统一
 * 事件通道（{ channel, payload }），渲染层据此刷新。
 */

export type LanEventChannel = 'snapshot' | 'message' | 'transfer-progress' | 'incoming-offer';

contextBridge.exposeInMainWorld('lan', {
  start: () => ipcRenderer.invoke('lan:start'),
  stop: () => ipcRenderer.invoke('lan:stop'),
  snapshot: () => ipcRenderer.invoke('lan:snapshot'),
  setOnline: (on: boolean) => ipcRenderer.invoke('lan:setOnline', on),
  sendChat: (peerId: string, text: string) => ipcRenderer.invoke('lan:sendChat', peerId, text),
  broadcast: (text: string) => ipcRenderer.invoke('lan:broadcast', text),
  sendFile: (peerId: string, filePath: string) => ipcRenderer.invoke('lan:sendFile', peerId, filePath),
  acceptFile: (transferId: number, ok: boolean, savePath?: string) =>
    ipcRenderer.invoke('lan:acceptFile', transferId, ok, savePath),
  messages: (peerId: string, limit?: number) => ipcRenderer.invoke('lan:messages', peerId, limit),
  pickFile: () => ipcRenderer.invoke('lan:pickFile'),
  pickDir: () => ipcRenderer.invoke('lan:pickDir'),
  listInterfaces: () => ipcRenderer.invoke('lan:listInterfaces'),
  getSelectedInterface: () => ipcRenderer.invoke('lan:getSelectedInterface'),
  setNic: (address: string | null) => ipcRenderer.invoke('lan:setNic', address),
  showInFolder: (filePath: string) => ipcRenderer.invoke('lan:showInFolder', filePath),

  /** 订阅主进程 push 的事件 */
  on: (cb: (channel: LanEventChannel, payload: any) => void) => {
    const handler = (_e: any, data: { channel: LanEventChannel; payload: any }) => {
      cb(data.channel, data.payload);
    };
    ipcRenderer.on('lan:event', handler);
    return () => ipcRenderer.removeListener('lan:event', handler);
  },
});
