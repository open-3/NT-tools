/**
 * 摘要提取单测。
 * 重点覆盖真实踩到的坑：「已修复。根因是…」取第一句会丢掉全部信息。
 */
import { summarize, extractDshText, SUMMARY_LIMIT } from '../src/main/summary';

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
function eq(name: string, a: any, b: any): void {
  ok(name, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
}

console.log('summarize');

// 核心用例：真实数据里最常见的形态
{
  const raw = '已修复。根因是无类型 Port/Property 的自身 ID 被当成了 end 类型。现在保存后的模型与四段预期一致。';
  const s = summarize(raw);
  ok('剥掉「已修复」空话，保留根因', s.startsWith('根因是无类型'), s);
  ok('长度在限制内', s.length <= SUMMARY_LIMIT + 1, `${s.length} 字: ${s}`);
}

// 不应把「已完成」类前缀当内容
{
  eq('纯「已完成。」→ 回退原文', summarize('已完成。'), '已完成。');
}

// 结构化输出（guardian 审查）
{
  const raw = '{"risk_level":"low","user_authorization":"high","outcome":"allow","rationale":"x"}';
  eq('JSON 提取 outcome', summarize(raw), 'allow');
}
{
  eq('坏 JSON → 占位', summarize('{not valid json'), '(结构化输出)');
}

// markdown 装饰
{
  const s = summarize('**已修复**：`null` 检查漏了');
  ok('去掉 markdown 星号与反引号', !s.includes('**') && !s.includes('`'), s);
}
{
  const s = summarize('### 完成\n修复了登录问题');
  ok('去掉标题井号', !s.startsWith('#'), s);
}

// 长文本：优先在逗号处断开
{
  const raw = '本次修改涉及三个文件，分别是认证模块、权限校验和日志组件，其中认证模块改动最大，需要重新跑一遍集成测试。';
  const s = summarize(raw);
  ok('长文本被截断', s.length <= SUMMARY_LIMIT + 9, `${s.length} 字: ${s}`);
  ok('截断后不以半句结尾', /[。！？!?，,；;]$|…$/.test(s), s);
}

// 短文本原样保留
{
  eq('短文本原样', summarize('你好！'), '你好！');
}

// 空值处理
{
  eq('null → 空串', summarize(null), '');
  eq('空串 → 空串', summarize(''), '');
  eq('纯空白 → 空串', summarize('   \n  '), '');
}

// 换行折叠
{
  const s = summarize('第一行\n第二行\n第三行');
  ok('换行被折叠为空格', !s.includes('\n'), s);
}

// 累积到 15 字才停（避免「好。」这种过短）
{
  const raw = '好。已修复登录问题。另外还优化了日志。';
  const s = summarize(raw);
  ok('短句会累积到有信息量', s.length >= 10, s);
}

console.log('\nextractDshText');

// 关键：必须排除 reasoning 块
{
  const msg = {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: '用户在打招呼，应该简短回应' },
      { type: 'text', text: '你好！有什么需要帮忙的吗？' },
    ],
  };
  eq('只取 text，不取 reasoning', extractDshText(msg), '你好！有什么需要帮忙的吗？');
}
{
  const msg = { content: [{ type: 'reasoning', text: '思考中' }] };
  eq('只有 reasoning → 空串', extractDshText(msg), '');
}
{
  const msg = { content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] };
  eq('多个 text 块拼接', extractDshText(msg), 'A B');
}
{
  eq('无 content 字段回退 text', extractDshText({ text: '兜底' }), '兜底');
  eq('null 安全', extractDshText(null), '');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
