async function __ccppAsrConnect(e, t) {
// cometix-asr voice transport.
//
// The adapter body below is the 2.1.241 one, unchanged: its handling of
// cumulative previews and the single session_final commit came from running
// against the real host, and rewriting it would throw that away.
//
// What did have to change is how it reaches Node. On 2.1.241 this was spliced
// into one CommonJS bundle, so require and __dirname were simply in scope.
// Since 2.1.242 it lands in an ESM chunk where neither exists, hence the
// prelude — the addon is a .node binary and has to go through a real require.
const {createRequire:__ccppCreateRequire}=await import("node:module");
const require=__ccppCreateRequire(import.meta.url);
const __dirname=require("path").dirname(require("url").fileURLToPath(import.meta.url));
/* CC voice bridge: cumulative Preview + one final result for the whole hold */
const _path=require("path"),_fs=require("fs");
function __loadCometixAsr(){
  const tryLoad=(p)=>{try{if(!p)return null;const m=require(p);if(m&&typeof m.startSession==="function")return m}catch{}return null};
  const dirs=[];
  try{dirs.push(_path.join(__dirname,"vendor","cometix-asr"))}catch{}
  for(const dir of dirs){
    if(!dir||!_fs.existsSync(dir))continue;
    let m=tryLoad(_path.join(dir,"index.js"));if(m)return m;
    m=tryLoad(dir);if(m)return m;
    try{for(const f of _fs.readdirSync(dir).filter(x=>x.startsWith("libcometix-asr")&&x.endsWith(".node"))){m=tryLoad(_path.join(dir,f));if(m)return m}}catch{}
  }
  return null;
}
const __asr=__loadCometixAsr();
if(!__asr){try{e.onError("cometix-asr vendor missing startSession",{fatal:true,connectFailureCode:"cometix_asr_missing"})}catch{}return null}
let __handle=null,__connected=false,__finalized=false,__closed=false,__readyFired=false;
let __finalText="",__previewText="",__previewBase="",__livePiece="";
let __previewAcceptedAt=0;
let __emittedFinal=false,__finResolve=null,__finTimer=null;
let __audioChunks=0,__audioBytes=0;
const __traceFile=String(process.env.COMETIX_ASR_TRACE_FILE||"").trim();
const __traceId=String(process.pid)+"-"+String(Date.now())+"-"+Math.random().toString(36).slice(2,8);
const __traceStartedAt=Date.now();
let __traceLastAt=__traceStartedAt,__traceSeq=0,__traceWriteFailed=false;
function __trace(kind,data){
  if(!__traceFile)return;
  const now=Date.now();
  const row={
    schema:1,traceId:__traceId,seq:++__traceSeq,
    at:new Date(now).toISOString(),elapsedMs:now-__traceStartedAt,
    deltaMs:now-__traceLastAt,kind,...(data||{})
  };
  __traceLastAt=now;
  try{
    const line=JSON.stringify(row,(key,value)=>{
      if(typeof value==="string"&&value.length>2000)return value.slice(0,2000)+"…<len="+String(value.length)+">";
      return value;
    });
    _fs.appendFileSync(__traceFile,line+String.fromCharCode(10),"utf8");
  }catch(err){
    if(!__traceWriteFailed){
      __traceWriteFailed=true;
      try{if(typeof v==="function")v("[cometix_asr_trace] write failed: "+String(err))}catch{}
    }
  }
}
function __previewState(){
  return {
    previewText:__previewText,previewBase:__previewBase,livePiece:__livePiece,
    previewAcceptedAt:__previewAcceptedAt,
    finalText:__finalText,emittedFinal:__emittedFinal
  };
}
function __cleanTranscript(text){return String(text||"").trim()}
function __commonPrefixLength(a,b){
  let n=Math.min(a.length,b.length),i=0;
  while(i<n&&a.charCodeAt(i)===b.charCodeAt(i))i++;
  return i;
}
function __sameLiveRewrite(a,b){
  a=__cleanTranscript(a);b=__cleanTranscript(b);
  if(!a||!b||a.startsWith(b)||b.startsWith(a))return true;
  const short=Math.min(a.length,b.length),common=__commonPrefixLength(a,b);
  return common>=Math.min(4,Math.max(1,Math.ceil(short*0.45)));
}
function __isStrictProjection(container,candidate){
  return Boolean(
    container&&candidate&&container!==candidate&&
    (container.startsWith(candidate)||container.endsWith(candidate))
  );
}
function __appendTranscript(base,tail){
  base=__cleanTranscript(base);tail=__cleanTranscript(tail);
  if(!base)return tail;
  if(!tail||base.endsWith(tail))return base;
  if(tail.startsWith(base))return tail;
  for(let n=Math.min(base.length,tail.length);n>0;n--){
    if(base.endsWith(tail.slice(0,n)))return base+tail.slice(n);
  }
  const sep=/[A-Za-z0-9]$/.test(base)&&/^[A-Za-z0-9]/.test(tail)?" ":"";
  return base+sep+tail;
}
function __cumulativePreview(full,piece,stage){
  full=__cleanTranscript(full);piece=__cleanTranscript(piece);
  const before=__previewState(),incoming=full||piece,previous=__previewText;
  const now=Date.now(),projectionAgeMs=__previewAcceptedAt?now-__previewAcceptedAt:null;
  if(!incoming){
    __trace("preview.normalize",{
      stage,decision:"empty",full,piece,projectionAgeMs,
      before,after:__previewState(),output:__previewText
    });
    return __previewText;
  }

  let decision="",next=previous,accepted=false;
  const live=piece||incoming;
  if(!previous){
    decision=stage+".first";
    next=incoming;
    accepted=true;
  }else if(incoming===previous){
    decision=stage+".ignore_duplicate";
    // A duplicate cumulative projection is the anchor for the remaining
    // prefix/suffix entries emitted from the same results[] batch.
    __previewAcceptedAt=now;
  }else if(
    __isStrictProjection(previous,incoming)&&
    projectionAgeMs!==null&&projectionAgeMs<=20
  ){
    // The addon can publish cumulative, stable-prefix and live-suffix entries
    // from one results[] batch within the same tick. Only the cumulative entry
    // is a new Preview; the other two are parallel projections.
    decision=stage+".ignore_parallel_projection";
    if(stage==="stable"&&previous.startsWith(incoming)){
      __previewBase=incoming;
      __livePiece=previous.slice(incoming.length);
    }
  }else if(incoming.startsWith(previous)){
    decision=stage+".accept_extension";
    next=incoming;
    accepted=true;
  }else if(previous.startsWith(incoming)||__sameLiveRewrite(previous,incoming)){
    decision=stage+".accept_whole_rewrite";
    next=incoming;
    accepted=true;
  }else if(__previewBase){
    if(incoming.startsWith(__previewBase)&&incoming.length>__previewBase.length){
      decision=stage+".accept_cumulative_display";
      next=incoming;
    }else if(__livePiece&&__sameLiveRewrite(__livePiece,live)){
      decision=stage+".rewrite_live_piece";
      next=__appendTranscript(__previewBase,live);
    }else{
      decision=stage+".rebuild_from_base";
      next=__appendTranscript(__previewBase,live);
    }
    accepted=true;
  }else{
    // Fallback for providers that really reset to phrase-only interim text.
    decision=stage+".new_phrase_reset";
    __previewBase=previous;
    __livePiece=live;
    next=__appendTranscript(__previewBase,live);
    accepted=true;
  }

  if(accepted){
    __previewText=next;
    __previewAcceptedAt=now;
    if(stage==="stable"){
      __previewBase=next;
      __livePiece="";
    }else if(__previewBase&&next.startsWith(__previewBase)){
      __livePiece=next.slice(__previewBase.length);
    }else{
      __livePiece=live;
    }
  }
  __trace("preview.normalize",{
    stage,decision,full,piece,projectionAgeMs,accepted,
    before,after:__previewState(),output:__previewText
  });
  return __previewText;
}
function __emitFinalOnce(text,source){
  text=__cleanTranscript(text);source=source||"unknown";
  if(!text){
    __trace("final.skip",{source,reason:"empty",state:__previewState()});
    return;
  }
  if(__emittedFinal){
    __trace("final.skip",{source,reason:"already_emitted",text,textLength:text.length,state:__previewState()});
    return;
  }
  __emittedFinal=true;
  __finalText=text;
  __trace("cc.onTranscript",{source,isFinal:true,text,textLength:text.length,state:__previewState()});
  try{e.onTranscript(text,true)}catch(err){__trace("cc.onTranscript.error",{source,isFinal:true,error:String(err)})}
  if(__finResolve){
    const r=__finResolve;__finResolve=null;
    if(__finTimer){clearTimeout(__finTimer);__finTimer=null}
    __trace("bridge.finalize.resolve",{source,result:"session_final",state:__previewState()});
    r("session_final");
  }
}
__trace("bridge.init",{pid:process.pid,traceFile:__traceFile});
const __api={
  send(k){
    if(!__connected||__finalized||__closed||__handle==null)return;
    const size=k&&typeof k.length==="number"?k.length:0;
    __audioChunks++;__audioBytes+=size;
    try{__asr.feedPcm(__handle,Buffer.from(k))}catch(err){
      __trace("audio.feed.error",{error:String(err),chunkBytes:size,audioChunks:__audioChunks,audioBytes:__audioBytes});
    }
  },
  finalize(){
    if(__finalized||__closed){
      __trace("bridge.finalize.skip",{reason:"already_closed",finalized:__finalized,closed:__closed,state:__previewState()});
      return Promise.resolve("ws_already_closed");
    }
    __finalized=true;
    __trace("bridge.finalize.request",{audioChunks:__audioChunks,audioBytes:__audioBytes,state:__previewState()});
    return new Promise((resolve)=>{
      __finResolve=resolve;
      try{__asr.finalizeSession(__handle)}catch(err){__trace("addon.finalize.error",{error:String(err)})}
      // wait SessionFinished/final text; do not resolve early or CC → No speech detected
      __finTimer=setTimeout(()=>{
        __finTimer=null;
        __trace("bridge.finalize.timeout",{hasFinalText:Boolean(__finalText),state:__previewState()});
        if(!__emittedFinal&&__finalText)__emitFinalOnce(__finalText,"finalize_timeout_fallback");
        const r=__finResolve;__finResolve=null;
        if(r){
          const result=__emittedFinal?"session_final":"safety_timeout";
          __trace("bridge.finalize.resolve",{source:"timeout",result,state:__previewState()});
          r(result);
        }
      },12000);
    });
  },
  close(){
    __trace("bridge.close.request",{audioChunks:__audioChunks,audioBytes:__audioBytes,state:__previewState()});
    __closed=true;__connected=false;
    try{if(__handle!=null)__asr.closeSession(__handle)}catch(err){__trace("addon.close.error",{error:String(err)})}
    __handle=null;
    if(__finResolve){
      const r=__finResolve;__finResolve=null;
      if(__finTimer){clearTimeout(__finTimer);__finTimer=null}
      __trace("bridge.finalize.resolve",{source:"api.close",result:"ws_close",state:__previewState()});
      r("ws_close");
    }
    try{e.onClose&&e.onClose()}catch(err){__trace("cc.onClose.error",{error:String(err)})}
  },
  isConnected(){return __connected&&!__closed}
};
function __startLive(){
  // empty → Rust product_config + ensureDid (post-asr default off in product_config for CC)
  __trace("addon.start.request",{});
  __handle=__asr.startSession("{}",(err,j)=>{
    if(err){
      __trace("addon.callback.error",{error:String(err)});
      try{e.onError(String(err))}catch(callbackErr){__trace("cc.onError.error",{error:String(callbackErr)})}
      return;
    }
    let ev;
    try{ev=JSON.parse(j)}catch(parseErr){
      __trace("addon.event.parse_error",{error:String(parseErr),raw:String(j||"")});
      return;
    }
    if(ev.type==="ready"){
      __connected=true;
      __trace("addon.ready",{sessionId:ev.session_id||"",mode:ev.mode||""});
      if(!__readyFired){
        __readyFired=true;
        __trace("cc.onReady",{});
        try{e.onReady(__api)}catch(callbackErr){__trace("cc.onReady.error",{error:String(callbackErr)})}
      }
    }else if(ev.type==="transcript"){
      const display=__cleanTranscript(ev.display),piece=__cleanTranscript(ev.text);
      const full=display||piece;
      const stage=ev.stage||((ev.is_vad_finished||ev.is_final)?"stable":"interim");
      __trace("addon.transcript",{
        rawStage:ev.stage||"",stage,isInterim:Boolean(ev.is_interim),
        isVadFinished:Boolean(ev.is_vad_finished),isFinal:Boolean(ev.is_final),
        text:piece,textLength:piece.length,display,displayLength:display.length,
        passCount:Number(ev.pass_count||0),
        stableText:__cleanTranscript(ev.stable_text),
        liveText:__cleanTranscript(ev.live_text),
        state:__previewState()
      });
      if(!full&&!__previewText){
        __trace("transcript.skip",{reason:"empty",stage,state:__previewState()});
        return;
      }
      if(stage==="session_final"){
        // SessionFinished is authoritative. Commit exactly once so CC does not
        // append the already-previewed stable segments a second time.
        __emitFinalOnce(full||__previewText,"addon.session_final");
      }else{
        // CC replaces voiceInterimTranscript on every isFinal=false callback.
        // Therefore both interim and stable must carry a cumulative Preview.
        const normalizedStage=stage==="stable"?"stable":"interim";
        const previousPreview=__previewText;
        const preview=__cumulativePreview(full,piece,normalizedStage);
        if(!preview){
          __trace("transcript.skip",{reason:"normalized_empty",stage,state:__previewState()});
          return;
        }
        __finalText=preview;
        if(preview===previousPreview){
          __trace("cc.onTranscript.skip",{
            source:"preview."+normalizedStage,reason:"unchanged_projection",
            text:preview,textLength:preview.length,state:__previewState()
          });
          return;
        }
        __trace("cc.onTranscript",{
          source:"preview."+normalizedStage,isFinal:false,text:preview,
          textLength:preview.length,state:__previewState()
        });
        try{e.onTranscript(preview,false)}catch(callbackErr){
          __trace("cc.onTranscript.error",{source:"preview."+normalizedStage,isFinal:false,error:String(callbackErr)});
        }
      }
    }else if(ev.type==="processed"){
      __trace("addon.processed",{text:__cleanTranscript(ev.text),fmtText:__cleanTranscript(ev.fmt_text)});
      // if post ever enabled, prefer single processed final
      __emitFinalOnce(ev.text||ev.fmt_text||"","addon.processed");
    }else if(ev.type==="error"){
      __trace("addon.error",{message:ev.message||"asr error",code:ev.code||""});
      try{e.onError(ev.message||"asr error")}catch(callbackErr){__trace("cc.onError.error",{error:String(callbackErr)})}
    }else if(ev.type==="close"){
      __connected=false;
      __trace("addon.close",{state:__previewState(),audioChunks:__audioChunks,audioBytes:__audioBytes});
      if(__finalText&&!__emittedFinal)__emitFinalOnce(__finalText,"addon.close_fallback");
      if(__finResolve){
        const r=__finResolve;__finResolve=null;
        if(__finTimer){clearTimeout(__finTimer);__finTimer=null}
        const result=__emittedFinal?"session_final":"close";
        __trace("bridge.finalize.resolve",{source:"addon.close",result,state:__previewState()});
        r(result);
      }
      try{e.onClose&&e.onClose()}catch(callbackErr){__trace("cc.onClose.error",{error:String(callbackErr)})}
    }else if(ev.type==="debug"){
      __trace("addon.debug",{message:ev.message||""});
    }else{
      __trace("addon.unknown",{event:ev});
    }
  });
}
try{__startLive()}catch(err){
  __trace("addon.start.error",{error:String(err)});
  try{e.onError(String(err),{fatal:true,connectFailureCode:"cometix_start_failed"})}catch(callbackErr){__trace("cc.onError.error",{error:String(callbackErr)})}
  return null;
}
return __api;
}
