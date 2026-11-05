import { zstdDecompressSync } from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * DSH 的 session.v4.jsonl.zstd 是「多帧拼接」的 zstd 流，不是单帧容器。
 * zstdDecompressSync(整个文件) 只会解出第一帧（实测 208 字节），所以必须逐帧解。
 *
 * 做法：先扫出所有帧魔数位置，再对每个候选区间单独解压。
 * 压缩数据里偶然出现的魔数会导致解压失败——跳过该候选即可，不中断整体。
 */
export function decodeFrames(buf: Buffer, maxFrames = 80): string[] {
  const offsets: number[] = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i >= 0) {
    offsets.push(i);
    i = buf.indexOf(MAGIC, i + 4);
  }
  if (offsets.length === 0) return [];

  // 只解尾部若干帧：我们关心的是「最近的审批/轮次状态」，不需要全量历史
  const use = offsets.slice(-maxFrames);
  const out: string[] = [];
  for (let k = 0; k < use.length; k++) {
    const start = use[k];
    const end = k + 1 < use.length ? use[k + 1] : buf.length;
    try {
      out.push(zstdDecompressSync(buf.subarray(start, end)).toString('utf8'));
    } catch {
      // 伪魔数或跨帧截断，跳过
    }
  }
  return out;
}

export function decodeFrameLines(buf: Buffer, maxFrames = 80): string[] {
  const chunks = decodeFrames(buf, maxFrames);
  const lines: string[] = [];
  for (const chunk of chunks) {
    for (const line of chunk.split('\n')) {
      if (line.trim()) lines.push(line);
    }
  }
  return lines;
}

/** 支持 .jsonl（明文）与 .jsonl.zstd（多帧压缩）两种会话文件 */
export function readSessionLines(filePath: string, buf: Buffer, maxFrames = 80): string[] {
  if (filePath.endsWith('.zstd') || filePath.endsWith('.zst')) {
    return decodeFrameLines(buf, maxFrames);
  }
  return buf.toString('utf8').split('\n').filter((l) => l.trim());
}

export function safeParse<T = any>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}
