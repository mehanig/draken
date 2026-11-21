const {enrich}=require('../../dist/factory-enrichment');
/** Saved guidance fixture, not a model-quality proof. */
module.exports=workflow=>enrich(workflow,{steps:workflow.method.map((_,i)=>({step:i+1,approach:'Inspect and perform this workflow step',checks:['Verify its result']})),review:['Review the diff and repair findings'],completion:['Verify the requested endpoint'],risks:[]});
