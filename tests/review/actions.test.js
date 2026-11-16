import test from 'node:test';
import assert from 'node:assert/strict';
import { Period, toMarkdown, ReviewText } from '../../app/review-model.js';
import { saveReview, ReviewActions } from '../../app/review-actions.js';
const now=Date.parse('2026-11-13T08:09:10.123Z'), options={now,timeZone:'Asia/Shanghai'}, p=Period.of('day','2026-11-13');
import { memorySource } from './memory-source.js';
test('新建全部字段及软件时区/UTC毫秒；修改保留created和未知字段',()=>{
 const data={reviews:[],tasks:[{id:'不动'}],deleted:{[p.id]:'旧墓碑'}};
 const r=saveReview(data,p,{title:' 总结 ',sections:[['今日完成',' 一段 ']],score:4},options);
 assert.deepEqual(r,{id:'day:2026-11-13',scale:'day',start:'2026-11-13',end:'2026-11-13',title:'总结',content:'【今日完成】\n一段',score:4,created:'2026-11-13 16:09:10',updated:'2026-11-13T08:09:10.123Z'});assert.deepEqual(data.deleted,{});
 r.unknown={x:1};const oldCreated=r.created;
 const changed=saveReview(data,p,{modules:[['今日完成','改了']]},{...options,now:now+1000});
 assert.equal(changed.created,oldCreated);assert.equal(changed.updated,'2026-11-13T08:09:11.123Z');assert.deepEqual(changed.unknown,{x:1});assert.equal(changed.title,'总结');
});
test('只改一模块，其他复盘、其他模块和其他根字段逐值不变',()=>{
 const source=memorySource(),data=source.state.planner;saveReview(data,p,{sections:[['今日完成','一'],['问题与卡点','二']]},options);
 saveReview(data,Period.shift(p,-1),{title:'昨天'},options);const before=structuredClone(data);
 saveReview(data,p,{modules:[['今日完成','新一']]},options);
 assert.deepEqual(data.reviews[1],before.reviews[1]);assert.deepEqual(data.tasks,before.tasks);assert.equal(ReviewText.get(ReviewText.parse(data.reviews[0].content),'问题与卡点'),'二');
});
test('全空删除并留UTC墓碑；空白新稿不制造墓碑；无变化不碰更新时间',()=>{
 const data={};assert.equal(saveReview(data,p,{sections:[],title:' ',score:0},options),null);assert.deepEqual(data,{});
 const r=saveReview(data,p,{title:'有字'},options);assert.equal(saveReview(data,p,{title:'有字'},{...options,now:now+5000}),r);
 saveReview(data,p,{title:' ',sections:[],score:0},options);assert.deepEqual(data.reviews,[]);assert.equal(data.deleted[p.id],'2026-11-13T08:09:10.123Z');
});
test('评分钳位和负值不修改',()=>{const data={};saveReview(data,p,{score:9},options);assert.equal(data.reviews[0].score,5);saveReview(data,p,{score:-1},options);assert.equal(data.reviews[0].score,5);});
test('导入与撤销只还原本期数据，保留随后总结和别的模块',async()=>{const s=memorySource(),a=new ReviewActions(s,{now:()=>now});const undo=await a.importData(p,'统计');await a.save(p,{title:'随后写',modules:[['今日完成','新文字']]});await undo.undo();assert.equal(s.state.planner.reviews[0].title,'随后写');assert.equal(s.state.planner.reviews[0].content,'【今日完成】\n新文字');});
test('导入撤销拒绝覆盖后来更改的本期数据',async()=>{const s=memorySource(),a=new ReviewActions(s,{now:()=>now});const receipt=await a.importData(p,'统计');await a.save(p,{modules:[['本期数据','改过']]});await assert.rejects(receipt.undo(),/新改动/);});
test('复制Markdown逐字符对应ReviewModel.cs:255–278，剪贴板失败返回全文',async()=>{
 const s=memorySource({settings:{'ReviewModules.day':'今日完成|空模块'}}),a=new ReviewActions(s,{now:()=>now});await a.save(p,{title:'总结',score:2,sections:[['本期数据','■ 概览\n- 共完成：1 项'],['今日完成','一']]});
 const expected=['# 日复盘 · 2026年11月13日 周五','','- 周期：2026-11-13','- 自评：★★☆☆☆（2/5）','- 一句话总结：总结','- 更新于：2026-11-13 16:09','- 来源：野马专注与健康助手','','## 本期数据','','### 概览','- 共完成：1 项','','## 今日完成','','一','','## 空模块','','',''].join('\r\n');
 assert.equal(toMarkdown(s.state.planner.reviews[0],['今日完成','空模块'],'Asia/Shanghai'),expected);
 let copied;assert.equal((await a.copyAll(p,{async writeText(t){copied=t;}})).copied,true);assert.equal(copied,expected);assert.deepEqual(await a.copyAll(p,{}),{copied:false,text:expected});
});
test('未加入拒绝编辑；失败保持原数据',async()=>{const s=memorySource({joined:false}),a=new ReviewActions(s,{now:()=>now});await assert.rejects(a.save(p,{title:'不存'}),/第一次同步/);s.state.joined=true;s.fail=true;await assert.rejects(a.save(p,{title:'不存'}),/空间不足/);assert.deepEqual(s.state.planner.reviews,[]);});

test('只改总结/评分也用Compose规范正文（ReviewView.Save:742–755），保留手写模块的当前输入顺序',()=>{
 const data={reviews:[{id:p.id,scale:p.scale,start:p.start,end:p.end,title:' 原总结 ',content:'【额外】\r\n旧\r\n\r\n【今日完成】\r\n一  \r\n',score:0,created:'2026-11-13 08:00:00',updated:'2026-11-13T00:00:00.000Z'}]};
 saveReview(data,p,{score:2},options);assert.equal(data.reviews[0].title,'原总结');assert.equal(data.reviews[0].content,'【今日完成】\n一\n\n【额外】\n旧');
 saveReview(data,p,{modules:[['今日完成','【问题与卡点】\n这是输入正文里的标题行']]},options);assert.equal(data.reviews[0].content,'【今日完成】\n【问题与卡点】\n这是输入正文里的标题行\n\n【额外】\n旧');
});
