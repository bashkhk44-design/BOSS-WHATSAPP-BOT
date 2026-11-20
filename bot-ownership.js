'use strict';
function createBotOwnershipService(pool) {
  async function listClients({limit=8,offset=0}={}) {
    const r=await pool.query("SELECT id, COALESCE(NULLIF(first_name,''),NULLIF(telegram_username,''),telegram_user_id::text) AS display_name FROM clients ORDER BY id DESC LIMIT $1 OFFSET $2",
      [Math.min(20,Math.max(1,Number(limit)||8)),Math.max(0,Number(offset)||0)]);
    return r.rows;
  }
  async function listProjects({clientId,limit=8,offset=0}={}) {
    if (!/^\d+$/.test(String(clientId||'')) || Number(clientId)<=0) throw new TypeError('Invalid clientId');
    const r=await pool.query("SELECT id,client_id,name FROM client_projects WHERE client_id=$1 ORDER BY id DESC LIMIT $2 OFFSET $3",
      [clientId,Math.min(20,Math.max(1,Number(limit)||8)),Math.max(0,Number(offset)||0)]);
    return r.rows;
  }
  async function assignBotToProject({botId,clientId,projectId}={}) {
    for (const [k,v] of Object.entries({botId,clientId,projectId})) if (!/^\d+$/.test(String(v||'')) || Number(v)<=0) throw new TypeError('Invalid '+k);
    const c=await pool.connect();
    try {
      await c.query('BEGIN');
      const b=await c.query('SELECT id FROM telegram_bots WHERE id=$1 FOR UPDATE',[botId]);
      if (!b.rowCount) { const e=new Error('BOT_NOT_FOUND'); e.code='BOT_NOT_FOUND'; throw e; }
      const p=await c.query('SELECT id FROM client_projects WHERE id=$1 AND client_id=$2',[projectId,clientId]);
      if (!p.rowCount) { const e=new Error('PROJECT_NOT_OWNED_BY_CLIENT'); e.code='PROJECT_NOT_OWNED_BY_CLIENT'; throw e; }
      const u=await c.query('UPDATE telegram_bots SET client_id=$2,project_id=$3 WHERE id=$1 RETURNING id,name,client_id,project_id',[botId,clientId,projectId]);
      await c.query('COMMIT'); return u.rows[0];
    } catch(e) { try { await c.query('ROLLBACK'); } catch(_) {} throw e; }
    finally { c.release(); }
  }
  return {listClients,listProjects,assignBotToProject};
}
module.exports={createBotOwnershipService};
