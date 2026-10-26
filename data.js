// Data layer. The app talks only to this interface, so the backend can be
// replaced later (for example a China-hosted backend) without touching the UI.
// Two adapters: Supabase (real) and Mock (local testing, ?mock=1).

function supabaseAdapter(cfg) {
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });
  let user = null;
  const err = (e) => { if (e) throw e; };

  return {
    kind: 'supabase',
    async init() {
      const { data } = await sb.auth.getSession();
      user = data.session ? data.session.user : null;
      return user;
    },
    userId() { return user ? user.id : null; },
    userEmail() { return user ? user.email : ''; },
    onAuth(cb) {
      sb.auth.onAuthStateChange((_ev, session) => { user = session ? session.user : null; cb(user); });
    },
    async signUp(email, password) {
      const { data, error } = await sb.auth.signUp({ email, password }); err(error);
      user = data.user || null;
      return { needsConfirm: !data.session };
    },
    async signIn(email, password) {
      const { data, error } = await sb.auth.signInWithPassword({ email, password }); err(error);
      user = data.user; return user;
    },
    async signOut() { await sb.auth.signOut(); user = null; },

    async getContext() {
      const { data: mem, error } = await sb.from('members').select('household_id').eq('user_id', user.id).limit(1); err(error);
      if (!mem || !mem.length) return null;
      const hid = mem[0].household_id;
      const [hh, members, pets] = await Promise.all([
        sb.from('households').select('*').eq('id', hid).single(),
        sb.from('members').select('user_id, display_name, created_at').eq('household_id', hid).order('created_at'),
        sb.from('pets').select('*').eq('household_id', hid).order('created_at')
      ]);
      err(hh.error); err(members.error); err(pets.error);
      return { household: hh.data, members: members.data, pets: pets.data };
    },
    async createHousehold(hhName, petName, displayName) {
      const { error } = await sb.rpc('create_household', { p_household_name: hhName, p_pet_name: petName, p_display_name: displayName }); err(error);
    },
    async joinHousehold(code, displayName) {
      const { error } = await sb.rpc('join_household', { p_code: code, p_display_name: displayName }); err(error);
    },
    async updateMyName(hid, name) {
      const { error } = await sb.from('members').update({ display_name: name }).eq('household_id', hid).eq('user_id', user.id); err(error);
    },
    async updatePet(id, fields) {
      const { data, error } = await sb.from('pets').update(fields).eq('id', id).select().single(); err(error); return data;
    },

    async listRecords(petId) {
      const { data, error } = await sb.from('records').select('*').eq('pet_id', petId).order('ts', { ascending: false }).limit(3000); err(error);
      return data;
    },
    async addRecords(rows) {
      const { error } = await sb.from('records').upsert(rows, { onConflict: 'id', ignoreDuplicates: true }); err(error);
    },
    async deleteRecord(id) {
      const { error } = await sb.from('records').delete().eq('id', id); err(error);
    },
    async listEvents(petId) {
      const { data, error } = await sb.from('events').select('*').eq('pet_id', petId).order('ts'); err(error); return data;
    },
    async addEvent(row) {
      const { error } = await sb.from('events').insert(row); err(error);
    },
    async deleteEvent(id) {
      const { error } = await sb.from('events').delete().eq('id', id); err(error);
    },

    endpoint() { return cfg.supabaseUrl + '/functions/v1/siri-record'; },
    async createToken(label) {
      const { data, error } = await sb.rpc('create_api_token', { p_label: label }); err(error); return data;
    },
    async listTokens() {
      const { data, error } = await sb.from('api_tokens').select('id, label, created_at, last_used_at').order('created_at'); err(error); return data;
    },
    async deleteToken(id) {
      const { error } = await sb.from('api_tokens').delete().eq('id', id); err(error);
    },

    subscribe(hid, on) {
      const ch = sb.channel('hh-' + hid)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'records', filter: 'household_id=eq.' + hid }, (p) => on.record(p.eventType, p.new, p.old))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'events', filter: 'household_id=eq.' + hid }, (p) => on.event(p.eventType, p.new, p.old))
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'pets', filter: 'household_id=eq.' + hid }, (p) => on.pet(p.new))
        .subscribe((status) => on.status && on.status(status));
      return () => sb.removeChannel(ch);
    }
  };
}

// In-memory adapter for local UI testing. Nothing leaves the browser.
function mockAdapter() {
  const me = 'u-me', other = 'u-partner', hid = 'h1', pid = 'p1';
  const now = Date.now(), day = 864e5;
  const st = {
    user: { id: me, email: 'me@example.com' },
    household: { id: hid, name: '我家', invite_code: 'AB12CD34' },
    members: [{ user_id: me, display_name: '我' }, { user_id: other, display_name: '伴侣' }],
    pets: [{ id: pid, household_id: hid, name: '示例猫', warn_yellow: 26, warn_red: 30, vet_name: '示例动物医院', vet_phone: '03-0000-0000' }],
    records: [], events: [{ id: 'e1', pet_id: pid, household_id: hid, ts: new Date(now - 10 * day).toISOString(), kind: 'med_start', label: '开始用药 A', created_by: me }]
  };
  const vals = [22, 24, 23, 25, 27, 24, 22, 26, 28, 24, 23, 25, 31, 24, 26, 33];
  vals.forEach((v, i) => st.records.push({ id: 'r' + i, pet_id: pid, household_id: hid, ts: new Date(now - (vals.length - i) * day * 0.9).toISOString(), rpm: v, method: '30s', count: v / 2, dur: 30, asleep: i !== 5, note: i === 12 ? '房间偏热' : '', created_by: i % 3 ? me : other }));
  let listeners = null;
  const later = (fn) => setTimeout(fn, 30);
  return {
    kind: 'mock',
    async init() { return new URLSearchParams(location.search).get('mock') === 'auth' ? null : st.user; },
    userId() { return me; }, userEmail() { return st.user.email; },
    onAuth() {}, async signUp() { return { needsConfirm: false }; }, async signIn() { return st.user; }, async signOut() {},
    async getContext() { return new URLSearchParams(location.search).get('mock') === 'onboard' ? null : { household: st.household, members: st.members, pets: st.pets }; },
    async createHousehold() {}, async joinHousehold() {},
    async updateMyName(_h, n) { st.members[0].display_name = n; },
    async updatePet(_id, f) { Object.assign(st.pets[0], f); return st.pets[0]; },
    async listRecords() { return st.records.slice().sort((a, b) => b.ts.localeCompare(a.ts)); },
    async addRecords(rows) {
      rows.forEach((r) => { if (!st.records.find((x) => x.id === r.id)) { const row = Object.assign({ household_id: hid, created_by: me }, r); st.records.push(row); if (listeners) later(() => listeners.record('INSERT', row)); } });
    },
    async deleteRecord(id) { st.records = st.records.filter((r) => r.id !== id); if (listeners) later(() => listeners.record('DELETE', null, { id })); },
    async listEvents() { return st.events.slice(); },
    async addEvent(row) { const e = Object.assign({ id: 'e' + Date.now(), household_id: hid, created_by: me }, row); st.events.push(e); if (listeners) later(() => listeners.event('INSERT', e)); },
    async deleteEvent(id) { st.events = st.events.filter((e) => e.id !== id); if (listeners) later(() => listeners.event('DELETE', null, { id })); },
    endpoint() { return 'https://example.supabase.co/functions/v1/siri-record'; },
    async createToken() { const tk = 'pbl_' + 'f'.repeat(48); (st.tokens = st.tokens || []).push({ id: 'k' + Date.now(), label: 'Siri', created_at: new Date().toISOString(), last_used_at: null }); return tk; },
    async listTokens() { return st.tokens || []; },
    async deleteToken(id) { st.tokens = (st.tokens || []).filter((k) => k.id !== id); },
    subscribe(_hid, on) {
      listeners = on; on.status && on.status('SUBSCRIBED');
      // simulate the partner recording a moment later
      const t = setTimeout(() => {
        const row = { id: 'rp' + Date.now(), pet_id: pid, household_id: hid, ts: new Date().toISOString(), rpm: 24, method: '30s', count: 12, dur: 30, asleep: true, note: '', created_by: other };
        st.records.push(row); on.record('INSERT', row);
      }, 2500);
      return () => clearTimeout(t);
    }
  };
}

window.PBL_DATA = (new URLSearchParams(location.search).get('mock')) ? mockAdapter() : supabaseAdapter(window.PBL_CONFIG);
