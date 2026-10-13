const SUPABASE_URL = 'https://tgfngbayiauxlylckfue.supabase.co';

function durationToMinutes(value = '') {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(String(value));
  if (!m || !m[0]) return 0;
  return Math.max(1, Math.round((Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) / 60));
}

async function sb(path, key, options = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal', ...(options.headers || {}) }
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  const body = await r.text();
  return body ? JSON.parse(body) : null;
}

async function helix(path, clientId, token) {
  const r = await fetch(`https://api.twitch.tv/helix/${path}`, { headers: { 'Client-Id': clientId, Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Twitch ${r.status}: ${await r.text()}`);
  return r.json();
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!clientId || !clientSecret || !serviceKey) return res.status(500).json({ error: 'Server-Konfiguration fehlt.' });

  try {
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' })
    });
    if (!tokenRes.ok) throw new Error(`Twitch Token ${tokenRes.status}: ${await tokenRes.text()}`);
    const { access_token: token } = await tokenRes.json();
    const people = await sb('ucp_allowlist?select=discord_id,twitch_name,joined_at&enabled=eq.true&twitch_name=not.is.null', serviceKey, { method: 'GET' });
    let imported = 0;
    let liveUpdated = 0;
    const errors = [];
    const details = [];

    for (const p of people || []) {
      const login = String(p.twitch_name || '').trim().replace(/^@/, '').toLowerCase();
      if (!login) continue;
      try {
        const user = (await helix(`users?login=${encodeURIComponent(login)}`, clientId, token)).data?.[0];
        if (!user) { errors.push(`${login}: Twitch-Kanal nicht gefunden`); continue; }
        let cursor = '';
        let pages = 0;
        let vodCount = 0;
        const vodStarts = [];
        do {
          const q = new URLSearchParams({ user_id: user.id, type: 'archive', first: '100' });
          if (cursor) q.set('after', cursor);
          const vj = await helix(`videos?${q}`, clientId, token);
          const videos = (vj.data || []).filter(v => !p.joined_at || v.created_at.slice(0, 10) >= p.joined_at);
          const rows = videos.map(v => ({
            discord_id: p.discord_id,
            stream_date: v.created_at.slice(0, 10),
            duration_minutes: durationToMinutes(v.duration),
            twitch_video_id: v.id,
            updated_at: new Date().toISOString()
          }));
          if (rows.length) {
            await sb('stream_sessions?on_conflict=twitch_video_id', serviceKey, { method: 'POST', body: JSON.stringify(rows) });
            imported += rows.length;
            vodCount += rows.length;
            vodStarts.push(...videos.map(v => Date.parse(v.created_at)));
          }
          cursor = vj.pagination?.cursor || '';
          pages++;
        } while (cursor && pages < 10);

        // Laufende Streams werden als vorläufiger Eintrag gespeichert.
        // Wenn ein VOD desselben Streams erscheint, wird dieser Eintrag entfernt,
        // damit die Stunden nicht doppelt gezählt werden.
        const streams = await helix(`streams?user_id=${encodeURIComponent(user.id)}`, clientId, token);
        const live = streams.data?.[0];
        if (live && (!p.joined_at || live.started_at.slice(0, 10) >= p.joined_at)) {
          const start = Date.parse(live.started_at);
          const liveId = `live_${user.id}_${start}`;
          const archiveExists = vodStarts.some(t => Math.abs(t - start) < 6 * 60 * 60 * 1000);
          if (!archiveExists) {
            const minutes = Math.max(1, Math.floor((Date.now() - start) / 60000));
            await sb('stream_sessions?on_conflict=twitch_video_id', serviceKey, {
              method: 'POST',
              body: JSON.stringify([{ discord_id: p.discord_id, stream_date: live.started_at.slice(0, 10), duration_minutes: minutes, twitch_video_id: liveId, updated_at: new Date().toISOString() }])
            });
            liveUpdated++;
          }
        }
        // Bereits durch VODs ersetzte Live-Zwischeneinträge entfernen.
        // Provisorische IDs beziehen sich auf den exakten Startzeitpunkt.
        if (vodStarts.length) {
          const provisional = await sb(`stream_sessions?select=twitch_video_id&discord_id=eq.${encodeURIComponent(p.discord_id)}&twitch_video_id=like.live_*`, serviceKey, { method: 'GET' });
          for (const row of provisional || []) {
            const m = /^live_(\d+)_(\d+)$/.exec(row.twitch_video_id || '');
            if (!m || m[1] !== String(user.id)) continue;
            if (vodStarts.some(t => Math.abs(t - Number(m[2])) < 6 * 60 * 60 * 1000)) {
              await sb(`stream_sessions?twitch_video_id=eq.${encodeURIComponent(row.twitch_video_id)}`, serviceKey, { method: 'DELETE' });
            }
          }
        }
        details.push({ twitch: login, archives: vodCount, live: Boolean(live) });
      } catch (e) {
        console.error(`[Twitch-Sync] ${login}:`, e);
        errors.push(`${login}: ${e.message}`);
      }
    }
    return res.status(200).json({ ok: errors.length === 0, imported, liveUpdated, channels: details, errors });
  } catch (e) {
    console.error('[Twitch-Sync]', e);
    return res.status(500).json({ error: e.message });
  }
}
