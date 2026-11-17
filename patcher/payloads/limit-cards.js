;
// /limit-cards - a read-only view of the account's usage-limit resets.
//
// It sends the one request /limit-reset sends before it offers a reset,
// GET /api/oauth/usage?cedar_ember=1&skip_spend=1, through the host's own
// usage reader, so OAuth refresh, retries and the token replay guard all stay
// the host's. It never calls reset_rate_limits: nothing here can use a reset.
//
// The reader lives in another chunk, whose hashed name the patch reads off the
// cedar-ember status fetch's own import and splices in below. It is reached by
// a dynamic import when the command runs, so the chunk this lands in gains no
// static dependency and its evaluation order is untouched.
var __ccppLimitCardsCmd={
  type:"local-jsx",
  name:"limit-cards",
  description:"Show your usage-limit resets and when they expire (read-only, never uses one)",
  argumentHint:"[json]",
  isEnabled:()=>!0,
  isHidden:!1,
  load:()=>import("{{usagePath}}").then((__ccppMod)=>({
    call:(__ccppDone,__ccppCtx,__ccppArgs)=>__ccppLimitCards(__ccppMod.{{usageExport}},__ccppDone,__ccppCtx,__ccppArgs)
  }))
};
async function __ccppLimitCards(__ccppFetch,__ccppDone,__ccppCtx,__ccppArgs){
  const say=(text)=>(__ccppDone(text,{display:"system"}),null);
  let body;
  try{
    body=await __ccppFetch(__ccppCtx?.credentials,{read:"cedar_ember"});
  }catch(err){
    return say(`Couldn't read your limit resets \u00b7 ${err?.message??err}`);
  }
  // The reader answers {} rather than throwing when the login can't see usage:
  // an API key, or a claude.ai login without the profile scope.
  if(!body||typeof body!=="object"||Object.keys(body).length===0){
    return say("No usage data \u00b7 limit resets are only reported to a claude.ai login with the profile scope \u00b7 run /login");
  }
  if(String(__ccppArgs??"").trim()==="json"){
    const raw=JSON.stringify({cedar_ember:body.cedar_ember??null,juniper_tide:body.juniper_tide??null},null,2);
    return say("```json\n"+raw+"\n```");
  }
  return say(__ccppLimitCardsText(body,Date.now()));
}
// Command output is rendered as markdown (the host's own renderer, the one
// assistant text goes through), so this writes markdown rather than ANSI: the
// tables get the host's box drawing and theme colours, they fall back to a
// stacked layout on a narrow terminal instead of wrapping mid-line, and the
// transcript the model reads stays plain text.
function __ccppLimitCardsText(body,now){
  const pad=(n)=>String(n).padStart(2,"0");
  const DAY=86400000;
  // Free text from the server goes into tables and emphasis; escape what
  // would otherwise end a cell or open a span.
  const md=(s)=>String(s).replace(/[\\`*_|<>\[\]]/g,"\\$&");
  const span=(ms)=>{
    const mins=Math.floor(Math.abs(ms)/60000),hours=Math.floor(mins/60),days=Math.floor(hours/24);
    return days>=10?`${days}d`:days>0?`${days}d ${hours%24}h`:hours>0?`${hours}h ${mins%60}m`:`${mins}m`;
  };
  // Time of day only when it is close enough to matter; the year only when
  // it is not this one.
  const stamp=(t)=>{
    const d=new Date(t),n=new Date(now);
    const date=`${d.getFullYear()===n.getFullYear()?"":`${d.getFullYear()}-`}${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    const time=`${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if(d.toDateString()===n.toDateString())return time;
    return Math.abs(t-now)<7*DAY?`${date} ${time}`:date;
  };
  const when=(iso)=>{
    const t=Date.parse(iso??"");
    if(!Number.isFinite(t))return"\u2014";
    return `${stamp(t)} (${t>=now?`in ${span(t-now)}`:`${span(t-now)} ago`})`;
  };
  // The host's own words for these limits (session, week), shortened to fit
  // a table cell. Unknown ones show as sent.
  const LIMIT={five_hour:"session",seven_day:"week",seven_day_overage_included:"week+extra",seven_day_opus:"week\u00b7Opus",seven_day_sonnet:"week\u00b7Sonnet"};
  const limits=(a)=>Array.isArray(a)&&a.length>0?a.map((k)=>LIMIT[k]??k).join(", "):"\u2014";
  const bar=(pct)=>{
    const cells=10,eighths=Math.round(Math.max(0,Math.min(100,pct))/100*cells*8);
    const full=Math.floor(eighths/8),part=eighths%8;
    return "\u2588".repeat(full)+(part>0?" \u258f\u258e\u258d\u258c\u258b\u258a\u2589"[part]:"")+"\u2591".repeat(cells-full-(part>0?1:0));
  };
  const out=[];
  const ce=body.cedar_ember;
  const grants=(ce&&typeof ce==="object"&&Array.isArray(ce.grants)?ce.grants:[]).filter((g)=>g&&typeof g==="object");
  const usable=grants.filter((g)=>g.usable_now&&!g.paused&&(g.resets_left??0)>0).length;
  out.push(`**Limit resets** \u00b7 ${grants.length===0?"none":`${usable} of ${grants.length} usable now`} \u00b7 read-only, nothing was used`);
  if(!ce||typeof ce!=="object"){
    out.push("The server sent no reset information for this account.");
  }else{
    const facts=[ce.eligible?"eligible":`not eligible (${md(ce.ineligible_reason??"unknown")})`];
    facts.push(ce.at_limit?`at a limit: ${limits(ce.exhausted)}`:"not at a limit");
    if(ce.cooldown_until)facts.push(`cooling down until ${when(ce.cooldown_until)}`);
    if(ce.weekly_resets_at)facts.push(`week resets ${when(ce.weekly_resets_at)}`);
    out.push(facts.join(" \u00b7 "));
    if(grants.length>0){
      const rows=["| Reset | Left | Status | Clears | Expires |","|---|---|---|---|---|"];
      for(const g of grants){
        const starts=Date.parse(g.starts_at??""),ends=Date.parse(g.ends_at??"");
        // The host reads a missing use_requires_limit as true, so only an
        // explicit false means the reset works before a limit is reached.
        const status=Number.isFinite(ends)&&ends<=now?"expired"
          :(g.resets_left??0)<=0?"used up"
          :g.paused?"paused"
          :Number.isFinite(starts)&&starts>now?`starts in ${span(starts-now)}`
          :g.usable_now?"**usable now**"
          :g.use_requires_limit!==!1&&!ce.at_limit?"at a limit only"
          :"not usable now";
        const blocked=Array.isArray(g.blocking)&&g.blocking.length>0?` (blocked: ${limits(g.blocking)})`:"";
        const id=`${g.id===ce.next_grant_id?"\u25b8 ":""}\`${String(g.id).replace(/`/g,"")}\``;
        rows.push(`| ${id} | ${g.resets_left??"?"}/${g.resets_total??"?"} | ${status}${blocked} | ${limits(g.clears)} | ${when(g.ends_at)} |`);
      }
      out.push(rows.join("\n"));
      // Labels are long sentences; in a cell they would stretch the table
      // past the terminal, so they go below it, where a wrap stays indented.
      const labelled=grants.filter((g)=>g.label);
      if(labelled.length>0)out.push(labelled.map((g)=>`- \`${String(g.id).replace(/`/g,"")}\` ${md(g.label)}`).join("\n"));
    }else{
      out.push("No resets on this account.");
    }
  }
  // Only present when the account is in the weekly session-reset experiment
  // or the server has a verdict on it; null otherwise.
  const jt=body.juniper_tide;
  if(jt&&typeof jt==="object"){
    out.push(`**Weekly session reset** \u00b7 ${jt.eligible?(jt.available?"available":`used \u00b7 next ${when(jt.next_available_at)}`):`not offered (${md(jt.ineligible_reason??"unknown")})`}`);
  }
  const usage=["five_hour","seven_day","seven_day_opus","seven_day_sonnet"]
    .filter((k)=>body[k]&&typeof body[k].utilization==="number")
    .map((k)=>{const pct=Math.round(body[k].utilization);return `| ${LIMIT[k]} | \`${bar(pct)}\` ${pct}% | ${when(body[k].resets_at)} |`});
  if(usage.length>0)out.push(["| Limit | Used | Resets |","|---|---|---|",...usage].join("\n"));
  out.push("Use one with `/limit-reset` \u00b7 `/limit-cards json` shows the raw blocks");
  // A blank line between blocks: tables and lists only parse as such when
  // they start a block.
  return out.join("\n\n");
}
