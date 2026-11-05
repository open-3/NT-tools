/**
 * 项目名清洗单测。
 * 重点：WorkBuddy 的时间戳目录（2026-10-24-00-50-30）不能直接显示。
 */
import { projectName, isMeaningfulProject, buildContext } from '../src/main/project';

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}  ${detail}`);
  }
}
function eq(name: string, a: any, b: any): void {
  ok(name, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
}

console.log('projectName');

// 正常路径
eq('普通路径取末段', projectName('D:\\work\\acme\\acme-modeler'), 'acme-modeler');
eq('去掉 \\\\?\\ 前缀', projectName('\\\\?\\D:\\a\\b\\proj-x'), 'proj-x');
eq('中文路径', projectName('D:\\work\\我的应用'), '我的应用');
eq('末尾带斜杠', projectName('D:\\a\\b\\proj\\'), 'proj');
eq('正斜杠路径', projectName('C:/Users/x/proj-y'), 'proj-y');

// 核心：时间戳目录要退到上层
eq('时间戳目录退一层', projectName('C:\\Users\\me\\WorkBuddy AI\\2026-10-24-00-50-30'), 'WorkBuddy AI');
eq('日期目录退一层', projectName('D:\\work\\myproj\\2026-10-24'), 'myproj');
eq('纯数字日期退一层', projectName('D:\\work\\myproj\\20261024'), 'myproj');

// 边界
eq('空值', projectName(null), '');
eq('空串', projectName(''), '');
eq('只有根', projectName('D:\\'), 'D:');

console.log('\nisMeaningfulProject');
ok('正常名字有意义', isMeaningfulProject('acme-modeler'));
ok('中文名字有意义', isMeaningfulProject('我的应用'));
ok('test 无意义', !isMeaningfulProject('test'));
ok('new-chat 无意义', !isMeaningfulProject('new-chat'));
ok('default-workspace 无意义', !isMeaningfulProject('default-workspace'));
ok('空串无意义', !isMeaningfulProject(''));
ok('纯数字无意义', !isMeaningfulProject('12345'));
ok('时间戳无意义', !isMeaningfulProject('2026-10-24-00-50-30'));

console.log('\nbuildContext');

// 项目名 + 分支
{
  const c = buildContext('D:\\work\\acme-modeler', 'feature-a');
  eq('项目名', c?.project, 'acme-modeler');
  eq('分支', c?.branch, 'feature-a');
}
// 主分支不显示
{
  const c = buildContext('D:\\work\\proj', 'main');
  eq('main 分支被省略', c?.branch, undefined);
  eq('项目名仍在', c?.project, 'proj');
}
{
  const c = buildContext('D:\\work\\proj', 'master');
  eq('master 分支被省略', c?.branch, undefined);
}
// refs/heads 前缀与长分支名
{
  const c = buildContext('D:\\work\\proj', 'refs/heads/feature/payment-refactor');
  eq('去掉 refs/heads 并取末段', c?.branch, 'payment-refactor');
}
{
  const c = buildContext('D:\\work\\proj', 'feature/a-very-long-branch-name-that-overflows');
  ok('超长分支被截断', (c?.branch?.length ?? 0) <= 25, c?.branch);
}
// 无意义项目名 → 整个 context 为 undefined（不显示）
{
  eq('无意义项目不返回 context', buildContext('D:\\x\\test'), undefined);
  eq('空 cwd 不返回 context', buildContext(null), undefined);
}
// 无分支时只返回项目
{
  const c = buildContext('D:\\work\\proj', null);
  eq('无分支', c?.branch, undefined);
  eq('项目仍在', c?.project, 'proj');
}
// 时间戳 + 分支
{
  const c = buildContext('C:\\Users\\me\\WorkBuddy AI\\2026-10-24-00-50-30', 'main');
  eq('时间戳目录退层后仍可用', c?.project, 'WorkBuddy AI');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
