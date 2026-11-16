import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDemoReviewData, createDemoReviewSource } from '../../app/demo-review-data.js';
import { ReviewText } from '../../app/review-model.js';
test('示例日期相对生成，21日日复盘/3周/1月，额外模块与一处冲突，番茄各种状态与习惯',()=>{
 for(const today of ['2026-11-13','2027-01-01','2024-02-29']) {
 const s=createDemoReviewData(today);assert.equal(s.planner.reviews.filter(r=>r.scale==='day').length,21);assert.equal(s.planner.reviews.filter(r=>r.scale==='week').length,3);assert.equal(s.planner.reviews.filter(r=>r.scale==='month').length,1);assert.equal(s.conflicts.length,1);assert.ok(s.planner.reviews.some(r=>ReviewText.get(ReviewText.parse(r.content),'旧版小记')));assert.ok(s.records.every(r=>r.day<=today));assert.deepEqual(new Set(s.records.map(r=>r.columns[5])),new Set(['完成','放弃','跳过','推迟','中断','外部','分心']));assert.ok(s.planner.habits.every(h=>h.checks.length));
 }
});
test('预览假来源可以修改，重新建立后重置；实例相互隔离',async()=>{const a=createDemoReviewSource('2026-11-13'),b=createDemoReviewSource('2026-11-13');await a.change('虚构修改',p=>{p.reviews[0].title='改变';});assert.equal(a.snapshot().planner.reviews[0].title,'改变');assert.notEqual(b.snapshot().planner.reviews[0].title,'改变');});
test('静态资源存在、无外部资源/框架/数据HTML拼接/直接同步来源导入',async()=>{
 const html=await readFile(new URL('../../review-preview.html',import.meta.url),'utf8');assert.match(html,/仅供验收的预览页，不随正式版发布/);assert.ok(!/https?:\/\/|register\(/.test(html));
 for(const file of ['review-model.js','review-actions.js','review-view.js','demo-review-data.js']) {const code=await readFile(new URL('../../app/'+file,import.meta.url),'utf8');assert.ok(!/innerHTML|from ['"].*datasource\.js|from ['"].*engine\.js/.test(code),file);}
 const css=await readFile(new URL('../../app/review.css',import.meta.url),'utf8');assert.match(css,/min-width: 44px/);assert.match(css,/min-height: 44px/);assert.match(css,/font-size: max\(1rem, 16px\)/);assert.match(css,/overflow-y: hidden/);
});

test('明暗配色：正文和图例4.5:1，输入边界和图形3:1（仅色值计算）',async()=>{
 const css=await readFile(new URL('../../app/ui.css',import.meta.url),'utf8');const blocks=[...css.matchAll(/:root\s*\{([^}]+)\}/g)];
 const luminance=hex=>{const rgb=hex.match(/\w\w/g).map(x=>parseInt(x,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
 const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
 for(const block of blocks){const vars=Object.fromEntries([...block[1].matchAll(/--([\w-]+):\s*#([a-f\d]{6})/gi)].map(m=>[m[1],m[2]]));for(const bg of ['bg','panel','surface','hover'])for(const fg of ['ink','caption','accent','blue','danger'])assert.ok(contrast(vars[fg],vars[bg])>=4.5,fg+'/'+bg);assert.ok(contrast(vars.border,vars.surface)>=3);assert.ok(contrast(vars['button-ink'],vars.accent)>=4.5);}
});
test('模拟静态HTTP处理器可读取独立预览及其新资源（未监听端口）',async()=>{
 const { createPreviewServer }=await import('../../tools/serve.js');const server=createPreviewServer();
 for(const path of ['/review-preview.html','/app/ui.css','/app/review.css','/app/review-model.js','/app/review-actions.js','/app/review-view.js','/app/demo-review-data.js']) {
 const response=await new Promise(resolve=>{const headers={};server.emit('request',{url:path,method:'GET'}, {setHeader(k,v){headers[k]=v;},writeHead(status,more){this.status=status;Object.assign(headers,more);},end(body){resolve({status:this.status,headers,body:String(body)});}});});
 assert.equal(response.status,200,path);assert.match(response.headers['Content-Type'],/text\/(html|css|javascript)/);assert.ok(response.body.length>0);
 }
 server.close();
});
