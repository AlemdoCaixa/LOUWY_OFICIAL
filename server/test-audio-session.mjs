import assert from 'node:assert/strict';
import test from 'node:test';
import { setAudioSessionType, resumeAudioContext } from '../src/audioSession.ts';

test('sets playback session and switches to microphone mode',()=>{
  const session={type:'auto'};
  assert.equal(setAudioSessionType('playback',session),true);
  assert.equal(session.type,'playback');
  assert.equal(setAudioSessionType('play-and-record',session),true);
  assert.equal(session.type,'play-and-record');
  setAudioSessionType('auto',session);
  assert.equal(session.type,'auto');
});

test('unsupported or readonly audio session cannot break playback',()=>{
  assert.equal(setAudioSessionType('playback',undefined),false);
  assert.equal(setAudioSessionType('playback',Object.freeze({type:'auto'})),false);
});

test('resume is invoked synchronously in the user gesture',async()=>{
  let called=false;
  const context={state:'suspended',resume(){called=true;this.state='running';return Promise.resolve();}};
  const pending=resumeAudioContext(context);
  assert.equal(called,true);
  await pending;
});

test('an interrupted context can resume on an explicit retry',async()=>{
  let attempts=0;
  const context={state:'interrupted',resume(){attempts++;if(attempts>1)this.state='running';return Promise.resolve();}};
  await assert.rejects(resumeAudioContext(context),/Toque em reproduzir/);
  await resumeAudioContext(context);
  assert.equal(attempts,2);
});

test('a rejected resume gives a useful retry message',async()=>{
  const context={state:'suspended',resume:()=>Promise.reject(new Error('NotAllowedError'))};
  await assert.rejects(resumeAudioContext(context),/Toque em reproduzir/);
});

test('an unresolved browser resume is bounded and a later retry succeeds',async()=>{
  const context={state:'interrupted',resume:()=>new Promise(()=>{})};
  await assert.rejects(resumeAudioContext(context,10),/Toque em reproduzir/);
  context.resume=()=>{context.state='running';return Promise.resolve();};
  await resumeAudioContext(context);
});

test('closed audio contexts ask for reload instead of an endless retry',async()=>{
  let called=false;
  await assert.rejects(resumeAudioContext({state:'closed',resume:()=>{called=true;return Promise.resolve();}}),/Recarregue/);
  assert.equal(called,false);
});
