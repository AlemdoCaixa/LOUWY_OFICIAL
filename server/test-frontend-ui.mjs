import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

// Isolated browser regressions. All API requests and audio use fixtures; no production data is touched.
const baseUrl=process.env.QA_FRONTEND_URL||'http://127.0.0.1:5191';
const browser=await puppeteer.launch({headless:true,executablePath:process.env.CHROME_BIN||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--no-sandbox','--disable-gpu','--autoplay-policy=no-user-gesture-required']});
const errors=[];
const master={id:'qa-master',name:'Gestor QA',phone:'11999990000',role:'master',functions:[],active:true};
const branding={productName:'Louwy',organizationName:'Ministério QA',logoUrl:'',accentColor:'#d8ff55'};
const song={id:'demo-qa',title:'Faixa QA',artist:'Teste',originalKey:'C',duration:15,audioUrl:'/qa-test.wav',source:'demo'};
const audio=Buffer.alloc(44+16000*15*2);audio.write('RIFF');audio.writeUInt32LE(audio.length-8,4);audio.write('WAVEfmt ',8);audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22);audio.writeUInt32LE(16000,24);audio.writeUInt32LE(32000,28);audio.writeUInt16LE(2,32);audio.writeUInt16LE(16,34);audio.write('data',36);audio.writeUInt32LE(audio.length-44,40);
for(let sample=0;sample<16000*15;sample++)audio.writeInt16LE(Math.round(800*Math.sin(2*Math.PI*220*sample/16000)),44+sample*2);

async function open({width=1440,loggedIn=true,catalogFailure=false}={}){
  const page=await browser.newPage();
  await page.setViewport({width,height:900});
  await page.setBypassServiceWorker(true);
  await page.evaluateOnNewDocument(()=>{
    const session={type:'auto'};
    Object.defineProperty(navigator,'audioSession',{configurable:true,value:session});
  });
  page.on('pageerror',(error)=>errors.push(error.message));
  const state={loggedIn,catalogFailure,teamFailure:false,eventFailure:false,profileFailure:false,identifyCalls:0,profileWrites:0,audioFailure:false,audioDelay:0,workspace:{branding,members:[master],teams:[],events:[],profiles:{[master.id]:{folders:[],library:[],playlists:[]}}}};
  await page.setRequestInterception(true);
  page.on('request',async(request)=>{
    const url=new URL(request.url());
    if(url.pathname==='/qa-test.wav'){
      const failed=state.audioFailure;
      if(state.audioDelay)await new Promise(resolve=>setTimeout(resolve,state.audioDelay));
      await request.respond(failed?{status:503,contentType:'application/json',body:'{"error":"Audio unavailable"}'}:{status:200,contentType:'audio/wav',body:audio});return;
    }
    if(!url.pathname.startsWith('/api/')){await request.continue();return;}
    const path=url.pathname,method=request.method();
    const payload=request.postData()?JSON.parse(request.postData()):{};
    let status=200,body={};
    if(path==='/api/branding')body=branding;
    else if(path==='/api/auth/me'){status=state.loggedIn?200:401;body=state.loggedIn?{member:master}:{error:'Entre novamente.'};}
    else if(path==='/api/auth/bootstrap-status')body={needsMasterSetup:false};
    else if(path==='/api/auth/identify'){state.identifyCalls++;await new Promise(resolve=>setTimeout(resolve,150));body={member:{id:master.id,name:master.name},firstAccess:false};}
    else if(path==='/api/auth/login'){state.loggedIn=true;body={member:master};}
    else if(path==='/api/auth/logout')state.loggedIn=false;
    else if(path==='/api/catalog'){status=state.catalogFailure?503:200;body=state.catalogFailure?{error:'Catálogo indisponível para teste'}:[song];}
    else if(path==='/api/workspace')body=state.workspace;
    else if(path==='/api/notifications')body={notifications:[]};
    else if(path===`/api/profile/${master.id}`){state.profileWrites++;status=state.profileFailure?503:200;if(state.profileFailure)body={error:'Falha de gravação para teste'};else{state.workspace.profiles[master.id]=payload.profile;body=payload.profile;}}
    else if(path==='/api/teams'&&method==='POST'){
      status=state.teamFailure?503:200;
      if(state.teamFailure)body={error:'Equipe indisponível para teste'};
      else{body={...payload,id:'qa-team',createdAt:new Date().toISOString()};state.workspace.teams.push(body);}
    }
    else if(path==='/api/events'&&method==='POST'){
      if(state.eventFailure){await request.abort('failed');return;}
      body={...payload,id:'qa-event',songs:[],messages:[],attachments:[],createdAt:new Date().toISOString()};state.workspace.events.push(body);
    }
    else {status=404;body={error:`Unexpected test API ${method} ${path}`};}
    await request.respond({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(baseUrl,{waitUntil:'networkidle0'});
  return {page,state};
}
async function button(page,label){
  await page.waitForFunction(label=>[...document.querySelectorAll('button')].some(el=>el.textContent.trim()===label&&el.getBoundingClientRect().width>0),{},label);
  await page.evaluate(label=>[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===label&&el.getBoundingClientRect().width>0).click(),label);
}
async function text(page,value){await page.waitForFunction(value=>document.body.textContent.includes(value),{},value);}
async function fill(page,selector,value){await page.click(selector,{clickCount:3});await page.type(selector,value);}
async function noOverflow(page){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'horizontal viewport overflow');}

try{
  const login=await open({loggedIn:false,width:390});
  await noOverflow(login.page);
  await login.page.type('.auth-field input','11999990000');
  await login.page.keyboard.press('Enter');
  await login.page.keyboard.press('Enter');
  await text(login.page,'Digite sua senha');
  assert.equal(login.state.identifyCalls,1,'Enter while identifying must not send duplicate requests');
  await login.page.type('input[type=password]','qa-password');
  await login.page.keyboard.press('Enter');
  await text(login.page,'Seu ambiente de louvor');
  await noOverflow(login.page);
  await login.page.close();
  console.log('PASS mobile login, duplicate-submit guard, layout');

  const {page,state}=await open({catalogFailure:true});
  await text(page,'Catálogo indisponível para teste');
  assert.equal(await page.$('.hero'),null,'failed load must not expose empty editable workspace');
  state.catalogFailure=false;
  await button(page,'Tentar novamente');
  await text(page,'Seu ambiente de louvor');
  await noOverflow(page);
  console.log('PASS application load failure and recovery');

  await button(page,'Pessoas & equipes');
  await button(page,'Nova equipe');
  await fill(page,'.modal input','Equipe QA');
  state.teamFailure=true;
  await button(page,'Criar equipe');
  await text(page,'Equipe indisponível para teste');
  assert.equal(await page.$eval('.modal .actions button',el=>el.disabled),false);
  state.teamFailure=false;
  await button(page,'Criar equipe');
  await page.waitForSelector('.custom-team-card');
  assert.equal(state.workspace.teams.length,1);
  console.log('PASS team HTTP failure, retry and create');

  await button(page,'Eventos');
  await button(page,'Novo evento');
  await fill(page,'.modal input','Evento QA');
  state.eventFailure=true;
  await button(page,'Criar evento');
  await page.waitForSelector('.modal [role=alert]');
  assert.equal(await page.$eval('.modal .actions button',el=>el.disabled),false);
  state.eventFailure=false;
  await button(page,'Criar evento');
  await page.waitForSelector('.modular-event-card');
  assert.equal(state.workspace.events.length,1);
  console.log('PASS event network failure, retry and create');

  await button(page,'Biblioteca');
  await button(page,'Nova pasta');
  await fill(page,'.modal input','Pasta QA');
  state.profileFailure=true;
  await button(page,'Salvar');
  await text(page,'Falha de gravação para teste');
  assert.equal(await page.$eval('.modal .actions button',el=>el.disabled),false);
  state.profileFailure=false;
  await button(page,'Salvar');
  await page.waitForSelector('.folder-name');
  assert.equal(state.workspace.profiles[master.id].folders.length,1);
  await button(page,'Explorar');
  await button(page,'+ Biblioteca');
  await text(page,'Na biblioteca');
  await button(page,'Playlists');
  await button(page,'Nova playlist');
  await fill(page,'.modal input','Playlist QA');
  await button(page,'Salvar');
  await page.waitForSelector('.playlist-card-real');
  await page.click('.playlist-card-real');
  await page.select('.playlist-add-box select',song.id);
  await page.waitForSelector('.playlist-order');
  assert.deepEqual(state.workspace.profiles[master.id].playlists[0].songIds,[song.id]);
  assert.equal(state.workspace.profiles[master.id].library.length,1);
  console.log('PASS failed profile save retains modal, retry, library and playlist creation');

  state.audioFailure=true;state.audioDelay=400;
  await button(page,'Estudar');
  await text(page,'Carregando áudio');
  await text(page,'Não consegui abrir esse áudio');
  state.audioFailure=false;state.audioDelay=0;
  await button(page,'Tentar carregar novamente');
  await page.waitForFunction(()=>{const play=document.querySelector('.transport .play');return play&&!play.disabled;});
  assert.equal(await page.$eval('.transport .play',el=>el.getAttribute('aria-label')),'Reproduzir');
  console.log('PASS audio loading feedback, failed load and retry');

  await page.evaluate(()=>{
    window.__qaOriginalResume=AudioContext.prototype.resume;
    AudioContext.prototype.resume=function(){window.__qaNativeContext=this;return Promise.reject(new DOMException('Test rejected resume','NotAllowedError'));};
  });
  await page.click('.transport .play');
  await text(page,'Toque em reproduzir para tentar novamente');
  assert.equal(await page.$eval('.transport .play',el=>el.disabled),false);
  await page.evaluate(()=>{AudioContext.prototype.resume=function(){return new Promise(()=>{});};});
  await page.click('.transport .play');
  await text(page,'Ativando áudio');
  await page.waitForFunction(()=>!document.querySelector('.transport .play').disabled,{timeout:7000});
  await page.evaluate(()=>{AudioContext.prototype.resume=window.__qaOriginalResume;});
  console.log('PASS rejected and unresolved context resume recover with explicit retry');

  await page.click('.transport .play');
  await page.waitForFunction(()=>Number(document.querySelector('.timeline').value)>4);
  assert.equal(await page.evaluate(()=>navigator.audioSession.type),'playback');
  const before=await page.$eval('.timeline',el=>Number(el.value));
  await button(page,'0.7x');
  await new Promise(resolve=>setTimeout(resolve,150));
  const after=await page.$eval('.timeline',el=>Number(el.value));
  assert.ok(after>=before-.2,`speed change jumped backwards: ${before} -> ${after}`);
  await page.click('.transport .play');
  await page.$eval('.timeline',el=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,el.max);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.click('.transport .play');
  await page.waitForFunction(()=>Number(document.querySelector('.timeline').value)<1);
  await page.click('.transport .play');
  assert.equal(await page.evaluate(()=>navigator.audioSession.type),'auto');
  console.log('PASS Studio speed continuity and restart at end');

  await page.click('.transport .play');
  await page.waitForFunction(()=>document.querySelector('.transport .play').getAttribute('aria-label')==='Pausar');
  await page.evaluate(()=>window.__qaNativeContext.suspend());
  await text(page,'O áudio foi interrompido pelo aparelho');
  assert.equal(await page.$eval('.transport .play',el=>el.getAttribute('aria-label')),'Reproduzir');
  await page.click('.transport .play');
  await page.waitForFunction(()=>document.querySelector('.transport .play').getAttribute('aria-label')==='Pausar');
  await page.click('.transport .play');
  console.log('PASS interrupted context pauses UI and resumes only on click');

  await page.evaluate(()=>{
    window.__qaStopped=0;
    navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>{window.__qaResolveMic=()=>resolve({getTracks:()=>[{stop:()=>window.__qaStopped++}]});});
  });
  await button(page,'Gravar voz');
  await text(page,'Abrindo o microfone');
  assert.equal(await page.evaluate(()=>navigator.audioSession.type),'play-and-record');
  await button(page,'Biblioteca');
  assert.equal(await page.evaluate(()=>navigator.audioSession.type),'auto');
  await page.evaluate(()=>window.__qaResolveMic());
  await page.waitForFunction(()=>window.__qaStopped===1);
  console.log('PASS pending microphone is released after leaving Studio');

  await button(page,'Estudar');
  await page.waitForFunction(()=>!document.querySelector('.transport .play').disabled);
  await page.evaluate(()=>{navigator.mediaDevices.getUserMedia=()=>new Promise((_,reject)=>{window.__qaRejectMic=()=>reject(new DOMException('Delayed denial','NotAllowedError'));});});
  await button(page,'Gravar voz');
  await text(page,'Abrindo o microfone');
  await button(page,'Biblioteca');
  await button(page,'Estudar');
  await page.waitForFunction(()=>!document.querySelector('.transport .play').disabled);
  await page.click('.transport .play');
  await page.waitForFunction(()=>document.querySelector('.transport .play').getAttribute('aria-label')==='Pausar');
  await page.evaluate(()=>window.__qaRejectMic());
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(await page.evaluate(()=>navigator.audioSession.type),'playback','stale mic rejection must not reset replacement player audio session');
  await page.click('.transport .play');
  console.log('PASS stale microphone rejection preserves active replacement playback');

  await page.evaluate(()=>{
    navigator.mediaDevices.getUserMedia=()=>Promise.resolve({getTracks:()=>[{stop(){}}]});
    window.MediaRecorder=class{
      static isTypeSupported(){return true;}
      state='inactive';mimeType='audio/webm';
      constructor(){window.__qaRecorder=this;}
      start(){this.state='recording';}
      stop(){this.state='inactive';}
    };
  });
  await button(page,'Gravar voz');
  await page.waitForFunction(()=>window.__qaRecorder?.onstart);
  await page.evaluate(()=>{window.__qaLateStart=window.__qaRecorder.onstart;window.__qaLateStop=window.__qaRecorder.onstop;});
  await button(page,'Biblioteca');
  assert.equal(await page.evaluate(()=>['onstart','onstop','ondataavailable','onerror'].every(key=>window.__qaRecorder[key]===null)),true);
  await page.evaluate(()=>{window.__qaLateStart();window.__qaLateStop();});
  assert.equal(await page.evaluate(()=>navigator.audioSession.type),'auto');
  console.log('PASS unmount clears recorder callbacks and ignores queued events');
  await page.close();
  assert.deepEqual(errors,[],'browser exceptions');
  console.log('PASS no uncaught browser exceptions');
}finally{await browser.close();}
