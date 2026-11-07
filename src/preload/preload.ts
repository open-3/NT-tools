import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('pulse', {
  get: () => ipcRenderer.invoke('pulse:get'),
  state: () => ipcRenderer.invoke('pulse:state'),
  ack: (key: string) => ipcRenderer.send('pulse:ack', key),
  ackAll: () => ipcRenderer.send('pulse:ackAll'),
  ignore: (key: string, minutes: number) => ipcRenderer.send('pulse:ignore', key, minutes),
  itemMenu: (key: string, title: string) => ipcRenderer.send('pulse:itemMenu', key, title),
  mainMenu: () => ipcRenderer.send('pulse:mainMenu'),
  toolbox: () => ipcRenderer.send('pulse:toolbox'),
  collapse: (v: boolean) => ipcRenderer.send('pulse:collapse', v),
  toggleTop: () => ipcRenderer.send('pulse:toggleTop'),
  hide: () => ipcRenderer.send('pulse:hide'),
  quit: () => ipcRenderer.send('pulse:quit'),
  setHeight: (h: number) => ipcRenderer.send('pulse:height', h),
  onUpdate: (cb: (s: any) => void) => {
    ipcRenderer.on('pulse:update', (_e, s) => cb(s));
  },
  onState: (cb: (s: any) => void) => {
    ipcRenderer.on('pulse:state', (_e, s) => cb(s));
  },
  onUpdateEvent: (cb: (s: any) => void) => {
    ipcRenderer.on('pulse:update-event', (_e, s) => cb(s));
  },
  updateNow: () => ipcRenderer.send('pulse:update-now'),
  updateRestart: () => ipcRenderer.send('pulse:update-restart'),
});
