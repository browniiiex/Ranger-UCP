const SUPABASE_URL = 'https://tgfngbayiauxlylckfue.supabase.co';

function durationToMinutes(value='') {
  const m = value.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i);
  if (!m) return 0;
  const seconds=(Number(m[1]||0)*3600)+(Number(m[2]||0)*60)+Number(m[3]||0);
  return Math.max(1, Math.round(seconds/60));
}

async function sb(path, key, options={}) {
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{
    ...options,
    headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal',...(options.headers||{})}
  });
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  const text=await r.text();
  return text?JSON.parse(text):null;
}

export default async function handler(req,res){
  if(!['GET','POST'].includes(req.method)) return res.status(405).json({error:'Method not allowed'});
  const clientId=process.env.TWITCH_CLIENT_ID;
  const clientSecret=process.env.TWITCH_CLIENT_SECRET;
  const serviceKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!clientId||!clientSecret||!serviceKey) return res.status(500).json({error:'Server-Konfiguration fehlt.'});
  try{
    const tokenRes=await fetch('https://id.twitch.tv/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,grant_type:'client_credentials'})});
    if(!tokenRes.ok) throw new Error(`Twitch Token ${tokenRes.status}: ${await tokenRes.text()}`);
    const {access_token}=await tokenRes.json();
    const people=await sb('ucp_allowlist?select=discord_id,twitch_name,joined_at&enabled=eq.true&twitch_name=not.is.null',serviceKey,{method:'GET'});
    let imported=0;
    for(const p of people||[]){
      const login=String(p.twitch_name||'').trim().toLowerCase();
      if(!login) continue;
      const u=await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`,{headers:{'Client-Id':clientId,Authorization:`Bearer ${access_token}`}});
      if(!u.ok) continue;
      const uj=await u.json(); const user=uj.data?.[0]; if(!user) continue;
      let cursor=''; let pages=0;
      do{
        const url=new URL('https://api.twitch.tv/helix/videos');
        url.searchParams.set('user_id',user.id);url.searchParams.set('type','archive');url.searchParams.set('first','100');
        if(cursor) url.searchParams.set('after',cursor);
        const vr=await fetch(url,{headers:{'Client-Id':clientId,Authorization:`Bearer ${access_token}`}});
        if(!vr.ok) break;
        const vj=await vr.json();
        const rows=(vj.data||[]).filter(v=>!p.joined_at || v.created_at.slice(0,10)>=p.joined_at).map(v=>({discord_id:p.discord_id,stream_date:v.created_at.slice(0,10),duration_minutes:durationToMinutes(v.duration),twitch_video_id:v.id,updated_at:new Date().toISOString()}));
        if(rows.length){await sb('stream_sessions?on_conflict=twitch_video_id',serviceKey,{method:'POST',body:JSON.stringify(rows)});imported+=rows.length;}
        cursor=vj.pagination?.cursor||''; pages++;
      }while(cursor && pages<10);
    }
    res.status(200).json({ok:true,imported});
  }catch(e){res.status(500).json({error:e.message});}
}
