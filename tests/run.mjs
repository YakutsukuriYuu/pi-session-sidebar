import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { piDir, plugin, requirePi, tuiPath } from './setup.mjs';
const temp = mkdtempSync(join(tmpdir(), 'resume-plus-test-'));
process.env.PI_CODING_AGENT_DIR = join(temp, 'agent');
mkdirSync(process.env.PI_CODING_AGENT_DIR);
const importFile = (file) => import(pathToFileURL(file).href);
const pi = await importFile(join(piDir, 'dist/index.js'));
const tui = await importFile(tuiPath);
const { KeybindingsManager } = await importFile(join(piDir, 'dist/core/keybindings.js'));
const nativeTheme = await importFile(join(piDir, 'dist/modes/interactive/theme/theme.js'));
nativeTheme.initTheme('dark', false);
const { createJiti } = requirePi('jiti');
const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false,
  virtualModules: { '@earendil-works/pi-coding-agent': pi, '@earendil-works/pi-tui': tui } });
const { SessionSelectorComponent: Picker } = await jiti.import(join(plugin, 'src/picker/session-selector.ts'));
const search = await jiti.import(join(plugin, 'src/picker/session-selector-search.ts'));
const nativeSearch = await importFile(join(piDir, 'dist/modes/interactive/components/session-selector-search.js'));
const config = await jiti.import(join(plugin, 'src/shared/config.ts'));
const launcher = await jiti.import(join(plugin, 'src/shared/terminal-launcher.ts'));
const paths = await jiti.import(join(plugin, 'src/shared/paths.ts'));
const registry = await jiti.import(join(plugin, 'src/shared/active-sessions.ts'));
const Native = pi.SessionSelectorComponent;
const kb = new KeybindingsManager();
tui.setKeybindings(kb);
const keys = { tab:'\t', down:'\x1b[B', up:'\x1b[A', left:'\x1b[D', right:'\x1b[C', enter:'\r', esc:'\x1b', sort:'\x13', named:'\x0e', rename:'\x12', del:'\x04', path:'\x10', pageDown:'\x1b[6~', pageUp:'\x1b[5~', shiftEnter:'\x1b[13;2u', shiftDown:'\x1b[1;2B', shiftUp:'\x1b[1;2A', shiftLeft:'\x1b[1;2D', shiftRight:'\x1b[1;2C', group:'\x1bg' };
const tick = () => new Promise((resolve) => setImmediate(resolve));
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
const allPickers = [];
function fixture(id, cwd, modified, parent, name=id) {
  return { id, path:join(temp,id+'.jsonl'), cwd, modified:new Date(modified), created:new Date(0), parentSessionPath:parent ? join(temp,parent+'.jsonl') : undefined, name, messageCount:1, firstMessage:id, allMessagesText:`${id} exact phrase authentication 中文` };
}
// native list loaders supply descending modified order. A→B→A exercises a return fork.
const sessions = [fixture('grandchild','/B',100,'child'), fixture('return','/A',90,'grandchild'), fixture('independent','/C',80), fixture('other','/A',60), fixture('root','/A',10), fixture('child','/A',5,'root'), fixture('unnamed','/A',3,undefined,'')];
async function make(Type=Picker, data=sessions, options={}) {
  const events=[];
  const p=new Type(async()=>data, async()=>data, (path)=>events.push(['select',path]), ()=>events.push(['cancel']), ()=>events.push(['exit']), ()=>{},
    {theme:nativeTheme.theme,keybindings:kb,renameSession:async(path,name)=>events.push(['rename',path,name]),...options}, options.currentFile);
  allPickers.push(p); await tick();
  return {p,list:p.getSessionList(),events};
}
const rows = (list) => list.filteredSessions;
const plain = (p,width=120) => p.render(width).map((line)=>line.replace(/\x1b\[[0-9;]*m/g,'')).join('\n');
try {
  await test('native search parity: regex, quoted, fuzzy, AND, invalid, named × all sort modes',()=>{
    for(const query of ['', 'authentication','"exact phrase"','root auth','re:(root|child)','re:[','re:', '"unclosed','中文'])
      for(const sort of ['threaded','recent','relevance']) for(const filter of ['all','named'])
        assert.deepEqual(search.filterAndSortSessions(sessions,query,sort,filter),nativeSearch.filterAndSortSessions(sessions,query,sort,filter));
  });
  await test('current scope matches native tree metadata, search, sort and named modes',async()=>{
    // Compare against the native picker, so pin the native matcher (bare word = fuzzy).
    const a=await make(Picker,sessions,{searchMode:'fuzzy'}), b=await make(Native);
    a.p.handleInput(keys.tab);await tick(); // default is All; Tab into Current
    for(const key of ['',keys.sort,keys.sort,keys.sort,'auth',keys.named,keys.sort,keys.named,'\x15']) {
      if(key) {a.p.handleInput(key);b.p.handleInput(key);}
      const normalized=(l)=>rows(l).map(({session,depth,isLast,ancestorContinues})=>({path:session.path,depth,isLast,ancestorContinues}));
      assert.deepEqual(normalized(a.list),normalized(b.list));
    }
  });
  await test('default scope is All; current scope lazy-loads on first Tab and caches All',async()=>{
    let currentCalls=0,allCalls=0;
    const p=new Picker(async()=>{currentCalls++;return sessions;},async()=>{allCalls++;return sessions;},()=>{},()=>{},()=>{},()=>{},{theme:nativeTheme.theme,keybindings:kb});
    allPickers.push(p);await tick();
    assert.equal(p.scope,'all');assert.equal(allCalls,1);assert.equal(currentCalls,0);
    assert.ok(rows(p.getSessionList()).some(n=>n.kind==='folder'));
    p.handleInput(keys.tab);await tick();
    assert.equal(p.scope,'current');assert.equal(currentCalls,1);
    assert.ok(rows(p.getSessionList()).every(n=>n.kind!=='folder'));
    p.handleInput(keys.tab);assert.equal(p.scope,'all');assert.equal(allCalls,1);
  });
  await test('current cwd folder pinned first (unfiltered) but search follows match relevance',async()=>{
    for(const [cwd,expected] of [['/C',['/C','/A','/B']],['/B',['/B','/A','/C']],['/none',['/A','/B','/C']]]) {
      const a=await make(Picker,sessions,{currentCwd:cwd});
      assert.deepEqual(rows(a.list).filter(n=>n.kind==='folder').map(n=>n.folderPath),expected);
    }
    // Current folder holds only a weak message-text match; the exact name match lives elsewhere.
    const weak={...fixture('weak','/B',100),allMessagesText:'needle only appears deep in the conversation body'},
          exact={...fixture('exact','/A',50,undefined,'needle target')};
    const a=await make(Picker,[weak,exact],{currentCwd:'/B'});
    assert.deepEqual(rows(a.list).filter(n=>n.kind==='folder').map(n=>n.folderPath),['/B','/A']);
    a.p.handleInput('needle');
    assert.deepEqual(rows(a.list).filter(n=>n.kind==='folder').map(n=>n.folderPath),['/A','/B']);
    assert.ok(rows(a.list).findIndex(n=>n.kind!=='folder'&&n.session.path===exact.path)<=2,'exact match must stay at the top while searching');
  });
  await test('pin matches canonical cwd through symlink alias',async()=>{
    const realDir=join(temp,'realproj'),aliasDir=join(temp,'aliasproj');mkdirSync(realDir);symlinkSync(realDir,aliasDir);
    const a=await make(Picker,[fixture('pinned',realDir,50),fixture('other2','/B',100)],{currentCwd:aliasDir});
    assert.deepEqual(rows(a.list).filter(n=>n.kind==='folder').map(n=>n.folderPath),[realDir,'/B']);
  });
  await test('folder-name search expands that folder to all its sessions',async()=>{
    const f1=fixture('alpha-one','/alpha',10,undefined,'one'),
          f2=fixture('alpha-two','/alpha',20,undefined,'two'),
          other=fixture('beta-one','/beta',30,undefined,'three');
    // Anchored regex matches the folder NAME but no session text: only the
    // folder-name path can surface these sessions.
    const a=await make(Picker,[f1,f2,other],{currentCwd:'/tmp'});
    a.p.handleInput('re:^alpha$');
    const r=rows(a.list);
    assert.equal(r[0].kind,'folder');assert.equal(r[0].folderPath,'/alpha');assert.equal(r[0].folderMatch,'name');
    assert.equal(r[0].session.messageCount,2);
    assert.deepEqual(r.filter(n=>n.kind!=='folder').map(n=>n.session.id).sort(),['alpha-one','alpha-two']);
    assert.ok(!r.some(n=>n.folderPath==='/beta'),'non-matching folder must not appear');
  });
  await test('folder path matching is literal: fuzzy-only path hits are not folder matches',async()=>{
    const sshFolder='/Users/su/Harness/ssh',geo='/Users/su/Harness/GeoSure',qwen='/Users/su/Harness/Qwen';
    const a1=fixture('ssh-one',sshFolder,10,undefined,'SSH debian'),
          g1=fixture('geo-one',geo,5,undefined,'SSH home:/x/GeoSure project'),
          q1={...fixture('qwen-one',qwen,99,undefined,'unrelated title'),allMessagesText:'we discussed ssh setup briefly'};
    const a=await make(Picker,[a1,g1,q1],{currentCwd:'/tmp'});
    a.p.handleInput('ssh');
    const r=rows(a.list);
    // ssh = exact folder name; GeoSure = its session name matches SSH; Qwen = weak body match only.
    assert.deepEqual(r.filter(n=>n.kind==='folder').map(n=>n.folderPath),[sshFolder,geo,qwen]);
    assert.equal(r[0].folderMatch,'exact');
    assert.ok(!r.find(n=>n.folderPath===geo).folderMatch,'GeoSure must not be a fuzzy path hit');
    assert.ok(!r.find(n=>n.folderPath===qwen).folderMatch,'Qwen must not be a fuzzy path hit');
  });
  await test('multi-token path matching requires every token literally',async()=>{
    const a=await make(Picker,[fixture('x','/Users/su/Harness/Qwen',10),fixture('y','/Users/su/Harness/ssh',20)],{currentCwd:'/tmp'});
    a.p.handleInput('harness qwen');
    const r=rows(a.list);
    assert.deepEqual(r.filter(n=>n.kind==='folder').map(n=>n.folderPath),['/Users/su/Harness/Qwen']);
    assert.equal(r[0].folderMatch,'path');
  });
  await test('folder-name matches sort above content-only matches and keep their marker',async()=>{
    const f1=fixture('alpha-one','/alpha',10,undefined,'one'),
          f2=fixture('alpha-two','/alpha',20,undefined,'two'),
          byContent={...fixture('beta-one','/beta',90,undefined,'three'),allMessagesText:'alpha appears only in the body of this conversation'};
    const a=await make(Picker,[f1,f2,byContent],{currentCwd:'/tmp'});
    a.p.handleInput('alpha');
    const r=rows(a.list);
    assert.equal(r[0].folderPath,'/alpha');assert.equal(r[0].folderMatch,'exact');
    assert.equal(r.filter(n=>n.kind!=='folder'&&n.folderPath==='/alpha').length,2);
    const beta=r.find(n=>n.kind==='folder'&&n.folderPath==='/beta');
    assert.ok(beta&&!beta.folderMatch,'content-only folder keeps no marker');
    assert.ok(r.findIndex(n=>n.kind==='folder'&&n.folderPath==='/alpha')<r.findIndex(n=>n.kind==='folder'&&n.folderPath==='/beta'));
  });
  await test('folder path matches are supported and marked as path matches',async()=>{
    const p1=fixture('team-one','/team/alpha-project',10,undefined,'x');
    const a=await make(Picker,[p1],{currentCwd:'/tmp'});
    a.p.handleInput('team');
    const r=rows(a.list);
    assert.equal(r[0].folderMatch,'path');
    assert.equal(r.filter(n=>n.kind!=='folder').length,1);
  });
  await test('expanded folder still honours the Named filter',async()=>{
    const named=fixture('alpha-named','/alpha',10,undefined,'has a name'),
          unnamed={...fixture('alpha-unnamed','/alpha',20,undefined,'')};
    const a=await make(Picker,[named,unnamed],{currentCwd:'/tmp'});
    a.p.handleInput(keys.named);
    a.p.handleInput('re:^alpha$');
    assert.deepEqual(rows(a.list).filter(n=>n.kind!=='folder').map(n=>n.session.id),['alpha-named']);
  });
  await test('no query means no folder-match markers, current cwd still pinned',async()=>{
    const a=await make(Picker,[fixture('alpha-one','/alpha',10),fixture('beta-one','/beta',20)],{currentCwd:'/alpha'});
    assert.ok(rows(a.list).every(n=>!n.folderMatch));
    assert.equal(rows(a.list)[0].folderPath,'/alpha');
  });
  await test('default search is strict substring; quotes switch to fuzzy',async()=>{
    // "ssh" is scattered (not contiguous) in this path; substring must not match it.
    const scattered={...fixture('scattered','/Users/su/Harness/Qwen',10,undefined,'unrelated title'),allMessagesText:'nothing relevant here'},
          literal=fixture('literal','/plain/dir',20,undefined,'SSH debian');
    const a=await make(Picker,[scattered,literal],{currentCwd:'/tmp'});
    a.p.handleInput('ssh');
    assert.deepEqual(rows(a.list).filter(n=>n.kind!=='folder').map(n=>n.session.id),['literal']);
    a.p.handleInput('\x15');                       // clear the search
    a.p.handleInput('"ssh"');                     // quoted form = fuzzy subsequence
    assert.deepEqual(rows(a.list).filter(n=>n.kind!=='folder').map(n=>n.session.id).sort(),['literal','scattered']);
  });
  await test('fuzzy mode keeps native semantics: bare word is the fuzzy matcher',async()=>{
    const scattered={...fixture('scattered','/Users/su/Harness/Qwen',10,undefined,'unrelated title'),allMessagesText:'nothing relevant here'};
    const a=await make(Picker,[scattered],{currentCwd:'/tmp',searchMode:'fuzzy'});
    a.p.handleInput('ssh');
    assert.deepEqual(rows(a.list).filter(n=>n.kind!=='folder').map(n=>n.session.id),['scattered']);
    a.p.handleInput('\x15');
    a.p.handleInput('"ssh"');                     // quoted form = substring in fuzzy mode
    assert.equal(rows(a.list).filter(n=>n.kind!=='folder').length,0);
  });
  await test('folder name matching honours the search mode',async()=>{
    const s={...fixture('one','/Users/su/server-hub',10,undefined,'title'),allMessagesText:'no keyword here'};
    const substring=await make(Picker,[s],{currentCwd:'/tmp'});
    substring.p.handleInput('svh');                // fuzzy would match server-hub, substring must not
    assert.equal(rows(substring.list).filter(n=>n.kind==='folder').length,0);
    const fuzzy=await make(Picker,[s],{currentCwd:'/tmp',searchMode:'fuzzy'});
    fuzzy.p.handleInput('svh');
    assert.equal(rows(fuzzy.list)[0].folderMatch,'name');
  });
  await test('config: searchMode defaults to substring and validates',()=>{
    assert.equal(config.parseConfig({}).searchMode,'substring');
    assert.equal(config.parseConfig({searchMode:'fuzzy'}).searchMode,'fuzzy');
    assert.equal(config.parseConfig({searchMode:'substring'}).searchMode,'substring');
    assert.throws(()=>config.parseConfig({searchMode:'nope'}));
  });
  await test('folder-row Shift+Enter creates a session in that folder (config-gated)',async()=>{
    const opened=[],created=[];
    const a=await make(Picker,sessions,{onOpenInNew:path=>opened.push(path),newSessionInFolder:folder=>created.push(folder)});
    const firstFolder=rows(a.list).find(n=>n.kind==='folder').folderPath;
    a.p.handleInput(keys.shiftEnter);
    assert.deepEqual(created,[firstFolder]);assert.deepEqual(opened,[],'folder row must not open a terminal');
    a.p.handleInput(keys.down);                       // folder row -> session row
    a.p.handleInput(keys.shiftEnter);
    assert.equal(opened.length,1,'session row still opens a terminal');
    assert.equal(created.length,1);
    // Disabled (no callback wired): the folder row is inert, session rows unaffected.
    const opened2=[];
    const b=await make(Picker,sessions,{onOpenInNew:path=>opened2.push(path)});
    b.p.handleInput(keys.shiftEnter);
    assert.deepEqual(opened2,[],'disabled: folder row does nothing');
    b.p.handleInput(keys.down);b.p.handleInput(keys.shiftEnter);
    assert.equal(opened2.length,1,'disabled must not affect session rows');
  });
  await test('Shift+Left collapses every folder, Shift+Right expands them all',async()=>{
    const a=await make();
    const expanded=rows(a.list).filter(n=>n.kind!=='folder').length;
    assert.ok(expanded>0);
    a.p.handleInput(keys.shiftLeft);
    assert.equal(rows(a.list).filter(n=>n.kind!=='folder').length,0);
    assert.equal(rows(a.list).filter(n=>n.kind==='folder').length,3);
    a.p.handleInput(keys.shiftRight);
    assert.equal(rows(a.list).filter(n=>n.kind!=='folder').length,expanded);
    // The collapse-all state survives a search and a cleared query.
    a.p.handleInput(keys.shiftLeft);
    a.p.handleInput('auth');
    assert.ok(rows(a.list).filter(n=>n.kind!=='folder').length>0,'search still reveals matches');
    a.p.handleInput('\x15');
    assert.equal(rows(a.list).filter(n=>n.kind!=='folder').length,0,'folders stay collapsed after clearing');
  });
  await test('new session in a folder: the header must be written or the switch lands in the wrong cwd',async()=>{
    const proj=join(temp,'proj-new');mkdirSync(proj);
    const manager=pi.SessionManager.create(proj,join(temp,'custom-sessions'));
    const file=manager.getSessionFile();
    assert.ok(file,'a file path is chosen immediately');
    assert.ok(!existsSync(file),'pi writes a new session file lazily (first assistant message)');
    assert.equal(pi.SessionManager.open(file).getCwd(),process.cwd(),'an unflushed path loses the target cwd');
    // What the extension does: persist the generated header, then switch.
    const header=manager.getHeader();
    assert.ok(header&&header.cwd===proj,'create() encodes the target cwd in the header');
    writeFileSync(file,`${JSON.stringify(header)}\n`,{flag:'wx'});
    const reopened=pi.SessionManager.open(file);
    assert.equal(reopened.getCwd(),proj,'the header makes open() target the right project');
    reopened.appendThinkingLevelChange('off');
    assert.ok(readFileSync(file,'utf8').includes('thinking_level_change'),'later entries append cleanly');
  });
  await test('new session lands in the target folder\'s own session dir (All scope stays global)',async()=>{
    const proj=join(temp,'proj-dir'),elsewhere=join(temp,'elsewhere-dir');
    mkdirSync(proj);mkdirSync(elsewhere);
    const projDir=paths.defaultSessionDir(proj),otherDir=paths.defaultSessionDir(elsewhere);
    assert.notEqual(projDir,otherDir);
    // What the extension does: use the target cwd's default dir, not another project's.
    const manager=pi.SessionManager.create(proj,projDir);
    const file=manager.getSessionFile();
    assert.ok(file.startsWith(projDir+sep),'file must live in the target project dir');
    writeFileSync(file,`${JSON.stringify(manager.getHeader())}\n`,{flag:'wx'});
    const reopened=pi.SessionManager.open(file);
    assert.equal(reopened.getCwd(),proj);
    // This equality is what keeps the picker's All scope listing every project.
    // Storing the file under a different project's dir makes it false, and pi's All
    // scope then lists only that one directory (the reported bug).
    assert.equal(reopened.getSessionDir(),paths.defaultSessionDir(reopened.getCwd()));
    const misplaced=pi.SessionManager.create(proj,otherDir);
    const misplacedFile=misplaced.getSessionFile();
    writeFileSync(misplacedFile,`${JSON.stringify(misplaced.getHeader())}\n`,{flag:'wx'});
    const wrong=pi.SessionManager.open(misplacedFile);
    assert.notEqual(wrong.getSessionDir(),paths.defaultSessionDir(wrong.getCwd()),'documents the degraded-All condition');
  });
  await test('unused-session cleanup removes only never-used sessions (trash then unlink)',async()=>{
    const files=await jiti.import(join(plugin,'src/shared/session-files.ts'));
    const dir=join(temp,'cleanup-sessions');mkdirSync(dir);
    const make=(id,extra=[])=>{const m=pi.SessionManager.create(join(temp,'proj-cleanup'),dir);const f=m.getSessionFile();
      writeFileSync(f,`${JSON.stringify(m.getHeader())}\n`);for(const e of extra)writeFileSync(f,`${JSON.stringify(e)}\n`,{flag:'a'});return f;};
    const ts=new Date().toISOString();
    const unused=make('unused');
    const used=make('used',[{type:'message',id:'a1',parentId:null,timestamp:ts,message:{role:'user',content:'hello'}}]);
    const named=make('named',[{type:'session_info',id:'b1',parentId:null,timestamp:ts,name:'keep me'}]);
    const labelled=make('labelled',[{type:'label',id:'c1',parentId:null,timestamp:ts,targetId:'x',label:'keep'} ]);
    assert.equal(files.isSessionUnused(unused),true);
    assert.equal(files.isSessionUnused(used),false);
    assert.equal(files.isSessionUnused(named),false);
    assert.equal(files.isSessionUnused(labelled),false);
    assert.equal(files.isSessionUnused(join(dir,'missing.jsonl')),false,'unknown files are never "unused"');
    // The current session is kept even when unused; used/named ones are kept and untracked.
    for(const f of [unused,used,named,labelled]) files.trackUnusedSession(f);
    files.cleanupTrackedUnusedSessions(unused);
    assert.ok(existsSync(unused),'the active session must be kept');
    assert.equal(files.trackedUnusedCount(),1,'the kept session stays tracked so it is cleaned when we leave it');
    // Without a current session, the unused one is removed (PATH makes trash fail -> unlink).
    const bin=join(temp,'bin-cleanup');mkdirSync(bin,{recursive:true});writeFileSync(join(bin,'trash'),'#!/bin/sh\nexit 1\n',{mode:0o755});
    const oldPath=process.env.PATH;process.env.PATH=bin;
    try {
      files.cleanupTrackedUnusedSessions();
      assert.ok(!existsSync(unused),'unused session removed');
      assert.equal(files.trackedUnusedCount(),0);
    } finally { process.env.PATH=oldPath; }
    assert.ok(existsSync(used)&&existsSync(named)&&existsSync(labelled),'used sessions survive cleanup');
  });
  await test('config: folderNewSession defaults to enabled and validates',()=>{
    assert.equal(config.parseConfig({}).folderNewSession.enabled,true);
    assert.equal(config.parseConfig({}).folderNewSession.cleanupUnused,true);
    assert.equal(config.parseConfig({folderNewSession:{enabled:false}}).folderNewSession.enabled,false);
    assert.equal(config.parseConfig({folderNewSession:{cleanupUnused:false}}).folderNewSession.cleanupUnused,false);
    assert.throws(()=>config.parseConfig({folderNewSession:{enabled:'no'}}));
    assert.throws(()=>config.parseConfig({folderNewSession:{cleanupUnused:'no'}}));
    assert.throws(()=>config.parseConfig({folderNewSession:[]}));
  });
  await test('All folder order uses GLOBAL descendant activity (root mtime is old)',async()=>{
    const a=await make();
    assert.deepEqual(rows(a.list).filter(n=>n.kind==='folder').map(n=>n.folderPath),['/A','/B','/C']);
    assert.deepEqual(rows(a.list).filter(n=>n.folderPath==='/A'&&n.kind!=='folder').map(n=>[n.session.id,!!n.reference]),
      [['root',false],['child',false],['grandchild',true],['return',false],['other',false],['unnamed',false]]);
    assert.equal(rows(a.list).find(n=>n.kind==='folder'&&n.folderPath==='/A').session.messageCount,5);
  });
  await test('cross-folder references keep A→B→A ancestor depths and actual paths',async()=>{
    const a=await make();
    const r=rows(a.list).filter(n=>n.folderPath==='/B'&&n.kind!=='folder');
    assert.deepEqual(r.map(n=>[n.session.id,n.depth,!!n.reference]),[['root',1,true],['child',2,true],['grandchild',3,false]]);
  });
  await test('All Alt+G has exact native GLOBAL order and tree metadata',async()=>{
    const a=await make(Picker,sessions,{currentCwd:'/C',searchMode:'fuzzy'}),b=await make(Native);b.p.handleInput(keys.tab);await tick();a.p.handleInput(keys.group);
    assert.deepEqual(rows(a.list),rows(b.list));
  });
  await test('grouped fuzzy results retain native rank within each cwd; no mtime re-sort',async()=>{
    const a=await make(Picker,sessions,{searchMode:'fuzzy'});a.p.handleInput('auth');
    for(const cwd of ['/A','/B','/C']) assert.deepEqual(rows(a.list).filter(n=>n.kind!=='folder'&&n.folderPath===cwd).map(n=>n.session.path),
      nativeSearch.filterAndSortSessions(sessions,'auth','threaded').filter(s=>s.cwd===cwd).map(s=>s.path));
  });
  await test('directional collapse/expand idempotent, folder Enter never resumes',async()=>{
    const a=await make();a.p.handleInput(keys.left);const count=rows(a.list).length;
    a.p.handleInput(keys.left);assert.equal(rows(a.list).length,count);a.p.handleInput(keys.right);assert.ok(rows(a.list).length>count);
    const open=rows(a.list).length;a.p.handleInput(keys.right);assert.equal(rows(a.list).length,open);a.p.handleInput(keys.enter);assert.equal(rows(a.list).length,count);assert.deepEqual(a.events,[]);
  });
  await test('Shift arrows navigate project roots; folders protected from rename/delete/new',async()=>{
    const a=await make();a.p.handleInput(keys.shiftDown);assert.equal(rows(a.list)[a.list.selectedIndex].folderPath,'/B');
    a.p.handleInput(keys.shiftUp);assert.equal(a.list.selectedIndex,0);
    for(const k of [keys.rename,keys.del,keys.shiftEnter]) a.p.handleInput(k);
    assert.equal(a.p.mode,'list');assert.equal(a.list.confirmingDeletePath,null);assert.deepEqual(a.events,[]);
  });
  await test('typing searches collapsed folders and query cursor left/right remains native',async()=>{
    const a=await make();a.p.handleInput(keys.left);a.p.handleInput('auth');
    assert.ok(rows(a.list).some(n=>n.session.id==='root'));a.p.handleInput(keys.left);a.p.handleInput('Z');assert.equal(a.list.searchInput.getValue(),'autZh');
  });
  await test('session-row cursor movement, page navigation and IME focus',async()=>{
    const a=await make();a.p.handleInput(keys.tab);await tick();a.p.focused=true;assert.equal(a.list.searchInput.focused,true);
    a.p.handleInput('abc');a.p.handleInput(keys.left);a.p.handleInput('Z');assert.equal(a.list.searchInput.getValue(),'abZc');
    a.p.handleInput('\x15');a.p.handleInput(keys.pageDown);assert.equal(a.list.selectedIndex,sessions.length-1);a.p.handleInput(keys.pageUp);assert.equal(a.list.selectedIndex,0);
  });
  await test('empty list Down/PageDown/ShiftEnter/Enter safe with nonnegative index',async()=>{
    const a=await make(Picker,[]);for(const k of [keys.down,keys.pageDown,keys.shiftEnter,keys.enter])a.p.handleInput(k);
    assert.equal(a.list.selectedIndex,0);assert.deepEqual(a.events,[]);
  });
  await test('disabled ShiftEnter is inert even if rebound to confirm/delete/rename',async()=>{
    for(const action of ['tui.select.confirm','app.session.delete','app.session.rename']) {
      const a=await make(Picker,sessions,{keybindings:new KeybindingsManager({[action]:'shift+enter'})});
      a.p.handleInput(keys.down);a.p.handleInput(keys.shiftEnter);assert.equal(a.p.mode,'list');assert.equal(a.list.confirmingDeletePath,null);assert.deepEqual(a.events,[]);
    }
  });
  await test('enabled ShiftEnter returns real path only, never normal-select callback',async()=>{
    const opened=[];const a=await make(Picker,sessions,{onOpenInNew:path=>opened.push(path)});
    a.p.handleInput(keys.down);a.p.handleInput(keys.shiftEnter);assert.deepEqual(opened,[a.list.getSelectedSessionPath()]);assert.deepEqual(a.events,[]);
  });
  await test('delete confirmation absorbs ShiftEnter and other actions, Esc cancels only confirmation',async()=>{
    const a=await make(Picker,sessions,{onOpenInNew:()=>assert.fail('opened while confirming')});
    a.p.handleInput(keys.down);a.p.handleInput(keys.del);const target=a.list.confirmingDeletePath;assert.ok(target);
    for(const key of [keys.shiftEnter,keys.tab,keys.rename,'x'])a.p.handleInput(key);
    assert.equal(a.list.confirmingDeletePath,target);a.p.handleInput(keys.esc);assert.equal(a.list.confirmingDeletePath,null);assert.deepEqual(a.events,[]);
  });
  await test('symlink canonicalization protects current session and joins parent references',async()=>{
    const real=join(temp,'protected.jsonl'),alias=join(temp,'alias.jsonl');writeFileSync(real,'');symlinkSync(real,alias);
    const s={...sessions[0],path:alias,parentSessionPath:undefined};const a=await make(Picker,[s],{currentFile:real});a.p.handleInput(keys.down);a.p.handleInput(keys.del);
    assert.equal(a.list.confirmingDeletePath,null);assert.match(plain(a.p),/Cannot delete/);assert.equal(paths.canonicalizePath(alias),paths.canonicalizePath(real));
    assert.equal(paths.canonicalizePath('/missing path'),'/missing path');
  });
  await test('rename prefill, blank stays, ShiftEnter ignored, save trims, cancel preserves selector',async()=>{
    const a=await make();a.p.handleInput(keys.down);a.p.handleInput(keys.rename);assert.equal(a.p.renameInput.getValue(),'root');a.p.handleInput('\x0b');assert.equal(a.p.renameInput.getValue(),'');a.p.handleInput(keys.enter);await tick();assert.equal(a.p.mode,'rename');
    a.p.handleInput(keys.shiftEnter);assert.deepEqual(a.events,[]);a.p.handleInput(' new name ');a.p.handleInput(keys.enter);await tick();await tick();
    assert.deepEqual(a.events,[['rename',join(temp,'root.jsonl'),'new name']]);assert.equal(a.p.mode,'list');a.p.handleInput(keys.rename);a.p.handleInput(keys.esc);assert.equal(a.p.mode,'list');
  });
  await test('rename failure is visible, no unhandled rejection',async()=>{
    const a=await make(Picker,sessions,{renameSession:async()=>{throw Error('write denied');}});a.p.handleInput(keys.down);a.p.handleInput(keys.rename);a.p.handleInput(keys.enter);await tick();
    assert.equal(a.p.mode,'list');assert.match(plain(a.p),/Failed to rename: write denied/);
  });
  await test('injected remapped keys work and header reports actual mapping',async()=>{
    const custom=new KeybindingsManager({'app.session.toggleSort':'alt+s','app.session.rename':'alt+r','tui.select.down':'alt+j'});
    const a=await make(Picker,sessions,{keybindings:custom});a.p.handleInput('\x1bs');assert.equal(a.p.sortMode,'recent');a.p.handleInput('\x1bj');assert.equal(a.list.selectedIndex,1);
    assert.match(plain(a.p),/(option|alt)\+r rename/);
  });
  await test('all shortcut hints wrap at 24/40/80/120 cols and host theme emits color',async()=>{
    const a=await make(Picker,sessions,{onOpenInNew:()=>{}});
    for(const width of [24,40,80,120]) {
      const lines=a.p.render(width);assert.ok(lines.every(line=>tui.visibleWidth(line)<=width));
      const content=plain(a.p,width).replace(/\s/g,'');for(const hint of ['shift+enter','shift+up/shift+down','regex','rename','delete'])assert.ok(content.includes(hint),hint+' at '+width);
    }
    assert.match(a.p.render(120).join('\n'),/\x1b\[/);
    const disabled=await make();assert.ok(!plain(disabled.p).includes('shift+enter'));
  });
  await test('loading progress, error and disposal do not mutate closed UI',async()=>{
    let complete,progress;let renders=0;const p=new Picker(async()=>[],(cb)=>{progress=cb;return new Promise(r=>complete=r);},()=>{},()=>{},()=>{},()=>renders++,{theme:nativeTheme.theme,keybindings:kb});
    progress(1,3);assert.match(plain(p),/1\/3/);p.dispose();const before=renders;progress(2,3);complete(sessions);await tick();assert.equal(renders,before);
    const q=new Picker(async()=>[],async()=>{throw Error('read denied');},()=>{},()=>{},()=>{},()=>{},{theme:nativeTheme.theme,keybindings:kb});allPickers.push(q);await tick();assert.match(plain(q),/Failed to load sessions: read denied/);
  });
  await test('config defaults/deep defaults/false validation/malformed file fail closed',()=>{
    assert.equal(config.parseConfig({}).shiftEnter.mode,'same');assert.equal(config.parseConfig({shiftEnter:{enabled:false}}).shiftEnter.enabled,false);
    for(const invalid of [null,[],{shiftEnter:{enabled:'false'}},{shiftEnter:{mode:'bad'}},{shiftEnter:{terminal:{type:'bad'}}}])assert.throws(()=>config.parseConfig(invalid));
    const file=join(temp,'bad.json');writeFileSync(file,'{');assert.throws(()=>config.readConfig(file));assert.equal(config.readConfig(join(temp,'absent.json')).shiftEnter.mode,'same');
  });
  await test('custom-dir native listing and copied default-directory helper',async()=>{
    const custom=join(temp,'custom');mkdirSync(custom);const a=pi.SessionManager.create('/A',custom);const b=pi.SessionManager.create('/B',custom);
    for(const manager of [a,b]) {manager.appendMessage({role:'user',content:'fixture',timestamp:0});manager.appendMessage({role:'assistant',content:[{type:'text',text:'ok'}],api:'openai-responses',provider:'openai',model:'fixture',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:0});}
    assert.equal((await pi.SessionManager.list('/A',custom)).length,1);assert.equal((await pi.SessionManager.listAll(custom)).length,2);
    const manager=pi.SessionManager.create(temp);assert.equal(paths.defaultSessionDir(temp),manager.getSessionDir());assert.equal(manager.usesDefaultSessionDir(),true);
  });
  await test('active registry per-PID, canonical matching, shutdown, and current-session fallback',()=>{
    const session=join(temp,'protected.jsonl');registry.registerActiveSession(session,temp);assert.equal(registry.isSessionActive(join(temp,'alias.jsonl')),true);
    registry.unregisterActiveSession();assert.equal(registry.isSessionActive(session),false);assert.equal(registry.isSessionActive(session,session),true);
  });
  await test('terminal detection current/system/non-mac fallback and configured paths',()=>{
    assert.equal(launcher.detectTerminal(undefined,{TERM_PROGRAM:'iTerm.app'},'darwin'),'iTerm2');
    assert.equal(launcher.detectTerminal(undefined,{},'linux'),'x-terminal-emulator');
    assert.equal(launcher.detectTerminal(undefined,{KITTY_WINDOW_ID:'1'},'linux'),'Kitty');
    const p=launcher.buildLaunchPlan({type:'WezTerm',path:'/custom/wezterm'},'/cwd','/session','same','/pi',{},'linux');assert.equal(p.command,'/custom/wezterm');assert.ok(p.args.includes('--always-new-process'));
  });
  await test('Linux plans use exec argv not macOS open; mode passes exact native flag',()=>{
    for(const type of ['Ghostty','Alacritty','Kitty','WezTerm','gnome-terminal','konsole','xterm','x-terminal-emulator'])for(const mode of ['same','fork']) {
      const p=launcher.buildLaunchPlan({type},'/cwd','/session',mode,'/pi',{},'linux');assert.notEqual(p.command,'open');assert.ok(p.args.join(' ').includes(mode==='same'?'--session':'--fork'));
    }
  });
  await test('POSIX quoting round trips hostile paths and AppleScript backslash/quote escaping',()=>{
    const value="space 中文 ' \" $HOME `whoami` ; {pi}";
    assert.equal(execFileSync('/bin/sh',['-c',`printf %s ${launcher.shellQuote(value)}`],{encoding:'utf8'}),value);
    assert.equal(launcher.appleScriptQuote('a"b\\c'),'"a\\"b\\\\c"');
    const p=launcher.buildLaunchPlan({type:'custom',executable:'/launcher',args:['{cwd}','{session}','{pi}','{mode}']},value,'/session','same','/pi');assert.equal(p.args[0],value);
  });
  await test('iTerm creates regular window first; Terminal path and shell launch preserved',()=>{
    const p=launcher.buildLaunchPlan({type:'iTerm2',path:'/Applications/iTerm.app'},'/cwd','/s','same','/pi',{},'darwin');
    assert.match(p.args[1],/create window with default profile/);assert.match(p.args[1],/write text/);assert.match(p.args[1],/Applications\/iTerm.app/);
  });
  await test('launcher missing cwd/pi and immediate nonzero exit are reported',async()=>{
    await assert.rejects(launcher.launchInTerminal({type:'custom',executable:process.execPath,args:['-e','process.exit(1)']},'/missing-dir','/s','same'),/项目目录不存在/);
    await assert.rejects(launcher.launchInTerminal({type:'custom',executable:process.execPath,args:['-e','process.exit(1)']},temp,join(temp,'protected.jsonl'),'same','/missing-pi'),/找不到可执行文件/);
    await assert.rejects(launcher.launchInTerminal({type:'custom',executable:process.execPath,args:['-e','process.exit(1)']},temp,join(temp,'protected.jsonl'),'same',process.execPath),/启动器退出/);
  });
  await test('custom launcher executes safely with cwd/session/pi/mode placeholders',async()=>{
    const file=join(temp,'args.json'),script=join(temp,'launcher.mjs');writeFileSync(script,`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(file)},JSON.stringify(process.argv.slice(2)));`);
    const s=join(temp,'protected.jsonl');await launcher.launchInTerminal({type:'custom',executable:process.execPath,args:[script,'{cwd}','{session}','{pi}','{mode}']},temp,s,'fork',process.execPath);
    assert.deepEqual(JSON.parse(readFileSync(file)),[temp,s,process.execPath,'fork']);
  });
  // Deletion always touches fixtures only; force trash failure using a private executable.
  await test('delete falls back to unlink, refreshes, protects confirm semantics',async()=>{
    const bin=join(temp,'bin');mkdirSync(bin);writeFileSync(join(bin,'trash'),'#!/bin/sh\nexit 1\n',{mode:0o755});const old=process.env.PATH;process.env.PATH=bin;
    try {const path=join(temp,'delete-only-fixture.jsonl');writeFileSync(path,'fixture');const a=await make(Picker,[{...sessions[0],path,parentSessionPath:undefined}]);a.p.handleInput(keys.down);a.p.handleInput(keys.del);assert.ok(existsSync(path));a.p.handleInput(keys.enter);await new Promise(r=>setTimeout(r,30));assert.ok(!existsSync(path));assert.match(plain(a.p),/Session deleted/);}finally{process.env.PATH=old;}
  });
  console.log(`\n${passed} tests passed. Only temporary fixtures used. Native reference: pi ${pi.VERSION}.`);
} finally {
  for(const p of allPickers) { if(p.dispose)p.dispose(); else p.header.setStatusMessage(null); }
  rmSync(temp,{recursive:true,force:true});
}
