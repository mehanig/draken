const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '../src'), folder = path.join(root, 'workflow-learning');
function files(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir,e.name)) : e.name.endsWith('.ts') ? [path.join(dir,e.name)] : []); }
function imports(file) {
  const tree = ts.createSourceFile(file, fs.readFileSync(file,'utf8'), ts.ScriptTarget.Latest, true), result = [];
  function visit(node) {
    let literal = node.moduleSpecifier;
    if (ts.isImportTypeNode(node)) literal = node.argument.literal;
    if (ts.isExternalModuleReference(node)) literal = node.expression;
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(tree) === 'require')) literal = node.arguments[0] || node;
    if (literal) result.push(ts.isStringLiteral(literal) ? literal.text : null);
    ts.forEachChild(node,visit);
  }
  visit(tree); return result;
}
test('workflow learning is isolated and callers use its public entry point', () => {
  for (const file of files(root)) for (const name of imports(file)) {
    if (file.startsWith(folder + path.sep)) {
      assert.ok(name?.startsWith('./') || name?.startsWith('../'));
      assert.ok(path.resolve(path.dirname(file), name).startsWith(folder + path.sep));
    } else if (name) {
      const target = path.resolve(path.dirname(file),name);
      if (target.startsWith(folder + path.sep)) assert.equal(target,path.join(folder,'index'));
    }
  }
});
test('both public modules compile away from Draken and process originals with two independent hosts', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'workflow-alone-'));
  try {
    for (const name of ['evidence','workflow-learning']) fs.cpSync(path.join(root,name),path.join(temp,name),{recursive:true});
    const out = path.join(temp,'out');
    const program = ts.createProgram(['evidence','workflow-learning'].map(name => path.join(temp,name,'index.ts')), {
      target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,strict:true,types:[],lib:['lib.es2023.d.ts','lib.dom.d.ts'],outDir:out,
    });
    assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText,'\n')),[]);
    assert.equal(program.emit().emitSkipped,false);
    execFileSync(process.execPath,['-e',`
      const assert=require('node:assert/strict');
      const {prepareProcedureEvidence,readTaskEvidence}=require(${JSON.stringify(path.join(out,'evidence/index.js'))});
      const {extractProcedures,validateProcess,validateProcessMatch,validateContractAssessment,decideContractMatch,taskWorkflow,reconstructTask,assembledTaskInput,reconstructionEvidence,consolidatedWorkflows}=require(${JSON.stringify(path.join(out,'workflow-learning/index.js'))});
      assert.deepEqual(validateProcess('{"summary":"No supported process","fragments":[],"limitations":["Insufficient evidence"]}',[]).fragments,[]);
      const empty={primary:{goal:'Unknown',context:'Unknown',stages:[],branches:[],dependencies:[],decisions:[]},coverage:{complete:false,triggerPresent:false,outcomePresent:false,gaps:['No evidence']},secondary:{recoveries:[],toolsAndSkills:[]}};
      assert.equal(validateProcessMatch('{"relation":"insufficient","reason":"No episodes","sharedStages":[],"importantDifferences":[],"toolSkillDifferences":[],"missingEvidence":["No examples"]}',[empty,empty]).relation,'insufficient');
      const contractInput={goal:'Unknown',context:'Unknown',complete:false,gaps:[],stages:[],facts:[],secondary:[]};
      const assessment={relation:'insufficient',workflow:null,stagePairs:[],reason:'No identifiable method',limitations:['No facts']};
      assert.equal(decideContractMatch(validateContractAssessment(JSON.stringify(assessment),[contractInput,contractInput]),[contractInput,contractInput]).sameWorkflow,false);
      async function host(sessionId) {
        const signal=new AbortController().signal;
        const packet=await prepareProcedureEvidence({sessionId,before:'2026-11-19T00:00:00Z',refs:['R1'],signal},{
          cleanText:s=>s.replaceAll('secret','[redacted]'),
          read:async ref=>({ref,sessionId,sequence:1,at:'2026-11-18T00:00:00Z',role:'user',text:'secret request'}),
        });
        const fragment={key:'task',goal:'Release 1.2.3',context:'Requested publication',state:'partial',refs:['R1'],coverage:{triggerRefs:['R1'],outcomeRefs:[],gaps:['Outcome missing']},stages:[{key:'release',action:'Publish 1.2.3',normalizedAction:'Publish the target release',role:'main',condition:null,claims:[{description:'Publication requested',basis:'requested',refs:['R1']}],refs:['R1'],tools:[],skills:[]}],dependencies:[],decisions:[],exceptions:[],questions:[],matching:{goal:'Publish a release',context:'Requested publication'}};
        const fragments=[{id:'F0',process:fragment,...reconstructionEvidence(fragment,packet.records)}];
        assert.equal(consolidatedWorkflows(JSON.stringify({groups:[{members:['W1'],workflow:{purpose:'Publish a release',method:['Publish the target release'],appliesWhen:'A release is requested'},reason:'One supported procedure'}]}),['W1']).length,1);
        const assembly=reconstructTask(JSON.stringify({status:'task',members:['F0'],reason:'The supplied release request identifies this task',coverage:fragment.coverage}),fragments);
        const reconstructed=assembledTaskInput(assembly,[{fragment,limitations:[]}]);
        assert.equal(reconstructed.goal,'Release 1.2.3');assert.equal(reconstructed.complete,false);assert.equal(reconstructed.stages[0].id,'S1');
        assert.throws(()=>reconstructTask(JSON.stringify({...assembly,members:['F99']}),fragments));
        let calls=0;
        const result=await extractProcedures(packet,async payload=>{ calls++;assert.ok(!JSON.stringify(payload).includes('secret'));return '{"episodes":[],"limitations":["Insufficient evidence"]}'; },signal);
        assert.equal(calls,1);assert.equal(result.episodes.length,0);
        const cross=await readTaskEvidence({before:'2026-11-19T00:00:00Z',selections:[{ref:'H1',offset:0},{ref:'H2',offset:0}],signal},{
          cleanText:s=>s.replaceAll('secret','[redacted]'),read:async ref=>({offset:0,neighbors:[],record:{ref,session_id:sessionId+ref,sync_id:null,kind:'session',workspace:'/repo',title:'Task',role:'user',sequence:1,at:'2026-11-18T00:00:00Z',qualification:'Original',text:'secret task'}}),
        });
        assert.equal(cross.records.length,2);assert.equal(new Set(cross.records.map(r=>r.sessionId)).size,2);assert.ok(!JSON.stringify(cross.records).includes('secret'));
        assert.equal(taskWorkflow(JSON.stringify({kind:'insufficient',message:'No identifiable method',process:null,fragment:null,repositoryRef:null,workflow:null}),cross.records).kind,'insufficient');
      }
      Promise.all([host('one'),host('two')]).catch(e=>{console.error(e);process.exitCode=1;});
    `],{cwd:temp,env:{},timeout:30000});
  } finally { fs.rmSync(temp,{recursive:true,force:true}); }
});
