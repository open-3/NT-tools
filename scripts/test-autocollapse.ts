// AutoCollapse 状态机单测（无 Electron 依赖）
import { AutoCollapse } from '../src/main/autocollapse';

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

/** 手动的假定时器，便于精确控制时间推进 */
function harness(delay = 2000) {
  let empty = true;
  let manual = false;
  let collapsed = false;
  const events: string[] = [];
  let pending: { fn: () => void; at: number } | null = null;
  let clock = 0;

  const ac = new AutoCollapse(
    {
      isEmpty: () => empty,
      isManuallyCollapsed: () => manual,
      collapse: () => {
        collapsed = true;
        events.push('collapse');
      },
      expand: () => {
        collapsed = false;
        events.push('expand');
      },
      setTimer: (fn, ms) => {
        pending = { fn, at: clock + ms };
        return 1;
      },
      clearTimer: () => {
        pending = null;
      },
    },
    delay,
  );

  return {
    ac,
    events,
    setEmpty(v: boolean) {
      empty = v;
    },
    setManual(v: boolean) {
      manual = v;
    },
    get collapsed() {
      return collapsed;
    },
    advance(ms: number) {
      clock += ms;
      if (pending && clock >= pending.at) {
        const fn = pending.fn;
        pending = null;
        fn();
      }
    },
  };
}

console.log('AutoCollapse');
{
  const h = harness();
  h.ac.tick();
  ok('空态立即不折叠（要等延迟）', h.collapsed === false);
  h.advance(1999);
  ok('1999ms 仍未折叠', h.collapsed === false);
  h.advance(2);
  ok('2001ms 后自动折叠', h.collapsed === true, JSON.stringify(h.events));
}
{
  const h = harness();
  h.ac.tick();
  h.advance(500);
  h.setEmpty(false);
  h.ac.tick();
  h.advance(5000);
  ok('空态中途来内容 → 不折叠', h.collapsed === false, JSON.stringify(h.events));
}
{
  const h = harness();
  h.ac.tick();
  h.advance(2500);
  ok('先折叠', h.collapsed === true);
  h.setEmpty(false);
  h.ac.tick();
  ok('来内容 → 立即展开', h.collapsed === false, JSON.stringify(h.events));
}
{
  const h = harness();
  h.setManual(true);
  h.ac.tick();
  h.advance(5000);
  ok('用户已手动折叠 → 不重复触发', h.events.length === 0, JSON.stringify(h.events));
}
{
  const h = harness();
  h.ac.tick();
  h.advance(2500);
  const before = h.events.length;
  h.ac.onManualToggle();
  h.advance(5000);
  ok('手动切换后清空自动状态', h.ac.isAutoCollapsed === false);
  ok('手动切换后不再自动动作', h.events.length === before);
}
{
  // 反复空/有 不应累积多个定时器
  const h = harness();
  h.ac.tick();
  h.ac.tick();
  h.ac.tick();
  h.advance(2500);
  ok('重复 tick 不产生多次折叠', h.events.filter((e) => e === 'collapse').length === 1, JSON.stringify(h.events));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
