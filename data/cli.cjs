'use strict';
const core=require('./core.cjs');
function execute(request,root) {
  if(!request || typeof request!=='object' || Array.isArray(request)) throw new Error('请求格式无效');
  switch(request.action) {
    case 'history':return core.history(root,request.filters);
    case 'daily':return core.daily(root);
    case 'compare':return core.compare(root,request.leftName,request.rightName);
    case 'export':return core.exportResult(root,request.name,request.format);
    default:throw new Error('未知数据操作');
  }
}
module.exports={execute};
if(require.main===module) {
  let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',chunk=>input+=chunk);
  process.stdin.on('end',()=>{try {const request=JSON.parse(input.replace(/^\uFEFF/,'')); const args=process.argv.slice(2), index=args.indexOf('--data'); const root=index>=0?args[index+1]:request.dataRoot; process.stdout.write(JSON.stringify(execute(request,root)));}
  catch {process.stdout.write(JSON.stringify({error:'数据操作失败，请检查数据目录、参数与结果文件格式'}));process.exitCode=1;}});
}
