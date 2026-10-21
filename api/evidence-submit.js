// Vercel Node.js API – service keys belong ONLY in Vercel Environment Variables.
const BASE=process.env.SUPABASE_URL||'https://tgfngbayiauxlylckfue.supabase.co';
const KEY=process.env.SUPABASE_SERVICE_ROLE_KEY;
const TOKEN=process.env.DISCORD_BOT_TOKEN;
const CHANNEL=process.env.DISCORD_EVIDENCE_CHANNEL_ID;
const api=(path)=>`${BASE}/rest/v1/${path}`;
const headers=(key)=>({apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'});
async function sb(path,options={}){const r=await fetch(api(path),{...options,headers:{...headers(KEY),...(options.headers||{})}});if(!r.ok)throw Error(`Supabase ${r.status}: ${await r.text()}`);const txt=await r.text();return txt?JSON.parse(txt):null}
const clean=(s,n=1000)=>String(s??'').trim().slice(0,n);
function decodeImage(image){if(!image||!['image/png','image/jpeg','image/webp'].includes(image.mime))throw Error('Ungültiges Bildformat');const b=Buffer.from(image.data||'','base64');if(!b.length||b.length>1024*1024)throw Error('Bildgröße überschritten (max. 1 MB)');return b}
export default async function handler(req,res){
 if(req.method!=='POST')return res.status(405).json({error:'Nur POST erlaubt.'});
 if(!KEY||!TOKEN||!CHANNEL)return res.status(503).json({error:'Serverkonfiguration unvollständig (SUPABASE_SERVICE_ROLE_KEY, DISCORD_BOT_TOKEN, DISCORD_EVIDENCE_CHANNEL_ID).'});
 try{
  const bearer=String(req.headers.authorization||'').match(/^Bearer (.+)$/i)?.[1];if(!bearer)return res.status(401).json({error:'Anmeldung erforderlich.'});
  const auth=await fetch(`${BASE}/auth/v1/user`,{headers:{apikey:KEY,Authorization:`Bearer ${bearer}`}});if(!auth.ok)return res.status(401).json({error:'UCP-Sitzung ungültig.'});const user=await auth.json();
  const users=await sb(`ucp_users?select=id,enabled,discord_id,display_name,discord_name&id=eq.${encodeURIComponent(user.id)}&limit=1`);
  const ranger=users?.[0];if(!ranger?.enabled||!/^[0-9]{15,22}$/.test(String(ranger.discord_id||'')))return res.status(403).json({error:'UCP-Zugang nicht freigegeben oder Discord-ID fehlt.'});
  const allowed=await sb(`ucp_allowlist?select=discord_id&discord_id=eq.${ranger.discord_id}&enabled=eq.true&limit=1`);if(!allowed?.length)return res.status(403).json({error:'Ranger nicht in der aktiven Freigabeliste.'});
  const body=req.body||{};const tv=clean(body.tvName,120);if(!tv)return res.status(400).json({error:'TV-Name fehlt.'});
  const items=Array.isArray(body.items)?body.items.slice(0,60).map(x=>({name:clean(x.name,120),returned:x.returned===true})).filter(x=>x.name):[];
  const images=Array.isArray(body.images)?body.images:[];if(images.length>3)return res.status(400).json({error:'Maximal 3 Bilder.'});
  const imageBuffers=images.map(decodeImage);
  const data={dob:clean(body.dob,32),waffenlizenz:clean(body.waffenlizenz,60),waffenstufe:clean(body.waffenstufe,80),fuehrerschein:clean(body.fuehrerschein,60),rights:clean(body.rechte,150),witness:clean(body.zeuge,150),seized:items.filter(x=>!x.returned).map(x=>x.name).join('\n')||'Keine',returned:items.filter(x=>x.returned).map(x=>x.name).join('\n')||'Keine',items,source:'ucp'};
  // Save image files in a private Supabase bucket before Discord publication.
  const paths=[];for(let n=0;n<imageBuffers.length;n++){
   const suffix=images[n].mime==='image/png'?'png':images[n].mime==='image/webp'?'webp':'jpg';
   const path=`${user.id}/${crypto.randomUUID()}-${n}.${suffix}`;
   const upload=await fetch(`${BASE}/storage/v1/object/ranger-evidence/${path}`,{method:'POST',headers:{apikey:KEY,Authorization:`Bearer ${KEY}`,'Content-Type':images[n].mime,'x-upsert':'false'},body:imageBuffers[n]});
   if(!upload.ok)throw Error(`Bild-Upload fehlgeschlagen: ${await upload.text()}`);paths.push(path);
  }
  data.image_paths=paths;
  // Existing inbox: expiry is set by the DB default/trigger; do not override inbox_expiry.
  const inserted=await sb('ucp_akteneingang?select=id',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({tv_name:tv,officer_name:clean(ranger.display_name||ranger.discord_name||'Ranger',120),officer_discord_id:ranger.discord_id,payload:data})});
  const id=inserted?.[0]?.id;if(!id)throw Error('Akteneingang konnte nicht bestätigt werden.');
  const embed={title:'🚓 Tatverdächtiger aufgenommen',color:15712100,fields:[{name:'👤 Name',value:tv,inline:true},{name:'🎂 Geburtsdatum',value:data.dob||'–',inline:true},{name:'🔫 Waffenlizenz',value:data.waffenlizenz||'–',inline:true},{name:'🎯 Waffenstufe',value:data.waffenstufe||'–',inline:true},{name:'🪪 Führerschein',value:data.fuehrerschein||'–',inline:true},{name:'⚖️ Rechte verlesen durch',value:data.rights||'–'},{name:'👁️ Zeuge',value:data.witness||'Keiner'},{name:'📥 Beschlagnahmt',value:data.seized.slice(0,1000)},{name:'📤 Zurückgegeben',value:data.returned.slice(0,1000)},{name:'👮 Aufgenommen von',value:`<@${ranger.discord_id}>`}],footer:{text:'Retro Ranger · Beweissicherung'},timestamp:new Date().toISOString()};
  const form=new FormData();form.append('payload_json',JSON.stringify({embeds:[embed],allowed_mentions:{parse:[]}}));imageBuffers.forEach((buf,n)=>form.append(`files[${n}]`,new Blob([buf],{type:images[n].mime}),`beweis-${n+1}.${images[n].mime.split('/')[1]}`));
  let discordSent=false,discordError=null,discordMessage=null;
  try{const r=await fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`,{method:'POST',headers:{Authorization:`Bot ${TOKEN}`},body:form});if(!r.ok)throw Error(`Discord ${r.status}: ${(await r.text()).slice(0,400)}`);discordMessage=await r.json();discordSent=true;await sb(`ucp_akteneingang?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({discord_message_id:discordMessage.id})})}catch(e){discordError=e.message;console.error('Discord-Beweissicherung:',e)}
  return res.status(200).json({ok:true,id,discordSent,discordError,messageUrl:discordMessage?`https://discord.com/channels/${discordMessage.guild_id||'@me'}/${CHANNEL}/${discordMessage.id}`:null});
 }catch(e){console.error('Evidence submit:',e);return res.status(500).json({error:String(e.message||e).slice(0,600)})}
}
