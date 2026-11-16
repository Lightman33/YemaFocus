import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Period, computeStats, statsToText, habitRate, parseRecord, fmtMin, percent, addDays, roundEven } from '../../app/review-model.js';
const p=Period.of('week','2026-11-13');
const task=(id,date,doneAt,extra={})=>({id,title:id,date,done:Boolean(doneAt),doneAt,steps:[],...extra});
export const planner={projects:[{id:'r',name:'项目甲'},{id:'sub',name:'子项目',parent:'r'}],reviews:[],habits:[
 {id:'h1',name:'每日阅读',kind:'Daily',start:'2026-11-09',checks:['2026-11-09','2026-11-11']},
 {id:'h2',name:'每周练习',kind:'TimesPerWeek',perWeek:3,start:'2026-11-09',checks:['2026-11-09','2026-11-10','2026-11-11']}
],tasks:[
 task('按期','2026-11-09','2026-11-10 08:00:00',{project:'r',steps:[{done:true},{done:true}]}),
 task('未完成','2026-11-10',null,{project:'sub'}),
 task('周内','', '2026-11-16 09:00:00',{weekOf:'2026-11-09',steps:[{done:true}]}),
 task('计划外','2026-11-01','2026-11-11 10:00:00',{project:'sub',steps:[{done:true}]}),
 task('放弃','2026-11-12','2026-11-12 19:00:00',{abandoned:true,abandonedAt:'2026-11-12T16:00:00.000Z',abandonReason:'条件变了',steps:[{done:true}]}),
 task('未来','2026-11-15',null,{steps:[{done:true}]}), task('月内',null,null,{monthOf:'2026-11-01'}),
 task('垃圾桶','2026-11-09','2026-11-10 08:00:00',{trashedAt:'2026-11-12'})
]};
export function record(kind,start,minutes,status='完成',name='') {return {id:kind+start,day:start.slice(0,10),columns:[kind,start,start.slice(0,10)+' 23:59:00',String(minutes),name,status,'','']};}
export const records=[record('番茄','2026-11-09 09:00:00',25,'完成','学习 ／ 读书'),record('番茄','2026-11-09 09:30:00',25,'完成','学习/读书'),record('番茄','2026-11-10 10:00:00',20),record('正计时','2026-11-11 12:00:00',30,'完成','整理'),record('番茄','2026-11-11 13:00:00',15,'放弃'),record('休息','2026-11-09 10:00:00',5),record('休息','2026-11-09 11:00:00',5,'跳过'),record('休息','2026-11-10 11:00:00',5,'推迟'),record('休息','2026-11-10 12:00:00',5,'中断'),record('打断','2026-11-12 14:00:00',10,'外部'),record('打断','2026-11-12 14:30:00',10,'分心'),record('番茄','2026-11-16 09:00:00',25),{columns:[]}];
const stats=()=>computeStats(planner,p,records,'2026-11-13','Asia/Shanghai');
test('手算全部数字：Summarize:1670–1713、PeriodStats:350–394、StatsForm:337',()=>{
 const s=stats();assert.deepEqual([s.planned,s.plannedDone,s.planRate,s.doneTotal,s.stepsDone,s.abandonedTotal],[5,2,.4,2,5,1]);
 assert.deepEqual([s.pomos,s.pomoMin,s.stopwatchMin,s.stopwatchCount,s.pomosAbandoned],[3,100,30,1,1]);
 assert.deepEqual([s.breaksDone,s.breaksSkipped,s.breaksPostponed,s.breaksInterrupted,s.interruptions,s.external,s.self],[1,1,1,1,2,1,1]);
 assert.equal(s.interruptionHours[14],2);assert.equal(s.habitRate,.75);assert.deepEqual(s.habits.map(h=>[h.count,h.rate]),[[2,.5],[3,1]]);
 assert.deepEqual(Object.entries(s.byProject),[['r',[2,1,1]],['',[3,1,0]]]);assert.deepEqual(Object.entries(s.byTask),[['学习/读书',[2,50]],['（未选事项）',[1,20]],['整理',[0,30]]]);assert.deepEqual(s.byCategory['学习'],[2,50]);assert.deepEqual(s.byCategory['未分类'],[1,20]);
 assert.deepEqual(s.unfinished.map(t=>t.id),['未完成','未来']);assert.deepEqual(s.completed.map(t=>t.id),['按期','计划外']);assert.deepEqual(s.abandoned.map(t=>t.abandonReason),['条件变了']);
 assert.deepEqual(s.doneByBucket,[0,1,1,0,0,0,0]);assert.deepEqual(s.pomoByBucket,[2,1,0,0,0,0,0]);assert.deepEqual(s.pomoByHour,Array.from({length:24},(_,i)=>i===9?2:i===10?1:0));assert.equal(s.badRecords,1);assert.equal(s.recordCount,11);
});
test('ToText完整输出逐字符：ReviewModel.cs:411–520，计划外概览沿电脑版用共完成减按计划完成',()=>{
 const expected=`（2026年第46周（11月9日–15日） · 11-13 16:09 导入）

■ 概览
- 计划完成：40% · 2/5 项
- 专注番茄：3 个 · 1 小时 40 分
- 按时休息：1 次 · 跳过 1 次
- 习惯打卡：75% · 2 个习惯

■ 任务
- 计划：5 项，完成 2 项（40%），未完成 2 项
- 共完成：2 项，另完成步骤 5 个
- 放弃了 1 件

■ 按项目（完成/计划）
- 项目甲：1/2，计划外 +1
- 无项目：1/3

■ 已放弃
放弃 — 条件变了

■ 专注
- 番茄：3 个，共 1 小时 10 分，平均每个 23 分钟；中途放弃 1 个
- 正计时：1 次，共 30 分钟
- 合计专注：1 小时 40 分
- 最专注时段：9–11 点（开始了 3 个番茄）

■ 专注分布（按事项）
- 学习/读书：2 个番茄，50 分钟
- 整理：30 分钟
- （未选事项）：1 个番茄，20 分钟

■ 休息
- 按时休息：1 次，跳过 1 次，推迟 1 次

■ 习惯
- 每日阅读：2 次（50%）
- 每周练习：3 次（100%）
- 平均完成率：75%

■ 已完成（2）
1. 11/10 按期 · 项目甲
2. 11/11 计划外 · 子项目

■ 未完成（2）
1. 未完成 · 子项目（原定 11/10）
2. 未来（原定 11/15）`;
 assert.equal(statsToText(stats(),planner,{now:Date.parse('2026-11-13T08:09:10Z'),timeZone:'Asia/Shanghai'}),expected);
});
test('空数据ToText与仅正计时、截断清单、日完成时刻',()=>{
 const empty=computeStats({},Period.of('day','2026-11-13'),[],'2026-11-13');
 assert.equal(statsToText(empty,{}, {now:Date.parse('2026-11-13T08:09:10Z')}),'（2026年11月13日 周五 · 11-13 16:09 导入）\n\n■ 概览\n- 完成任务：0 项 · 没有提前计划\n- 专注番茄：0 个 · 0 分钟\n\n■ 任务\n- 共完成：0 项\n- 放弃了 0 件');
 const s=computeStats(planner,Period.of('day','2026-11-11'),records,'2026-11-13');assert.equal(s.pomos,0);assert.equal(s.stopwatchCount,1);assert.match(statsToText(s,planner,{now:Date.parse('2026-11-13T08:09:10Z')}),/1\. 10:00 计划外/);
 assert.match(statsToText(stats(),planner,{now:Date.parse('2026-11-13T08:09:10Z'),maxItems:1}),/…… 另 1 项/);
});
test('分段：日24小时，闰月29天，季度首周从周一，年12月，边界不纳入相邻期',()=>{
 const day=computeStats(planner,Period.of('day','2026-11-09'),records,'2026-11-13');assert.equal(day.pomoByBucket.length,24);assert.equal(day.pomoByBucket[9],2);
 const month=Period.buckets(Period.of('month','2024-02-15'));assert.equal(month.n,29);assert.equal(month.labels.at(-1),'29');assert.equal(month.of('2024-02-29'),28);
 const quarter=Period.buckets(Period.of('quarter','2026-04-01'));assert.equal(quarter.n,14);assert.equal(quarter.of('2026-04-01'),0);assert.equal(quarter.of('2026-04-06'),1);
 const s=computeStats(planner,Period.of('year','2026-11-13'),records,'2026-11-13');assert.equal(s.pomoByBucket.length,12);assert.equal(s.pomoByBucket[10],4);
 const nonweek=computeStats({tasks:[task('周待安排',null,null,{weekOf:'2026-11-09'})]},Period.of('month','2026-11-13'),[],'2026-11-13');assert.equal(nonweek.planned,0);
});
test('习惯：今天未打卡不扣分、开始结束截取、周内折算、归档有记录保留、重复checks不重计',()=>{
 assert.equal(habitRate({start:'2026-11-13',checks:[]},'2026-11-09','2026-11-15','2026-11-13'),-1);
 assert.equal(habitRate({start:'2026-11-09',end:'2026-11-10',checks:['2026-11-09']},p.start,p.end,'2026-11-13'),.5);
 assert.equal(habitRate({start:'2026-11-09',kind:'Weekdays',weekMask:1,checks:['2026-11-09']},p.start,p.end,'2026-11-13'),1);
 assert.equal(habitRate({start:'2026-11-09',kind:'TimesPerWeek',perWeek:7,checks:['2026-11-09']},p.start,p.end,'2026-11-10'),.5);
 const s=computeStats({habits:[{id:'a',start:'2026-11-09',archived:true,checks:['2026-11-09','2026-11-09']},{id:'b',start:'2026-11-09',archived:true,checks:[]},{id:'c',start:'2026-12-01',checks:[]},{id:'d',start:'2026-01-01',end:'2026-02-01',checks:[]}]},p,[],'2026-11-13');assert.deepEqual(s.habits.map(h=>[h.habit.id,h.count]),[['a',1]]);
});
test('放弃日期用软件时区，原因为空沿电脑文案；完成计划可以在期外完成',()=>{
 const data={tasks:[task('零时','2026-11-13','2026-11-13 00:00:00',{abandoned:true,abandonedAt:'2026-11-12T16:00:00Z'}),task('期外','2026-11-13','2026-12-01 10:00:00')]};
 const s=computeStats(data,Period.of('day','2026-11-13'),[],'2026-11-13','Asia/Shanghai');assert.equal(s.abandonedTotal,1);assert.equal(s.plannedDone,1);assert.equal(s.doneTotal,0);assert.match(statsToText(s,data,{now:Date.parse('2026-11-13T08:09:10Z')}),/零时 — 未填写原因/);
});
test('RecordStore数字日期、归一化事项、无效分钟回退、负分钟归零；银行家舍入',()=>{
 assert.equal(parseRecord({columns:['番茄','2026/11/9 9:00','2026/11/9 9:25','坏',' 学习\\阅读 ／ 深入 ','完成']}).minutes,25);
 assert.equal(parseRecord(record('番茄','2026-11-13 09:00:00',-5)).minutes,0);assert.equal(parseRecord({columns:[]}),null);
 assert.equal(parseRecord({columns:['番茄','坏','坏','1','x','完成']}),null);
 assert.deepEqual([roundEven(.5),roundEven(1.5),roundEven(2.5)],[0,2,2]);assert.equal(fmtMin(60),'1 小时');assert.equal(percent(.125),'12%');
});
test('性能实测：730日复盘和4000条记录计算一年（不含浏览器渲染）',t=>{
 const data={...planner,reviews:Array.from({length:730},(_,i)=>({id:'day:'+addDays('2025-01-01',i),content:'虚构复盘'}))};
 const rows=Array.from({length:4000},(_,i)=>record('番茄',addDays('2025-01-01',i%730)+' 09:00:00',25));
 const start=performance.now(),result=computeStats(data,Period.of('year','2026-11-13'),rows,'2026-11-13');const elapsed=performance.now()-start;
 assert.ok(result.pomos>0);t.diagnostic('730 reviews + 4000 records, computeStats(year): '+elapsed.toFixed(3)+' ms');
});

test('损坏的abandonedAt按电脑版回退doneAt；done为假不算已放弃且仍统计步骤',()=>{
 const data={tasks:[task('回退','2026-11-13','2026-11-13 15:00:00',{abandoned:true,abandonedAt:'损坏'}),task('未关闭','2026-11-13',null,{abandoned:true,steps:[{done:true}]})]};
 const s=computeStats(data,Period.of('day','2026-11-13'),[],'2026-11-13');assert.equal(s.abandonedTotal,1);assert.equal(s.unfinished.length,1);assert.equal(s.stepsDone,1);
});

test('未完成排序沿电脑日期/时刻/优先级/顺序；步骤不按步骤自身日期另算',()=>{
 const data={tasks:[task('晚','2026-11-13',null,{time:'12:00',priority:3}),task('早低','2026-11-13',null,{time:'9:00',priority:1,order:2}),task('早高后','2026-11-13',null,{time:'09:00',priority:3,order:2}),task('早高先','2026-11-13',null,{time:'09:00',priority:3,order:1,steps:[{done:true,date:'2027-01-01'}]})]};
 const s=computeStats(data,Period.of('day','2026-11-13'),[],'2026-11-13');assert.deepEqual(s.unfinished.map(t=>t.id),['早高先','早高后','早低','晚']);assert.equal(s.stepsDone,1);
});
