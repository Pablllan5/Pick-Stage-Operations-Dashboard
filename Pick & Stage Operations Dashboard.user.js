// ==UserScript==
// @name         Pick & Stage Operations Dashboard
// @namespace    http://tampermonkey.net/
// @version      9.1.0
// @description  Dashboard Pick & Stage
// @author       Pablllan (Pablo Chicano Llano)
// @match        https://ui.pvsgb.last-mile.amazon.dev/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      hooks.slack.com
// @connect      *.slack.com
// @updateURL    https://raw.githubusercontent.com/Pablllan5/Pick-Stage-Operations-Dashboard/main/Pick%20%26%20Stage%20Operations%20Dashboard.user.js
// @downloadURL  https://raw.githubusercontent.com/Pablllan5/Pick-Stage-Operations-Dashboard/main/Pick%20%26%20Stage%20Operations%20Dashboard.user.js
// ==/UserScript==
// ============================================================================
// Pick & Stage Operations Dashboard
// Version 9.1.0
//
// Created by:
// Pablo Chicano Llano (Pablllan)
//
// Developed with AI-assisted engineering.
// Copyright © Pablo Chicano Llano
// ============================================================================
(function () {
'use strict';

const OVERLAY_ID = 'pick-stage-overlay';
const PANEL_ID = 'Pick-forecast-pro';
const MINI_ID = 'pick-stage-mini';
const STORAGE_KEY = 'pick_stage_operations_dashboard_v910';
const FIELD_IDS = [
  'pf-now','pf-next','pf-ns','pf-wave',
  'pf-routes-per-wave','pf-routes-manual','pf-override','pf-start',
  'pf-ym','pf-ym-start','pf-ym-end',
  'pf-extra-levers','pf-extra-start','pf-extra-end'
];

// Config keys stored via GM
const CONFIG_KEYS = ['webhookMeeting','webhookFull','firstWave','waveInterval','liveDelay'];

let LAST_REPORT_DATA = null;
let AVG_HISTORY = []; // {time, avg} for 15min trend
let AUTO_REFRESH_TIMER = null;

function getConfig(key, def){ return GM_getValue(key, def); }
function setConfig(key, val){ GM_setValue(key, val); }

function appDoc() { try { return window.top && window.top.document ? window.top.document : document; } catch (e) { return document; } }
function appHead() { return appDoc().head || document.head; }
function appBody() { return appDoc().body || document.body; }
function byId(id) { return appDoc().getElementById(id) || document.getElementById(id); }

function getStore(){ try{return JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}');}catch{return{};} }
function setStore(data){ localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
function saveField(id){ const el=byId(id)||document.getElementById(id); if(!el)return; const s=getStore(); s[id]=el.value; setStore(s); }
function loadAllFields(){ const s=getStore(); FIELD_IDS.forEach(id=>{ const el=byId(id)||document.getElementById(id); if(el&&s[id]!==undefined)el.value=s[id]; }); }

function text(){ return document.body?.innerText || ''; }

function parseDuration(v){ if(!v) return null; v=String(v).trim().replace(',','.'); let m=v.match(/^(\d{1,2})[:.](\d{2})$/); if(m) return Number(m[1])+Number(m[2])/60; m=v.match(/^(\d+)(?:\.(\d+))?$/); if(m) return Number(v); return null; }
function parseRoutes(v){ if(v===null||v===undefined) return null; v=String(v).trim(); if(v==='') return null; const m=v.match(/^(\d+)$/); return m ? Number(m[1]) : null; }

function findAvgRoute(){ const m=text().match(/Average Duration[\s\S]{0,300}?(\d{1,2})[:.](\d{2})\s*\/\s*(\d{1,2})[:.](\d{2})/i); if(!m) return null; return Number(m[1])+Number(m[2])/60; }
function findTotalRoutes(){ const m=text().match(/Totals[\s\S]{0,160}?(\d+)\s*Routes/i); return m ? Number(m[1]) : null; }

function findNotAssigned(){
  const block=(text().match(/Routes\/Picklists[\s\S]{0,1200}/i)||[])[0];
  if(!block) return null;
  let m;
  m=block.match(/(\d+)\s*\/\s*\d+\s*Not\s*Assigned/i); if(m) return Number(m[1]);
  m=block.match(/Not\s*Assigned[\s\S]{0,160}?(\d+)\s*\/\s*\d+/i); if(m) return Number(m[1]);
  m=block.match(/(\d+)\s*Not\s*Assigned/i); if(m) return Number(m[1]);
  m=block.match(/Not\s*Assigned[\s\S]{0,160}?(\d+)/i); if(m) return Number(m[1]);
  const lines=block.split('\n').map(x=>x.trim()).filter(Boolean);
  const idx=lines.findIndex(x=>x.toLowerCase()==='not assigned');
  if(idx!==-1){ for(let i=idx-4;i<=idx+4;i++){ if(!lines[i]) continue; const slash=lines[i].match(/(\d+)\s*\/\s*\d+/); if(slash) return Number(slash[1]); const n=lines[i].match(/\b\d+\b/); if(n) return Number(n[0]); } }
  return null;
}

function timeToday(hhmm){ const [h,m]=hhmm.split(':').map(Number); const d=new Date(); d.setHours(h,m,0,0); return d; }
function fmt(d){ return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }
function addMin(d,min){ return new Date(d.getTime()+min*60000); }
function diffMin(a,b){ return Math.round((a-b)/60000); }
function waveTime(hhmm,start){ const d=timeToday(hhmm); if(d<start) d.setDate(d.getDate()+1); return d; }
function windowTime(hhmm, ref){ if(!hhmm) return null; const d=timeToday(hhmm); if(ref && d < addMin(ref, -720)) d.setDate(d.getDate()+1); return d; }
function normalizeWindow(startHHMM, endHHMM, ref){ const start=windowTime(startHHMM,ref); const end=windowTime(endHHMM,ref); if(!start||!end) return null; if(end<=start) end.setDate(end.getDate()+1); return {start,end}; }

function buildCapacityWindows(start){
  const assocNS=Number(byId('pf-now')?.value||0);
  const assocAMPT=Number(byId('pf-next')?.value||0);
  const nsRaw=byId('pf-ns')?.value;
  const ym=Number(byId('pf-ym')?.value||0);
  const ymStartRaw=byId('pf-ym-start')?.value;
  const ymEndRaw=byId('pf-ym-end')?.value;
  const extra=Number(byId('pf-extra-levers')?.value||0);
  const extraStartRaw=byId('pf-extra-start')?.value;
  const extraEndRaw=byId('pf-extra-end')?.value;
  const farEnd=addMin(start,24*60);
  const windows=[];
  if(assocAMPT>0) windows.push({name:'AMPT',people:assocAMPT,start:new Date(start),end:farEnd,permanent:true});
  if(assocNS>0&&nsRaw){ const nsEnd=windowTime(nsRaw,start); if(nsEnd&&nsEnd>start) windows.push({name:'NS',people:assocNS,start:new Date(start),end:nsEnd}); }
  if(ym>0&&ymStartRaw&&ymEndRaw){ const w=normalizeWindow(ymStartRaw,ymEndRaw,start); if(w&&w.end>start) windows.push({name:'Yard Marshals',people:ym,start:w.start,end:w.end}); }
  if(extra>0&&extraStartRaw&&extraEndRaw){ const w=normalizeWindow(extraStartRaw,extraEndRaw,start); if(w&&w.end>start) windows.push({name:'Extra Levers',people:extra,start:w.start,end:w.end}); }
  return windows;
}

function capacityAt(time,windows){ return windows.reduce((sum,w)=>sum+(w.start<=time&&time<w.end?w.people:0),0); }

function finishWithCapacity(start,workMin,windows){
  if(workMin<=0) return start;
  const points=[new Date(start)];
  windows.forEach(w=>{ if(w.start>start) points.push(new Date(w.start)); if(w.end>start) points.push(new Date(w.end)); });
  points.push(addMin(start,24*60));
  const unique=Array.from(new Map(points.map(p=>[p.getTime(),p])).values()).sort((a,b)=>a-b);
  let remaining=workMin;
  for(let i=0;i<unique.length-1;i++){
    const a=unique[i],b=unique[i+1];
    if(b<=start) continue;
    const segmentStart=a<start?start:a;
    const people=capacityAt(segmentStart,windows);
    const minutes=Math.max(0,(b-segmentStart)/60000);
    if(people<=0||minutes<=0) continue;
    const capacity=people*minutes;
    if(remaining<=capacity) return addMin(segmentStart,remaining/people);
    remaining-=capacity;
  }
  return null;
}

function latestStartForCapacity(workMin,waveHHMM,assocNS,assocAMPT){
  const wave=timeToday(waveHHMM);
  let high=new Date(wave),low=addMin(wave,-720);
  for(let i=0;i<50;i++){
    const mid=new Date((low.getTime()+high.getTime())/2);
    const windows=buildCapacityWindows(mid);
    const finish=finishWithCapacity(mid,workMin,windows);
    if(finish&&finish<=wave) low=mid; else high=mid;
  }
  return low;
}

function generateWaveTimes(firstHHMM,lastHHMM,intervalMin){
  if(!firstHHMM||!lastHHMM||!intervalMin||intervalMin<=0) return [];
  let first=timeToday(firstHHMM),last=timeToday(lastHHMM);
  if(last<first) last.setDate(last.getDate()+1);
  const waves=[]; let cursor=new Date(first);
  for(let i=0;i<40&&cursor<=last;i++){ waves.push(new Date(cursor)); cursor=addMin(cursor,intervalMin); }
  if(!waves.some(w=>Math.abs(w-last)<60000)) waves.push(last);
  return waves;
}

function describeWindows(windows){
  if(!windows.length) return 'No active capacity';
  return windows.map(w=>{
    if(w.name==='AMPT') return `${w.name}: ${w.people} associates`;
    if(w.name==='NS') return `${w.name}: ${w.people} until ${fmt(w.end)}`;
    if(w.name==='Yard Marshals') return `YM: ${w.people} · ${fmt(w.start)}–${fmt(w.end)}`;
    if(w.name==='Extra Levers') return `Extra: ${w.people} · ${fmt(w.start)}–${fmt(w.end)}`;
    return `${w.name}: ${w.people} · ${fmt(w.start)}–${fmt(w.end)}`;
  }).join(' · ');
}

function calcAmptMaxRoutes(avg,start,lastWave){
  const assocAMPT=Number(byId('pf-next')?.value||0);
  const nsRaw=byId('pf-ns')?.value;
  if(!assocAMPT||!avg||!nsRaw||!lastWave) return 0;
  const nsEnd=windowTime(nsRaw,start);
  if(!nsEnd||lastWave<=nsEnd) return 0;
  const minsAMPT=Math.max(0,(lastWave-nsEnd)/60000);
  return Math.floor((minsAMPT*assocAMPT)/avg);
}

function durationToSec(v){ if(!v||!String(v).includes(':')) return 0; const parts=String(v).split(':').map(Number); if(parts.length===3) return parts[0]*3600+parts[1]*60+parts[2]; if(parts.length===2) return parts[0]*60+parts[1]; return 0; }
function secToDuration(sec){ sec=Math.max(0,Math.round(sec||0)); const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60; return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`; }
function secToMinText(sec){ sec=Math.max(0,Math.round(sec||0)); if(sec<=0) return '-'; const m=Math.floor(sec/60),s=sec%60; if(m<=0) return `${s}s`; return `${m}m ${String(s).padStart(2,'0')}s`; }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }


function getRouteTableText(){
  const candidates=Array.from(document.querySelectorAll('*'))
    .filter(el=>{ const t=el.innerText||''; return t.includes('Route ID')&&t.includes('Stage by time')&&(t.includes('DSP:')||t.includes('Not assigned')||t.includes('In progress')); })
    .sort((a,b)=>(b.innerText||'').length-(a.innerText||'').length);
  return candidates[0]?.innerText||'';
}

function cleanAssociateList(raw){
  if(!raw) return [];
  return String(raw).replace(/\s*,\s*/g,',').split(/[,\s]+/).map(x=>x.trim()).filter(Boolean)
    .filter(x=>/^[a-z][a-z0-9_.-]{2,}$/i.test(x))
    .filter(x=>!['picked','partially','progress','assigned','ready','not','in','dsp','route','routes','wave','stage','status','duration','priority','aisles','spr','type'].includes(x.toLowerCase()));
}

function parseVisibleRoutes(){
  const txt=getRouteTableText().replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').trim();
  const starts=[...txt.matchAll(/(\d{2}:\d{2})\s+(CA_[A-Z0-9]+)/g)];
  const routes=[];
  for(let i=0;i<starts.length;i++){
    const start=starts[i].index,end=i+1<starts.length?starts[i+1].index:txt.length;
    const chunk=txt.slice(start,end).trim();
    const wave=starts[i][1],route=starts[i][2];
    let status='Unknown';
    const statusMatch=chunk.match(/\b(Partially picked|In progress|Not assigned|Not ready|Picked)\b/i);
    if(statusMatch) status=statusMatch[1];
    const beforeStatus=statusMatch?chunk.slice(0,statusMatch.index).trim():chunk;
    const aisleMatches=[...beforeStatus.matchAll(/\b[A-Z]\d{2,3}\b/g)].map(m=>m[0]);
    const aisles=Array.from(new Set(aisleMatches));
    const aisleCount=aisles.length;
    const durationMatch=chunk.match(/(\d{2}:\d{2}:\d{2})\s*DSP:([A-Z0-9]+)/);
    const duration=durationMatch?durationMatch[1]:'';
    const dsp=durationMatch?durationMatch[2]:'';
    const durationSec=durationToSec(duration);
    const beforeDuration=durationMatch?chunk.slice(0,durationMatch.index).trim():chunk;
    const progressMatches=[...beforeDuration.matchAll(/(\d+)\s*\/\s*(\d+)/g)];
    const progressMatch=progressMatches.length?progressMatches[progressMatches.length-1]:null;
    const progress=progressMatch?`${progressMatch[1]}/${progressMatch[2]}`:'-';
    const bagsOversDone=progressMatch?Number(progressMatch[1]):0;
    const bagsOvers=progressMatch?Number(progressMatch[2]):0;
    const beforeProgress=progressMatch?beforeDuration.slice(0,progressMatch.index).trim():beforeDuration;
    const afterProgress=progressMatch?beforeDuration.slice(progressMatch.index+progressMatch[0].length).trim():'';
    const numericTokens=[...beforeProgress.matchAll(/\b(\d{1,5})\b/g)].map(m=>Number(m[1]));
    const volume=numericTokens.length?numericTokens[numericTokens.length-1]:0;
    const spr=volume,packages=bagsOvers;
    let associates=cleanAssociateList(afterProgress);
    if(!associates.length&&!/not assigned/i.test(status)) continue;
    associates=Array.from(new Set(associates));
    routes.push({wave,route,status,aisles,aisleCount,spr,volume,progress,bagsOversDone,bagsOvers,packages,associate:associates.length?associates.join(' , '):'Unassigned',associates,duration,durationSec,dsp,split:associates.length>1});
  }
  return routes;
}

async function readAllRoutePages(){
  const all=[];
  const navButtons=Array.from(document.querySelectorAll('nav[aria-label="Pagination navigation"] button'));
  const pageNumbers=navButtons.map(b=>{const label=b.getAttribute('aria-label')||'';const txt=(b.innerText||'').trim();const m=(label.match(/page\s+(\d+)/i)||txt.match(/^(\d+)$/));return m?Number(m[1]):null;}).filter(Boolean);
  const maxPage=Math.max(1,...pageNumbers);
  for(let page=1;page<=maxPage;page++){
    const btn=document.querySelector(`button[aria-label="Go to page ${page}"]`)||Array.from(document.querySelectorAll('nav[aria-label="Pagination navigation"] button')).find(b=>(b.innerText||'').trim()===String(page));
    if(btn){btn.click();await sleep(850);}
    all.push(...parseVisibleRoutes());
  }
  return Array.from(new Map(all.map(r=>[r.route,r])).values());
}

function routeAssociatesForStats(r){
  const fromArray=Array.isArray(r.associates)?r.associates:[];
  const fromString=cleanAssociateList(r.associate||'');
  return Array.from(new Set([...fromArray,...fromString])).filter(x=>x&&x.toLowerCase()!=='unassigned');
}

function buildWaveRiskMonitor(routes){
  const now=new Date();
  const risks=(routes||[]).map(r=>{const w=timeToday(r.wave);return Object.assign({},r,{minsToWave:diffMin(w,now)});})
    .filter(r=>{const st=String(r.status||'').toLowerCase();return r.minsToWave>=0&&r.minsToWave<=10&&(st==='not assigned'||st==='in progress');})
    .sort((a,b)=>a.minsToWave-b.minsToWave||a.wave.localeCompare(b.wave));
  if(!risks.length) return `<div class="risk-monitor ok-monitor"><div class="wave-title">Wave Risk Monitor</div><div class="no-wave">No routes at wave-freeze risk.</div></div>`;
  const rows=risks.map(r=>`<tr><td>${r.wave}</td><td>${r.minsToWave}m</td><td>${r.route}</td><td><span class="risk-pill">${r.status}</span></td><td>${r.associate||'Unassigned'}</td><td>${r.durationSec?secToMinText(r.durationSec):'-'}</td><td>${r.progress||'-'}</td></tr>`).join('');
  return `<div class="risk-monitor bad-monitor"><div class="wave-title">Wave Risk Monitor</div><div class="risk-alert-title">🚨 ROUTES AT RISK WITHIN 10 MIN</div><table class="risk-table"><thead><tr><th>Wave</th><th>ETA</th><th>Route</th><th>Status</th><th>Associate</th><th>Elapsed</th><th>Progress</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function buildPerformanceInsights(routes){
  const perfRoutes=(routes||[]).filter(r=>r.durationSec>0&&!/not assigned/i.test(r.status));
  if(!perfRoutes.length) return `<div class="perf-wrap"><div class="wave-title">Performance Insights</div><div class="no-wave">No route table data detected yet.</div></div>`;
  const pickerMap=new Map();
  perfRoutes.forEach(r=>{routeAssociatesForStats(r).forEach(a=>{if(!pickerMap.has(a))pickerMap.set(a,{associate:a,routes:0,totalSec:0,bagsOvers:0,totalSpr:0});const p=pickerMap.get(a);p.routes+=1;p.totalSec+=r.durationSec;p.bagsOvers+=r.packages;p.totalSpr+=r.spr||0;});});
  const pickers=Array.from(pickerMap.values()).map(p=>({associate:p.associate,routes:p.routes,avgSec:p.routes?p.totalSec/p.routes:0,avg:secToDuration(p.routes?p.totalSec/p.routes:0),bagsOvers:p.bagsOvers,avgSpr:p.routes?Math.round(p.totalSpr/p.routes):0}));
  const topPickers=[...pickers].sort((a,b)=>b.routes-a.routes||b.bagsOvers-a.bagsOvers).slice(0,15);
  const bottomPickers=[...pickers].sort((a,b)=>a.routes-b.routes||a.bagsOvers-b.bagsOvers).slice(0,15);
  const completed=perfRoutes.filter(r=>/^Picked/i.test(r.status));
  const fastest=[...completed].sort((a,b)=>a.durationSec-b.durationSec).slice(0,15);
  const slowest=[...completed].sort((a,b)=>b.durationSec-a.durationSec).slice(0,15);
  const effectiveAssignments=perfRoutes.reduce((sum,r)=>sum+Math.max(1,routeAssociatesForStats(r).length),0);
  const rowPickers=(items)=>items.map((p,i)=>`<tr><td>${i+1}</td><td>${p.associate}</td><td>${p.routes}</td><td>${p.avg}</td><td>${p.bagsOvers}</td></tr>`).join('');
  const rowRoutes=(items)=>items.map((r,i)=>`<tr><td>${i+1}</td><td>${r.wave}</td><td>${r.route}</td><td>${r.associate}${r.split?' <span class="tag">DOUBLE</span>':''}</td><td>${r.duration}</td><td>${r.progress}</td></tr>`).join('');
  return `<div class="perf-wrap"><div class="wave-title">Performance Insights</div><div class="perf-grid"><div class="perf-card"><div class="mini-title">Top 15 Pickers</div><table class="perf-table"><thead><tr><th>#</th><th>Associate</th><th>Routes</th><th>Avg</th><th>Bags-Overs</th></tr></thead><tbody>${rowPickers(topPickers)}</tbody></table></div><div class="perf-card"><div class="mini-title">Bottom 15 Pickers</div><table class="perf-table"><thead><tr><th>#</th><th>Associate</th><th>Routes</th><th>Avg</th><th>Bags-Overs</th></tr></thead><tbody>${rowPickers(bottomPickers)}</tbody></table></div><div class="perf-card"><div class="mini-title">Top 15 Fastest Routes</div><table class="perf-table"><thead><tr><th>#</th><th>Wave</th><th>Route</th><th>Associate</th><th>Time</th><th>Progress</th></tr></thead><tbody>${rowRoutes(fastest)}</tbody></table></div><div class="perf-card"><div class="mini-title">Top 15 Slowest Routes</div><table class="perf-table"><thead><tr><th>#</th><th>Wave</th><th>Route</th><th>Associate</th><th>Time</th><th>Progress</th></tr></thead><tbody>${rowRoutes(slowest)}</tbody></table></div></div><div class="info-line"><b>Physical routes parsed:</b> ${routes.length} · <b>Associate-route assignments:</b> ${effectiveAssignments}</div></div>`;
}


function reportDateParts(){
  const d=new Date();
  const date=d.toLocaleDateString('en-GB');
  const time=`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  const stamp=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}_${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}`;
  return {date,time,stamp};
}

function buildAssociateStats(routes){
  const perfRoutes=(routes||[]).filter(r=>r.durationSec>0&&!/not assigned/i.test(r.status));
  const pickerMap=new Map();
  perfRoutes.forEach(r=>{routeAssociatesForStats(r).forEach(a=>{if(!pickerMap.has(a))pickerMap.set(a,{associate:a,routes:0,totalSec:0,bagsOvers:0,volume:0,totalAisles:0});const p=pickerMap.get(a);p.routes+=1;p.totalSec+=r.durationSec||0;p.bagsOvers+=r.bagsOvers||r.packages||0;p.volume+=r.volume||r.spr||0;p.totalAisles+=r.aisleCount||0;});});
  return Array.from(pickerMap.values()).map(p=>({associate:p.associate,routes:p.routes,avgSec:p.routes?p.totalSec/p.routes:0,avg:secToDuration(p.routes?p.totalSec/p.routes:0),bagsOvers:p.bagsOvers,volume:p.volume,avgAisles:p.routes?(p.totalAisles/p.routes).toFixed(1):'0.0'}));
}

// Avg VS 15 min trend
function trackAvg(avg){
  if(!avg) return;
  const now=Date.now();
  AVG_HISTORY.push({time:now,avg});
  // keep last 20 min
  AVG_HISTORY=AVG_HISTORY.filter(e=>now-e.time<=20*60000);
}
function getAvgTrend(currentAvg){
  if(!currentAvg||AVG_HISTORY.length<2) return {text:'-',cls:'blue'};
  const now=Date.now();
  const fifteenAgo=AVG_HISTORY.filter(e=>now-e.time>=14*60000&&now-e.time<=16*60000);
  const ref=fifteenAgo.length?fifteenAgo[fifteenAgo.length-1].avg:AVG_HISTORY[0].avg;
  if(!ref) return {text:'-',cls:'blue'};
  const diff=currentAvg-ref;
  const pct=((diff/ref)*100).toFixed(1);
  if(Math.abs(diff)<0.1) return {text:'→ 0%',cls:'blue'};
  if(diff>0) return {text:`↑ +${pct}%`,cls:'bad'};
  return {text:`↓ ${pct}%`,cls:'ok'};
}

function buildMeetingSlackText(data){
  const parts=reportDateParts();
  const trend=getAvgTrend(data.avg);
  return [
    `*Pick & Stage — Operational Summary*`,
    `*Date:* ${parts.date} ${parts.time}`,
    `*Mode:* ${data.modeText}`,
    `*Latest Safe Start:* ${data.startLimit}`,
    `*Forecast Finish:* ${data.finishText}`,
    `*Last Wave:* ${data.waveRaw}`,
    `*VS Last Wave:* ${data.bufferText}`,
    `*Avg Route:* ${data.avg.toFixed(1)}m ${trend.text}`,
    `*Total Routes:* ${data.totalRoutes}`,
    `*Pending Routes:* ${data.routesPending}`,
    `*Capacity:* ${data.capacitySummary}`
  ].join('\n');
}

function buildFullSlackText(data){
  const parts=reportDateParts();
  const routes=data.routes||[];
  const associates=buildAssociateStats(routes).sort((a,b)=>b.routes-a.routes||b.volume-a.volume);
  const completed=routes.filter(r=>/^Picked/i.test(r.status));
  const fastest=[...completed].sort((a,b)=>a.durationSec-b.durationSec).slice(0,15);
  const slowest=[...completed].sort((a,b)=>b.durationSec-a.durationSec).slice(0,15);
  const routeLine=r=>`${r.wave} | ${r.route} | ${r.status} | ${r.associate||'Unassigned'} | ${r.duration||'-'} | Vol ${r.volume||r.spr||0} | Bags-Overs ${r.progress||'-'} | Aisles ${(r.aisles||[]).join(', ')||'-'} | DSP ${r.dsp||'-'}`;
  const pickerLine=(p,i)=>`${i+1}. ${p.associate} | Routes ${p.routes} | Avg ${p.avg} | Vol ${p.volume} | Bags-Overs ${p.bagsOvers} | Avg aisles ${p.avgAisles}`;
  const trend=getAvgTrend(data.avg);
  return [
    `*Pick & Stage Operations Dashboard — Full Report*`,
    `*Date:* ${parts.date} ${parts.time}`,
    `*Mode:* ${data.modeText}`,
    `*Total Routes:* ${data.totalRoutes}`,
    `*Pending Routes:* ${data.routesPending}`,
    `*Avg Route:* ${data.avg.toFixed(1)}m ${trend.text}`,
    `*Forecast Finish:* ${data.finishText}`,
    `*Latest Safe Start:* ${data.startLimit}`,
    `*Last Wave:* ${data.waveRaw}`,
    `*VS Last Wave:* ${data.bufferText}`,
    `*Capacity:* ${data.capacitySummary}`,
    ``,
    `*All Associates*`,
    associates.map(pickerLine).join('\n')||'No data.',
    ``,
    `*Top 15 Fastest Routes*`,
    fastest.map((r,i)=>`${i+1}. ${routeLine(r)}`).join('\n')||'No data.',
    ``,
    `*Top 15 Slowest Routes*`,
    slowest.map((r,i)=>`${i+1}. ${routeLine(r)}`).join('\n')||'No data.',
    ``,
    `*All Routes (${routes.length})*`,
    routes.map(routeLine).join('\n')||'No data.'
  ].join('\n');
}

function sendToSlackWebhook(webhookUrl, text){
  if(!webhookUrl){ alert('Configure el webhook en ⚙️ Config'); return; }
  GM_xmlhttpRequest({
    method:'POST',
    url:webhookUrl,
    headers:{'Content-Type':'application/json'},
    data:JSON.stringify({text}),
    onload(res){ if(res.status>=200&&res.status<300) alert('✅ Enviado a Slack'); else alert(`❌ Error Slack: ${res.status}`); },
    onerror(){ alert('❌ Error de conexión con Slack'); }
  });
}

async function sendSlackMeeting(){
  const data=await ensureReportData();
  if(!data){alert('No hay datos.');return;}
  const webhook=getConfig('webhookMeeting','');
  sendToSlackWebhook(webhook,buildMeetingSlackText(data));
}

async function sendSlackFull(){
  const data=await ensureReportData();
  if(!data){alert('No hay datos.');return;}
  const webhook=getConfig('webhookFull','');
  sendToSlackWebhook(webhook,buildFullSlackText(data));
}

function csvEscape(v){const s=String(v??'');return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;}
function buildCsv(data){
  const parts=reportDateParts();
  const rows=[['Date','Report Time','Wave','Route','Status','Associate','Duration','Duration Sec','Volume','Bags-Overs Progress','Bags-Overs Total','Aisles','Aisle Count','DSP']];
  (data.routes||[]).forEach(r=>{rows.push([parts.date,parts.time,r.wave,r.route,r.status,r.associate,r.duration,r.durationSec,r.volume||r.spr||0,r.progress,r.bagsOvers||r.packages||0,(r.aisles||[]).join(', '),r.aisleCount||0,r.dsp]);});
  rows.push([]);rows.push(['SUMMARY']);
  rows.push(['Mode',data.modeText]);rows.push(['Total Routes',data.totalRoutes]);rows.push(['Pending Routes',data.routesPending]);rows.push(['Avg Route',`${data.avg.toFixed(1)}m`]);rows.push(['Forecast Finish',data.finishText]);rows.push(['Latest Safe Start',data.startLimit]);rows.push(['Last Wave',data.waveRaw]);rows.push(['VS Last Wave',data.bufferText]);rows.push(['Capacity',data.capacitySummary]);
  return rows.map(r=>r.map(csvEscape).join(',')).join('\n');
}

async function copyTextToClipboard(txt){
  if(navigator.clipboard&&navigator.clipboard.writeText){await navigator.clipboard.writeText(txt);return true;}
  const ta=document.createElement('textarea');ta.value=txt;ta.style.position='fixed';ta.style.left='-9999px';document.body.appendChild(ta);ta.select();const ok=document.execCommand('copy');ta.remove();return ok;
}

async function ensureReportData(){await calc();return LAST_REPORT_DATA;}

async function exportCsvReport(){
  const data=await ensureReportData();
  if(!data){alert('No hay datos.');return;}
  const parts=reportDateParts();
  const csv=buildCsv(data);
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=`pick_stage_report_${parts.stamp}.csv`;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
}

function buildRecoveryLevers(riskMinRaw,avg){
  if(riskMinRaw<=0) return {html:`<div class="recovery-card ok-card"><div class="mini-title">Recovery Plan</div><div class="recovery-main ok">NO EXTRA SUPPORT</div><div class="info-line">Last wave covered with current capacity windows.</div></div>`,remainingRisk:0,remainingRoutesAtRisk:0,text:'No extra support needed'};
  const routesAtRisk=Math.ceil(riskMinRaw/avg);
  return {html:`<div class="recovery-card risk-card"><div class="mini-title">Recovery Plan</div><div class="recovery-main bad">${routesAtRisk} ROUTES AT RISK</div><div class="info-line"><b>Gap:</b> ${riskMinRaw}m · ${routesAtRisk} routes</div><div class="info-line"><b>Action:</b> Add support window or pull routes forward.</div></div>`,remainingRisk:riskMinRaw,remainingRoutesAtRisk:routesAtRisk,text:`${routesAtRisk} routes at risk`};
}


function injectCSS(){
  if(byId(PANEL_ID+'-css')) return;
  const s=appDoc().createElement('style');
  s.id=PANEL_ID+'-css';
  s.textContent=`
#${MINI_ID}{position:fixed!important;left:20px!important;bottom:20px!important;z-index:2147483647!important;background:linear-gradient(135deg,#146EB4,#1E88E5);color:white;border-radius:16px;padding:17px 34px;font-family:Arial,sans-serif;font-size:16px;font-weight:900;box-shadow:0 16px 45px rgba(0,0,0,.65),0 0 30px rgba(20,110,180,.35);cursor:pointer;border:1px solid rgba(255,255,255,.22);letter-spacing:.4px;}
#${OVERLAY_ID}{position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;width:100vw!important;height:100vh!important;z-index:2147483647!important;background:#020617!important;display:flex!important;align-items:stretch!important;justify-content:stretch!important;padding:0!important;margin:0!important;box-sizing:border-box!important;overflow:hidden!important;}
#${PANEL_ID}{position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;width:100vw!important;height:100vh!important;min-width:100vw!important;min-height:100vh!important;max-width:100vw!important;max-height:100vh!important;background:#0b1220;color:white;border-radius:0!important;font-family:Arial,sans-serif;border:0!important;overflow:hidden!important;display:flex;flex-direction:column;margin:0!important;padding:0!important;}
#${PANEL_ID} .h{background:linear-gradient(135deg,#146EB4,#1E88E5);padding:10px 22px;color:white;position:relative;flex:0 0 auto;box-shadow:0 6px 20px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:space-between;}
#${PANEL_ID} .h-left{display:flex;gap:8px;align-items:center;}
#${PANEL_ID} .h-center{text-align:center;flex:1;}
#${PANEL_ID} .h-right{display:flex;gap:8px;align-items:center;}
#${PANEL_ID} .t{font-size:20px;font-weight:900;letter-spacing:-.4px}
#${PANEL_ID} .s{font-size:10px;font-weight:900;opacity:.86}
#${PANEL_ID} .hbtn{height:32px;border-radius:10px;background:#0b1220;color:white;border:0;font-size:11px;font-weight:900;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0 12px;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,.25);}
#${PANEL_ID} .hbtn:hover{background:#020617;}
#${PANEL_ID} .clock-display{font-size:13px;font-weight:900;color:white;opacity:.95;}
#${PANEL_ID} .countdown-display{font-size:11px;font-weight:900;color:#facc15;margin-left:4px;}
#${PANEL_ID} .b{flex:1 1 auto;padding:10px;box-sizing:border-box;overflow-y:auto!important;overflow-x:hidden!important;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#146EB4 #0f172a;}
#${PANEL_ID} .main-layout{display:grid;grid-template-columns:335px 1fr;gap:10px;min-height:100%;}
#${PANEL_ID} .panel-box{background:#111827;border-radius:16px;padding:10px;border:1px solid rgba(255,255,255,.12);box-shadow:0 8px 30px rgba(0,0,0,.25);}
#${PANEL_ID} .section-title{font-size:9px;color:#4FA3E3;text-transform:uppercase;font-weight:900;margin:1px 0 6px;letter-spacing:.7px;}
#${PANEL_ID} .input-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 8px;}
#${PANEL_ID} .r{display:grid;grid-template-columns:1fr;gap:3px;align-items:center;margin-bottom:5px;}
#${PANEL_ID} label{font-size:10px;color:#cbd5e1;font-weight:800}
#${PANEL_ID} input{background:#0f172a;color:white;border:1px solid #334155;border-radius:9px;padding:7px;font-size:12px;outline:none;width:100%;box-sizing:border-box;}
#${PANEL_ID} input:focus{border-color:#1E88E5;box-shadow:0 0 0 2px rgba(30,136,229,.22)}
#${PANEL_ID} button.calc{width:100%;padding:10px;background:#ff9900;color:#111;border:0;border-radius:12px;font-weight:900;cursor:pointer;margin-top:7px;font-size:13px;}
#${PANEL_ID} .hint{font-size:10px;color:#facc15;line-height:1.2;margin:5px 0;font-weight:800}
#${PANEL_ID} .executive-card{background:linear-gradient(135deg,#0f172a,#111827);border:1px solid rgba(79,163,227,.35);border-radius:16px;padding:12px;box-shadow:0 10px 32px rgba(0,0,0,.22);}
#${PANEL_ID} .ops-layout{display:grid;grid-template-columns:1.35fr .65fr;gap:10px;align-items:stretch;}
#${PANEL_ID} .ops-card{background:#08111f;border-radius:14px;padding:12px;border:2px solid rgba(79,163,227,.25);}
#${PANEL_ID} .ops-title{font-size:11px;text-transform:uppercase;font-weight:900;color:#4FA3E3;letter-spacing:.7px;margin-bottom:8px;}
#${PANEL_ID} .ops-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;}
#${PANEL_ID} .ops-line{font-size:12px;font-weight:800;color:#cbd5e1;line-height:1.25;}
#${PANEL_ID} .ops-line b{color:white;font-weight:900;}
#${PANEL_ID} .summary-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-top:10px;}
#${PANEL_ID} .summary-item{background:#0f172a;border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:8px;min-height:50px;}
#${PANEL_ID} .summary-label{font-size:8px;text-transform:uppercase;font-weight:900;color:#94a3b8;letter-spacing:.45px;}
#${PANEL_ID} .summary-value{font-size:18px;font-weight:900;line-height:1;margin-top:5px;}
#${PANEL_ID} .info-line{font-size:12px;color:#cbd5e1;margin-top:4px;line-height:1.2}
#${PANEL_ID} .recovery-card{border-radius:14px;padding:10px;border:2px solid rgba(255,255,255,.1);background:#0f172a;height:100%;box-sizing:border-box}
#${PANEL_ID} .risk-card{border-color:rgba(255,107,107,.9);box-shadow:0 0 18px rgba(255,107,107,.1)}
#${PANEL_ID} .ok-card{border-color:rgba(74,222,128,.85);box-shadow:0 0 18px rgba(74,222,128,.1)}
#${PANEL_ID} .recovery-main{font-size:20px;font-weight:900;margin-top:3px;line-height:1}
#${PANEL_ID} .wave-title{font-size:13px;color:#4FA3E3;font-weight:900;margin:10px 0 6px;text-transform:uppercase;letter-spacing:.5px;}
#${PANEL_ID} .wave-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:8px;}
#${PANEL_ID} .wave-card{background:#0f172a;border:2px solid rgba(255,255,255,.1);border-radius:14px;padding:10px;min-height:82px;}
#${PANEL_ID} .wave-card.ok-border{border-color:rgba(74,222,128,.85)}
#${PANEL_ID} .wave-card.bad-border{border-color:rgba(255,107,107,.9)}
#${PANEL_ID} .wave-card.done-border{border-color:rgba(79,163,227,.95)}
#${PANEL_ID} .wave-time{font-weight:900;font-size:21px;line-height:1}
#${PANEL_ID} .wave-status{font-weight:900;font-size:17px;margin-top:5px;line-height:1}
#${PANEL_ID} .wave-buffer{font-weight:900;font-size:19px;margin-top:4px;line-height:1}
#${PANEL_ID} .wave-routes{font-size:10px;color:#cbd5e1;margin-top:5px;font-weight:800}
#${PANEL_ID} .risk-monitor{margin-top:10px;background:#0f172a;border-radius:14px;padding:10px;border:2px solid rgba(255,255,255,.1);}
#${PANEL_ID} .bad-monitor{border-color:rgba(255,107,107,.9);box-shadow:0 0 20px rgba(255,107,107,.14);}
#${PANEL_ID} .ok-monitor{border-color:rgba(74,222,128,.45);}
#${PANEL_ID} .risk-alert-title{font-size:17px;font-weight:900;color:#ef4444;margin:4px 0 8px;}
#${PANEL_ID} .risk-table{width:100%;border-collapse:collapse;font-size:11px;}
#${PANEL_ID} .risk-table th{color:#94a3b8;font-size:8px;text-transform:uppercase;text-align:left;padding:5px 4px;border-bottom:1px solid rgba(255,255,255,.12);}
#${PANEL_ID} .risk-table td{color:#e5e7eb;padding:6px 4px;border-bottom:1px solid rgba(255,255,255,.07);white-space:nowrap;}
#${PANEL_ID} .risk-pill{background:#ef4444;color:white;border-radius:999px;padding:2px 6px;font-size:9px;font-weight:900;}
#${PANEL_ID} .perf-wrap{margin-top:10px}
#${PANEL_ID} .perf-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
#${PANEL_ID} .perf-card{background:#0f172a;border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:9px;overflow:hidden;}
#${PANEL_ID} .perf-table{width:100%;border-collapse:collapse;font-size:10px;}
#${PANEL_ID} .perf-table th{color:#94a3b8;font-size:8px;text-transform:uppercase;text-align:left;padding:4px 3px;border-bottom:1px solid rgba(255,255,255,.1);}
#${PANEL_ID} .perf-table td{color:#e5e7eb;padding:4px 3px;border-bottom:1px solid rgba(255,255,255,.06);white-space:nowrap;}
#${PANEL_ID} .tag{font-size:8px;background:#ff9900;color:#111;font-weight:900;border-radius:999px;padding:1px 4px;margin-left:3px;}
#${PANEL_ID} .no-wave{background:#0f172a;border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:10px;font-size:14px;font-weight:900;color:#4ade80;}
#${PANEL_ID} .report-actions{display:grid;grid-template-columns:1fr 1fr 1fr;gap:7px;margin-top:7px;}
#${PANEL_ID} .reportbtn{width:100%;padding:9px;background:#0b1220;color:white;border:1px solid rgba(79,163,227,.45);border-radius:12px;font-weight:900;cursor:pointer;font-size:12px;}
#${PANEL_ID} .reportbtn:hover{background:#020617;}
#config-modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);z-index:2147483648;display:flex;align-items:center;justify-content:center;}
#config-modal{background:#111827;border:1px solid rgba(79,163,227,.5);border-radius:16px;padding:20px;width:380px;max-width:90vw;color:white;font-family:Arial,sans-serif;}
#config-modal h3{margin:0 0 12px;font-size:16px;color:#4FA3E3;}
#config-modal label{display:block;font-size:11px;color:#cbd5e1;font-weight:800;margin:8px 0 3px;}
#config-modal input{width:100%;box-sizing:border-box;background:#0f172a;color:white;border:1px solid #334155;border-radius:9px;padding:7px;font-size:12px;outline:none;}
#config-modal input:focus{border-color:#1E88E5;}
#config-modal .cfg-btns{display:flex;gap:8px;margin-top:14px;}
#config-modal .cfg-btns button{flex:1;padding:9px;border-radius:10px;font-weight:900;cursor:pointer;border:0;font-size:12px;}
#config-modal .cfg-save{background:#ff9900;color:#111;}
#config-modal .cfg-cancel{background:#334155;color:white;}
.ok{color:#22c55e;font-weight:900}.bad{color:#ef4444;font-weight:900}.warn{color:#facc15;font-weight:900}.blue{color:#4FA3E3;font-weight:900}.orange{color:#ff9900;font-weight:900}.done{color:#4FA3E3;font-weight:900}
`;
  appHead().appendChild(s);
}

function showConfigModal(){
  if(byId('config-modal-overlay')) return;
  const ov=appDoc().createElement('div');
  ov.id='config-modal-overlay';
  ov.innerHTML=`<div id="config-modal">
    <h3>⚙️ Configuration</h3>
    <label>Webhook Meeting (Slack URL)</label><input id="cfg-webhookMeeting" value="${getConfig('webhookMeeting','')}">
    <label>Webhook Full Report (Slack URL)</label><input id="cfg-webhookFull" value="${getConfig('webhookFull','')}">
    <label>Primera wave (HH:MM)</label><input id="cfg-firstWave" type="time" value="${getConfig('firstWave','09:50')}">
    <label>Intervalo waves (min)</label><input id="cfg-waveInterval" type="number" value="${getConfig('waveInterval',20)}" min="1">
    <label>Delay live (min)</label><input id="cfg-liveDelay" type="number" value="${getConfig('liveDelay',4)}" min="0">
    <div class="cfg-btns"><button class="cfg-save" id="cfg-save-btn">GUARDAR</button><button class="cfg-cancel" id="cfg-cancel-btn">CANCELAR</button></div>
  </div>`;
  appBody().appendChild(ov);
  byId('cfg-save-btn').onclick=()=>{
    setConfig('webhookMeeting',byId('cfg-webhookMeeting').value.trim());
    setConfig('webhookFull',byId('cfg-webhookFull').value.trim());
    setConfig('firstWave',byId('cfg-firstWave').value);
    setConfig('waveInterval',Number(byId('cfg-waveInterval').value)||20);
    setConfig('liveDelay',Number(byId('cfg-liveDelay').value)||4);
    ov.remove();
  };
  byId('cfg-cancel-btn').onclick=()=>ov.remove();
}

// Live clock + countdown
function updateClockAndCountdown(){
  const clockEl=byId('pf-live-clock');
  const countEl=byId('pf-countdown');
  if(!clockEl) return;
  const now=new Date();
  clockEl.textContent=fmt(now);
  if(!countEl) return;
  const firstWave=getConfig('firstWave','09:50');
  const interval=Number(getConfig('waveInterval',20));
  const waveRaw=byId('pf-wave')?.value;
  if(!firstWave||!waveRaw) {countEl.textContent='';return;}
  const waves=generateWaveTimes(firstWave,waveRaw,interval);
  const next=waves.find(w=>w>now);
  if(!next){countEl.textContent='Done';return;}
  const secs=Math.max(0,Math.round((next-now)/1000));
  const mm=Math.floor(secs/60),ss=secs%60;
  countEl.textContent=`⏱ ${mm}:${String(ss).padStart(2,'0')}`;
}

function startAutoRefresh(){
  if(AUTO_REFRESH_TIMER) clearInterval(AUTO_REFRESH_TIMER);
  AUTO_REFRESH_TIMER=setInterval(()=>{calc();},45000);
}

function lockBodyScroll(lock){
  try{
    const s=lock?'hidden':'';
    appDoc().documentElement.style.overflow=s;appDoc().body.style.overflow=s;
    document.documentElement.style.overflow=s;document.body.style.overflow=s;
  }catch(e){}
}

function toggleFullscreen(){
  try{
    const d=appDoc();
    const isFull=!!(d.fullscreenElement||d.webkitFullscreenElement);
    if(isFull){if(d.exitFullscreen)d.exitFullscreen();else if(d.webkitExitFullscreen)d.webkitExitFullscreen();}
    else{const el=byId(OVERLAY_ID);if(el?.requestFullscreen)el.requestFullscreen();else if(el?.webkitRequestFullscreen)el.webkitRequestFullscreen();}
  }catch(e){}
}


function showMini(){
  injectCSS();byId(OVERLAY_ID)?.remove();byId(MINI_ID)?.remove();lockBodyScroll(false);
  const mini=appDoc().createElement('div');mini.id=MINI_ID;mini.textContent='📊 PICK & STAGE DASHBOARD';
  mini.onclick=()=>{const store=getStore();store.minimized=false;setStore(store);mini.remove();render(false,true);};
  appBody().appendChild(mini);
}

function minimizePanel(){const store=getStore();store.minimized=true;setStore(store);showMini();}

function render(allowMini=true,fromClick=false){
  injectCSS();
  const store=getStore();
  if(allowMini&&store.minimized===true){showMini();return;}
  byId(MINI_ID)?.remove();byId(OVERLAY_ID)?.remove();lockBodyScroll(true);
  const overlay=appDoc().createElement('div');overlay.id=OVERLAY_ID;
  const p=appDoc().createElement('div');p.id=PANEL_ID;
  p.innerHTML=`
<div class="h">
  <div class="h-center">
    <div class="t">Pick & Stage Operations Dashboard</div>
    <div class="s">Created by Pablllan · <span class="clock-display" id="pf-live-clock"></span> <span class="countdown-display" id="pf-countdown"></span></div>
  </div>
</div>
<div class="b"><div class="main-layout">
  <div class="panel-box">
    <div class="section-title">Capacity Setup</div>
    <div class="input-grid">
      <div class="r"><label>Associates NS</label><input id="pf-now" type="number" value="7" min="0"></div>
      <div class="r"><label>Associates AMPT</label><input id="pf-next" type="number" value="4" min="0"></div>
      <div class="r"><label>Salida NS</label><input id="pf-ns" type="time" value="09:30"></div>
      <div class="r"><label>Última wave</label><input id="pf-wave" type="time" value="10:50"></div>
      <div class="r"><label>Rutas por wave</label><input id="pf-routes-per-wave" type="number" value="40" min="1"></div>
    </div>
    <div class="section-title" style="margin-top:8px">Additional capacity</div>
    <div class="input-grid">
      <div class="r"><label>Yard Marshals</label><input id="pf-ym" type="number" value="0" min="0"></div>
      <div class="r"><label>YM start</label><input id="pf-ym-start" type="time" value="07:00"></div>
      <div class="r"><label>YM end</label><input id="pf-ym-end" type="time" value="09:30"></div>
    </div>
    <div class="section-title" style="margin-top:8px">Extra levers window</div>
    <div class="input-grid">
      <div class="r"><label>Extra levers</label><input id="pf-extra-levers" type="number" value="0" min="0"></div>
      <div class="r"><label>Extra start</label><input id="pf-extra-start" type="time" value="09:30"></div>
      <div class="r"><label>Extra end</label><input id="pf-extra-end" type="time" value="10:00"></div>
    </div>
    <div class="section-title" style="margin-top:8px">Planning mode</div>
    <div class="hint">Si ya has empezado rutas, deja vacío. Si no, rellena previsión manual.</div>
    <div class="input-grid">
      <div class="r"><label>Rutas previstas</label><input id="pf-routes-manual" type="number" min="0" placeholder="vacío"></div>
      <div class="r"><label>Tiempo de ruta</label><input id="pf-override" placeholder="vacío / 13 / 13:30"></div>
      <div class="r"><label>Hora inicio rutas</label><input id="pf-start" type="time"></div>
    </div>
    <button class="calc" id="pf-btn">CALCULAR</button>
    <div class="report-actions">
      <button class="reportbtn" id="pf-fullscreen">⛶ FULLSCREEN</button>
      <button class="reportbtn" id="pf-csv">📈 EXPORT CSV</button>
      <button class="reportbtn" id="pf-slack-meeting">📤 SLACK MEETING</button>
      <button class="reportbtn" id="pf-slack-full">📤 SLACK FULL</button>
      <button class="reportbtn" id="pf-config">⚙️ CONFIG</button>
      <button class="reportbtn" id="pf-min">❌ CERRAR</button>
    </div>
  </div>
  <div class="panel-box"><div id="pf-res">Esperando datos...</div></div>
</div></div>`;
  overlay.appendChild(p);appBody().appendChild(overlay);
  loadAllFields();
  byId('pf-min').onclick=minimizePanel;
  byId('pf-fullscreen').onclick=toggleFullscreen;
  byId('pf-config').onclick=showConfigModal;
  byId('pf-slack-meeting').onclick=sendSlackMeeting;
  byId('pf-slack-full').onclick=sendSlackFull;
  byId('pf-btn').onclick=calc;
  byId('pf-csv').onclick=exportCsvReport;
  FIELD_IDS.forEach(id=>{const el=byId(id);if(!el)return;el.addEventListener('input',()=>{saveField(id);calc();});el.addEventListener('change',()=>{saveField(id);calc();});});
  calc();
  startAutoRefresh();
  setInterval(updateClockAndCountdown,1000);
  updateClockAndCountdown();
  if(fromClick) setTimeout(()=>toggleFullscreen(),100);
}


function buildWaveCards(firstWaveRaw,lastWaveRaw,interval,start,planningMode,routes,totalRoutes,avg,windows){
  const routesPerWave=Number(byId('pf-routes-per-wave')?.value||40);
  const waves=generateWaveTimes(firstWaveRaw,lastWaveRaw,interval);
  const title=planningMode?'All waves forecast':'Wave forecast';
  if(!waves.length) return `<div class="wave-title">${title}</div><div class="no-wave">No waves configured</div>`;
  const now=new Date();
  const safeTotalRoutes=Math.max(0,totalRoutes||routes||0);
  const pendingRoutes=Math.max(0,routes||0);
  const completedRoutes=planningMode?0:Math.max(0,safeTotalRoutes-pendingRoutes);
  const cards=waves.map((w,i)=>{
    let cumulativeRoutes,progressText,workForWave,cls,status,bufferText,borderClass;
    if(planningMode){
      cumulativeRoutes=Math.min(routes,(i+1)*routesPerWave);
      workForWave=cumulativeRoutes*avg;
      progressText=`${cumulativeRoutes} routes`;
      const finishForWave=finishWithCapacity(start,workForWave,windows);
      const rawBuffer=finishForWave?diffMin(w,finishForWave):-9999;
      cls=rawBuffer>=0?'ok':'bad';status=rawBuffer>=0?'OK':'RISK';
      bufferText=rawBuffer>=0?`+${rawBuffer}m`:`-${Math.abs(rawBuffer)}m`;
      borderClass=rawBuffer>=0?'ok-border':'bad-border';
    }else{
      const waveStart=i*routesPerWave,waveEnd=Math.min(safeTotalRoutes,(i+1)*routesPerWave);
      const waveSize=Math.max(0,waveEnd-waveStart);
      const waveCompleted=Math.max(0,Math.min(waveSize,completedRoutes-waveStart));
      const pct=waveSize>0?Math.round((waveCompleted/waveSize)*100):100;
      const remainingToThisWave=Math.max(0,waveEnd-completedRoutes);
      workForWave=remainingToThisWave*avg;
      progressText=`${waveCompleted}/${waveSize} · ${pct}%`;
      const isCompleted=waveSize>0&&waveCompleted>=waveSize;
      const isPast=w<now;
      if(isCompleted||isPast||waveSize===0){
        cls='done';status='DONE';bufferText=isCompleted?'100%':waveSize===0?'No routes':'Closed';borderClass='done-border';
      }else{
        const finishForWave=finishWithCapacity(start,workForWave,windows);
        const rawBuffer=finishForWave?diffMin(w,finishForWave):-9999;
        cls=rawBuffer>=0?'ok':'bad';status=rawBuffer>=0?'OK':'RISK';
        bufferText=rawBuffer>=0?`+${rawBuffer}m`:`-${Math.abs(rawBuffer)}m`;
        borderClass=rawBuffer>=0?'ok-border':'bad-border';
      }
    }
    return `<div class="wave-card ${borderClass}"><div class="wave-time">${fmt(w)}</div><div class="wave-status ${cls}">${status}</div><div class="wave-buffer ${cls}">${bufferText}</div><div class="wave-routes">${progressText}</div></div>`;
  }).join('');
  return `<div class="wave-title">${title}</div><div class="wave-grid">${cards}</div>`;
}


async function calc(){
  const pageRoutes=findNotAssigned();
  const totalRoutesLive=findTotalRoutes();
  const manualRoutes=parseRoutes(byId('pf-routes-manual')?.value);
  const planningMode=manualRoutes!==null;
  const routes=planningMode?manualRoutes:pageRoutes;
  const totalRoutes=planningMode?manualRoutes:(totalRoutesLive||pageRoutes);
  const systemAvg=findAvgRoute();
  const override=parseDuration(byId('pf-override')?.value);
  const avg=override||systemAvg;
  const firstWaveRaw=getConfig('firstWave','09:50');
  const waveRaw=byId('pf-wave')?.value;
  const interval=Number(getConfig('waveInterval',20));
  const liveDelay=Number(getConfig('liveDelay',4));

  if(routes==null||avg==null){byId('pf-res').innerHTML=`<span class="bad">No pude leer rutas o average. Si no hay datos, mete Rutas previstas y Tiempo de ruta.</span>`;return;}

  trackAvg(avg);
  const trend=getAvgTrend(avg);

  const assocNS=Number(byId('pf-now')?.value||0);
  const assocAMPT=Number(byId('pf-next')?.value||0);
  const startRaw=byId('pf-start')?.value;
  const totalWork=routes*avg;
  const totalRoutesWork=(totalRoutes||routes||0)*avg;

  let start,delayText='';
  if(planningMode){
    if(startRaw) start=timeToday(startRaw);
    else start=latestStartForCapacity(totalRoutesWork,waveRaw,assocNS,assocAMPT);
  }else{
    start=startRaw?timeToday(startRaw):addMin(new Date(),liveDelay);
    if(!startRaw&&liveDelay>0) delayText=` · delay ${liveDelay}m`;
  }

  const lastWave=waveTime(waveRaw,start);
  const windows=buildCapacityWindows(start);
  if(!windows.length){byId('pf-res').innerHTML=`<span class="bad">Sin capacidad disponible.</span>`;return;}

  const finish=routes===0?start:finishWithCapacity(start,totalWork,windows);
  if(!finish){byId('pf-res').innerHTML=`<span class="bad">No se puede terminar antes del horizonte.</span>`;return;}

  const rawBuffer=diffMin(lastWave,finish);
  const riskMinRaw=Math.max(0,-rawBuffer);
  const recovery=buildRecoveryLevers(riskMinRaw,avg);
  const statusClass=rawBuffer>=0?'ok':'bad';
  const modeText=planningMode?`Planning${startRaw?` desde ${fmt(start)}`:' · auto latest safe start'}`:`Live tracking${delayText}`;

  let startLimit='-';
  if((totalRoutes||routes)>0){const ls=latestStartForCapacity(totalRoutesWork,waveRaw,assocNS,assocAMPT);startLimit=ls?fmt(ls):'N/A';}

  const amptMaxRoutes=calcAmptMaxRoutes(avg,start,lastWave);
  const riskRoutesText=recovery.remainingRoutesAtRisk||0;
  const waveCards=buildWaveCards(firstWaveRaw,waveRaw,interval,start,planningMode,routes,totalRoutes,avg,windows);
  const capacitySummary=describeWindows(windows);

  let perfRoutes=[];
  let waveRiskHtml=`<div class="risk-monitor ok-monitor"><div class="wave-title">Wave Risk Monitor</div><div class="no-wave">Live route data only.</div></div>`;
  let performanceHtml=`<div class="perf-wrap"><div class="wave-title">Performance Insights</div><div class="no-wave">Loading...</div></div>`;

  if(!planningMode){
    try{perfRoutes=await readAllRoutePages();waveRiskHtml=buildWaveRiskMonitor(perfRoutes);performanceHtml=buildPerformanceInsights(perfRoutes);}catch(e){}
  }

  LAST_REPORT_DATA={generatedAt:new Date(),modeText,totalRoutes:totalRoutes||routes,routesPending:routes,avg,finishText:routes===0?'Ahora':fmt(finish),startLimit,waveRaw,bufferText:rawBuffer>=0?`+${rawBuffer}m`:`-${Math.abs(rawBuffer)}m`,riskRoutesText,capacitySummary,routes:perfRoutes||[],planningMode};

  byId('pf-res').innerHTML=`
<div class="executive-card">
  <div class="ops-layout">
    <div class="ops-card">
      <div class="ops-title">Operational Summary</div>
      <div class="ops-grid">
        <div class="ops-line"><b>Mode:</b> ${modeText}</div>
        <div class="ops-line"><b>Latest Safe Start:</b> ${startLimit}</div>
        <div class="ops-line"><b>Forecast Finish:</b> ${routes===0?'Ahora':fmt(finish)}</div>
        <div class="ops-line"><b>Last Wave:</b> ${waveRaw}</div>
        <div class="ops-line"><b>VS Last Wave:</b> <span class="${statusClass}">${rawBuffer>=0?`+${rawBuffer}m`:`-${Math.abs(rawBuffer)}m`}</span></div>
        <div class="ops-line"><b>Avg Route:</b> ${avg.toFixed(1)}m <span class="${trend.cls}">${trend.text}</span></div>
        <div class="ops-line"><b>Total Routes:</b> ${totalRoutes||routes}</div>
        <div class="ops-line"><b>Pending Routes:</b> ${routes}${planningMode?' PREV':''}</div>
        <div class="ops-line"><b>AMPT Max Routes:</b> ${amptMaxRoutes}</div>
        <div class="ops-line" style="grid-column:span 2"><b>Capacity:</b> ${capacitySummary}</div>
      </div>
    </div>
    ${recovery.html}
  </div>
  <div class="summary-grid">
    <div class="summary-item"><div class="summary-label">Total Routes</div><div class="summary-value">${totalRoutes||routes}</div></div>
    <div class="summary-item"><div class="summary-label">Pending</div><div class="summary-value">${routes}${planningMode?' PREV':''}</div></div>
    <div class="summary-item"><div class="summary-label">Avg Route</div><div class="summary-value">${avg.toFixed(1)}m</div></div>
    <div class="summary-item"><div class="summary-label">Finish</div><div class="summary-value">${routes===0?'Ahora':fmt(finish)}</div></div>
    <div class="summary-item"><div class="summary-label">VS Wave</div><div class="summary-value ${statusClass}">${rawBuffer>=0?`+${rawBuffer}m`:`-${Math.abs(rawBuffer)}m`}</div></div>
    <div class="summary-item"><div class="summary-label">Risk</div><div class="summary-value ${riskRoutesText>0?'bad':'ok'}">${riskRoutesText}</div></div>
  </div>
</div>
${waveCards}
${waveRiskHtml}
${performanceHtml}`;
}


function waitData(){
  setTimeout(()=>{
    const store=getStore();
    if(store.minimized===false) render(false,false);
    else showMini();
  },1500);
}

waitData();
})();
