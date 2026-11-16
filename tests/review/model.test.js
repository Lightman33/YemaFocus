import test from 'node:test';
import assert from 'node:assert/strict';
import { Period, defaultWeek, ReviewText as T, reviewModules } from '../../app/review-model.js';
// 期望均按 source/ReviewModel.cs Period.Of:31–49 / Shift:75–86 / Label:93–106，WeekStart:PlannerModel.cs:908 推出。
const periods = [
 ['day','2024-02-29','2024-02-29','2024-02-29','2024-02-28','2024-03-01','2024年2月29日 周四'],
 ['week','2021-01-01','2020-12-28','2021-01-03','2020-12-21','2021-01-04','2020年第53周（12月28日–1月3日）'],
 ['month','2024-02-29','2024-02-01','2024-02-29','2024-01-01','2024-03-01','2024年2月'],
 ['quarter','2026-12-31','2026-10-01','2026-12-31','2026-07-01','2027-01-01','2026年第4季度（10–12月）'],
 ['year','2024-02-29','2024-01-01','2024-12-31','2023-01-01','2025-01-01','2024年'],
 ['week','2025-12-31','2025-12-29','2026-01-04','2025-12-22','2026-01-05','2026年第1周（12月29日–1月4日）']
];
for (const [scale,d,start,end,prev,next,label] of periods) test('周期 '+scale+' '+d,()=>{ const p=Period.of(scale,d); assert.deepEqual(p,{scale,start,end,id:scale+':'+start}); assert.equal(Period.shift(p,-1).start,prev); assert.equal(Period.shift(p,1).start,next); assert.equal(Period.label(p),label); assert.deepEqual(Period.parseId(p.id),p); assert.equal(Period.contains(p,d),true); });
test('默认周：Encourage.cs:449–455，周一至三看上周',()=>{ for(const d of ['2026-11-09','2026-11-10','2026-11-11']) assert.equal(defaultWeek(d).start,'2026-11-02'); for(const d of ['2026-11-12','2026-11-13','2026-11-15']) assert.equal(defaultWeek(d).start,'2026-11-09'); });
test('非法、非起点编号和自定义不接受',()=>{for(const id of ['week:2021-01-01','day:2023-02-29','custom:2026-01-01~2026-01-03','x']) assert.equal(Period.parseId(id),null);});
// 逐条手推：Parse:189–214（只认整行单个闭括号），Compose:223–235（trim 仅 \n 和半角空格）。
const composeCases = [
 [[], ''], [[['甲','']], ''], [[['甲',' \n ']], ''], [[['甲','\t']], ''], [[['甲',null]], ''],
 [[['甲','正文']], '【甲】\n正文'], [[['','正文']], '正文'], [[[' 甲 ','正文']], '【 甲 】\n正文'],
 [[['甲','  正文  ']], '【甲】\n正文'], [[['甲','\n正文\n']], '【甲】\n正文'], [[['甲','一\r\n二']], '【甲】\n一\n二'],
 [[['甲','\t一\t']], '【甲】\n\t一\t'], [[['甲','一\r']], '【甲】\n一\r'], [[['甲','\u3000一\u3000']], '【甲】\n\u3000一\u3000'],
 [[['甲','一'],['乙','二']], '【甲】\n一\n\n【乙】\n二'], [[['甲',''],['乙','二']], '【乙】\n二'],
 [[['甲','一'],['甲','二']], '【甲】\n一\n\n【甲】\n二'], [[['','开头'],['甲','一']], '开头\n\n【甲】\n一'],
 [[['甲','句中【乙】']], '【甲】\n句中【乙】'], [[['甲','【乙】\n二']], '【甲】\n【乙】\n二'],
 [[['甲','\r一\r']], '【甲】\n\r一\r'], [[['甲','一\n\n二']], '【甲】\n一\n\n二'],
 [[['甲','\u0085']], ''], [[['甲','\uFEFF']], '【甲】\n\uFEFF'], [[['','\t\n']], ''],
 [[['甲','一\n '],['','二']], '【甲】\n一\n\n二']
];
composeCases.forEach(([input,expected],i)=>test('Compose 手推 '+(i+1),()=>assert.equal(T.compose(input),expected)));
const parseCases = [
 ['',[]],[' \n\r\n',[]],['\t',[]],['未分段',[['','未分段']]],['【甲】',[['甲','']]],['【甲】\n正文',[['甲','正文']]],
 [' 【 甲 】 \n一',[['甲','一']]],['【甲】\r\n一\r\n二',[['甲','一\n二']]],['前言\n【甲】\n一',[['','前言'],['甲','一']]],
 ['【甲】\n一\n【甲】\n二',[['甲','一'],['甲','二']]],['句中【乙】',[['','句中【乙】']]],['【甲】后缀',[['','【甲】后缀']]],
 ['【甲】 【乙】',[['','【甲】 【乙】']]],['【】',[['','【】']]],['【 】\n一',[['','一']]],['【甲【乙】\n一',[['甲【乙','一']]],
 ['【甲】\n\t一\t',[['甲','\t一\t']]],['【甲】\n  一  ',[['甲','一']]],['【甲】\n\u3000一\u3000',[['甲','\u3000一\u3000']]],
 ['【甲】\n一\r',[['甲','一']]],['【甲】\n一\n\n二',[['甲','一\n\n二']]],['【甲】\n\n【乙】',[['甲',''],['乙','']]],
 ['【甲】\n\n',[['甲','']]],['【甲】\n\r一\r',[['甲','一']]],['【甲】\n\u0085',[['甲','\u0085']]],['【甲】\n\uFEFF',[['甲','\uFEFF']]]
];
parseCases.forEach(([input,expected],i)=>test('Parse 手推 '+(i+1),()=>assert.deepEqual(T.parse(input),expected)));
test('Ordered/Get：ReviewModel.cs:216–251，首个同名、特殊段在先、额外段按存档顺序',()=>{
 const text='前言\n【旧乙】\n乙\n【甲】\n一\n【本期数据】\n数据\n【甲】\n二\n【旧丙】\n丙';
 assert.equal(T.get(T.parse(text),'甲'),'一'); assert.equal(T.get([],'甲'),null);
 assert.deepEqual(T.ordered(text,['甲','新','甲']),[['','前言'],['本期数据','数据'],['甲','一'],['新',''],['旧乙','乙'],['旧丙','丙']]);
 assert.deepEqual(T.ordered(text,null),T.parse(text));
});
test('模块默认及存储格式：Core.cs:291–295,338–370',()=>{assert.deepEqual(reviewModules({},'day'),['今日完成','收获与亮点','问题与卡点','明日最重要的三件事']); assert.deepEqual(reviewModules({'ReviewModules.day':' ##【甲】 |甲|乙\r\n|'+ '长'.repeat(35)},'day'),['甲','乙','长'.repeat(30)]); assert.deepEqual(reviewModules({'ReviewModules.day':''},'day'),[]);});

test('世纪非闰年、季度和跨年相邻日边界，周桶使用周一',()=>{
 assert.equal(Period.of('month','2100-02-01').end,'2100-02-28');assert.equal(Period.of('quarter','2024-02-29').end,'2024-03-31');assert.equal(Period.shift(Period.of('quarter','2024-02-29'),1).id,'quarter:2024-04-01');assert.equal(Period.shift(Period.of('day','2026-01-01'),-1).id,'day:2025-12-31');
 const b=Period.buckets(Period.of('week','2021-01-01'));assert.equal(b.of('2020-12-28 23:00:00'),0);assert.equal(b.of('2021-01-03 23:59:00'),6);
});
