let authenticated = false;
const $ = id => document.getElementById(id);
function toast(msg){const t=$("toast");t.textContent=msg;t.style.display="block";setTimeout(()=>t.style.display="none",3800)}
async function api(url, options={}) {
  const r=await fetch(url,{...options,credentials:"same-origin"});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.error||"Request failed");
  return data;
}
async function unlock(){
  const p=prompt("Enter the dashboard password configured on the server:");
  if(p===null)return;
  try{
    await api("/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:p})});
    authenticated=true;
    await refresh();
  }catch(e){authenticated=false;toast(e.message)}
}
async function sendCode(){
  try{const d=await api("/api/login/send-code",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({account_id:Number($("loginAccount").value),phone:$("phone").value})});$("verifyBox").classList.remove("hidden");toast(d.message)}catch(e){toast(e.message)}
}
async function verifyCode(){
  try{const d=await api("/api/login/verify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:$("code").value})});if(d.needs2FA){toast(d.message);return}toast(d.message);refresh()}catch(e){toast(e.message)}
}
async function verify2FA(){
  try{const d=await api("/api/login/2fa",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:$("password").value})});toast(d.message);refresh()}catch(e){toast(e.message)}
}
async function logout(){try{await api("/auth/logout",{method:"POST"});authenticated=false;toast("Dashboard session ended");unlock()}catch(e){toast(e.message)}}
async function addGroup(){
  try{const d=await api("/api/groups",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({account_id:Number($("groupAccount").value),username:$("groupName").value})});$("groupName").value="";toast("Group added: "+(d.title||d.username));refresh()}catch(e){toast(e.message)}
}
async function removeGroup(id){if(!confirm("Remove this group and its scheduled posts?"))return;try{await api("/api/groups/"+id,{method:"DELETE"});refresh()}catch(e){toast(e.message)}}
async function togglePost(id){try{await api("/api/posts/"+id+"/toggle",{method:"POST"});refresh()}catch(e){toast(e.message)}}
async function deletePost(id){if(!confirm("Delete this scheduled post?"))return;try{await api("/api/posts/"+id,{method:"DELETE"});refresh()}catch(e){toast(e.message)}}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
let accountsCache=[];
function ensureMultiAccountDOM(){
  const loginForm=$("loginForm");
  if(loginForm&&!$("accountCards")){
    const cards=document.createElement("div");
    cards.id="accountCards";
    cards.className="list";
    loginForm.parentNode.insertBefore(cards,loginForm);
  }
  if(loginForm&&!$("loginAccount")){
    const lbl=document.createElement("label");
    lbl.textContent="Account slot";
    const sel=document.createElement("select");
    sel.id="loginAccount";
    loginForm.insertBefore(sel,loginForm.firstChild);
    loginForm.insertBefore(lbl,sel);
  }
  const groupName=$("groupName");
  if(groupName&&!$("groupAccount")){
    const wrap=groupName.closest(".inline")||groupName;
    const prevLabel=wrap.previousElementSibling;
    const target=prevLabel&&prevLabel.tagName==="LABEL"?prevLabel:wrap;
    const lbl=document.createElement("label");
    lbl.textContent="Telegram account";
    const sel=document.createElement("select");
    sel.id="groupAccount";
    target.parentNode.insertBefore(lbl,target);
    target.parentNode.insertBefore(sel,target);
  }
}
function accName(id){const a=accountsCache.find(x=>x.id===id);return "Account "+id+(a&&a.label?" · "+a.label:"")}
async function disconnectAccount(id){if(!confirm("Disconnect "+accName(id)+"?"))return;try{await api("/api/logout",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({account_id:id})});toast("Account disconnected");refresh()}catch(e){toast(e.message)}}
function fillSelect(el,html){if(!el)return;const v=el.value;el.innerHTML=html;if(v&&[...el.options].some(o=>o.value===v&&!o.disabled))el.value=v}
function fmt(s){
  if(!s) return "—";
  try {
    return new Date(s).toLocaleString("en-US", { timeZone: "Asia/Dhaka", hour12: true });
  } catch(_) {
    return new Date(s).toLocaleString();
  }
}
async function refresh(){
  try{
    ensureMultiAccountDOM();
    const status=await api("/api/status");
    const [groups,posts,history]=await Promise.all([
      api("/api/groups").catch(()=>[]),
      api("/api/posts").catch(()=>[]),
      api("/api/history").catch(()=>[])
    ]);
    $("status").className="badge "+(status.connected?"on":"off");$("status").textContent=status.connected?"● Connected":"● Disconnected";
    if(status.firebaseError){toast("Firebase: "+status.firebaseError)}
    accountsCache=Array.isArray(status.accounts)&&status.accounts.length?status.accounts:[{id:1,label:"",phone:"",connected:Boolean(status.connected)},{id:2,label:"",phone:"",connected:false}];
    const connectedCount=accountsCache.filter(a=>a.connected).length;
    $("statAccount").textContent=connectedCount?connectedCount+" / "+accountsCache.length+" connected":"Not connected";
    if($("accountCards"))$("accountCards").innerHTML=accountsCache.map(a=>`<div class="list-row"><div><b>Account ${a.id}</b><small>${a.connected?esc((a.label||"Connected")+(a.phone?" · "+a.phone:"")):"Not connected"}</small></div>${a.connected?`<button class="danger" onclick="disconnectAccount(${a.id})">Disconnect</button>`:'<span class="pill">Offline</span>'}</div>`).join("");
    fillSelect($("loginAccount"),accountsCache.map(a=>`<option value="${a.id}">Account ${a.id}${a.connected?" (connected"+(a.label?": "+esc(a.label):"")+")":" (not connected)"}</option>`).join(""));
    fillSelect($("groupAccount"),accountsCache.map(a=>`<option value="${a.id}"${a.connected?"":" disabled"}>${esc(accName(a.id))}${a.connected?"":" (not connected)"}</option>`).join(""));
    if($("groupAccount")&&!$("groupAccount").value){const first=accountsCache.find(a=>a.connected);if(first)$("groupAccount").value=String(first.id)}
    $("statGroups").textContent=groups.length;$("statPosts").textContent=posts.filter(p=>p.active).length;$("statSuccess").textContent=history.filter(h=>h.result==="SUCCESS").length;
    $("groupsList").innerHTML=groups.length?groups.map(g=>`<div class="list-row"><div><b>${esc(g.title||g.username)}</b><small>@${esc(g.username)} · ${esc(accName(g.account_id||1))}</small></div><button class="danger" onclick="removeGroup(${g.id})">Remove</button></div>`).join(""):'<div class="empty">No groups added yet.</div>';
    $("targetGroup").innerHTML='<option value="">Select a group</option>'+groups.map(g=>`<option value="${g.id}">${esc(g.title||g.username)} (@${esc(g.username)}) — A${g.account_id||1}</option>`).join("");
    $("postsList").innerHTML=posts.length?`<table><thead><tr><th>Group</th><th>Content</th><th>Next run</th><th>Repeat</th><th>Status</th><th>Actions</th></tr></thead><tbody>${posts.map(p=>`<tr><td>@${esc(p.username)} <small>A${p.account_id||1}</small></td><td>${esc((p.text||"Image post").slice(0,55))}</td><td>${fmt(p.next_run_at)}</td><td>${p.interval_minutes?p.interval_minutes+" min":"Once"}</td><td><span class="pill ${p.active?"success":""}">${p.active?"Active":"Paused / done"}</span></td><td><button class="ghost" onclick="togglePost(${p.id})">${p.active?"Pause":"Resume"}</button> <button class="danger" onclick="deletePost(${p.id})">Delete</button></td></tr>`).join("")}</tbody></table>`:'<div class="empty">No scheduled posts yet.</div>';
    $("historyList").innerHTML=history.length?`<table><thead><tr><th>Time</th><th>Group</th><th>Result</th><th>Details</th></tr></thead><tbody>${history.map(h=>`<tr><td>${fmt(h.posted_at)}</td><td>@${esc(h.group_name)}</td><td><span class="pill ${h.result==="SUCCESS"?"success":"failed"}">${esc(h.result)}</span></td><td>${esc(h.detail)}</td></tr>`).join("")}</tbody></table>`:'<div class="empty">No posting activity yet.</div>';
  }catch(e){if(e.message.toLowerCase().includes("password")){authenticated=false;unlock()}else toast(e.message)}
}
$("postForm").addEventListener("submit",async e=>{
  e.preventDefault();
  try{
    const form=new FormData(e.target);
    const rawSchedule = $("scheduleAt").value;
    if(rawSchedule){
      const localDate = new Date(rawSchedule);
      if(!isNaN(localDate.getTime())){
        form.set("schedule_at", localDate.toISOString());
      }
    }
    await api("/api/posts",{method:"POST",body:form});
    e.target.reset();
    const dtNow=new Date(Date.now()-new Date().getTimezoneOffset()*60000);
    $("scheduleAt").value=dtNow.toISOString().slice(0,16);
    if($("intervalInput")) $("intervalInput").value="0";
    if($("intervalPreset")) $("intervalPreset").value="0";
    toast("Scheduled post saved.");
    refresh();
  }catch(err){toast(err.message)}
});
const dt=new Date(Date.now()-new Date().getTimezoneOffset()*60000);$("scheduleAt").value=dt.toISOString().slice(0,16);
ensureMultiAccountDOM();
unlock();
setInterval(()=>{if(authenticated)refresh()},30000);
