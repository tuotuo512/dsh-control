import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { pathToFileURL } from 'node:url';
import { redact } from './store.mjs';
export const safeError = error => redact(error instanceof Error ? error.message : 'DSH operation failed');
const prompt = z.string().refine(value => value.trim().length > 0, 'Prompt must be nonempty');
const id = z.string().trim().min(1);
export const schemas = {
 desktop_workspaces:z.object({limit:z.number().int().min(1).max(100).default(100),offset:z.number().int().min(0).default(0)}).strict(),
 desktop_session:z.object({sessionId:id}).strict(),
 desktop_sessions:z.object({limit:z.number().int().min(1).max(100).default(20)}).strict(),
 adopt:z.object({requestId:id,sessionId:id,permission:z.enum(['read-only','workspace-write']).default('read-only'),ownedPaths:z.array(id).optional(),timeoutSeconds:z.number().int().min(5).max(14400).default(1800)}).strict(),
 doctor: z.object({}).strict(),
  start: z.object({requestId:id,cwd:id,workspaceId:id.optional(),prompt,backend:z.enum(['sdk','desktop','acp']).optional(),title:id.optional(),permission:z.enum(['read-only','workspace-write']).default('read-only'),ownedPaths:z.array(id).optional(),timeoutSeconds:z.number().int().min(5).max(14400).default(1800)}).strict(),
 send:z.object({requestId:id,sessionId:id,prompt,title:id.optional()}).strict(),
 status:z.object({runId:id,afterEvent:z.number().int().min(0).optional(),maxEvents:z.number().int().min(1).max(100).default(20)}).strict(),
 result:z.object({runId:id,maxChars:z.number().int().min(1).max(50000).default(12000)}).strict(),
 list:z.object({limit:z.number().int().min(1).max(100).default(20)}).strict(),
 wait:z.object({runIds:z.array(id).min(1).max(8),timeoutMs:z.number().int().min(0).max(30000).default(10000),after:z.record(z.string(),z.number().int().min(0)).optional()}).strict(),
 respond:z.object({runId:id,pendingId:id,response:z.record(z.string(),z.unknown())}).strict(),
 cancel:z.object({runId:id}).strict()
};
const descriptions = {
  desktop_workspaces:'List actual native workspaces, including empty ones, with stable identities and paths. Does not create sessions.',
  desktop_session:'Check one exact native session for existence and archival without resuming it. Removes a local connection note only after confirmed archival or deletion.',
 desktop_sessions:'List native sessions without adopting or prompting.',
 adopt:'Explicitly attach an idle native session without sending a prompt.',
 doctor:'Inspect installed DSH runtime, configuration and readiness without exposing credentials.',
 start:'Start a durable managed DSH run. Defaults to read-only; workspace-write requires ownedPaths. requestId makes submission idempotent. Acceptance is not completion.',
 send:'Continue a managed or explicitly adopted session after its previous run releases ownership. A caller requestId prevents duplicate submission.',
 status:'Read a managed run and bounded public events after a cursor. Provider reasoning is excluded.',
 result:'Read bounded public output and durable report path. Supervisor must review files and tests separately.',
 list:'List recent managed runs, including runs surviving MCP disconnect.',
 wait:'Wait up to 30 seconds for completion, input, approval, or public events beyond supplied cursors. Continue monitoring until terminal state or explicit handoff.',
 respond:'Answer the exact pending question or approval request explicitly. Stale pending identities are rejected.',
 cancel:'Cancel the managed run only. SDK requires child exit; Desktop requires native quiescence and lease release, never Host process exit.'
};
export async function invoke(controller, operation, input) {
 if (!Object.hasOwn(schemas, operation)) throw new Error('Unknown operation');
 return controller[operation](schemas[operation].parse(input));
}
export function createServer(controller) {
  const server = new McpServer({name:'local-dsh-control',version:'0.6.0'});
 for (const [operation,schema] of Object.entries(schemas)) {
  server.registerTool(`dsh_${operation}`,{description:descriptions[operation],inputSchema:schema},async input=>{
   try {const value=await invoke(controller,operation,input); return {structuredContent:value,content:[{type:'text',text:JSON.stringify(value,null,2)}]};}
   catch (error) {return {isError:true,content:[{type:'text',text:JSON.stringify({error:safeError(error)})}]};}
  });
 }
 return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 const controller = await import('./controller.mjs');
 await createServer(controller).connect(new StdioServerTransport());
}
