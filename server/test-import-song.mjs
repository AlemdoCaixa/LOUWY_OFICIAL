import assert from 'node:assert/strict';
import test from 'node:test';
import { importSong, uploadSong, importErrorMessage } from '../src/importSong.ts';

const song={id:'video-qa',title:'Música QA',artist:'Artista QA',originalKey:'C',duration:120,audioUrl:'/audio/video-qa.mp3'};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const options=(fetcher,overrides={})=>({signal:new AbortController().signal,fetcher,pollIntervalMs:1,requestTimeoutMs:100,...overrides});

 test('queued job reports stages then returns song without resubmitting',async()=>{
  const requests=[],progress=[];
  const replies=[json({jobId:'job-qa',status:'queued'},202),json({status:'queued'}),json({status:'processing',stage:'downloading'}),json({status:'ready',song})];
  const result=await importSong(' https://youtu.be/video-qa ','actor',options(async(path,init)=>{requests.push({path,init});return replies.shift();},{onProgress:value=>progress.push(value)}));
  assert.deepEqual(result,{song,duplicate:false});
  assert.equal(requests.filter(({init})=>init.method==='POST').length,1);
  assert.equal(JSON.parse(requests[0].init.body).asynchronous,true);
  assert.equal(JSON.parse(requests[0].init.body).url,'https://youtu.be/video-qa');
  assert.ok(requests.slice(1).every(({path,init})=>path==='/api/import-jobs/job-qa'&&init.method==='GET'));
  assert.ok(progress.some(({message})=>message==='Baixando e preparando o áudio…'));
});

test('legacy success and immediate duplicate do not poll',async()=>{
  for(const [response,duplicate] of [[json(song,201),false],[json({duplicate:true,song,error:'Já existe'},409),true]]){
    let calls=0;
    assert.deepEqual(await importSong('url','actor',options(async()=>{calls++;return response;})),{song,duplicate});
    assert.equal(calls,1);
  }
});

test('provider failure from a completed job remains actionable and is not retried',async()=>{
  let calls=0;
  const message='O YouTube bloqueou a importação neste servidor. Tente outro vídeo.';
  await assert.rejects(importSong('url','actor',options(async()=>++calls===1?json({jobId:'job'},202):json({status:'error',error:message,code:'YOUTUBE_BLOCKED'}))),{message});
  assert.equal(calls,2);
});

test('HTML response shows Portuguese error without JSON parser details',async()=>{
  let calls=0;
  await assert.rejects(importSong('url','actor',options(async()=>{calls++;return new Response('<html>Bad Gateway</html>',{status:502});})),/O servidor não conseguiu responder/);
  assert.equal(calls,1);
});

test('POST network failure never automatically submits again',async()=>{
  let calls=0;
  await assert.rejects(importSong('url','actor',options(async()=>{calls++;throw new TypeError('Load failed');})),/A conexão foi interrompida/);
  assert.equal(calls,1);
  assert.match(importErrorMessage(new TypeError('Load failed')),/Confira o catálogo/);
});

test('GET network and 5xx failures reconnect then complete',async()=>{
  const progress=[];let calls=0;
  const result=await importSong('url','actor',options(async()=>{
    calls++;
    if(calls===1)return json({jobId:'job'},202);
    if(calls===2)throw new TypeError('Load failed');
    if(calls===3)return new Response('Service unavailable',{status:503});
    return json({status:'ready',song});
  },{onProgress:entry=>progress.push(entry)}));
  assert.equal(result.song.id,song.id);
  assert.equal(progress.filter(({status})=>status==='reconnecting').length,2);
  assert.equal(calls,4);
});

test('GET retries stop after three reconnection attempts',async()=>{
  let posts=0,gets=0;
  await assert.rejects(importSong('url','actor',options(async(_path,init)=>{
    if(init.method==='POST'){posts++;return json({jobId:'job'},202);}
    gets++;throw new TypeError('Load failed');
  })),/A conexão foi interrompida/);
  assert.equal(posts,1);assert.equal(gets,4);
});

test('request timeout stays friendly when abort wins the fetch race',async()=>{
  let calls=0;
  await assert.rejects(importSong('url','actor',options((_path,init)=>{
    calls++;
    return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))));
  },{requestTimeoutMs:5})),/O servidor demorou para responder/);
  assert.equal(calls,1);
});

test('network error while reading GET body is retried',async()=>{
  let calls=0;
  const result=await importSong('url','actor',options(async()=>{
    calls++;
    if(calls===1)return json({jobId:'job'},202);
    if(calls===2)return {ok:true,status:200,json:()=>Promise.reject(new TypeError('Load failed'))};
    return json({status:'ready',song});
  }));
  assert.equal(result.song.id,song.id);assert.equal(calls,3);
});

test('closing during queued progress stops polling',async()=>{
  let calls=0;
  const controller=new AbortController();
  await assert.rejects(importSong('url','actor',options(async()=>{calls++;return json({jobId:'job'},202);},{signal:controller.signal,onProgress:({status})=>{if(status==='queued')controller.abort();}})),{name:'AbortError'});
  assert.equal(calls,1);
});

test('closing discards a late transport response even if it ignores abort',async()=>{
  let resolveRequest;
  const controller=new AbortController();
  const pending=importSong('url','actor',options(()=>new Promise(resolve=>{resolveRequest=resolve;}),{signal:controller.signal}));
  const rejected=assert.rejects(pending,{name:'AbortError'});
  controller.abort();resolveRequest(json(song,201));
  await rejected;
});

test('auth and expired jobs fail immediately without reconnect loops',async()=>{
  for(const status of [401,403,404]){
    let calls=0;
    await assert.rejects(importSong('url','actor',options(async()=>++calls===1?json({jobId:'job'},202):new Response('<html>Unavailable</html>',{status}))),status===401?/sessão expirou/:status===403?/não pode acessar/:/expirou ou o servidor foi reiniciado/);
    assert.equal(calls,2);
  }
});

test('MP3 upload sends multipart bytes once and follows preparation progress',async()=>{
  const file=new File(['MP3 fixture'],'Música.mp3',{type:'audio/mpeg'});
  const requests=[],progress=[];
  const replies=[json({jobId:'upload-job'},202),json({status:'processing',stage:'preparing'}),json({status:'ready',song:{...song,source:'upload'}})];
  const result=await uploadSong(file,{title:' Música ',artist:' Artista '},options(async(path,init)=>{requests.push({path,init});return replies.shift();},{onProgress:entry=>progress.push(entry)}));
  assert.equal(result.song.source,'upload');
  assert.equal(requests[0].path,'/api/upload-song');
  assert.equal(requests[0].init.headers,undefined);
  assert.equal(requests[0].init.body.get('title'),'Música');
  assert.equal(requests[0].init.body.get('artist'),'Artista');
  assert.equal(await requests[0].init.body.get('audio').text(),'MP3 fixture');
  assert.equal(requests.filter(({init})=>init.method==='POST').length,1);
  assert.ok(progress.some(({message})=>message.includes('Verificando e preparando o MP3')));
});

test('MP3 duplicate returns existing song without polling or retransmitting',async()=>{
  let calls=0;
  const result=await uploadSong(new File(['audio'],'copy.mp3'),{title:'Copy',artist:''},options(async()=>{calls++;return json({duplicate:true,song},409);}));
  assert.deepEqual(result,{song,duplicate:true});assert.equal(calls,1);
});

test('invalid, empty and oversized uploads fail before any request',async()=>{
  let calls=0;
  for(const [file,message] of [[new File(['x'],'video.mp4'),/Selecione um arquivo MP3/],[new File([],'empty.mp3'),/arquivo está vazio/],[{name:'large.mp3',size:50*1024*1024+1},/50 MB/]]){
    await assert.rejects(uploadSong(file,{title:'',artist:''},options(async()=>{calls++;})),message);
  }
  assert.equal(calls,0);
});

test('upload network failure never repeats a potentially completed POST',async()=>{
  let calls=0;
  await assert.rejects(uploadSong(new File(['audio'],'song.mp3'),{title:'',artist:''},options(async()=>{calls++;throw new TypeError('Load failed');})),/Confira o catálogo/);
  assert.equal(calls,1);
});
