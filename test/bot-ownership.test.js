'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createBotOwnershipService}=require('../bot-ownership');
function poolFor({bot=true,project=true}={}) {
 const calls=[]; let committed=false,rolled=false;
 const client={async query(sql){calls.push(sql); if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK'){if(sql==='COMMIT')committed=true;if(sql==='ROLLBACK')rolled=true;return {rows:[],rowCount:null};}
 if(sql.startsWith('SELECT id FROM telegram_bots'))return {rows:bot?[{id:1}]:[],rowCount:bot?1:0};
 if(sql.startsWith('SELECT id FROM client_projects'))return {rows:project?[{id:3}]:[],rowCount:project?1:0};
 if(sql.startsWith('UPDATE telegram_bots'))return {rows:[{id:1,client_id:2,project_id:3}],rowCount:1};
 throw Error('unexpected query '+sql);},release(){}};
 return {calls,get committed(){return committed;},get rolled(){return rolled;},async connect(){return client;}};
}
test('assigns only when project belongs to selected client',async()=>{const p=poolFor();const r=await createBotOwnershipService(p).assignBotToProject({botId:1,clientId:2,projectId:3});assert.equal(r.project_id,3);assert.equal(p.committed,true);});
test('rejects cross-client project and rolls back without update',async()=>{const p=poolFor({project:false});await assert.rejects(createBotOwnershipService(p).assignBotToProject({botId:1,clientId:2,projectId:9}),e=>e.code==='PROJECT_NOT_OWNED_BY_CLIENT');assert.equal(p.rolled,true);assert.equal(p.calls.some(x=>x.startsWith('UPDATE telegram_bots')),false);});
test('rejects missing bot',async()=>{const p=poolFor({bot:false});await assert.rejects(createBotOwnershipService(p).assignBotToProject({botId:8,clientId:2,projectId:3}),e=>e.code==='BOT_NOT_FOUND');assert.equal(p.rolled,true);});
test('rejects malformed ids before opening transaction',async()=>{const p=poolFor();await assert.rejects(createBotOwnershipService(p).assignBotToProject({botId:0,clientId:2,projectId:3}),TypeError);assert.equal(p.calls.length,0);});
