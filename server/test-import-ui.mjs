import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

const baseUrl=process.env.QA_FRONTEND_URL||'http://127.0.0.1:5191';
const browser=await puppeteer.launch({headless:true,executablePath:process.env.CHROME_BIN||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--no-sandbox','--disable-gpu']});
const browserErrors=[];
const master={id:'qa-master',name:'Gestor QA',role:'master',functions:['Vocal'],active:true};
const branding={productName:'Louwy',organizationName:'QA',logoUrl:'/branding/primicias-logo.png',accentColor:'#d8ff55'};
const originalSong={id:'demo-qa',title:'Música existente',artist:'QA',originalKey:'C',duration:100,source:'demo'};
const importedSong={...originalSong,id:'imported-qa',title:'Música importada',source:'youtube'};
const event={id:'qa-event',title:'Evento QA',date:'2026-10-01',time:'19:00',createdAt:'2026-09-27',createdBy:master.id,vocalConfig:{highParts:3,lowParts:3},modules:[{id:'repertoire',kind:'repertoire',title:'Repertório',order:0}],participants:[{memberId:master.id,function:'Vocal',status:'pending'}],songs:[],messages:[],attachments:[]};

async function open(mode='success'){
  const page=await browser.newPage();
  await page.setViewport({width:390,height:844});
  await page.setBypassServiceWorker(true);
  page.on('pageerror',error=>browserErrors.push(error.message));
  const state={mode,imports:0,polls:0,eventWrites:0,completed:false,holdPost:false,holdPoll:false,holdCatalog:false,heldPost:false,heldPoll:false,heldCatalog:false,releasePost:null,releasePoll:null,releaseCatalog:null,workspace:{branding,members:[master],teams:[],events:[structuredClone(event)],profiles:{[master.id]:{library:[],folders:[],playlists:[]}}}};
  await page.setRequestInterception(true);
  page.on('request',request=>void handle(request).catch(error=>{if(!page.isClosed()&&!String(error).includes('Invalid InterceptionId'))throw error;}));
  async function handle(request){
    const path=new URL(request.url()).pathname;
    if(!path.startsWith('/api/')){await request.continue();return;}
    let status=200,body={};
    if(path==='/api/branding')body=branding;
    else if(path==='/api/auth/me')body={member:master};
    else if(path==='/api/workspace')body=state.workspace;
    else if(path==='/api/notifications')body={notifications:[]};
    else if(path==='/api/catalog'){
      if(state.completed&&state.holdCatalog){state.heldCatalog=true;await new Promise(resolve=>{state.releaseCatalog=resolve;});}
      if(state.completed&&state.mode==='refresh-failure'){status=503;body={error:'Catálogo indisponível para teste'};}
      else body=state.completed?[originalSong,importedSong]:[originalSong];
    }
    else if(path==='/api/import'){
      state.imports++;
      assert.equal(JSON.parse(request.postData()).asynchronous,true);
      if(state.holdPost){state.heldPost=true;await new Promise(resolve=>{state.releasePost=resolve;});}
      if(state.mode==='network'){await request.abort('failed');return;}
      if(state.mode==='html'){await request.respond({status:502,contentType:'text/html',body:'<html>Bad gateway</html>'});return;}
      if(state.mode==='duplicate'){status=409;body={duplicate:true,song:importedSong,error:'Já existe'};}
      else {status=202;body={jobId:'job-qa',status:'queued'};}
    }
    else if(path==='/api/import-jobs/job-qa'){
      state.polls++;
      if(state.holdPoll){state.heldPoll=true;await new Promise(resolve=>{state.releasePoll=resolve;});}
      if(state.mode==='provider')body={jobId:'job-qa',status:'error',code:'YOUTUBE_BLOCKED',error:'O YouTube bloqueou a importação neste servidor.'};
      else if(state.polls===1&&!state.holdPoll)body={jobId:'job-qa',status:'processing',stage:'downloading'};
      else {state.completed=true;body={jobId:'job-qa',status:'ready',song:importedSong};}
    }
    else if(path==='/api/events/qa-event/songs'){
      state.eventWrites++;
      const payload=JSON.parse(request.postData());
      body={...payload,id:'event-song',order:0,vocalAssignments:[],createdAt:new Date().toISOString()};
      state.workspace.events[0].songs.push(body);
    }
    else if(path.startsWith('/api/stems/'))body={status:'idle'};
    else if(path.startsWith('/api/lyrics/'))body={status:'ready',lyrics:[]};
    else if(path.startsWith('/api/profile/')){body=JSON.parse(request.postData()).profile;state.workspace.profiles[master.id]=body;}
    else {status=404;body={error:'Unexpected fixture path '+path};}
    await request.respond({status,contentType:'application/json',body:JSON.stringify(body)});
  }
  await page.goto(baseUrl,{waitUntil:'networkidle0'});
  await page.waitForSelector('.hero');
  return {page,state};
}
async function click(page,label){
  await page.waitForFunction(label=>[...(document.querySelector('.modal')||document).querySelectorAll('button')].some(el=>el.textContent.trim()===label&&el.getBoundingClientRect().width>0),{},label);
  await page.evaluate(label=>[...(document.querySelector('.modal')||document).querySelectorAll('button')].find(el=>el.textContent.trim()===label&&el.getBoundingClientRect().width>0).click(),label);
}
async function text(page,value){await page.waitForFunction(value=>document.body.textContent.includes(value),{},value);}
async function until(condition){const end=Date.now()+5000;while(!condition()){if(Date.now()>end)throw new Error('fixture state timed out');await new Promise(resolve=>setTimeout(resolve,10));}}
async function beginImport(page){await click(page,'Explorar');await page.click('.module-head .primary');await page.type('.modal .field input','https://youtu.be/3JUS_ueGjnA');await click(page,'Enviar música');}
async function closeImport(page){await page.click('[aria-label="Fechar importação"]');await page.waitForSelector('.modal',{hidden:true});}
async function assertNotNavigated(page){await new Promise(resolve=>setTimeout(resolve,150));assert.equal(await page.$('.studio-shell'),null);assert.equal(await page.$('.modal'),null);}

try{
  for(const [mode,message] of [['network','A conexão foi interrompida'],['html','O servidor não conseguiu responder'],['provider','O YouTube bloqueou']]){
    const {page,state}=await open(mode);await beginImport(page);await text(page,message);
    assert.equal(state.imports,1);assert.equal(await page.$eval('.modal .actions .primary',el=>el.disabled),false);
    assert.ok(!(await page.$eval('.modal',el=>el.textContent)).includes('Load failed'));
    await page.close();
  }
  console.log('PASS import network, HTML and provider errors stay friendly and allow retry');

  {
    const {page,state}=await open('refresh-failure');await beginImport(page);
    await text(page,'Na fila de processamento');await text(page,'Baixando e preparando');await text(page,'A música já foi importada');
    state.mode='success';await click(page,'Abrir música importada');await page.waitForSelector('.studio-shell');
    assert.equal(state.imports,1);assert.equal(state.polls,2);
    await page.close();
  }
  console.log('PASS queued stages and imported-song refresh recovery never repeat POST');

  for(const stage of ['Post','Poll','Catalog']){
    const {page,state}=await open();state['hold'+stage]=true;await beginImport(page);
    await until(()=>state['held'+stage]);
    if(stage==='Post')assert.ok(!(await page.$eval('.modal',el=>el.textContent)).includes('Você pode fechar'));
    await closeImport(page);
    const pollCount=state.polls;state['release'+stage]();
    await assertNotNavigated(page);await new Promise(resolve=>setTimeout(resolve,1600));assert.equal(state.polls,pollCount);
    await page.close();
  }
  console.log('PASS closing during POST, polling and catalog refresh ignores stale responses');

  {
    const {page,state}=await open();state.holdPost=true;
    await click(page,'Explorar');await page.click('.module-head .primary');await page.type('.modal .field input','https://youtu.be/3JUS_ueGjnA');
    await page.$eval('.modal .actions .primary',button=>{button.click();button.click();});
    await until(()=>state.heldPost);assert.equal(state.imports,1);
    await closeImport(page);state.releasePost();await page.close();
  }
  console.log('PASS immediate repeated clicks submit only one import');

  {
    const {page,state}=await open('duplicate');await beginImport(page);await page.waitForSelector('.duplicate-link');
    await page.click('.duplicate-link');await page.waitForSelector('.studio-shell');
    assert.equal(state.imports,1);assert.equal(state.polls,0);await page.close();
  }
  console.log('PASS immediate duplicate opens existing song without polling');

  {
    const {page,state}=await open('duplicate');await click(page,'Eventos');await page.click('.event-open');await click(page,'Enviar minha música');
    await page.type('.modal input[placeholder="https://youtube.com/watch?v=..."]','https://youtu.be/3JUS_ueGjnA');await click(page,'Enviar música');await page.waitForSelector('.duplicate-link');
    await page.click('.duplicate-link');await click(page,'Enviar música');await page.waitForSelector('.modal',{hidden:true});
    assert.equal(state.imports,1);assert.equal(state.eventWrites,1);assert.equal(state.workspace.events[0].songs[0].songId,importedSong.id);
    await page.close();
  }
  console.log('PASS event can use duplicate song absent from original catalog snapshot');

  {
    const {page,state}=await open('refresh-failure');await click(page,'Eventos');await page.click('.event-open');await click(page,'Enviar minha música');
    await page.type('.modal input[placeholder="https://youtube.com/watch?v=..."]','https://youtu.be/3JUS_ueGjnA');await click(page,'Enviar música');
    await text(page,'A música foi salva no evento');state.mode='success';await click(page,'Atualizar evento');await page.waitForSelector('.modal',{hidden:true});
    assert.equal(state.imports,1);assert.equal(state.eventWrites,1);await page.close();
  }
  console.log('PASS event refresh retry neither reimports nor duplicates repertoire entry');
  assert.deepEqual(browserErrors,[]);console.log('PASS no uncaught browser errors');
}finally{await browser.close();}
