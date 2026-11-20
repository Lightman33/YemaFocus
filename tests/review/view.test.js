import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument, until } from '../tasks/dom-double.js';
import { createDemoReviewData, createDemoReviewSource } from '../../app/demo-review-data.js';
import { ReviewText, findReview } from '../../app/review-model.js';
import { mountReview } from '../../app/review-view.js';
import { memorySource } from './memory-source.js';
const now=()=>Date.parse('2026-11-13T08:09:10.123Z');
function setup(source=memorySource(),storage=new Map()) {
 const doc=parseDocument('<main><section id="root"></section></main>');doc.defaultView={handlers:new Map(),localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},addEventListener(k,fn){this.handlers.set(k,fn);},removeEventListener(k){this.handlers.delete(k);},emit(k){this.handlers.get(k)?.();}};
 doc.removeEventListener=(k,fn)=>{doc.handlers.set(k,(doc.handlers.get(k)||[]).filter(f=>f!==fn));};
 const root=doc.getElementById('root'),view=mountReview({root,dataSource:source,now,preferences:{read:()=>{const v=storage.get('ui');return typeof v==='string'?JSON.parse(v):v;},write:value=>storage.set('ui',value)}});
 const find=(text)=>root.querySelectorAll('button').find(b=>!b.hidden && (b.getAttribute('aria-label')===text || b.textContent===text));
 const input=(name)=>root.querySelectorAll('textarea').find(b=>b.getAttribute('aria-label')===name);
 return {doc,root,view,source,find,input};
}
const tick=()=>new Promise(r=>setTimeout(r,10));
const primaryTouch = { pointerId: 1, isPrimary: true, button: 0 };

test('模块点一次同步展开并把光标放在末尾，打开时隐藏预览', () => {
 const source = memorySource();
 source.state.planner.reviews = [{id:'day:2026-11-13', content:'【今日完成】\n虚构第一行\n虚构第二行', updated:now()}];
 const s = setup(source), toggle = s.find('展开或收起模块：今日完成'), input = s.input('复盘模块：今日完成');
 const editor = input.parentNode, preview = toggle.parentNode.querySelector('.review-preview');
 assert.equal(preview.textContent, '虚构第一行');
 assert.equal(preview.hidden, false);
 assert.equal(editor.getAttribute('aria-hidden'), 'true');
 assert.equal(input.tabIndex, -1);
 for (let node = input; node !== s.root; node = node.parentNode) assert.equal(node.hidden, false);
 let selection;
 input.setSelectionRange = (start, end) => { selection = [start, end]; };
 input.addEventListener('focus', () => assert.deepEqual(selection, [input.value.length, input.value.length]));
 toggle.emit('click');
 assert.equal(s.doc.activeElement, input);
 assert.equal(toggle.getAttribute('aria-expanded'), 'true');
 assert.equal(editor.getAttribute('aria-hidden'), 'false');
 assert.equal(input.tabIndex, 0);
 assert.equal(preview.hidden, true);
 toggle.emit('click');
 assert.equal(s.doc.activeElement, toggle);
 assert.equal(preview.hidden, false);
 assert.equal(editor.getAttribute('aria-hidden'), 'true');
 assert.equal(input.tabIndex, -1);
 s.view.destroy();
});

test('从正在输入的模块点另一个模块或评分时保留焦点到点击，并保存上一框', async () => {
 const s = setup(), first = s.input('复盘模块：今日完成'), second = s.input('复盘模块：问题与卡点');
 s.find('展开或收起模块：今日完成').emit('click');
 first.value = '虚构的待保存文字';
 first.emit('input');
 const toggle = s.find('展开或收起模块：问题与卡点');
 s.root.emit('pointerdown', {...primaryTouch, target:toggle});
 s.doc.emit('pointerup', primaryTouch);
 assert.equal(toggle.emit('mousedown').defaultPrevented, true);
 assert.equal(s.doc.activeElement, first);
 s.doc.emit('click', {target:toggle});
 toggle.emit('click');
 assert.equal(s.doc.activeElement, second);
 assert.equal(second.scrolledIntoView, undefined);
 await until(() => s.source.state.planner.reviews[0]?.content.includes(first.value));
 assert.equal(s.doc.activeElement, second);
 const star = s.find('评分 3 星，再点同一颗清零');
 assert.equal(star.emit('mousedown').defaultPrevented, true);
 star.emit('click');
 assert.equal(s.doc.activeElement, star);
 await until(() => s.source.state.planner.reviews[0]?.score === 3);
 s.view.destroy();
});

test('抬手后若先失焦保存，冲突按钮保留到这次点击处理完', async () => {
 const source = memorySource(), path = ['review-module', 'day:2026-11-13', '问题与卡点'];
 source.state.conflicts = [{key:JSON.stringify(path), path, candidates:[{branch:'a', value:'虚构甲'}, {branch:'b', value:'虚构乙'}]}];
 const s = setup(source), input = s.input('一句话总结');
 input.focus();
 input.value = '点击处理冲突前写的虚构总结';
 input.emit('input');
 const label = '保留这一份（版本 1）', keep = s.find(label);
 s.root.emit('pointerdown', {...primaryTouch, target:keep});
 s.doc.emit('pointerup', primaryTouch);
 input.blur();
 await s.view.flush();
 assert.equal(s.find(label), keep);
 assert.equal(source.state.planner.reviews[0].title, input.value);
 s.doc.emit('click', {target:keep});
 keep.emit('click');
 await until(() => source.resolved?.choice.branch === 'a' && !s.find(label));
 s.view.destroy();
});

test('抬手未产生点击也会补做已排队的刷新', async () => {
 const s = setup(), input = s.input('一句话总结');
 s.root.emit('pointerdown', {...primaryTouch, target:input});
 s.source.state.planner.reviews = [{id:'day:2026-11-13', title:'虚构的同步总结', updated:now()}];
 s.source.publish();
 s.doc.emit('pointerup', primaryTouch);
 assert.equal(input.value, '');
 await until(() => input.value === '虚构的同步总结');
 s.view.destroy();
});

test('切尺度、周期、回本期和模式；偏好重开恢复',async()=>{
 const storage=new Map(),s=setup(memorySource(),storage);s.find('周复盘').emit('click');await until(()=>s.root.textContent.includes('第46周'));s.find('上一期').emit('click');await until(()=>s.root.textContent.includes('第45周'));s.find('回到本期').emit('click');await until(()=>s.root.textContent.includes('第46周'));s.find('看统计').emit('click');await tick();s.view.destroy();const reopened=setup(memorySource(),storage);assert.equal(reopened.find('看统计').getAttribute('aria-pressed'),'true');assert.ok(reopened.root.textContent.includes('第46周'));reopened.view.destroy();
});
test('输入停顿300ms保存，折叠预览，失焦立即保存',async()=>{
 const s=setup();const input=s.input('复盘模块：今日完成');input.focus();input.value='第一行\n第二行';input.emit('input');assert.equal(s.source.state.planner.reviews.length,0);await until(()=>s.source.state.planner.reviews.length===1);assert.ok(s.root.textContent.includes('第一行'));input.value='失焦即存';input.emit('input');input.blur();await until(()=>s.source.state.planner.reviews[0].content.includes('失焦即存'));s.view.destroy();
});
test('聚焦刷新保留同一输入节点及文字，其他字段更新',async()=>{
 const s=setup(),input=s.input('复盘模块：今日完成');input.focus();input.value='正在写';input.emit('input');s.source.state.planner.reviews=[{id:'day:2026-11-13',title:'远端总结',content:'【今日完成】\n远端旧字',score:3,updated:now()}];s.source.publish();assert.equal(s.input('复盘模块：今日完成'),input);assert.equal(input.value,'正在写');assert.equal(s.input('一句话总结').value,'远端总结');await s.view.flush();assert.ok(s.source.state.planner.reviews[0].content.includes('正在写'));s.view.destroy();
});
test('组合输入不保存半词，flush阻止切走；compositionend后能保存',async()=>{
 const s=setup(),input=s.input('一句话总结');input.focus();input.emit('compositionstart');input.value='半词';input.emit('input');await new Promise(r=>setTimeout(r,340));assert.equal(s.source.state.planner.reviews.length,0);await assert.rejects(s.view.flush(),/选词/);s.find('下一期').emit('click');await tick();assert.ok(s.root.textContent.includes('11月13日'));input.value='完整词';input.emit('compositionend');await s.view.flush();assert.equal(s.source.state.planner.reviews[0].title,'完整词');s.view.destroy();
});
test('存储失败保持输入，重试成功',async()=>{
 const s=setup(),input=s.input('一句话总结');s.source.fail=true;input.value='保留';input.emit('input');await assert.rejects(s.view.flush(),/空间不足/);assert.equal(input.value,'保留');assert.equal(s.source.state.planner.reviews.length,0);s.source.fail=false;await s.view.flush();assert.equal(s.source.state.planner.reviews[0].title,'保留');s.view.destroy();
});
test('五颗星每颗可读，重复点清零；未加入禁用输入',async()=>{
 const s=setup(),star=s.find('评分 3 星，再点同一颗清零');star.emit('click');await until(()=>s.source.state.planner.reviews[0]?.score===3);star.emit('click');await until(()=>s.source.state.planner.reviews.length===0);s.view.destroy();
 const locked=setup(memorySource({joined:false}));assert.ok(locked.root.textContent.includes('先在设置里连接并完成第一次同步'));assert.equal(locked.input('一句话总结').disabled,true);assert.equal(locked.find('导入本期数据，可撤销').disabled,true);locked.view.destroy();
});

test('导入本期数据只读卡片，编辑文字入口，撤销保留总结',async()=>{
 const source=createDemoReviewSource('2026-11-13',{now}),s=setup(source);
 const importButton = s.find('导入本期数据，可撤销');
 s.root.emit('pointerdown', {...primaryTouch, target:importButton});
 s.doc.emit('pointerup', primaryTouch);
 s.doc.emit('click', {target:importButton});
 importButton.emit('click');await until(()=>s.input('复盘模块：本期数据'));
 const input = s.input('复盘模块：本期数据'), editor = input.parentNode, read = editor.parentNode.querySelector('pre');
 assert.equal(editor.getAttribute('aria-hidden'), 'true');
 assert.equal(read.hidden, false);
 assert.ok(input.value.includes('■ 概览'));
 s.find('编辑本期数据文字').emit('click');
 assert.equal(s.doc.activeElement, input);
 assert.equal(editor.getAttribute('aria-hidden'), 'false');
 assert.equal(read.hidden, true);
 const title=s.input('一句话总结');title.value='导入后新写总结';title.emit('input');await s.view.flush();
 s.find('撤销刚才的操作').emit('click');await until(()=>!findReview(source.snapshot().planner,'day:2026-11-13').content.includes('【本期数据】'));
 assert.equal(findReview(source.snapshot().planner,'day:2026-11-13').title,'导入后新写总结');s.view.destroy();
});
for (const choice of [0,1,'both']) test('模块冲突解决 '+choice+'，保留完整文字且可重新读写',async()=>{
 const source=createDemoReviewSource('2026-11-13',{now}),s=setup(source),before=source.snapshot().conflicts[0];
 assert.ok(s.root.textContent.includes('有 1 处两边都改过'));
 for (const c of before.candidates) assert.ok(s.root.textContent.includes(c.value.raw));
 const label=choice==='both'?'两段都留着，按上面的版本顺序各占一段':'保留这一份（版本 '+(choice+1)+'）';
 s.find(label).emit('click');await until(()=>source.snapshot().conflicts.length===0);
 const content=findReview(source.snapshot().planner,'day:2026-11-13').content,body=ReviewText.get(ReviewText.parse(content),'收获与亮点');
 const texts=before.candidates.map(c=>ReviewText.get(ReviewText.parse(c.value.raw),'收获与亮点'));
 assert.equal(body,choice==='both'?texts.join('\n\n'):texts[choice]);
 assert.equal((content.match(/【收获与亮点】/g)||[]).length,1);s.view.destroy();
});
test('总结和评分冲突显示在对应控件前；评分不会被拼成字符串',async()=>{
 const data=createDemoReviewData('2026-11-13'),id='day:2026-11-13';
 data.conflicts=[{key:JSON.stringify(['review-title',id]),path:['review-title',id],candidates:[{branch:'a',value:'总结甲'},{branch:'b',value:'总结乙'}]}, {key:JSON.stringify(['review-score',id]),path:['review-score',id],candidates:[{branch:'c',value:2},{branch:'d',value:5}]}];
 const source=createDemoReviewSource('2026-11-13',{now,initial:data}),s=setup(source);
 assert.equal(s.input('一句话总结').disabled,true);assert.ok(s.root.textContent.includes('评分只能保留一个数值'));
 assert.equal(s.root.querySelectorAll('button').filter(b=>b.textContent==='两段都留着').length,1);
 const summaryCard=s.root.querySelectorAll('.review-conflict').find(c=>c.textContent.includes('总结甲'));
 summaryCard.querySelectorAll('button').at(-1).emit('click');await until(()=>source.snapshot().conflicts.length===1);
 assert.equal(findReview(source.snapshot().planner,id).title,'总结甲\n\n总结乙');
 const scoreCard=s.root.querySelectorAll('.review-conflict')[0];scoreCard.querySelectorAll('button')[1].emit('click');await until(()=>!source.snapshot().conflicts.length);assert.equal(findReview(source.snapshot().planner,id).score,5);s.view.destroy();
});
test('统计六卡、柱可读名称及点选、事项/大类、已完成默认5项展开',async()=>{
 const source=createDemoReviewSource('2026-11-13',{now}),s=setup(source);s.find('周复盘').emit('click');await until(()=>s.root.textContent.includes('第46周'));s.find('看统计').emit('click');await until(()=>s.root.querySelectorAll('.review-metric').length===6);
 const bar=s.root.querySelectorAll('.review-chart-segment')[0];assert.match(bar.getAttribute('aria-label'),/周一：完成 \d 项，番茄 \d 个/);bar.emit('click');await tick();assert.equal(s.root.querySelector('.review-chart-detail').textContent,bar.getAttribute('aria-label'));
 s.find('按大类查看专注分布').emit('click');await tick();const ratios=s.root.querySelectorAll('.review-ratio');assert.ok(ratios.some(r=>r.getAttribute('aria-label').startsWith('学习：')));
 const data=createDemoReviewData('2026-11-13');data.planner.tasks=Array.from({length:8},(_,i)=>({id:'done'+i,title:'虚构已完成'+i,date:'2026-11-13',done:true,doneAt:'2026-11-13 09:00:00',steps:[]}));const ss=setup(createDemoReviewSource('2026-11-13',{now,initial:data}));ss.find('看统计').emit('click');await until(()=>ss.root.querySelectorAll('li').length===5);ss.find('显示全部 8 项').emit('click');await until(()=>ss.root.querySelectorAll('li').length===8);s.view.destroy();ss.view.destroy();
});
test('统计清单调用已有完成操作，重复任务提示且不修改',async()=>{
 const source=createDemoReviewSource('2026-11-13',{now}),s=setup(source);s.find('看统计').emit('click');await until(()=>s.find('完成任务：整理虚构笔记 21'));s.find('完成任务：整理虚构笔记 21').emit('click');await until(()=>source.snapshot().planner.tasks.find(t=>t.id==='demo-task-0').done);
 s.find('完成任务：每周虚构整理（重复任务只读）').emit('click');await until(()=>s.root.textContent.includes('重复任务请先在电脑上完成，后续版本支持'));assert.equal(source.snapshot().planner.tasks.find(t=>t.id==='demo-repeat').done,false);s.view.destroy();
});
test('空统计解释、额外模块顺序、无标题空白模块不显示',async()=>{
 const s=setup();s.find('看统计').emit('click');await until(()=>s.root.textContent.includes('电脑同步过来或完成任务后'));assert.equal(s.root.querySelectorAll('.review-metric').length,0);s.view.destroy();
 const source=createDemoReviewSource('2026-11-13',{now}),extra=setup(source);extra.find('上一期').emit('click');await until(()=>extra.root.textContent.includes('旧版小记（存档模块）'));assert.equal(extra.root.querySelectorAll('.review-module').at(-1).querySelector('.review-module-title').textContent,'▶ 旧版小记（存档模块）');extra.view.destroy();
 const blank=memorySource();blank.state.planner.reviews=[{id:'day:2026-11-13',title:'',score:0,content:'【 】\n  \n【今日完成】\n一',updated:now()}];const b=setup(blank);assert.equal(b.input('复盘模块：其他'),undefined);b.view.destroy();
});
test('切模式、flush、visibilitychange、pagehide均即时触发保存',async()=>{
 const s=setup();let title=s.input('一句话总结');title.value='切模式前';title.emit('input');s.find('看统计').emit('click');await until(()=>s.source.state.planner.reviews[0]?.title==='切模式前');
 s.find('写复盘').emit('click');await tick();title.value='后台前';title.emit('input');s.doc.visibilityState='hidden';s.doc.emit('visibilitychange');await until(()=>s.source.state.planner.reviews[0]?.title==='后台前');
 title.value='pagehide前';title.emit('input');s.doc.defaultView.emit('pagehide');await until(()=>s.source.state.planner.reviews[0]?.title==='pagehide前');
 title.value='外壳flush';title.emit('input');await s.view.flush();assert.equal(s.source.state.planner.reviews[0].title,'外壳flush');s.view.destroy();
});
test('销毁解除订阅；偏好存储不可用不影响保存；缺settings/records兼容',async()=>{
 const source=memorySource(),s=setup(source);s.view.destroy();source.publish();assert.equal(s.root.children.length,0);
 const d=parseDocument('<section id="root"></section>');Object.defineProperty(d,'defaultView',{value:{get localStorage(){throw new Error('拒绝');}}});const root=d.getElementById('root'),v=mountReview({root,dataSource:memorySource(),now});const input=root.querySelectorAll('textarea')[0];input.value='独立保存';input.emit('input');await v.flush();v.destroy();
});

test('新复盘同时输入总结和两个模块，一次提交，三个字段都保留',async()=>{
 const s=setup();for(const [name,value] of [['一句话总结','总结'],['复盘模块：今日完成','完成'],['复盘模块：问题与卡点','问题']]){const input=s.input(name);input.value=value;input.emit('input');}
 await s.view.flush();assert.equal(s.source.calls.length,1);const record=s.source.state.planner.reviews[0];assert.equal(record.title,'总结');assert.equal(ReviewText.get(ReviewText.parse(record.content),'今日完成'),'完成');assert.equal(ReviewText.get(ReviewText.parse(record.content),'问题与卡点'),'问题');s.view.destroy();
});
test('保存尚未完成时继续输入，切周期等待新字全部保存后再切走',async()=>{
 const source=memorySource();let release,started=false;const original=source.change.bind(source);source.change=async(...args)=>{if(!started){started=true;await new Promise(r=>release=r);}return original(...args);};
 const s=setup(source),input=s.input('一句话总结');input.focus();input.value='第一段';input.emit('input');s.find('下一期').emit('click');await until(()=>started);input.value='第一段加第二段';input.emit('input');release();await until(()=>s.root.textContent.includes('11月14日'));
 assert.equal(source.state.planner.reviews[0].title,'第一段加第二段');assert.equal(source.calls.length,2);s.view.destroy();
});
test('本期数据插在普通模块之前；坏偏好不会导致页面打不开',async()=>{
 const source=createDemoReviewSource('2026-11-13',{now}),s=setup(source,new Map([['ui','null']]));s.find('导入本期数据，可撤销').emit('click');await until(()=>s.input('复盘模块：本期数据'));assert.equal(s.root.querySelectorAll('.review-module')[0].querySelector('button').getAttribute('aria-label'),'展开或收起模块：本期数据');s.view.destroy();
});

test('未知时区/未加入并有本机周期偏好时保持只读，不因格式化时间崩溃',()=>{
 const source=memorySource({today:null,timeZone:null,joined:false});source.state.planner.reviews=[{id:'day:2026-11-13',title:'虚构内容',content:'',score:0,updated:'2026-11-13T08:00:00Z'}];
 const s=setup(source,new Map([['ui','{"period":"day:2026-11-13"}']]));assert.ok(s.root.textContent.includes('先在设置里连接并完成第一次同步'));assert.equal(s.input('一句话总结').disabled,true);s.view.destroy();assert.equal(s.doc.defaultView.handlers.size,0);assert.equal(s.doc.handlers.get('visibilitychange').length,0);
});

test('剪贴板不可用时展示只读Markdown全文供手动复制，关闭回到复制按钮',async()=>{
 const s=setup(createDemoReviewSource('2026-11-13',{now}));s.find('复制全文 Markdown').emit('click');await until(()=>s.root.querySelector('dialog'));
 const dialog=s.root.querySelector('dialog'),text=dialog.querySelector('textarea');assert.equal(text.readOnly,true);assert.match(text.value,/^# 日复盘/);assert.match(text.value,/来源：野马专注与健康助手/);
 s.find('关闭手动复制全文').emit('click');await until(()=>!s.root.querySelector('dialog'));assert.equal(s.doc.activeElement,s.find('复制全文 Markdown'));s.view.destroy();
});
