// 终端小抄数据：分类 + 命令 + 说明。
// 命令优先选用「能直接复制粘贴跑」的实用项，说明用一句话讲清用途。

export interface CheatItem {
  cmd: string;
  desc: string;
}

export interface CheatCategory {
  id: string;
  label: string;
  items: CheatItem[];
}

export const CHEATS: CheatCategory[] = [
  {
    id: 'git',
    label: 'Git',
    items: [
      { cmd: 'git log --oneline --graph --all', desc: '图形化查看所有分支历史' },
      { cmd: 'git status --short', desc: '查看工作区改动（精简）' },
      { cmd: 'git diff HEAD', desc: '查看未提交的改动' },
      { cmd: 'git add -A && git commit -m "msg"', desc: '暂存全部并提交' },
      { cmd: 'git pull --rebase origin main', desc: '拉取并 rebase 到 main' },
      { cmd: 'git push origin main', desc: '推送 main 到远程' },
      { cmd: 'git merge --no-ff feature-x', desc: '合并分支（保留分支历史）' },
      { cmd: 'git rebase -i HEAD~3', desc: '交互式整理最近 3 个提交' },
      { cmd: 'git reset --hard HEAD~1', desc: '撤销最近一次提交（危险）' },
      { cmd: 'git stash && git stash pop', desc: '暂存改动 / 恢复改动' },
      { cmd: 'git cherry-pick <commit>', desc: '把某个提交应用到当前分支' },
      { cmd: 'git revert <commit>', desc: '撤销某个提交（生成反向提交）' },
      { cmd: 'git branch -d feature-x', desc: '删除本地已合并分支' },
      { cmd: 'git fetch --prune', desc: '拉取并清理已删除的远程分支' },
      { cmd: 'git checkout -- <file>', desc: '丢弃某个文件的未提交改动' },
      { cmd: 'git ls-files', desc: '列出仓库所有已跟踪文件' },
      { cmd: 'git blame <file>', desc: '查看文件每行的提交者' },
    ],
  },
  {
    id: 'file',
    label: '文件操作',
    items: [
      { cmd: 'ls -la', desc: '列出所有文件（含隐藏，含权限）' },
      { cmd: 'find . -name "*.log" -delete', desc: '递归删除所有 .log 文件' },
      { cmd: 'du -sh .', desc: '查看当前目录总大小' },
      { cmd: 'du -sh * | sort -h', desc: '按大小列出子目录/文件' },
      { cmd: 'grep -r "keyword" .', desc: '递归搜索关键字' },
      { cmd: 'grep -rn "keyword" --include="*.ts"', desc: '只在 .ts 文件里搜' },
      { cmd: 'tail -f app.log', desc: '实时跟踪日志文件' },
      { cmd: 'wc -l file.txt', desc: '统计文件行数' },
      { cmd: 'head -100 file.txt', desc: '看文件前 100 行' },
      { cmd: 'chmod +x script.sh', desc: '给脚本加执行权限' },
      { cmd: 'which <cmd>', desc: '查看命令的实际路径' },
      { cmd: 'history | grep "git"', desc: '搜索 shell 历史命令' },
    ],
  },
  {
    id: 'archive',
    label: '压缩解压',
    items: [
      { cmd: 'tar -czf out.tar.gz dir/', desc: '打包成 tar.gz' },
      { cmd: 'tar -xzf file.tar.gz', desc: '解压 tar.gz' },
      { cmd: 'tar -xJf file.tar.xz', desc: '解压 tar.xz' },
      { cmd: 'zip -r out.zip dir/', desc: '打包成 zip' },
      { cmd: 'unzip file.zip -d out/', desc: '解压 zip 到指定目录' },
      { cmd: 'gzip -d file.gz', desc: '解压 .gz 单文件' },
    ],
  },
  {
    id: 'network',
    label: '网络 / 端口',
    items: [
      { cmd: 'netstat -ano | findstr :8080', desc: '查谁占用 8080 端口（Windows）' },
      { cmd: 'lsof -i :8080', desc: '查谁占用 8080 端口（macOS/Linux）' },
      { cmd: 'curl -I https://example.com', desc: '只看响应头' },
      { cmd: 'curl -X POST -H "Content-Type: application/json" -d @body.json https://api', desc: '发 JSON POST 请求' },
      { cmd: 'ping -t example.com', desc: '持续 ping（Ctrl+C 停）' },
      { cmd: 'tracert example.com', desc: '追踪路由（Windows）' },
      { cmd: 'nslookup example.com', desc: '查域名解析' },
      { cmd: 'ipconfig /flushdns', desc: '刷新 DNS 缓存（Windows）' },
    ],
  },
  {
    id: 'node',
    label: 'Node / npm',
    items: [
      { cmd: 'npm install', desc: '安装 package.json 声明的依赖' },
      { cmd: 'npm install <pkg> --save-dev', desc: '安装为开发依赖' },
      { cmd: 'npm uninstall <pkg>', desc: '卸载依赖' },
      { cmd: 'npm run build', desc: '跑 build 脚本' },
      { cmd: 'npm view <pkg> version', desc: '查包最新版本' },
      { cmd: 'npx <pkg>', desc: '临时运行一个包，不安装' },
      { cmd: 'npm outdated', desc: '查看可升级的依赖' },
      { cmd: 'node -e "console.log(1)"', desc: '跑一段内联 JS' },
    ],
  },
  {
    id: 'process',
    label: '进程 / 系统',
    items: [
      { cmd: 'ps aux | grep <proc>', desc: '查进程（Linux/macOS）' },
      { cmd: 'tasklist | findstr <proc>', desc: '查进程（Windows）' },
      { cmd: 'kill -9 <pid>', desc: '强制杀进程（Linux/macOS）' },
      { cmd: 'taskkill /F /PID <pid>', desc: '强制杀进程（Windows）' },
      { cmd: 'top', desc: '实时看 CPU/内存占用' },
      { cmd: 'df -h', desc: '查看磁盘占用（Linux/macOS）' },
      { cmd: 'free -m', desc: '查看内存（Linux）' },
      { cmd: 'env | sort', desc: '查看环境变量（排序）' },
    ],
  },
];

/** 所有分类的总数 */
export function totalCount(): number {
  return CHEATS.reduce((sum, c) => sum + c.items.length, 0);
}
