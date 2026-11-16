import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { invoke, safeError } from './mcp.mjs';
export async function main(args = process.argv.slice(2), controller) {
 if(args.length===1 && ['--help','-h'].includes(args[0])) {process.stdout.write('Usage: node src/cli.mjs <doctor|preflight|workspace_policy|start|send|status|result|list|wait|respond|cancel|desktop_workspaces|desktop_session|desktop_sessions|adopt> [--input <json-file>]\nInput: UTF-8 JSON file or stdin. doctor/list/desktop_workspaces/desktop_sessions may omit input.\n');return;}
 try {
  const [operation,...rest]=args;
  if(rest.length && !(rest.length===2 && rest[0]==='--input')) throw new Error('Invalid arguments');
  const noInput=['doctor','list','desktop_workspaces','desktop_sessions'].includes(operation);
  let raw = rest.length ? await readFile(rest[1],'utf8') : (noInput || process.stdin.isTTY) ? '' : await (async()=>{let text='';process.stdin.setEncoding('utf8');for await(const chunk of process.stdin) text+=chunk;return text;})();
  const input=raw.trim() ? JSON.parse(raw.replace(/^\uFEFF/,'')) : noInput ? {} : JSON.parse('');
  const value=await invoke(controller ?? await import('./controller.mjs'),operation,input);
  process.stdout.write(JSON.stringify(value,null,2)+'\n');
 } catch (error) {process.stderr.write(JSON.stringify({error:safeError(error)})+'\n');process.exitCode=1;}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
